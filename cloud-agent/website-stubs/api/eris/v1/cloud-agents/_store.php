<?php
/**
 * Minimal JSON-file store for Cloud Agent fleet (MVP).
 * Copy this directory to the EricServices site under api/eris/v1/cloud-agents/
 * Replace with MySQL when ready — keep the same JSON response shapes.
 */
declare(strict_types=1);

function eris_cloud_agents_data_dir(): string
{
    $dir = getenv('ERIS_CLOUD_AGENTS_DATA') ?: (__DIR__ . '/../../../../data/eris-cloud-agents');
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    return $dir;
}

function eris_ca_read(): array
{
    $path = eris_cloud_agents_data_dir() . '/agents.json';
    if (!is_file($path)) {
        return ['agents' => []];
    }
    $raw = json_decode((string) file_get_contents($path), true);
    return is_array($raw) ? $raw : ['agents' => []];
}

function eris_ca_write(array $data): void
{
    $path = eris_cloud_agents_data_dir() . '/agents.json';
    file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod($path, 0600);
}

function eris_ca_json(array $body, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function eris_ca_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function eris_ca_bearer(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(\S+)/i', $h, $m)) {
        return trim($m[1]);
    }
    return '';
}

/** Replace with real EricServic.es admin check (me.php + role). */
function eris_ca_require_admin(): array
{
    $token = eris_ca_bearer();
    if ($token === '') {
        eris_ca_json(['ok' => false, 'error' => 'Admin Bearer required'], 401);
    }
    // Hook: validate eseris_… and require admin/ops role.
    return ['token' => $token, 'owner' => 'admin'];
}

function eris_ca_require_agent(): array
{
    $id = trim((string) ($_SERVER['HTTP_X_ERIS_AGENT_ID'] ?? ''));
    $secret = trim((string) ($_SERVER['HTTP_X_ERIS_AGENT_SECRET'] ?? ''));
    if ($id === '' || $secret === '') {
        eris_ca_json(['ok' => false, 'error' => 'X-Eris-Agent-Id and X-Eris-Agent-Secret required'], 401);
    }
    $db = eris_ca_read();
    foreach ($db['agents'] as $agent) {
        if (($agent['agentId'] ?? '') === $id && hash_equals((string) ($agent['agentSecret'] ?? ''), $secret)) {
            return $agent;
        }
    }
    eris_ca_json(['ok' => false, 'error' => 'Unknown agent or bad secret'], 401);
}

function eris_ca_public_agent(array $agent): array
{
    $out = $agent;
    unset($out['agentSecret'], $out['enrollToken']);
    if (!empty($out['settings']['llmKey'])) {
        $out['settings']['llmKey'] = '[set]';
    }
    return $out;
}

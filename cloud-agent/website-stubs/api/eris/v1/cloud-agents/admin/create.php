<?php
/**
 * Admin: create a Cloud Agent enrollment.
 * POST JSON: { "name": "prod-cpu-1", "settings": { ...optional } }
 * Auth: Bearer eseris_… (admin)
 */
declare(strict_types=1);
require_once dirname(__DIR__) . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    eris_ca_json(['ok' => false, 'error' => 'POST required'], 405);
}

eris_ca_require_admin();
$body = eris_ca_body();
$name = trim((string) ($body['name'] ?? 'cloud-agent'));
if ($name === '') {
    $name = 'cloud-agent';
}

$agentId = 'agt_' . bin2hex(random_bytes(8));
$agentSecret = rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
$enrollToken = 'enr_' . bin2hex(random_bytes(16));

$settings = is_array($body['settings'] ?? null) ? $body['settings'] : [];
$agent = [
    'agentId' => $agentId,
    'agentSecret' => $agentSecret,
    'enrollToken' => $enrollToken,
    'enrollUsed' => false,
    'displayName' => $name,
    'configRevision' => 1,
    'settings' => $settings,
    'createdAt' => gmdate('c'),
    'lastHeartbeatAt' => null,
    'lastHeartbeat' => null,
    'status' => 'pending_enroll',
];

$db = eris_ca_read();
$db['agents'][] = $agent;
eris_ca_write($db);

eris_ca_json([
    'ok' => true,
    'agentId' => $agentId,
    'enrollToken' => $enrollToken,
    'displayName' => $name,
    'installHint' =>
        "Environment=ERIS_CLOUD_FLEET_ENROLL_TOKEN={$enrollToken}\n" .
        "Environment=ERIS_CLOUD_FLEET_NAME={$name}",
    // Shown once — store securely; not returned by list.php
    'agentSecret' => $agentSecret,
]);

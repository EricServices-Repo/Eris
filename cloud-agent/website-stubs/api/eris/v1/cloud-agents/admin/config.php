<?php
/**
 * Admin: update settings for an agent (bumps revision).
 * POST JSON: { "agentId": "agt_…", "settings": {…}, "push": true }
 * When push=true and lastHeartbeat.publicBaseUrl is set, POSTs to the agent.
 */
declare(strict_types=1);
require_once dirname(__DIR__) . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    eris_ca_json(['ok' => false, 'error' => 'POST required'], 405);
}

eris_ca_require_admin();
$body = eris_ca_body();
$agentId = trim((string) ($body['agentId'] ?? ''));
$settings = is_array($body['settings'] ?? null) ? $body['settings'] : null;
if ($agentId === '' || $settings === null) {
    eris_ca_json(['ok' => false, 'error' => 'agentId and settings required'], 400);
}

$db = eris_ca_read();
$found = null;
foreach ($db['agents'] as $i => $agent) {
    if (($agent['agentId'] ?? '') === $agentId) {
        $db['agents'][$i]['settings'] = array_merge($agent['settings'] ?? [], $settings);
        $db['agents'][$i]['configRevision'] = (int) ($agent['configRevision'] ?? 0) + 1;
        $db['agents'][$i]['updatedAt'] = gmdate('c');
        $found = $db['agents'][$i];
        break;
    }
}
if (!$found) {
    eris_ca_json(['ok' => false, 'error' => 'Agent not found'], 404);
}
eris_ca_write($db);

$pushResult = null;
if (!empty($body['push'])) {
    $base = rtrim((string) ($found['lastHeartbeat']['publicBaseUrl'] ?? ''), '/');
    if ($base !== '') {
        $url = $base . '/v1/fleet/config';
        $payload = json_encode([
            'revision' => $found['configRevision'],
            'settings' => $found['settings'],
        ]);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json',
                'X-Eris-Agent-Id: ' . $found['agentId'],
                'X-Eris-Agent-Secret: ' . $found['agentSecret'],
            ],
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 12,
        ]);
        $resp = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $pushResult = ['http' => $code, 'body' => json_decode((string) $resp, true)];
    } else {
        $pushResult = ['skipped' => true, 'reason' => 'no publicBaseUrl from heartbeat yet'];
    }
}

eris_ca_json([
    'ok' => true,
    'agentId' => $agentId,
    'configRevision' => $found['configRevision'],
    'push' => $pushResult,
]);

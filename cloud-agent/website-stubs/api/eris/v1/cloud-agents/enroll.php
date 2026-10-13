<?php
/**
 * Agent: exchange one-time enroll token for agentId + agentSecret.
 * POST JSON: { "enrollToken": "enr_…", "version", "publicBaseUrl", "gpuMode", "name" }
 */
declare(strict_types=1);
require_once __DIR__ . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    eris_ca_json(['ok' => false, 'error' => 'POST required'], 405);
}

$body = eris_ca_body();
$token = trim((string) ($body['enrollToken'] ?? ''));
if ($token === '') {
    eris_ca_json(['ok' => false, 'error' => 'enrollToken required'], 400);
}

$db = eris_ca_read();
$foundIdx = null;
foreach ($db['agents'] as $i => $agent) {
    if (!empty($agent['enrollToken']) && hash_equals((string) $agent['enrollToken'], $token)) {
        if (!empty($agent['enrollUsed'])) {
            eris_ca_json(['ok' => false, 'error' => 'Enroll token already used'], 409);
        }
        $foundIdx = $i;
        break;
    }
}
if ($foundIdx === null) {
    eris_ca_json(['ok' => false, 'error' => 'Invalid enroll token'], 401);
}

$agent = &$db['agents'][$foundIdx];
$agent['enrollUsed'] = true;
$agent['status'] = 'enrolled';
$agent['enrolledAt'] = gmdate('c');
if (!empty($body['name'])) {
    $agent['displayName'] = trim((string) $body['name']);
}
$agent['lastHeartbeat'] = [
    'version' => $body['version'] ?? null,
    'publicBaseUrl' => $body['publicBaseUrl'] ?? null,
    'gpuMode' => $body['gpuMode'] ?? null,
    'at' => gmdate('c'),
];
eris_ca_write($db);

eris_ca_json([
    'ok' => true,
    'agentId' => $agent['agentId'],
    'agentSecret' => $agent['agentSecret'],
    'displayName' => $agent['displayName'] ?? null,
    'configRevision' => (int) ($agent['configRevision'] ?? 1),
    'config' => ['settings' => $agent['settings'] ?? []],
]);

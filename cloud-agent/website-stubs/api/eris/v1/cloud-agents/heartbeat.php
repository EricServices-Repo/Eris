<?php
/**
 * Agent → platform heartbeat. Returns newer config when configRevision is behind.
 */
declare(strict_types=1);
require_once __DIR__ . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    eris_ca_json(['ok' => false, 'error' => 'POST required'], 405);
}

$agent = eris_ca_require_agent();
$body = eris_ca_body();

$db = eris_ca_read();
foreach ($db['agents'] as $i => $row) {
    if (($row['agentId'] ?? '') === $agent['agentId']) {
        $db['agents'][$i]['lastHeartbeatAt'] = gmdate('c');
        $db['agents'][$i]['lastHeartbeat'] = $body;
        $db['agents'][$i]['status'] = !empty($body['ready']) ? 'ready' : 'online';
        $agent = $db['agents'][$i];
        break;
    }
}
eris_ca_write($db);

$remoteRev = (int) ($agent['configRevision'] ?? 0);
$localRev = (int) ($body['configRevision'] ?? 0);
$resp = [
    'ok' => true,
    'configRevision' => $remoteRev,
];
if ($remoteRev > $localRev) {
    $resp['config'] = ['settings' => $agent['settings'] ?? []];
}
eris_ca_json($resp);

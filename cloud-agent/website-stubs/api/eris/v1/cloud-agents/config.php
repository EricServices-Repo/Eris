<?php
/** Agent: fetch current config revision. */
declare(strict_types=1);
require_once __DIR__ . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    eris_ca_json(['ok' => false, 'error' => 'GET required'], 405);
}

$agent = eris_ca_require_agent();
eris_ca_json([
    'ok' => true,
    'configRevision' => (int) ($agent['configRevision'] ?? 0),
    'updatedAt' => $agent['updatedAt'] ?? $agent['createdAt'] ?? null,
    'config' => ['settings' => $agent['settings'] ?? []],
    'displayName' => $agent['displayName'] ?? null,
]);

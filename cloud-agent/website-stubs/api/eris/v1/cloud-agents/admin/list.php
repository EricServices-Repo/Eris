<?php
/** Admin: list Cloud Agents (secrets redacted). */
declare(strict_types=1);
require_once dirname(__DIR__) . '/_store.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    eris_ca_json(['ok' => false, 'error' => 'GET required'], 405);
}

eris_ca_require_admin();
$db = eris_ca_read();
$list = array_map('eris_ca_public_agent', $db['agents'] ?? []);
eris_ca_json(['ok' => true, 'agents' => $list, 'count' => count($list)]);

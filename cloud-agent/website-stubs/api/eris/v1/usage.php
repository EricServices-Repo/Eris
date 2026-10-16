<?php
/**
 * Eris profile usage (requests / tokens / cloud jobs per calendar day).
 *
 * Deploy to: https://www.ericservic.es/api/eris/v1/usage.php
 *
 * GET  Authorization: Bearer eseris_…  → today's totals (+ recent days)
 * POST Authorization: Bearer eseris_…  → apply delta or set absolute day totals
 *
 * Wire eris_usage_resolve_user() to your real token → username lookup (me.php).
 */
declare(strict_types=1);

function eris_usage_data_dir(): string
{
    $dir = getenv('ERIS_USAGE_DATA') ?: (__DIR__ . '/../../../data/eris-usage');
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    return $dir;
}

function eris_usage_json(array $body, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Eris-Client');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    eris_usage_json(['ok' => true], 204);
}

function eris_usage_bearer(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(\S+)/i', $h, $m)) {
        return trim($m[1]);
    }
    return '';
}

/**
 * Resolve Bearer → stable profile key + display username.
 * Replace with Control Hub me.php / session lookup in production.
 */
function eris_usage_resolve_user(string $token): array
{
    if ($token === '') {
        eris_usage_json(['ok' => false, 'error' => 'Authorization Bearer token required'], 401);
    }
    // Production: validate token, return ['owner' => $username, 'plan' => 'free'|'pro']
    $owner = 'user_' . substr(hash('sha256', $token), 0, 16);
    return ['owner' => $owner, 'plan' => 'free'];
}

function eris_usage_path(string $owner): string
{
    $safe = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $owner) ?: 'unknown';
    return eris_usage_data_dir() . '/' . $safe . '.json';
}

function eris_usage_empty_day(string $day): array
{
    return [
        'day' => $day,
        'requests' => 0,
        'inputTokens' => 0,
        'outputTokens' => 0,
        'cloudJobs' => 0,
        'updatedAt' => null,
    ];
}

function eris_usage_load(string $owner): array
{
    $path = eris_usage_path($owner);
    if (!is_file($path)) {
        return ['version' => 1, 'owner' => $owner, 'days' => []];
    }
    $raw = json_decode((string) file_get_contents($path), true);
    if (!is_array($raw)) {
        return ['version' => 1, 'owner' => $owner, 'days' => []];
    }
    $raw['days'] = is_array($raw['days'] ?? null) ? $raw['days'] : [];
    return $raw;
}

function eris_usage_save(string $owner, array $data): void
{
    $data['owner'] = $owner;
    $data['version'] = 1;
    // Keep ~90 days
    $keys = array_keys($data['days']);
    sort($keys);
    if (count($keys) > 90) {
        foreach (array_slice($keys, 0, count($keys) - 90) as $k) {
            unset($data['days'][$k]);
        }
    }
    file_put_contents(eris_usage_path($owner), json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod(eris_usage_path($owner), 0600);
}

function eris_usage_today(): string
{
    return gmdate('Y-m-d');
}

function eris_usage_normalize_day(array $day, string $key): array
{
    $base = eris_usage_empty_day($key);
    return [
        'day' => $key,
        'requests' => max(0, (int) ($day['requests'] ?? $base['requests'])),
        'inputTokens' => max(0, (int) ($day['inputTokens'] ?? $base['inputTokens'])),
        'outputTokens' => max(0, (int) ($day['outputTokens'] ?? $base['outputTokens'])),
        'cloudJobs' => max(0, (int) ($day['cloudJobs'] ?? $base['cloudJobs'])),
        'updatedAt' => $day['updatedAt'] ?? null,
    ];
}

$token = eris_usage_bearer();
$user = eris_usage_resolve_user($token);
$owner = $user['owner'];
$file = eris_usage_load($owner);
$today = eris_usage_today();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $dayKey = trim((string) ($_GET['day'] ?? $today));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dayKey)) {
        $dayKey = $today;
    }
    $day = eris_usage_normalize_day($file['days'][$dayKey] ?? [], $dayKey);
    $days = [];
    $keys = array_keys($file['days']);
    rsort($keys);
    $limit = 30;
    if (isset($_GET['days'])) {
        $limit = max(1, min(90, (int) $_GET['days']));
    }
    foreach (array_slice($keys, 0, $limit) as $k) {
        $days[] = eris_usage_normalize_day($file['days'][$k], $k);
    }
    eris_usage_json([
        'ok' => true,
        'owner' => $owner,
        'plan' => $user['plan'] ?? null,
        'day' => $dayKey,
        'usage' => $day,
        'days' => $days,
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'PUT') {
    eris_usage_json(['ok' => false, 'error' => 'GET or POST required'], 405);
}

$raw = file_get_contents('php://input');
$body = $raw ? json_decode($raw, true) : [];
if (!is_array($body)) {
    eris_usage_json(['ok' => false, 'error' => 'Invalid JSON'], 400);
}

$dayKey = trim((string) ($body['day'] ?? $today));
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dayKey)) {
    $dayKey = $today;
}

$cur = eris_usage_normalize_day($file['days'][$dayKey] ?? [], $dayKey);

if (isset($body['set']) && is_array($body['set'])) {
    // Absolute replace for fields present (desktop full sync)
    foreach (['requests', 'inputTokens', 'outputTokens', 'cloudJobs'] as $k) {
        if (array_key_exists($k, $body['set'])) {
            $cur[$k] = max(0, (int) $body['set'][$k]);
        }
    }
} else {
    // Incremental delta (preferred for multi-device)
    $delta = is_array($body['delta'] ?? null) ? $body['delta'] : $body;
    foreach (['requests', 'inputTokens', 'outputTokens', 'cloudJobs'] as $k) {
        if (isset($delta[$k])) {
            $cur[$k] = max(0, $cur[$k] + (int) $delta[$k]);
        }
    }
}

$cur['updatedAt'] = gmdate('c');
$cur['lastSource'] = trim((string) ($body['source'] ?? 'eris'));
$file['days'][$dayKey] = $cur;
eris_usage_save($owner, $file);

eris_usage_json([
    'ok' => true,
    'owner' => $owner,
    'day' => $dayKey,
    'usage' => $cur,
    'source' => $cur['lastSource'],
]);

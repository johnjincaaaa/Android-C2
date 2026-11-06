<?php
// build_download.php 重写版: URL-token 场景带 attachment, fetch 场景不带
declare(strict_types=1);
error_reporting(0);

// JWT 密钥与 Node 共用 /var/www/eagle_php/.jwt_secret（不进源码）
$_sf = '/var/www/eagle_php/.jwt_secret';
if (!is_readable($_sf) || strlen(trim((string)@file_get_contents($_sf))) < 32) {
    http_response_code(500); header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'server misconfigured']); exit;
}
define('SECRET', trim((string)file_get_contents($_sf)));
const UPLOAD_ROOT = '/root/xyzcs_front/uploads';
const XACCEL_URI = '/__eagle_dl/';

function b64d(string $s): string { return base64_decode(str_replace(['-', '_'], ['+', '/'], $s)); }
function jwtCheck(?string $tok): ?array {
    if (!$tok || substr_count($tok, '.') !== 2) return null;
    [$h, $p, $s] = explode('.', $tok);
    if (strlen($h) > 512 || strlen($p) > 4096 || strlen($s) !== 43) return null;
    $exp = rtrim(str_replace(['+', '/'], ['-', '_'], base64_encode(hash_hmac('sha256', $h . '.' . $p, SECRET, true))), '=');
    if (!hash_equals($exp, $s)) return null;
    $d = json_decode(b64d($p), true);
    if (!is_array($d) || ($d['exp'] ?? 0) * 1000 < time() * 1000) return null;
    return $d;
}
function forbidden(): void {
    http_response_code(401);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => '未提供令牌'], JSON_UNESCAPED_UNICODE);
    exit;
}
function notFound(string $msg = '构建不存在或未完成'): void {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') notFound('方法不允许');

$uri = $_SERVER['REQUEST_URI'] ?? '';
if (!preg_match('#^/m/build/(\d{1,18})/download#', $uri, $m)) notFound('路径非法');
$bid = $m[1];

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$ok = false;
$viaUrlToken = false;
if (preg_match('/^Bearer\s+(.+)$/i', $auth, $am)) $ok = jwtCheck(trim($am[1])) !== null;
/* URL 参数 token = 原生导航下载场景 (location.href 直链, 兼容 Safari 等不触发 blob 保存的浏览器) */
if (!$ok && !empty($_GET['token'])) { $ok = jwtCheck((string)$_GET['token']) !== null; $viaUrlToken = $ok; }
if (!$ok) forbidden();

$fp = UPLOAD_ROOT . '/build_' . $bid . '.apk';
if (!is_file($fp)) notFound();

header('Content-Type: application/vnd.android.package-archive');
if ($viaUrlToken) header('Content-Disposition: attachment; filename="app_' . $bid . '.apk"');  // 原生导航必须带附件头, 否则浏览器内联显示二进制
// Authorization 头 (fetch) 场景不带 attachment — Safari WebKit 对 fetch 响应的该头会取消 body 读取
header('X-Content-Type-Options: nosniff');
/* 下载计数（控制台"下载量"卡片数据源，Node collectStats 读取 dl_stats.json） */
$dlFile = '/var/www/eagle_php/dl_stats.json';
$fp0 = fopen($dlFile, 'c+');
if ($fp0) {
    if (flock($fp0, LOCK_EX)) {
        $st = json_decode((string)stream_get_contents($fp0), true) ?: [];
        $td = gmdate('Y-m-d', time() + 8 * 3600);
        if (($st['date'] ?? '') !== $td) { $st['date'] = $td; $st['today'] = 0; }
        $st['today'] = (int)($st['today'] ?? 0) + 1;
        $st['total'] = (int)($st['total'] ?? 0) + 1;
        ftruncate($fp0, 0); rewind($fp0);
        fwrite($fp0, json_encode($st)); fflush($fp0);
        flock($fp0, LOCK_UN);
    }
    fclose($fp0);
}
header('X-Accel-Redirect: ' . XACCEL_URI . 'build_' . $bid . '.apk');

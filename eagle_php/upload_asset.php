<?php
/**
 * 花木工作室 — 构建器资产上传（PHP 版，替代 Node POST /m/upload/asset/:atype）
 * nginx 将 /m/upload/asset/<atype> 分流到此。
 * 鉴权与 Node 共用 JWT HS256（SECRET 同源）；响应格式与 Node 版一致：
 *   {success:true, url:"/m/assets/<atype>/<name>", name:"<name>"}
 * 魔数校验：仅收图片（PNG/JPG/WEBP/GIF）——构建器上传的是图标/启动图。
 */
declare(strict_types=1);
error_reporting(0);
header('Content-Type: application/json; charset=utf-8');

// JWT 密钥与 Node 共用 /var/www/eagle_php/.jwt_secret（不进源码）
$_sf = '/var/www/eagle_php/.jwt_secret';
if (!is_readable($_sf) || strlen(trim((string)@file_get_contents($_sf))) < 32) {
    http_response_code(500); header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'server misconfigured']); exit;
}
define('SECRET', trim((string)file_get_contents($_sf)));
const UPLOAD_ROOT = '/root/xyzcs_front/uploads';
const MAX_SIZE = 50 * 1024 * 1024;

function out(array $o): void { echo json_encode($o, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
function fail(string $msg, int $code = 400): void { http_response_code($code); out(['error' => $msg]); }

/* ---------- JWT HS256（与 Node jwtCheck 同算法同密钥） ---------- */
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

/* ---------- 魔数 ---------- */
function sniffImage(string $fp): string {
    $h = (string)file_get_contents($fp, false, null, 0, 16);
    if (strlen($h) >= 8 && substr($h, 0, 8) === "\x89PNG\r\n\x1a\n") return 'png';
    if (strlen($h) >= 3 && substr($h, 0, 3) === "\xff\xd8\xff") return 'jpg';
    if (strncmp($h, 'RIFF', 4) === 0 && strncmp($h, 'WEBP', 8) === 0) return 'webp';
    if (strncmp($h, 'GIF89a', 6) === 0 || strncmp($h, 'GIF87a', 6) === 0) return 'gif';
    return '';
}

/* ================= 主流程 ================= */
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail('方法不允许', 405);

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+(.+)$/i', $auth, $m) || !jwtCheck(trim($m[1]))) fail('未提供令牌', 401);

/* atype 从 REQUEST_URI 提取: /m/upload/asset/<atype> */
$uri = $_SERVER['REQUEST_URI'] ?? '';
if (!preg_match('#^/m/upload/asset/([A-Za-z0-9_-]{1,32})#', rawurldecode($uri), $am)) fail('路径非法');
$atype = $am[1];

if (empty($_SERVER['CONTENT_TYPE']) || stripos($_SERVER['CONTENT_TYPE'], 'multipart/form-data') === false) fail('未收到文件');
$f = $_FILES['file'] ?? null;
if (!$f || !is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) fail('未收到文件');
if ($f['size'] <= 0 || $f['size'] > MAX_SIZE) fail('文件超过大小限制');
if (!is_uploaded_file($f['tmp_name'])) fail('上传校验失败');

if (sniffImage($f['tmp_name']) === '') fail('仅支持 PNG/JPG/WEBP/GIF 图片');

/* 安全文件名（与 Node 版一致: [^\w.-] 清洗） */
$safe = preg_replace('/[^\w.-]/', '', basename((string)$f['name'])) ?: '';
if ($safe === '' || $safe === '.' || $safe === '..' || str_starts_with($safe, '.')) fail('文件名非法');
if (strlen($safe) > 120) $safe = substr($safe, -100);

$dir = UPLOAD_ROOT . '/' . $atype;
if (!is_dir($dir)) @mkdir($dir, 0755, true);
$dest = $dir . '/' . $safe;
if (!@move_uploaded_file($f['tmp_name'], $dest)) { @unlink($f['tmp_name']); fail('保存文件失败'); }
@chmod($dest, 0644);

out(['success' => true, 'url' => '/m/assets/' . $atype . '/' . $safe, 'name' => $safe]);

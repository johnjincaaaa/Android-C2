/**
 * ============================================================================
 * 花木工作室 — dxs 无线调试桥（/s/lk WebSocket）
 * ============================================================================
 * 手机端无线调试链路：
 *   agent 引导开启无线调试 → 原生 TLS 配对 → 部署 dxs(tpx) →
 *   dxs 反连 面板 wss://…/s/lk?di=<android_id>（Go-http-client UA）→
 *   本模块接管该 WS → 面板侧 adb server 经 127.0.0.1:15563 直达手机 adbd。
 *
 * 协议：dxs 每 30s 发 {"type":"ping"}，本模块回 {"type":"pong"}（90s 无 pong 对端重连）；
 * 连接建立后向 dxs 投递隧道配置（tps 候选格式，见 handleBridgeWs）；
 * 全量帧记录到 /tmp/xy_bridge.log（前缀 bridge-*）。
 * 15563/5038 归 ssh 反向隧道与 frps，本进程不绑定。
 *
 * 被引用：server.js require('./bridge')；upgrade 分支 /s/lk → handleBridgeWs。
 */
const net = require('net');

// frps 地址与 token 全部走环境变量，缺省不向设备下发
const TPS_HOST = process.env.EAGLE_TPS_HOST || '';
const TPS_PORT = Number(process.env.EAGLE_TPS_PORT || 7000);
const TPS_TOKEN = process.env.EAGLE_FRP_TOKEN || '';

// di → {ws, lastSeen}；adbStreamListener 绑定状态
const bridges = new Map();
let adbListener = null;
const ADB_LOCAL_PORT = 15563;

function log(ctx, tag, obj) {
  // 统一走 ctx.log（LOG_FILE 可配），不再重复直写 /tmp
  try { ctx.log(tag, obj); } catch (e) {}
}

/** dxs WS 接入（server.js upgrade /s/lk 分支调用） */
// 只接受已注册设备（devices 表）或 eagle_map 中登记过的 id
function isKnownDevice(ctx, di) {
  const id = String(di || '').slice(0, 64);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return false;
  try {
    if (ctx.db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) return true;
    const kv = ctx.db.prepare("SELECT v FROM kv WHERE k='eagle_map'").get();
    if (kv) {
      const m = JSON.parse(kv.v) || {};
      for (const k of Object.keys(m)) {
        const v = m[k] || {};
        if (v.dev_id === id || v.devId === id || v.aid === id || String(k) === id) return true;
      }
    }
  } catch (e) {}
  return false;
}

function handleBridgeWs(ctx, ws, req) {
  const u = new URL(req.url, 'http://x');
  const di = u.searchParams.get('di') || '';
  const ua = req.headers['user-agent'] || '';
  if (!isKnownDevice(ctx, di)) {
    log(ctx, 'bridge-reject', {di: String(di).slice(0, 64), why: 'unknown device'});
    try { ws.close(4003, 'unknown device'); } catch (e) {}
    return;
  }
  log(ctx, 'bridge-open', {di, ua: String(ua).slice(0, 80), hdrs: {
    secWebSocketProtocol: req.headers['sec-websocket-protocol'] || '',
    secWebSocketExtensions: req.headers['sec-websocket-extensions'] || '',
  }});
  bridges.set(di, {ws, lastSeen: Date.now()});

  ws.on('message', (data, isBinary) => {
    const info = {di, binary: !!isBinary, len: data.length};
    if (isBinary) info.hex = data.toString('hex').slice(0, 240);
    else info.utf8 = data.toString('utf8').slice(0, 600);
    log(ctx, 'bridge-msg', info);
    bridges.set(di, {ws, lastSeen: Date.now()});
    // 心跳应答：{"type":"ping"} → {"type":"pong"}
    try {
      if (!isBinary && data.toString('utf8').includes('"ping"')) {
        ws.send('{"type":"pong"}');
        log(ctx, 'bridge-send', {di, utf8: '{"type":"pong"}'});
      }
    } catch (e) {}
  });
  ws.on('close', (code, reason) => {
    log(ctx, 'bridge-close', {di, code, reason: String(reason || '').slice(0, 80)});
    if (bridges.get(di) && bridges.get(di).ws === ws) bridges.delete(di);
  });
  ws.on('error', e => log(ctx, 'bridge-err', {di, e: String(e).slice(0, 120)}));

  // 隧道配置推送：dxs 连上 /s/lk WS 后等待服务器下发 tps 配置。
  // 消息 type 未最终确定，按候选格式逐个投递（dxs 对未知 type 会记日志，可据此筛选）
  const TPS = {tpsAddr: TPS_HOST, tpsPort: TPS_PORT, remotePort: 15563,
               server_addr: TPS_HOST, server_port: TPS_PORT};
  if (TPS_TOKEN) { TPS.tpsToken = TPS_TOKEN; TPS.token = TPS_TOKEN; }
  const candidates = [
    JSON.stringify({type: 'tps', code: 200, success: true, data: TPS, ...TPS}),
    JSON.stringify({type: 'tps_config', code: 200, success: true, data: TPS, ...TPS}),
    JSON.stringify({type: 'config', code: 200, success: true, data: TPS, ...TPS}),
    JSON.stringify({type: 'lk', code: 200, success: true, data: TPS, ...TPS}),
    JSON.stringify({code: 200, success: true, data: TPS, ...TPS}),
  ];
  const timers = [];
  let acc = 3000;
  if (!TPS_HOST) { log(ctx, 'bridge-no-tps', {di, why: 'EAGLE_TPS_HOST unset'}); return; }
  for (const msg of candidates) {
    timers.push(setTimeout(() => {
      try { ws.send(msg); log(ctx, 'bridge-send-tps', {di, utf8: msg.slice(0, 200)}); } catch (e) {}
    }, acc));
    acc += 8000;
  }
  // 探测：连接 5s 后发 hello 观察响应（dxs 断线会自动重拨，无风险）
  const probes = [
    ['{"type":"open"}', 5000],
    ['{"type":"open","port":0}', 0],
    ['{"type":"connect"}', 0],
    ['{"action":"open"}', 0],
  ];
  for (const [msg, extra] of probes) {
    acc += extra;
    timers.push(setTimeout(() => {
      try { ws.send(msg); log(ctx, 'bridge-send', {di, utf8: msg}); } catch (e) {}
    }, acc));
    acc += 6000;
  }
  ws.on('close', () => timers.forEach(clearTimeout));
}

/** 15563 观察口已移除：该端口归用户 SSH 反向隧道（-R 15563）与 frps 远端端口使用，
 *  本进程不得占用。adb 直注数据路径 = adb server(5038) → 隧道 → 手机 adbd。 */
function init(ctx) { /* 无需启动监听；保留 handleBridgeWs 的 /s/lk 桥接与捕获 */ }

module.exports = {handleBridgeWs, init, bridges};

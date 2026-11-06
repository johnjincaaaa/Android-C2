#!/usr/bin/env node
/** 触控闭环测试：面板 WS vnc_touch 点击 → 手机响应（打开设置）→ 帧变化验证 */
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const HOST = 'zxg123.com';
const SECRET = process.env.EAGLE_JWT_SECRET || require('fs').readFileSync(process.env.EAGLE_JWT_SECRET_FILE || '/var/www/eagle_php/.jwt_secret', 'utf8').trim();
const DEV = 'de63d84be06c6452';
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOK = b64u(JSON.stringify({alg: 'HS256', typ: 'JWT'})) + '.' +
  b64u(JSON.stringify({uid: 1, usr: 'shanji', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600})) + '.' +
  b64u(crypto.createHmac('sha256', SECRET).update(
    b64u(JSON.stringify({alg: 'HS256', typ: 'JWT'})) + '.' +
    b64u(JSON.stringify({uid: 1, usr: 'shanji', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600}))).digest());

(async () => {
  const ws = new WebSocket(`wss://${HOST}/e?token=${TOK}`, {rejectUnauthorized: false});
  let frames = 0;
  ws.on('open', async () => {
    ws.send(JSON.stringify({type: 'subscribe', data: {device_ids: [DEV]}}));
    await new Promise(r => setTimeout(r, 800));
    // 点击设置图标（909,1410 来自之前的 UI dump）
    ws.send(JSON.stringify({type: 'vnc_touch', device_id: DEV, data: {cmd: 'click', x: 909, y: 1410}}));
    console.log('click sent (设置 909,1410)');
  });
  ws.on('message', raw => { try { if (JSON.parse(raw.toString()).type === 'screenshot') frames++; } catch {} });
  await new Promise(r => setTimeout(r, 8000));
  ws.close();
  console.log('frames after click:', frames);
  // 手机前台验证
  const {execSync} = require('child_process');
  try {
    const out = execSync(`adb -s 127.0.0.1:15563 shell "dumpsys window | grep -m2 mCurrentFocus"`, {timeout: 8000}).toString();
    console.log('focus:', out.trim().split('\n')[1] || out.trim());
  } catch (e) { console.log('focus check failed'); }
})();

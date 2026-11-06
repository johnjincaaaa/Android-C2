#!/usr/bin/env node
/** 验证 OPPO agent：设备列表 + 屏幕流激活 + 帧接收 */
const https = require('https');
const crypto = require('crypto');

const HOST = 'zxg123.com';
const SECRET = process.env.EAGLE_JWT_SECRET || require('fs').readFileSync(process.env.EAGLE_JWT_SECRET_FILE || '/var/www/eagle_php/.jwt_secret', 'utf8').trim();
const DEV = 'de63d84be06c6452';

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtSign = p => {
  const h = b64u(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const q = b64u(JSON.stringify(p));
  const s = b64u(crypto.createHmac('sha256', SECRET).update(h + '.' + q).digest());
  return `${h}.${q}.${s}`;
};
const TOK = jwtSign({uid: 1, usr: 'shanji', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600});

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: HOST, path, method, rejectUnauthorized: false,
      headers: {'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'}}, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // 1. 设备列表
  const devs = await api('GET', '/m/devices?page=1&size=10');
  console.log('devices total:', devs.total, 'online:', devs.online_count);
  for (const d of devs.items.slice(0, 5))
    console.log(' -', d.id, d.model, d.source, 'online:', d.online, d.app_name);

  // 2. 激活屏幕流
  const r = await api('POST', `/m/device/${DEV}/command`, {command: 'SCREEN_CAPTURE_SET_TECH', payload: {}});
  console.log('screen-start cmd:', JSON.stringify(r));

  // 3. WS 订阅收帧（10s）
  const WebSocket = require('ws');
  const ws = new WebSocket(`wss://${HOST}/e?token=${TOK}`, {rejectUnauthorized: false});
  const types = {};
  ws.on('open', () => ws.send(JSON.stringify({type: 'subscribe', data: {device_ids: [DEV]}})));
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      types[m.type] = (types[m.type] || 0) + 1;
      if (m.type === 'screenshot' && types.screenshot === 1)
        console.log('first frame b64 len:', ((m.data || {}).image || '').length);
    } catch {}
  });
  await new Promise(r2 => setTimeout(r2, 10000));
  ws.close();
  console.log('ws types:', JSON.stringify(types));
})();

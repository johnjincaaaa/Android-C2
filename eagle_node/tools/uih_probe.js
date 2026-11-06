#!/usr/bin/env node
/** 抓 agent GET_UI_HIERARCHY 回包：订阅 WS + 触发命令 + 打印所有回包 */
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const HOST = 'zxg123.com';
const SECRET = process.env.EAGLE_JWT_SECRET || require('fs').readFileSync(process.env.EAGLE_JWT_SECRET_FILE || '/var/www/eagle_php/.jwt_secret', 'utf8').trim();
const DEV = 'de63d84be06c6452';
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hd = b64u(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
const pl = b64u(JSON.stringify({uid: 1, usr: 'shanji', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600}));
const TOK = `${hd}.${pl}.${b64u(crypto.createHmac('sha256', SECRET).update(hd + '.' + pl).digest())}`;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({hostname: HOST, path, method, rejectUnauthorized: false,
      headers: {'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'}}, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const ws = new WebSocket(`wss://${HOST}/e?token=${TOK}`, {rejectUnauthorized: false});
  const seen = [];
  ws.on('open', async () => {
    ws.send(JSON.stringify({type: 'subscribe', data: {device_ids: [DEV]}}));
    console.log('subscribed, triggering GET_UI_HIERARCHY...');
    await api('POST', `/m/device/${DEV}/command`, {command: 'GET_UI_HIERARCHY', payload: {}});
    setTimeout(() => ws.send(JSON.stringify({type: 'command', device_id: DEV,
      data: {command: 'catAllViewSwitch', payload: {on: true}}})), 3000);
  });
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribed') return;
      const s = JSON.stringify(m);
      seen.push(m.type);
      console.log(`[${m.type}]`, s.slice(0, 260));
    } catch {}
  });
  setTimeout(() => { console.log('types seen:', JSON.stringify(seen)); process.exit(0); }, 12000);
})();

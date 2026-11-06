// 构建任务队列助手（跑在 45 上，本地 build_worker 通过 ssh 调用）
// 用法: node buildq.js <list-pending|claim|update> [args...]  （参数 base64 编码）
const db = require('/root/eagle_node/node_modules/better-sqlite3')('/root/xyzcs_replica.db');
const dec = s => { try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch (e) { return s; } };
const cmd = dec(process.argv[2]);
const store = 'builds';
function listAll() { return db.prepare("SELECT data FROM generic WHERE store=?").all(store).map(r => JSON.parse(r.data)); }
function save(b) { db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES(?,?,?,datetime('now'))").run(store, String(b.id), JSON.stringify(b)); }
if (cmd === 'list-pending') {
  console.log(JSON.stringify(listAll().filter(b => b.status === 'pending')));
} else if (cmd === 'claim') {
  const b = listAll().find(x => String(x.id) === dec(process.argv[3]));
  if (b && b.status === 'pending') { b.status = 'building'; b.progress = 10; save(b); console.log(JSON.stringify(b)); }
  else console.log('null');
} else if (cmd === 'update') {
  const b = listAll().find(x => String(x.id) === dec(process.argv[3]));
  if (b) { Object.assign(b, JSON.parse(dec(process.argv[4]))); save(b); console.log('ok'); }
  else console.log('null');
} else if (cmd === 'reset-building') {
  let n = 0;
  for (const b of listAll()) { if (b.status === 'building') { b.status = 'pending'; save(b); n++; } }
  console.log(String(n));
} else console.log('usage: list-pending | claim <id> | update <id> <json> | reset-building');

// 服务器快速诊断：q.js <devices|kv|log|url>
const db = require('/root/eagle_node/node_modules/better-sqlite3')('/root/xyzcs_replica.db');
const cmd = process.argv[2];
if (cmd === 'devices') {
  try {
    const r = db.prepare('SELECT id,data FROM devices').all();
    console.log('count=' + r.length);
    for (const x of r) console.log(x.id, '|', String(x.data).slice(0, 300));
  } catch (e) { console.log('ERR:' + e.message); }
} else if (cmd === 'kv') {
  const r = db.prepare("SELECT key,data FROM kv").all();
  console.log('kv count=' + r.length);
  for (const x of r) console.log(x.key, '|', String(x.data).slice(0, 200));
}

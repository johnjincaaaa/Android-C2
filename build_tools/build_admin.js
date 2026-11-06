// 构建任务操作助手（服务器端）：build_list.js 列出全部；build_push.js <id> <label> <server_url> 插入 pending
const db = require('/root/eagle_node/node_modules/better-sqlite3')('/root/xyzcs_replica.db');
const cmd = process.argv[2];
const rows = db.prepare("SELECT id,data FROM generic WHERE store='builds'").all();
if (cmd === 'list') {
  for (const r of rows) {
    const b = JSON.parse(r.data);
    console.log(String(r.id), '|', b.status, '|', (b.app_label || ''), '|', (b.progress || 0) + '%', '|', ((b.log || []).slice(-2).join(' / ')));
  }
} else if (cmd === 'push') {
  const id = Number(process.argv[3]);
  const label = process.argv[4] || '花木终端';
  const url = process.argv[5] || '';
  if (!/^\d{1,12}$/.test(String(id))) { console.log('bad id'); process.exit(1); }
  const b = { id, app_label: label, server_url: url, bind_user: 'admin', status: 'pending', progress: 0, log: [] };
  db.prepare("INSERT OR REPLACE INTO generic(store,id,data,updated_at) VALUES(?,?,?,datetime('now'))").run('builds', String(id), JSON.stringify(b));
  console.log('pushed build', id);
} else if (cmd === 'get') {
  const r = rows.find(x => x.id === String(process.argv[3]));
  console.log(r ? r.data : 'null');
}

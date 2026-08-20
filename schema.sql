-- D1 数据库 schema（meting-users）
-- 执行方式：wrangler d1 execute meting-users --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,      -- PBKDF2-SHA256, 100k 迭代, 格式 "saltHex:hashHex"
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,           -- 256-bit 随机 hex token
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL       -- unix 秒，90 天有效期
);

CREATE TABLE IF NOT EXISTS play_counts (
  user_id INTEGER NOT NULL,
  song_key TEXT NOT NULL,           -- 稳定歌曲标识："ne:{网易云ID}" / "lo:{音频URL}" / "ti:{歌名|歌手}"
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, song_key)
);

CREATE TABLE IF NOT EXISTS login_throttle (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL     -- 登录失败限流：10 次 / 10 分钟 / IP
);

-- ====================================================
-- FlarePanel 账号 Worker 数据表（Cloudflare D1 / SQLite）
-- 在账号库（sites.config.js 里的 accountDb）执行，已有同名表会跳过：
--   npx wrangler d1 execute <账号库名> --remote --file=account/schema.sql --config account/wrangler.jsonc
--
-- users 表的前五列（id、username、password_hash、created_at、last_login_at）和仓库根目录 schema.sql 一致，
-- FlarePanel「账号管理」读写它们（不读 password_hash）；后面三列只有 Worker 用，后台不读。
--
-- 已经用根目录 schema.sql 建过 users 表的，CREATE TABLE 会被跳过，需要手动补上 Worker 用的三列（每条只执行一次）：
--   ALTER TABLE users ADD COLUMN salt TEXT NOT NULL DEFAULT '';
--   ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
-- ====================================================

-- 会员账号（FlarePanel「账号管理」）
CREATE TABLE IF NOT EXISTS users (
    id                 TEXT    PRIMARY KEY,                     -- UUID
    username           TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- 唯一，英文字母不分大小写
    password_hash      TEXT    NOT NULL,                        -- pbkdf2$迭代数$十六进制哈希（PBKDF2-SHA256）。后台不读
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,      -- UTC
    last_login_at      DATETIME,                                -- 最近一次登录，UTC
    -- ---------- 以下只有 Worker 使用 ----------
    salt               TEXT    NOT NULL DEFAULT '',             -- 密码哈希的随机盐，每次改密都换新
    token_version      INTEGER NOT NULL DEFAULT 0,              -- 登录凭证版本：改密或重置密码时 +1，旧凭证全部失效
    recovery_code_hash TEXT                                     -- 恢复码的 SHA-256（明文只在生成时返回一次）
);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- 频率限制计数（固定窗口，IP 只存哈希，过期记录会被自动清理）
-- 和评论 Worker（worker/schema.sql）的同名表结构相同，两个 Worker 用同一个库也没问题
CREATE TABLE IF NOT EXISTS rate_limits (
    k           TEXT    PRIMARY KEY,
    n           INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL                  -- Unix 秒
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

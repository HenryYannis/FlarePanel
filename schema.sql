-- ====================================================
-- FlarePanel 数据表结构（Cloudflare D1 / SQLite）
-- 后台只读写这些字段；你的网站或评论 Worker 可以加更多字段，后台不受影响。
-- 用仓库里的评论 Worker（worker/）时，改用 worker/schema.sql：它包含下面的评论库表，外加 Worker 自己用的几张表。
--
-- 评论库（sites.config.js 里的 commentDb）：comments、article_views、file_downloads
--   npx wrangler d1 execute <评论库名> --remote --file=schema.sql
-- 账号库（accountDb）只需要 users 表，可以单独执行最后一段。
-- ====================================================

-- 评论
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick        TEXT    NOT NULL,                 -- 昵称
    comment     TEXT    NOT NULL,                 -- 评论内容
    url         TEXT    NOT NULL,                 -- 所在页面路径，如 /posts/hello/
    parent_id   INTEGER,                          -- 回复的评论 id，顶层评论为空
    ip          TEXT    DEFAULT '',               -- 只在后台显示，公开接口不要返回
    likes       INTEGER DEFAULT 0,
    is_author   INTEGER DEFAULT 0,                -- 1 = 站长在后台回复的
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP -- UTC
);
CREATE INDEX IF NOT EXISTS idx_comments_url     ON comments(url);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);

-- 页面浏览量（每个页面一行，网站每次访问 +1）
CREATE TABLE IF NOT EXISTS article_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL UNIQUE,          -- 页面路径
    views       INTEGER DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_article_views_views ON article_views(views);

-- R2 文件下载次数（文件管理里显示，重命名/移动文件时后台会同步路径）
CREATE TABLE IF NOT EXISTS file_downloads (
    file_path   TEXT    PRIMARY KEY,              -- 存储桶里的对象 Key
    downloads   INTEGER DEFAULT 0
);

-- ====================================================
-- 账号库（accountDb）
-- ====================================================
CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,            -- 推荐 UUID
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE, -- 英文字母不分大小写
    password_hash TEXT    NOT NULL,               -- 后台不读这一列，只给你的网站登录用
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME,
    -- 以下三列只有配套账号 Worker（account/）使用，后台不读；不用账号 Worker 也可以留着
    salt               TEXT    NOT NULL DEFAULT '', -- 密码哈希的随机盐
    token_version      INTEGER NOT NULL DEFAULT 0,  -- 登录凭证版本，改密后旧凭证失效
    recovery_code_hash TEXT                         -- 恢复码的 SHA-256
);

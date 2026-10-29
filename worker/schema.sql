-- ====================================================
-- FlarePanel 评论 Worker 数据表（Cloudflare D1 / SQLite）
-- 一次建好评论库需要的全部表，已有同名表会跳过：
--   npx wrangler d1 execute <评论库名> --remote --file=worker/schema.sql
--
-- 前三张表（comments、article_views、file_downloads）和仓库根目录 schema.sql 完全一致，FlarePanel 后台读写它们；
-- 后四张表只有 Worker 用，后台不读。
-- 账号库（users 表）Worker 不用，见根目录 schema.sql。
-- ====================================================

-- 评论（FlarePanel「评论管理」）
CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nick        TEXT    NOT NULL,                 -- 昵称
    comment     TEXT    NOT NULL,                 -- 评论内容
    url         TEXT    NOT NULL,                 -- 所在页面路径，如 /posts/hello
    parent_id   INTEGER,                          -- 回复的评论 id，顶层评论为空
    ip          TEXT    DEFAULT '',               -- 只在后台显示，公开接口不返回
    likes       INTEGER DEFAULT 0,
    is_author   INTEGER DEFAULT 0,                -- 1 = 站长（后台回复，或带 X-Admin-Token 发表）
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP -- UTC
);
CREATE INDEX IF NOT EXISTS idx_comments_url     ON comments(url);
CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);

-- 页面浏览量（FlarePanel「浏览数量」），每个页面一行
CREATE TABLE IF NOT EXISTS article_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL UNIQUE,          -- 页面路径
    views       INTEGER DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_article_views_views ON article_views(views);

-- R2 文件下载次数（FlarePanel「文件分享」显示）
CREATE TABLE IF NOT EXISTS file_downloads (
    file_path   TEXT    PRIMARY KEY,              -- 存储桶里的对象 Key
    downloads   INTEGER DEFAULT 0
);

-- ---------- 以下只有 Worker 使用 ----------

-- 文章点赞，每个页面一行
CREATE TABLE IF NOT EXISTS article_likes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL UNIQUE,
    likes       INTEGER DEFAULT 0
);

-- 通用投票（工具、游戏、作品等），推荐 +1、不推荐 -1
CREATE TABLE IF NOT EXISTS item_likes (
    item_id     TEXT    PRIMARY KEY,
    item_name   TEXT    DEFAULT '',
    likes       INTEGER DEFAULT 0
);

-- 在线人数心跳，id = 房间:客户端
CREATE TABLE IF NOT EXISTS site_online (
    id          TEXT    PRIMARY KEY,
    room        TEXT    NOT NULL DEFAULT 'site',
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_online_room ON site_online(room, updated_at);

-- 频率限制计数（按分钟的固定窗口，IP 只存哈希，过期记录会被自动清理）
CREATE TABLE IF NOT EXISTS rate_limits (
    k           TEXT    PRIMARY KEY,
    n           INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER NOT NULL                  -- Unix 秒
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

-- ==============================================================================
-- FlarePanel / web-panel 生产与下游 D1 数据库升级与清洗脚本 (2026-11)
-- 适用生态：小宝科技站 (xbkjz)、小宝命理站 (xbmlz)、小宝游戏站 (xbyxz)
-- 执行方式：在终端使用 wrangler d1 execute 执行，或直接在 Cloudflare D1 控制台 Console 执行
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. 命理站账号与集中审计库 (xbmlz-account)
-- D1 Database: xbmlz-account (ID: f73c905f-f597-40de-b3ac-1a9e3b3cf801)
-- 命令示例：npx wrangler d1 execute xbmlz-account --remote --command="<SQL>"
-- ------------------------------------------------------------------------------

-- [1.1] ai_logs 运行监控覆盖索引升级 (大幅提升近 7 天/30 天按服务商与站点的聚合速度)
CREATE INDEX IF NOT EXISTS idx_ai_logs_date_provider ON ai_logs(date, provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_date_site     ON ai_logs(date, site_id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_created       ON ai_logs(created_at);

-- [1.2] users 会员表安全凭证版本字段升级 (改密/重置密码时 +1，使所有设备上的旧 JWT 即刻作废)
-- 若已有该列，D1 会提示 duplicate column name，可忽略
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- [1.3] (可选维护) ai_logs 历史日志归档清理 (保留近 90 天记录，防止单库行数超额)
-- DELETE FROM ai_logs WHERE date < DATE('now', '-90 day');


-- ------------------------------------------------------------------------------
-- 2. 游戏站账号库 (xbyxz-account)
-- D1 Database: xbyxz-account (ID: 21e832cd-b0a4-4ecf-b87c-2fa0c1283d3f)
-- 命令示例：npx wrangler d1 execute xbyxz-account --remote --command="<SQL>"
-- ------------------------------------------------------------------------------

-- [2.1] users 会员表安全凭证版本字段升级
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;


-- ------------------------------------------------------------------------------
-- 3. 科技站互动库 (xbkjz-comment)
-- D1 Database: xbkjz-comment (ID: 1b04e4aa-11bd-4922-a287-a09cfe3391dd)
-- 命令示例：npx wrangler d1 execute xbkjz-comment --remote --command="<SQL>"
-- ------------------------------------------------------------------------------

-- [3.1] file_downloads 补充最近一次下载时间字段
ALTER TABLE file_downloads ADD COLUMN last_downloaded_at DATETIME;

-- [3.2] 历史评论与浏览量 URL 规范化清洗 (去除 .html, /index.html 与非根目录尾部斜杠)
UPDATE comments SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE comments SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE comments SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;

UPDATE article_views SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE article_views SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE article_views SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;


-- ------------------------------------------------------------------------------
-- 4. 命理站互动库 (xbmlz-comment)
-- D1 Database: xbmlz-comment (ID: bcd3acc9-cea4-499b-9be4-5eb8e333b2f7)
-- 命令示例：npx wrangler d1 execute xbmlz-comment --remote --command="<SQL>"
-- ------------------------------------------------------------------------------

-- [4.1] 历史评论与浏览量 URL 规范化清洗
UPDATE comments SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE comments SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE comments SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;

UPDATE article_views SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE article_views SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE article_views SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;


-- ------------------------------------------------------------------------------
-- 5. 游戏站互动库 (xbyxz-comment)
-- D1 Database: xbyxz-comment (ID: e3632a19-0c69-479a-8069-66e1fc58370a)
-- 命令示例：npx wrangler d1 execute xbyxz-comment --remote --command="<SQL>"
-- ------------------------------------------------------------------------------

-- [5.1] file_downloads 补充最近一次下载时间字段
ALTER TABLE file_downloads ADD COLUMN last_downloaded_at DATETIME;

-- [5.2] 历史评论与浏览量 URL 规范化清洗
UPDATE comments SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE comments SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE comments SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;

UPDATE article_views SET url = REPLACE(url, '/index.html', '/') WHERE url LIKE '%/index.html';
UPDATE article_views SET url = REPLACE(url, '.html', '') WHERE url LIKE '%.html';
UPDATE article_views SET url = SUBSTR(url, 1, LENGTH(url) - 1) WHERE url LIKE '%/' AND LENGTH(url) > 1;

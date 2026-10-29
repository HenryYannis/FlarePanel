-- ====================================================
-- FlarePanel AI 网关：调用流水表（Cloudflare D1 / SQLite，可选）
-- 绑定了 D1（binding = "DB"）时，网关把每次调用写进 ai_logs，/v1/stats 用 SQL 聚合；
-- 不绑定 D1 时改写 KV 里的 STATS:DAILY:<日期> 和 STATS:RECENT_LOGS，后台照样能看统计。
--
--   npx wrangler d1 execute <库名> --remote --file=gateway/schema.sql --config gateway/wrangler.jsonc
--
-- 只存调用元数据（时间、站点、服务商、模型、状态、耗时、Token 数），不存提示词、回答和密钥。
-- ====================================================

CREATE TABLE IF NOT EXISTS ai_logs (
    id                TEXT    PRIMARY KEY,
    date              TEXT    NOT NULL,              -- YYYY-MM-DD，按 STATS_UTC_OFFSET_MINUTES 的时区分天
    time              TEXT    NOT NULL,              -- HH:MM:SS，同上
    timestamp         INTEGER NOT NULL,              -- 请求开始的毫秒时间戳（UTC）
    site_id           TEXT    NOT NULL DEFAULT 'other', -- 来源站点，对应 FlarePanel sites.config.js 的 aiSiteId；开发者密钥为密钥 ID
    site_name         TEXT,
    client            TEXT    NOT NULL DEFAULT 'unauth', -- unauth / auth / 开发者密钥名称
    user_id           TEXT,                          -- 站点登录用户 ID（只在配置了 JWT_SECRET 时有）
    user_name         TEXT,
    provider_id       TEXT    NOT NULL DEFAULT 'unknown',
    provider_name     TEXT,
    model             TEXT,
    status            INTEGER NOT NULL DEFAULT 200,
    latency_ms        INTEGER NOT NULL DEFAULT 0,    -- 非流式为总耗时，流式为首包耗时
    tokens            INTEGER NOT NULL DEFAULT 0,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    fallback          INTEGER NOT NULL DEFAULT 0,    -- 1 = 发生过降级
    error             TEXT,                          -- 失败或降级原因（简短说明，不含上游原文）
    page_path         TEXT,                          -- 调用页面路径（不含查询串）
    tool_name         TEXT,                          -- 图片 / 语音接口名
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_logs_date      ON ai_logs(date);
CREATE INDEX IF NOT EXISTS idx_ai_logs_timestamp ON ai_logs(timestamp);

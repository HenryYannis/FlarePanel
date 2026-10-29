# FlarePanel AI 网关 Worker

**简体中文** | [English](README.en.md)

FlarePanel「代理网关」栏目的配套后端：一个 OpenAI 兼容的 Cloudflare Worker，把多个服务商合成一个入口。服务商、模型、降级链和开发者密钥存在 KV，由 FlarePanel 后台编辑；网关读取后转发请求，失败自动换下一个模型或服务商，并记录用量统计给后台看。

单文件 `index.js`，不需要构建，也没有 npm 依赖。域名、来源网站、密钥都写在 wrangler 配置和 Secrets 里，代码里没有写死任何站点。

## 功能

| 功能 | 接口 | 说明 |
|---|---|---|
| 模型列表 | `GET /v1/models` | 列出已启用服务商的模型，ID 形如 `服务商ID/模型名` |
| 对话 | `POST /v1/chat/completions` | 流式（SSE）和非流式；按降级链自动重试 |
| 用量统计 | `GET /v1/stats?days=7` | 需要开发者密钥；返回字段就是后台监控页用的格式（1–30 天） |
| 刷新配置 | `POST /v1/reload` | 需要开发者密钥；后台保存配置后自动调用 |
| 图片、语音 | `POST /v1/images/generations`、`/v1/images/edits`、`/v1/audio/transcriptions` | 只给开发者密钥；按模型名找到登记它的服务商后原样转发 |
| 健康检查 | `GET /`、`GET /v1` | 只返回在线状态和版本 |
| 内部调用（可选） | Service Binding `GatewayRPC` | 同账号的其他 Worker 免密钥调用，外网访问不到 |

转发细节：

- 透传 `temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`reasoning_effort`、`tools`、`tool_choice`、`response_format`、`stop`、`seed` 等常用参数，其他字段丢弃。
- 流式请求自动加 `stream_options.include_usage`，上游不返回用量时按字数估算 Token。
- 服务商的 `baseUrl` 填 `cloudflare-workers-ai` 并绑定 `AI` 时，用 Workers AI 调用（流式输出会转成 OpenAI 格式）。

## 和 FlarePanel 的对应关系

| FlarePanel `sites.config.js` | 网关 |
|---|---|
| `AI_HUB.gatewayUrl` | 网关地址加 `/v1`，例如 `https://ai.example.com/v1` |
| `AI_HUB.kvNamespaceId` | 网关绑定为 `CONFIG_KV` 的 KV 命名空间 ID |
| `AI_HUB.configKey` | 网关的 `CONFIG_KEY`（默认都是 `AI_GATEWAY_CONFIG`） |
| 各站点的 `aiSiteId` | 网关 `SITE_IDS` 里该站点主机名对应的 site_id |
| 后台域名 | 必须写进网关的 `ALLOWED_ORIGINS` |

后台写进 KV 的配置（网关只读这些字段）：

```jsonc
{
  "version": 1,
  "gateway": {
    "keys": [{ "id": "key_1", "name": "VS Code", "key": "sk-fp-...", "enabled": true }], // 开发者密钥
    "masterKey": "sk-fp-..."                       // 旧版单密钥，仍然认
  },
  "sitePolicy": {
    "fallbackChain": ["provider_a", "provider_b"], // 降级链顺序；其余启用的服务商排在后面兜底
    "unauthDailyLimit": 20,                        // 公开访问时游客每天次数（PUBLIC_ACCESS=true 才生效）
    "authDailyLimit": 100,                         // 公开访问时登录用户每天次数
    "moderationModel": "provider_a/some-model"     // model 填 "moderation" 时用它
  },
  "telegram": { "enabled": true, "botToken": "", "chatId": "" },
  "providers": [{
    "id": "provider_a", "name": "Provider A", "enabled": true,
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",                            // 或 "env:PROVIDER_KEY_A"，从同名 Secret 读取
    "models": "model-1, model-2",
    "pollModels": ["model-1", "model-2"],          // 本服务商内依次尝试的模型；不填只用 defaultModel
    "defaultModel": "model-1",
    "timeoutMs": 45000                             // 可选
  }]
}
```

## 请求怎么路由

请求里的 `model`：

| 写法 | 行为 |
|---|---|
| 不填、`auto`、`default` | 按 `fallbackChain` 依次尝试 |
| `provider_a` | 只用这家，依次尝试它勾选的模型 |
| `provider_a/model-2` | 只用这家，先试 `model-2`，失败再试它其他勾选的模型 |
| `model-2` | 所有登记了这个模型的服务商依次尝试 |
| `moderation` | 换成 `sitePolicy.moderationModel`，没设就走降级链 |

每家服务商内先轮完勾选的模型，再换下一家。超时、网络错误、任何非 2xx 都会换下一个；全部失败时返回最后一次的状态码。统计里记录降级经过（哪家哪个模型、简短原因），不记录上游原文。

## 谁能调用

| 调用方 | 怎么认 | 限制 |
|---|---|---|
| 开发者 | `Authorization: Bearer <密钥>`（也认 `x-api-key`），密钥是后台「开发者密钥」里的任意一个、旧版 `masterKey` 或 Secret `MASTER_KEY` | 不限次数，可以用全部接口 |
| 站点登录用户 | `PUBLIC_ACCESS=true` 且设置了 `JWT_SECRET` 时，白名单网站带的 HS256 JWT（`sub`、`id` 或 `userId` 为用户 ID） | 每天 `authDailyLimit` 次，只能用 models 和 chat |
| 站点游客 | `PUBLIC_ACCESS=true` 时，`ALLOWED_ORIGINS` 里网站的浏览器请求 | 每天 `unauthDailyLimit` 次（按 IP 哈希计），只能用 models 和 chat |

`PUBLIC_ACCESS` 默认是 `false`：所有接口都要开发者密钥。打开公开访问前要知道：`Origin` 请求头可以被脚本伪造，次数限制是防刷用的，KV 计数也不是严格原子的。

## 部署

需要 Node.js 18+ 和 `npx wrangler`。以下命令都在仓库根目录执行。

### 1. 创建 KV（已经给 FlarePanel 建过就直接用）

```bash
npx wrangler kv namespace create AI_GATEWAY
```

记下 `id`，填到 `sites.config.js` 的 `AI_HUB.kvNamespaceId`。

### 2. 写配置

```bash
cp gateway/wrangler.example.jsonc gateway/wrangler.jsonc
```

打开 `gateway/wrangler.jsonc`：

- `name` 改成你的 Worker 名；
- `kv_namespaces` 填第 1 步的 `id`；
- `vars.ALLOWED_ORIGINS` 至少写上 FlarePanel 后台的域名；
- 按需改 `SITE_IDS`、`PUBLIC_ACCESS` 等（见下面的变量表）。

`gateway/wrangler.jsonc` 含有你的资源 ID，建议放在私有副本里，不要提交到公开仓库。

### 3. （可选）用 D1 存调用流水

不建 D1 也能用：统计会写进 KV 的 `STATS:DAILY:<日期>` 和 `STATS:RECENT_LOGS`。调用量大时建议用 D1，KV 每天的免费写入次数有限。

```bash
npx wrangler d1 create example-ai-logs
# 把 database_id 填进 gateway/wrangler.jsonc 的 d1_databases，然后建表：
npx wrangler d1 execute example-ai-logs --remote --file=gateway/schema.sql --config gateway/wrangler.jsonc
```

### 4. 设置密钥（都可选）

```bash
npx wrangler secret put MASTER_KEY --config gateway/wrangler.jsonc
```

### 5. 部署

```bash
npx wrangler deploy --config gateway/wrangler.jsonc
```

然后在 FlarePanel 里把 `AI_HUB.enabled` 设为 `true`、`gatewayUrl` 填网关地址加 `/v1`，在「代理网关」栏目添加服务商、生成开发者密钥。后台保存时会自动调 `/v1/reload`。

## 变量（vars）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空 | 允许浏览器调用的网站，逗号分隔，带协议。带了 `Origin` 但不在名单里的请求一律 403（包括预检） |
| `ALLOW_LOCALHOST` | `false` | 本地调试时允许 `http://localhost`、`http://127.0.0.1` |
| `CONFIG_KEY` | `AI_GATEWAY_CONFIG` | KV 里的配置键名 |
| `CONFIG_CACHE_SECONDS` | `300` | 配置在内存里缓存多久。`/v1/reload` 只刷新收到请求的那个节点，其他节点最多等这么久 |
| `PUBLIC_ACCESS` | `false` | 是否允许白名单网站的访客不带密钥调用 |
| `UNAUTH_DAILY_LIMIT` | `20` | 游客每天次数，后台 `sitePolicy.unauthDailyLimit` 优先；`0` 不限 |
| `AUTH_DAILY_LIMIT` | `100` | 登录用户每天次数，后台 `sitePolicy.authDailyLimit` 优先；`0` 不限 |
| `RATE_LIMIT_EXEMPT_ORIGINS` | 空 | 不受每日次数限制的网站（完整 Origin，逗号分隔） |
| `SITE_IDS` | 空 | `主机名=site_id`，逗号分隔，子域名也匹配。没匹配上的记为 `other`，本地记为 `site_local`，开发者密钥记为密钥 ID |
| `HIDE_UPSTREAM_MODEL` | `true` | 返回给游客、登录用户的 `model` 字段换成请求里的值或 `auto`，不暴露上游模型名 |
| `UPSTREAM_TIMEOUT_MS` | `45000` | 单次对话请求等响应头的超时 |
| `MEDIA_TIMEOUT_MS` | `120000` | 图片、语音接口的超时 |
| `STATS_UTC_OFFSET_MINUTES` | `480` | 统计按哪个时区分天。FlarePanel 后台在网关不可用时会直接读 KV 统计，那段代码按 UTC+8 分天，改了日期会对不上 |
| `LOG_RETENTION_DAYS` | `60` | D1 流水保留天数，`0` 不清理 |
| `MAX_BODY_BYTES` | `2097152` | 对话请求体上限 |
| `MAX_MEDIA_BYTES` | `26214400` | 图片、语音请求体上限 |
| `ALERT_COOLDOWN_SECONDS` | `600` | 同一条 Telegram 告警的最短间隔 |
| `LOG_LANG` | `zh` | 统计里的失败原因和告警文字用中文还是英文（`en`） |

## 密钥（Secrets）

| 名称 | 说明 |
|---|---|
| `MASTER_KEY` | 额外的开发者密钥（后台「开发者密钥」之外） |
| `JWT_SECRET` | 识别站点登录用户的 HS256 密钥；不设就不区分登录用户 |
| `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 后台没填 Telegram 时的备用 |
| `PROVIDER_KEY_*` | 服务商 API Key 不想存在 KV 时，后台填 `env:PROVIDER_KEY_XXX`，网关从同名 Secret 读取。只认 `PROVIDER_KEY_` 开头的名字，别的 Secret 读不到 |

Telegram 告警只在游客、登录用户的请求发生服务商切换或全部失败时发，开发者密钥的请求不告警。

## 安全

- 开发者密钥用 SHA-256 摘要做常量时间比较，并且会比完所有候选密钥，不从耗时泄露信息。
- 严格 CORS：只给 `ALLOWED_ORIGINS` 回 `Access-Control-Allow-Origin`，不在名单里的 `Origin` 直接 403；不带 `Origin` 的请求（命令行、服务端）只能靠密钥。
- 返回给客户端的错误不含上游原文；开发者密钥能看到最后一次上游报错，但其中的服务商 Key、`Bearer` 令牌和常见 Key 格式会被抹掉。
- 日志和统计不记录提示词、回答和任何密钥；页面路径只存路径，不存查询串；限次计数里 IP 和用户 ID 只存哈希。
- 后台 KV 里存着服务商 Key 和开发者密钥，能写这个 KV 的 Cloudflare Token 等同于管理员权限。

发现安全问题请私下提交 GitHub Security Advisory，不要公开发 Issue。

## 内部调用（可选）

同一账号下的其他 Worker 可以用 Service Binding 免密钥调用（按开发者身份记账，统计里显示调用方名称）：

```jsonc
// 调用方的 wrangler 配置
"services": [{ "binding": "AI_GATEWAY", "service": "my-ai-gateway", "entrypoint": "GatewayRPC" }]
```

```js
const data = await env.AI_GATEWAY.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, 'my-worker');
const verdict = await env.AI_GATEWAY.moderate({ messages, site: 'blog' }); // 去掉 <think> 段后的文字
```

## 本地调试

```bash
cp gateway/wrangler.example.jsonc gateway/wrangler.jsonc   # 填好后
npx wrangler kv key put --local --binding CONFIG_KV AI_GATEWAY_CONFIG --path my-config.json --config gateway/wrangler.jsonc
npx wrangler dev --local --config gateway/wrangler.jsonc
```

本地调试时把 `ALLOW_LOCALHOST` 设为 `true`，Secrets 写在 `gateway/.dev.vars`（已被 `.gitignore` 忽略）。

## 许可证

[MIT](../LICENSE) © 2026 程小宝

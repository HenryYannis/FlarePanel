# FlarePanel

一个后台管理你所有 Cloudflare 网站：评论、浏览量、会员账号、R2 文件，以及可选的 AI 网关配置。

纯 Cloudflare Pages 部署，不需要服务器，不需要构建步骤。登录用你自己的 Cloudflare API Token，数据都在你自己的账号里。

*One dashboard for all your Cloudflare-hosted sites: comments, page views, users, R2 files and an optional AI gateway. Runs entirely on Cloudflare Pages with your own API token. No server, no build step.*

## 能做什么

| 栏目 | 读写的资源 | 功能 |
|---|---|---|
| 文件分享 | R2 存储桶 | 浏览目录、上传（大文件分片）、新建文件夹、重命名、移动、删除、复制链接，显示下载次数 |
| 评论管理 | D1 `comments` | 按页面筛选、搜索、以站长身份回复、单条或批量删除，可导出 CSV |
| 浏览数量 | D1 `article_views` | 按分类筛选、按浏览量或更新时间排序、删除、导出 CSV |
| 账号管理 | D1 `users` | 搜索、排序、删除会员，导出 CSV |
| 代理网关（可选） | KV | 管理 AI 网关的服务商、模型、降级链和用量统计，需要配套网关 Worker |

一个后台可以管多个站点，顶部切换。某类资源一个站点都没配置时，那个栏目会自动隐藏。

## 部署

### 1. Fork 或下载本仓库

### 2. 改 `sites.config.js`

这是唯一需要改的文件。每个站点写一项：

```js
export const SITES = [
    {
        name: '我的博客',
        url: 'https://blog.example.com',
        commentDb: 'blog-comment',   // D1 数据库名
        accountDb: '',               // 没有会员系统就留空
        bucket: 'blog-assets',       // R2 存储桶名
        filesDomain: 'https://files.example.com',
        aiSiteId: ''
    }
];
```

后台只列出这里写过的数据库和存储桶，账号里其他资源不会出现。

### 3. 建表

用 `schema.sql` 给评论库建表（已有同名表会跳过）：

```bash
npx wrangler d1 execute blog-comment --remote --file=schema.sql
```

你的网站或评论 Worker 负责写入评论、浏览量和下载次数，FlarePanel 负责管理。字段说明见 `schema.sql`。

### 4. 部署到 Cloudflare Pages

Cloudflare 控制台 → Workers 和 Pages → 创建 → Pages → 连接到 Git，选这个仓库：

- 框架预设：无
- 构建命令：留空
- 构建输出目录：`/`

或者命令行：

```bash
npx wrangler pages deploy . --project-name flarepanel
```

### 5. 设置环境变量

Pages 项目 → 设置 → 环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CF_ACCOUNT_ID` | 是 | 你的 Account ID，服务端接口用它确认来访者是本账号管理员 |
| `R2_ACCESS_KEY_ID` | 否 | R2 S3 API 密钥，填了才能上传 100 MB 以上的文件 |
| `R2_SECRET_ACCESS_KEY` | 否 | 同上 |

### 6. 建议加一层访问保护

后台本身靠 API Token 登录，但页面谁都能打开。建议在 Cloudflare Zero Trust → Access 给后台域名加一条邮箱验证，只有你能进。

## 登录用的 API Token

我的个人资料 → API 令牌 → 创建令牌 → 自定义令牌，账户级权限：

| 权限 | 用途 |
|---|---|
| D1 → 编辑 | 评论、浏览量、账号 |
| Workers R2 存储 → 编辑 | 文件分享 |
| Workers KV 存储 → 编辑 | 只有开启 AI Hub 才需要 |

Account ID 和 Token 只保存在你浏览器的 localStorage。请求经过本站 `/api/cf` 转发到 `api.cloudflare.com`（浏览器不能直接跨域调用），转发时不记录、不保存。在公用电脑上用完请点「退出登录」。

## 安全说明

- `/api/cf` 只转发到 `api.cloudflare.com`，没有你的 Token 什么也做不了。
- `/api/s3-credentials`、`/api/fetch-models`、`/api/test-telegram` 都会先用调用者的 Token 验证是否为 `CF_ACCOUNT_ID` 这个账号的管理员。
- `/api/fetch-models` 只允许访问 https 公网地址。
- 中间件会拦截 `.md`、`.sql`、点文件、`wrangler.*`、`scripts/`、`lib/` 等，不会被当成静态文件下载。
- CI 每次提交都跑 gitleaks 密钥扫描。

发现安全问题请私下提交 GitHub Security Advisory，不要公开发 Issue。

## AI Hub（可选）

AI Hub 管理一个 OpenAI 兼容的 AI 网关 Worker：服务商和模型存在 KV，网关读取后按降级链转发请求。网关 Worker 不在本仓库，没有就保持 `AI_HUB.enabled: false`，后台不显示这个栏目。网关需要提供：

| 接口 | 用途 |
|---|---|
| `GET /v1/models` | 当前可用模型 |
| `POST /v1/chat/completions` | 对话，支持流式 |
| `GET /v1/stats?days=7` | 用量统计 |
| `POST /v1/reload` | 后台保存配置后通知网关刷新，`Authorization: Bearer <Master Key>` |

## 本地预览

```bash
cp .dev.vars.example .dev.vars   # 填 CF_ACCOUNT_ID
npx wrangler pages dev .
```

## 技术栈

原生 HTML / CSS / ES Modules，后端是 Cloudflare Pages Functions。没有框架，没有构建，改完刷新就能看到。

## 许可证

[MIT](LICENSE) © 2026 程小宝

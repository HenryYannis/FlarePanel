# FlarePanel

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | [English](README.en.md)

一个后台管理你所有 Cloudflare 网站：评论、浏览量、会员账号、R2 文件，以及可选的 AI 网关配置。

[![CI](https://github.com/HenryYannis/FlarePanel/actions/workflows/check.yml/badge.svg)](https://github.com/HenryYannis/FlarePanel/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![FlarePanel](docs/social-preview.png)

纯 Cloudflare Pages 部署，不需要服务器，不需要构建步骤。登录用你自己的 Cloudflare API Token，数据都在你自己的账号里。

![登录页](docs/screenshots/login.png)

![代理网关](docs/screenshots/gateway.png)

## 功能

| 栏目 | 读写的资源 | 功能 |
|---|---|---|
| 文件分享 | R2 存储桶 | 浏览目录、上传（大文件分片）、新建文件夹、重命名、移动、删除、复制链接，显示下载次数 |
| 评论管理 | D1 `comments` | 按页面筛选、搜索、以站长身份回复、单条或批量删除，可导出 CSV |
| 浏览数量 | D1 `article_views` | 按分类筛选、按浏览量或更新时间排序、删除、导出 CSV |
| 账号管理 | D1 `users` | 搜索、排序、删除会员，导出 CSV |
| 代理网关（可选） | KV | 管理 AI 网关的服务商、模型、降级链和用量统计，需要配套网关 Worker |

- 一个后台可以管多个站点，顶部切换。某类资源一个站点都没配置时，那个栏目会自动隐藏。
- 代理网关的服务商列表里，API Key 默认显示为与密钥等长的星号，点眼睛或星号可切换明文。
- 仓库里带三个配套 Worker，都可以直接部署：网站这一侧写入评论和浏览量的评论 Worker 在 [`worker/`](worker/README.md)，会员注册登录的账号 Worker 在 [`account/`](account/README.md)，AI 网关 Worker 在 [`gateway/`](gateway/README.md)。

### 界面语言和夜间模式

- 支持简体中文、繁體中文和英文。顶部导航栏右侧的语言菜单切换，选择保存在浏览器里，切换后页面会刷新。
- 没手动选过时按浏览器语言：`zh-TW`、`zh-HK`、`zh-MO`、`zh-Hant` 用繁体，其他以 `zh` 开头用简体，其余用英文。
- 夜间模式默认跟随系统。语言菜单旁的月亮 / 太阳按钮可以手动切换；系统再次切换日夜时回到自动。
- 日期和数字按当前语言格式显示。
- 站点名、后台标题等写在 `sites.config.js` 里的内容属于你的数据，原样显示，不翻译。
- 词典在 `assets/js/i18n/zh.js`、`zh-Hant.js`、`en.js`，三个文件的键一一对应，CI 会检查（`scripts/check-i18n.mjs`）。繁体词典由简体用 OpenCC（s2twp）转换后修正用词。

## 部署

### 1. Fork 或下载本仓库

```bash
git clone https://github.com/HenryYannis/FlarePanel.git
cd FlarePanel
```

### 2. 改 `sites.config.js`

部署前只需要改这一个文件，每个站点写一项（各字段见下面的「配置」）：

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

账号库只需要 `users` 表，可以单独执行 `schema.sql` 的最后一段。

评论、浏览量和下载次数由网站这一侧写入，FlarePanel 负责管理。仓库里的 [`worker/`](worker/README.md) 就是配套的评论 Worker（评论、回复、点赞、浏览量、R2 下载次数），按它的说明部署即可；用 `worker/schema.sql` 建表会把 Worker 额外用到的几张表一起建好。也可以用你自己的 Worker，只要按下面的「数据表」写入。

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

Pages 项目 → 设置 → 环境变量（见下面「配置」里的 `.dev.vars.example`）。改完要重新部署一次才会生效。

### 6. 建议加一层访问保护

后台本身靠 API Token 登录，但页面谁都能打开。建议在 Cloudflare Zero Trust → Access 给后台域名加一条邮箱验证，只有你能进。

### 本地预览

```bash
cp .dev.vars.example .dev.vars   # 填 CF_ACCOUNT_ID
npx wrangler pages dev .
```

## 配置

### `.dev.vars.example`：环境变量

本地预览时复制为 `.dev.vars` 填写；线上在 Pages 项目的「设置 → 环境变量」里填同样的变量。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CF_ACCOUNT_ID` | 是 | 你的 Account ID（32 位）。服务端接口用它确认来访者是本账号管理员，`/api/cf` 和 `/api/s3` 也只转发这个账号的请求。不填的话所有接口都会返回「服务端未配置」 |
| `R2_ACCESS_KEY_ID` | 否 | R2 S3 API 密钥。不填时单个文件最大约 95 MB；填了以后 50 MB 以上的文件改用 S3 分片上传（每片 10 MB），可以传更大的文件 |
| `R2_SECRET_ACCESS_KEY` | 否 | 同上 |

### `wrangler.jsonc`：Pages 项目

只有三项：项目名 `name`（默认 `flarepanel`）、构建输出目录 `pages_build_output_dir`（`.`，即仓库根目录整个发布）和 `compatibility_date`。`wrangler pages dev` / `wrangler pages deploy` 会读取它。根目录会整个发布，所以 `functions/_middleware.js` 会拦截内部文件（见「安全说明」）。

### `sites.config.js`：站点

有三部分。

**`PANEL`：后台整体**

| 字段 | 说明 |
|---|---|
| `title` | 后台标题，显示在浏览器标签和顶部导航栏 |
| `adminName` | 在后台回复评论时用的昵称。可以写成 `{ zh: '站长', en: 'Admin' }`，按界面语言选择 |
| `viewTypes` | 浏览量统计的页面分类，按网址前缀匹配，例如 `{ key: 'posts', label: { zh: '文章', en: 'Posts' }, prefixes: ['/posts/'] }`。`label` 可以是普通文字或多语言对象（可加 `'zh-Hant'`，没写时繁体界面用 `zh`）。没匹配上的归入「其他页面」 |
| `viewExcludes` | 浏览量统计里不显示的页面，网址里含这些关键词就跳过 |

**`SITES`：每个站点一项**（站点顺序就是后台里站点按钮的顺序）

| 字段 | 说明 |
|---|---|
| `name` | 站点显示名 |
| `url` | 站点网址，评论和浏览量里的相对路径会拼成这个网址的链接 |
| `commentDb` | 评论库的 D1 数据库名（不是 ID），存 `comments`、`article_views`、`file_downloads` |
| `accountDb` | 账号库的 D1 数据库名，存 `users`，没有会员系统就留空 |
| `bucket` | R2 存储桶名，不用文件管理就留空 |
| `filesDomain` | 存储桶绑定的公开域名，用于复制文件链接和快速读取 |
| `aiSiteId` | AI 网关日志里这个站点的 `site_id`，不用 AI Hub 就留空 |
| `viewTypes` | 可选，覆盖 `PANEL.viewTypes` |

用不到的资源留空字符串，对应栏目会自动隐藏这个站点。

**`AI_HUB`：AI 网关（可选）**

| 字段 | 说明 |
|---|---|
| `enabled` | 是否显示「代理网关」栏目 |
| `gatewayUrl` | 网关地址，以 `/v1` 结尾 |
| `kvNamespaceId` | 网关读取配置的 KV 命名空间 ID |
| `configKey` | KV 里的配置键名，默认 `AI_GATEWAY_CONFIG` |
| `logsDb` | 网关绑定的 D1 日志库名（有 `ai_logs` 表）；后台没有开发者密钥时运行监控直接查它，留空自动查找 |

## 使用

### 登录用的 API Token

我的个人资料 → API 令牌 → 创建令牌 → 自定义令牌，账户级权限：

| 权限 | 用途 |
|---|---|
| D1 → 编辑 | 评论、浏览量、账号（登录时也用它验证 Token） |
| Workers R2 存储 → 编辑 | 文件分享 |
| Workers KV 存储 → 编辑 | 只有开启 AI Hub 才需要 |

Account ID、API Token，以及（若配置了）R2 S3 密钥，只保存在你浏览器的 localStorage。请求经过本站 `/api/cf` 转发到 `api.cloudflare.com`（浏览器不能直接跨域调用），转发时不记录、不保存。登录时填的 Account ID 必须和环境变量 `CF_ACCOUNT_ID` 一致。在公用电脑上用完请点「退出账号」，退出会清掉 Token 和缓存的 S3 密钥。

### 数据表

`schema.sql` 里有完整建表语句和字段注释。后台只读写下面这些字段，你的网站可以加更多字段，后台不受影响。

| 表 | 所在库 | 主要字段 | 说明 |
|---|---|---|---|
| `comments` | 评论库 | `id`、`nick`、`comment`、`url`、`parent_id`、`ip`、`likes`、`is_author`、`created_at` | 评论。`parent_id` 是回复的评论 id；`is_author = 1` 表示站长在后台回复的；`created_at` 存 UTC |
| `article_views` | 评论库 | `id`、`url`（唯一）、`views`、`updated_at` | 每个页面一行，网站每次访问 +1 |
| `file_downloads` | 评论库 | `file_path`（主键）、`downloads` | R2 文件下载次数；后台重命名、移动文件时会同步路径 |
| `users` | 账号库 | `id`、`username`（唯一）、`password_hash`、`created_at`、`last_login_at` | 会员账号。后台不读 `password_hash` |

配套评论 Worker 另外用到 `article_likes`、`item_likes`、`site_online`、`rate_limits` 四张表，后台不读，建表语句在 `worker/schema.sql`。配套账号 Worker 在 `users` 表上另外用到 `salt`、`token_version`、`recovery_code_hash` 三列（根目录 `schema.sql` 已包含，后台不读），并用到 `rate_limits` 表，建表语句在 `account/schema.sql`。

### AI Hub（可选）

AI Hub 管理一个 OpenAI 兼容的 AI 网关 Worker：服务商和模型存在 KV，网关读取后按降级链转发请求。配套网关在 [`gateway/`](gateway/README.md)，可以直接部署；不用就保持 `AI_HUB.enabled: false`，后台不显示这个栏目。网关主要接口：

| 接口 | 用途 |
|---|---|
| `GET /v1/models` | 当前可用模型 |
| `POST /v1/chat/completions` | 对话，支持流式 |
| `GET /v1/stats?days=7` | 用量统计，需要开发者密钥（Master Key） |
| `POST /v1/reload` | 后台保存配置后通知网关刷新，`Authorization: Bearer <Master Key>` |

网关还提供图片、语音转发和健康检查接口，见 [`gateway/README.md`](gateway/README.md)。后台域名要写进网关的 `ALLOWED_ORIGINS`，否则统计、测速和保存后刷新会被拒绝。

Telegram 告警的「发送测试通知」走本站的 `/api/test-telegram`，需要已登录后台。

### 自动同步私有副本（可选）

如果你 fork 后在自己的私有仓库里放个人配置，可以让本仓库 main 一有新提交就通知它同步，不用等定时任务：

1. 建一个细粒度 Personal Access Token，只授权下游仓库，权限给 Contents、Workflows（读写）。
2. 在本仓库（或你的 fork）Settings → Secrets and variables → Actions 加两个 Secrets：`DOWNSTREAM_REPO`（如 `yourname/my-panel`）、`DOWNSTREAM_TOKEN`。
3. 下游仓库的同步工作流加上触发条件：

```yaml
on:
  repository_dispatch:
    types: [flarepanel-updated]
```

没配置这两个 Secrets 时 `.github/workflows/notify-downstream.yml` 会直接跳过。

## 安全说明

所有 `/api/*` 接口都要求调用者是 `CF_ACCOUNT_ID` 这个账号的管理员：用调用者的 Cloudflare API Token 去列一次本账号的 D1 数据库或 R2 存储桶，能列出来才放行。验证通过的结果按 Token 的 SHA-256 在内存里缓存约 1 分钟，避免每个请求都多问一次 Cloudflare。吊销或轮换 Token 后，同一 isolate 内最多约 1 分钟仍可能放行。

| 接口 | 保护措施 |
|---|---|
| `/api/cf/*` | 必须带管理员 Token（`Authorization: Bearer`），并且只转发 `accounts/<CF_ACCOUNT_ID>/...` 下的接口；别的账号 ID 返回 403，账号以外的路径（如 `user/...`）返回 403，带 `..` 跳出账号目录的路径也会被拒绝 |
| `/api/s3/*` | 只转发到 `<CF_ACCOUNT_ID>.r2.cloudflarestorage.com`，请求头里的账号 ID 只用来核对，不一致返回 403。`Authorization` 里是 S3 签名，所以登录 Token 放在单独的 `x-cf-token` 头里校验（需要 R2 权限），这个头不会转发给 R2。CORS 预检已允许这个头 |
| `/api/s3-credentials` | 管理员 Token（R2 权限）才能取到 S3 密钥 |
| `/api/fetch-models` | 管理员 Token；只允许 https 公网 DNS 主机名（禁止 IP、localhost、内网主机名；不跟随重定向） |
| `/api/test-telegram` | 管理员 Token。前端只通过这个接口发测试消息，不从浏览器直连 Telegram；测试消息内容是通用文字，不含站点名 |

其他：

- 接口的错误信息按请求头 `Accept-Language` 返回简体中文、繁体中文或英文，并带一个 `code` 字段；后台前端会按界面语言发送这个请求头。
- 中间件会拦截 `.md`、`.sql`、点文件、`wrangler.*`、`docs/`、`scripts/`、`lib/`、`worker/`、`account/`、`gateway/` 等，不会被当成静态文件下载。
- CI 在每个 PR 和每次推送到 main 时跑 gitleaks 密钥扫描。

发现安全问题请私下提交 GitHub Security Advisory，不要公开发 Issue。

## 技术栈

原生 HTML / CSS / ES Modules，后端是 Cloudflare Pages Functions。没有框架，没有构建，改完刷新就能看到。三个配套 Worker（`worker/`、`account/`、`gateway/`）都是单文件 Cloudflare Worker，同样没有 npm 依赖。

CI（`.github/workflows/check.yml`）在每个 PR 和推送到 main 时运行：仓库卫生、Pages 配置格式、gitleaks、HTML 结构、全部 JS 语法、JSON / TOML / CSS 语法、站内链接和多语言词典。

## 相关教程

FlarePanel 管理的评论、浏览量、R2 文件和 AI 网关，背后的搭法都写在小宝科技站的「Cloudflare 建站」系列里：

- [腾讯云域名 + GitHub + Cloudflare Pages 实现全球流畅访问](https://xbkjz.cn/posts/2026/02-10-cloudflare-pages-deployment/)
- [Cloudflare Pages 部署踩坑实录：从 522 报错到完美重定向](https://xbkjz.cn/posts/2026/02-10-cloudflare-pages-troubleshooting/)
- [用 Cloudflare 全家桶打造安全高效的网站基础设施](https://xbkjz.cn/posts/2026/03-07-cloudflare-comment-system/)
- [零成本搭建评论系统：用 D1 + Workers 为静态博客实现评论功能](https://xbkjz.cn/posts/2026/03-08-cloudflare-d1-comment-system/)
- [给评论区加装「防弹衣」：Workers 敏感词过滤与高性能缓存实战](https://xbkjz.cn/posts/2026/03-10-cloudflare-workers-security-cache/)
- [免注册一键部署静态网页：Cloudflare Drop 体验](https://xbkjz.cn/posts/2026/07-09-cloudflare-drop/)
- [防刷指南：利用 Workers + KV 限制前端模型接口访问次数](https://xbkjz.cn/posts/2026/07-09-cloudflare-workers-rate-limiting/)
- [用 Cloudflare R2 免费搭自己的文件分享网盘](https://xbkjz.cn/posts/2026/08-28-cloudflare-r2-file-sharing/)
- [用 Workers 零成本打造永不停机的统一 AI 大模型网关](https://xbkjz.cn/posts/2026/10-06-cloudflare-workers-ai-gateway/)
- [新手后台配置避坑全指南：从 SSL 到安全加速逐项拆解](https://xbkjz.cn/posts/2026/10-12-cloudflare-settings-guide/)
- [Cloudflare 核心配置与避坑速查表](https://xbkjz.cn/wiki/cloudflare-settings/)

## 相关项目

- [FlareRouter](https://github.com/HenryYannis/FlareRouter)：部署在单个 Cloudflare Worker 上的个人 AI 网关，同时提供 OpenAI 兼容和 Anthropic 接口，多家服务商一个地址、失败自动切换。

## 许可证

[MIT](LICENSE) © 2026 程小宝

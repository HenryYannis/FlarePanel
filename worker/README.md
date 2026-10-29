# FlarePanel 评论 Worker

**简体中文** | [English](README.en.md)

FlarePanel 的配套后端：一个 Cloudflare Worker，给静态网站提供评论、回复、点赞、浏览量等接口，数据写进 D1，由 FlarePanel 后台管理。可选用 R2 做文件下载（带下载次数），可选接 Telegram 推送新评论。

单文件 `index.js`，不需要构建，也没有 npm 依赖。站点相关的东西（域名、站名、Telegram 等）全部写在 wrangler 配置和密钥里。

## 功能

| 功能 | 接口 | 写入的表 | FlarePanel 栏目 |
|---|---|---|---|
| 评论、回复 | `GET/POST /api/comment`、`POST /api/comment/reply` | `comments` | 评论管理 |
| 评论点赞 | `POST /api/comment/like` | `comments.likes` | 评论管理 |
| 页面浏览量 | `GET/POST /api/article/view` | `article_views` | 浏览数量 |
| 文件下载次数 | 文件域名下的 `GET /<文件路径>` | `file_downloads` | 文件分享 |
| 文章点赞 | `GET/POST /api/article/like` | `article_likes` | 无（只给网站用） |
| 通用投票（推荐 / 不推荐） | `GET /api/item/votes`、`POST /api/item/upvote`、`POST /api/item/downvote` | `item_likes` | 无 |
| 在线人数 | `POST /api/online/heartbeat`、`GET /api/online` | `site_online` | 无 |

安全和防刷：

- 只接受 `ALLOWED_ORIGINS` 里的网站发来的浏览器请求，其他来源的写请求返回 403。
- 每个 IP 每分钟的评论、点赞、浏览次数都有上限（可配置），计数时 IP 只存哈希。
- 评论先经 Workers AI 语义审核（可选），再过敏感词表；访客昵称不能包含站长昵称。
- 计数全部用原子 UPSERT，并发时不会少记。
- 公开接口不返回 IP；出错时只返回通用错误信息，详细原因写在 Worker 日志里。
- 带 `X-Admin-Token` 请求头（等于密钥 `ADMIN_TOKEN`）发表的评论标为站长，免审核和限流。

## 部署

需要 Node.js 18+ 和 `npx wrangler`（第一次会提示登录 Cloudflare）。以下命令都在仓库根目录执行。

### 1. 创建 D1 评论库

```bash
npx wrangler d1 create example-comment
```

记下输出里的 `database_id`。库名要和 FlarePanel `sites.config.js` 里的 `commentDb` 一致。已经有评论库的话直接用。

### 2. 写配置

```bash
cp worker/wrangler.example.jsonc worker/wrangler.jsonc
```

打开 `worker/wrangler.jsonc`：

- `name` 改成你的 Worker 名；
- `d1_databases` 里填第 1 步的库名和 `database_id`；
- `vars` 里至少改 `ALLOWED_ORIGINS`、`SITE_NAME`、`SITE_URL`；
- 需要文件下载、敏感词 KV、Workers AI 时，取消对应段落的注释并填好。

### 3. 建表

```bash
npx wrangler d1 execute example-comment --remote --file=worker/schema.sql --config worker/wrangler.jsonc
```

已有同名表会跳过，不影响旧数据。

### 4. 设置密钥（都可选）

```bash
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.jsonc
```

不设置 Telegram 密钥时，如果绑定了 `PANEL_CONFIG_KV`（FlarePanel AI Hub 用的 KV），Worker 会读取后台「代理网关」里保存的 Telegram 配置。两者都没有就不推送。

### 5. 部署

```bash
npx wrangler deploy --config worker/wrangler.jsonc
```

部署后会得到 `https://<name>.<你的子域>.workers.dev`，也可以在 `routes` 里绑定自己的域名。

### 6. 接入 FlarePanel

FlarePanel 直接读写 D1，不调用这个 Worker，所以只要 `sites.config.js` 里的库名对得上：

| `sites.config.js` | 对应 |
|---|---|
| `commentDb` | `d1_databases` 里的 `database_name` |
| `bucket` | `r2_buckets` 里的 `bucket_name`（用文件下载时） |
| `filesDomain` | `https://` + `vars.FILES_HOSTNAME` |
| `PANEL.adminName` | 建议和 `vars.ADMIN_NAME` 相同 |

在后台回复的评论 `is_author = 1`，网站上会显示为站长；在后台删除的评论网站上立即消失。

## 配置项

`vars`（写在 `wrangler.jsonc`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空 | 允许的网站，逗号分隔，如 `https://example.com,https://www.example.com` |
| `ALLOW_LOCALHOST` | `false` | 允许 `http://localhost`、`http://127.0.0.1`，本地调试用 |
| `SITE_NAME` | 空 | 站名，出现在 Telegram 通知和文件目录页 |
| `SITE_URL` | 空 | 站点网址，用于通知里的页面链接 |
| `ADMIN_NAME` | 空 | 站长昵称，访客昵称不能包含它 |
| `RESERVED_NICKS` | 空 | 其他保留昵称，逗号分隔 |
| `COMMENT_RATE_PER_MIN` | `5` | 每个 IP 每分钟评论 + 回复上限，0 不限 |
| `LIKE_RATE_PER_MIN` | `30` | 每个 IP 每分钟点赞 + 投票上限 |
| `VIEW_RATE_PER_MIN` | `120` | 每个 IP 每分钟计入浏览量的次数，超过的不计数 |
| `MAX_NICK_LENGTH` / `MAX_COMMENT_LENGTH` / `MAX_REPLY_LENGTH` | `20` / `500` / `300` | 长度上限（按字符） |
| `MAX_PAGE_SIZE` | `50` | 评论列表每页最多条数 |
| `SENSITIVE_WORDS` | 空 | 敏感词，逗号分隔；空 = 用 `SENSITIVE_WORDS_KV` 或内置的极简垃圾广告词表；`none` = 关闭 |
| `SENSITIVE_WORDS_KEY` | `WORDS_LIST` | `SENSITIVE_WORDS_KV` 里的键名 |
| `AI_MODERATION` | `true` | 绑定了 `AI` 时是否用 Workers AI 审核 |
| `AI_MODERATION_MODEL` | `@cf/zai-org/glm-4.7-flash` | 审核用的 Workers AI 模型 |
| `PANEL_CONFIG_KEY` | `AI_GATEWAY_CONFIG` | `PANEL_CONFIG_KV` 里的键名，和 `sites.config.js` 的 `AI_HUB.configKey` 一致 |
| `NOTIFY_TIMEZONE` | `UTC` | 通知里时间的时区 |
| `NOTIFY_SKIP_PATHS` | 空 | 这些页面的评论不推送，逗号分隔，如 `/chat` |
| `ONLINE_WINDOW_SECONDS` | `60` | 多少秒内有心跳算在线 |
| `FILES_HOSTNAME` | 空 | 文件域名，如 `files.example.com`；请求这个域名时走 R2 文件分发 |
| `FILES_LISTING` | `false` | 是否显示目录页（只列二级及更深的目录，根目录和一级目录永远不列） |
| `FILES_PRIVATE_PREFIXES` | 空 | 只能直接取文件、不能列目录的前缀，如 `posts/,wiki/` |
| `FILES_NOT_FOUND_URL` | 空 | 文件不存在时跳转的网址，空则返回 404 |
| `FILES_CONTACT` | 空 | 目录页底部的版权联系方式 |
| `FILES_CACHE_CONTROL` | `public, max-age=86400` | 文件的 Cache-Control |

密钥（`wrangler secret put`）：`ADMIN_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`，都可选。

绑定：`DB`（D1，必需）、`FILES_BUCKET`（R2）、`SENSITIVE_WORDS_KV`、`PANEL_CONFIG_KV`（KV）、`AI`（Workers AI），后四个可选。

## 接口

所有接口返回 JSON。成功时 `success: true`；失败时 `success: false`，带 `code`（固定英文代码）和 `error`（按 `Accept-Language` 返回中文或英文）。`url` 参数可以传完整网址或路径，Worker 会统一成 `/posts/hello` 这种形式（去掉域名、查询参数、`.html`、`index.html` 和结尾斜杠）。

| 方法和路径 | 请求 | 返回 |
|---|---|---|
| `GET /api/comment?url=&page=1&limit=20&sort=&keyword=` | `sort=time` 按时间倒序，默认按点赞数；`keyword` 搜昵称和内容 | `{ data: [{ id, nick, comment, url, parent_id, likes, is_author, created_at }], total, page, limit }` |
| `POST /api/comment` | `{ nick, comment, url }` | `{ id }` |
| `POST /api/comment/reply` | `{ nick, comment, url, parentId }`，回复会挂到父评论所在页面 | `{ id }` |
| `POST /api/comment/like` | `{ commentId }` | `{ likes }` |
| `GET /api/article/like?url=` | | `{ likes, url }` |
| `POST /api/article/like` | `{ url }` | `{ likes, url }` |
| `GET /api/article/view?url=` | | `{ views, url }` |
| `POST /api/article/view` | `{ url }` | `{ counted, views, url }`，超过频率限制时 `counted: false` |
| `GET /api/item/votes?prefix=` | `prefix` 可选，按条目 id 前缀筛选，如 `tool:` | `{ data: [{ item_id, item_name, likes }] }` |
| `POST /api/item/upvote` / `POST /api/item/downvote` | `{ itemId, itemName? }` | `{ likes }` |
| `POST /api/online/heartbeat` | `{ clientId?, room? }`，`room` 默认 `site` | `{ onlineCount }` |
| `GET /api/online?room=` | | `{ onlineCount }` |

常见错误码：`missing_fields`、`bad_json`、`nick_too_long`、`comment_too_long`、`reserved_nick`、`rejected`（审核未通过）、`rate_limited`（429）、`not_found`（404）、`forbidden_origin`（403）、`server_error`（500）。

`created_at` 是 UTC 时间（D1 的 `CURRENT_TIMESTAMP`），显示前请自己转换时区。

## 在静态网站里嵌入评论

最简单的写法，放在文章页面底部。`API` 换成你的 Worker 地址，并把网站域名加进 `ALLOWED_ORIGINS`。

```html
<section id="comments">
  <form id="comment-form">
    <input name="nick" placeholder="昵称" maxlength="20" required>
    <textarea name="comment" placeholder="说点什么" maxlength="500" required></textarea>
    <button type="submit">发表</button>
  </form>
  <ul id="comment-list"></ul>
</section>

<script>
  const API = 'https://my-comment-worker.example.workers.dev';
  const pageUrl = location.pathname;
  const list = document.getElementById('comment-list');
  const form = document.getElementById('comment-form');

  async function loadComments() {
    const res = await fetch(`${API}/api/comment?url=${encodeURIComponent(pageUrl)}&sort=time`);
    const { data = [] } = await res.json();
    list.replaceChildren(...data.map((c) => {
      const li = document.createElement('li');
      // 用 textContent 显示，避免评论里的 HTML 被执行
      li.textContent = `${c.nick}${c.is_author ? '（站长）' : ''}：${c.comment}`;
      return li;
    }));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { nick: form.nick.value, comment: form.comment.value, url: pageUrl };
    const res = await fetch(`${API}/api/comment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();
    if (!result.success) return alert(result.error);
    form.comment.value = '';
    loadComments();
  });

  // 记一次浏览量
  fetch(`${API}/api/article/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: pageUrl })
  });

  loadComments();
</script>
```

回复把 `parentId` 一起发到 `/api/comment/reply`；按 `parent_id` 把回复挂到对应评论下面即可显示成楼中楼。

## 本地调试

```bash
npx wrangler d1 execute example-comment --local --file=worker/schema.sql --config worker/wrangler.jsonc
npx wrangler dev --config worker/wrangler.jsonc
```

本地调试时把 `ALLOW_LOCALHOST` 设为 `true`。

## 不包含的部分

- 会员注册登录在 [`account/`](../account/README.md)，AI 网关在 [`gateway/`](../gateway/README.md)；游戏排行榜、聊天室、咨询表单等站点专属功能没有放进来。

## 许可证

[MIT](../LICENSE) © 2026 程小宝

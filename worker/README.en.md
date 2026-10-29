# FlarePanel Comment Worker

[简体中文](README.md) | **English**

The companion backend for FlarePanel: a Cloudflare Worker that gives a static site comments, replies, likes and page views. Data goes into D1 and is managed in FlarePanel. Optionally it serves files from R2 (with download counts) and sends new comments to Telegram.

One file, `index.js`, no build step and no npm dependencies. Everything site-specific (domains, site name, Telegram) lives in the wrangler config and secrets.

## Features

| Feature | Endpoints | Table | FlarePanel section |
|---|---|---|---|
| Comments and replies | `GET/POST /api/comment`, `POST /api/comment/reply` | `comments` | Comments |
| Comment likes | `POST /api/comment/like` | `comments.likes` | Comments |
| Page views | `GET/POST /api/article/view` | `article_views` | Page views |
| File download counts | `GET /<file path>` on the files hostname | `file_downloads` | Files |
| Article likes | `GET/POST /api/article/like` | `article_likes` | none (site only) |
| Generic votes (up / down) | `GET /api/item/votes`, `POST /api/item/upvote`, `POST /api/item/downvote` | `item_likes` | none |
| Online count | `POST /api/online/heartbeat`, `GET /api/online` | `site_online` | none |

Safety and abuse protection:

- Browser requests are accepted only from sites in `ALLOWED_ORIGINS`; write requests from other origins get 403.
- Comments, likes and views are rate limited per IP per minute (configurable). Only a hash of the IP is stored for counting.
- Comments go through Workers AI moderation (optional), then a word list. Visitor nicknames may not contain the admin name.
- All counters use atomic UPSERTs, so nothing is lost under concurrency.
- Public endpoints never return IPs. Errors return a generic message; details go to the Worker log.
- Comments sent with an `X-Admin-Token` header equal to the `ADMIN_TOKEN` secret are marked as the author's and skip moderation and rate limits.

## Deploy

You need Node.js 18+ and `npx wrangler` (it asks you to log in to Cloudflare the first time). Run everything from the repository root.

### 1. Create the D1 comment database

```bash
npx wrangler d1 create example-comment
```

Note the `database_id`. The name must match `commentDb` in FlarePanel's `sites.config.js`. If you already have a comment database, use it.

### 2. Write the config

```bash
cp worker/wrangler.example.jsonc worker/wrangler.jsonc
```

In `worker/wrangler.jsonc`:

- set `name` to your Worker name;
- fill the database name and `database_id` from step 1 in `d1_databases`;
- change at least `ALLOWED_ORIGINS`, `SITE_NAME` and `SITE_URL` in `vars`;
- uncomment and fill the R2, KV or Workers AI blocks if you want file serving, a KV word list or AI moderation.

### 3. Create the tables

```bash
npx wrangler d1 execute example-comment --remote --file=worker/schema.sql --config worker/wrangler.jsonc
```

Existing tables are skipped; old data is untouched.

### 4. Set secrets (all optional)

```bash
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put TELEGRAM_CHAT_ID --config worker/wrangler.jsonc
```

Without the Telegram secrets, if `PANEL_CONFIG_KV` (the KV namespace FlarePanel's AI Hub uses) is bound, the Worker reads the Telegram settings saved in the panel's AI Gateway section. With neither, nothing is sent.

### 5. Deploy

```bash
npx wrangler deploy --config worker/wrangler.jsonc
```

You get `https://<name>.<your-subdomain>.workers.dev`; you can also add your own domain under `routes`.

### 6. Connect to FlarePanel

FlarePanel reads and writes D1 directly and never calls this Worker, so the names in `sites.config.js` just need to match:

| `sites.config.js` | Matches |
|---|---|
| `commentDb` | `database_name` in `d1_databases` |
| `bucket` | `bucket_name` in `r2_buckets` (if you serve files) |
| `filesDomain` | `https://` + `vars.FILES_HOSTNAME` |
| `PANEL.adminName` | best kept equal to `vars.ADMIN_NAME` |

Replies written in the panel have `is_author = 1` and show as the author's on the site; comments deleted in the panel disappear from the site immediately.

## Configuration

`vars` (in `wrangler.jsonc`):

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | empty | Allowed sites, comma separated, e.g. `https://example.com,https://www.example.com` |
| `ALLOW_LOCALHOST` | `false` | Also allow `http://localhost` and `http://127.0.0.1`, for local testing |
| `SITE_NAME` | empty | Site name, shown in Telegram messages and file listings |
| `SITE_URL` | empty | Site URL, used for page links in notifications |
| `ADMIN_NAME` | empty | Admin nickname; visitor nicknames may not contain it |
| `RESERVED_NICKS` | empty | More reserved nicknames, comma separated |
| `COMMENT_RATE_PER_MIN` | `5` | Comments + replies per IP per minute, 0 = unlimited |
| `LIKE_RATE_PER_MIN` | `30` | Likes + votes per IP per minute |
| `VIEW_RATE_PER_MIN` | `120` | Counted page views per IP per minute; extra ones are not counted |
| `MAX_NICK_LENGTH` / `MAX_COMMENT_LENGTH` / `MAX_REPLY_LENGTH` | `20` / `500` / `300` | Length limits in characters |
| `MAX_PAGE_SIZE` | `50` | Maximum comments per page |
| `SENSITIVE_WORDS` | empty | Word list, comma separated; empty = use `SENSITIVE_WORDS_KV` or the small built-in spam list; `none` = off |
| `SENSITIVE_WORDS_KEY` | `WORDS_LIST` | Key in `SENSITIVE_WORDS_KV` |
| `AI_MODERATION` | `true` | Use Workers AI moderation when the `AI` binding exists |
| `AI_MODERATION_MODEL` | `@cf/zai-org/glm-4.7-flash` | Workers AI model used for moderation |
| `PANEL_CONFIG_KEY` | `AI_GATEWAY_CONFIG` | Key in `PANEL_CONFIG_KV`, same as `AI_HUB.configKey` in `sites.config.js` |
| `NOTIFY_TIMEZONE` | `UTC` | Time zone for times in notifications |
| `NOTIFY_SKIP_PATHS` | empty | Pages whose comments are not sent to Telegram, e.g. `/chat` |
| `ONLINE_WINDOW_SECONDS` | `60` | A client counts as online if it sent a heartbeat within this many seconds |
| `FILES_HOSTNAME` | empty | Files hostname, e.g. `files.example.com`; requests to it are served from R2 |
| `FILES_LISTING` | `false` | Show directory pages (only second level and deeper; the root and first-level folders are never listed) |
| `FILES_PRIVATE_PREFIXES` | empty | Prefixes whose files can be fetched but never listed, e.g. `posts/,wiki/` |
| `FILES_NOT_FOUND_URL` | empty | Redirect target for missing files; empty = plain 404 |
| `FILES_CONTACT` | empty | Copyright contact shown at the bottom of directory pages |
| `FILES_CACHE_CONTROL` | `public, max-age=86400` | Cache-Control for files |

Secrets (`wrangler secret put`): `ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, all optional.

Bindings: `DB` (D1, required), `FILES_BUCKET` (R2), `SENSITIVE_WORDS_KV` and `PANEL_CONFIG_KV` (KV), `AI` (Workers AI); the last four are optional.

## API

Every endpoint returns JSON. On success `success: true`; on failure `success: false` with a `code` (fixed English code) and `error` (Chinese or English per `Accept-Language`). The `url` parameter can be a full URL or a path; the Worker normalizes it to `/posts/hello` (no domain, query, `.html`, `index.html` or trailing slash).

| Method and path | Request | Response |
|---|---|---|
| `GET /api/comment?url=&page=1&limit=20&sort=&keyword=` | `sort=time` for newest first, default is by likes; `keyword` searches nickname and content | `{ data: [{ id, nick, comment, url, parent_id, likes, is_author, created_at }], total, page, limit }` |
| `POST /api/comment` | `{ nick, comment, url }` | `{ id }` |
| `POST /api/comment/reply` | `{ nick, comment, url, parentId }`; the reply is stored on the parent's page | `{ id }` |
| `POST /api/comment/like` | `{ commentId }` | `{ likes }` |
| `GET /api/article/like?url=` | | `{ likes, url }` |
| `POST /api/article/like` | `{ url }` | `{ likes, url }` |
| `GET /api/article/view?url=` | | `{ views, url }` |
| `POST /api/article/view` | `{ url }` | `{ counted, views, url }`; `counted: false` when rate limited |
| `GET /api/item/votes?prefix=` | optional `prefix` filters by item id, e.g. `tool:` | `{ data: [{ item_id, item_name, likes }] }` |
| `POST /api/item/upvote` / `POST /api/item/downvote` | `{ itemId, itemName? }` | `{ likes }` |
| `POST /api/online/heartbeat` | `{ clientId?, room? }`, `room` defaults to `site` | `{ onlineCount }` |
| `GET /api/online?room=` | | `{ onlineCount }` |

Common error codes: `missing_fields`, `bad_json`, `nick_too_long`, `comment_too_long`, `reserved_nick`, `rejected` (moderation), `rate_limited` (429), `not_found` (404), `forbidden_origin` (403), `server_error` (500).

`created_at` is UTC (D1 `CURRENT_TIMESTAMP`); convert it before display.

## Embed comments on a static site

A minimal version for the bottom of an article page. Replace `API` with your Worker URL and add your site to `ALLOWED_ORIGINS`.

```html
<section id="comments">
  <form id="comment-form">
    <input name="nick" placeholder="Name" maxlength="20" required>
    <textarea name="comment" placeholder="Say something" maxlength="500" required></textarea>
    <button type="submit">Post</button>
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
      // textContent, so HTML inside a comment is never executed
      li.textContent = `${c.nick}${c.is_author ? ' (author)' : ''}: ${c.comment}`;
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

  // count one page view
  fetch(`${API}/api/article/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: pageUrl })
  });

  loadComments();
</script>
```

For replies, send `parentId` to `/api/comment/reply` and nest replies under their comment by `parent_id`.

## Local testing

```bash
npx wrangler d1 execute example-comment --local --file=worker/schema.sql --config worker/wrangler.jsonc
npx wrangler dev --config worker/wrangler.jsonc
```

Set `ALLOW_LOCALHOST` to `true` while testing locally.

## Not included

- Member sign-up and login live in [`account/`](../account/README.en.md) and the AI gateway in [`gateway/`](../gateway/README.en.md); site-specific features such as game leaderboards, chat rooms and contact forms are not included.

## License

[MIT](../LICENSE) © 2026 程小宝

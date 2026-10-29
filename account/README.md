# FlarePanel 账号 Worker

**简体中文** | [English](README.en.md)

FlarePanel 的配套后端之一：一个 Cloudflare Worker，给静态网站提供会员注册、登录、改密码、改用户名、恢复码找回密码和注销账号。账号写进 D1 的 `users` 表，FlarePanel「账号管理」可以搜索、排序、删除和导出。

单文件 `index.js`，不需要构建，也没有 npm 依赖。站点相关的东西（允许的域名、用户名规则、限流等）全部写在 wrangler 配置和密钥里。

## 功能

| 功能 | 接口 | 需要登录 |
|---|---|---|
| 注册（返回一次性恢复码） | `POST /api/auth/register` | 否 |
| 登录（返回 JWT，更新 `last_login_at`） | `POST /api/auth/login` | 否 |
| 获取当前用户 | `GET /api/auth/me` | 是 |
| 改密码（其他设备上的登录全部失效） | `POST /api/auth/update_password` | 是 |
| 改用户名 | `POST /api/auth/update_username` | 是 |
| 生成新恢复码（旧的作废） | `POST /api/auth/recovery_code` | 是 |
| 忘记密码：凭恢复码重置 | `POST /api/auth/reset_password` | 否 |
| 注销账号 | `POST` 或 `DELETE /api/auth/delete_account` | 是 |

需要登录的接口带请求头 `Authorization: Bearer <token>`。

安全和防刷：

- 密码用 PBKDF2-SHA256 加随机盐哈希，格式 `pbkdf2$迭代数$哈希`。迭代数写在哈希里，调高 `PBKDF2_ITERATIONS` 后老账号照常登录，并在下次登录时自动按新迭代数重算。
- 没有设置 `JWT_SECRET`（或短于 32 个字符）时所有接口返回「服务端未配置」，不会用空密钥签发凭证。
- 登录凭证是 HS256 JWT，签名用常量时间比较，只接受 `alg: HS256`。改密码、凭恢复码重置密码时凭证版本 +1，之前签发的凭证全部失效；注销账号后凭证也立即失效。
- 登录失败时，用户不存在和密码错误返回同样的错误，用户不存在时也照样算一次哈希，响应时间差不多。恢复码重置同理。
- 登录、改密、生成恢复码、注销这些要校验密码的操作，每个 IP 每分钟有上限；注册、恢复码重置每个 IP 每 24 小时有上限（都可配置）。计数时 IP 只存哈希。限流表出错时拒绝请求，不放开暴力破解。
- 只接受 `ALLOWED_ORIGINS` 里的网站发来的浏览器请求，其他来源一律 403，预检也不放行。凭证放在请求头里而不是 Cookie，别的网站无法借用访客的登录状态。
- 用户名不能有 `< > " ' &` 和零宽、方向控制等不可见字符；注册和改名时英文字母不分大小写查重，`Admin` 和 `admin` 不能同时存在；可以配置长度、正则和保留词。
- 恢复码 16 位（去掉易混的 0 O 1 I L），库里只存哈希，用过一次就换新。
- 响应不返回 `password_hash`、`salt` 等字段；出错时只返回通用错误信息，详细原因写在 Worker 日志里。所有响应带 `Cache-Control: no-store`。

## 部署

需要 Node.js 18+ 和 `npx wrangler`（第一次会提示登录 Cloudflare）。以下命令都在仓库根目录执行。

### 1. 创建 D1 账号库

```bash
npx wrangler d1 create example-account
```

记下输出里的 `database_id`。库名要和 FlarePanel `sites.config.js` 里的 `accountDb` 一致。已经有账号库的话直接用（见下面「已有 users 表」）。

### 2. 写配置

```bash
cp account/wrangler.example.jsonc account/wrangler.jsonc
```

打开 `account/wrangler.jsonc`：

- `name` 改成你的 Worker 名；
- `d1_databases` 里填第 1 步的库名和 `database_id`；
- `vars` 里至少改 `ALLOWED_ORIGINS`，按需要调整用户名规则和限流。

`account/wrangler.jsonc` 里有你的数据库 ID，公开仓库里不要提交它。

### 3. 建表

```bash
npx wrangler d1 execute example-account --remote --file=account/schema.sql --config account/wrangler.jsonc
```

已有同名表会跳过，不影响旧数据。

**已有 users 表**：如果账号库是用 v1.0.0 时的根目录 `schema.sql` 建的（现在的根目录 `schema.sql` 已包含这三列），`users` 表会被跳过，需要另外补三列（每条只执行一次）：

```bash
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN salt TEXT NOT NULL DEFAULT ''"
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN recovery_code_hash TEXT"
```

已有账号的密码哈希必须是 `pbkdf2$迭代数$哈希` 格式、盐在 `salt` 列，才能用这个 Worker 登录；其他格式的账号需要自己迁移或让用户重新注册。

### 4. 设置 JWT 密钥（必需）

```bash
openssl rand -base64 48   # 生成一串随机密钥
npx wrangler secret put JWT_SECRET --config account/wrangler.jsonc
```

至少 32 个字符。换掉它会让所有已签发的登录凭证失效（所有人需要重新登录）。

### 5. 部署

```bash
npx wrangler deploy --config account/wrangler.jsonc
```

部署后会得到 `https://<name>.<你的子域>.workers.dev`，也可以在 `routes` 里绑定自己的域名。

### 6. 接入 FlarePanel

FlarePanel 直接读写 D1，不调用这个 Worker，所以只要 `sites.config.js` 里的 `accountDb` 和 `d1_databases` 里的 `database_name` 一致，注册的账号就会出现在「账号管理」里。在后台删除的账号，凭证立即失效。

## 配置项

`vars`（写在 `wrangler.jsonc`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALLOWED_ORIGINS` | 空 | 允许的网站，逗号分隔，如 `https://example.com,https://www.example.com` |
| `ALLOW_LOCALHOST` | `false` | 允许 `http://localhost`、`http://127.0.0.1`，本地调试用 |
| `USERNAME_MIN_LENGTH` / `USERNAME_MAX_LENGTH` | `2` / `20` | 用户名长度（按字符） |
| `USERNAME_PATTERN` | 空 | 用户名必须匹配的正则，如 `^[A-Za-z0-9_]+$`；空 = 不限制字符集（不可见字符和 `< > " ' &` 始终不允许） |
| `RESERVED_USERNAMES` | 空 | 保留词，逗号分隔；用户名包含其中任意一个就不能注册或改名（不分大小写、全角当半角、忽略空格） |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` | `8` / `128` | 密码长度 |
| `PBKDF2_ITERATIONS` | `20000` | PBKDF2 迭代数，范围 1000 ~ 100000（Workers 的上限）。免费版每次请求 CPU 时间很紧，付费版可以调高 |
| `TOKEN_TTL_DAYS` | `30` | 登录凭证有效天数 |
| `LOGIN_RATE_PER_MIN` | `10` | 每个 IP 每分钟校验密码的次数（登录、改密、生成恢复码、注销合计），0 不限 |
| `REGISTER_RATE_PER_DAY` | `20` | 每个 IP 每 24 小时注册上限。学校机房等共用出口 IP 时可以调高 |
| `RESET_RATE_PER_DAY` | `10` | 每个 IP 每 24 小时恢复码重置的尝试次数 |

密钥（`wrangler secret put`）：`JWT_SECRET`，必需，至少 32 个字符。

绑定：`DB`（D1 账号库，必需）。

## 接口

所有接口收发 JSON。成功时 `success: true`；失败时 `success: false`，带 `code`（固定英文代码）和 `error`（按 `Accept-Language` 返回中文或英文）。`user` 对象是 `{ id, username, created_at, last_login_at }`，时间是 UTC（D1 的 `CURRENT_TIMESTAMP`）。

| 方法和路径 | 请求 | 返回 |
|---|---|---|
| `POST /api/auth/register` | `{ username, password, confirmPassword? }` | 201，`{ user: { id, username }, recoveryCode }` |
| `POST /api/auth/login` | `{ username, password }` | `{ token, user }` |
| `GET /api/auth/me` | | `{ user }` |
| `POST /api/auth/update_password` | `{ oldPassword, newPassword, confirmNewPassword? }` | `{ token, user }`，用新 token 替换旧的 |
| `POST /api/auth/update_username` | `{ newUsername }` | `{ token, user }`，用新 token 替换旧的 |
| `POST /api/auth/recovery_code` | `{ password }` | `{ recoveryCode }` |
| `POST /api/auth/reset_password` | `{ username, recoveryCode, newPassword, confirmNewPassword? }` | `{ recoveryCode }`（新的恢复码），之后用新密码登录 |
| `POST` / `DELETE /api/auth/delete_account` | `{ password }` | `{}` |

`confirmPassword`、`confirmNewPassword` 可选，传了就必须和新密码一致。恢复码不分大小写，横线和空格可有可无。

常见错误码：`missing_fields`、`bad_json`、`invalid_username`、`reserved_username`、`username_taken`（409）、`same_username`、`weak_password`、`password_mismatch`、`invalid_credentials`（401，登录失败）、`wrong_password`（403，已登录时密码不对）、`invalid_recovery`（401）、`unauthorized`（401，未登录或凭证失效）、`rate_limited`（429）、`forbidden_origin`（403）、`body_too_large`（413）、`not_configured`（500）、`server_error`（500）。

## 在静态网站里使用

最简单的写法。`API` 换成你的 Worker 地址，并把网站域名加进 `ALLOWED_ORIGINS`。

```html
<form id="login-form">
  <input name="username" placeholder="用户名" autocomplete="username" required>
  <input name="password" type="password" placeholder="密码" autocomplete="current-password" required>
  <button type="submit">登录</button>
</form>
<p id="who"></p>

<script>
  const API = 'https://my-account-worker.example.workers.dev';
  const form = document.getElementById('login-form');
  const who = document.getElementById('who');

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('token');
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) });
    const data = await res.json();
    if (data.code === 'unauthorized') localStorage.removeItem('token');
    return data;
  }

  async function showMe() {
    const data = await api('/api/auth/me');
    // 用 textContent 显示，避免用户名里的内容被当成 HTML
    who.textContent = data.success ? `已登录：${data.user.username}` : '未登录';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value }
    });
    if (!data.success) return alert(data.error);
    localStorage.setItem('token', data.token);
    form.password.value = '';
    showMe();
  });

  showMe();
</script>
```

注册成功后把 `recoveryCode` 明确展示给用户，提醒他抄下来：忘记密码时只能靠它找回，服务端只存哈希，看不到明文。改密码、改用户名后记得用返回的新 `token` 替换旧的。

## 本地调试

```bash
npx wrangler d1 execute example-account --local --file=account/schema.sql --config account/wrangler.jsonc
echo "JWT_SECRET=$(openssl rand -base64 48)" > account/.dev.vars
npx wrangler dev --config account/wrangler.jsonc
```

本地调试时把 `ALLOW_LOCALHOST` 设为 `true`。`wrangler dev` 会带上本机 IP，所以本地同样限流，反复测试时可以把限流调高或设为 `0`。`.dev.vars` 已在 `.gitignore` 里。

## 不包含的部分

- 会员等级、付费、兑换码等业务功能；成绩、排行榜等站点专属数据。需要的话在 `users` 表旁边自己加表，用 `GET /api/auth/me` 拿到的 `id` 关联。
- 邮箱或手机号验证、第三方登录、人机验证。忘记密码只能靠恢复码。
- 注销账号只删除 `users` 里的这一行；你自己加的其他表里的关联数据需要自己清理。

## 许可证

[MIT](../LICENSE) © 2026 程小宝

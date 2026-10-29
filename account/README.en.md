# FlarePanel Account Worker

[简体中文](README.md) | **English**

One of FlarePanel's companion backends: a Cloudflare Worker that gives a static site member sign-up, sign-in, password and username changes, password recovery with a recovery code, and account deletion. Accounts go into the D1 `users` table, which FlarePanel's Accounts section can search, sort, delete and export.

One file, `index.js`, no build step and no npm dependencies. Everything site-specific (allowed origins, username rules, rate limits) lives in the wrangler config and secrets.

## Features

| Feature | Endpoint | Sign-in required |
|---|---|---|
| Sign up (returns a one-time recovery code) | `POST /api/auth/register` | No |
| Sign in (returns a JWT, updates `last_login_at`) | `POST /api/auth/login` | No |
| Current user | `GET /api/auth/me` | Yes |
| Change password (signs out every other device) | `POST /api/auth/update_password` | Yes |
| Change username | `POST /api/auth/update_username` | Yes |
| New recovery code (the old one stops working) | `POST /api/auth/recovery_code` | Yes |
| Forgot password: reset with the recovery code | `POST /api/auth/reset_password` | No |
| Delete account | `POST` or `DELETE /api/auth/delete_account` | Yes |

Endpoints that need sign-in take an `Authorization: Bearer <token>` header.

Safety and abuse protection:

- Passwords are hashed with PBKDF2-SHA256 and a random salt, stored as `pbkdf2$iterations$hash`. The iteration count is part of the hash, so raising `PBKDF2_ITERATIONS` keeps old accounts working and re-hashes them with the new count on their next sign-in.
- Without a `JWT_SECRET` (or with one shorter than 32 characters) every endpoint answers "server is not configured"; tokens are never signed with an empty key.
- Tokens are HS256 JWTs. Signatures are compared in constant time and only `alg: HS256` is accepted. Changing the password or resetting it with a recovery code bumps the token version, so every token issued before stops working; deleting the account invalidates its tokens at once.
- A failed sign-in returns the same error whether the user does not exist or the password is wrong, and a hash is computed either way so the timing is similar. Recovery-code resets behave the same.
- Password checks (sign-in, password change, new recovery code, deletion) are limited per IP per minute; sign-ups and recovery-code resets per IP per 24 hours (all configurable). Only a hash of the IP is stored. If the rate-limit table fails, the request is refused rather than letting brute force through.
- Browser requests are accepted only from sites in `ALLOWED_ORIGINS`; any other origin gets 403, preflight included. Tokens travel in a header rather than a cookie, so other sites cannot ride on a visitor's session.
- Usernames may not contain `< > " ' &` or invisible characters such as zero-width and bidi controls. Sign-up and rename check for duplicates case-insensitively, so `Admin` and `admin` cannot both exist. Length, a pattern and reserved words are configurable.
- Recovery codes have 16 characters (without the look-alikes 0 O 1 I L). Only a hash is stored, and each code works once.
- Responses never include `password_hash` or `salt`. Errors return a generic message; details go to the Worker log. Every response carries `Cache-Control: no-store`.

## Deploy

You need Node.js 18+ and `npx wrangler` (it asks you to log in to Cloudflare the first time). Run everything from the repository root.

### 1. Create the D1 account database

```bash
npx wrangler d1 create example-account
```

Note the `database_id`. The name must match `accountDb` in FlarePanel's `sites.config.js`. If you already have an account database, use it (see "Existing users table" below).

### 2. Configure

```bash
cp account/wrangler.example.jsonc account/wrangler.jsonc
```

In `account/wrangler.jsonc`:

- set `name` to your Worker's name;
- fill in the database name and `database_id` from step 1 under `d1_databases`;
- under `vars`, set at least `ALLOWED_ORIGINS`, and adjust the username rules and rate limits if you like.

`account/wrangler.jsonc` holds your database ID; do not commit it to a public repository.

### 3. Create the tables

```bash
npx wrangler d1 execute example-account --remote --file=account/schema.sql --config account/wrangler.jsonc
```

Existing tables are skipped and old data is left alone.

**Existing users table**: if the account database was created with the root `schema.sql` from v1.0.0 (the current root `schema.sql` already has these columns), the `users` table is skipped and needs three more columns (run each once):

```bash
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN salt TEXT NOT NULL DEFAULT ''"
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute example-account --remote --config account/wrangler.jsonc --command "ALTER TABLE users ADD COLUMN recovery_code_hash TEXT"
```

Existing accounts can sign in through this Worker only if their hash is in the `pbkdf2$iterations$hash` format with the salt in the `salt` column; accounts in other formats need your own migration, or a fresh sign-up.

### 4. Set the JWT secret (required)

```bash
openssl rand -base64 48   # generate a random secret
npx wrangler secret put JWT_SECRET --config account/wrangler.jsonc
```

At least 32 characters. Changing it invalidates every token already issued (everyone signs in again).

### 5. Deploy

```bash
npx wrangler deploy --config account/wrangler.jsonc
```

You get `https://<name>.<your-subdomain>.workers.dev`, or bind your own domain under `routes`.

### 6. Connect FlarePanel

FlarePanel reads and writes D1 directly and never calls this Worker, so as long as `accountDb` in `sites.config.js` matches `database_name` under `d1_databases`, new accounts show up in the Accounts section. Deleting an account in the panel invalidates its tokens immediately.

## Configuration

`vars` (in `wrangler.jsonc`):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | empty | Allowed sites, comma-separated, e.g. `https://example.com,https://www.example.com` |
| `ALLOW_LOCALHOST` | `false` | Also allow `http://localhost` and `http://127.0.0.1`, for local testing |
| `USERNAME_MIN_LENGTH` / `USERNAME_MAX_LENGTH` | `2` / `20` | Username length in characters |
| `USERNAME_PATTERN` | empty | Regular expression usernames must match, e.g. `^[A-Za-z0-9_]+$`; empty = any characters (invisible characters and `< > " ' &` are always refused) |
| `RESERVED_USERNAMES` | empty | Reserved words, comma-separated; a username containing any of them cannot be registered or chosen (case-insensitive, full-width folded to half-width, spaces ignored) |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` | `8` / `128` | Password length |
| `PBKDF2_ITERATIONS` | `20000` | PBKDF2 iterations, 1000 to 100000 (the Workers limit). The free plan has a tight CPU budget per request; raise it on a paid plan |
| `TOKEN_TTL_DAYS` | `30` | Token lifetime in days |
| `LOGIN_RATE_PER_MIN` | `10` | Password checks per IP per minute (sign-in, password change, new recovery code and deletion together); 0 = unlimited |
| `REGISTER_RATE_PER_DAY` | `20` | Sign-ups per IP per 24 hours. Raise it when many users share one IP, such as a school lab |
| `RESET_RATE_PER_DAY` | `10` | Recovery-code reset attempts per IP per 24 hours |

Secret (`wrangler secret put`): `JWT_SECRET`, required, at least 32 characters.

Binding: `DB` (the D1 account database, required).

## API

Every endpoint takes and returns JSON. On success `success: true`; on failure `success: false` with `code` (a fixed English code) and `error` (Chinese or English by `Accept-Language`). A `user` object is `{ id, username, created_at, last_login_at }`, times in UTC (D1 `CURRENT_TIMESTAMP`).

| Method and path | Request | Response |
|---|---|---|
| `POST /api/auth/register` | `{ username, password, confirmPassword? }` | 201, `{ user: { id, username }, recoveryCode }` |
| `POST /api/auth/login` | `{ username, password }` | `{ token, user }` |
| `GET /api/auth/me` | | `{ user }` |
| `POST /api/auth/update_password` | `{ oldPassword, newPassword, confirmNewPassword? }` | `{ token, user }`; replace the old token with the new one |
| `POST /api/auth/update_username` | `{ newUsername }` | `{ token, user }`; replace the old token with the new one |
| `POST /api/auth/recovery_code` | `{ password }` | `{ recoveryCode }` |
| `POST /api/auth/reset_password` | `{ username, recoveryCode, newPassword, confirmNewPassword? }` | `{ recoveryCode }` (the new code); then sign in with the new password |
| `POST` / `DELETE /api/auth/delete_account` | `{ password }` | `{}` |

`confirmPassword` and `confirmNewPassword` are optional; when sent they must equal the new password. Recovery codes are case-insensitive, with or without dashes and spaces.

Common error codes: `missing_fields`, `bad_json`, `invalid_username`, `reserved_username`, `username_taken` (409), `same_username`, `weak_password`, `password_mismatch`, `invalid_credentials` (401, failed sign-in), `wrong_password` (403, wrong password while signed in), `invalid_recovery` (401), `unauthorized` (401, not signed in or token no longer valid), `rate_limited` (429), `forbidden_origin` (403), `body_too_large` (413), `not_configured` (500), `server_error` (500).

## Using it from a static site

The simplest version. Replace `API` with your Worker's address and add your site to `ALLOWED_ORIGINS`.

```html
<form id="login-form">
  <input name="username" placeholder="Username" autocomplete="username" required>
  <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
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
    // textContent, so nothing in a username is treated as HTML
    who.textContent = data.success ? `Signed in as ${data.user.username}` : 'Not signed in';
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

After sign-up, show the `recoveryCode` clearly and ask the user to write it down: it is the only way back in after a forgotten password, and the server stores only its hash. After a password or username change, replace the stored token with the new one returned.

## Local testing

```bash
npx wrangler d1 execute example-account --local --file=account/schema.sql --config account/wrangler.jsonc
echo "JWT_SECRET=$(openssl rand -base64 48)" > account/.dev.vars
npx wrangler dev --config account/wrangler.jsonc
```

Set `ALLOW_LOCALHOST` to `true` while testing locally. `wrangler dev` passes your local IP, so rate limits apply locally too; raise them or set them to `0` for repeated tests. `.dev.vars` is already in `.gitignore`.

## Not included

- Membership tiers, payments, redeem codes and similar business features; scores, leaderboards and other site-specific data. Add your own tables next to `users` and link them by the `id` from `GET /api/auth/me`.
- Email or phone verification, third-party sign-in, CAPTCHA. A forgotten password can be recovered only with the recovery code.
- Deleting an account removes only its row in `users`; clean up related rows in your own tables yourself.

## License

[MIT](../LICENSE) © 2026 程小宝

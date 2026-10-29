# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

发现安全问题时，请**不要**公开提 Issue。请到仓库的 **Security → Report a vulnerability** 私下提交，我会尽快回复并修复。

Please **do not** open a public issue for security problems. Use **Security → Report a vulnerability** on this repository to report it privately. I'll reply and fix it as soon as possible.

请尽量附上 / Please include:

- 受影响的文件或接口 / the affected file or endpoint
- 复现步骤 / steps to reproduce
- 可能的影响 / the possible impact

## 支持的版本 / Supported versions

只维护最新版本（`main` 分支和最新 Release）。
Only the latest version (`main` and the latest release) receives fixes.

## 部署建议 / Deployment notes

- 在 Pages 环境变量里设置 `CF_ACCOUNT_ID`（生产和预览都要），否则所有 `/api` 接口返回 500。
  Set `CF_ACCOUNT_ID` in Pages environment variables (Production and Preview), otherwise every `/api` endpoint returns 500.
- 登录用的 API Token 只给需要的权限（D1、R2、KV），不要用 Global API Key。
  Give the sign-in API token only the permissions it needs (D1, R2, KV). Never use the Global API Key.
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 用「密钥」类型保存。
  Store `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` as encrypted secrets.
- 建议给后台域名加 **Cloudflare Access**（邮箱验证）。页面本身可公开打开；Account ID、API Token 和（可选）R2 S3 密钥存在浏览器 `localStorage`，退出登录会一并清除。
  Put **Cloudflare Access** (email verification) in front of the panel domain. The page itself is publicly reachable; the Account ID, API token, and optional R2 S3 keys live in browser `localStorage` and are cleared on sign-out.
- 管理员 Token 校验通过后在同一 isolate 内存缓存约 **1 分钟**。吊销或轮换 Token 后，这段窗口内仍可能放行；重新部署会清空缓存。
  A successful admin-token check is cached in memory for about **1 minute** per isolate. After revoke/rotate, that window may still allow the old token; a redeploy clears the cache.
- `/api/fetch-models` 只接受 https 公网 DNS 主机名（禁止 IP / localhost / 内网主机名），且不跟随重定向。
  `/api/fetch-models` only accepts public https DNS hostnames (no IP literals, localhost, or private hostnames) and does not follow redirects.

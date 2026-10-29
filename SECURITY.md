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

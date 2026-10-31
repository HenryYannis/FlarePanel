# FlarePanel

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | [English](README.en.md)

一個後台管理你所有 Cloudflare 網站：評論、瀏覽量、會員帳號、R2 檔案，以及可選的 AI 閘道設定。

[![CI](https://github.com/HenryYannis/FlarePanel/actions/workflows/check.yml/badge.svg)](https://github.com/HenryYannis/FlarePanel/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![FlarePanel](docs/social-preview.png)

純 Cloudflare Pages 部署，不需要伺服器，不需要建置步驟。登入用你自己的 Cloudflare API Token，資料都在你自己的帳號裡。

![登入頁](docs/screenshots/login.png)

![代理閘道](docs/screenshots/gateway.png)

## 功能

| 欄目 | 讀寫的資源 | 功能 |
|---|---|---|
| 檔案分享 | R2 儲存桶 | 瀏覽目錄、上傳（大檔案分片）、新建資料夾、重新命名、移動、刪除、複製連結，顯示下載次數 |
| 評論管理 | D1 `comments` | 按頁面篩選、搜尋、以站長身份回覆、單條或批次刪除，可匯出 CSV |
| 瀏覽數量 | D1 `article_views` | 按分類篩選、按瀏覽量或更新時間排序、刪除、匯出 CSV |
| 帳號管理 | D1 `users` | 搜尋、排序、刪除會員，匯出 CSV |
| 代理閘道（可選） | KV | 管理 AI 閘道的服務商、模型、降級鏈和用量統計，需要配套閘道 Worker |

- 一個後台可以管多個站點，頂部切換。某類資源一個站點都沒設定時，那個欄目會自動隱藏。
- 儲存庫裡帶三個配套 Worker，都可以直接部署：網站這一側寫入評論和瀏覽量的評論 Worker 在 [`worker/`](worker/README.md)，會員註冊登入的帳號 Worker 在 [`account/`](account/README.md)，AI 閘道 Worker 在 [`gateway/`](gateway/README.md)。

### 介面語言和夜間模式

- 支援簡體中文、繁體中文和英文。頂部導覽列右側的語言選單切換，選擇儲存在瀏覽器裡，切換後頁面會重新整理。
- 沒手動選過時按瀏覽器語言：`zh-TW`、`zh-HK`、`zh-MO`、`zh-Hant` 用繁體，其他以 `zh` 開頭用簡體，其餘用英文。
- 夜間模式預設跟隨系統。語言選單旁的月亮 / 太陽按鈕可以手動切換；系統再次切換日夜時回到自動。
- 日期和數字按當前語言格式顯示。
- 站點名、後台標題等寫在 `sites.config.js` 裡的內容屬於你的資料，原樣顯示，不翻譯。
- 詞典在 `assets/js/i18n/zh.js`、`zh-Hant.js`、`en.js`，三個檔案的鍵一一對應，CI 會檢查（`scripts/check-i18n.mjs`）。繁體詞典由簡體用 OpenCC（s2twp）轉換後修正用詞。

## 部署

### 1. Fork 或下載本儲存庫

```bash
git clone https://github.com/HenryYannis/FlarePanel.git
cd FlarePanel
```

### 2. 改 `sites.config.js`

部署前只需要改這一個檔案，每個站點寫一項（各欄位見下面的「設定」）：

```js
export const SITES = [
    {
        name: '我的部落格',
        url: 'https://blog.example.com',
        commentDb: 'blog-comment',   // D1 資料庫名
        accountDb: '',               // 沒有會員系統就留空
        bucket: 'blog-assets',       // R2 儲存桶名
        filesDomain: 'https://files.example.com',
        aiSiteId: ''
    }
];
```

後台只列出這裡寫過的資料庫和儲存桶，帳號裡其他資源不會出現。

### 3. 建表

用 `schema.sql` 給評論庫建表（已有同名表會跳過）：

```bash
npx wrangler d1 execute blog-comment --remote --file=schema.sql
```

帳號庫只需要 `users` 表，可以單獨執行 `schema.sql` 的最後一段。

評論、瀏覽量和下載次數由網站這一側寫入，FlarePanel 負責管理。儲存庫裡的 [`worker/`](worker/README.md) 就是配套的評論 Worker（評論、回覆、按讚、瀏覽量、R2 下載次數），按它的說明部署即可；用 `worker/schema.sql` 建表會把 Worker 額外用到的幾張表一起建好。也可以用你自己的 Worker，只要按下面的「資料表」寫入。

### 4. 部署到 Cloudflare Pages

Cloudflare 控制台 → Workers 和 Pages → 建立 → Pages → 連線到 Git，選這個儲存庫：

- 框架預設：無
- 建置命令：留空
- 建置輸出目錄：`/`

或者命令列：

```bash
npx wrangler pages deploy . --project-name flarepanel
```

### 5. 設定環境變數

Pages 專案 → 設定 → 環境變數（見下面「設定」裡的 `.dev.vars.example`）。改完要重新部署一次才會生效。

### 6. 建議加一層存取保護

後台本身靠 API Token 登入，但頁面誰都能開啟。建議在 Cloudflare Zero Trust → Access 給後台域名加一條電子郵件驗證，只有你能進。

### 本地預覽

```bash
cp .dev.vars.example .dev.vars   # 填 CF_ACCOUNT_ID
npx wrangler pages dev .
```

## 設定

### `.dev.vars.example`：環境變數

本地預覽時複製為 `.dev.vars` 填寫；線上在 Pages 專案的「設定 → 環境變數」裡填同樣的變數。

| 變數 | 必填 | 說明 |
|---|---|---|
| `CF_ACCOUNT_ID` | 是 | 你的 Account ID（32 位）。伺服器端端點用它確認來訪者是本帳號管理員，`/api/cf` 和 `/api/s3` 也只轉發這個帳號的請求。不填的話所有端點都會回傳「伺服器端未設定」 |
| `R2_ACCESS_KEY_ID` | 否 | R2 S3 API 金鑰。不填時單個檔案最大約 95 MB；填了以後 50 MB 以上的檔案改用 S3 分片上傳（每片 10 MB），可以傳更大的檔案 |
| `R2_SECRET_ACCESS_KEY` | 否 | 同上 |

### `wrangler.jsonc`：Pages 專案

只有三項：專案名 `name`（預設 `flarepanel`）、建置輸出目錄 `pages_build_output_dir`（`.`，即儲存庫根目錄整個發布）和 `compatibility_date`。`wrangler pages dev` / `wrangler pages deploy` 會讀取它。根目錄會整個發布，所以 `functions/_middleware.js` 會攔截內部檔案（見「安全說明」）。

### `sites.config.js`：站點

有三部分。

**`PANEL`：後台整體**

| 欄位 | 說明 |
|---|---|
| `title` | 後台標題，顯示在瀏覽器標籤和頂部導覽列 |
| `adminName` | 在後台回覆評論時用的暱稱。可以寫成 `{ zh: '站長', en: 'Admin' }`，按介面語言選擇 |
| `viewTypes` | 瀏覽量統計的頁面分類，按網址前綴匹配，例如 `{ key: 'posts', label: { zh: '文章', en: 'Posts' }, prefixes: ['/posts/'] }`。`label` 可以是普通文字或多語言物件（可加 `'zh-Hant'`，沒寫時繁體介面用 `zh`）。沒匹配上的歸入「其他頁面」 |
| `viewExcludes` | 瀏覽量統計裡不顯示的頁面，網址裡含這些關鍵詞就跳過 |

**`SITES`：每個站點一項**（站點順序就是後台裡站點按鈕的順序）

| 欄位 | 說明 |
|---|---|
| `name` | 站點顯示名 |
| `url` | 站點網址，評論和瀏覽量裡的相對路徑會拼成這個網址的連結 |
| `commentDb` | 評論庫的 D1 資料庫名（不是 ID），存 `comments`、`article_views`、`file_downloads` |
| `accountDb` | 帳號庫的 D1 資料庫名，存 `users`，沒有會員系統就留空 |
| `bucket` | R2 儲存桶名，不用檔案管理就留空 |
| `filesDomain` | 儲存桶繫結的公開域名，用於複製檔案連結和快速讀取 |
| `aiSiteId` | AI 閘道日誌裡這個站點的 `site_id`，不用 AI Hub 就留空 |
| `viewTypes` | 可選，覆蓋 `PANEL.viewTypes` |

用不到的資源留空字串，對應欄目會自動隱藏這個站點。

**`AI_HUB`：AI 閘道（可選）**

| 欄位 | 說明 |
|---|---|
| `enabled` | 是否顯示「代理閘道」欄目 |
| `gatewayUrl` | 閘道地址，以 `/v1` 結尾 |
| `kvNamespaceId` | 閘道讀取設定的 KV 命名空間 ID |
| `configKey` | KV 裡的設定鍵名，預設 `AI_GATEWAY_CONFIG` |
| `logsDb` | 閘道綁定的 D1 日誌庫名（有 `ai_logs` 表）；後台沒有開發者金鑰時執行監控直接查它，留空自動尋找 |

## 使用

### 登入用的 API Token

我的個人資料 → API 令牌 → 建立令牌 → 自定義令牌，帳戶級權限：

| 權限 | 用途 |
|---|---|
| D1 → 編輯 | 評論、瀏覽量、帳號（登入時也用它驗證 Token） |
| Workers R2 儲存 → 編輯 | 檔案分享 |
| Workers KV 儲存 → 編輯 | 只有開啟 AI Hub 才需要 |

Account ID、API Token，以及（若設定了）R2 S3 金鑰，只儲存在你瀏覽器的 localStorage。請求經過本站 `/api/cf` 轉發到 `api.cloudflare.com`（瀏覽器不能直接跨域呼叫），轉發時不記錄、不儲存。登入時填的 Account ID 必須和環境變數 `CF_ACCOUNT_ID` 一致。在公用電腦上用完請點「登出」，登出會清掉 Token 和快取的 S3 金鑰。

### 資料表

`schema.sql` 裡有完整建表語句和欄位註解。後台只讀寫下面這些欄位，你的網站可以加更多欄位，後台不受影響。

| 表 | 所在庫 | 主要欄位 | 說明 |
|---|---|---|---|
| `comments` | 評論庫 | `id`、`nick`、`comment`、`url`、`parent_id`、`ip`、`likes`、`is_author`、`created_at` | 評論。`parent_id` 是回覆的評論 id；`is_author = 1` 表示站長在後台回覆的；`created_at` 存 UTC |
| `article_views` | 評論庫 | `id`、`url`（唯一）、`views`、`updated_at` | 每個頁面一行，網站每次造訪 +1 |
| `file_downloads` | 評論庫 | `file_path`（主鍵）、`downloads` | R2 檔案下載次數；後台重新命名、移動檔案時會同步路徑 |
| `users` | 帳號庫 | `id`、`username`（唯一）、`password_hash`、`created_at`、`last_login_at` | 會員帳號。後台不讀 `password_hash` |

配套評論 Worker 另外用到 `article_likes`、`item_likes`、`site_online`、`rate_limits` 四張表，後台不讀，建表語句在 `worker/schema.sql`。配套帳號 Worker 在 `users` 表上另外用到 `salt`、`token_version`、`recovery_code_hash` 三列（根目錄 `schema.sql` 已包含，後台不讀），並用到 `rate_limits` 表，建表語句在 `account/schema.sql`。

### AI Hub（可選）

AI Hub 管理一個 OpenAI 相容的 AI 閘道 Worker：服務商和模型存在 KV，閘道讀取後按降級鏈轉發請求。配套閘道在 [`gateway/`](gateway/README.md)，可以直接部署；不用就保持 `AI_HUB.enabled: false`，後台不顯示這個欄目。閘道主要端點：

| 端點 | 用途 |
|---|---|
| `GET /v1/models` | 當前可用模型 |
| `POST /v1/chat/completions` | 對話，支援流式 |
| `GET /v1/stats?days=7` | 用量統計，需要開發者金鑰（Master Key） |
| `POST /v1/reload` | 後台儲存設定後通知閘道重新整理，`Authorization: Bearer <Master Key>` |

閘道還提供圖片、語音轉發和健康檢查端點，見 [`gateway/README.md`](gateway/README.md)。後台域名要寫進閘道的 `ALLOWED_ORIGINS`，否則統計、測速和儲存後重新整理會被拒絕。

Telegram 告警的「傳送測試通知」走本站的 `/api/test-telegram`，需要已登入後台。

### 自動同步私有副本（可選）

如果你 fork 後在自己的私有儲存庫裡放個人設定，可以讓本儲存庫 main 一有新提交就通知它同步，不用等定時任務：

1. 建一個細粒度 Personal Access Token，只授權下游儲存庫，權限給 Contents、Workflows（讀寫）。
2. 在本儲存庫（或你的 fork）Settings → Secrets and variables → Actions 加兩個 Secrets：`DOWNSTREAM_REPO`（如 `yourname/my-panel`）、`DOWNSTREAM_TOKEN`。
3. 下游儲存庫的同步工作流加上觸發條件：

```yaml
on:
  repository_dispatch:
    types: [flarepanel-updated]
```

沒設定這兩個 Secrets 時 `.github/workflows/notify-downstream.yml` 會直接跳過。

## 安全說明

所有 `/api/*` 端點都要求呼叫者是 `CF_ACCOUNT_ID` 這個帳號的管理員：用呼叫者的 Cloudflare API Token 去列一次本帳號的 D1 資料庫或 R2 儲存桶，能列出來才放行。驗證通過的結果按 Token 的 SHA-256 在記憶體裡快取約 1 分鐘，避免每個請求都多問一次 Cloudflare。吊銷或輪換 Token 後，同一 isolate 內最多約 1 分鐘仍可能放行。

| 端點 | 保護措施 |
|---|---|
| `/api/cf/*` | 必須帶管理員 Token（`Authorization: Bearer`），並且只轉發 `accounts/<CF_ACCOUNT_ID>/...` 下的端點；別的帳號 ID 回傳 403，帳號以外的路徑（如 `user/...`）回傳 403，帶 `..` 跳出帳號目錄的路徑也會被拒絕 |
| `/api/s3/*` | 只轉發到 `<CF_ACCOUNT_ID>.r2.cloudflarestorage.com`，請求頭裡的帳號 ID 只用來核對，不一致回傳 403。`Authorization` 裡是 S3 簽名，所以登入 Token 放在單獨的 `x-cf-token` 頭裡校驗（需要 R2 權限），這個頭不會轉發給 R2。CORS 預檢已允許這個頭 |
| `/api/s3-credentials` | 管理員 Token（R2 權限）才能取到 S3 金鑰 |
| `/api/fetch-models` | 管理員 Token；只允許 https 公網 DNS 主機名稱（禁止 IP、localhost、內網主機名稱；不跟隨重定向） |
| `/api/test-telegram` | 管理員 Token。前端只透過這個端點發測試訊息，不從瀏覽器直連 Telegram；測試訊息內容是通用文字，不含站點名 |

其他：

- 端點的錯誤資訊按請求頭 `Accept-Language` 回傳中文或英文，並帶一個 `code` 欄位；後台前端會按介面語言傳送這個請求頭。
- 中介軟體會攔截 `.md`、`.sql`、點檔案、`wrangler.*`、`docs/`、`scripts/`、`lib/`、`worker/`、`account/`、`gateway/` 等，不會被當成靜態檔案下載。
- CI 在每個 PR 和每次推送到 main 時跑 gitleaks 金鑰掃描。

發現安全問題請私下提交 GitHub Security Advisory，不要公開發 Issue。

## 技術棧

原生 HTML / CSS / ES Modules，後端是 Cloudflare Pages Functions。沒有框架，沒有建置，改完重新整理就能看到。三個配套 Worker（`worker/`、`account/`、`gateway/`）都是單檔案 Cloudflare Worker，同樣沒有 npm 依賴。

CI（`.github/workflows/check.yml`）在每個 PR 和推送到 main 時執行：儲存庫衛生、Pages 設定格式、gitleaks、HTML 結構、全部 JS 語法、JSON / TOML / CSS 語法、站內連結和多語言詞典。

## 相關教程

FlarePanel 管理的評論、瀏覽量、R2 檔案和 AI 閘道，背後的搭法都寫在小宝科技站的「Cloudflare 建站」系列裡：

- [騰訊雲域名 + GitHub + Cloudflare Pages 實現全球流暢訪問](https://xbkjz.cn/posts/2026/02-10-cloudflare-pages-deployment/)
- [Cloudflare Pages 部署踩坑實錄：從 522 報錯到完美重定向](https://xbkjz.cn/posts/2026/02-10-cloudflare-pages-troubleshooting/)
- [用 Cloudflare 全家桶打造安全高效的網站基礎設施](https://xbkjz.cn/posts/2026/03-07-cloudflare-comment-system/)
- [零成本搭建評論系統：用 D1 + Workers 為靜態博客實現評論功能](https://xbkjz.cn/posts/2026/03-08-cloudflare-d1-comment-system/)
- [給評論區加裝「防彈衣」：Workers 敏感詞過濾與高性能緩存實戰](https://xbkjz.cn/posts/2026/03-10-cloudflare-workers-security-cache/)
- [免註冊一鍵部署靜態網頁：Cloudflare Drop 體驗](https://xbkjz.cn/posts/2026/07-09-cloudflare-drop/)
- [防刷指南：利用 Workers + KV 限制前端模型接口訪問次數](https://xbkjz.cn/posts/2026/07-09-cloudflare-workers-rate-limiting/)
- [用 Cloudflare R2 免費搭自己的文件分享網盤](https://xbkjz.cn/posts/2026/08-28-cloudflare-r2-file-sharing/)
- [用 Workers 零成本打造永不停機的統一 AI 大模型網關](https://xbkjz.cn/posts/2026/10-06-cloudflare-workers-ai-gateway/)
- [新手後台配置避坑全指南：從 SSL 到安全加速逐項拆解](https://xbkjz.cn/posts/2026/10-12-cloudflare-settings-guide/)
- [Cloudflare 核心配置與避坑速查表](https://xbkjz.cn/wiki/cloudflare-settings/)

## 相關專案

- [FlareRouter](https://github.com/HenryYannis/FlareRouter)：部署在單個 Cloudflare Worker 上的個人 AI 閘道，同時提供 OpenAI 相容和 Anthropic 格式的 API，多家服務商一個地址、失敗自動切換。

## 授權條款

[MIT](LICENSE) © 2026 程小宝

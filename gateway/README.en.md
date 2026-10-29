# FlarePanel AI Gateway Worker

[简体中文](README.md) | **English**

The companion backend for FlarePanel's "AI Gateway" section: an OpenAI-compatible Cloudflare Worker that puts several providers behind one endpoint. Providers, models, the failover chain and developer keys live in KV and are edited in the FlarePanel panel; the gateway reads them, forwards requests, moves on to the next model or provider when one fails, and records usage stats for the panel.

A single `index.js` with no build step and no npm dependencies. Domains, allowed sites and secrets all live in the wrangler config and Secrets; no site is hard-coded.

## Features

| Feature | Endpoint | Notes |
|---|---|---|
| Model list | `GET /v1/models` | Models of enabled providers, IDs look like `providerId/model` |
| Chat | `POST /v1/chat/completions` | Streaming (SSE) and non-streaming; automatic retries along the failover chain |
| Usage stats | `GET /v1/stats?days=7` | Developer key required; returns exactly the format the panel's monitoring page uses (1–30 days) |
| Reload config | `POST /v1/reload` | Developer key required; the panel calls it after saving |
| Images, audio | `POST /v1/images/generations`, `/v1/images/edits`, `/v1/audio/transcriptions` | Developer keys only; forwarded as-is to the provider that lists the model |
| Health check | `GET /`, `GET /v1` | Only status and version |
| Internal calls (optional) | Service Binding `GatewayRPC` | Other Workers in the same account call it without a key; not reachable from the internet |

Forwarding details:

- Common parameters are passed through (`temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `tools`, `tool_choice`, `response_format`, `stop`, `seed` and more); other fields are dropped.
- Streaming requests get `stream_options.include_usage`; when the upstream returns no usage, tokens are estimated from the text length.
- A provider whose `baseUrl` is `cloudflare-workers-ai` uses Workers AI when the `AI` binding is present (streamed output is converted to the OpenAI format).

## How it maps to FlarePanel

| FlarePanel `sites.config.js` | Gateway |
|---|---|
| `AI_HUB.gatewayUrl` | Gateway URL plus `/v1`, e.g. `https://ai.example.com/v1` |
| `AI_HUB.kvNamespaceId` | ID of the KV namespace bound as `CONFIG_KV` |
| `AI_HUB.configKey` | The gateway's `CONFIG_KEY` (both default to `AI_GATEWAY_CONFIG`) |
| Each site's `aiSiteId` | The site_id mapped to that site's hostname in `SITE_IDS` |
| Panel domain | Must be listed in the gateway's `ALLOWED_ORIGINS` |

The config the panel writes to KV (the gateway only reads these fields):

```jsonc
{
  "version": 1,
  "gateway": {
    "keys": [{ "id": "key_1", "name": "VS Code", "key": "sk-fp-...", "enabled": true }], // developer keys
    "masterKey": "sk-fp-..."                       // legacy single key, still accepted
  },
  "sitePolicy": {
    "fallbackChain": ["provider_a", "provider_b"], // failover order; other enabled providers follow as a last resort
    "unauthDailyLimit": 20,                        // daily calls per anonymous visitor (only with PUBLIC_ACCESS=true)
    "authDailyLimit": 100,                         // daily calls per signed-in user
    "moderationModel": "provider_a/some-model"     // used when model is "moderation"
  },
  "telegram": { "enabled": true, "botToken": "", "chatId": "" },
  "providers": [{
    "id": "provider_a", "name": "Provider A", "enabled": true,
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-...",                            // or "env:PROVIDER_KEY_A" to read the Secret of that name
    "models": "model-1, model-2",
    "pollModels": ["model-1", "model-2"],          // models tried in turn within this provider; defaults to defaultModel only
    "defaultModel": "model-1",
    "timeoutMs": 45000                             // optional
  }]
}
```

## Routing

The request's `model`:

| Value | Behaviour |
|---|---|
| empty, `auto`, `default` | Tries providers in `fallbackChain` order |
| `provider_a` | Only this provider, trying its selected models in turn |
| `provider_a/model-2` | Only this provider, `model-2` first, then its other selected models |
| `model-2` | Every provider that lists this model, in turn |
| `moderation` | Replaced by `sitePolicy.moderationModel`; failover chain if unset |

Within a provider, all selected models are tried before moving on. Timeouts, network errors and any non-2xx response move to the next one; when everything fails, the last status code is returned. Stats record the failover path (provider, model, short reason), never the upstream's raw text.

## Who can call it

| Caller | How it is recognised | Limits |
|---|---|---|
| Developer | `Authorization: Bearer <key>` (`x-api-key` also works); any key from the panel's developer keys, the legacy `masterKey`, or the `MASTER_KEY` Secret | Unlimited, all endpoints |
| Signed-in site user | With `PUBLIC_ACCESS=true` and `JWT_SECRET` set: an HS256 JWT sent from an allowed site (user ID in `sub`, `id` or `userId`) | `authDailyLimit` per day, models and chat only |
| Anonymous visitor | With `PUBLIC_ACCESS=true`: browser requests from a site in `ALLOWED_ORIGINS` | `unauthDailyLimit` per day (counted per IP hash), models and chat only |

`PUBLIC_ACCESS` defaults to `false`: every endpoint needs a developer key. Before turning public access on, keep in mind that scripts can forge the `Origin` header; the daily limit is anti-abuse, and KV counters are not strictly atomic.

## Deploy

You need Node.js 18+ and `npx wrangler`. Run the commands from the repository root.

### 1. Create the KV namespace (reuse it if FlarePanel already has one)

```bash
npx wrangler kv namespace create AI_GATEWAY
```

Put the `id` in `AI_HUB.kvNamespaceId` in `sites.config.js`.

### 2. Configure

```bash
cp gateway/wrangler.example.jsonc gateway/wrangler.jsonc
```

In `gateway/wrangler.jsonc`:

- set `name` to your Worker name;
- put the step 1 `id` in `kv_namespaces`;
- add at least your FlarePanel panel domain to `vars.ALLOWED_ORIGINS`;
- adjust `SITE_IDS`, `PUBLIC_ACCESS` and the rest as needed (see the table below).

`gateway/wrangler.jsonc` contains your resource IDs; keep it in a private copy rather than a public repository.

### 3. (Optional) Store call logs in D1

Without D1 the gateway still works: stats go to KV under `STATS:DAILY:<date>` and `STATS:RECENT_LOGS`. For heavier traffic, D1 is recommended because KV's free daily writes are limited.

```bash
npx wrangler d1 create example-ai-logs
# put the database_id in d1_databases in gateway/wrangler.jsonc, then create the table:
npx wrangler d1 execute example-ai-logs --remote --file=gateway/schema.sql --config gateway/wrangler.jsonc
```

### 4. Set secrets (all optional)

```bash
npx wrangler secret put MASTER_KEY --config gateway/wrangler.jsonc
```

### 5. Deploy

```bash
npx wrangler deploy --config gateway/wrangler.jsonc
```

Then in FlarePanel set `AI_HUB.enabled` to `true` and `gatewayUrl` to the gateway URL plus `/v1`, add providers and generate a developer key in the AI Gateway section. The panel calls `/v1/reload` whenever it saves.

## Variables (vars)

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | empty | Sites allowed to call from a browser, comma-separated, with scheme. Requests with an `Origin` not on the list get 403, preflights included |
| `ALLOW_LOCALHOST` | `false` | Allow `http://localhost` and `http://127.0.0.1` for local testing |
| `CONFIG_KEY` | `AI_GATEWAY_CONFIG` | Config key in KV |
| `CONFIG_CACHE_SECONDS` | `300` | How long config is cached in memory. `/v1/reload` refreshes only the instance that receives it; others catch up within this time |
| `PUBLIC_ACCESS` | `false` | Allow visitors of allowed sites to call without a key |
| `UNAUTH_DAILY_LIMIT` | `20` | Daily calls per visitor; the panel's `sitePolicy.unauthDailyLimit` wins; `0` = unlimited |
| `AUTH_DAILY_LIMIT` | `100` | Daily calls per signed-in user; the panel's `sitePolicy.authDailyLimit` wins; `0` = unlimited |
| `RATE_LIMIT_EXEMPT_ORIGINS` | empty | Sites exempt from the daily limit (full origins, comma-separated) |
| `SITE_IDS` | empty | `hostname=site_id`, comma-separated, subdomains match too. Unmatched calls are `other`, local ones `site_local`, developer keys use the key ID |
| `HIDE_UPSTREAM_MODEL` | `true` | For visitors and signed-in users, replace the response `model` with the requested value or `auto` |
| `UPSTREAM_TIMEOUT_MS` | `45000` | Timeout for a chat request to return headers |
| `MEDIA_TIMEOUT_MS` | `120000` | Timeout for image and audio endpoints |
| `STATS_UTC_OFFSET_MINUTES` | `480` | Time zone used to split stats into days. When the gateway is unreachable, the panel reads KV stats directly and that code splits days at UTC+8, so changing this makes the dates disagree |
| `LOG_RETENTION_DAYS` | `60` | Days to keep D1 logs, `0` = keep forever |
| `MAX_BODY_BYTES` | `2097152` | Chat request body limit |
| `MAX_MEDIA_BYTES` | `26214400` | Image and audio request body limit |
| `ALERT_COOLDOWN_SECONDS` | `600` | Minimum interval between identical Telegram alerts |
| `LOG_LANG` | `zh` | Language of failure reasons in stats and of alerts (`zh` or `en`) |

## Secrets

| Name | Description |
|---|---|
| `MASTER_KEY` | An extra developer key (besides the panel's developer keys) |
| `JWT_SECRET` | HS256 secret for recognising signed-in site users; without it, users aren't distinguished |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Fallback when the panel has no Telegram settings |
| `PROVIDER_KEY_*` | To keep a provider's API key out of KV, enter `env:PROVIDER_KEY_XXX` in the panel and the gateway reads the Secret of that name. Only names starting with `PROVIDER_KEY_` are readable this way |

Telegram alerts fire only when a visitor or signed-in user request switches provider or fails completely; developer-key requests never alert.

## Security

- Developer keys are compared in constant time on SHA-256 digests, and every candidate is checked so timing reveals nothing.
- Strict CORS: `Access-Control-Allow-Origin` is only returned for `ALLOWED_ORIGINS`; any other `Origin` gets 403. Requests without an `Origin` (CLI, servers) can only get in with a key.
- Errors returned to clients never include upstream raw text. Developer keys see the last upstream error, with provider keys, `Bearer` tokens and common key formats scrubbed.
- Logs and stats never record prompts, answers or any key; page paths are stored without query strings; rate-limit counters only store hashes of IPs and user IDs.
- The panel's KV holds provider keys and developer keys; a Cloudflare token that can write it is effectively an admin.

Please report security issues privately through a GitHub Security Advisory rather than a public issue.

## Internal calls (optional)

Other Workers in the same account can call through a Service Binding without a key (accounted as a developer, with the caller's name in stats):

```jsonc
// the caller's wrangler config
"services": [{ "binding": "AI_GATEWAY", "service": "my-ai-gateway", "entrypoint": "GatewayRPC" }]
```

```js
const data = await env.AI_GATEWAY.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, 'my-worker');
const verdict = await env.AI_GATEWAY.moderate({ messages, site: 'blog' }); // text with <think> blocks removed
```

## Local development

```bash
cp gateway/wrangler.example.jsonc gateway/wrangler.jsonc   # then fill it in
npx wrangler kv key put --local --binding CONFIG_KV AI_GATEWAY_CONFIG --path my-config.json --config gateway/wrangler.jsonc
npx wrangler dev --local --config gateway/wrangler.jsonc
```

Set `ALLOW_LOCALHOST` to `true` for local testing and put Secrets in `gateway/.dev.vars` (ignored by `.gitignore`).

## License

[MIT](../LICENSE) © 2026 Cheng Xiaobao (程小宝)

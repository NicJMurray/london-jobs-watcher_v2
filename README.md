# Simple Cloudflare Worker Telegram Bot (London Jobs)

This is a minimal Cloudflare Worker Telegram bot.

When you send `/jobs`, it:
- fetches one jobs page from `JOBS_URL`
- scans links using simple regex/string parsing
- keeps links where nearby text contains `London`
- replies with up to 10 matching job links

## Setup

### 1) Install

```bash
npm install
```

### 2) Log in to Cloudflare

```bash
npx wrangler login
```

### 3) Set Telegram token secret

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### 4) Set jobs page URL in `wrangler.jsonc`

Edit:

```jsonc
"vars": {
  "JOBS_URL": "https://example.com/jobs"
}
```

## Deploy

```bash
npx wrangler deploy
```

After deploy, copy your Worker URL (for example: `https://london-jobs-watcher.<subdomain>.workers.dev`).

## Set Telegram webhook

Use:

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>/webhook
```

Example:

```text
https://api.telegram.org/bot123456:ABCDEF/setWebhook?url=https://london-jobs-watcher.your-subdomain.workers.dev/webhook
```

## Endpoints

- `GET /health` → returns `OK`
- `POST /webhook` → receives Telegram updates

## Behavior

- If message is `/jobs`:
  - fetch `JOBS_URL`
  - find `<a>` links whose surrounding text includes `London`
  - send up to 10 links back to same chat
- If none found: replies `No London jobs found.`
- If an error happens: replies with a short `Error: ...` message

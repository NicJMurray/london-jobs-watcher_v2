# Simple Cloudflare Worker Telegram Bot (London Jobs)

This is a minimal Cloudflare Worker Telegram bot.

When you send `/jobs`, it:
- fetches one jobs page from `JOBS_URL`
- scans links using simple regex/string parsing
- keeps links where nearby text contains `London`
- checks Cloudflare KV to skip already-seen links
- replies with up to 10 new matching job links

## Setup

### 1) Install

```bash
npm install
```

### 2) Log in to Cloudflare

```bash
npx wrangler login
```

### 3) Create a KV namespace

```bash
npx wrangler kv namespace create JOBS_KV
```

Copy the returned namespace `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "JOBS_KV",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

### 4) Set Telegram token secret

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

### 5) Set jobs page URL in `wrangler.jsonc`

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

## Endpoints

- `GET /health` → returns `OK`
- `POST /webhook` → receives Telegram updates

## Behavior

- If message is `/jobs`:
  - fetch `JOBS_URL`
  - find `<a>` links whose surrounding text includes `London`
  - skip links already in KV
  - store new links in KV
  - send up to 10 new links back to same chat
- If no London matches at all: replies `No London jobs found.`
- If all London matches were seen before: replies `No new London jobs found.`
- If an error happens: replies with a short `Error: ...` message


## Automatic checks (every 6 hours)

A cron trigger is configured in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["0 */6 * * *"]
}
```

How it works:
- The first time you send `/jobs`, the bot stores your Telegram chat ID in KV.
- Every 6 hours, the Worker runs automatically and sends any new London links to that saved chat.
- If no chat ID is saved yet, the cron run does nothing.

# london-jobs-watcher

A Cloudflare Worker that runs every 6 hours, checks configured company careers pages/APIs for London jobs, stores already-seen jobs in Cloudflare KV, and sends only newly discovered London jobs to Telegram.

## What It Does

- Runs on a Cloudflare Workers cron schedule: `0 */6 * * *`
- Checks companies listed in [src/companies.js](src/companies.js)
- Supports Greenhouse, Lever, Ashby, and a basic fetch-based HTML fallback
- Stores seen jobs in KV binding `SEEN_JOBS` under key `seen-jobs-v1`
- Sends one Telegram message only when new London jobs are discovered
- Keeps going if one company fails and includes a warning in Telegram when new jobs are found

## Requirements

- Node.js 20 or newer
- A Cloudflare account
- A Telegram bot token from BotFather
- A Telegram chat ID for the chat where alerts should be sent

## Install

```bash
npm install
```

## Log In To Cloudflare

```bash
npx wrangler login
```

## Create The KV Namespace

Create the production namespace:

```bash
npx wrangler kv namespace create SEEN_JOBS
```

Create the preview/local namespace:

```bash
npx wrangler kv namespace create SEEN_JOBS --preview
```

Wrangler prints config snippets containing `id` and `preview_id`. Copy those IDs into [wrangler.jsonc](wrangler.jsonc):

```jsonc
"kv_namespaces": [
  {
    "binding": "SEEN_JOBS",
    "id": "paste-production-id-here",
    "preview_id": "paste-preview-id-here"
  }
]
```

The placeholder all-zero IDs let `wrangler dev` start locally, but real IDs are required before deployment.

## Set Telegram Secrets

For deployed Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

For local testing, create `.dev.vars` from the example:

```bash
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars`:

```text
TELEGRAM_BOT_TOKEN=123456789:your-real-token
TELEGRAM_CHAT_ID=123456789
```

To find your chat ID, send a message to your bot, then open:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
```

Look for `message.chat.id`.

## Local Testing

Start the Worker:

```bash
npm run dev
```

In another terminal:

```bash
curl http://localhost:8787/health
```

Expected response:

```text
OK
```

Send a Telegram test message:

```bash
curl http://localhost:8787/test-telegram
```

Run the watcher manually and send Telegram only if new London jobs are found:

```bash
curl http://localhost:8787/run-now
```

Run the watcher without sending Telegram:

```bash
curl "http://localhost:8787/run-now?notify=false"
```

This still records first-seen jobs in KV. Use it when you want to seed the dedupe list without sending an initial batch of existing jobs.

Inspect KV dedupe state:

```bash
curl http://localhost:8787/debug-seen
```

## Deploy

After replacing the KV namespace IDs in [wrangler.jsonc](wrangler.jsonc):

```bash
npm run deploy
```

The deployed Worker will run every 6 hours from the cron trigger in [wrangler.jsonc](wrangler.jsonc).

## GitHub Actions Deploy

The workflow is in [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It deploys on pushes to `main` and can also be run manually.

Add these repository secrets in GitHub:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The Worker still needs its own Telegram secrets in Cloudflare. Set them with:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

## Endpoints

- `GET /health` returns `OK`
- `GET or POST /test-telegram` sends a Telegram test message
- `GET or POST /run-now` checks companies immediately and sends a Telegram alert only if new London jobs are found
- `GET /run-now?notify=false` checks companies without sending Telegram
- `GET /debug-seen` shows the current KV dedupe count and recent seen jobs

## London Filtering

A job is treated as London-relevant when its title, location, office text, or HTML fallback context mentions:

- `London`
- `Greater London`
- `Hybrid London`
- `UK Remote` only when London is mentioned somewhere in the job text

Non-London UK jobs are excluded unless London appears somewhere in the parsed job text.

## How Dedupe Works

The Worker stores all first-seen jobs, not just London jobs. This avoids noisy alerts when an existing non-London job is later edited to mention London.

KV shape:

```json
{
  "version": 1,
  "updatedAt": "2026-05-04T12:00:00.000Z",
  "jobs": {
    "company-slug::job-id-or-canonical-url": {
      "firstSeenAt": "2026-05-04T12:00:00.000Z",
      "company": "Example",
      "title": "Example role",
      "location": "London",
      "url": "https://example.com/jobs/123"
    }
  }
}
```

## Add Or Edit Companies

Edit [src/companies.js](src/companies.js). Each entry has:

```js
{
  name: 'Company Name',
  slug: 'company-name',
  url: 'https://example.com/jobs',
  parserType: 'html',
  enabled: true,
  notes: 'Why this URL/parser is used.'
}
```

Supported `parserType` values:

- `greenhouse` for `https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true`
- `lever` for `https://api.lever.co/v0/postings/{site}?mode=json`
- `ashby` for `https://api.ashbyhq.com/posting-api/job-board/{job_board_name}?includeCompensation=false`
- `html` for basic fetch-based link parsing

To temporarily stop checking a company, set:

```js
enabled: false
```

## Add A Parser

Add a new parser function in [src/parsers.js](src/parsers.js), then extend `fetchCompanyJobs()` with a new `parserType`. Return normalized jobs with:

```js
{
  key: 'company::stable-id',
  company: 'Company',
  title: 'Job title',
  location: 'London',
  office: 'London',
  url: 'https://example.com/job',
  searchText: 'text used for London filtering'
}
```

Keep parsers fetch-based in v1. Do not add Playwright or browser automation.

## Troubleshooting

If `/run-now` returns `KV binding SEEN_JOBS is missing`, check [wrangler.jsonc](wrangler.jsonc).

If `/test-telegram` fails, check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

If a company appears in `failures`, the rest of the run still completed. Update that company's URL or parser in [src/companies.js](src/companies.js).

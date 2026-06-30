# Deployment

- Repo: `NicJMurray/london-jobs-watcher_v2`
- Purpose: London jobs scraper Worker with KV dedupe, cron checks, public scrape log, and Telegram alerts
- Canonical URL: `https://scraper.njmurray.com`
- Cloudflare type: Worker
- Cloudflare Worker name: `london-jobs-watcher`
- Deploy command: `npm run deploy`
- Wrangler command: `wrangler deploy`

## GitHub Actions

Pushing to `main` deploys through `.github/workflows/deploy.yml`.

Required repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Worker bindings and schedules are configured in `wrangler.jsonc`:

- KV binding: `SEEN_JOBS`
- Cron: `0 * * * *`

Cloudflare Worker secrets to set with Wrangler:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
```

The existing KV namespace IDs and preview IDs are kept in `wrangler.jsonc`.

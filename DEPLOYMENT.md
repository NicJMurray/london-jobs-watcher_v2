# Deployment

- Repo: `NicJMurray/london-jobs-watcher_v2`
- Purpose: London jobs scraper Worker with KV dedupe, cron checks, public scrape log, and Telegram alerts
- Canonical URL: `https://scraper.njmurray.com`
- Cloudflare type: Worker
- Cloudflare Worker name: `london-jobs-watcher`
- Deploy method: GitHub Actions + Wrangler
- Local/manual deploy command: `npm run deploy`
- Wrangler command: `wrangler deploy`

## GitHub Actions

This repo is a Worker project, so it keeps the Wrangler GitHub Actions workflow.

Pushing to `main` deploys through `.github/workflows/deploy.yml`.

GitHub repository secrets are required for the Cloudflare account ID and API token.

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

## Note

The static Pages repos use Cloudflare Git integration and do not need GitHub Actions deploy workflows. This Worker repo is different and still uses Wrangler.

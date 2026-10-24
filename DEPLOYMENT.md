# Deployment

| Setting | Value |
| --- | --- |
| Repository | `NicJMurray/london-jobs-watcher_v2` |
| Production branch | `main` |
| Live application | <https://scraper.njmurray.com> |
| Cloudflare Worker | `london-jobs-watcher` |
| Configuration | `wrangler.jsonc` in the repository root |
| Worker entry point | `src/index.js` |
| Install | `npm ci` |
| Build | No separate build step |
| Deploy | `npx wrangler deploy` |

## GitHub to Cloudflare

Pushing `main` runs `.github/workflows/deploy.yml`, which installs locked dependencies, and publishes this Worker through Wrangler. The workflow targets the known Cloudflare account directly and requires only `CLOUDFLARE_API_TOKEN` as a repository secret. A missing token fails explicitly.

The pipeline was verified on 23 October 2026 with a successful GitHub Actions deployment to the existing production Worker. The deployment token is stored as an encrypted repository secret; it must never be added to source. Deployment concurrency prevents overlapping releases. Check the current Actions result and live site for each subsequent change.

## Editing and publishing

1. Edit this repository; update `README.md` when routes, parser behaviour, or scheduling changes.
2. Run `npm ci`, `npm test`, and `npx wrangler deploy --dry-run`. Use `/check?company=slug` for read-only live source diagnostics.
3. Commit and push checked source to `main`.
4. Follow the GitHub Actions deployment for that exact commit, then verify `/health` and the public page.

`npm run deploy` is the manual fallback using the local Cloudflare sign-in. A manual upload does not verify Git-triggered publication.

The homepage links to this independent application. Its existing link opens the most recent successful production deployment.

## State, schedules, and secrets

Preserve the current production `SEEN_JOBS` namespace ID from `wrangler.jsonc`; replacing the namespace would lose deduplication history and reminder state. Keep the preview namespace distinct.

The cron is `0 * * * *` UTC. The application divides company checks into three hourly shards and independently evaluates reminders at its configured London time.

These are runtime Cloudflare Worker secrets, not ordinary build variables:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
```

Code deployments must retain existing secrets. Do not expose them in source, logs, or documentation.

Use `/health`, the public page, `/scraper.json`, or `/check?company=slug` for normal deployment verification. `/check` does not touch KV or Telegram. Manual `/run-now` requests now default to `notify=false&save=false`. Enabling either side effect requires an authenticated POST with the existing `TELEGRAM_WEBHOOK_SECRET` in `x-telegram-bot-api-secret-token`; no new credential is needed. The removed `/test-telegram` and `/test-latest-jobs` routes must not be used.

GitHub Actions runs the offline regression tests before deploying. Source repairs on 24 October 2026 switched Fujifilm to its current Workday board and Skyscanner to its current Ashby board. Microsoft checks now reject truncated/error responses and retry transient HTTP failures. BBC, Adidas, and Decathlon are no longer monitored or shown in the public log; their stored history is retained.

Revolut challenges direct requests from Cloudflare Worker IPs. `.github/workflows/refresh-revolut.yml` fetches its official careers page hourly using a GitHub runner and writes `revolut.json` on the separate `source-data` branch. It uses GitHub's built-in token with repository contents permission, not a new secret. The Worker reads that public snapshot and refuses data older than six hours. Source-data commits do not deploy the Worker. Run the refresh workflow manually after initial setup, confirm its success, and verify `/check?company=revolut` from production. Preserve the scheduled workflow when editing deployment automation.

Preserve the `scraper.njmurray.com` custom domain, Worker name, compatibility date, hourly schedule, and runtime bindings unless the task requires coordinated changes.

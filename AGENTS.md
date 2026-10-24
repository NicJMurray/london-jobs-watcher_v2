# Working on London Jobs Watcher

- This repository is the source for `https://scraper.njmurray.com`; the production Worker is `london-jobs-watcher`.
- Read `README.md` before changing parser identity, London matching, notifications, KV, or cron handling. Read `DEPLOYMENT.md` before changing publishing.
- Keep parsing fetch-based. The Worker has no headless browser; do not add one as a quick parser fix.
- Revolut is paused because its official page challenges Worker and GitHub runner requests. Do not re-enable it or restore the removed reader/snapshot workflow without a verified reliable fetch-based source.
- Use `npm ci`, `npm test`, and syntax-check changed JavaScript. Use `/check?company=slug` for narrow read-only source checks; it never reads/writes KV or sends Telegram.
- Preserve stable job keys; changing identity can rediscover historical roles and send duplicate alerts.
- Preserve the production `SEEN_JOBS` namespace and stored deduplication/reminder state. Do not clear KV or replace namespace IDs as a deployment workaround.
- Runtime secrets are `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_WEBHOOK_SECRET`; keep them in Cloudflare settings or ignored local files and never print values.
- Verify deployments through `/health`, `/`, `/scraper.json`, and narrow `/check` requests. Manual runs default to read-only; notification or KV writes require explicit flags and an authenticated POST using the existing webhook-secret header. Never call notification routes without explicit authorization to message recipients. Do not restore the removed notification test routes.
- Preserve the Worker name, domain, hourly cron, compatibility date, and bindings unless the task requires coordinated changes.
- Update documentation when parsers, routes, schedules, or deployment commands change.
- When publishing is requested or authorized, push checked source to `main`, verify deployment for that exact commit, then inspect health and public routes. Report pending or failed publication accurately.

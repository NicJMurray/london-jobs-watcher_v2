# Working on London Jobs Watcher

- This repository is the source for `https://scraper.njmurray.com`; the production Worker is `london-jobs-watcher`.
- Read `README.md` before changing parser identity, London matching, notifications, KV, or cron handling. Read `DEPLOYMENT.md` before changing publishing.
- Keep parsing fetch-based. The Worker has no headless browser; do not add one as a quick parser fix.
- Use `npm ci` and syntax-check changed JavaScript. Use narrow read-only parser checks when runtime validation is necessary.
- Preserve stable job keys; changing identity can rediscover historical roles and send duplicate alerts.
- Preserve the production `SEEN_JOBS` namespace and stored deduplication/reminder state. Do not clear KV or replace namespace IDs as a deployment workaround.
- Runtime secrets are `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_WEBHOOK_SECRET`; keep them in Cloudflare settings or ignored local files and never print values.
- Verify deployments through `/health`, `/`, or `/scraper.json`. Manual notification routes send messages; do not call them without explicit authorization to message recipients. For a requested read-only watcher diagnostic, set both `notify=false` and `save=false`.
- Preserve the Worker name, domain, hourly cron, compatibility date, and bindings unless the task requires coordinated changes.
- Update documentation when parsers, routes, schedules, or deployment commands change.
- When publishing is requested or authorized, push checked source to `main`, verify deployment for that exact commit, then inspect health and public routes. Report pending or failed publication accurately.

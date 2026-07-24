# London Jobs Watcher

Personal Cloudflare Worker at `scraper.njmurray.com`. It watches a configured set of careers pages for London roles, remembers everything it has seen, sends Telegram alerts only for genuinely new relevant jobs, and also handles birthday/anniversary reminders.

## Scheduled jobs flow

The Worker runs hourly. Each run checks one of three company shards, so the source list is spread across three hours rather than fetched all at once.

1. `src/companies.js` defines the companies, their source URL, parser type, and whether each is enabled.
2. `fetchCompanyJobs()` in `src/parsers.js` uses the relevant fetch-based parser (for example Greenhouse, Lever, Ashby, Workday, iCIMS, or a site-specific parser) and returns a common job shape.
3. `isLondonJob()` decides whether the title, location, office, or parser text is London-relevant.
4. `src/index.js` de-duplicates job keys within the run and against the `seen-jobs-v1` object in the `SEEN_JOBS` KV namespace. Non-London jobs are also stored: this stops an old non-London listing becoming a “new” alert merely because its text later changes.
5. A new London role is only eligible for an alert if it is not more than 14 days old when a posted date is available. Parsers can also perform a job-specific open/closed check before notification.
6. Eligible roles are grouped into Telegram messages. Once they are successfully sent, their KV records receive `telegramSentAt`. If Telegram fails, the seen state is not saved, so a later run can retry instead of silently losing the alert.

Individual company failures do not stop the rest of the run. Failure warnings are included when there are new jobs, or when every enabled source fails.

## Public scraper page

`/` and `/scraper` render a small HTML page directly from the KV history. It shows London-relevant records first seen in the last 30 days, with client-side keyword and company filtering. `/scraper.json` exposes the same current window as JSON.

The page is based on stored discoveries, not a live re-fetch when someone loads it. It is therefore a 30-day scrape log rather than an authoritative current vacancy list.

## Birthday and Telegram behaviour

`src/birthdays.js` is the source of truth for birthdays and anniversaries. Hourly cron runs call the birthday handler too, but it only sends during the `08:00` hour in `Europe/London` and uses a separate KV key to avoid duplicate reminders. The Telegram webhook supports `/birthdays` and `/events`, replying with the next three relevant dates only for the configured chat.

The running Worker needs the `SEEN_JOBS` KV binding plus its Telegram token, chat ID, and webhook secret. Those values are runtime configuration rather than files in this repo.

## Code map

| File | Responsibility |
| --- | --- |
| `src/index.js` | HTTP routes, hourly scheduling, orchestration, KV persistence, Telegram messages, public scraper UI, and birthday reminders. |
| `src/companies.js` | Company source registry and enable/disable switches. |
| `src/parsers.js` | Generic and site-specific careers parsers, normalisation, London filtering, and open-job checks. |
| `src/birthdays.js` | Birthday and anniversary data. |
| `wrangler.jsonc` | Worker entry point, hourly cron, custom domain, and KV binding. |
| `scripts/set-telegram-webhook.mjs` | Registers the production webhook and bot command metadata. |

## Useful routes

| Route | Purpose |
| --- | --- |
| `/health` | Minimal health check. |
| `/run-now` | Manually runs the watcher; `notify=false` and `save=false` allow inspection without alerts or KV changes. |
| `/test-latest-jobs` | Sends the latest parsed London job per source without changing dedupe state. |
| `/run-birthday-reminders` | Manually runs or previews birthday reminders. |
| `/debug-seen` | Inspects recent stored job records. |
| `/telegram-webhook` | Receives Telegram commands. |

## Things worth changing

- Add, remove, or pause companies in `src/companies.js`; use `enabled: false` to pause one without deleting its notes.
- Add a parser in `src/parsers.js` only when a generic source type will not work. Keep it fetch-based: browser automation is intentionally not part of this Worker.
- Adjust the alert-age and public-window constants at the top of `src/index.js` if the trade-off between freshness and history changes.
- Edit `src/birthdays.js` directly for dates; `kind: 'anniversary'` changes the reminder wording.

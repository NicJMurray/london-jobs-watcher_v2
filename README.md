# London Jobs Watcher

A fetch-based Cloudflare Worker that watches company careers pages for new London
jobs, sends Telegram alerts, and serves a [30-day discovery log](https://scraper.njmurray.com/).
The same bot also handles birthday/anniversary reminders and `/birthdays` commands.

## How it works

1. The hourly cron checks one of three company shards. Each enabled company is
   checked once every three hours, with up to six companies fetched concurrently.
2. Source parsers return a common job shape with a stable `company::source-id` key.
3. The Worker checks the `SEEN_JOBS` KV history, applies London and freshness rules,
   and sends alerts for unseen London jobs.
4. Discovery history is saved only after notification handling succeeds. Failed
   Telegram delivery leaves the new jobs eligible for the next run.

There is no browser automation, database, queue, or third-party scraping service.
Most sources use their official recruiting APIs; the remaining ones expose job
data in their public HTML. Revolut is paused: its page challenges both Cloudflare
Workers and GitHub runners, and the former third-party reader is rate-limited.
It needs a reliable fetch-based source before being re-enabled; the bot does not
attempt browser challenges or maintain a proxy/snapshot pipeline for it.

Network requests have a 45-second timeout covering the
body as well as the headers. A network failure, HTTP 429, or HTTP 5xx gets at most
one retry; permanent HTTP errors fail immediately. Long `Retry-After` instructions
are reported rather than ignored or allowed to stall the run.
Worker logs are enabled for investigating failures from the scheduled runs.

## Company configuration and source repairs

`src/companies.js` is the watchlist. Each entry provides `name`, `slug`, `url`,
`parserType`, and `enabled`, with source-specific pagination/location options.
There are 28 enabled companies and four paused sources. BBC, Adidas, and
Decathlon have been removed from the watchlist and public results; their old KV
records remain intact for deduplication/history.

Repairs made on 24 October 2026:

| Company | Cause | Current source |
| --- | --- | --- |
| Fujifilm | The Europe iCIMS portal was retired and returned 404. | Workday board linked from [Fujifilm UK careers](https://www.fujifilm.com/uk/en/about/career), searched for London. Zero matching jobs is valid. |
| Revolut | The third-party reader was rate-limited; both Worker and GitHub runner requests hit a browser challenge. | Paused until a reliable fetch-based source is available. The parser retains original UUIDs; existing job history is preserved. |
| Microsoft | No HTTP failure reproduced during the review; the three-page cap did omit results. | Official Eightfold API, with one transient retry and up to ten pages. Missing/error payloads and truncated results fail explicitly. |
| Skyscanner | The old Greenhouse board returns 404. | Official Ashby board used by Skyscanner's current careers page. Unlisted jobs are excluded. |

Supported parser families are Greenhouse, Ashby, Workday, Workable, Jibe,
Eightfold, Spotify, Apple, Meta GraphQL, Next.js-embedded data, and plain HTML.
Unused Lever, Paradox, SuccessFactors, and iCIMS parsers have been removed, along
with the BBC-only detail-page checks and duplicated retry implementations.

## Safe diagnostics

Start with a single company instead of running the entire watchlist:

```text
GET /check
GET /check?company=fujifilm
GET /check?company=microsoft
GET /check?company=revolut
```

Without a company, `/check` lists the configured sources. With a slug, it fetches
that source and returns total/London counts plus up to five sample London jobs.
It never reads/writes KV or sends Telegram messages. A source failure returns
HTTP 502 and its reason; a healthy board with no matching jobs returns HTTP 200.

`GET /run-now?shard=0&shards=3` additionally compares one shard with existing KV
history. Manual runs default to `notify=false` and `save=false`, so opening a URL
cannot send alerts or consume discovery history. Omit shard parameters to check
all enabled companies, but use a narrow diagnostic when possible.

Sending alerts or saving history manually requires an explicit authenticated
`POST /run-now?notify=true&save=true`, with the existing `TELEGRAM_WEBHOOK_SECRET`
in the `x-telegram-bot-api-secret-token` header. Never put this secret in a URL.
The old `/test-telegram` and `/test-latest-jobs` routes have been removed.

## Matching, state, and public history

- London includes Greater London and explicit London hybrid roles. Ontario is
  excluded; a generic remote role mentioning the London office is not enough.
- New jobs with a known posting date more than 14 days old are recorded without
  alerts. Jobs with no date are eligible on first discovery.
- Source IDs must remain stable. Changing them can rediscover historical jobs.
- `SEEN_JOBS` stores `seen-jobs-v1`, a versioned JSON object keyed by job identity.
  It includes all discovered jobs, including non-London roles, so an edited
  location does not make an old job appear new.
- The public log shows configured companies' London discoveries from the last 30
  days, up to 5,000 records. It is a discovery log, not proof a vacancy is still
  open. Removed companies are hidden without deleting stored records; paused
  companies' existing discoveries remain visible within the usual window.
- KV remains one JSON object: simple for this bot, but concurrent manual writes
  can conflict with the scheduled run. Use read-only diagnostics routinely.

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /health` | `OK`, without upstream requests. |
| `GET /` or `/scraper` | Public HTML log, cached for five minutes. |
| `GET /scraper.json` | Public log as JSON. |
| `GET /check?company=slug` | Source-only, read-only diagnostic. |
| `GET /run-now` | Read-only comparison with discovery history; optional `shard`/`shards`. |
| `POST /run-now` | Same diagnostic; explicit `notify=true`/`save=true` require authentication. |
| `GET /debug-seen?limit=25` | History count and up to 100 recent records. |
| `GET /run-birthday-reminders` | Reminder preview; optional `date=YYYY-MM-DD` and `force=true`. |
| `POST /run-birthday-reminders?notify=true` | Authenticated manual reminder sending. |
| `POST /telegram-webhook` | Authenticated bot commands from the configured chat. |

The scheduled reminder check runs at 08:00 Europe/London and checks today and
tomorrow. Dates live in `src/birthdays.js`; successful deliveries are deduplicated
under the separate `birthday-reminders-v1` KV key. The webhook uses the same
existing secret and fails closed when that secret is missing. Job checks and
reminders fail independently.

## Working on the bot

```sh
npm ci
npm test
npx wrangler deploy --dry-run
```

The tests use recorded source shapes and mocked fetch/KV/Telegram boundaries;
they never contact production or send messages. They cover source migrations,
pagination, malformed payloads, bounded retries, safe diagnostics, notification
failure handling, and history preservation.

| File | Responsibility |
| --- | --- |
| `src/companies.js` | Watchlist and source configuration. |
| `src/parsers.js` | Source retrieval, normalisation, stable IDs, and London matching. |
| `src/index.js` | HTTP page/API, cron, deduplication, Telegram, and reminders. |
| `src/birthdays.js` | Personal dates. |
| `test/` | Offline regression tests. |
| `wrangler.jsonc` | Worker, domain, hourly cron, and existing KV bindings. |

Keep `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_WEBHOOK_SECRET` in
Cloudflare secrets or ignored `.dev.vars`, never source or logs. Preserve the
current KV namespace and its contents. When publishing, push checked source to
`main`; GitHub Actions runs tests and deploys through Wrangler. Verify that exact
commit and the live health/page/source checks before reporting success. See
[DEPLOYMENT.md](DEPLOYMENT.md).

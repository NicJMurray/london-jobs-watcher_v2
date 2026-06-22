import { BIRTHDAY_EVENTS } from './birthdays.js';
import { COMPANIES } from './companies.js';
import { fetchCompanyJobs, isLondonJob, verifyJobIsOpenForAlert } from './parsers.js';

const SEEN_KV_KEY = 'seen-jobs-v1';
const BIRTHDAY_REMINDER_KV_KEY = 'birthday-reminders-v1';
const BIRTHDAY_REMINDER_TIME_ZONE = 'Europe/London';
const BIRTHDAY_REMINDER_HOUR = 8;
const MAX_DEBUG_JOBS = 100;
const MAX_PUBLIC_SCRAPER_JOBS = 5000;
const PUBLIC_SCRAPER_WINDOW_DAYS = 30;
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const COMPANY_FETCH_CONCURRENCY = 6;
const SCHEDULED_COMPANY_SHARDS = 3;
const MAX_ALERT_JOB_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return textResponse('OK');
      }

      if (request.method === 'GET' && ['/scraper', '/scraper/'].includes(url.pathname)) {
        return scraperPageResponse(env);
      }

      if (request.method === 'GET' && url.pathname === '/scraper.json') {
        const jobs = await loadPublicScraperJobs(env);
        return jsonResponse({
          ok: true,
          generatedAt: new Date().toISOString(),
          scope: {
            location: 'London',
            days: PUBLIC_SCRAPER_WINDOW_DAYS,
          },
          count: jobs.length,
          jobs,
        });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/test-telegram') {
        const message = `london-jobs-watcher test message\n${new Date().toISOString()}`;
        await sendTelegramMessage(env, message);
        return jsonResponse({ ok: true, sent: true });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/test-latest-jobs') {
        const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
        const shardOptions = parseShardSearchParams(url.searchParams);
        const result = await runLatestJobsTest(env, { includeDisabled, ...shardOptions });
        const status = result.notification?.error ? 502 : 200;
        return jsonResponse(result, { status });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/run-now') {
        const shouldNotify = url.searchParams.get('notify') !== 'false';
        const shouldSaveSeen = url.searchParams.get('save') !== 'false';
        const shardOptions = parseShardSearchParams(url.searchParams);
        const result = await runWatcher(env, {
          trigger: 'manual',
          notify: shouldNotify,
          saveSeen: shouldSaveSeen,
          ...shardOptions,
        });
        const status = result.notification?.error ? 502 : 200;
        return jsonResponse(summarizeRun(result), { status });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/run-birthday-reminders') {
        const shouldNotify = url.searchParams.get('notify') !== 'false';
        const result = await runBirthdayReminders(env, {
          trigger: 'manual',
          notify: shouldNotify,
          force: url.searchParams.get('force') === 'true',
          dateOverride: url.searchParams.get('date') || '',
        });
        const status = result.notification?.error ? 502 : 200;
        return jsonResponse(result, { status });
      }

      if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
        const result = await handleTelegramWebhook(request, env);
        return jsonResponse(result);
      }

      if (request.method === 'GET' && url.pathname === '/debug-seen') {
        const limit = clampNumber(Number(url.searchParams.get('limit') || 25), 1, MAX_DEBUG_JOBS);
        const seenStore = await loadSeenStore(env);
        const jobs = Object.entries(seenStore.jobs)
          .map(([key, value]) => ({ key, ...value }))
          .sort((a, b) => String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')))
          .slice(0, limit);

        return jsonResponse({
          ok: true,
          kvKey: SEEN_KV_KEY,
          count: Object.keys(seenStore.jobs).length,
          showing: jobs.length,
          jobs,
        });
      }

      return jsonResponse({ ok: false, error: 'Not Found' }, { status: 404 });
    } catch (error) {
      console.error('Request failed', error);
      return jsonResponse({ ok: false, error: errorMessage(error) }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env, { scheduledTime: event.scheduledTime }));
  },
};

async function scraperPageResponse(env) {
  const jobs = await loadPublicScraperJobs(env);
  return htmlResponse(renderScraperPage(jobs), {
    headers: {
      'cache-control': 'public, max-age=300',
    },
  });
}

async function loadPublicScraperJobs(env) {
  const seenStore = await loadSeenStore(env);
  const now = new Date();

  return Object.values(seenStore.jobs)
    .map((job) => ({
      firstSeenAt: String(job.firstSeenAt || ''),
      company: String(job.company || ''),
      title: String(job.title || 'Untitled entry'),
      location: String(job.location || ''),
      office: String(job.office || ''),
      url: String(job.url || ''),
      postedAt: String(job.postedAt || ''),
      london: typeof job.london === 'boolean' ? job.london : null,
      telegramSentAt: String(job.telegramSentAt || ''),
    }))
    .filter((job) => shouldShowPublicScraperJob(job, now))
    .sort((a, b) => {
      const byFirstSeen = timestampFromDate(b.firstSeenAt) - timestampFromDate(a.firstSeenAt);
      if (byFirstSeen) return byFirstSeen;

      const byCompany = a.company.localeCompare(b.company);
      return byCompany || a.title.localeCompare(b.title);
    })
    .map(({ london, office, telegramSentAt, ...job }) => job)
    .slice(0, MAX_PUBLIC_SCRAPER_JOBS);
}

function shouldShowPublicScraperJob(job, now) {
  if (!job.company || !job.title || !job.url) return false;

  const firstSeenTimestamp = timestampFromDate(job.firstSeenAt);
  if (!firstSeenTimestamp) return false;

  const windowStart = now.getTime() - PUBLIC_SCRAPER_WINDOW_DAYS * DAY_MS;
  if (firstSeenTimestamp < windowStart) return false;

  if (job.telegramSentAt) return true;

  const matchesLondon = job.london === true || (job.london !== false && isLondonJob(job));
  if (!matchesLondon) return false;

  return !staleAlertReason(job, new Date(firstSeenTimestamp));
}

function renderScraperPage(jobs) {
  const companies = uniqueStrings(jobs.map((job) => job.company)).sort((a, b) => a.localeCompare(b));
  const generatedAt = new Date().toISOString();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Scraper | Nic</title>
    <meta name="description" content="A London-only 30-day company scrape log." />
    <meta property="og:title" content="Scraper" />
    <meta property="og:description" content="A London-only 30-day company scrape log." />
    <meta property="og:type" content="website" />
    <meta name="theme-color" content="#f4f6f3" />
    <style>
      :root {
        --paper: #f4f6f3;
        --surface: #fffef9;
        --ink: #171a1f;
        --muted: #66716b;
        --line: #cfd8d0;
        --green: #174f43;
        --green-dark: #0f3932;
        --blue: #284f8f;
        --red: #b5483c;
        --gold: #c18426;
        --shadow: 0 18px 44px rgba(23, 26, 31, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      html {
        min-width: 320px;
        background: var(--paper);
      }

      body {
        min-width: 320px;
        min-height: 100vh;
        margin: 0;
        color: var(--ink);
        background:
          linear-gradient(90deg, rgba(23, 79, 67, 0.08) 1px, transparent 1px),
          linear-gradient(rgba(40, 79, 143, 0.055) 1px, transparent 1px),
          var(--paper);
        background-size: 44px 44px;
        font: 16px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      .shell {
        width: min(1120px, calc(100% - 40px));
        margin: 0 auto;
        padding: 28px 0 56px;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        min-height: 48px;
        padding-bottom: 18px;
        border-bottom: 1px solid var(--line);
      }

      .wordmark {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
      }

      .mark {
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        border: 1px solid var(--green);
        border-radius: 8px;
        color: var(--surface);
        background: var(--green);
        font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
      }

      nav {
        display: flex;
        align-items: center;
        gap: 18px;
        color: var(--muted);
        font-size: 0.95rem;
      }

      nav a {
        border-bottom: 1px solid transparent;
      }

      nav a:hover {
        color: var(--ink);
        border-bottom-color: currentColor;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 28px;
        align-items: end;
        padding: 58px 0 34px;
      }

      .eyebrow {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1 {
        max-width: 740px;
        margin: 0;
        font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
        font-size: clamp(3rem, 9vw, 6.8rem);
        line-height: 0.92;
        font-weight: 800;
      }

      .summary {
        width: min(300px, 100%);
        color: var(--muted);
      }

      .summary strong {
        display: block;
        color: var(--ink);
        font-size: 2rem;
        line-height: 1.1;
      }

      .controls {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) minmax(180px, 260px);
        gap: 14px;
        align-items: end;
        padding: 18px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 254, 249, 0.78);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      input,
      select {
        width: 100%;
        height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        color: var(--ink);
        background: var(--surface);
        font: inherit;
      }

      input:focus,
      select:focus {
        outline: 3px solid rgba(193, 132, 38, 0.24);
        border-color: var(--gold);
      }

      .meta-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        margin: 26px 0 14px;
        color: var(--muted);
        font-size: 0.92rem;
      }

      .list {
        display: grid;
        gap: 12px;
      }

      .entry {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 20px;
        min-height: 118px;
        padding: 18px;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 254, 249, 0.9);
        box-shadow: 0 12px 26px rgba(23, 26, 31, 0.05);
      }

      .entry::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 5px;
        background: linear-gradient(180deg, var(--green), var(--blue));
      }

      .entry h2 {
        margin: 4px 0 8px;
        font-size: 1.08rem;
        line-height: 1.35;
      }

      .company {
        margin: 0;
        color: var(--green-dark);
        font-weight: 800;
      }

      .detail {
        margin: 0;
        color: var(--muted);
      }

      .date {
        display: grid;
        align-content: start;
        justify-items: end;
        gap: 8px;
        min-width: 138px;
        color: var(--muted);
        font-size: 0.9rem;
        text-align: right;
      }

      .date a {
        color: var(--blue);
        font-weight: 800;
        border-bottom: 1px solid rgba(40, 79, 143, 0.28);
      }

      .empty {
        display: none;
        padding: 32px 18px;
        border: 1px dashed var(--line);
        border-radius: 8px;
        color: var(--muted);
        background: rgba(255, 254, 249, 0.62);
        text-align: center;
      }

      .empty[aria-hidden="false"] {
        display: block;
      }

      footer {
        margin-top: 46px;
        padding-top: 24px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 0.92rem;
      }

      @media (max-width: 760px) {
        .shell {
          width: min(100% - 28px, 1120px);
          padding-top: 18px;
        }

        .topbar,
        .hero,
        .entry,
        .meta-row {
          grid-template-columns: 1fr;
        }

        .topbar,
        .meta-row {
          align-items: flex-start;
        }

        nav {
          flex-wrap: wrap;
          gap: 10px 14px;
        }

        .hero {
          padding-top: 38px;
        }

        .controls {
          grid-template-columns: 1fr;
          padding: 14px;
        }

        .date {
          justify-items: start;
          min-width: 0;
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <a class="wordmark" href="/" aria-label="njmurray homepage">
          <span class="mark" aria-hidden="true">N</span>
          <span>Nic Murray</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/">Home</a>
          <a href="/books/">Books</a>
          <a href="/playlist/">Playlist Finder</a>
          <a href="/playlists/">Playlists</a>
          <a href="/gutenberg/">Rare Words</a>
        </nav>
      </header>

      <section class="hero" aria-labelledby="scraper-title">
        <div>
          <p class="eyebrow">Tech</p>
          <h1 id="scraper-title">Scraper</h1>
        </div>
        <p class="summary">
          <strong>${jobs.length.toLocaleString('en-GB')}</strong>
          London company records, last ${PUBLIC_SCRAPER_WINDOW_DAYS} days
        </p>
      </section>

      <section class="controls" aria-label="Filters">
        <label>
          Keyword
          <input id="search" type="search" autocomplete="off" placeholder="Search title, company, location" />
        </label>
        <label>
          Company
          <select id="company">
            <option value="">All companies</option>
            ${companies.map((company) => `<option value="${escapeHtml(company)}">${escapeHtml(company)}</option>`).join('')}
          </select>
        </label>
      </section>

      <div class="meta-row">
        <span id="result-count">${jobs.length.toLocaleString('en-GB')} London records</span>
        <span>Last ${PUBLIC_SCRAPER_WINDOW_DAYS} days &middot; Updated ${escapeHtml(formatPublicDateTime(generatedAt))}</span>
      </div>

      <section id="list" class="list" aria-live="polite"></section>
      <p id="empty" class="empty" aria-hidden="true">No matching London records.</p>

      <footer>
        <a href="/">&copy; <span id="year"></span> Nic Murray</a>
      </footer>
    </main>

    <script id="scrape-data" type="application/json">${jsonForHtml(jobs)}</script>
    <script>
      const jobs = JSON.parse(document.getElementById("scrape-data").textContent);
      const list = document.getElementById("list");
      const empty = document.getElementById("empty");
      const search = document.getElementById("search");
      const company = document.getElementById("company");
      const resultCount = document.getElementById("result-count");
      const formatter = new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      document.getElementById("year").textContent = new Date().getFullYear();

      function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Date unknown";
        return formatter.format(date);
      }

      function escapeText(value) {
        return String(value || "").replace(/[&<>"']/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "\\"": "&quot;",
          "'": "&#39;",
        }[character]));
      }

      function render() {
        const query = search.value.trim().toLowerCase();
        const companyValue = company.value;
        const visible = jobs.filter((job) => {
          const companyMatch = !companyValue || job.company === companyValue;
          const haystack = [job.title, job.company, job.location].join(" ").toLowerCase();
          return companyMatch && (!query || haystack.includes(query));
        });

        resultCount.textContent = visible.length.toLocaleString("en-GB") + (visible.length === 1 ? " London record" : " London records");
        empty.setAttribute("aria-hidden", String(visible.length !== 0));
        list.innerHTML = visible.map((job) => \`
          <article class="entry">
            <div>
              <p class="company">\${escapeText(job.company)}</p>
              <h2>\${escapeText(job.title)}</h2>
              <p class="detail">\${escapeText(job.location || "Location not listed")}</p>
            </div>
            <div class="date">
              <time datetime="\${escapeText(job.firstSeenAt)}">\${escapeText(formatDate(job.firstSeenAt))}</time>
              <a href="\${escapeText(job.url)}" rel="noreferrer" target="_blank">Open</a>
            </div>
          </article>
        \`).join("");
      }

      search.addEventListener("input", render);
      company.addEventListener("change", render);
      render();
    </script>
  </body>
</html>`;
}

async function runScheduledTasks(env, options = {}) {
  const companyShard = scheduledCompanyShard(options.scheduledTime);

  await Promise.all([
    runWatcher(env, {
      trigger: 'scheduled',
      notify: true,
      companyShard,
      companyShards: SCHEDULED_COMPANY_SHARDS,
    }).catch((error) => {
      console.error('Scheduled jobs run failed', error);
    }),
    runBirthdayReminders(env, { trigger: 'scheduled', notify: true }).catch((error) => {
      console.error('Scheduled birthday reminder run failed', error);
    }),
  ]);
}

async function runWatcher(env, options = {}) {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const seenStore = await loadSeenStore(env);
  const seenJobs = seenStore.jobs;

  const enabledCompaniesAll = COMPANIES.filter((company) => company.enabled);
  const disabledCompanies = COMPANIES.filter((company) => !company.enabled);
  const companyShard = normalizeCompanyShard(options.companyShard, options.companyShards);
  const enabledCompanies = companyShard
    ? enabledCompaniesAll.filter((_, index) => index % companyShard.total === companyShard.index)
    : enabledCompaniesAll;

  const run = {
    ok: true,
    trigger: options.trigger || 'manual',
    startedAt: startedAtIso,
    finishedAt: null,
    checkedCompanies: enabledCompanies.length,
    totalEnabledCompanies: enabledCompaniesAll.length,
    disabledCompanies: disabledCompanies.length,
    companyShard,
    saveSeen: options.saveSeen !== false,
    totalJobsFound: 0,
    londonJobsFound: 0,
    firstSeenJobs: 0,
    skippedLondonAlerts: [],
    newLondonJobs: [],
    failures: [],
    notification: {
      attempted: false,
      sent: false,
      error: null,
    },
  };

  const companyResults = await mapWithConcurrency(
    enabledCompanies,
    COMPANY_FETCH_CONCURRENCY,
    async (company) => checkCompany(company),
  );

  const processedKeys = new Set();
  let seenStoreChanged = false;

  for (const companyResult of companyResults) {
    if (!companyResult.ok) {
      run.failures.push(companyResult.failure);
      continue;
    }

    run.totalJobsFound += companyResult.jobs.length;

    for (const job of companyResult.jobs) {
      if (!job?.key || processedKeys.has(job.key)) continue;
      processedKeys.add(job.key);

      const londonJob = isLondonJob(job);
      if (londonJob) run.londonJobsFound += 1;

      if (seenJobs[job.key]) continue;

      run.firstSeenJobs += 1;
      seenStoreChanged = true;
      seenJobs[job.key] = {
        firstSeenAt: startedAtIso,
        company: job.company,
        title: job.title,
        location: job.location || job.office || '',
        office: job.office || '',
        url: job.url,
        postedAt: job.postedAt || '',
        closingAt: job.closingAt || '',
        london: londonJob,
      };

      if (londonJob) {
        const alertDecision = await shouldAlertNewLondonJob(job, startedAt);

        if (!alertDecision.alert) {
          run.skippedLondonAlerts.push({
            company: job.company,
            title: job.title,
            location: job.location || job.office || 'Location not listed',
            url: job.url,
            reason: alertDecision.reason,
          });
          continue;
        }

        run.newLondonJobs.push({
          key: job.key,
          company: job.company,
          title: job.title,
          location: job.location || job.office || 'Location not listed',
          url: job.url,
        });
      }
    }
  }

  run.newLondonJobs.sort((a, b) => {
    const byCompany = a.company.localeCompare(b.company);
    return byCompany || a.title.localeCompare(b.title);
  });

  const shouldNotify = options.notify !== false;

  if (shouldNotify) {
    const messages = formatTelegramRunMessages(run);
    if (messages.length > 0) {
      run.notification.attempted = true;
      try {
        for (const message of messages) {
          await sendTelegramMessage(env, message);
        }
        run.notification.sent = true;
        markTelegramSentJobs(seenJobs, run.newLondonJobs);
      } catch (error) {
        run.notification.error = errorMessage(error);
        console.error('Telegram notification failed', error);
      }
    }
  }

  const notificationFailed = run.notification.attempted && !run.notification.sent && run.notification.error;

  if (seenStoreChanged && !notificationFailed && options.saveSeen !== false) {
    await saveSeenStore(env, {
      version: 1,
      updatedAt: new Date().toISOString(),
      jobs: seenJobs,
    });
  }

  run.finishedAt = new Date().toISOString();
  console.log(`Run finished: ${run.newLondonJobs.length} new London jobs, ${run.failures.length} failures`);

  return run;
}

function markTelegramSentJobs(seenJobs, jobs) {
  const sentAt = new Date().toISOString();

  for (const job of jobs) {
    if (!job.key || !seenJobs[job.key]) continue;
    seenJobs[job.key].telegramSentAt = sentAt;
  }
}

async function shouldAlertNewLondonJob(job, runStartedAt) {
  const staleReason = staleAlertReason(job, runStartedAt);
  if (staleReason) return { alert: false, reason: staleReason };

  try {
    const openCheck = await verifyJobIsOpenForAlert(job, runStartedAt);
    if (!openCheck.open) {
      return { alert: false, reason: openCheck.reason || 'job appears closed' };
    }
  } catch (error) {
    console.warn(`Could not verify job is open for alert: ${job.key}`, error);
  }

  return { alert: true, reason: '' };
}

function staleAlertReason(job, runStartedAt) {
  if (!job.postedAt) return '';

  const postedAt = new Date(job.postedAt);
  if (Number.isNaN(postedAt.getTime())) return '';

  const cutoff = new Date(runStartedAt.getTime() - MAX_ALERT_JOB_AGE_DAYS * DAY_MS);
  if (postedAt >= cutoff) return '';

  return `posted more than ${MAX_ALERT_JOB_AGE_DAYS} days ago (${postedAt.toISOString().slice(0, 10)})`;
}

async function runLatestJobsTest(env, options = {}) {
  const startedAt = new Date().toISOString();
  const allCompanies = COMPANIES.filter((company) => options.includeDisabled || company.enabled);
  const disabledCompanies = COMPANIES.filter((company) => !company.enabled);
  const companyShard = normalizeCompanyShard(options.companyShard, options.companyShards);
  const companies = companyShard
    ? allCompanies.filter((_, index) => index % companyShard.total === companyShard.index)
    : allCompanies;
  const companyResults = await mapWithConcurrency(
    companies,
    COMPANY_FETCH_CONCURRENCY,
    async (company) => checkCompany(company),
  );

  const latestJobs = [];
  const noJobs = [];
  const failures = [];

  for (const companyResult of companyResults) {
    if (!companyResult.ok) {
      failures.push(companyResult.failure);
      continue;
    }

    const londonJobs = companyResult.jobs.filter(isLondonJob);
    const latestJob = pickLatestJob(londonJobs);
    if (!latestJob) {
      noJobs.push(companyResult.company);
      continue;
    }

    latestJobs.push({
      company: latestJob.company,
      title: latestJob.title,
      location: latestJob.location || latestJob.office || 'Location not listed',
      url: latestJob.url,
      postedAt: latestJob.postedAt || '',
    });
  }

  latestJobs.sort((a, b) => a.company.localeCompare(b.company));
  noJobs.sort((a, b) => a.localeCompare(b));

  const messages = formatLatestJobsTestMessages({
    startedAt,
    checkedCompanies: companies.length,
    disabledCompanies: options.includeDisabled ? 0 : disabledCompanies.length,
    latestJobs,
    noJobs,
    failures,
  });

  const notification = {
    attempted: true,
    sent: false,
    messages: messages.length,
    error: null,
  };

  try {
    for (const message of messages) {
      await sendTelegramMessage(env, message);
    }
    notification.sent = true;
  } catch (error) {
    notification.error = errorMessage(error);
    console.error('Latest jobs test Telegram notification failed', error);
  }

  return {
    ok: !notification.error,
    startedAt,
    finishedAt: new Date().toISOString(),
    checkedCompanies: companies.length,
    totalCompanies: allCompanies.length,
    disabledCompanies: options.includeDisabled ? 0 : disabledCompanies.length,
    companyShard,
    latestJobsCount: latestJobs.length,
    noJobs,
    failures,
    notification,
    latestJobs,
  };
}

async function runBirthdayReminders(env, options = {}) {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const trigger = options.trigger || 'manual';
  const localDate = options.dateOverride
    ? parseIsoDateParts(options.dateOverride)
    : getLocalDateParts(startedAt, BIRTHDAY_REMINDER_TIME_ZONE);

  const result = {
    ok: true,
    trigger,
    startedAt: startedAtIso,
    finishedAt: null,
    localDate: localDate.ymd,
    localHour: localDate.hour,
    timeZone: BIRTHDAY_REMINDER_TIME_ZONE,
    reminderHour: BIRTHDAY_REMINDER_HOUR,
    dueEvents: [],
    skippedAlreadySent: [],
    skippedReason: '',
    messagePreview: '',
    notification: {
      attempted: false,
      sent: false,
      error: null,
    },
  };

  if (trigger === 'scheduled' && localDate.hour !== BIRTHDAY_REMINDER_HOUR) {
    result.skippedReason = `outside ${BIRTHDAY_REMINDER_TIME_ZONE} ${String(BIRTHDAY_REMINDER_HOUR).padStart(2, '0')}:00 reminder hour`;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const allEvents = [
    ...collectBirthdayReminderEvents(BIRTHDAY_EVENTS, localDate, 'today'),
    ...collectBirthdayReminderEvents(BIRTHDAY_EVENTS, addCalendarDays(localDate, 1), 'tomorrow'),
  ];

  if (allEvents.length === 0) {
    result.skippedReason = 'no birthdays or anniversaries today or tomorrow';
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const store = await loadBirthdayReminderStore(env);
  const force = options.force === true;
  const dueEvents = allEvents.filter((event) => force || !store.reminders[event.key]);

  result.dueEvents = dueEvents.map(publicBirthdayReminderEvent);
  result.skippedAlreadySent = allEvents
    .filter((event) => !force && store.reminders[event.key])
    .map(publicBirthdayReminderEvent);

  if (dueEvents.length === 0) {
    result.skippedReason = 'matching reminders have already been sent';
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const message = formatBirthdayReminderMessage(dueEvents);
  result.messagePreview = message;

  if (options.notify !== false) {
    result.notification.attempted = true;
    try {
      await sendTelegramMessage(env, message);
      result.notification.sent = true;
    } catch (error) {
      result.ok = false;
      result.notification.error = errorMessage(error);
      console.error('Birthday reminder Telegram notification failed', error);
    }
  }

  if (result.notification.sent) {
    const nowIso = new Date().toISOString();
    for (const event of dueEvents) {
      store.reminders[event.key] = nowIso;
    }
    await saveBirthdayReminderStore(env, {
      version: 1,
      updatedAt: nowIso,
      reminders: store.reminders,
    });
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

async function handleTelegramWebhook(request, env) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = request.headers.get('x-telegram-bot-api-secret-token');
    if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return { ok: false, ignored: true, reason: 'invalid webhook secret' };
    }
  }

  const update = await request.json().catch(() => null);
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chatId = message?.chat?.id;

  if (!message || !text || !chatId) {
    return { ok: true, ignored: true, reason: 'no text message' };
  }

  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
    return { ok: true, ignored: true, reason: 'chat is not allowed' };
  }

  const command = parseTelegramCommand(text);
  if (!command) {
    return { ok: true, ignored: true, reason: 'not a command' };
  }

  if (['birthdays', 'birthday', 'events', 'nextbirthdays', 'next_events', 'next3'].includes(command)) {
    const today = getLocalDateParts(new Date(), BIRTHDAY_REMINDER_TIME_ZONE);
    const reply = formatUpcomingBirthdayEventsMessage(BIRTHDAY_EVENTS, today, 3);
    await sendTelegramMessage(env, reply, {
      chatId,
      replyToMessageId: message.message_id,
    });
    return { ok: true, handled: true, command };
  }

  if (['start', 'help'].includes(command)) {
    await sendTelegramMessage(env, telegramHelpMessage(), {
      chatId,
      replyToMessageId: message.message_id,
    });
    return { ok: true, handled: true, command };
  }

  return { ok: true, ignored: true, reason: 'unknown command', command };
}

async function checkCompany(company) {
  try {
    const jobs = await fetchCompanyJobs(company);
    console.log(`${company.name}: ${jobs.length} jobs found`);
    return { ok: true, company: company.name, jobs };
  } catch (error) {
    const failure = {
      company: company.name,
      parserType: company.parserType,
      url: company.url,
      error: errorMessage(error),
    };
    console.error(`${company.name}: ${failure.error}`);
    return { ok: false, failure };
  }
}

function pickLatestJob(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  return jobs
    .map((job, index) => ({ job, index, timestamp: timestampFromDate(job.postedAt) }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return a.index - b.index;
    })[0].job;
}

async function loadSeenStore(env) {
  assertKvBinding(env);

  const raw = await env.SEEN_JOBS.get(SEEN_KV_KEY);
  if (!raw) return { version: 1, jobs: {} };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`KV key ${SEEN_KV_KEY} does not contain valid JSON`);
  }

  if (parsed?.jobs && typeof parsed.jobs === 'object' && !Array.isArray(parsed.jobs)) {
    return { version: parsed.version || 1, jobs: parsed.jobs };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { version: 1, jobs: parsed };
  }

  throw new Error(`KV key ${SEEN_KV_KEY} has an unsupported shape`);
}

async function saveSeenStore(env, seenStore) {
  assertKvBinding(env);
  await env.SEEN_JOBS.put(SEEN_KV_KEY, JSON.stringify(seenStore));
}

async function loadBirthdayReminderStore(env) {
  assertKvBinding(env);

  const raw = await env.SEEN_JOBS.get(BIRTHDAY_REMINDER_KV_KEY);
  if (!raw) return { version: 1, reminders: {} };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`KV key ${BIRTHDAY_REMINDER_KV_KEY} does not contain valid JSON`);
  }

  if (parsed?.reminders && typeof parsed.reminders === 'object' && !Array.isArray(parsed.reminders)) {
    return { version: parsed.version || 1, reminders: parsed.reminders };
  }

  throw new Error(`KV key ${BIRTHDAY_REMINDER_KV_KEY} has an unsupported shape`);
}

async function saveBirthdayReminderStore(env, birthdayReminderStore) {
  assertKvBinding(env);
  await env.SEEN_JOBS.put(BIRTHDAY_REMINDER_KV_KEY, JSON.stringify(birthdayReminderStore));
}

function assertKvBinding(env) {
  if (!env.SEEN_JOBS) {
    throw new Error('KV binding SEEN_JOBS is missing. Check wrangler.jsonc.');
  }
}

async function sendTelegramMessage(env, text, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  const chatId = options.chatId || env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID is not set');
  }

  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (options.replyToMessageId) {
    body.reply_parameters = { message_id: options.replyToMessageId };
  }

  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0, 200)}`);
  }
}

function formatTelegramRunMessages(run) {
  const count = run.newLondonJobs.length;
  const allCompaniesFailed = run.checkedCompanies > 0 && run.failures.length >= run.checkedCompanies;

  if (count === 0 && !allCompaniesFailed) return [];

  const header = count > 0
    ? `${count} new London jobs found`
    : `All ${run.checkedCompanies} enabled company checks failed`;
  const blocks = [];

  if (count > 0) {
    for (const job of run.newLondonJobs) {
      blocks.push(`${job.company} - ${job.title}\n${job.location}\n${job.url}`);
    }
  }

  if (run.failures.length > 0) {
    const failedCompanies = run.failures.map((failure) => failure.company);
    const prefix = allCompaniesFailed && count === 0
      ? 'Failed companies'
      : `Warning: ${run.failures.length} compan${run.failures.length === 1 ? 'y' : 'ies'} failed`;
    blocks.push(`${prefix}: ${failedCompanies.join(', ')}`);
  }

  return chunkTelegramBlocks(header, blocks);
}

function formatUpcomingBirthdayEventsMessage(events, today, limit) {
  const upcomingEvents = getUpcomingBirthdayEvents(events, today, limit);
  const lines = ['Next birthdays/events'];

  for (const [index, event] of upcomingEvents.entries()) {
    lines.push(`${index + 1}. ${event.label} - ${formatUpcomingDate(event.date, today)} (${formatDaysUntil(event.daysUntil)})`);
  }

  return lines.join('\n');
}

function getUpcomingBirthdayEvents(events, today, limit) {
  return events
    .map((event, index) => {
      const normalized = normalizeBirthdayEvent(event);
      const dateParts = nextOccurrenceDateParts(normalized, today);
      return {
        index,
        label: birthdayEventLabel(normalized),
        date: dateParts,
        daysUntil: calendarDayDiff(today, dateParts),
      };
    })
    .sort((a, b) => a.daysUntil - b.daysUntil || a.index - b.index)
    .slice(0, limit);
}

function nextOccurrenceDateParts(event, today) {
  let year = today.year;
  let candidate = makeDateParts(year, event.month, event.day, today.hour);
  if (calendarDayDiff(today, candidate) < 0) {
    year += 1;
    candidate = makeDateParts(year, event.month, event.day, today.hour);
  }
  return candidate;
}

function calendarDayDiff(fromDate, toDate) {
  const from = Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day);
  const to = Date.UTC(toDate.year, toDate.month - 1, toDate.day);
  return Math.round((to - from) / DAY_MS);
}

function formatUpcomingDate(dateParts, today) {
  const suffix = dateParts.year === today.year ? '' : ` ${dateParts.year}`;
  return `${formatShortDate(dateParts)}${suffix}`;
}

function formatDaysUntil(daysUntil) {
  if (daysUntil === 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  return `in ${daysUntil} days`;
}

function parseTelegramCommand(text) {
  if (!text.startsWith('/')) return '';
  const firstToken = text.split(/\s+/)[0];
  return firstToken.slice(1).split('@')[0].toLowerCase();
}

function telegramHelpMessage() {
  return [
    'Commands',
    '/birthdays - show the next 3 birthdays/events',
    '/events - show the next 3 birthdays/events',
  ].join('\n');
}

function collectBirthdayReminderEvents(events, targetDate, timing) {
  return events
    .map((event) => normalizeBirthdayEvent(event))
    .filter((event) => event.month === targetDate.month && event.day === targetDate.day)
    .map((event) => ({
      key: `${targetDate.ymd}:${timing}:${event.name}:${event.date}`,
      timing,
      targetDate: targetDate.ymd,
      shortDate: formatShortDate(targetDate),
      label: birthdayEventLabel(event),
    }));
}

function normalizeBirthdayEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Birthday event entries must be objects');
  }

  const name = String(event.name || '').trim();
  if (!name) {
    throw new Error('Birthday event is missing a name');
  }

  const { month, day } = parseBirthdayDate(event.date, name);
  return {
    name,
    date: String(event.date).trim(),
    month,
    day,
    kind: String(event.kind || 'birthday').trim().toLowerCase() || 'birthday',
    label: String(event.label || '').trim(),
  };
}

function parseBirthdayDate(value, name) {
  const dateText = String(value || '').trim();
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(dateText);
  if (!match) {
    throw new Error(`${name}: birthday date must use DD/MM format`);
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const parsedDate = new Date(Date.UTC(2000, month - 1, day, 12));
  if (
    !Number.isInteger(day)
    || !Number.isInteger(month)
    || parsedDate.getUTCMonth() + 1 !== month
    || parsedDate.getUTCDate() !== day
  ) {
    throw new Error(`${name}: invalid birthday date ${dateText}`);
  }

  return { month, day };
}

function birthdayEventLabel(event) {
  if (event.label) return event.label;
  if (event.kind === 'birthday') return `${event.name}'s birthday`;
  return `${event.name} ${event.kind}`;
}

function formatBirthdayReminderMessage(events) {
  const todayEvents = events.filter((event) => event.timing === 'today');
  const tomorrowEvents = events.filter((event) => event.timing === 'tomorrow');
  const lines = ['Birthday reminders'];

  if (todayEvents.length > 0) {
    lines.push(`Today (${todayEvents[0].shortDate}): ${joinLabels(todayEvents)}`);
  }

  if (tomorrowEvents.length > 0) {
    lines.push(`Tomorrow (${tomorrowEvents[0].shortDate}): ${joinLabels(tomorrowEvents)}`);
  }

  return lines.join('\n');
}

function joinLabels(events) {
  const labels = events.map((event) => event.label);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function publicBirthdayReminderEvent(event) {
  return {
    timing: event.timing,
    targetDate: event.targetDate,
    label: event.label,
  };
}

function getLocalDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return makeDateParts(Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour));
}

function parseIsoDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    throw new Error('date must use YYYY-MM-DD format');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsedDate = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsedDate.getUTCFullYear() !== year
    || parsedDate.getUTCMonth() + 1 !== month
    || parsedDate.getUTCDate() !== day
  ) {
    throw new Error(`invalid date ${value}`);
  }

  return makeDateParts(year, month, day, BIRTHDAY_REMINDER_HOUR);
}

function addCalendarDays(dateParts, days) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days, 12));
  return makeDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), dateParts.hour);
}

function makeDateParts(year, month, day, hour = 0) {
  return {
    year,
    month,
    day,
    hour,
    ymd: [
      String(year).padStart(4, '0'),
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0'),
    ].join('-'),
  };
}

function formatShortDate(dateParts) {
  return `${dateParts.day} ${MONTH_LABELS[dateParts.month - 1]}`;
}

function formatLatestJobsTestMessages(result) {
  const blocks = result.latestJobs.map((job) => {
    const lines = [
      `${job.company} - ${job.title}`,
      job.location,
    ];

    if (job.postedAt) {
      lines.push(`Posted: ${formatDateForMessage(job.postedAt)}`);
    }

    lines.push(job.url);
    return lines.join('\n');
  });

  if (result.noJobs.length > 0) {
    blocks.push(`No parsed London jobs: ${result.noJobs.join(', ')}`);
  }

  if (result.failures.length > 0) {
    blocks.push(`Failed companies: ${result.failures.map((failure) => failure.company).join(', ')}`);
  }

  const summaryLines = [
    'Latest job listing test',
    `${result.latestJobs.length} companies with parsed London jobs`,
    `${result.checkedCompanies} checked, ${result.disabledCompanies} disabled skipped`,
  ];

  return chunkTelegramBlocks(summaryLines.join('\n'), blocks);
}

function chunkTelegramBlocks(header, blocks) {
  const chunks = [];
  let current = [];

  for (const block of blocks) {
    const candidateBlocks = [...current, block];
    const candidate = `${header}\n\n${candidateBlocks.join('\n\n')}`;

    if (candidate.length > MAX_TELEGRAM_MESSAGE_LENGTH && current.length > 0) {
      chunks.push(current);
      current = [block];
    } else {
      current = candidateBlocks;
    }
  }

  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) return [header];

  return chunks.map((chunk, index) => {
    const chunkHeader = chunks.length > 1 ? `${header}\nPart ${index + 1}/${chunks.length}` : header;
    return `${chunkHeader}\n\n${chunk.join('\n\n')}`;
  });
}

function summarizeRun(run) {
  return {
    ok: run.ok,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    checkedCompanies: run.checkedCompanies,
    totalEnabledCompanies: run.totalEnabledCompanies,
    disabledCompanies: run.disabledCompanies,
    companyShard: run.companyShard,
    saveSeen: run.saveSeen,
    totalJobsFound: run.totalJobsFound,
    londonJobsFound: run.londonJobsFound,
    firstSeenJobs: run.firstSeenJobs,
    skippedLondonAlertsCount: run.skippedLondonAlerts.length,
    skippedLondonAlerts: run.skippedLondonAlerts.slice(0, 25),
    newLondonJobsCount: run.newLondonJobs.length,
    newLondonJobs: run.newLondonJobs,
    failures: run.failures,
    notification: run.notification,
    kvKey: SEEN_KV_KEY,
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init.headers,
    },
  });
}

function textResponse(text, init = {}) {
  return new Response(text, {
    ...init,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...init.headers,
    },
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...init.headers,
    },
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
  })[character]);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const item = String(value || '').trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}

function formatPublicDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BIRTHDAY_REMINDER_TIME_ZONE,
    timeZoneName: 'short',
  }).format(date);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error) {
  return String(error?.message || error || 'Unknown error');
}

function timestampFromDate(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDateForMessage(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function scheduledCompanyShard(scheduledTime) {
  const timestamp = Number(scheduledTime) || Date.now();
  const scheduledDate = new Date(timestamp);
  const utcHour = scheduledDate.getUTCHours();
  return utcHour % SCHEDULED_COMPANY_SHARDS;
}

function parseShardSearchParams(searchParams) {
  const shardValue = searchParams.get('shard');
  const shardsValue = searchParams.get('shards');

  if (shardValue == null && shardsValue == null) return {};

  const companyShards = shardsValue == null ? SCHEDULED_COMPANY_SHARDS : Number(shardsValue);
  const companyShard = Number(shardValue);
  const normalized = normalizeCompanyShard(companyShard, companyShards);
  if (!normalized) {
    throw new Error('shard and shards must be integers where 0 <= shard < shards');
  }

  return {
    companyShard: normalized.index,
    companyShards: normalized.total,
  };
}

function normalizeCompanyShard(companyShard, companyShards) {
  if (companyShard == null && companyShards == null) return null;

  const total = Number(companyShards || SCHEDULED_COMPANY_SHARDS);
  const index = Number(companyShard);

  if (
    !Number.isInteger(total)
    || !Number.isInteger(index)
    || total < 1
    || index < 0
    || index >= total
  ) {
    return null;
  }

  return { index, total };
}

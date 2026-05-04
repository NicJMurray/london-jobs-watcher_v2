import { COMPANIES } from './companies.js';
import { fetchCompanyJobs, isLondonJob } from './parsers.js';

const SEEN_KV_KEY = 'seen-jobs-v1';
const MAX_DEBUG_JOBS = 100;
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const COMPANY_FETCH_CONCURRENCY = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return textResponse('OK');
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/test-telegram') {
        const message = `london-jobs-watcher test message\n${new Date().toISOString()}`;
        await sendTelegramMessage(env, message);
        return jsonResponse({ ok: true, sent: true });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/test-latest-jobs') {
        const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
        const result = await runLatestJobsTest(env, { includeDisabled });
        const status = result.notification?.error ? 502 : 200;
        return jsonResponse(result, { status });
      }

      if (['GET', 'POST'].includes(request.method) && url.pathname === '/run-now') {
        const shouldNotify = url.searchParams.get('notify') !== 'false';
        const result = await runWatcher(env, { trigger: 'manual', notify: shouldNotify });
        const status = result.notification?.error ? 502 : 200;
        return jsonResponse(summarizeRun(result), { status });
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
    ctx.waitUntil(
      runWatcher(env, { trigger: 'scheduled', notify: true }).catch((error) => {
        console.error('Scheduled run failed', error);
      }),
    );
  },
};

async function runWatcher(env, options = {}) {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const seenStore = await loadSeenStore(env);
  const seenJobs = seenStore.jobs;

  const enabledCompanies = COMPANIES.filter((company) => company.enabled);
  const disabledCompanies = COMPANIES.filter((company) => !company.enabled);

  const run = {
    ok: true,
    trigger: options.trigger || 'manual',
    startedAt: startedAtIso,
    finishedAt: null,
    checkedCompanies: enabledCompanies.length,
    disabledCompanies: disabledCompanies.length,
    totalJobsFound: 0,
    londonJobsFound: 0,
    firstSeenJobs: 0,
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
        url: job.url,
      };

      if (londonJob) {
        run.newLondonJobs.push({
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
    run.notification.attempted = true;
    try {
      await sendTelegramMessage(env, formatTelegramRunMessage(run));
      run.notification.sent = true;
    } catch (error) {
      run.notification.error = errorMessage(error);
      console.error('Telegram notification failed', error);
    }
  }

  if (seenStoreChanged && (!shouldNotify || run.notification.sent)) {
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

async function runLatestJobsTest(env, options = {}) {
  const startedAt = new Date().toISOString();
  const companies = COMPANIES.filter((company) => options.includeDisabled || company.enabled);
  const disabledCompanies = COMPANIES.filter((company) => !company.enabled);
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
    disabledCompanies: options.includeDisabled ? 0 : disabledCompanies.length,
    latestJobsCount: latestJobs.length,
    noJobs,
    failures,
    notification,
    latestJobs,
  };
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

function assertKvBinding(env) {
  if (!env.SEEN_JOBS) {
    throw new Error('KV binding SEEN_JOBS is missing. Check wrangler.jsonc.');
  }
}

async function sendTelegramMessage(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error('TELEGRAM_CHAT_ID is not set');
  }

  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body.slice(0, 200)}`);
  }
}

function formatTelegramRunMessage(run) {
  const count = run.newLondonJobs.length;
  const lines = [count > 0 ? `${count} new London jobs found` : 'No new London listings found', ''];
  let omitted = 0;

  if (count > 0) {
    for (const job of run.newLondonJobs) {
      const block = `${job.company} — ${job.title}\n${job.location}\n${job.url}`;
      const candidate = [...lines, block, ''].join('\n');

      if (candidate.length > MAX_TELEGRAM_MESSAGE_LENGTH) {
        omitted += 1;
        continue;
      }

      lines.push(block, '');
    }
  }

  if (omitted > 0) {
    lines.push(`${omitted} more job${omitted === 1 ? '' : 's'} omitted from this message.`, '');
  }

  if (run.failures.length > 0) {
    const failedCompanies = run.failures.map((failure) => failure.company);
    lines.push(
      `Warning: ${run.failures.length} compan${run.failures.length === 1 ? 'y' : 'ies'} failed: ${failedCompanies.join(', ')}`,
    );
  }

  return lines.join('\n').trim();
}

function formatLatestJobsTestMessages(result) {
  const blocks = result.latestJobs.map((job) => {
    const lines = [
      `${job.company} — ${job.title}`,
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
    disabledCompanies: run.disabledCompanies,
    totalJobsFound: run.totalJobsFound,
    londonJobsFound: run.londonJobsFound,
    firstSeenJobs: run.firstSeenJobs,
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

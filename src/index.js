import { BIRTHDAY_EVENTS } from './birthdays.js';
import { COMPANIES } from './companies.js';
import { fetchCompanyJobs, isLondonJob, verifyJobIsOpenForAlert } from './parsers.js';

const SEEN_KV_KEY = 'seen-jobs-v1';
const BIRTHDAY_REMINDER_KV_KEY = 'birthday-reminders-v1';
const BIRTHDAY_REMINDER_TIME_ZONE = 'Europe/London';
const BIRTHDAY_REMINDER_HOUR = 8;
const MAX_DEBUG_JOBS = 100;
const MAX_TELEGRAM_MESSAGE_LENGTH = 3900;
const COMPANY_FETCH_CONCURRENCY = 6;
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
    ctx.waitUntil(runScheduledTasks(env));
  },
};

async function runScheduledTasks(env) {
  await Promise.all([
    runWatcher(env, { trigger: 'scheduled', notify: true }).catch((error) => {
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
        url: job.url,
        postedAt: job.postedAt || '',
        closingAt: job.closingAt || '',
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
    const message = formatTelegramRunMessage(run);
    if (message) {
      run.notification.attempted = true;
      try {
        await sendTelegramMessage(env, message);
        run.notification.sent = true;
      } catch (error) {
        run.notification.error = errorMessage(error);
        console.error('Telegram notification failed', error);
      }
    }
  }

  const notificationFailed = run.notification.attempted && !run.notification.sent && run.notification.error;

  if (seenStoreChanged && !notificationFailed) {
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

function formatTelegramRunMessage(run) {
  const count = run.newLondonJobs.length;
  const allCompaniesFailed = run.checkedCompanies > 0 && run.failures.length >= run.checkedCompanies;

  if (count === 0 && !allCompaniesFailed) return '';

  const lines = count > 0
    ? [`${count} new London jobs found`, '']
    : [`All ${run.checkedCompanies} enabled company checks failed`, ''];
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
    const prefix = allCompaniesFailed && count === 0
      ? 'Failed companies'
      : `Warning: ${run.failures.length} compan${run.failures.length === 1 ? 'y' : 'ies'} failed`;
    lines.push(`${prefix}: ${failedCompanies.join(', ')}`);
  }

  return lines.join('\n').trim();
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

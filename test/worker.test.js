import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const url = 'https://scraper.njmurray.com';
const noKv = { get() { throw new Error('Unexpected KV read'); }, put() { throw new Error('Unexpected KV write'); } };

test('company diagnostics work without KV or Telegram and return useful counts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ total: 0, jobPostings: [] }));
  const response = await worker.fetch(new Request(`${url}/check?company=fujifilm`), { SEEN_JOBS: noKv });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, company: 'Fujifilm', totalJobs: 0, londonJobs: 0, sample: [] });
});

test('company diagnostics distinguish source failure from zero vacancies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Gone', { status: 404 }));
  const response = await worker.fetch(new Request(`${url}/check?company=revolut`), {});
  assert.equal(response.status, 502);
  assert.match((await response.json()).failure.error, /HTTP 404/);
});

test('company list and invalid-company requests do not fetch upstream', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected source fetch'); });
  const listing = await worker.fetch(new Request(`${url}/check`), {});
  const { companies } = await listing.json();
  assert.equal(companies.filter((entry) => entry.enabled).length, 28);
  assert.equal(companies.find((entry) => entry.slug === 'revolut').enabled, false);
  const missing = await worker.fetch(new Request(`${url}/check?company=bbc`), {});
  assert.equal(missing.status, 400);
});

test('manual GET is read-only by default and preserves discovery history', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (sourceUrl) => {
    assert.ok(!sourceUrl.includes('api.telegram.org'));
    return Response.json({ result: [{ id: 'already-seen', text: 'Engineer', locations: [{ location: 'London' }] }] });
  });
  const env = { SEEN_JOBS: {
    async get() { reads += 1; return JSON.stringify({ version: 1, jobs: {} }); },
    put: noKv.put,
  } };
  const response = await worker.fetch(new Request(`${url}/run-now?shard=0&shards=29`), env);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(result.newLondonJobsCount, 1);
  assert.equal(result.saveSeen, false);
  assert.equal(result.notification.attempted, false);
});

test('public requests cannot turn on notification or KV writes', async () => {
  for (const path of ['/run-now?notify=true', '/run-now?save=true', '/run-birthday-reminders?notify=true']) {
    for (const method of ['GET', 'POST']) {
      const response = await worker.fetch(new Request(url + path, { method }), { SEEN_JOBS: noKv });
      assert.equal(response.status, 401);
    }
  }
});

test('routine runs skip Revolut and the three removed companies', async (t) => {
  const sources = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (sourceUrl) => {
    sources.push(sourceUrl);
    return new Response('Unavailable', { status: 403 });
  });
  const response = await worker.fetch(new Request(`${url}/run-now`), {
    SEEN_JOBS: { async get() { return JSON.stringify({ version: 1, jobs: {} }); }, put: noKv.put },
  });
  const result = await response.json();
  assert.equal(result.checkedCompanies, 28);
  assert.equal(sources.length, 28);
  assert.ok(sources.every((source) => !/revolut|bbc|adidas|decathlon|jina\.ai/i.test(source)));
});

test('failed Telegram delivery leaves new jobs eligible for retry', async (t) => {
  const secret = 'local-test-secret';
  let telegramCalls = 0;
  t.mock.method(globalThis, 'fetch', async (sourceUrl) => {
    if (sourceUrl.startsWith('https://api.telegram.org/')) {
      telegramCalls += 1;
      return new Response('Unavailable', { status: 503 });
    }
    return Response.json({ result: [{ id: 'new', text: 'Engineer', locations: [{ location: 'London' }] }] });
  });
  const env = {
    TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_TOKEN: 'local-test-token', TELEGRAM_CHAT_ID: 'local-test-chat',
    SEEN_JOBS: { async get() { return JSON.stringify({ version: 1, jobs: {} }); }, put: noKv.put },
  };
  const response = await worker.fetch(new Request(`${url}/run-now?notify=true&save=true&shard=0&shards=29`, {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
  }), env);
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.newLondonJobsCount, 1);
  assert.equal(telegramCalls, 1);
  assert.equal(result.notification.sent, false);
});

test('removed companies are hidden while paused-company history is preserved', async () => {
  const base = { title: 'Engineer', location: 'London', firstSeenAt: new Date().toISOString(), london: true, url: 'https://example.com/job/1' };
  const jobs = {
    'bbc::1': { ...base, company: 'BBC' }, 'spotify::1': { ...base, company: 'Spotify' },
    'revolut::1': { ...base, company: 'Revolut' },
  };
  const response = await worker.fetch(new Request(`${url}/scraper.json`), {
    SEEN_JOBS: { async get() { return JSON.stringify({ version: 1, jobs }); }, put: noKv.put },
  });
  const result = await response.json();
  assert.deepEqual(result.jobs.map((job) => job.company), ['Revolut', 'Spotify']);
  assert.equal(Object.keys(jobs).length, 3);
});

test('old notification test routes are gone and webhook authentication fails closed', async () => {
  for (const path of ['/test-telegram', '/test-latest-jobs']) {
    assert.equal((await worker.fetch(new Request(url + path), {})).status, 404);
  }
  const response = await worker.fetch(new Request(`${url}/telegram-webhook`, { method: 'POST', body: '{}' }), {});
  assert.equal((await response.json()).reason, 'invalid webhook secret');
});

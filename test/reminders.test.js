import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { BIRTHDAY_EVENTS } from '../src/birthdays.js';

const baseUrl = 'https://scraper.njmurray.com/run-birthday-reminders';
const kvKey = 'birthday-reminders-v1';

function useEvents(t) {
  const original = [...BIRTHDAY_EVENTS];
  BIRTHDAY_EVENTS.splice(0, BIRTHDAY_EVENTS.length,
    { name: 'Today event', date: '27/12' },
    { name: 'Tomorrow event', date: '28/12', kind: 'anniversary' },
    { name: 'Week event', date: '03/01' });
  t.after(() => BIRTHDAY_EVENTS.splice(0, BIRTHDAY_EVENTS.length, ...original));
}

test('seven-day preview crosses the year boundary and preserves existing reminder keys', async (t) => {
  useEvents(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Preview must not send messages'); });
  const env = { SEEN_JOBS: {
    async get(key) {
      assert.equal(key, kvKey);
      return JSON.stringify({ version: 1, reminders: {
        '2026-12-27:today:Today event:27/12': 'already sent',
        '2026-12-28:tomorrow:Tomorrow event:28/12': 'already sent',
      } });
    },
    put() { throw new Error('Preview must not write state'); },
  } };
  const response = await worker.fetch(new Request(`${baseUrl}?date=2026-12-27`), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.dueEvents, [{ timing: 'week', targetDate: '2027-01-03', label: "Week event's birthday" }]);
  assert.equal(result.skippedAlreadySent.length, 2);
  assert.match(result.messagePreview, /In one week \(3 Jan\): Week event's birthday/);
  assert.equal(result.notification.attempted, false);
});

test('week-ahead delivery is deduplicated independently of tomorrow and today', async (t) => {
  useEvents(t);
  const secret = 'local-test-secret';
  const messages = [];
  let store = { version: 1, reminders: {} };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(url.startsWith('https://api.telegram.org/'));
    messages.push(JSON.parse(init.body).text);
    return Response.json({ ok: true });
  });
  const env = {
    TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_TOKEN: 'local-test-token', TELEGRAM_CHAT_ID: 'local-test-chat',
    SEEN_JOBS: {
      async get(key) { assert.equal(key, kvKey); return JSON.stringify(store); },
      async put(key, value) { assert.equal(key, kvKey); store = JSON.parse(value); },
    },
  };
  async function send(date) {
    const response = await worker.fetch(new Request(`${baseUrl}?notify=true&date=${date}`, {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
    }), env);
    assert.equal(response.status, 200);
    return response.json();
  }
  await send('2026-12-27');
  assert.ok(store.reminders['2027-01-03:week:Week event:03/01']);
  assert.match(messages[0], /Today \(27 Dec\)/);
  assert.match(messages[0], /Tomorrow \(28 Dec\)/);
  assert.match(messages[0], /In one week \(3 Jan\)/);
  assert.equal((await send('2026-12-27')).notification.attempted, false);
  assert.equal(messages.length, 1);
  assert.equal((await send('2027-01-02')).notification.sent, true);
  assert.ok(store.reminders['2027-01-03:tomorrow:Week event:03/01']);
  assert.equal((await send('2027-01-03')).notification.sent, true);
  assert.ok(store.reminders['2027-01-03:today:Week event:03/01']);
  assert.equal(messages.length, 3);
});

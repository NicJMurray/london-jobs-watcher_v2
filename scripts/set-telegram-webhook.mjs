import { readFileSync } from 'node:fs';

const env = readDotEnv('.dev.vars');
const token = env.TELEGRAM_BOT_TOKEN;
const workerBaseUrl = process.argv[2]?.replace(/\/+$/, '');
const secret = env.TELEGRAM_WEBHOOK_SECRET;

if (!token || token.includes('replace_me') || token.includes('PASTE_')) {
  console.error('Paste your Telegram bot token into .dev.vars first.');
  process.exit(1);
}

if (!workerBaseUrl) {
  console.error('Usage: npm run telegram:webhook -- https://your-worker-url');
  process.exit(1);
}

const webhookUrl = `${workerBaseUrl}/telegram-webhook`;

await callTelegramApi('setMyCommands', {
  commands: [
    { command: 'birthdays', description: 'Show the next 3 birthdays/events' },
    { command: 'events', description: 'Show the next 3 birthdays/events' },
  ],
});

await callTelegramApi('setWebhook', {
  url: webhookUrl,
  allowed_updates: ['message'],
  ...(secret ? { secret_token: secret } : {}),
});

console.log(`Telegram webhook set to ${webhookUrl}`);
if (!secret) {
  console.log('No TELEGRAM_WEBHOOK_SECRET was found in .dev.vars, so Telegram secret-token checking is disabled.');
}

async function callTelegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    console.error(`Telegram ${method} failed (${response.status}).`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
}

function readDotEnv(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`${path} does not exist. Create it first.`);
    process.exit(1);
  }

  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }

  return values;
}

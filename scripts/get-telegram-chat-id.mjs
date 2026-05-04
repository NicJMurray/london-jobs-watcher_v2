import { readFileSync } from 'node:fs';

const env = readDotEnv('.dev.vars');
const token = env.TELEGRAM_BOT_TOKEN;

if (!token || token.includes('replace_me') || token.includes('PASTE_')) {
  console.error('Paste your Telegram bot token into .dev.vars first.');
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await response.json().catch(() => null);

if (!response.ok || !data?.ok) {
  console.error(`Telegram getUpdates failed (${response.status}).`);
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

const chats = new Map();
for (const update of data.result || []) {
  const chat = update.message?.chat || update.channel_post?.chat || update.my_chat_member?.chat;
  if (!chat?.id) continue;

  chats.set(chat.id, {
    id: chat.id,
    type: chat.type,
    title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '',
  });
}

if (chats.size === 0) {
  console.log('No chats found yet.');
  console.log('Send any message to your bot in Telegram, then run this command again:');
  console.log('npm run telegram:chat-id');
  process.exit(0);
}

console.log('Found Telegram chat IDs:');
for (const chat of chats.values()) {
  console.log(`${chat.id}${chat.title ? `  ${chat.title}` : ''}${chat.type ? `  (${chat.type})` : ''}`);
}

console.log('\nPaste the ID you want into .dev.vars as TELEGRAM_CHAT_ID.');

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

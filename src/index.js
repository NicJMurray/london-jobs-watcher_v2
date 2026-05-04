const CHAT_ID_KEY = 'config:chat_id';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event, env) {
    await runJobsCheck(env);
  },
};

async function handleWebhook(request, env) {
  let update;

  try {
    update = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const message = update?.message;
  const text = message?.text || '';
  const chatId = message?.chat?.id;

  if (!chatId) {
    return new Response('OK', { status: 200 });
  }

  if (text.trim() !== '/jobs') {
    await sendTelegramMessage(env, chatId, 'Send /jobs to fetch London roles.');
    return new Response('OK', { status: 200 });
  }

  try {
    await env.JOBS_KV.put(CHAT_ID_KEY, String(chatId));
    await runJobsCheck(env, String(chatId));
    return new Response('OK', { status: 200 });
  } catch (error) {
    await sendTelegramMessage(env, chatId, `Error: ${String(error.message || error).slice(0, 180)}`);
    return new Response('OK', { status: 200 });
  }
}

async function runJobsCheck(env, explicitChatId) {
  if (!env.JOBS_URL) throw new Error('JOBS_URL is not set.');
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Bot token is missing.');
  if (!env.JOBS_KV) throw new Error('JOBS_KV binding is missing.');

  const chatId = explicitChatId || (await env.JOBS_KV.get(CHAT_ID_KEY));
  if (!chatId) return;

  const htmlResponse = await fetch(env.JOBS_URL);
  if (!htmlResponse.ok) {
    throw new Error(`Jobs page returned ${htmlResponse.status}.`);
  }

  const html = await htmlResponse.text();
  const matches = findLondonLinks(html, env.JOBS_URL);

  if (matches.length === 0) {
    await sendTelegramMessage(env, chatId, 'No London jobs found.');
    return;
  }

  const unseen = [];

  for (const match of matches) {
    const key = keyForUrl(match.url);
    const alreadySeen = await env.JOBS_KV.get(key);
    if (alreadySeen) continue;

    unseen.push(match);
    await env.JOBS_KV.put(key, '1');

    if (unseen.length >= 10) break;
  }

  if (unseen.length === 0) {
    await sendTelegramMessage(env, chatId, 'No new London jobs found.');
    return;
  }

  const lines = unseen.map((item, i) => `${i + 1}. ${item.text}\n${item.url}`);
  const reply = `New London jobs (${unseen.length}):\n\n${lines.join('\n\n')}`;
  await sendTelegramMessage(env, chatId, reply);
}

function findLondonLinks(html, baseUrl) {
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const results = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const anchorInner = stripHtml(match[2]).replace(/\s+/g, ' ').trim();

    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(html.length, linkRegex.lastIndex + 200);
    const context = stripHtml(html.slice(contextStart, contextEnd));

    if (!/london/i.test(context)) continue;

    let absolute;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (seen.has(absolute)) continue;
    seen.add(absolute);

    results.push({
      text: anchorInner || 'Job link',
      url: absolute,
    });
  }

  return results;
}

function keyForUrl(url) {
  return `seen:${url}`;
}

function stripHtml(input) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

async function sendTelegramMessage(env, chatId, text) {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed (${response.status}).`);
  }
}

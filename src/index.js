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
    if (!env.JOBS_URL) throw new Error('JOBS_URL is not set.');
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Bot token is missing.');

    const htmlResponse = await fetch(env.JOBS_URL);
    if (!htmlResponse.ok) {
      throw new Error(`Jobs page returned ${htmlResponse.status}.`);
    }

    const html = await htmlResponse.text();
    const matches = findLondonLinks(html, env.JOBS_URL).slice(0, 10);

    if (matches.length === 0) {
      await sendTelegramMessage(env, chatId, 'No London jobs found.');
      return new Response('OK', { status: 200 });
    }

    const lines = matches.map((item, i) => `${i + 1}. ${item.text}\n${item.url}`);
    const reply = `London jobs found (${matches.length}):\n\n${lines.join('\n\n')}`;
    await sendTelegramMessage(env, chatId, reply);

    return new Response('OK', { status: 200 });
  } catch (error) {
    await sendTelegramMessage(env, chatId, `Error: ${String(error.message || error).slice(0, 180)}`);
    return new Response('OK', { status: 200 });
  }
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

const REQUEST_TIMEOUT_MS = 45000;
const HTML_CONTEXT_CHARS = 500;

const LONDON_PATTERN = /\b(?:Greater\s+London|London|Hybrid\s+London)\b/i;
const NON_UK_LONDON_PATTERN = /\bLondon\s*,?\s*(?:ON|Ontario|Canada)\b/i;

export async function fetchCompanyJobs(company) {
  switch (company.parserType) {
    case 'greenhouse':
      return fetchGreenhouseJobs(company);
    case 'lever':
      return fetchLeverJobs(company);
    case 'ashby':
      return fetchAshbyJobs(company);
    case 'html':
      return fetchHtmlJobs(company);
    default:
      throw new Error(`Unsupported parser type: ${company.parserType}`);
  }
}

export function isLondonJob(job) {
  const titleAndLocation = normalizeWhitespace([job.title, job.location].filter(Boolean).join(' '));
  const supportingText = normalizeWhitespace([job.office, job.searchText].filter(Boolean).join(' '));
  const text = normalizeWhitespace([titleAndLocation, supportingText].filter(Boolean).join(' '));

  if (!LONDON_PATTERN.test(text)) return false;
  if (NON_UK_LONDON_PATTERN.test(text) && !/\b(?:UK|United Kingdom|England|Greater London)\b/i.test(text)) {
    return false;
  }

  if (LONDON_PATTERN.test(titleAndLocation)) return true;
  if (!job.location) return LONDON_PATTERN.test(supportingText);

  const remoteOrHybrid = /\b(?:remote|hybrid|multiple|various|anywhere)\b/i.test(job.location);
  const ukRemote = remoteOrHybrid && /\b(?:UK|United Kingdom|England)\b/i.test(text);
  return ukRemote && LONDON_PATTERN.test(supportingText);
}

async function fetchGreenhouseJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const offices = collectNames(job.offices);
    const location = normalizeWhitespace(job.location?.name || '');
    const office = normalizeWhitespace(offices.join(', '));

    return normalizeJob(company, {
      id: job.id || job.internal_job_id || job.absolute_url,
      title: job.title,
      location,
      office,
      url: job.absolute_url,
      postedAt: job.first_published || job.updated_at,
      searchText: [job.title, location, office].join(' '),
    });
  });
}

async function fetchLeverJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data) ? data : [];

  return jobs.map((job) => {
    const allLocations = Array.isArray(job.categories?.allLocations)
      ? job.categories.allLocations.join(', ')
      : '';
    const location = normalizeWhitespace(job.categories?.location || allLocations || '');
    const office = normalizeWhitespace(allLocations);

    return normalizeJob(company, {
      id: job.id || job.hostedUrl,
      title: job.text,
      location,
      office,
      url: job.hostedUrl || job.applyUrl,
      postedAt: normalizeLeverTimestamp(job.createdAt),
      searchText: [job.text, location, office, job.categories?.team, job.categories?.department].join(' '),
    });
  });
}

async function fetchAshbyJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((job) => {
    const secondaryLocations = Array.isArray(job.secondaryLocations)
      ? job.secondaryLocations.map((location) => location.location).filter(Boolean).join(', ')
      : '';
    const location = normalizeWhitespace([job.location, secondaryLocations].filter(Boolean).join(', '));
    const office = normalizeWhitespace([job.workplaceType, job.address?.postalAddress?.addressLocality].filter(Boolean).join(', '));

    return normalizeJob(company, {
      id: job.id || job.jobUrl || job.applyUrl,
      title: job.title,
      location,
      office,
      url: job.jobUrl || job.applyUrl,
      postedAt: job.publishedAt,
      searchText: [job.title, location, office].join(' '),
    });
  });
}

async function fetchHtmlJobs(company) {
  const html = await fetchText(company.url);
  const links = extractLinks(html, company.url);
  const jobs = [];
  const seenUrls = new Set();

  for (const link of links) {
    if (seenUrls.has(link.url)) continue;
    if (!isProbablyJobLink(link)) continue;

    seenUrls.add(link.url);
    jobs.push(
      normalizeJob(company, {
        id: link.url,
        title: titleFromHtmlLink(link),
        location: locationFromText(link.filterText),
        office: locationFromText(link.filterText),
        url: link.url,
        postedAt: '',
        searchText: link.filterText,
      }),
    );
  }

  return jobs;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const linkRegex = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = decodeHtml(match[2]);
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;

    const url = canonicalUrl(href, baseUrl);
    if (!url) continue;

    const text = stripHtml(match[3]);
    const contextStart = Math.max(0, match.index - HTML_CONTEXT_CHARS);
    const contextEnd = Math.min(html.length, linkRegex.lastIndex + HTML_CONTEXT_CHARS);
    const context = stripHtml(html.slice(contextStart, contextEnd));
    const searchText = normalizeWhitespace([text, context, url].join(' '));
    const filterText = normalizeWhitespace([text, url].join(' '));

    links.push({
      url,
      text: normalizeWhitespace(text),
      context: normalizeWhitespace(context),
      searchText,
      filterText,
    });
  }

  return links;
}

function isProbablyJobLink(link) {
  const blockedUtilityLink = /(?:privacy|cookie|terms|accessibility|locale=|\/content\/|\/blog\/|\/press\/|\/events?\/)/i.test(
    link.url,
  );
  if (blockedUtilityLink) return false;

  const jobDetailUrlSignal = /(?:\/job\/|\/jobs\/job\/|\/jobs\/results\/(?:jobs\/results\/)?\d|\/roles?\/[^/?#]+|\/positions?\/[^/?#]+|\/openings?\/[^/?#]+|\/requisition\/[^/?#]+|workdayjobs\.com\/.+\/job\/|job-boards\.[^/]+\/[^/]+\/jobs\/\d|[?&](?:gh_jid|jobId|jid|reqId)=|[_-](?:JR|R)\d{3,})/i.test(
    link.url,
  );
  const urlSignal = jobDetailUrlSignal;
  const textSignal = /\b(?:job|career|role|position|opening|vacanc(?:y|ies)|apply)\b/i.test(link.text);
  const londonSignal = LONDON_PATTERN.test(link.searchText);

  return urlSignal || (textSignal && londonSignal);
}

function titleFromHtmlLink(link) {
  if (link.text && !/^(?:apply|view|learn more|read more|details|job|jobs|careers?)$/i.test(link.text)) {
    return link.text;
  }

  const urlTitle = titleFromUrl(link.url);
  if (urlTitle) return urlTitle;

  const sentence = link.context
    .split(/(?<=[.!?])\s+|\s{2,}/)
    .map((part) => normalizeWhitespace(part))
    .find((part) => part && part.length >= 8 && part.length <= 140);

  return sentence || 'Job link';
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments.at(-1) || '';
    const titleSegment = /^\d+$/.test(lastSegment) ? segments.at(-2) || '' : lastSegment;
    const withoutExtension = titleSegment.replace(/\.[a-z0-9]+$/i, '');
    const withoutLeadingId = withoutExtension.replace(/^[a-z]*\d+[a-z0-9]*[-_]+/i, '');
    const decoded = decodeURIComponent(withoutLeadingId.replace(/\+/g, ' '));
    const words = decoded
      .split(/[-_,()\s]+/)
      .filter((word) => word && !/^\d+$/.test(word));

    if (words.length < 2) return '';

    return words
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return '';
  }
}

function locationFromText(text) {
  if (!LONDON_PATTERN.test(text)) return '';

  const match = text.match(/(?:Greater\s+London|Hybrid\s+London|London(?:,\s*(?:UK|United Kingdom|England))?)/i);
  return match ? match[0] : 'London';
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: 'application/json' },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON but received: ${text.slice(0, 160)}`);
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  return text;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeJob(company, job) {
  const url = canonicalUrl(job.url || company.careersUrl || company.url, company.url);
  const title = normalizeWhitespace(job.title || 'Untitled job');
  const location = normalizeWhitespace(job.location || '');
  const office = normalizeWhitespace(job.office || '');
  const identity = normalizeWhitespace(String(job.id || url || `${title}-${location}`));

  return {
    key: `${company.slug}::${identity}`,
    company: company.name,
    companySlug: company.slug,
    title,
    location,
    office,
    url,
    postedAt: normalizeDate(job.postedAt),
    parserType: company.parserType,
    searchText: normalizeWhitespace(job.searchText || [title, location, office].join(' ')),
  };
}

function normalizeLeverTimestamp(value) {
  if (!value) return '';
  if (typeof value === 'number') return normalizeDate(new Date(value).toISOString());
  return normalizeDate(value);
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function collectNames(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectNames(item));
  if (typeof value === 'object') {
    return [value.name, value.location?.name].filter(Boolean).map((item) => normalizeWhitespace(String(item)));
  }
  return [normalizeWhitespace(String(value))];
}

function canonicalUrl(input, baseUrl) {
  try {
    const url = new URL(input, baseUrl);
    url.hash = '';

    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === 'gh_src') {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return '';
  }
}

function stripHtml(input) {
  return decodeHtml(
    String(input || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function normalizeWhitespace(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

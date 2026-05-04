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
    case 'apple':
      return fetchAppleJobs(company);
    case 'spotify':
      return fetchSpotifyJobs(company);
    case 'successfactors':
      return fetchSuccessFactorsJobs(company);
    case 'workable':
      return fetchWorkableJobs(company);
    case 'jibe':
      return fetchJibeJobs(company);
    case 'eightfold-embedded':
      return fetchEightfoldEmbeddedJobs(company);
    case 'next-greenhouse':
      return fetchNextGreenhouseJobs(company);
    case 'html':
      return fetchHtmlJobs(company);
    default:
      throw new Error(`Unsupported parser type: ${company.parserType}`);
  }
}

async function fetchNextGreenhouseJobs(company) {
  const html = await fetchText(company.url);
  const data = extractNextData(html);
  const jobs = findGreenhouseJobArrays(data).flat();

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

async function fetchAppleJobs(company) {
  const jobs = [];
  const seenIds = new Set();
  const maxPages = company.maxPages || 10;
  let totalRecords = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const html = await fetchText(urlWithSearchParam(company.url, 'page', page === 1 ? '' : String(page)));
    const hydrationData = extractAppleHydrationData(html);
    const searchData = hydrationData?.loaderData?.search;
    const pageJobs = Array.isArray(searchData?.searchResults) ? searchData.searchResults : [];

    if (!pageJobs.length) {
      if (page === 1) return extractAppleHtmlJobs(company, html);
      break;
    }

    totalRecords = Number(searchData.totalRecords || totalRecords || 0);

    for (const job of pageJobs) {
      const id = normalizeWhitespace(String(job.reqId || job.id || job.positionId || ''));
      if (!id || seenIds.has(id)) continue;

      seenIds.add(id);
      jobs.push(mapAppleJob(company, job));
    }

    if (totalRecords > 0 && seenIds.size >= totalRecords) break;
  }

  return jobs;
}

function extractAppleHtmlJobs(company, html) {
  const itemRegex = /<div id="search-search-job-title-PIPE-([^"]+)"[\s\S]*?<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>[\s\S]*?<span class="job-posted-date"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span class="table--advanced-search__location-sub"[^>]*>([\s\S]*?)<\/span>/gi;
  const jobs = [];
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const id = normalizeWhitespace(match[1]);
    const url = canonicalUrl(match[2], company.url);
    const title = stripHtml(match[3]);
    const postedAt = normalizeAppleDate(stripHtml(match[4]));
    const location = stripHtml(match[5]);

    jobs.push(
      normalizeJob(company, {
        id: id || url,
        title,
        location,
        office: location,
        url,
        postedAt,
        searchText: [title, location].join(' '),
      }),
    );
  }

  return jobs;
}

function mapAppleJob(company, job) {
  const title = stripHtml(job.postingTitle);
  const location = normalizeWhitespace(
    arrayFrom(job.locations)
      .map((locationItem) => {
        if (!locationItem || typeof locationItem !== 'object') return '';
        return [locationItem.name, locationItem.city, locationItem.stateProvince, locationItem.countryName]
          .filter(Boolean)
          .join(', ');
      })
      .filter(Boolean)
      .join('; '),
  );
  const id = normalizeWhitespace(String(job.reqId || job.id || job.positionId || ''));
  const detailId = id.replace(/^PIPE-/i, '') || job.positionId || id;
  const detailSlug = job.transformedPostingTitle || slugify(title);
  const url = appleDetailUrl(company.url, detailId, detailSlug, job.team?.teamCode);
  const team = normalizeWhitespace(job.team?.teamName || '');

  return normalizeJob(company, {
    id: id || url,
    title,
    location,
    office: location,
    url,
    postedAt: job.postDateInGMT || job.postingDate,
    searchText: [title, location, team, job.jobSummary].join(' '),
  });
}

function extractAppleHydrationData(html) {
  const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:(?:\\.)|[^"\\])*")\)/);
  if (!match) return null;

  try {
    return JSON.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

async function fetchSpotifyJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data?.result) ? data.result : [];

  return jobs.map((job) => {
    const title = stripHtml(job.text);
    const locations = uniqueStrings(arrayFrom(job.locations).map((location) => location?.location).filter(Boolean));
    const location = normalizeWhitespace(locations.join(', '));
    const category = normalizeWhitespace(
      [job.main_category?.name, job.sub_category?.name, job.job_type?.name].filter(Boolean).join(', '),
    );
    const url = canonicalUrl(`${company.careersUrl || 'https://www.lifeatspotify.com/jobs'}/${job.id}`, company.url);

    return normalizeJob(company, {
      id: job.id || url,
      title,
      location,
      office: location,
      url,
      postedAt: '',
      searchText: [title, location, category].join(' '),
    });
  });
}

async function fetchSuccessFactorsJobs(company) {
  const locale = company.locale || 'en_GB';
  const locationQuery = company.locationQuery || 'London';
  const sortBy = company.sortBy || 'recent';
  const keywords = company.keywords || '';
  const maxPages = company.maxPages || 10;
  const passes = company.passes || 2;
  const jobs = [];
  const seenIds = new Set();
  let totalJobs = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const data = await postJson(company.url, {
        keywords,
        locale,
        location: locationQuery,
        pageNumber,
        sortBy,
      });
      const pageJobs = Array.isArray(data?.jobSearchResult)
        ? data.jobSearchResult.map((item) => item?.response || item).filter(Boolean)
        : [];

      if (!pageJobs.length) break;

      totalJobs = Number(data?.totalJobs || totalJobs || 0);

      for (const job of pageJobs) {
        const id = normalizeWhitespace(String(job.id || job.jobReqId || job.requisitionId || ''));
        if (!id || seenIds.has(id)) continue;

        seenIds.add(id);
        jobs.push(mapSuccessFactorsJob(company, job, locale));
      }

      if (totalJobs > 0 && seenIds.size >= totalJobs) break;
    }

    if (totalJobs > 0 && seenIds.size >= totalJobs) break;
  }

  return jobs;
}

async function fetchWorkableJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];
  const groupedJobs = new Map();

  for (const job of jobs) {
    const id = normalizeWhitespace(String(job.shortcode || job.id || job.url || job.shortlink || ''));
    if (!id) continue;

    const existing = groupedJobs.get(id);
    const location = workableLocation(job);

    if (existing) {
      if (location) existing.locations.add(location);
      continue;
    }

    groupedJobs.set(id, {
      job,
      locations: new Set(location ? [location] : []),
    });
  }

  return [...groupedJobs.values()].map(({ job, locations }) => {
    const title = stripHtml(job.title);
    const location = normalizeWhitespace([...locations].join('; '));
    const department = normalizeWhitespace([job.department, job.function, job.employment_type].filter(Boolean).join(', '));

    return normalizeJob(company, {
      id: job.shortcode || job.id || job.url || job.shortlink,
      title,
      location,
      office: location,
      url: job.url || job.shortlink || job.application_url,
      postedAt: job.published_on || job.created_at,
      searchText: [title, location, department].join(' '),
    });
  });
}

async function fetchJibeJobs(company) {
  const jobs = [];
  const seenIds = new Set();
  const limit = company.limit || 100;
  const maxPages = company.maxPages || 5;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = urlWithSearchParam(company.url, 'page', page === 1 ? '' : String(page));
    const data = await fetchJibeJson(url);
    const pageJobs = Array.isArray(data?.jobs) ? data.jobs : [];

    if (!pageJobs.length) break;

    for (const item of pageJobs) {
      const job = item?.data || item;
      const id = normalizeWhitespace(String(job.req_id || job.slug || job.id || job.apply_url || ''));
      if (!id || seenIds.has(id)) continue;

      seenIds.add(id);
      jobs.push(mapJibeJob(company, job));
    }

    if (Number(data?.totalCount || 0) <= seenIds.size || pageJobs.length < limit) break;
  }

  return jobs;
}

async function fetchJibeJson(url) {
  try {
    return await fetchJson(url);
  } catch (error) {
    if (!/HTTP 404|Expected JSON/i.test(errorMessage(error))) throw error;
    await delay(350);
    return fetchJson(url);
  }
}

async function fetchEightfoldEmbeddedJobs(company) {
  const html = await fetchText(company.url);
  const data = extractCodeJson(html, ['smartApplyData', 'pcs-data', 'pcsx-data']);
  const jobs = Array.isArray(data?.positions) ? data.positions : [];

  return jobs.map((job) => {
    const title = stripHtml(job.posting_name || job.name);
    const locations = uniqueStrings([job.location, ...arrayFrom(job.locations)].filter(Boolean));
    const location = normalizeWhitespace(locations.join('; '));
    const url = job.canonicalPositionUrl || canonicalUrl(`/careers/job/${job.id}`, company.url);
    const department = normalizeWhitespace(
      [job.department, job.business_unit, job.work_location_option].filter(Boolean).join(', '),
    );

    return normalizeJob(company, {
      id: job.ats_job_id || job.display_job_id || job.id_locale || job.id || url,
      title,
      location,
      office: location,
      url,
      postedAt: normalizeUnixTimestamp(job.t_create || job.t_update),
      searchText: [title, location, department].join(' '),
    });
  });
}

function mapSuccessFactorsJob(company, job, locale) {
  const title = stripHtml(job.unifiedStandardTitle || job.title || job.jobTitle);
  const location = normalizeWhitespace(
    uniqueStrings([
      ...arrayFrom(job.sfstd_jobLocation_obj).map(stripHtml),
      ...arrayFrom(job.jobLocationShort).map(stripHtml),
    ]).join(', '),
  );
  const department = uniqueStrings([...arrayFrom(job.filter2), ...arrayFrom(job.filter4)]).map(stripHtml).join(', ');
  const id = normalizeWhitespace(String(job.id || job.jobReqId || job.requisitionId || ''));
  const urlTitle = normalizeWhitespace(decodeHtml(job.urlTitle || job.unifiedUrlTitle || slugify(title)));
  const baseUrl = (company.careersUrl || new URL(company.url).origin).replace(/\/$/, '');
  const url = `${baseUrl}/job/${urlTitle}/${id}-${locale}/`;

  return normalizeJob(company, {
    id: id || url,
    title,
    location,
    office: location,
    url,
    postedAt: normalizeSuccessFactorsDate(job.unifiedStandardStart || job.postedDate),
    searchText: [title, location, department].join(' '),
  });
}

function extractCodeJson(html, ids) {
  for (const id of ids) {
    const pattern = new RegExp(`<code id="${escapeRegExp(id)}"[^>]*>([\\s\\S]*?)<\\/code>`);
    const match = html.match(pattern);
    if (!match) continue;

    try {
      return JSON.parse(decodeHtml(match[1]));
    } catch {
      return null;
    }
  }

  return null;
}

function workableLocation(job) {
  const locations = arrayFrom(job.locations)
    .map((location) => {
      if (!location || typeof location !== 'object') return '';
      return [location.city, location.region || location.state, location.country].filter(Boolean).join(', ');
    })
    .filter(Boolean);

  if (locations.length > 0) return uniqueStrings(locations).join('; ');

  return [job.city, job.state, job.country].filter(Boolean).join(', ');
}

function mapJibeJob(company, job) {
  const title = stripHtml(job.title);
  const location = normalizeWhitespace(
    job.full_location
      || job.short_location
      || [job.location_name, job.city, job.state, job.country].filter(Boolean).join(', '),
  );
  const tags = [
    ...collectNames(job.categories),
    ...collectNames(job.tags),
    ...arrayFrom(job.tags1),
    ...arrayFrom(job.tags2),
    ...arrayFrom(job.tags3),
    job.employment_type,
  ];
  const url = job.apply_url || canonicalUrl(`/jobs/${job.slug || job.req_id}`, company.url);

  return normalizeJob(company, {
    id: job.req_id || job.slug || url,
    title,
    location,
    office: location,
    url,
    postedAt: job.posted_date || job.create_date || job.update_date,
    searchText: [title, location, uniqueStrings(tags).join(', ')].join(' '),
  });
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

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    return JSON.parse(decodeHtml(match[1]));
  } catch {
    return null;
  }
}

function findGreenhouseJobArrays(value) {
  const found = [];
  const seen = new Set();

  function visit(item) {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);

    if (Array.isArray(item)) {
      if (item.some(isGreenhouseJobShape)) {
        found.push(item.filter(isGreenhouseJobShape));
      }
      for (const child of item) visit(child);
      return;
    }

    for (const child of Object.values(item)) {
      visit(child);
    }
  }

  visit(value);
  return found;
}

function isGreenhouseJobShape(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && value.absolute_url
      && value.title
      && (value.id || value.internal_job_id),
  );
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

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeAppleDate(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalizeDate(`${normalized} 00:00:00 GMT`);
}

function normalizeSuccessFactorsDate(value) {
  const normalized = normalizeWhitespace(value);
  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return normalizeDate(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`);
  return normalizeDate(normalized);
}

function normalizeUnixTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return normalizeDate(new Date(value * 1000).toISOString());
  }
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

function appleDetailUrl(searchUrl, id, slug, teamCode) {
  try {
    const parsed = new URL(searchUrl);
    const locale = parsed.pathname.split('/').filter(Boolean)[0] || 'en-us';
    const detailUrl = new URL(`/${locale}/details/${encodeURIComponent(id)}/${encodeURIComponent(slug)}`, parsed.origin);

    if (teamCode) detailUrl.searchParams.set('team', teamCode);
    return detailUrl.toString();
  } catch {
    return searchUrl;
  }
}

function urlWithSearchParam(url, key, value) {
  const parsed = new URL(url);
  if (value) {
    parsed.searchParams.set(key, value);
  } else {
    parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function arrayFrom(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const item = normalizeWhitespace(String(value || ''));
    if (!item || seen.has(item.toLowerCase())) continue;

    seen.add(item.toLowerCase());
    result.push(item);
  }

  return result;
}

function slugify(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error) {
  return String(error?.message || error || 'Unknown error');
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

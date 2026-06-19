const REQUEST_TIMEOUT_MS = 45000;
const HTML_CONTEXT_CHARS = 500;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (compatible; london-jobs-watcher/1.0; +https://workers.cloudflare.com/)';
const REAL_BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LONDON_PATTERN = /\b(?:Greater\s+London|London|Hybrid\s+London)\b/i;
const NON_UK_LONDON_PATTERN = /\bLondon\s*,?\s*(?:ON|Ontario|Canada)\b/i;
const MONTH_INDEX = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

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
    case 'workday':
      return fetchWorkdayJobs(company);
    case 'icims':
      return fetchIcimsJobs(company);
    case 'paradox':
      return fetchParadoxJobs(company);
    case 'revolut-next':
      return fetchRevolutNextJobs(company);
    case 'jibe':
      return fetchJibeJobs(company);
    case 'eightfold-embedded':
      return fetchEightfoldEmbeddedJobs(company);
    case 'eightfold-pcsx':
      return fetchEightfoldPcsxJobs(company);
    case 'meta-graphql':
      return fetchMetaGraphqlJobs(company);
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
  const configuredJobs = company.greenhouseDataMapKey
    ? data?.props?.pageProps?.jobs?.dataMap?.[company.greenhouseDataMapKey]?.jobs
    : null;
  const jobs = dedupeRawJobs(
    Array.isArray(configuredJobs) ? configuredJobs : findGreenhouseJobArrays(data).flat(),
  );

  return jobs.map((job) => {
    const offices = collectNames(job.offices);
    const cityCountry = normalizeWhitespace([job.city?.name, job.country?.name].filter(Boolean).join(', '));
    const location = normalizeWhitespace(job.location?.name || cityCountry || collectLocations(job.offices).join(', '));
    const office = normalizeWhitespace(offices.join(', '));

    return normalizeJob(company, {
      id: job.id || job.internal_job_id || job.absolute_url,
      title: job.title,
      location,
      office,
      url: job.absolute_url,
      postedAt: job.first_published || job.updated_at,
      searchText: [job.title, location, office, metadataValues(job.metadata).join(', ')].join(' '),
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

async function fetchWorkdayJobs(company) {
  const jobs = [];
  const seenIds = new Set();
  const pageSize = company.pageSize || company.limit || 20;
  const maxPages = company.maxPages || 5;
  const searchText = company.searchText || company.locationQuery || '';
  const appliedFacets = { ...(company.appliedFacets || {}) };
  const searches = Array.isArray(company.searches) && company.searches.length > 0
    ? company.searches
    : [{ searchText, appliedFacets, maxPages }];

  for (const search of searches) {
    const searchMaxPages = search.maxPages || maxPages;
    const searchAppliedFacets = { ...(search.appliedFacets || appliedFacets) };
    const query = search.searchText ?? searchText;

    for (let page = 0; page < searchMaxPages; page += 1) {
      const data = await postJson(company.url, {
        appliedFacets: searchAppliedFacets,
        limit: pageSize,
        offset: page * pageSize,
        searchText: query,
      });
      const pageJobs = Array.isArray(data?.jobPostings) ? data.jobPostings : [];

      if (!pageJobs.length) break;

      for (const job of pageJobs) {
        const id = normalizeWhitespace(String(workdayJobId(job) || ''));
        if (!id || seenIds.has(id)) continue;

        seenIds.add(id);
        jobs.push(mapWorkdayJob(company, job, search.locationHint));
      }

      if (Number(data?.total || 0) <= (page + 1) * pageSize || pageJobs.length < pageSize) break;
    }
  }

  return jobs;
}

async function fetchIcimsJobs(company) {
  const html = await fetchText(company.url);
  const itemRegex = /<li\b[^>]*class="[^"]*\biCIMS_JobCardItem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  const jobs = [];
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];
    const link = block.match(/<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*\biCIMS_Anchor\b[^"]*"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const url = cleanIcimsUrl(canonicalUrl(decodeHtml(link[1]), company.url));
    const title = stripHtml(link[3]).replace(/^Job Posting Title\s*/i, '') || titleFromUrl(url);
    const location = extractIcimsField(block, 'Job Locations');
    const id = extractIcimsField(block, 'ID') || matchFirst(url, [/\/jobs\/(\d+)\//]) || url;
    const postedAt = normalizeIcimsDate(matchFirst(block, [/<span\b[^>]*title="([^"]+)"[^>]*>\s*[^<]*<span class="sr-only">/i]));

    jobs.push(
      normalizeJob(company, {
        id,
        title,
        location,
        office: location,
        url,
        postedAt,
        searchText: [title, location, stripHtml(block)].join(' '),
      }),
    );
  }

  return jobs;
}

async function fetchParadoxJobs(company) {
  const entryUrl = company.careersUrl || new URL(company.url).origin;
  const page = await fetchTextWithRetry(entryUrl, {
    headers: browserHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', REAL_BROWSER_USER_AGENT),
  });
  const cookie = cookieHeaderFromSetCookie(page.headers);
  const jobs = [];
  const seenIds = new Set();
  const pageSize = company.pageSize || 20;
  const maxPages = company.maxPages || 5;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = new URL(company.url);
    if (company.keyword) url.searchParams.set('keyword', company.keyword);
    if (company.locationQuery) url.searchParams.set('location_name', company.locationQuery);
    if (company.locationType) url.searchParams.set('location_type', company.locationType);
    if (company.radius != null) url.searchParams.set('radius', String(company.radius));
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('page_number', String(pageNumber));

    const data = await postJsonWithRetry(
      url.toString(),
      {
        disable_switch_search_mode: Boolean(company.disableSwitchSearchMode),
        site_available_languages: company.siteAvailableLanguages || ['en'],
      },
      {
        ...browserHeaders('application/json, text/plain, */*', REAL_BROWSER_USER_AGENT),
        'content-type': 'application/json',
        origin: new URL(entryUrl).origin,
        referer: entryUrl,
        ...(cookie ? { cookie } : {}),
      },
    );
    const pageJobs = Array.isArray(data?.jobs) ? data.jobs : [];

    if (!pageJobs.length) break;

    for (const job of pageJobs) {
      const id = normalizeWhitespace(String(job.requisitionID || job.reference || job.uniqueID || job.sourceID || job.originalURL || ''));
      if (!id || seenIds.has(id)) continue;

      seenIds.add(id);
      jobs.push(mapParadoxJob(company, job));
    }

    if (Number(data?.totalJob || 0) <= seenIds.size || pageJobs.length < pageSize) break;
  }

  return jobs;
}

async function fetchRevolutNextJobs(company) {
  const html = await fetchReaderHtml(company.url);
  const data = extractNextData(html);
  const positions = Array.isArray(data?.props?.pageProps?.positions) ? data.props.pageProps.positions : [];

  return positions.map((position) => {
    const title = stripHtml(position.text);
    const locations = arrayFrom(position.locations).map(revolutLocation).filter(Boolean);
    const location = normalizeWhitespace(uniqueStrings(locations).join('; '));
    const url = canonicalUrl(`/careers/position/${slugify(title)}-${position.id}/`, company.careersUrl || 'https://www.revolut.com');

    return normalizeJob(company, {
      id: position.id || url,
      title,
      location,
      office: location,
      url,
      postedAt: '',
      searchText: [title, location, position.team].join(' '),
    });
  });
}

async function fetchJibeJobs(company) {
  const jobs = [];
  const seenIds = new Set();
  const pageSize = company.pageSize || company.limit || 10;
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

    if (Number(data?.totalCount || 0) <= seenIds.size || pageJobs.length < pageSize) break;
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

async function fetchEightfoldPcsxJobs(company) {
  const jobs = [];
  const seenIds = new Set();
  const domain = company.domain || new URL(company.careersUrl || company.url).hostname;
  const query = company.query || '';
  const location = company.locationQuery || '';
  const pageSize = company.pageSize || 10;
  const maxPages = company.maxPages || 10;
  let totalCount = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(company.url);
    url.searchParams.set('domain', domain);
    url.searchParams.set('query', query);
    url.searchParams.set('location', location);
    url.searchParams.set('start', String(page * pageSize));
    if (company.sortBy) url.searchParams.set('sort_by', company.sortBy);

    const data = await fetchJson(url.toString());
    const pageJobs = Array.isArray(data?.data?.positions) ? data.data.positions : [];
    totalCount = Number(data?.data?.count || totalCount || 0);

    if (!pageJobs.length) break;

    for (const job of pageJobs) {
      const id = normalizeWhitespace(String(job.displayJobId || job.atsJobId || job.id || job.positionUrl || ''));
      if (!id || seenIds.has(id)) continue;

      seenIds.add(id);
      jobs.push(mapEightfoldPcsxJob(company, job));
    }

    if (totalCount > 0 && seenIds.size >= totalCount) break;
    if (pageJobs.length < pageSize) break;
  }

  return jobs;
}

async function fetchMetaGraphqlJobs(company) {
  const page = await fetchTextWithHeaders(company.url, { headers: browserHeaders('text/html,*/*;q=0.8') });
  const html = page.text;
  const metaConfig = extractMetaGraphqlConfig(html);
  metaConfig.cookie = cookieHeaderFromSetCookie(page.headers);
  const offices = company.offices || ['London, UK'];
  const variables = {
    search_input: {
      q: company.query || null,
      divisions: [],
      offices,
      roles: [],
      leadership_levels: [],
      saved_jobs: [],
      saved_searches: [],
      sub_teams: [],
      teams: [],
      is_leadership: false,
      is_remote_only: false,
      sort_by_new: Boolean(company.sortByNew),
      results_per_page: null,
    },
  };
  const data = await postMetaGraphql(company, metaConfig, variables);
  const jobs = Array.isArray(data?.data?.job_search_with_featured_jobs?.all_jobs)
    ? data.data.job_search_with_featured_jobs.all_jobs
    : [];

  return jobs.map((job) => {
    const location = normalizeWhitespace(uniqueStrings(arrayFrom(job.locations)).join('; '));
    const categories = uniqueStrings([...arrayFrom(job.teams), ...arrayFrom(job.sub_teams)]).join(', ');

    return normalizeJob(company, {
      id: job.id,
      title: job.title,
      location,
      office: location,
      url: canonicalUrl(`/jobs/${job.id}/`, company.url),
      postedAt: '',
      searchText: [job.title, location, categories].join(' '),
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
    postedAt: normalizeSuccessFactorsDate(
      job.postedDate || job.postingDate || job.createdDate || job.requisitionOpenDate,
    ),
    closingAt: normalizeSuccessFactorsDate(job.unifiedStandardEnd || job.jobEndDate || job.endDate),
    searchText: [title, location, department].join(' '),
  });
}

function mapWorkdayJob(company, job, locationHint = '') {
  const title = stripHtml(job.title);
  const baseLocation = normalizeWhitespace(job.locationsText || arrayFrom(job.locations).map(collectNames).flat().join('; '));
  const location = normalizeWhitespace(
    locationHint && baseLocation && !LONDON_PATTERN.test(baseLocation)
      ? `${baseLocation} (${locationHint})`
      : baseLocation,
  );
  const categories = normalizeWhitespace([...arrayFrom(job.bulletFields), job.timeType].filter(Boolean).join(', '));
  const url = workdayJobUrl(company, job.externalPath || job.url);

  return normalizeJob(company, {
    id: workdayJobId(job) || url,
    title,
    location,
    office: location,
    url,
    postedAt: normalizeWorkdayPostedOn(job.postedOn),
    searchText: [title, location, categories, locationHint].join(' '),
  });
}

function mapParadoxJob(company, job) {
  const title = stripHtml(job.title);
  const location = normalizeWhitespace(uniqueStrings(arrayFrom(job.locations).map(paradoxLocation).filter(Boolean)).join('; '));
  const fieldValues = uniqueStrings([
    ...arrayFrom(job.employmentType),
    ...arrayFrom(job.employmentStatus),
    ...arrayFrom(job.customFields).map((field) => field?.value),
    ...arrayFrom(job.jobCardExtraFields).flatMap((field) => arrayFrom(field?.value)),
  ]).join(', ');
  const url = canonicalUrl(job.originalURL || job.applyURL, company.careersUrl || company.url);

  return normalizeJob(company, {
    id: job.requisitionID || job.reference || job.uniqueID || job.sourceID || url,
    title,
    location,
    office: location,
    url,
    postedAt: normalizeDate(job.datePosted || job.postedDate || job.createDate),
    searchText: [title, location, fieldValues].join(' '),
  });
}

function mapEightfoldPcsxJob(company, job) {
  const title = stripHtml(job.name || job.title);
  const location = normalizeWhitespace(
    uniqueStrings([...arrayFrom(job.locations), ...arrayFrom(job.standardizedLocations)]).join('; '),
  );
  const department = normalizeWhitespace(
    [job.department, job.workLocationOption, job.locationFlexibility].filter(Boolean).join(', '),
  );
  const url = canonicalUrl(job.positionUrl || `/careers/job/${job.id}`, company.careersUrl || company.url);

  return normalizeJob(company, {
    id: job.displayJobId || job.atsJobId || job.id || url,
    title,
    location,
    office: location,
    url,
    postedAt: normalizeUnixTimestamp(job.postedTs || job.creationTs),
    searchText: [title, location, department].join(' '),
  });
}

async function postMetaGraphql(company, metaConfig, variables) {
  const body = new URLSearchParams({
    av: '0',
    __user: '0',
    __a: '1',
    __req: '1',
    __hs: metaConfig.hasteSession,
    dpr: '1',
    __ccg: 'EXCELLENT',
    __rev: metaConfig.clientRevision,
    __s: 'x',
    __hsi: metaConfig.hsi,
    __comet_req: '31',
    lsd: metaConfig.lsd,
    jazoest: metaConfig.jazoest,
    __spin_r: metaConfig.clientRevision,
    __spin_b: 'trunk',
    __spin_t: metaConfig.spinT,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: company.graphqlFriendlyName || 'CareersJobSearchResultsDataQuery',
    variables: JSON.stringify(variables),
    server_timestamps: 'true',
    doc_id: company.graphqlDocId,
  });

  const response = await fetchWithTimeout(company.graphqlUrl || 'https://www.metacareers.com/api/graphql/', {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': BROWSER_USER_AGENT,
      origin: 'https://www.metacareers.com',
      referer: company.url,
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-asbd-id': '359341',
      'x-fb-friendly-name': company.graphqlFriendlyName || 'CareersJobSearchResultsDataQuery',
      'x-fb-lsd': metaConfig.lsd,
      ...(metaConfig.cookie ? { cookie: metaConfig.cookie } : {}),
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  try {
    return JSON.parse(text.replace(/^for \(;;\);/, ''));
  } catch {
    throw new Error(`Expected Meta GraphQL JSON but received: ${text.slice(0, 160)}`);
  }
}

function extractMetaGraphqlConfig(html) {
  const lsd = matchFirst(html, [
    /\["LSD",\[\],\{"token":"([^"]+)"/,
    /"LSD",\[\],\{"token":"([^"]+)"/,
  ]);
  const clientRevision = matchFirst(html, [/"client_revision":(\d+)/]);
  const hsi = matchFirst(html, [/"hsi":"(\d+)"/]);
  const hasteSession = matchFirst(html, [/"haste_session":"([^"]+)"/]);
  const spinT = matchFirst(html, [/"__spin_t":(\d+)/]) || String(Math.floor(Date.now() / 1000));

  if (!lsd || !clientRevision || !hsi) {
    throw new Error('Could not extract Meta GraphQL boot tokens');
  }

  return {
    lsd,
    clientRevision,
    hsi,
    hasteSession,
    spinT,
    jazoest: jazoestFromToken(lsd),
  };
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function jazoestFromToken(token) {
  return `2${[...String(token)].map((char) => char.charCodeAt(0)).join('')}`;
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

function workdayJobId(job) {
  return arrayFrom(job.bulletFields).find((field) => /\b(?:JR|R)-?\d+/i.test(String(field)))
    || matchFirst(job.externalPath || '', [/_(JR-?\d+|R-?\d+(?:-\d+)?)$/i])
    || job.externalPath;
}

function workdayJobUrl(company, externalPath) {
  const baseUrl = (company.careersUrl || company.url).replace(/\/$/, '');
  const path = String(externalPath || '');
  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return canonicalUrl(path, baseUrl);
  return canonicalUrl(`${baseUrl}/${path.replace(/^\//, '')}`, baseUrl);
}

function paradoxLocation(location) {
  if (!location || typeof location !== 'object') return normalizeWhitespace(location);

  return normalizeWhitespace(
    location.locationText
      || location.locationParsedText
      || [location.city || location.locationName, location.state || location.stateAbbr, location.country].filter(Boolean).join(', '),
  );
}

function revolutLocation(location) {
  if (!location || typeof location !== 'object') return normalizeWhitespace(location);

  const name = normalizeWhitespace(location.name);
  const country = normalizeWhitespace(location.country);
  if (!name) return country;
  if (!country || name.toLowerCase().includes(country.toLowerCase())) return name;
  return `${name}, ${country}`;
}

function extractIcimsField(block, label) {
  const srOnlyPattern = new RegExp(`<span class="sr-only field-label">\\s*${escapeRegExp(label)}\\s*<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, 'i');
  const srOnlyMatch = block.match(srOnlyPattern);
  if (srOnlyMatch) return stripHtml(srOnlyMatch[1]);

  const definitionPattern = new RegExp(`<dt[^>]*>\\s*${escapeRegExp(label)}\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, 'i');
  const definitionMatch = block.match(definitionPattern);
  return definitionMatch ? stripHtml(definitionMatch[1]) : '';
}

function cleanIcimsUrl(url) {
  if (!url) return '';

  try {
    const parsed = new URL(url);
    ['in_iframe', 'hashed', 'mobile', 'needsRedirect'].forEach((key) => parsed.searchParams.delete(key));
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeIcimsDate(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';
  return normalizeDate(`${normalized} GMT`);
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
  const url = job.meta_data?.canonical_url || job.canonical_url || job.apply_url || canonicalUrl(`/jobs/${job.slug || job.req_id}`, company.url);

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

export async function verifyJobIsOpenForAlert(job, now = new Date()) {
  if (job.companySlug !== 'bbc') return { open: true };

  const html = await fetchText(job.url);
  const closingAt = extractBbcJobClosingDate(html);
  if (!closingAt) return { open: true };

  if (dateOnlyTimestamp(closingAt) < dateOnlyTimestamp(now)) {
    return {
      open: false,
      reason: `closed on ${closingAt.slice(0, 10)}`,
    };
  }

  return { open: true, closingAt };
}

async function fetchGreenhouseJobs(company) {
  const data = await fetchJson(company.url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : Array.isArray(data) ? data : [];

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
        id: htmlJobIdentity(link, company.url),
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

function htmlJobIdentity(link, baseUrl) {
  return googleCareersLegacyJobId(link.url, baseUrl) || link.url;
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
  return postJsonWithHeaders(url, body, {
    accept: 'application/json',
    'content-type': 'application/json',
  });
}

async function postJsonWithHeaders(url, body, headers) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
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

async function postJsonWithRetry(url, body, headers, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();

    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Expected JSON but received: ${text.slice(0, 160)}`);
      }
    }

    if ((response.status === 403 || response.status === 429) && attempt < maxAttempts) {
      await delay(readerRetryDelayMs(response.headers, text));
      continue;
    }

    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  throw new Error('POST JSON retry failed');
}

async function fetchText(url) {
  const { text } = await fetchTextWithHeaders(url);
  return text;
}

async function fetchTextWithRetry(url, init = {}, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchTextWithHeaders(url, init);
    } catch (error) {
      if (!/HTTP (?:403|429)/i.test(errorMessage(error)) || attempt >= maxAttempts) throw error;
      await delay(5000);
    }
  }

  throw new Error('Text retry failed');
}

async function fetchTextWithHeaders(url, init = {}) {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...init.headers,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  return { text, headers: response.headers };
}

async function fetchReaderHtml(url) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchWithTimeout(url, {
      headers: {
        ...browserHeaders('text/html,*/*;q=0.8'),
        'x-return-format': 'html',
      },
    });
    const text = await response.text();

    if (response.ok) return text;

    if (response.status === 429 && attempt < maxAttempts) {
      await delay(readerRetryDelayMs(response.headers, text));
      continue;
    }

    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }

  throw new Error('Reader fetch failed');
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

function readerRetryDelayMs(headers, text) {
  const retryAfterHeader = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
    return Math.min(retryAfterHeader * 1000, 20000);
  }

  try {
    const parsed = JSON.parse(text);
    const retryAfter = Number(parsed?.retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, 20000);
    }
  } catch {
    // Fall through to a short default backoff.
  }

  return 5000;
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
    closingAt: normalizeDate(job.closingAt),
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
  return normalizeHumanDate(normalized) || normalizeDate(normalized);
}

function extractBbcJobClosingDate(html) {
  const text = normalizeWhitespace(stripHtml(html));
  const match = text.match(
    /Job Closing Date:\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
  );

  if (!match) return '';

  return normalizeSuccessFactorsDate(match[1]);
}

function normalizeHumanDate(value) {
  const normalized = normalizeWhitespace(value);
  const match = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/i);
  if (!match) return '';

  const month = MONTH_INDEX[match[2].toLowerCase()];
  if (month == null) return '';

  const day = Number(match[1]);
  const year = Number(match[3]);
  if (!Number.isInteger(day) || !Number.isInteger(year) || day < 1 || day > 31) return '';

  return new Date(Date.UTC(year, month, day)).toISOString();
}

function dateOnlyTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return Number.NaN;

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function normalizeWorkdayPostedOn(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return '';

  if (/today/i.test(normalized)) return normalizeRelativeDate(0);
  if (/yesterday/i.test(normalized)) return normalizeRelativeDate(1);

  const daysMatch = normalized.match(/Posted\s+(\d+)\+?\s+Days?\s+Ago/i);
  if (daysMatch) return normalizeRelativeDate(Number(daysMatch[1]));

  return normalizeDate(normalized.replace(/^Posted\s+/i, ''));
}

function normalizeRelativeDate(daysAgo) {
  const days = Number.isFinite(daysAgo) ? daysAgo : 0;
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
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
    return [value.name, typeof value.location === 'string' ? value.location : value.location?.name]
      .filter(Boolean)
      .map((item) => normalizeWhitespace(String(item)));
  }
  return [normalizeWhitespace(String(value))];
}

function browserHeaders(accept, userAgent = BROWSER_USER_AGENT) {
  return {
    accept,
    'accept-language': 'en-GB,en;q=0.9',
    'user-agent': userAgent,
  };
}

function cookieHeaderFromSetCookie(headers) {
  const setCookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);

  return setCookies
    .flatMap((value) => String(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/))
    .map((value) => value.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function collectLocations(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectLocations(item));
  if (typeof value === 'object') {
    return [
      typeof value.location === 'string' ? value.location : value.location?.name,
      [value.city?.name || value.city, value.country?.name || value.country].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .map((item) => normalizeWhitespace(String(item)));
  }
  return [normalizeWhitespace(String(value))];
}

function metadataValues(value) {
  return arrayFrom(value)
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      return item.value;
    })
    .filter(Boolean)
    .map((item) => normalizeWhitespace(String(item)));
}

function dedupeRawJobs(jobs) {
  const seen = new Set();
  const result = [];

  for (const job of jobs) {
    const key = normalizeWhitespace(String(job?.id || job?.internal_job_id || job?.absolute_url || ''));
    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(job);
  }

  return result;
}

function canonicalUrl(input, baseUrl) {
  try {
    const url = new URL(input, baseUrl);
    url.hash = '';
    normalizeGoogleCareersUrl(url);

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

function normalizeGoogleCareersUrl(url) {
  if (!/(^|\.)google\.com$/i.test(url.hostname)) return;

  url.pathname = url.pathname.replace(
    /^\/about\/careers\/applications\/jobs\/results\/jobs\/results\//i,
    '/about/careers/applications/jobs/results/',
  );
}

function googleCareersLegacyJobId(value, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value);

    if (!/(^|\.)google\.com$/i.test(base.hostname) || !/(^|\.)google\.com$/i.test(url.hostname)) {
      return '';
    }

    if (!base.pathname.startsWith('/about/careers/applications/jobs/results')) {
      return '';
    }

    const match = url.pathname.match(/^\/about\/careers\/applications\/jobs\/results\/(.+)$/i);
    if (!match) return '';

    const legacyUrl = new URL(url.toString());
    legacyUrl.pathname = `/about/careers/applications/jobs/results/jobs/results/${match[1]}`;
    return legacyUrl.toString();
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

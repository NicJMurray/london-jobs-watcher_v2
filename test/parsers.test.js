import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANIES } from '../src/companies.js';
import { fetchCompanyJobs, isLondonJob, extractRevolutPositions } from '../src/parsers.js';

const company = (slug) => COMPANIES.find((entry) => entry.slug === slug);
const json = (data) => Response.json(data);
const microsoftJob = (id, location = 'London, England, GB') => ({
  id: Number(id) + 1000, displayJobId: id, name: 'Software Engineer',
  locations: [location], positionUrl: `/careers/job/${Number(id) + 1000}`,
});

test('removed companies are absent from the registry', () => {
  for (const slug of ['bbc', 'adidas', 'decathlon']) assert.equal(company(slug), undefined);
});

test('Fujifilm uses the current official Workday board and accepts zero London jobs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /fujifilm\.wd3\.myworkdayjobs\.com\/wday\/cxs\//);
    assert.equal(JSON.parse(init.body).searchText, 'London');
    return json({ total: 0, jobPostings: [] });
  });
  assert.deepEqual(await fetchCompanyJobs(company('fujifilm')), []);
});

test('Workday pagination retains requisition IDs and real location text', async (t) => {
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { offset } = JSON.parse(init.body);
    offsets.push(offset);
    return json({ total: 2, jobPostings: [{
      title: 'Account Manager', externalPath: `/job/London/Account-Manager_R00${offset + 1}`,
      locationsText: 'London', bulletFields: [`R00${offset + 1}`], postedOn: 'Posted Today',
    }] });
  });
  const jobs = await fetchCompanyJobs({ ...company('fujifilm'), pageSize: 1 });
  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(jobs.map((job) => job.key), ['fujifilm::R001', 'fujifilm::R002']);
  assert.ok(jobs.every(isLondonJob));
});

test('malformed Workday response is a failure rather than zero vacancies', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'unavailable' }));
  await assert.rejects(fetchCompanyJobs(company('fujifilm')), /missing jobPostings/);
});

test('Skyscanner uses its current Ashby board and excludes unlisted roles', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(url, /api\.ashbyhq\.com\/posting-api\/job-board\/eb485598-/);
    return json({ jobs: [
      { id: 'listed', title: 'Engineer', location: 'London', jobUrl: 'https://jobs.ashbyhq.com/example/listed', isListed: true },
      { id: 'unlisted', title: 'Unlisted job', location: 'London', jobUrl: 'https://jobs.ashbyhq.com/example/unlisted', isListed: false },
    ] });
  });
  assert.deepEqual((await fetchCompanyJobs(company('skyscanner'))).map((job) => job.key), ['skyscanner::listed']);
});

test('Revolut parses official Next data and retains UUIDs through its source snapshot', async (t) => {
  const payload = { props: { pageProps: { positions: [{
    id: 'existing-uuid', text: 'Risk &amp; Policy', team: 'Risk',
    locations: [{ name: 'London', country: 'United Kingdom' }],
  }] } } };
  const positions = extractRevolutPositions(`<script nonce="example" type="application/json" id="__NEXT_DATA__">${JSON.stringify(payload)}</script>`);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, company('revolut').snapshotUrl);
    return json({ source: company('revolut').url, fetchedAt: new Date().toISOString(), positions });
  });
  const [job] = await fetchCompanyJobs(company('revolut'));
  assert.equal(job.key, 'revolut::existing-uuid');
  assert.equal(job.title, 'Risk & Policy');
  assert.equal(job.url, 'https://www.revolut.com/careers/position/risk-policy-existing-uuid/');
  assert.ok(isLondonJob(job));
});

test('Revolut challenge pages cannot be published as empty snapshots', () => {
  assert.throws(() => extractRevolutPositions('<html>Careers unavailable</html>'), /missing its positions payload/);
});

test('stale Revolut snapshots are failures rather than silently healthy results', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({
    source: company('revolut').url, fetchedAt: '2020-01-01T00:00:00Z', positions: [],
  }));
  await assert.rejects(fetchCompanyJobs(company('revolut')), /older than six hours/);
});

test('Revolut snapshot must identify the official source', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({
    source: 'https://wrong-source.example', fetchedAt: new Date().toISOString(), positions: [],
  }));
  await assert.rejects(fetchCompanyJobs(company('revolut')), /Invalid Revolut source snapshot/);
});

test('Microsoft retries a transient error then reads every page with stable IDs', async (t) => {
  const starts = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const start = Number(new URL(url).searchParams.get('start'));
    starts.push(start);
    if (starts.length === 1) return new Response('Slow down', { status: 429, headers: { 'retry-after': '0.001' } });
    return json({ status: 200, data: {
      count: 3, positions: start === 0 ? [microsoftJob('100'), microsoftJob('101')] : [microsoftJob('102')],
    } });
  });
  const jobs = await fetchCompanyJobs({ ...company('microsoft'), pageSize: 2 });
  assert.deepEqual(starts, [0, 0, 2]);
  assert.deepEqual(jobs.map((job) => job.key), ['microsoft::100', 'microsoft::101', 'microsoft::102']);
});

test('Microsoft pagination cap cannot silently discard matches', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ status: 200, data: {
    count: 3, positions: [microsoftJob('100'), microsoftJob('101')],
  } }));
  await assert.rejects(fetchCompanyJobs({ ...company('microsoft'), pageSize: 2, maxPages: 1 }), /truncated/);
});

test('Microsoft error envelope cannot masquerade as a healthy empty result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ status: 503, error: 'Unavailable' }));
  await assert.rejects(fetchCompanyJobs(company('microsoft')), /reports an error/);
});

test('permanent HTTP errors are not retried', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('Gone', { status: 404 }));
  await assert.rejects(fetchCompanyJobs(company('revolut')), /HTTP 404/);
  assert.equal(mock.mock.callCount(), 1);
});

test('transient failures have a bounded retry count', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', {
    status: 503, headers: { 'retry-after': '0.001' },
  }));
  await assert.rejects(fetchCompanyJobs(company('revolut')), /HTTP 503/);
  assert.equal(mock.mock.callCount(), 2);
});

test('long source cooldowns fail promptly rather than retrying too early', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('Slow down', {
    status: 429, headers: { 'retry-after': '60' },
  }));
  await assert.rejects(fetchCompanyJobs(company('revolut')), /retry after 60s/);
  assert.equal(mock.mock.callCount(), 1);
});

test('London filtering rejects Ontario and generic remote roles', () => {
  assert.equal(isLondonJob({ location: 'London, Ontario, Canada' }), false);
  assert.equal(isLondonJob({ location: 'Remote', searchText: 'Our headquarters are in London' }), false);
  assert.equal(isLondonJob({ location: 'London, United Kingdom' }), true);
});

import { writeFile } from 'node:fs/promises';
import { COMPANIES } from '../src/companies.js';
import { extractRevolutPositions } from '../src/parsers.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/refresh-revolut.mjs <output.json>');
const company = COMPANIES.find((company) => company.slug === 'revolut');
const response = await fetch(company.url, { signal: AbortSignal.timeout(45000) });
if (!response.ok) throw new Error(`Revolut careers page returned HTTP ${response.status}`);
const positions = extractRevolutPositions(await response.text());
await writeFile(output, JSON.stringify({
  source: company.url, fetchedAt: new Date().toISOString(), positions,
}) + '\n');
console.log(`Saved ${positions.length} Revolut positions`);

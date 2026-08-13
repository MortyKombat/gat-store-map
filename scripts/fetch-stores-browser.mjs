import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const LOCATOR_PAGE = 'https://gatavigdor.co.il/where-gat/';
const OUTPUT = process.argv[2] || 'site/stores.json';
const MAP_ID = '2678';
const RADIUS_KM = '25';

// Match the two searches requested for now.
const SEARCHES = [
  { name: 'תל אביב', lat: 32.0853, lng: 34.7818 },
  { name: 'חיפה', lat: 32.7940, lng: 34.9896 },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Chrome/Chromium not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function decodeEntities(text = '') {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(html = '') {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractField(html, pattern) {
  const match = String(html).match(pattern);
  return match ? stripTags(match[1]) : '';
}

function storeFromLocation(location) {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const info = String(location.infowindow || '');
  const store = extractField(info, /<h3[^>]*>([\s\S]*?)<\/h3>/i) || 'Unnamed store';
  const address = extractField(info, /class=["']info-window-address["'][^>]*>([\s\S]*?)<\/p>/i);
  const phone = extractField(info, /fa-phone-square[^>]*><\/i>\s*([\s\S]*?)<\/p>/i);

  return {
    id: '',
    lat,
    lng,
    store,
    address,
    address2: '',
    city: '',
    state: '',
    zip: '',
    country: '',
    phone,
    url: '',
  };
}

function parseLocationsFromHtml(html) {
  const match = String(html).match(/var\s+locations\s*=\s*(\{[\s\S]*?\})\s*;/i);
  if (!match) throw new Error(`Could not find locations JSON in locator response: ${String(html).slice(0, 240).replace(/\s+/g, ' ')}`);

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Could not parse locations JSON: ${error.message}`);
  }

  const rows = Array.isArray(parsed.locations) ? parsed.locations : [];
  return rows.map(storeFromLocation).filter(Boolean);
}

function keyFor(store) {
  return `${store.lat.toFixed(6)},${store.lng.toFixed(6)}|${store.store.trim().toLocaleLowerCase()}`;
}

function dedupe(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const store of group) {
      const key = keyFor(store);
      map.set(key, { ...(map.get(key) || {}), ...store });
    }
  }
  return [...map.values()].map((store, index) => ({ ...store, id: `store-${index + 1}` }));
}

async function queryLocator(page, search) {
  const result = await page.evaluate(async ({ name, lat, lng, radius, mapId }) => {
    const params = new URLSearchParams({
      action: 'make_search_request_custom_maps',
      store_locatore_search_input: name,
      store_locatore_search_radius: radius,
      store_locator_category: '',
      store_locatore_search_lat: String(lat),
      store_locatore_search_lng: String(lng),
      map_id: mapId,
      lat: String(lat),
      lng: String(lng),
    });

    const response = await fetch('/wp-admin/admin-ajax.php', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: '*/*',
      },
      body: params.toString(),
    });

    return { status: response.status, text: await response.text() };
  }, { name: search.name, lat: search.lat, lng: search.lng, radius: RADIUS_KM, mapId: MAP_ID });

  if (result.status !== 200) throw new Error(`${search.name} locator request returned HTTP ${result.status}`);
  const stores = parseLocationsFromHtml(result.text);
  console.log(`${search.name}, radius ${RADIUS_KM} km: ${stores.length} stores`);
  return stores;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  try {
    await page.goto(LOCATOR_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const groups = [];
    for (const search of SEARCHES) groups.push(await queryLocator(page, search));

    const stores = dedupe(groups);
    if (!stores.length) throw new Error('The live locator returned no stores');

    const perSearchCounts = Object.fromEntries(SEARCHES.map((search, i) => [search.name, groups[i].length]));
    const rawTotal = groups.reduce((sum, group) => sum + group.length, 0);
    const overlapCount = rawTotal - stores.length;

    const payload = {
      ok: true,
      count: stores.length,
      stores,
      retrieval: 'tel-aviv-haifa-25km-union',
      completenessCheck: `Snapshot intentionally contains only the 25 km תל אביב and חיפה searches. ${overlapCount} duplicate result(s) overlapped between the two searches.`,
      perSearchCounts,
      fetchedAt: new Date().toISOString(),
      source: LOCATOR_PAGE,
    };

    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
    console.log(`Per-search counts: ${JSON.stringify(perSearchCounts)}; overlap=${overlapCount}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

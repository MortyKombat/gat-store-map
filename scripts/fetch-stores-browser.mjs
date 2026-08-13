import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const LOCATOR_PAGE = 'https://gatavigdor.co.il/where-gat/';
const OUTPUT = process.argv[2] || 'site/stores.json';
const PROBES = [
  [31.55, 34.78],
  [32.08, 34.79],
  [32.82, 34.99],
  [30.66, 34.80],
  [33.00, 35.50],
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

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat ?? raw.latitude ?? raw.location?.lat);
  const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.location?.lng ?? raw.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    id: String(raw.id ?? raw.ID ?? raw.store_id ?? ''),
    lat,
    lng,
    store: String(raw.store ?? raw.name ?? raw.title ?? raw.post_title ?? 'Unnamed store'),
    address: String(raw.address ?? raw.street ?? raw.address1 ?? ''),
    address2: String(raw.address2 ?? ''),
    city: String(raw.city ?? raw.locality ?? ''),
    state: String(raw.state ?? ''),
    zip: String(raw.zip ?? raw.postcode ?? raw.postal_code ?? ''),
    country: String(raw.country ?? ''),
    phone: String(raw.phone ?? raw.tel ?? raw.telephone ?? ''),
    url: String(raw.url ?? raw.permalink ?? ''),
  };
}

function extractStoreArrays(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value.map(normalizeStore).filter(Boolean);
    if (normalized.length) out.push(normalized);
    for (const item of value) extractStoreArrays(item, out, seen);
    return out;
  }

  for (const v of Object.values(value)) extractStoreArrays(v, out, seen);
  return out;
}

function dedupe(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const raw of group || []) {
      const s = normalizeStore(raw) || raw;
      if (!s || !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng))) continue;
      const key = s.id ? `id:${s.id}` : `geo:${Number(s.lat).toFixed(6)},${Number(s.lng).toFixed(6)}:${s.store}`;
      map.set(key, { ...(map.get(key) || {}), ...s, lat: Number(s.lat), lng: Number(s.lng) });
    }
  }
  return [...map.values()];
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const executablePath = findChrome();
  console.log(`Using browser: ${executablePath}`);

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const capturedGroups = [];

  page.on('response', async response => {
    const url = response.url();
    const type = response.request().resourceType();
    if (!['xhr', 'fetch'].includes(type) && !/admin-ajax|locator|store/i.test(url)) return;

    try {
      const text = await response.text();
      const json = parseMaybeJson(text);
      const groups = json ? extractStoreArrays(json) : [];
      if (groups.length) {
        for (const g of groups) capturedGroups.push(g);
        console.log(`Captured ${groups.reduce((n, g) => n + g.length, 0)} store-shaped rows from ${response.status()} ${url}`);
      } else if (/admin-ajax|locator|store/i.test(url)) {
        console.log(`Network ${response.status()} ${type} ${url} :: ${text.slice(0, 180).replace(/\s+/g, ' ')}`);
      }
    } catch (error) {
      console.log(`Could not inspect response ${url}: ${error.message}`);
    }
  });

  try {
    console.log(`Opening ${LOCATOR_PAGE}`);
    await page.goto(LOCATOR_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(7000);

    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      globals: Object.keys(window).filter(k => /wpsl|store.?locator|locator/i.test(k)).slice(0, 30),
      inputs: [...document.querySelectorAll('input')].map((el, i) => ({
        i,
        id: el.id,
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        className: el.className,
      })).slice(0, 30),
      buttons: [...document.querySelectorAll('button,input[type="submit"]')].map((el, i) => ({
        i,
        id: el.id,
        text: (el.innerText || el.value || '').trim(),
        className: el.className,
      })).slice(0, 30),
      selects: [...document.querySelectorAll('select')].map((el, i) => ({
        i,
        id: el.id,
        name: el.name,
        values: [...el.options].map(o => o.value).slice(0, 20),
      })).slice(0, 20),
    }));
    console.log(`DOM diagnostics: ${JSON.stringify(diagnostics)}`);

    // First choice: make the WP Store Locator request from inside Gat's own
    // origin. This carries the real browser session/cookies and avoids CORS.
    for (const [lat, lng] of PROBES) {
      const result = await page.evaluate(async ({ lat, lng }) => {
        const url = new URL('/wp-admin/admin-ajax.php', location.origin);
        url.searchParams.set('action', 'store_search');
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lng', String(lng));
        url.searchParams.set('autoload', '1');
        try {
          const response = await fetch(url, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
          });
          return { status: response.status, text: await response.text(), url: response.url };
        } catch (error) {
          return { status: 0, text: String(error), url: url.href };
        }
      }, { lat, lng });

      const json = parseMaybeJson(result.text);
      const groups = json ? extractStoreArrays(json) : [];
      console.log(`Same-origin probe ${lat},${lng}: HTTP ${result.status}; ${groups.length ? `${groups.reduce((n,g)=>n+g.length,0)} store rows` : result.text.slice(0,140).replace(/\s+/g,' ')}`);
      for (const g of groups) capturedGroups.push(g);
    }

    // If the generic WP action isn't what this site currently uses, exercise
    // the real visible search UI and capture its own XHR/fetch response.
    if (!dedupe(capturedGroups).length) {
      const searchSelectors = [
        '#wpsl-search-input',
        'input[placeholder*="עיר"]',
        'input[placeholder*="שכונה"]',
        'input[placeholder*="Location"]',
      ];
      let search = null;
      for (const selector of searchSelectors) {
        const loc = page.locator(selector).first();
        if (await loc.count()) { search = loc; console.log(`Using search field ${selector}`); break; }
      }

      if (search) {
        await search.fill('תל אביב');
        const buttonSelectors = [
          '#wpsl-search-btn',
          'button:has-text("בצע חיפוש חדש")',
          'button:has-text("חיפוש")',
          'input[type="submit"]',
        ];
        let clicked = false;
        for (const selector of buttonSelectors) {
          const loc = page.locator(selector).first();
          if (await loc.count()) {
            console.log(`Clicking search control ${selector}`);
            await loc.click({ timeout: 10000 }).catch(() => {});
            clicked = true;
            break;
          }
        }
        if (!clicked) await search.press('Enter').catch(() => {});
        await page.waitForTimeout(12000);
      }
    }

    const stores = dedupe(capturedGroups);
    if (!stores.length) {
      throw new Error('Browser session loaded Gat successfully, but no store-coordinate JSON was captured. See DOM/network diagnostics above.');
    }

    const payload = {
      ok: true,
      count: stores.length,
      stores,
      retrieval: 'headless-browser',
      completenessCheck: 'Store rows were unioned and deduplicated across multiple same-origin autoload probes and/or the live search UI.',
      fetchedAt: new Date().toISOString(),
      source: LOCATOR_PAGE,
    };

    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

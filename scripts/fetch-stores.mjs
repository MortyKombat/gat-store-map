import fs from 'node:fs/promises';
import path from 'node:path';

const LOCATOR_PAGE = 'https://gatavigdor.co.il/where-gat/';
const OUTPUT = process.argv[2] || 'site/stores.json';

const PROBE_POINTS = [
  [31.55, 34.78],
  [32.82, 34.99],
  [30.66, 34.80],
];

const DEEP_SCAN_POINTS = [
  [29.56, 34.95], [30.99, 34.92], [31.42, 34.59], [31.78, 35.22],
  [31.89, 34.81], [32.08, 34.79], [32.32, 34.86], [32.79, 34.99],
  [32.93, 35.08], [32.79, 35.54], [33.00, 35.50], [31.67, 34.57],
];

const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0 Safari/537.36',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

function normalizeStore(store) {
  const lat = Number(store.lat);
  const lng = Number(store.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Keep only fields the map actually needs. This also avoids republishing
  // unrelated metadata if the source plugin adds fields later.
  return {
    id: store.id != null ? String(store.id) : '',
    lat,
    lng,
    store: store.store || store.name || 'Unnamed store',
    address: store.address || '',
    address2: store.address2 || '',
    city: store.city || '',
    state: store.state || '',
    zip: store.zip || '',
    country: store.country || '',
    phone: store.phone || '',
    url: store.url || store.permalink || '',
  };
}

function keyFor(store) {
  return store.id ? `id:${store.id}` : `geo:${store.lat.toFixed(6)},${store.lng.toFixed(6)}:${store.store}`;
}

function dedupe(groups) {
  const map = new Map();
  for (const group of groups) {
    for (const raw of group || []) {
      const store = normalizeStore(raw);
      if (!store) continue;
      const key = keyFor(store);
      map.set(key, { ...(map.get(key) || {}), ...store });
    }
  }
  return [...map.values()];
}

function sameIdSet(a, b) {
  const id = s => String(s.id || `${s.lat},${s.lng},${s.store}`);
  const sa = new Set(a.map(id));
  const sb = new Set(b.map(id));
  if (sa.size !== sb.size) return false;
  for (const value of sa) if (!sb.has(value)) return false;
  return true;
}

function cookieHeader(response) {
  const values = response.headers.getSetCookie?.() || [];
  return values.map(v => v.split(';', 1)[0]).filter(Boolean).join('; ');
}

function parseWpslSettings(html) {
  const patterns = [
    /var\s+wpslSettings\s*=\s*(\{[\s\S]*?\});/,
    /window\.wpslSettings\s*=\s*(\{[\s\S]*?\});/,
    /wpslSettings\s*=\s*(\{[\s\S]*?\});/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      console.log(`Found wpslSettings but could not parse it: ${error.message}`);
    }
  }
  return null;
}

async function loadLocatorSession() {
  const response = await fetch(LOCATOR_PAGE, {
    headers: {
      ...browserHeaders,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) throw new Error(`Locator page returned HTTP ${response.status}`);
  const html = await response.text();
  const settings = parseWpslSettings(html);
  const cookies = cookieHeader(response);

  if (!settings) {
    const i = html.indexOf('wpslSettings');
    if (i >= 0) console.log(`wpslSettings context: ${html.slice(Math.max(0, i - 120), i + 500)}`);
    throw new Error('Could not find wpslSettings in the live locator page');
  }

  const ajaxurl = settings.ajaxurl || new URL('/wp-admin/admin-ajax.php', LOCATOR_PAGE).href;
  console.log(`Live locator AJAX URL: ${ajaxurl}`);
  console.log(`Live WPSL defaults: maxResults=${settings.maxResults ?? ''}, searchRadius=${settings.searchRadius ?? ''}, autoLoad=${settings.autoLoad ?? ''}`);

  return { ajaxurl, settings, cookies };
}

async function gatQuery(session, lat, lng) {
  const url = new URL(session.ajaxurl, LOCATOR_PAGE);
  url.searchParams.set('action', 'store_search');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lng', String(lng));
  url.searchParams.set('autoload', '1');

  // Include the live defaults as well, matching the site's own request shape.
  if (session.settings.maxResults != null) url.searchParams.set('max_results', String(session.settings.maxResults));
  if (session.settings.searchRadius != null) url.searchParams.set('search_radius', String(session.settings.searchRadius));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {
      ...browserHeaders,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: LOCATOR_PAGE,
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (session.cookies) headers.Cookie = session.cookies;

    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Gat Avigdor returned HTTP ${response.status}: ${text.slice(0, 220)}`);
    }

    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Source returned non-JSON: ${text.slice(0, 220)}`); }
    if (!Array.isArray(data)) throw new Error(`Unexpected store-locator response shape: ${text.slice(0, 220)}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const session = await loadLocatorSession();

  const probes = [];
  for (const [lat, lng] of PROBE_POINTS) {
    const result = await gatQuery(session, lat, lng);
    console.log(`Probe ${lat},${lng}: ${result.length} stores`);
    probes.push(result);
  }

  let groups = probes;
  let retrieval = 'autoload-full';
  let completenessCheck = 'Three widely separated autoload probes returned the same store IDs.';

  if (!probes.every(group => sameIdSet(probes[0], group))) {
    retrieval = 'autoload-regional-union';
    completenessCheck = 'Autoload results differed by origin, so regional queries were unioned and deduplicated by store ID.';
    groups = [...probes];
    for (const [lat, lng] of DEEP_SCAN_POINTS) {
      const result = await gatQuery(session, lat, lng);
      console.log(`Regional probe ${lat},${lng}: ${result.length} stores`);
      groups.push(result);
    }
  }

  const stores = dedupe(groups);
  if (!stores.length) throw new Error('No stores were returned by the source locator');

  const payload = {
    ok: true,
    count: stores.length,
    stores,
    retrieval,
    completenessCheck,
    fetchedAt: new Date().toISOString(),
    source: LOCATOR_PAGE,
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

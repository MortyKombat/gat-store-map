import fs from 'node:fs/promises';
import path from 'node:path';

const GAT_AJAX = 'https://gatavigdor.co.il/wp-admin/admin-ajax.php';
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

function normalizeStore(store) {
  const lat = Number(store.lat);
  const lng = Number(store.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    ...store,
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
    email: store.email || '',
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

async function gatQuery(lat, lng) {
  const url = new URL(GAT_AJAX);
  url.searchParams.set('action', 'store_search');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lng', String(lng));
  url.searchParams.set('autoload', '1');
  url.searchParams.set('skip_cache', '1');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 GatStoreMap/1.0 (+https://github.com/MortyKombat/gat-store-map)',
        'Accept': 'application/json,text/plain,*/*',
        'Referer': 'https://gatavigdor.co.il/where-gat/',
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Gat Avigdor returned HTTP ${response.status}`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`Source returned non-JSON: ${text.slice(0, 160)}`); }
    if (!Array.isArray(data)) throw new Error('Unexpected store-locator response shape');
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const probes = [];
  for (const [lat, lng] of PROBE_POINTS) {
    const result = await gatQuery(lat, lng);
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
      const result = await gatQuery(lat, lng);
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
    source: 'https://gatavigdor.co.il/where-gat/',
  };

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

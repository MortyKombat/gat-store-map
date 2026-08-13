import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const LOCATOR_PAGE = 'https://gatavigdor.co.il/where-gat/';
const OUTPUT = process.argv[2] || 'site/stores.json';

function findChrome() {
  const candidates = [process.env.CHROME_PATH,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
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
    id: String(raw.id ?? raw.ID ?? raw.store_id ?? ''), lat, lng,
    store: String(raw.store ?? raw.name ?? raw.title ?? raw.post_title ?? 'Unnamed store'),
    address: String(raw.address ?? raw.street ?? raw.address1 ?? ''), address2: String(raw.address2 ?? ''),
    city: String(raw.city ?? raw.locality ?? ''), state: String(raw.state ?? ''), zip: String(raw.zip ?? raw.postcode ?? raw.postal_code ?? ''),
    country: String(raw.country ?? ''), phone: String(raw.phone ?? raw.tel ?? raw.telephone ?? ''), url: String(raw.url ?? raw.permalink ?? ''),
  };
}

function extractStoreArrays(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeStore).filter(Boolean);
    if (normalized.length) out.push(normalized);
    for (const item of value) extractStoreArrays(item, out, seen);
  } else {
    for (const v of Object.values(value)) extractStoreArrays(v, out, seen);
  }
  return out;
}

function dedupe(groups) {
  const map = new Map();
  for (const group of groups) for (const raw of group || []) {
    const s = normalizeStore(raw) || raw;
    if (!s || !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lng))) continue;
    const key = s.id ? `id:${s.id}` : `geo:${Number(s.lat).toFixed(6)},${Number(s.lng).toFixed(6)}:${s.store}`;
    map.set(key, { ...(map.get(key) || {}), ...s, lat:Number(s.lat), lng:Number(s.lng) });
  }
  return [...map.values()];
}

function parseMaybeJson(text){ try{return JSON.parse(text);}catch{return null;} }

async function main() {
  const browser = await chromium.launch({ executablePath: findChrome(), headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
  const context = await browser.newContext({ locale:'he-IL', viewport:{width:1440,height:1000} });
  const page = await context.newPage();
  const capturedGroups = [];

  page.on('request', request => {
    if (/\/wp-admin\/admin-ajax\.php/.test(request.url())) {
      console.log(`AJAX REQUEST ${request.method()} ${request.url()} :: ${(request.postData() || '').slice(0,900)}`);
    }
  });

  page.on('response', async response => {
    const url=response.url(), type=response.request().resourceType();
    if (!['xhr','fetch'].includes(type) && !/admin-ajax|locator|store/i.test(url)) return;
    try {
      const text=await response.text();
      const json=parseMaybeJson(text);
      if (json) for (const g of extractStoreArrays(json)) capturedGroups.push(g);
      if (/admin-ajax/i.test(url)) console.log(`AJAX RESPONSE ${response.status()} :: ${text.slice(0,1200).replace(/\s+/g,' ')}`);
    } catch {}
  });

  try {
    await page.goto(LOCATOR_PAGE,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(9000);

    // WP Multi Store Locator Pro exposes these globals. If any contain locations,
    // recursively harvest coordinate-bearing objects from them.
    const globalData = await page.evaluate(() => {
      const names=['store_locator_map_options','store_locator_grid_options'];
      const result={};
      for(const name of names){
        try{ result[name]=JSON.parse(JSON.stringify(window[name])); }
        catch{ result[name]=null; }
      }
      return result;
    });
    console.log(`PLUGIN GLOBALS ${JSON.stringify(globalData).slice(0,5000)}`);
    for (const g of extractStoreArrays(globalData)) capturedGroups.push(g);

    // Harvest stores already rendered by the plugin. It creates hidden inputs
    // such as pano-address-2784, one per store. Walk up each store block and
    // read coordinate attributes / JS literals from its HTML.
    const domStores = await page.evaluate(() => {
      const stores=[];
      const seen=new Set();
      const isLat=n=>Number.isFinite(n)&&n>=29&&n<=34;
      const isLng=n=>Number.isFinite(n)&&n>=34&&n<=36.5;
      const attrNames=['data-lat','data-lng','data-latitude','data-longitude','lat','lng','latitude','longitude'];

      for(const hidden of document.querySelectorAll('[id^="pano-address-"]')){
        const id=hidden.id.replace('pano-address-','');
        if(seen.has(id)) continue;
        let node=hidden, chosen=null;
        for(let depth=0; node && depth<9; depth++,node=node.parentElement){
          const attrs={};
          for(const el of [node,...node.querySelectorAll('*')].slice(0,300)){
            for(const a of attrNames) if(el.hasAttribute?.(a)) attrs[a]=el.getAttribute(a);
          }
          const html=node.outerHTML||'';
          const nums=[...html.matchAll(/-?\d{2,3}\.\d{4,}/g)].map(m=>Number(m[0]));
          const lat=Number(attrs['data-lat']??attrs['data-latitude']??attrs.lat??attrs.latitude) || nums.find(isLat);
          const lng=Number(attrs['data-lng']??attrs['data-longitude']??attrs.lng??attrs.longitude) || nums.find(n=>isLng(n)&&Math.abs(n-lat)>.1);
          if(isLat(lat)&&isLng(lng)) { chosen={node,lat,lng,html}; break; }
        }
        if(!chosen) continue;
        seen.add(id);
        const lines=(chosen.node.innerText||chosen.node.textContent||'').split(/\n+/).map(s=>s.trim()).filter(Boolean);
        const phone=(chosen.html.match(/(?:\+972|0)5\d[-\s]?\d{3}[-\s]?\d{4}/)||[])[0]||'';
        stores.push({id,lat:chosen.lat,lng:chosen.lng,store:lines[0]||`Store ${id}`,address:lines.slice(1,3).join(', '),phone});
      }
      return stores;
    });
    console.log(`DOM extraction found ${domStores.length} coordinate-bearing stores; sample=${JSON.stringify(domStores.slice(0,5))}`);
    if(domStores.length) capturedGroups.push(domStores);

    // Exercise the real search UI once, and capture its POST body/response in logs.
    const search=page.locator('input[placeholder*="עיר"], #location_name').first();
    if(await search.count()){
      await search.fill('תל אביב');
      const btn=page.locator('button:has-text("בצע חיפוש חדש"), #store_locatore_search_btn').first();
      if(await btn.count()) await btn.click().catch(()=>{}); else await search.press('Enter').catch(()=>{});
      await page.waitForTimeout(8000);
    }

    // Re-run DOM extraction after search; plugin may render extra metadata.
    const afterSearch = await page.evaluate(() => [...document.querySelectorAll('[id^="pano-address-"]')].length);
    console.log(`Store-id nodes after search: ${afterSearch}`);

    const stores=dedupe(capturedGroups);
    if(!stores.length) throw new Error('No coordinate-bearing stores extracted; inspect AJAX REQUEST/RESPONSE and plugin globals above.');

    await fs.mkdir(path.dirname(OUTPUT),{recursive:true});
    await fs.writeFile(OUTPUT,JSON.stringify({ok:true,count:stores.length,stores,retrieval:'wp-multi-store-locator-pro-browser',completenessCheck:`Extracted ${stores.length} unique coordinate-bearing store records from the live locator DOM/plugin data.`,fetchedAt:new Date().toISOString(),source:LOCATOR_PAGE},null,2)+'\n');
    console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
  } finally { await browser.close(); }
}

main().catch(e=>{console.error(e);process.exit(1);});

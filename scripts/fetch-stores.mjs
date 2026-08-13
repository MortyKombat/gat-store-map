import fs from 'node:fs/promises';
import path from 'node:path';

const AJAX = 'https://gatavigdor.co.il/wp-admin/admin-ajax.php';
const LOCATOR_PAGE = 'https://gatavigdor.co.il/where-gat/';
const OUTPUT = process.argv[2] || 'site/stores.json';

const PROBE_POINTS = [[31.55,34.78],[32.82,34.99],[30.66,34.80]];
const DEEP_SCAN_POINTS = [
  [29.56,34.95],[30.99,34.92],[31.42,34.59],[31.78,35.22],
  [31.89,34.81],[32.08,34.79],[32.32,34.86],[32.79,34.99],
  [32.93,35.08],[32.79,35.54],[33.00,35.50],[31.67,34.57],
];

const baseHeaders = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': LOCATOR_PAGE,
  'X-Requested-With': 'XMLHttpRequest',
};

function normalizeStore(s) {
  const lat = Number(s.lat), lng = Number(s.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: s.id != null ? String(s.id) : '', lat, lng,
    store: s.store || s.name || 'Unnamed store',
    address: s.address || '', address2: s.address2 || '', city: s.city || '',
    state: s.state || '', zip: s.zip || '', country: s.country || '',
    phone: s.phone || '', url: s.url || s.permalink || '',
  };
}
function keyFor(s){ return s.id ? `id:${s.id}` : `geo:${s.lat.toFixed(6)},${s.lng.toFixed(6)}:${s.store}`; }
function dedupe(groups){ const m=new Map(); for(const g of groups) for(const r of g||[]){const s=normalizeStore(r); if(s)m.set(keyFor(s),{...(m.get(keyFor(s))||{}),...s});} return [...m.values()]; }
function sameIdSet(a,b){ const f=s=>String(s.id||`${s.lat},${s.lng},${s.store}`), A=new Set(a.map(f)), B=new Set(b.map(f)); return A.size===B.size && [...A].every(x=>B.has(x)); }

async function attempt(method, params) {
  let url = AJAX;
  const options = { method, headers: {...baseHeaders}, redirect: 'follow' };
  if (method === 'GET') {
    const u = new URL(url);
    for (const [k,v] of Object.entries(params)) u.searchParams.set(k,String(v));
    url = u.href;
  } else {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    options.body = new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString();
  }
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),20000);
  options.signal = controller.signal;
  try {
    const r = await fetch(url, options);
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok:r.ok && Array.isArray(data), status:r.status, text, data };
  } finally { clearTimeout(timeout); }
}

let workingVariant = null;
async function gatQuery(lat,lng) {
  const variants = workingVariant ? [workingVariant] : [
    {method:'GET', radiusKey:'radius', autoload:true},
    {method:'GET', radiusKey:'search_radius', autoload:true},
    {method:'POST', radiusKey:'radius', autoload:true},
    {method:'POST', radiusKey:'search_radius', autoload:true},
    {method:'GET', radiusKey:'radius', autoload:false},
    {method:'POST', radiusKey:'radius', autoload:false},
    {method:'GET', radiusKey:'search_radius', autoload:false},
    {method:'POST', radiusKey:'search_radius', autoload:false},
  ];

  const errors=[];
  for(const v of variants){
    const p={action:'store_search',lat,lng,max_results:1000,[v.radiusKey]:1000};
    if(v.autoload) p.autoload=1;
    const r=await attempt(v.method,p);
    if(r.ok){
      if(!workingVariant){ workingVariant=v; console.log(`Working locator request: ${v.method}, ${v.radiusKey}, autoload=${v.autoload}`); }
      return r.data;
    }
    errors.push(`${v.method}/${v.radiusKey}/autoload=${v.autoload}: HTTP ${r.status} ${r.text.slice(0,80)}`);
  }
  throw new Error(`All Gat locator request variants failed:\n${errors.join('\n')}`);
}

async function main(){
  const probes=[];
  for(const [lat,lng] of PROBE_POINTS){ const result=await gatQuery(lat,lng); console.log(`Probe ${lat},${lng}: ${result.length} stores`); probes.push(result); }
  let groups=probes, retrieval='autoload-full', completenessCheck='Three widely separated probes returned the same store IDs.';
  if(!probes.every(g=>sameIdSet(probes[0],g))){
    retrieval='regional-union'; completenessCheck='Results differed by origin, so regional queries were unioned and deduplicated by store ID.'; groups=[...probes];
    for(const [lat,lng] of DEEP_SCAN_POINTS){ const result=await gatQuery(lat,lng); console.log(`Regional probe ${lat},${lng}: ${result.length} stores`); groups.push(result); }
  }
  const stores=dedupe(groups); if(!stores.length) throw new Error('No stores returned by source locator');
  const payload={ok:true,count:stores.length,stores,retrieval,completenessCheck,fetchedAt:new Date().toISOString(),source:LOCATOR_PAGE};
  await fs.mkdir(path.dirname(OUTPUT),{recursive:true}); await fs.writeFile(OUTPUT,JSON.stringify(payload,null,2)+'\n','utf8');
  console.log(`Wrote ${stores.length} unique stores to ${OUTPUT}`);
}
main().catch(e=>{console.error(e);process.exit(1);});

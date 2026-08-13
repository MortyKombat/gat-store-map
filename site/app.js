/* global L */
(() => {
  const els = {
    statusDot: document.getElementById('statusDot'), storeCount: document.getElementById('storeCount'),
    fetchStatus: document.getElementById('fetchStatus'), storeSearch: document.getElementById('storeSearch'),
    fitStores: document.getElementById('fitStores'), clearLocation: document.getElementById('clearLocation'),
    refreshStores: document.getElementById('refreshStores'), results: document.getElementById('results'),
    resultsTitle: document.getElementById('resultsTitle'), resultsSubtitle: document.getElementById('resultsSubtitle'),
    locationChip: document.getElementById('locationChip'), mapTip: document.getElementById('mapTip'),
  };

  const map = L.map('map', { zoomControl: true }).setView([31.75, 34.95], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const storeLayer = L.layerGroup().addTo(map);
  let stores = [], userLocation = null, userMarker = null, activeId = null;
  const markers = new Map();
  const PROBES = [[31.55,34.78],[32.08,34.79],[32.82,34.99],[30.66,34.80],[33.00,35.50]];

  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const addressFor = s => [s.address,s.address2,s.city,s.zip].filter(Boolean).join(', ');
  function haversineKm(a,b){const R=6371,r=d=>d*Math.PI/180,dLat=r(b.lat-a.lat),dLng=r(b.lng-a.lng),h=Math.sin(dLat/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(h));}
  function formatDistance(km){if(km<1)return `${Math.round(km*1000)} m`; if(km<10)return `${km.toFixed(1)} km`; return `${Math.round(km)} km`;}

  function normalize(s){const lat=Number(s.lat),lng=Number(s.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;return {id:String(s.id??''),lat,lng,store:s.store||s.name||'Unnamed store',address:s.address||'',address2:s.address2||'',city:s.city||'',zip:s.zip||'',phone:s.phone||''};}
  function dedupe(groups){const m=new Map();for(const g of groups)for(const raw of g||[]){const s=normalize(raw);if(!s)continue;const k=s.id||`${s.lat},${s.lng},${s.store}`;m.set(k,{...(m.get(k)||{}),...s});}return [...m.values()];}

  function targetUrl(lat,lng){const u=new URL('https://gatavigdor.co.il/wp-admin/admin-ajax.php');u.searchParams.set('action','store_search');u.searchParams.set('lat',lat);u.searchParams.set('lng',lng);u.searchParams.set('max_results','1000');u.searchParams.set('radius','1000');u.searchParams.set('autoload','1');return u.href;}
  async function tryJson(url, timeoutMs=15000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeoutMs);try{const r=await fetch(url,{cache:'no-store',signal:c.signal});const text=await r.text();if(!r.ok)throw new Error(`HTTP ${r.status}`);const data=JSON.parse(text);if(!Array.isArray(data))throw new Error('Unexpected response');return data;}finally{clearTimeout(t);}}
  async function queryStores(lat,lng){
    const target=targetUrl(lat,lng);
    const attempts=[
      ['direct',target],
      ['AllOrigins',`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`],
      ['CORSProxy',`https://corsproxy.io/?url=${encodeURIComponent(target)}`],
    ];
    const errors=[];
    for(const [name,url] of attempts){try{return {data:await tryJson(url),via:name};}catch(e){errors.push(`${name}: ${e.message}`);}}
    throw new Error(errors.join(' · '));
  }

  function popupHtml(s){const a=addressFor(s),dest=`${s.lat},${s.lng}`,dir=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`,tel=s.phone?`tel:${s.phone.replace(/[^+\d]/g,'')}`:'';return `<div class="popup-title" dir="auto">${esc(s.store)}</div>${a?`<div class="popup-address" dir="auto">${esc(a)}</div>`:''}${s.phone?`<div class="popup-meta" dir="auto">${esc(s.phone)}</div>`:''}${Number.isFinite(s._distance)?`<div class="popup-meta">${esc(formatDistance(s._distance))} from your pin</div>`:''}<div class="popup-actions"><a href="${dir}" target="_blank" rel="noopener">Directions</a>${tel?`<a href="${tel}">Call</a>`:''}</div>`;}

  function rebuildMarkers(){storeLayer.clearLayers();markers.clear();for(const s of stores){const m=L.circleMarker([s.lat,s.lng],{radius:7,weight:2,color:'#fff',fillColor:'#246746',fillOpacity:.92});m.bindPopup(()=>popupHtml(s));m.on('click',()=>{activeId=s.id;renderResults();});m.addTo(storeLayer);markers.set(String(s.id),m);}}
  function sortedStores(){const q=els.storeSearch.value.trim().toLocaleLowerCase();let list=stores.filter(s=>!q||[s.store,s.address,s.address2,s.city,s.zip,s.phone].filter(Boolean).join(' ').toLocaleLowerCase().includes(q));if(userLocation)list=list.map(s=>({...s,_distance:haversineKm(userLocation,s)})).sort((a,b)=>a._distance-b._distance);else list=list.slice().sort((a,b)=>String(a.city).localeCompare(String(b.city),'he')||String(a.store).localeCompare(String(b.store),'he'));return list;}
  function renderResults(){const list=sortedStores();if(!list.length){els.results.innerHTML='<div class="empty">No stores match that filter.</div>';return;}els.results.innerHTML=list.map((s,i)=>`<button class="store-card${String(s.id)===String(activeId)?' active':''}" type="button" data-id="${esc(s.id)}"><span class="rank">${i+1}</span><span><span class="store-name" dir="auto">${esc(s.store)}</span>${addressFor(s)?`<span class="store-address" dir="auto">${esc(addressFor(s))}</span>`:''}${s.phone?`<span class="store-meta" dir="auto">${esc(s.phone)}</span>`:''}</span>${Number.isFinite(s._distance)?`<span class="store-distance">${esc(formatDistance(s._distance))}</span>`:''}</button>`).join('');els.results.querySelectorAll('.store-card').forEach(b=>b.addEventListener('click',()=>focusStore(b.dataset.id)));}
  function focusStore(id){activeId=String(id);const s=stores.find(x=>String(x.id)===String(id)),m=markers.get(String(id));if(!s||!m)return;map.flyTo([s.lat,s.lng],Math.max(map.getZoom(),14),{duration:.55});m.openPopup();renderResults();}
  function setUserLocation(latlng){userLocation={lat:latlng.lat,lng:latlng.lng};if(!userMarker){const icon=L.divIcon({className:'',html:'<div class="user-pin"></div>',iconSize:[24,24],iconAnchor:[12,12]});userMarker=L.marker(latlng,{icon,draggable:true,zIndexOffset:1000}).addTo(map);userMarker.on('dragend',e=>setUserLocation(e.target.getLatLng()));}else userMarker.setLatLng(latlng);els.clearLocation.disabled=false;els.mapTip.textContent='Drag the blue pin to fine-tune your location';els.resultsTitle.textContent='Nearest stores';els.resultsSubtitle.textContent='Sorted by straight-line distance from your pin.';els.locationChip.hidden=false;els.locationChip.textContent=`${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;activeId=null;renderResults();}
  function clearUserLocation(){userLocation=null;if(userMarker){map.removeLayer(userMarker);userMarker=null;}els.clearLocation.disabled=true;els.mapTip.textContent='Click the map to place your location';els.resultsTitle.textContent='All stores';els.resultsSubtitle.textContent='Place your pin to sort by distance.';els.locationChip.hidden=true;activeId=null;renderResults();}
  function fitAllStores(){if(stores.length)map.fitBounds(L.latLngBounds(stores.map(s=>[s.lat,s.lng])).pad(.1),{maxZoom:11});}

  async function loadStores(){els.statusDot.className='status-dot';els.storeCount.textContent='Loading stores…';els.fetchStatus.textContent='Trying Gat Avigdor and fallback relays';els.refreshStores.disabled=true;try{const groups=[],via=new Set();for(const [lat,lng] of PROBES){const r=await queryStores(lat,lng);groups.push(r.data);via.add(r.via);}stores=dedupe(groups);if(!stores.length)throw new Error('No stores returned');els.statusDot.className='status-dot ok';els.storeCount.textContent=`${stores.length} stores loaded`;els.fetchStatus.textContent=`Live data via ${[...via].join(', ')}`;rebuildMarkers();renderResults();fitAllStores();}catch(e){console.error(e);els.statusDot.className='status-dot error';els.storeCount.textContent='Could not load stores';els.fetchStatus.textContent=e.message;els.results.innerHTML=`<div class="empty">Could not read the source locator.<br>${esc(e.message)}</div>`;}finally{els.refreshStores.disabled=false;}}

  map.on('click',e=>setUserLocation(e.latlng));els.storeSearch.addEventListener('input',renderResults);els.fitStores.addEventListener('click',fitAllStores);els.clearLocation.addEventListener('click',clearUserLocation);els.refreshStores.addEventListener('click',loadStores);loadStores();
})();

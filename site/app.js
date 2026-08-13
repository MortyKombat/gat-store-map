/* global L */
(() => {
  const els = {
    statusDot: document.getElementById('statusDot'),
    storeCount: document.getElementById('storeCount'),
    fetchStatus: document.getElementById('fetchStatus'),
    storeSearch: document.getElementById('storeSearch'),
    fitStores: document.getElementById('fitStores'),
    clearLocation: document.getElementById('clearLocation'),
    refreshStores: document.getElementById('refreshStores'),
    results: document.getElementById('results'),
    resultsTitle: document.getElementById('resultsTitle'),
    resultsSubtitle: document.getElementById('resultsSubtitle'),
    locationChip: document.getElementById('locationChip'),
    mapTip: document.getElementById('mapTip'),
  };

  const map = L.map('map', { zoomControl: true }).setView([31.75, 34.95], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const storeLayer = L.layerGroup().addTo(map);
  let stores = [];
  let filteredStores = [];
  let userLocation = null;
  let userMarker = null;
  let activeId = null;
  const markers = new Map();

  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[ch]);
  }

  function addressFor(store) {
    return [store.address, store.address2, store.city, store.zip].filter(Boolean).join(', ');
  }

  function haversineKm(a, b) {
    const R = 6371;
    const rad = deg => deg * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const lat1 = rad(a.lat);
    const lat2 = rad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatDistance(km) {
    if (!Number.isFinite(km)) return '';
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }

  function popupHtml(store) {
    const address = addressFor(store);
    const destination = `${store.lat},${store.lng}`;
    const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
    const phoneHref = store.phone ? `tel:${String(store.phone).replace(/[^+\d]/g, '')}` : '';
    return `
      <div class="popup-title" dir="auto">${esc(store.store)}</div>
      ${address ? `<div class="popup-address" dir="auto">${esc(address)}</div>` : ''}
      ${store.phone ? `<div class="popup-meta" dir="auto">${esc(store.phone)}</div>` : ''}
      ${Number.isFinite(store._distance) ? `<div class="popup-meta">${esc(formatDistance(store._distance))} from your pin</div>` : ''}
      <div class="popup-actions">
        <a href="${directions}" target="_blank" rel="noopener">Directions</a>
        ${phoneHref ? `<a href="${phoneHref}">Call</a>` : ''}
      </div>`;
  }

  function rebuildMarkers() {
    storeLayer.clearLayers();
    markers.clear();
    for (const store of stores) {
      const marker = L.circleMarker([store.lat, store.lng], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: '#246746',
        fillOpacity: 0.92,
      });
      marker.bindPopup(() => popupHtml(store));
      marker.on('click', () => {
        activeId = store.id;
        renderResults();
      });
      marker.addTo(storeLayer);
      markers.set(String(store.id), marker);
    }
  }

  function sortedStores() {
    const q = els.storeSearch.value.trim().toLocaleLowerCase();
    let list = stores.filter(store => {
      if (!q) return true;
      return [store.store, store.address, store.address2, store.city, store.zip, store.phone]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(q);
    });

    if (userLocation) {
      list = list.map(s => ({ ...s, _distance: haversineKm(userLocation, s) }))
        .sort((a, b) => a._distance - b._distance);
    } else {
      list = list.slice().sort((a, b) => String(a.city || '').localeCompare(String(b.city || ''), 'he') || String(a.store).localeCompare(String(b.store), 'he'));
    }
    return list;
  }

  function renderResults() {
    filteredStores = sortedStores();
    if (!filteredStores.length) {
      els.results.innerHTML = '<div class="empty">No stores match that filter.</div>';
      return;
    }

    els.results.innerHTML = filteredStores.map((store, index) => {
      const active = String(store.id) === String(activeId) ? ' active' : '';
      const address = addressFor(store);
      return `
        <button class="store-card${active}" type="button" data-id="${esc(store.id)}">
          <span class="rank">${index + 1}</span>
          <span>
            <span class="store-name" dir="auto">${esc(store.store)}</span>
            ${address ? `<span class="store-address" dir="auto">${esc(address)}</span>` : ''}
            ${store.phone ? `<span class="store-meta" dir="auto">${esc(store.phone)}</span>` : ''}
          </span>
          ${Number.isFinite(store._distance) ? `<span class="store-distance">${esc(formatDistance(store._distance))}</span>` : ''}
        </button>`;
    }).join('');

    els.results.querySelectorAll('.store-card').forEach(button => {
      button.addEventListener('click', () => focusStore(button.dataset.id));
    });
  }

  function focusStore(id) {
    activeId = String(id);
    const store = stores.find(s => String(s.id) === String(id));
    const marker = markers.get(String(id));
    if (!store || !marker) return;
    map.flyTo([store.lat, store.lng], Math.max(map.getZoom(), 14), { duration: 0.55 });
    marker.openPopup();
    renderResults();
  }

  function setUserLocation(latlng, center = false) {
    userLocation = { lat: latlng.lat, lng: latlng.lng };
    if (!userMarker) {
      const icon = L.divIcon({ className: '', html: '<div class="user-pin"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
      userMarker = L.marker(latlng, { icon, draggable: true, zIndexOffset: 1000 }).addTo(map);
      userMarker.bindTooltip('Your selected location', { direction: 'top', offset: [0, -12] });
      userMarker.on('dragend', e => setUserLocation(e.target.getLatLng(), false));
    } else {
      userMarker.setLatLng(latlng);
    }

    if (center) map.panTo(latlng);
    els.clearLocation.disabled = false;
    els.mapTip.textContent = 'Drag the blue pin to fine-tune your location';
    els.resultsTitle.textContent = 'Nearest stores';
    els.resultsSubtitle.textContent = 'Sorted by straight-line distance from your pin.';
    els.locationChip.hidden = false;
    els.locationChip.textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    activeId = null;
    renderResults();
  }

  function clearUserLocation() {
    userLocation = null;
    if (userMarker) {
      map.removeLayer(userMarker);
      userMarker = null;
    }
    els.clearLocation.disabled = true;
    els.mapTip.textContent = 'Click the map to place your location';
    els.resultsTitle.textContent = 'All stores';
    els.resultsSubtitle.textContent = 'Place your pin to sort by distance.';
    els.locationChip.hidden = true;
    activeId = null;
    renderResults();
  }

  function fitAllStores() {
    if (!stores.length) return;
    const bounds = L.latLngBounds(stores.map(s => [s.lat, s.lng]));
    map.fitBounds(bounds.pad(0.10), { maxZoom: 11 });
  }

  async function loadStores(refresh = false) {
    els.statusDot.className = 'status-dot';
    els.storeCount.textContent = refresh ? 'Refreshing stores…' : 'Loading stores…';
    els.fetchStatus.textContent = 'Reading the latest published store snapshot';
    els.refreshStores.disabled = true;
    try {
      const cacheBust = refresh ? `?t=${Date.now()}` : '';
      const response = await fetch(`./stores.json${cacheBust}`, { cache: refresh ? 'no-store' : 'default' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);

      stores = payload.stores.filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))).map(s => ({ ...s, lat: Number(s.lat), lng: Number(s.lng) }));
      els.statusDot.className = 'status-dot ok';
      els.storeCount.textContent = `${stores.length} stores loaded`;
      const refreshed = payload.fetchedAt ? new Date(payload.fetchedAt).toLocaleString() : '';
      els.fetchStatus.textContent = payload.retrieval === 'autoload-full'
        ? `Complete snapshot${refreshed ? ` · ${refreshed}` : ''}`
        : `Regional results merged${refreshed ? ` · ${refreshed}` : ''}`;
      els.fetchStatus.title = payload.completenessCheck || '';
      rebuildMarkers();
      renderResults();
      fitAllStores();
    } catch (error) {
      console.error(error);
      els.statusDot.className = 'status-dot error';
      els.storeCount.textContent = 'Could not load stores';
      els.fetchStatus.textContent = error.message;
      els.results.innerHTML = `<div class="empty">Could not read the source locator.<br>${esc(error.message)}</div>`;
    } finally {
      els.refreshStores.disabled = false;
    }
  }

  map.on('click', e => setUserLocation(e.latlng, false));
  els.storeSearch.addEventListener('input', renderResults);
  els.fitStores.addEventListener('click', fitAllStores);
  els.clearLocation.addEventListener('click', clearUserLocation);
  els.refreshStores.addEventListener('click', () => loadStores(true));

  loadStores(false);
})();

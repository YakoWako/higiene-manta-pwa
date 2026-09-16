'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  barrios: null,
  parroquias: null,
  puntos: [],
  currentLocation: null,
  currentTerritory: null,
  nearestPoint: null,
  selectedMapPoint: null,
  startAt: null,
  endAt: null,
  auth: { authorized: false, expiresAt: 0, pendingAction: null },
  map: { leaflet: null, baseLayer: null, barrioLayer: null, parishLayer: null, pointLayer: null, userLayer: null, pointMarkers: new Map(), initial: null, view: null, dragging: false, lastX: 0, lastY: 0, moved: false }
};

const WASTE_TYPES = [
  'Residuos Sólidos Urbanos (RSU) Comunes',
  'Desechos Orgánicos',
  'Material de Construcción y Escombros',
  'Desechos Voluminosos (Muebles, Electrodomésticos)',
  'Llantas',
  'Desechos Peligrosos/Especiales',
  'Maleza',
  'Otros'
];

const DB_NAME = 'higiene-manta-pwa';
const DB_VERSION = 1;
const STORE = 'evacuaciones';
const AUTH_KEY = 'higiene-manta-supervisor-session-v1';
let dbPromise = null;
let toastTimer = null;
let gpsWatchId = null;
let gpsTimer = null;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function formatMeters(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}

function formatDateTime(iso) {
  if (!iso) return 'No registrado';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('es-EC', {dateStyle:'short', timeStyle:'short'}).format(d);
}

function normalizeName(v='') {
  return String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
}

function supervisorSessionActive() {
  const expiresAt = Number(localStorage.getItem(AUTH_KEY) || 0);
  const active = Number.isFinite(expiresAt) && expiresAt > Date.now();
  state.auth.authorized = active;
  state.auth.expiresAt = active ? expiresAt : 0;
  if (!active && expiresAt) localStorage.removeItem(AUTH_KEY);
  return active;
}

function updateAccessUI() {
  const active = supervisorSessionActive();
  const bar = $('accessBar');
  if (!bar) return;
  bar.classList.toggle('supervisor', active);
  bar.classList.toggle('public', !active);
  $('appShell').classList.toggle('supervisor-unlocked', active);
  $('accessIcon').textContent = active ? '✓' : '◎';
  $('accessTitle').textContent = active ? 'Modo supervisor habilitado' : 'Consulta pública';
  $('accessSubtitle').textContent = active
    ? 'Registro y gestión de evacuaciones habilitados en este dispositivo'
    : 'Ubicación, mapa y fichas disponibles sin contraseña';
  $('logoutSupervisorBtn').classList.toggle('hidden', !active);
  if ($('nearestRegisterBtn')) $('nearestRegisterBtn').textContent = active ? 'Registrar evacuación' : '🔒 Registrar evacuación';
  if ($('mapRegisterSelected')) $('mapRegisterSelected').textContent = active ? 'Registrar evacuación' : '🔒 Registrar evacuación';
  if (!active && $('pendingBadge')) $('pendingBadge').classList.add('hidden');
}

async function sha256Hex(text) {
  if (!window.crypto?.subtle) throw new Error('La validación segura requiere abrir la aplicación mediante HTTPS.');
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}

function closeAuthModal() {
  $('authModal').classList.add('hidden');
  $('supervisorPin').value = '';
  $('authError').classList.add('hidden');
  state.auth.pendingAction = null;
}

function openAuthModal(action) {
  if (supervisorSessionActive()) { action?.(); return; }
  state.auth.pendingAction = typeof action === 'function' ? action : null;
  $('authError').classList.add('hidden');
  $('supervisorPin').value = '';
  $('authModal').classList.remove('hidden');
  setTimeout(() => $('supervisorPin').focus(), 30);
}

async function confirmSupervisorAccess() {
  const pin = $('supervisorPin').value.trim();
  const err = $('authError');
  if (!/^\d{4}$/.test(pin)) {
    err.textContent = 'Ingrese el PIN de 4 dígitos.';
    err.classList.remove('hidden');
    return;
  }
  try {
    const hash = await sha256Hex(pin);
    const expected = String(window.APP_CONFIG?.supervisorPinHash || '').toLowerCase();
    if (!expected || hash !== expected) {
      err.textContent = 'PIN incorrecto.';
      err.classList.remove('hidden');
      $('supervisorPin').select();
      return;
    }
    const hours = Math.max(1, Number(window.APP_CONFIG?.supervisorSessionHours || 8));
    const expiresAt = Date.now() + hours * 60 * 60 * 1000;
    localStorage.setItem(AUTH_KEY, String(expiresAt));
    state.auth.authorized = true; state.auth.expiresAt = expiresAt;
    const action = state.auth.pendingAction;
    $('authModal').classList.add('hidden');
    $('supervisorPin').value = ''; err.classList.add('hidden');
    state.auth.pendingAction = null;
    updateAccessUI();
    await refreshPendingList().catch(()=>{});
    toast('Acceso de supervisor habilitado');
    action?.();
  } catch (e) {
    console.error(e);
    err.textContent = e.message || 'No fue posible validar el acceso.';
    err.classList.remove('hidden');
  }
}

function logoutSupervisor() {
  localStorage.removeItem(AUTH_KEY);
  state.auth.authorized = false; state.auth.expiresAt = 0; state.auth.pendingAction = null;
  const protectedOpen = $('tabRegistro').classList.contains('active') || $('tabPendientes').classList.contains('active');
  if (protectedOpen) switchTab('Ubicacion', true);
  updateAccessUI();
  refreshPendingList().catch(()=>{});
  toast('Sesión de supervisor cerrada');
}

async function loadData() {
  const [barrios, parroquias, puntos] = await Promise.all([
    fetch('data/barrios.geojson').then(r => r.json()),
    fetch('data/parroquias.geojson').then(r => r.json()),
    fetch('data/puntos.json').then(r => r.json())
  ]);
  state.barrios = barrios;
  state.parroquias = parroquias;
  state.puntos = puntos;
  cacheFeatureBBoxes(state.barrios);
  cacheFeatureBBoxes(state.parroquias);
  populatePointSelect();
  buildWasteGrid();
  renderStats();
  // El mapa se inicializa al abrir su pestaña; así Leaflet obtiene el tamaño real de la pantalla.
  if($('tabMapa')?.classList.contains('active')) renderMap();
}

function cacheFeatureBBoxes(fc) {
  for (const f of fc.features) f._bbox = featureBBox(f);
}

function featureBBox(feature) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  forEachCoord(feature.geometry, ([x,y]) => {
    if (x<minX) minX=x; if (x>maxX) maxX=x; if (y<minY) minY=y; if (y>maxY) maxY=y;
  });
  return [minX,minY,maxX,maxY];
}

function forEachCoord(geometry, cb) {
  if (!geometry) return;
  const c = geometry.coordinates;
  if (geometry.type === 'Polygon') {
    c.forEach(r => r.forEach(cb));
  } else if (geometry.type === 'MultiPolygon') {
    c.forEach(p => p.forEach(r => r.forEach(cb)));
  }
}

function ringContains(point, ring) {
  const x = point.lng, y = point.lat;
  let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    const intersect = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-15)+xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonContains(point, rings) {
  if (!rings?.length || !ringContains(point, rings[0])) return false;
  for (let i=1;i<rings.length;i++) if (ringContains(point, rings[i])) return false;
  return true;
}

function featureContains(feature, point) {
  const b = feature._bbox || featureBBox(feature);
  if (point.lng < b[0] || point.lng > b[2] || point.lat < b[1] || point.lat > b[3]) return false;
  const g = feature.geometry;
  if (g.type === 'Polygon') return polygonContains(point, g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some(poly => polygonContains(point, poly));
  return false;
}

function featureAreaApprox(feature) {
  let total=0;
  const ringArea = ring => {
    let a=0;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++) a += (ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1]);
    return Math.abs(a/2);
  };
  if(feature.geometry.type==='Polygon') total += ringArea(feature.geometry.coordinates[0]||[]);
  else feature.geometry.coordinates.forEach(p=>total+=ringArea(p[0]||[]));
  return total;
}

function containingFeature(fc, point) {
  const matches = fc.features.filter(f => featureContains(f, point));
  if (!matches.length) return null;
  matches.sort((a,b)=>featureAreaApprox(a)-featureAreaApprox(b));
  return matches[0];
}

function metersXY(origin, coord) {
  const latRad = origin.lat * Math.PI/180;
  return {
    x:(coord[0]-origin.lng)*111320*Math.cos(latRad),
    y:(coord[1]-origin.lat)*110540
  };
}

function distPointSegmentMeters(origin, aCoord, bCoord) {
  const a=metersXY(origin,aCoord), b=metersXY(origin,bCoord);
  const px=0,py=0, dx=b.x-a.x, dy=b.y-a.y;
  const denom=dx*dx+dy*dy;
  let t=denom?((px-a.x)*dx+(py-a.y)*dy)/denom:0;
  t=Math.max(0,Math.min(1,t));
  const x=a.x+t*dx, y=a.y+t*dy;
  return Math.hypot(x,y);
}

function featureBoundaryDistance(feature, point) {
  let min=Infinity;
  const checkRings = rings => rings.forEach(ring => {
    for(let i=1;i<ring.length;i++) min=Math.min(min,distPointSegmentMeters(point,ring[i-1],ring[i]));
  });
  const g=feature.geometry;
  if(g.type==='Polygon') checkRings(g.coordinates);
  else g.coordinates.forEach(checkRings);
  return min;
}

function nearestOtherFeature(fc, point, excluded) {
  let best=null, bestD=Infinity;
  for (const f of fc.features) {
    if (f===excluded) continue;
    const d=featureBoundaryDistance(f,point);
    if(d<bestD){bestD=d;best=f;}
  }
  return {feature:best,distance:bestD};
}

function haversine(a,b) {
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function pointName(f) { return f?.properties?.descripcion || f?.properties?.name || 'Sin determinar'; }

function nearestCritical(location) {
  let best=null,bestD=Infinity;
  for (const p of state.puntos) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const d=haversine(location,{lat:p.lat,lng:p.lng});
    if(d<bestD){bestD=d;best=p;}
  }
  return {point:best,distance:bestD};
}

async function locateUser() {
  if (!navigator.geolocation) {
    showBoundaryError('Este navegador no ofrece geolocalización.');
    return;
  }
  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  if (gpsTimer) clearTimeout(gpsTimer);

  $('locateBtn').disabled=true;
  $('locateBtn').textContent='Buscando una lectura GPS precisa…';
  let best=null, samples=0, finished=false;

  const finish=(errorMessage='')=>{
    if(finished)return;
    finished=true;
    if(gpsWatchId!==null){navigator.geolocation.clearWatch(gpsWatchId);gpsWatchId=null;}
    if(gpsTimer){clearTimeout(gpsTimer);gpsTimer=null;}
    $('locateBtn').disabled=false;
    $('locateBtn').textContent='⌖ Actualizar mi ubicación GPS';
    if(!best){
      showBoundaryError(errorMessage||'No fue posible obtener una posición GPS utilizable. Intente nuevamente en un espacio abierto.');
      return;
    }
    const loc={lat:best.coords.latitude,lng:best.coords.longitude,accuracy:best.coords.accuracy,timestamp:best.timestamp,samples};
    state.currentLocation=loc;
    analyzeLocation(loc);
    drawUserLocation();
    updateFormAutoFields();
    toast(`Ubicación actualizada · precisión ±${Math.round(loc.accuracy||0)} m`);
  };

  gpsWatchId=navigator.geolocation.watchPosition(
    pos=>{
      samples++;
      if(!best || Number(pos.coords.accuracy||Infinity)<Number(best.coords.accuracy||Infinity)) best=pos;
      const acc=Math.round(best.coords.accuracy||0);
      $('locateBtn').textContent=`GPS ±${acc} m · buscando mejor lectura…`;
      // Con una lectura de 8 m o mejor ya es razonable detener la búsqueda.
      if(samples>=2 && acc<=8) finish();
    },
    err=>{
      if(err.code===1) finish('Permiso de ubicación denegado. Active la ubicación para este sitio.');
      else if(!best && err.code===2) $('locateBtn').textContent='GPS temporalmente no disponible…';
    },
    {enableHighAccuracy:true,timeout:12000,maximumAge:0}
  );
  // Si no alcanza una precisión excelente, se utiliza la mejor lectura recogida durante 10 segundos.
  gpsTimer=setTimeout(()=>finish(),10000);
}

function showBoundaryError(msg){
  const el=$('boundaryAlert'); el.textContent=msg; el.className='alert error';
}

function analyzeLocation(loc) {
  const exactBarrio=containingFeature(state.barrios,loc);
  const exactParroquia=containingFeature(state.parroquias,loc);
  const gpsAccuracy=Math.max(0,Number(loc.accuracy||0));
  const probableThreshold=Math.max(12,gpsAccuracy*1.35);

  let barrio=exactBarrio, barrioProbable=false, barrioDistance=Infinity;
  if(!barrio){
    const near=nearestOtherFeature(state.barrios,loc,null);
    if(near.feature && near.distance<=probableThreshold){barrio=near.feature;barrioProbable=true;barrioDistance=near.distance;}
  }else barrioDistance=featureBoundaryDistance(barrio,loc);

  let parroquia=exactParroquia, parroquiaProbable=false;
  if(!parroquia){
    const near=nearestOtherFeature(state.parroquias,loc,null);
    if(near.feature && near.distance<=probableThreshold){parroquia=near.feature;parroquiaProbable=true;}
  }

  state.currentTerritory={barrio,parroquia,barrioProbable,parroquiaProbable};
  $('locHeadline').textContent='Ubicación territorial identificada';
  $('barrioValue').textContent=barrio ? `${pointName(barrio)}${barrioProbable?' (probable)':''}` : 'Fuera de polígonos';
  $('parroquiaValue').textContent=parroquia ? `${pointName(parroquia)}${parroquiaProbable?' (probable)':''}` : 'Fuera de polígonos';
  $('precisionValue').textContent=`±${Math.round(gpsAccuracy)} m`;
  $('coordinatesValue').textContent=`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
  $('accuracyBadge').textContent=(gpsAccuracy<=10?'GPS alta':gpsAccuracy<=25?'GPS media':'GPS baja');

  const alert=$('boundaryAlert');
  if(exactBarrio){
    const d=barrioDistance;
    $('limiteValue').textContent=formatMeters(d);
    const threshold=Math.max(12,gpsAccuracy*1.35);
    if(d<=threshold){
      const neighbor=nearestOtherFeature(state.barrios,loc,exactBarrio);
      const n=neighbor.feature && neighbor.distance<Math.max(40,threshold*2) ? ` con ${pointName(neighbor.feature)}` : '';
      alert.className='alert warning';
      alert.textContent=`Ubicación cercana a un límite barrial${n}. Precisión GPS ±${Math.round(gpsAccuracy)} m; confirme visualmente si la intervención está exactamente sobre el lindero.`;
    }else alert.classList.add('hidden');
  }else if(barrioProbable){
    $('limiteValue').textContent=formatMeters(barrioDistance);
    alert.className='alert warning';
    alert.textContent=`La coordenada puntual quedó fuera del polígono, pero está a ${formatMeters(barrioDistance)} de ${pointName(barrio)} y el GPS reporta una precisión de ±${Math.round(gpsAccuracy)} m. Se muestra como barrio probable; actualice el GPS al aire libre para confirmar.`;
  }else{
    $('limiteValue').textContent='—';
    alert.className='alert warning';
    alert.textContent=`La mejor coordenada disponible no coincide con un polígono barrial y tampoco queda dentro del margen de error GPS (±${Math.round(gpsAccuracy)} m). Pruebe nuevamente al aire libre o revise la cobertura cartográfica.`;
  }

  const near=nearestCritical(loc); state.nearestPoint=near.point;
  if(near.point){
    $('nearestTitle').textContent=`${near.point.codigo} · ${near.point.barrio}`;
    $('nearestDistance').textContent=formatMeters(near.distance);
    $('nearestDetails').innerHTML=`<strong>${escapeHtml(near.point.referencia||'Sin referencia')}</strong><br>${escapeHtml(near.point.parroquia||'')} · Estado: ${escapeHtml(near.point.estado)} · Frecuencia: ${escapeHtml(near.point.frecuencia)}`;
    $('nearestMapBtn').disabled=false; $('nearestRegisterBtn').disabled=false;
  }
}

function renderStats(){
  $('statTotal').textContent=state.puntos.length;
  $('statActive').textContent=state.puntos.filter(p=>p.estado==='Activo').length;
  $('statCoords').textContent=state.puntos.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).length;
}

function populatePointSelect(){
  const sel=$('formPoint');
  sel.innerHTML='<option value="">Seleccione el punto…</option>' + state.puntos.map(p=>`<option value="${escapeHtml(p.codigo)}">${escapeHtml(p.codigo)} · ${escapeHtml(p.barrio)} · ${escapeHtml(p.parroquia)}</option>`).join('');
}

function selectedPoint(){ return state.puntos.find(p=>p.codigo===$('formPoint').value)||null; }

function updateFormAutoFields(){
  const p=selectedPoint();
  const loc=state.currentLocation;
  const territorio=state.currentTerritory;
  const barrioGPS=territorio?.barrio||null, parroquiaGPS=territorio?.parroquia||null;
  $('formParroquia').value=loc&&parroquiaGPS?pointName(parroquiaGPS):(p?.parroquia||'');
  $('formBarrio').value=loc&&barrioGPS?pointName(barrioGPS):(p?.barrio||'');
  $('formReferencia').value=p?.referencia||'';
  const lat=loc?.lat ?? p?.lat, lng=loc?.lng ?? p?.lng;
  $('formCoords').value=(Number.isFinite(lat)&&Number.isFinite(lng))?`${lat.toFixed(6)}, ${lng.toFixed(6)}`:'Sin coordenadas';
  $('formTipoPropiedad').value=p?.tipo_propiedad||'Sin dato';
}

function buildWasteGrid(){
  const grid=$('wasteGrid');
  grid.innerHTML='';
  for(const [i,name] of WASTE_TYPES.entries()){
    const row=document.createElement('div');row.className='waste-row';
    const label=document.createElement('label');label.textContent=name;label.htmlFor=`waste_${i}`;
    const select=document.createElement('select');select.id=`waste_${i}`;select.dataset.waste=name;
    for(let v=0;v<=100;v+=10){const o=document.createElement('option');o.value=v;o.textContent=`${v}%`;select.appendChild(o);}
    select.addEventListener('change',updateWasteTotal);row.append(label,select);grid.appendChild(row);
  }
  updateWasteTotal();
}

function updateWasteTotal(){
  const total=[...document.querySelectorAll('#wasteGrid select')].reduce((s,e)=>s+Number(e.value||0),0);
  const chip=$('wasteTotal');chip.textContent=`Total ${total}%`;chip.className=`sum-chip ${total===100?'valid':'invalid'}`;
  return total;
}

function setPointForRegistration(code){
  if(!supervisorSessionActive()){
    openAuthModal(()=>setPointForRegistration(code));
    return;
  }
  switchTab('Registro', true);
  $('formPoint').value=code||'';
  updateFormAutoFields();
  window.scrollTo({top:0,behavior:'smooth'});
}

function switchTab(name, authorizedBypass=false){
  const protectedTab = name==='Registro' || name==='Pendientes';
  if(protectedTab && !authorizedBypass && !supervisorSessionActive()){
    openAuthModal(()=>switchTab(name, true));
    return false;
  }
  document.querySelectorAll('.tab-panel').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
  const panel=$(`tab${name}`); if(panel) panel.classList.add('active');
  const btn=document.querySelector(`.nav-item[data-tab="${name}"]`); if(btn) btn.classList.add('active');
  if(name==='Mapa') setTimeout(()=>{renderMap(); if(state.currentLocation) centerMapOn(state.currentLocation,0.025);},20);
  if(name==='Pendientes') refreshPendingList();
  return true;
}

function pointStatusClass(estado=''){
  if(estado==='Activo')return 'active';
  if(estado==='Eliminado')return 'eliminated';
  return 'inactive';
}

function pointStatusColor(estado=''){
  if(estado==='Activo')return '#d83434';      // rojo
  if(estado==='Eliminado')return '#2f9e57';  // verde
  return '#f2c94c';                           // amarillo
}

function geometryPath(geometry){
  const ringPath = ring => ring.length ? `M ${ring.map(c=>`${c[0]} ${-c[1]}`).join(' L ')} Z` : '';
  if(geometry.type==='Polygon') return geometry.coordinates.map(ringPath).join(' ');
  if(geometry.type==='MultiPolygon') return geometry.coordinates.map(poly=>poly.map(ringPath).join(' ')).join(' ');
  return '';
}

function datasetBounds(){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const f of state.parroquias.features){const b=f._bbox;minX=Math.min(minX,b[0]);maxX=Math.max(maxX,b[2]);minY=Math.min(minY,b[1]);maxY=Math.max(maxY,b[3]);}
  return {x:minX,y:-maxY,width:maxX-minX,height:maxY-minY};
}

function initLeafletMap(){
  if(state.map.leaflet || !window.L) return Boolean(state.map.leaflet);
  const host=$('leafletMap');
  if(!host)return false;
  try{
    const map=L.map(host,{zoomControl:true,touchZoom:true,doubleClickZoom:true,scrollWheelZoom:true,dragging:true,preferCanvas:true,minZoom:10,maxZoom:19});
    state.map.leaflet=map;
    state.map.baseLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,
      attribution:'&copy; OpenStreetMap contributors',
      crossOrigin:true
    }).addTo(map);

    state.map.parishLayer=L.geoJSON(state.parroquias,{
      style:()=>({color:'#087d79',weight:2,opacity:.9,dashArray:'6 5',fillColor:'#0d7a76',fillOpacity:.025}),
      onEachFeature:(f,l)=>l.bindTooltip(pointName(f),{sticky:true,direction:'top'})
    }).addTo(map);
    state.map.barrioLayer=L.geoJSON(state.barrios,{
      style:()=>({color:'#557b8d',weight:1.35,opacity:.9,fillColor:'#ffffff',fillOpacity:.07}),
      onEachFeature:(f,l)=>l.bindTooltip(pointName(f),{sticky:true,direction:'top'})
    }).addTo(map);
    state.map.pointLayer=L.layerGroup().addTo(map);
    state.map.userLayer=L.layerGroup().addTo(map);
    state.map.pointMarkers=new Map();

    const bounds=state.map.barrioLayer.getBounds();
    if(bounds?.isValid()) map.fitBounds(bounds.pad(.04));
    else map.setView([-0.96,-80.72],13);

    state.map.baseLayer.on('tileerror',()=>{
      if(!navigator.onLine) showMapBaseStatus('Sin conexión: el mapa vial no está disponible; las capas institucionales siguen funcionando.');
    });
    state.map.baseLayer.on('load',()=>{ if(navigator.onLine) hideMapBaseStatus(); });
    host.classList.remove('hidden');
    $('fallbackVectorMap').classList.add('hidden');
    setTimeout(()=>map.invalidateSize(),30);
    return true;
  }catch(e){
    console.error('Leaflet no pudo iniciarse',e);
    state.map.leaflet=null;
    return false;
  }
}

function showMapBaseStatus(message){
  const el=$('mapBaseStatus'); if(!el)return;
  el.textContent=message; el.classList.remove('hidden');
}
function hideMapBaseStatus(){ const el=$('mapBaseStatus'); if(el)el.classList.add('hidden'); }

function renderFallbackMap(){
  $('leafletMap')?.classList.add('hidden');
  $('fallbackVectorMap')?.classList.remove('hidden');
  if(!state.map.initial){
    const b=datasetBounds(); const pad=.005;
    state.map.initial={x:b.x-pad,y:b.y-pad,width:b.width+2*pad,height:b.height+2*pad};
    state.map.view={...state.map.initial};
  }
  applyViewBox();
  const parish=$('parishLayer'), barrios=$('barrioLayer');
  if(parish && !parish.dataset.rendered){
    parish.innerHTML=state.parroquias.features.map((f,i)=>`<path class="parish-shape" data-i="${i}" d="${geometryPath(f.geometry)}"><title>${escapeHtml(pointName(f))}</title></path>`).join('');
    parish.dataset.rendered='1';
  }
  if(barrios && !barrios.dataset.rendered){
    barrios.innerHTML=state.barrios.features.map((f,i)=>`<path class="barrio-shape" data-i="${i}" d="${geometryPath(f.geometry)}"><title>${escapeHtml(pointName(f))}</title></path>`).join('');
    barrios.dataset.rendered='1';
  }
  renderPointLayer(); drawUserLocation(); setLayerVisibility();
  showMapBaseStatus('Mapa vial no disponible. Se muestra el mapa territorial simplificado almacenado en el dispositivo.');
}

function renderMap(){
  if(!state.parroquias||!state.barrios)return;
  if(initLeafletMap()){
    renderPointLayer(); drawUserLocation(); setLayerVisibility();
    setTimeout(()=>state.map.leaflet.invalidateSize(),40);
    if(!navigator.onLine) showMapBaseStatus('Sin conexión: barrios, parroquias, puntos y GPS siguen disponibles; el fondo vial puede no mostrarse.');
  }else renderFallbackMap();
}

function renderPointLayer(){
  const filter=$('estadoFilter')?.value||'Todos';
  const pts=state.puntos.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&(filter==='Todos'||p.estado===filter));

  if(state.map.leaflet && window.L){
    state.map.pointLayer.clearLayers();
    state.map.pointMarkers=new Map();
    for(const p of pts){
      const marker=L.circleMarker([p.lat,p.lng],{
        radius:8,
        color:'#ffffff',weight:2.5,opacity:1,
        fillColor:pointStatusColor(p.estado),fillOpacity:1
      });
      marker.bindTooltip(`${escapeHtml(p.codigo)} · ${escapeHtml(p.barrio)}`,{direction:'top',offset:[0,-6],opacity:.95});
      marker.on('click',()=>showMapPoint(p.codigo));
      marker.addTo(state.map.pointLayer);
      state.map.pointMarkers.set(p.codigo,marker);
    }
    return;
  }

  const layer=$('pointLayer'); if(!layer)return;
  const r=(state.map.view?.width||.25)/430;
  layer.innerHTML=pts.map(p=>{
    const cls=pointStatusClass(p.estado);
    return `<circle class="point-dot ${cls}" data-code="${escapeHtml(p.codigo)}" cx="${p.lng}" cy="${-p.lat}" r="${r}"><title>${escapeHtml(p.codigo+' · '+p.barrio)}</title></circle>`;
  }).join('');
  layer.querySelectorAll('.point-dot').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();showMapPoint(el.dataset.code);}));
}

function drawUserLocation(){
  const loc=state.currentLocation;
  if(state.map.leaflet && window.L){
    state.map.userLayer.clearLayers();
    if(!loc)return;
    L.circle([loc.lat,loc.lng],{radius:Math.max(4,loc.accuracy||10),color:'#124d70',weight:1.5,opacity:.8,fillColor:'#124d70',fillOpacity:.12,interactive:false}).addTo(state.map.userLayer);
    L.circleMarker([loc.lat,loc.lng],{radius:7,color:'#ffffff',weight:3,fillColor:'#124d70',fillOpacity:1,interactive:false}).addTo(state.map.userLayer);
    return;
  }
  const g=$('userLayer'); if(!g)return;
  if(!loc){g.innerHTML='';return;}
  const r=(state.map.view?.width||.25)/350;
  const accuracyDeg=(loc.accuracy||10)/111320;
  g.innerHTML=`<circle class="user-halo" cx="${loc.lng}" cy="${-loc.lat}" r="${Math.max(r*2.2,accuracyDeg)}"></circle><circle class="user-dot" cx="${loc.lng}" cy="${-loc.lat}" r="${r}"></circle>`;
}

function setLayerVisibility(){
  const barriosOn=$('toggleBarrios')?.checked, parroquiasOn=$('toggleParroquias')?.checked, puntosOn=$('togglePuntos')?.checked;
  if(state.map.leaflet){
    const map=state.map.leaflet;
    const toggle=(layer,on)=>{if(!layer)return;if(on&&!map.hasLayer(layer))layer.addTo(map);if(!on&&map.hasLayer(layer))map.removeLayer(layer);};
    toggle(state.map.barrioLayer,barriosOn); toggle(state.map.parishLayer,parroquiasOn); toggle(state.map.pointLayer,puntosOn);
    return;
  }
  if($('barrioLayer')) $('barrioLayer').style.display=barriosOn?'':'none';
  if($('parishLayer')) $('parishLayer').style.display=parroquiasOn?'':'none';
  if($('pointLayer')) $('pointLayer').style.display=puntosOn?'':'none';
}

function applyViewBox(){
  const v=state.map.view; if(!v||!$('mapSvg'))return;
  $('mapSvg').setAttribute('viewBox',`${v.x} ${v.y} ${v.width} ${v.height}`);
}

function zoomMap(factor,center=null){
  if(state.map.leaflet){
    if(factor<1)state.map.leaflet.zoomIn();else state.map.leaflet.zoomOut();
    return;
  }
  const v=state.map.view;if(!v)return;
  const cx=center?.lng ?? (v.x+v.width/2), cy=center? -center.lat : (v.y+v.height/2);
  const nw=Math.max(.002,Math.min(state.map.initial.width*1.15,v.width*factor));
  const nh=nw*(v.height/v.width);
  const rx=(cx-v.x)/v.width, ry=(cy-v.y)/v.height;
  v.x=cx-rx*nw;v.y=cy-ry*nh;v.width=nw;v.height=nh;
  applyViewBox();renderPointLayer();drawUserLocation();
}

function centerMapOn(loc,width=.02){
  if(!loc)return;
  if(state.map.leaflet){
    const zoom=width<=.013?17:width<=.022?16:15;
    state.map.leaflet.setView([loc.lat,loc.lng],zoom,{animate:true});
    return;
  }
  if(!state.map.view)return;
  const aspect=state.map.view.height/state.map.view.width;
  state.map.view={x:loc.lng-width/2,y:-loc.lat-(width*aspect)/2,width,height:width*aspect};
  applyViewBox();renderPointLayer();drawUserLocation();
}

function showMapPoint(code){
  const p=state.puntos.find(x=>x.codigo===code); if(!p)return;
  state.selectedMapPoint=p;
  const cls=pointStatusClass(p.estado);
  const card=$('mapSelectionCard');card.classList.remove('hidden');
  card.innerHTML=`<div class="point-card-head"><div><p class="eyebrow">${escapeHtml(p.codigo)}</p><h3>${escapeHtml(p.barrio)}</h3></div><span class="status-chip ${cls}">${escapeHtml(p.estado)}</span></div><div class="point-details"><strong>${escapeHtml(p.referencia||'Sin referencia')}</strong><br>${escapeHtml(p.parroquia)} · Frecuencia: ${escapeHtml(p.frecuencia)} · Propiedad: ${escapeHtml(p.tipo_propiedad)}<br>Residuos registrados: ${escapeHtml(p.residuos)}</div><div class="button-row"><button class="secondary-btn" id="mapCenterSelected">Centrar</button><button class="primary-btn" id="mapRegisterSelected">${supervisorSessionActive()?'Registrar evacuación':'🔒 Registrar evacuación'}</button></div>`;
  $('mapCenterSelected').onclick=()=>centerMapOn({lat:p.lat,lng:p.lng},.012);
  $('mapRegisterSelected').onclick=()=>setPointForRegistration(p.codigo);
  if(state.map.leaflet){
    const marker=state.map.pointMarkers.get(p.codigo);
    if(marker){state.map.leaflet.panTo(marker.getLatLng(),{animate:true});marker.openTooltip();}
  }
}

function setupMapPan(){
  const svg=$('mapSvg'); if(!svg)return;
  svg.addEventListener('pointerdown',e=>{
    if(e.target.classList.contains('point-dot'))return;
    state.map.dragging=true;state.map.lastX=e.clientX;state.map.lastY=e.clientY;state.map.moved=false;svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove',e=>{
    if(!state.map.dragging)return;
    const rect=svg.getBoundingClientRect(),v=state.map.view;if(!v)return;
    const dx=(e.clientX-state.map.lastX)/rect.width*v.width;
    const dy=(e.clientY-state.map.lastY)/rect.height*v.height;
    if(Math.abs(e.clientX-state.map.lastX)+Math.abs(e.clientY-state.map.lastY)>2)state.map.moved=true;
    v.x-=dx;v.y-=dy;state.map.lastX=e.clientX;state.map.lastY=e.clientY;applyViewBox();
  });
  const end=e=>{state.map.dragging=false;try{svg.releasePointerCapture(e.pointerId);}catch{}};
  svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
  svg.addEventListener('wheel',e=>{e.preventDefault();zoomMap(e.deltaY>0?1.18:.84);},{passive:false});
}

function openDB(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}

async function dbPut(record){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}
async function dbGetAll(){const db=await openDB();return new Promise((res,rej)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>res(req.result||[]);req.onerror=()=>rej(req.error);});}
async function dbDelete(id){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}

async function compressImage(file){
  if(!file)return null;
  try{
    const bitmap=await createImageBitmap(file);
    const max=1280,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    return await new Promise(resolve=>canvas.toBlob(b=>resolve(b||file),'image/jpeg',.78));
  }catch{return file;}
}

function previewFile(input,img){
  const f=input.files?.[0]; if(!f){img.classList.remove('has-image');img.removeAttribute('src');return;}
  img.src=URL.createObjectURL(f);img.classList.add('has-image');
}

function checkedValues(name){return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(e=>e.value);}
function wasteValues(){const o={};document.querySelectorAll('#wasteGrid select').forEach(e=>o[e.dataset.waste]=Number(e.value||0));return o;}

async function handleSubmit(ev){
  ev.preventDefault();
  if(!supervisorSessionActive()){
    openAuthModal(()=>toast('Acceso restablecido. Revise el formulario y vuelva a guardar.'));
    return;
  }
  const err=$('formError');err.classList.add('hidden');
  const p=selectedPoint();
  const total=updateWasteTotal();
  const issues=[];
  if(!p)issues.push('Seleccione el punto crítico.');
  if(!$('formSupervisor').value)issues.push('Seleccione el supervisor responsable.');
  if(!$('formFuente').value)issues.push('Seleccione la fuente del pedido.');
  if(!state.startAt)issues.push('Marque la hora de inicio.');
  if(!state.endAt)issues.push('Marque la hora de finalización.');
  if(state.startAt&&state.endAt&&new Date(state.endAt)<new Date(state.startAt))issues.push('La finalización no puede ser anterior al inicio.');
  if(total!==100)issues.push('La caracterización de residuos debe sumar 100%.');
  if(!$('formVehicleType').value)issues.push('Seleccione el tipo de vehículo.');
  if(!$('formVehicleOwner').value)issues.push('Seleccione la propiedad del vehículo.');
  if(!$('formTrips').value)issues.push('Ingrese el número de viajes.');
  if(issues.length){err.innerHTML=issues.map(x=>`• ${escapeHtml(x)}`).join('<br>');err.classList.remove('hidden');err.scrollIntoView({behavior:'smooth',block:'center'});return;}

  const before=await compressImage($('photoBefore').files?.[0]);
  const after=await compressImage($('photoAfter').files?.[0]);
  const loc=state.currentLocation;
  const gpsBarrio=loc?containingFeature(state.barrios,loc):null;
  const gpsParroquia=loc?containingFeature(state.parroquias,loc):null;
  const record={
    id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt:new Date().toISOString(),synced:false,
    punto:{codigo:p.codigo,barrioInventario:p.barrio,parroquiaInventario:p.parroquia,referencia:p.referencia,estado:p.estado,frecuencia:p.frecuencia,tipoPropiedad:p.tipo_propiedad},
    supervisor:$('formSupervisor').value,
    territorio:{parroquia:$('formParroquia').value,barrio:$('formBarrio').value,lat:loc?.lat??p.lat,lng:loc?.lng??p.lng,accuracy:loc?.accuracy??null,barrioGPS:gpsBarrio?pointName(gpsBarrio):null,parroquiaGPS:gpsParroquia?pointName(gpsParroquia):null},
    fuente:$('formFuente').value,fuenteOtro:$('formFuenteOtro').value.trim(),terreno:checkedValues('terreno'),
    inicio:state.startAt,fin:state.endAt,residuos:wasteValues(),
    vehiculo:{tipo:$('formVehicleType').value,propiedad:$('formVehicleOwner').value,capacidadM3:Number($('formCapacity').value||0),viajes:Number($('formTrips').value||0)},
    equipo:{tipos:checkedValues('equipo'),propiedad:$('formEquipmentOwner').value},
    observaciones:$('formObservations').value.trim(),photoBefore:before,photoAfter:after
  };
  await dbPut(record);
  toast(navigator.onLine?'Registro guardado; listo para sincronizar':'Registro guardado sin conexión');
  resetFormKeepSupervisor();
  await refreshPendingList();
  switchTab('Pendientes');
}

function resetFormKeepSupervisor(){
  const sup=$('formSupervisor').value;
  $('evacForm').reset();$('formSupervisor').value=sup;state.startAt=null;state.endAt=null;
  $('startDisplay').textContent='No registrado';$('endDisplay').textContent='No registrado';
  buildWasteGrid();$('previewBefore').classList.remove('has-image');$('previewAfter').classList.remove('has-image');
  updateFormAutoFields();
}

async function refreshPendingList(){
  if(!supervisorSessionActive()){
    if($('pendingBadge')) $('pendingBadge').classList.add('hidden');
    if($('syncNotice')) $('syncNotice').textContent='Acceso de supervisor requerido para consultar, sincronizar o eliminar registros guardados.';
    if($('pendingList')) $('pendingList').innerHTML='<div class="home-note"><strong>Contenido protegido.</strong> Ingrese como supervisor para administrar los registros de evacuación almacenados en este dispositivo.</div>';
    return;
  }
  const records=(await dbGetAll()).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const pending=records.filter(r=>!r.synced).length;
  $('pendingBadge').textContent=pending;$('pendingBadge').classList.toggle('hidden',pending===0);
  const endpoint=window.APP_CONFIG?.syncEndpoint?.trim();
  $('syncNotice').textContent=endpoint ? `${pending} registro(s) pendiente(s). Al sincronizar se enviarán los datos y fotografías al servicio configurado.` : `Hay ${pending} registro(s) pendiente(s). La sincronización con Google está preparada, pero falta configurar la URL del Web App de Apps Script.`;
  $('pendingList').innerHTML=records.length?records.map(r=>`<article><div class="point-card-head"><div><p class="eyebrow">${escapeHtml(r.punto.codigo)}</p><h4>${escapeHtml(r.punto.referencia||r.punto.barrioInventario)}</h4></div><span class="sync-state ${r.synced?'synced':''}">${r.synced?'Sincronizado':'Pendiente'}</span></div><div class="pending-meta">${escapeHtml(r.supervisor)} · ${escapeHtml(formatDateTime(r.inicio))}<br>${escapeHtml(r.territorio.barrio||'')} · ${escapeHtml(r.vehiculo.tipo)} · ${r.vehiculo.viajes} viaje(s)</div><div class="record-actions">${r.synced?'':`<button class="secondary-btn compact" data-sync-one="${r.id}">Sincronizar</button>`}<button class="danger-btn" data-delete="${r.id}">Eliminar</button></div></article>`).join(''):'<div class="home-note">Todavía no existen registros guardados en este dispositivo.</div>';
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{if(confirm('¿Eliminar este registro del dispositivo?')){await dbDelete(b.dataset.delete);refreshPendingList();}});
  document.querySelectorAll('[data-sync-one]').forEach(b=>b.onclick=()=>syncRecords(b.dataset.syncOne));
}

function blobToBase64(blob){return new Promise((resolve,reject)=>{if(!blob)return resolve(null);const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob);});}

async function syncRecords(onlyId=null){
  if(!supervisorSessionActive()){openAuthModal(()=>syncRecords(onlyId));return;}
  const endpoint=window.APP_CONFIG?.syncEndpoint?.trim();
  if(!endpoint){toast('Falta configurar el endpoint de Google Apps Script');return;}
  if(!navigator.onLine){toast('No hay conexión a internet');return;}
  const all=await dbGetAll();const list=all.filter(r=>!r.synced&&(!onlyId||r.id===onlyId));
  if(!list.length){toast('No hay registros pendientes');return;}
  $('syncBtn').disabled=true;$('syncBtn').textContent='Enviando…';
  let ok=0,fail=0;
  for(const r of list){
    try{
      const payload={...r,photoBefore:r.photoBefore?{mime:r.photoBefore.type||'image/jpeg',data:await blobToBase64(r.photoBefore)}:null,photoAfter:r.photoAfter?{mime:r.photoAfter.type||'image/jpeg',data:await blobToBase64(r.photoAfter)}:null};
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(payload)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      r.synced=true;r.syncedAt=new Date().toISOString();await dbPut(r);ok++;
    }catch(e){console.error(e);fail++;}
  }
  $('syncBtn').disabled=false;$('syncBtn').textContent='Sincronizar';
  await refreshPendingList();toast(fail?`${ok} enviados · ${fail} con error`:`${ok} registro(s) sincronizado(s)`);
}

function setupEvents(){
  document.querySelector('[data-open-module="puntos"]').onclick=()=>{$('homeScreen').classList.remove('active');$('moduleScreen').classList.add('active');switchTab('Ubicacion');updateAccessUI();};
  $('backHome').onclick=()=>{$('moduleScreen').classList.remove('active');$('homeScreen').classList.add('active');};
  document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  $('logoutSupervisorBtn').onclick=logoutSupervisor;
  $('confirmAuthBtn').onclick=confirmSupervisorAccess;
  $('cancelAuthBtn').onclick=closeAuthModal;
  $('supervisorPin').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();confirmSupervisorAccess();}if(e.key==='Escape')closeAuthModal();});
  $('authModal').addEventListener('click',e=>{if(e.target===$('authModal'))closeAuthModal();});
  $('locateBtn').onclick=locateUser;
  $('nearestMapBtn').onclick=()=>{if(state.nearestPoint){switchTab('Mapa');setTimeout(()=>{showMapPoint(state.nearestPoint.codigo);centerMapOn({lat:state.nearestPoint.lat,lng:state.nearestPoint.lng},.012);},30);}};
  $('nearestRegisterBtn').onclick=()=>state.nearestPoint&&setPointForRegistration(state.nearestPoint.codigo);
  $('formPoint').addEventListener('change',updateFormAutoFields);
  $('markStartBtn').onclick=()=>{state.startAt=new Date().toISOString();$('startDisplay').textContent=formatDateTime(state.startAt);};
  $('markEndBtn').onclick=()=>{state.endAt=new Date().toISOString();$('endDisplay').textContent=formatDateTime(state.endAt);};
  $('photoBefore').onchange=()=>previewFile($('photoBefore'),$('previewBefore'));
  $('photoAfter').onchange=()=>previewFile($('photoAfter'),$('previewAfter'));
  $('evacForm').addEventListener('submit',handleSubmit);
  $('syncBtn').onclick=()=>syncRecords();
  ['toggleBarrios','toggleParroquias','togglePuntos'].forEach(id=>$(id).onchange=setLayerVisibility);
  $('estadoFilter').onchange=renderPointLayer;
  $('zoomInBtn').onclick=()=>zoomMap(.78);$('zoomOutBtn').onclick=()=>zoomMap(1.28);
  $('centerMapBtn').onclick=()=>{if(state.currentLocation)centerMapOn(state.currentLocation,.02);else toast('Primero consulte el GPS');};
  setupMapPan();
}

function updateNetworkStatus(){
  const online=navigator.onLine, pill=$('networkPill');
  pill.classList.toggle('offline',!online);pill.classList.toggle('online',online);
  pill.querySelector('span:last-child').textContent=online?'En línea':'Sin conexión';
  if(state.map.leaflet){
    if(online) hideMapBaseStatus();
    else showMapBaseStatus('Sin conexión: barrios, parroquias, puntos y GPS siguen disponibles; el fondo vial puede no mostrarse.');
  }
  refreshPendingList().catch(()=>{});
}

async function init(){
  setupEvents();updateAccessUI();updateNetworkStatus();
  window.addEventListener('online',updateNetworkStatus);window.addEventListener('offline',updateNetworkStatus);
  try{await loadData();}catch(e){console.error(e);toast('No se pudieron cargar las capas territoriales');}
  updateAccessUI();
  await refreshPendingList();
  setInterval(()=>{
    const wasAuthorized=state.auth.authorized;
    const active=supervisorSessionActive();
    if(wasAuthorized&&!active){
      const protectedOpen=$('tabRegistro').classList.contains('active')||$('tabPendientes').classList.contains('active');
      if(protectedOpen)switchTab('Ubicacion',true);
      updateAccessUI();refreshPendingList().catch(()=>{});toast('La sesión de supervisor finalizó');
    }
  },60000);
  if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('service-worker.js').catch(console.warn);
}

document.addEventListener('DOMContentLoaded',init);

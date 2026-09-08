let map = null;
let robotMarker = null;
let trackLine = null;
let routeLine = null;
let routeMarkers = [];
let routeLabels = [];
let selectedPointIndex = -1;
let route = {name:'route_01', loop:false, points:[]};
let dirty = false;
let firstGpsCenter = true;
let lastTrackCount = -1;
let lastGps = null;

// 天地图部分区域只有到 Z18/Z19 的真实瓦片。
// Z20~Z22 不再请求更高层级瓦片，而是对 Z19 画面做纯前端视觉放大。
const NATIVE_MIN_ZOOM = 3;
const NATIVE_MAX_ZOOM = 19;
const VIRTUAL_MAX_ZOOM = 22;
let logicalZoom = 12;
let virtualScale = 1;
let suppressMapClickUntil = 0;
let interactionMode = 'pan'; // pan | edit
let virtualDrag = null;

const $ = id => document.getElementById(id);
const setSaveState = (text, cls='') => { $('saveStatus').textContent=text; $('saveStatus').className='pill '+cls; };
const isVirtualZoom = () => logicalZoom > NATIVE_MAX_ZOOM;

function setInteractionMode(mode){
  interactionMode = mode === 'edit' ? 'edit' : 'pan';
  document.body.classList.toggle('mode-pan', interactionMode === 'pan');
  document.body.classList.toggle('mode-edit', interactionMode === 'edit');
  if($('panMode')) $('panMode').classList.toggle('active', interactionMode === 'pan');
  if($('editMode')) $('editMode').classList.toggle('active', interactionMode === 'edit');
  try{
    if(map){
      if(interactionMode === 'pan' && map.enableDrag) map.enableDrag();
      if(interactionMode === 'edit' && map.disableDrag) map.disableDrag();
    }
  }catch(e){}
  syncMarkerDragging();
  renderVirtualMarkers();
}

function getVirtualVisualPoint(ll){
  if(!map || !ll || !map.lngLatToContainerPoint) return null;
  const viewport = $('mapViewport');
  if(!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  const p = map.lngLatToContainerPoint(ll);
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  return {
    x: cx + (Number(p.x) - cx) * virtualScale,
    y: cy + (Number(p.y) - cy) * virtualScale
  };
}

function bindVirtualPinDrag(el, index){
  el.addEventListener('pointerdown', ev=>{
    if(interactionMode !== 'edit' || !isVirtualZoom()) return;
    ev.preventDefault(); ev.stopPropagation();
    virtualDrag={index,pointerId:ev.pointerId};
    try{ el.setPointerCapture(ev.pointerId); }catch(e){}
  });
  el.addEventListener('pointermove', ev=>{
    if(!virtualDrag || virtualDrag.pointerId!==ev.pointerId || virtualDrag.index!==index) return;
    const point=visualClientToMapPoint(ev.clientX,ev.clientY);
    if(!point || !map.containerPointToLngLat) return;
    const ll=map.containerPointToLngLat(point);
    if(!ll) return;
    route.points[index].lat=Number(ll.lat);
    route.points[index].lon=Number(ll.lng);
    const vp=getVirtualVisualPoint(new T.LngLat(route.points[index].lon,route.points[index].lat));
    if(vp){ el.style.left=vp.x+'px'; el.style.top=vp.y+'px'; }
    dirty=true; setSaveState('有未保存修改','bad');
  });
  const finish=ev=>{
    if(!virtualDrag || virtualDrag.pointerId!==ev.pointerId || virtualDrag.index!==index) return;
    virtualDrag=null;
    try{ el.releasePointerCapture(ev.pointerId); }catch(e){}
    renderRoute();
  };
  el.addEventListener('pointerup',finish);
  el.addEventListener('pointercancel',finish);
  el.addEventListener('click',ev=>{ ev.preventDefault(); ev.stopPropagation(); selectPoint(index,false); });
}

function renderVirtualMarkers(){
  const layer=$('virtualMarkerLayer');
  if(!layer) return;
  if(!map || !isVirtualZoom()){
    layer.innerHTML='';
    layer.style.display='none';
    return;
  }
  layer.style.display='block';
  layer.innerHTML='';
  route.points.forEach((p,i)=>{
    const vp=getVirtualVisualPoint(new T.LngLat(p.lon,p.lat));
    if(!vp) return;
    const el=document.createElement('div');
    el.className='virtual-pin'+(i===selectedPointIndex?' selected':'');
    el.dataset.label=String(i+1);
    el.style.left=vp.x+'px'; el.style.top=vp.y+'px';
    el.title=`标注点 ${i+1}`;
    bindVirtualPinDrag(el,i);
    layer.appendChild(el);
  });
}

function loadTianditu(tk){
  return new Promise((resolve,reject)=>{
    if(!tk){ reject(new Error('未配置天地图 tk')); return; }
    const s=document.createElement('script');
    s.src='https://api.tianditu.gov.cn/api?v=4.0&tk='+encodeURIComponent(tk);
    s.onload=resolve; s.onerror=()=>reject(new Error('天地图 JS API 加载失败'));
    document.head.appendChild(s);
  });
}

function setMapMode(mode){
  if(!map) return;
  try{
    if(mode === 'satellite'){
      if(typeof TMAP_SATELLITE_MAP !== 'undefined') map.setMapType(TMAP_SATELLITE_MAP);
      else if(typeof TMAP_HYBRID_MAP !== 'undefined') map.setMapType(TMAP_HYBRID_MAP);
      else throw new Error('当前天地图 API 未提供卫星地图常量');
    }else{
      if(typeof TMAP_NORMAL_MAP !== 'undefined') map.setMapType(TMAP_NORMAL_MAP);
      else throw new Error('当前天地图 API 未提供普通地图常量');
    }
    $('normalMap').classList.toggle('active', mode === 'normal');
    $('satelliteMap').classList.toggle('active', mode === 'satellite');
  }catch(e){
    $('mapError').textContent='地图类型切换失败：'+e.message;
    $('mapError').classList.remove('hidden');
  }
}

function getNativeZoom(){
  try{
    const z = Number(map && map.getZoom ? map.getZoom() : logicalZoom);
    return Number.isFinite(z) ? z : 12;
  }catch(e){ return 12; }
}

function updateZoomUi(){
  if(!$('zoomLevel')) return;
  const suffix = isVirtualZoom() ? '*' : '';
  $('zoomLevel').textContent = 'Z' + logicalZoom + suffix;
  $('zoomLevel').title = isVirtualZoom()
    ? `虚拟缩放：使用 Z${NATIVE_MAX_ZOOM} 瓦片放大 ${virtualScale}x`
    : `天地图原生缩放 Z${logicalZoom}`;
  $('zoomOut').disabled = logicalZoom <= NATIVE_MIN_ZOOM;
  $('zoomIn').disabled = logicalZoom >= VIRTUAL_MAX_ZOOM;
  document.body.classList.toggle('virtual-zoom-active', isVirtualZoom());
}

function applyVirtualTransform(){
  const mapEl = $('map');
  if(!mapEl) return;
  virtualScale = isVirtualZoom() ? Math.pow(2, logicalZoom - NATIVE_MAX_ZOOM) : 1;
  mapEl.style.transform = virtualScale === 1 ? '' : `scale(${virtualScale})`;
  mapEl.style.transformOrigin = '50% 50%';
  updateZoomUi();
  requestAnimationFrame(renderVirtualMarkers);
}

function syncMarkerDragging(){
  routeMarkers.forEach(marker=>{
    try{
      if(isVirtualZoom() || interactionMode !== 'edit'){
        if(marker.disableDragging) marker.disableDragging();
      }else{
        if(marker.enableDragging) marker.enableDragging();
      }
    }catch(e){}
  });
}

function setLogicalZoom(target){
  if(!map) return;
  const next = Math.max(NATIVE_MIN_ZOOM, Math.min(VIRTUAL_MAX_ZOOM, Math.round(target)));
  const wasVirtual = isVirtualZoom();
  logicalZoom = next;
  try{
    if(next <= NATIVE_MAX_ZOOM){
      applyVirtualTransform();
      if(map.setZoom) map.setZoom(next);
      else if(map.getCenter) map.centerAndZoom(map.getCenter(), next);
    }else{
      // Z20+ 永远把真实地图钉在 Z19，再做 CSS 视觉放大。
      const native = getNativeZoom();
      if(native !== NATIVE_MAX_ZOOM){
        if(map.setZoom) map.setZoom(NATIVE_MAX_ZOOM);
        else if(map.getCenter) map.centerAndZoom(map.getCenter(), NATIVE_MAX_ZOOM);
      }
      applyVirtualTransform();
    }
  }catch(e){
    console.warn('zoom failed', e);
    applyVirtualTransform();
  }
  syncMarkerDragging();
  if(wasVirtual !== isVirtualZoom()) renderRoute(); else renderVirtualMarkers();
}

function setZoom(delta){
  setLogicalZoom(logicalZoom + delta);
}

function centerAt(ll, desiredLogicalZoom=null){
  if(!map || !ll) return;
  const wasVirtual = isVirtualZoom();
  const z = desiredLogicalZoom == null ? logicalZoom : desiredLogicalZoom;
  const nativeZ = Math.min(NATIVE_MAX_ZOOM, Math.max(NATIVE_MIN_ZOOM, z));
  try{ map.centerAndZoom(ll, nativeZ); }catch(e){ try{ map.panTo(ll); }catch(_){} }
  logicalZoom = Math.max(NATIVE_MIN_ZOOM, Math.min(VIRTUAL_MAX_ZOOM, Math.round(z)));
  applyVirtualTransform();
  syncMarkerDragging();
  if(wasVirtual !== isVirtualZoom()) renderRoute(); else renderVirtualMarkers();
}

function visualClientToMapPoint(clientX, clientY){
  const viewport = $('mapViewport');
  if(!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  const vx = clientX - rect.left;
  const vy = clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  return new T.Point(
    cx + (vx - cx) / virtualScale,
    cy + (vy - cy) / virtualScale
  );
}

function addRoutePoint(lat, lon){
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  route.points.push({id:Date.now(), lat, lon, type:'via'});
  selectedPointIndex = route.points.length - 1;
  dirty=true;
  setSaveState('有未保存修改','bad');
  renderRoute();
}

function initMap(){
  // 真实天地图最大只请求到 Z19；Z20~22 由前端虚拟放大实现。
  map = new T.Map('map', {minZoom: NATIVE_MIN_ZOOM, maxZoom: NATIVE_MAX_ZOOM});
  map.centerAndZoom(new T.LngLat(116.40769,39.89945), 12);
  logicalZoom = 12;
  map.enableScrollWheelZoom();

  map.addEventListener('zoomend', ()=>{
    // 只有非虚拟缩放时才跟随天地图原生层级。
    if(!isVirtualZoom()){
      logicalZoom = Math.max(NATIVE_MIN_ZOOM, Math.min(NATIVE_MAX_ZOOM, Math.round(getNativeZoom())));
      virtualScale = 1;
      applyVirtualTransform();
    }
  });

  // 原生 Z3~Z19 的点击继续使用天地图事件。
  map.addEventListener('click', e => {
    if(isVirtualZoom() || interactionMode !== 'edit') return;
    if(Date.now() < suppressMapClickUntil) return;
    addRoutePoint(e.lnglat.lat, e.lnglat.lng);
  });

  const viewport = $('mapViewport');
  if(viewport){
    // 在 Z20+，屏幕已经被放大，需要把视觉坐标除以虚拟倍率后再转经纬度。
    viewport.addEventListener('click', ev=>{
      if(!isVirtualZoom() || !map || interactionMode !== 'edit') return;
      if(ev.target && ev.target.closest && ev.target.closest('button')) return;
      const point = visualClientToMapPoint(ev.clientX, ev.clientY);
      if(!point || !map.containerPointToLngLat) return;
      const ll = map.containerPointToLngLat(point);
      if(ll) addRoutePoint(Number(ll.lat), Number(ll.lng));
      suppressMapClickUntil = Date.now() + 120;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    // 鼠标滚轮在 Z19 继续向上时进入虚拟 Z20~22；向下则回到原生层级。
    viewport.addEventListener('wheel', ev=>{
      if(!map) return;
      const dy = ev.deltaY;
      if((logicalZoom >= NATIVE_MAX_ZOOM && dy < 0) || isVirtualZoom()){
        ev.preventDefault();
        ev.stopPropagation();
        setLogicalZoom(logicalZoom + (dy < 0 ? 1 : -1));
      }
    }, {passive:false, capture:true});
  }
  try{ map.addEventListener('move', renderVirtualMarkers); }catch(e){}
  try{ map.addEventListener('moveend', renderVirtualMarkers); }catch(e){}
  setInteractionMode('pan');
  updateZoomUi();
}

function clearRouteOverlays(){
  routeMarkers.forEach(m=>map.removeOverLay(m));
  routeLabels.forEach(l=>map.removeOverLay(l));
  routeMarkers=[];
  routeLabels=[];
}

function createMarker(p, index){
  const ll = new T.LngLat(p.lon,p.lat);
  const marker = new T.Marker(ll);
  map.addOverLay(marker);
  if(interactionMode === 'edit' && marker.enableDragging) marker.enableDragging();
  else if(marker.disableDragging) marker.disableDragging();
  marker.addEventListener('click', ()=>selectPoint(index, true));
  marker.addEventListener('dragend', e=>{
    // 虚拟 Z20+ 禁止拖动，避免第三方地图内部拖动坐标未考虑 CSS scale。
    if(isVirtualZoom()) return;
    route.points[index].lon=e.lnglat.lng;
    route.points[index].lat=e.lnglat.lat;
    selectedPointIndex=index;
    dirty=true; setSaveState('有未保存修改','bad'); renderRoute();
  });

  try{
    const label = new T.Label({
      text:String(index+1),
      position:ll,
      offset:new T.Point(-11,-34)
    });
    label.setBackgroundColor(index===selectedPointIndex ? '#155eef' : '#ffffff');
    label.setFontColor(index===selectedPointIndex ? '#ffffff' : '#172033');
    label.setBorderColor(index===selectedPointIndex ? '#155eef' : '#98a2b3');
    label.setLineHeight(22);
    label.setFontSize(12);
    label.setFontWeight('bold');
    label.addEventListener('click', ()=>selectPoint(index, true));
    map.addOverLay(label);
    routeLabels.push(label);
  }catch(e){ console.warn('point label unavailable', e); }
  return marker;
}

function renderRoute(){
  if(!map) return;
  if(routeLine){ map.removeOverLay(routeLine); routeLine=null; }
  clearRouteOverlays();
  if(!isVirtualZoom()) route.points.forEach((p,i)=>routeMarkers.push(createMarker(p,i)));

  const pts=route.points.map(p=>new T.LngLat(p.lon,p.lat));
  if(route.loop && pts.length>2) pts.push(pts[0]);
  if(pts.length>=2){
    routeLine=new T.Polyline(pts,{weight:5,opacity:.9});
    map.addOverLay(routeLine);
  }

  $('routeName').value=route.name||'route_01';
  $('loop').checked=!!route.loop;
  $('pointCount').textContent=`${route.points.length} 点`;
  renderPointList();
  syncMarkerDragging();
  renderVirtualMarkers();
}

function renderPointList(){
  if(!route.points.length){
    $('pointList').innerHTML='<div class="empty-points">暂无标注点<br><span>在地图上点击即可添加</span></div>';
    return;
  }
  $('pointList').innerHTML=route.points.map((p,i)=>`
    <div class="point ${i===selectedPointIndex?'selected':''}" data-select="${i}">
      <div class="point-index">${i+1}</div>
      <div class="point-main">
        <div class="point-name">标注点 ${i+1}</div>
        <div class="coord">${p.lat.toFixed(7)}, ${p.lon.toFixed(7)}</div>
      </div>
      <button class="point-delete" data-delete="${i}" title="删除">×</button>
    </div>`).join('');

  $('pointList').querySelectorAll('[data-select]').forEach(row=>{
    row.onclick=(e)=>{
      if(e.target.closest('[data-delete]')) return;
      selectPoint(Number(row.dataset.select), true);
    };
  });
  $('pointList').querySelectorAll('[data-delete]').forEach(btn=>{
    btn.onclick=(e)=>{
      e.stopPropagation();
      const i=Number(btn.dataset.delete);
      route.points.splice(i,1);
      if(selectedPointIndex===i) selectedPointIndex=-1;
      else if(selectedPointIndex>i) selectedPointIndex--;
      dirty=true;setSaveState('有未保存修改','bad');renderRoute();
    };
  });
}

function selectPoint(index, center){
  if(index<0 || index>=route.points.length) return;
  selectedPointIndex=index;
  renderRoute();
  if(center){
    const p=route.points[index];
    // 保留用户当前虚拟放大倍率；若当前较远则至少拉到 Z19。
    const targetZoom = Math.max(logicalZoom, NATIVE_MAX_ZOOM);
    centerAt(new T.LngLat(p.lon,p.lat), Math.min(VIRTUAL_MAX_ZOOM, targetZoom));
  }
  const row=$('pointList').querySelector(`[data-select="${index}"]`);
  if(row) row.scrollIntoView({block:'nearest',behavior:'smooth'});
}

function setGpsUi(state, reason, gps){
  if(state==='ok' && gps){
    $('gpsStatus').textContent='GPS 正常';
    $('gpsStatus').className='pill ok';
    $('lat').textContent=gps.lat.toFixed(8);
    $('lon').textContent=gps.lon.toFixed(8);
    $('alt').textContent=gps.alt==null?'--':gps.alt.toFixed(2)+' m';
    return;
  }
  if(state==='weak'){
    $('gpsStatus').textContent='卫星信号弱';
    $('gpsStatus').className='pill warn';
    $('lat').textContent='--'; $('lon').textContent='--'; $('alt').textContent='--';
    return;
  }
  $('gpsStatus').textContent='等待 /fix';
  $('gpsStatus').className='pill bad';
  $('lat').textContent='--'; $('lon').textContent='--'; $('alt').textContent='--';
}

function updateRobot(gps){
  if(!map || !gps) return;
  lastGps=gps;
  const ll=new T.LngLat(gps.lon,gps.lat);
  if(!robotMarker){ robotMarker=new T.Marker(ll); map.addOverLay(robotMarker); }
  else robotMarker.setLngLat(ll);
  if(firstGpsCenter){ centerAt(ll,NATIVE_MAX_ZOOM); firstGpsCenter=false; }
}

function updateTrack(track){
  if(!map || !track || track.length===lastTrackCount) return;
  lastTrackCount=track.length;
  if(trackLine){ map.removeOverLay(trackLine); trackLine=null; }
  if(track.length>=2){ trackLine=new T.Polyline(track.map(p=>new T.LngLat(p.lon,p.lat)),{weight:3,opacity:.8}); map.addOverLay(trackLine); }
}

async function poll(){
  try{
    const r=await fetch('/api/state',{cache:'no-store'}); const s=await r.json();
    setGpsUi(s.gps_state || (s.gps?'ok':'waiting'), s.gps_reason, s.gps);
    if(s.gps_state==='ok' && s.gps) updateRobot(s.gps);
    updateTrack(s.track||[]);
  }catch(e){
    $('gpsStatus').textContent='Web/ROS 断开';$('gpsStatus').className='pill bad';
  }
}

async function saveRoute(){
  route.name=$('routeName').value.trim()||'route_01'; route.loop=$('loop').checked;
  const r=await fetch('/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(route)});
  const d=await r.json(); if(!d.ok) throw new Error(d.error||'保存失败'); route=d.route; dirty=false; setSaveState('已保存','ok'); renderRoute();
}

(async function(){
  try{
    const cfg=await (await fetch('/api/config')).json();
    await loadTianditu(cfg.tianditu_tk); initMap();
    route=await (await fetch('/api/route')).json(); renderRoute();
    setSaveState('已加载','ok');
  }catch(e){ $('mapError').textContent=e.message+'。请在 launch 中设置 tianditu_tk，或设置环境变量 TIANDITU_TK。'; $('mapError').classList.remove('hidden'); }

  $('normalMap').onclick=()=>setMapMode('normal');
  $('satelliteMap').onclick=()=>setMapMode('satellite');
  $('panMode').onclick=()=>setInteractionMode('pan');
  $('editMode').onclick=()=>setInteractionMode('edit');
  $('zoomOut').onclick=()=>setZoom(-1);
  $('zoomIn').onclick=()=>setZoom(1);
  $('routeName').oninput=()=>{route.name=$('routeName').value;dirty=true;setSaveState('有未保存修改','bad')};
  $('loop').onchange=()=>{route.loop=$('loop').checked;dirty=true;setSaveState('有未保存修改','bad');renderRoute()};
  $('saveRoute').onclick=()=>saveRoute().catch(e=>alert(e.message));
  $('clearRoute').onclick=()=>{if(confirm('清空当前路线？')){route.points=[];selectedPointIndex=-1;dirty=true;setSaveState('有未保存修改','bad');renderRoute();}};
  $('centerRobot').onclick=()=>{if(lastGps&&map) centerAt(new T.LngLat(lastGps.lon,lastGps.lat), Math.max(logicalZoom,NATIVE_MAX_ZOOM));};
  $('clearTrack').onclick=async()=>{await fetch('/api/track/clear',{method:'POST'});lastTrackCount=-1;updateTrack([])};
  setInterval(poll,1000); poll();
})();

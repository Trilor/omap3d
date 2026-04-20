/**
 * mapContextMenu.js — 地図右クリックメニュー
 *
 * 使い方: init(map, { isPcSimActive }) を起動直後に呼ぶ。
 *   isPcSimActive() — PCシム中かどうかを返す関数
 */

/**
 * @param {maplibregl.Map} map
 * @param {{ isPcSimActive: () => boolean }} callbacks
 */
export function init(map, { isPcSimActive }) {
  const menu    = document.getElementById('map-context-menu');
  const anchor  = document.getElementById('ctx-open-googlemap');
  const copyBtn = document.getElementById('ctx-copy-link');
  if (!menu || !anchor || !copyBtn) return;

  let _lat = 0, _lng = 0;

  map.on('contextmenu', (e) => {
    if (isPcSimActive()) return;
    ({ lng: _lng, lat: _lat } = e.lngLat);
    const z = map.getZoom().toFixed(2);
    anchor.href = `https://www.google.com/maps/@${_lat.toFixed(6)},${_lng.toFixed(6)},${z}z`;
    // SVG アイコンは textContent で消えるため innerHTML で再挿入
    copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>この地点のリンクをコピー`;
    menu.style.left = `${e.originalEvent.clientX}px`;
    menu.style.top  = `${e.originalEvent.clientY}px`;
    menu.style.display = 'block';
    e.originalEvent.preventDefault();
    e.originalEvent.stopPropagation();
  });

  // MapLibre の hash と同じ形式 #zoom/lat/lng[/bearing[/pitch]] で URL 生成
  copyBtn.addEventListener('click', () => {
    const z = Math.round(map.getZoom()    * 100) / 100;
    const b = Math.ceil (map.getBearing() *  10) /  10;
    const p = Math.ceil (map.getPitch()   *  10) /  10;
    const lat4 = Math.ceil(_lat * 10000) / 10000;
    const lng4 = Math.ceil(_lng * 10000) / 10000;
    const parts = [z, lat4, lng4];
    if (b || p) parts.push(b);
    if (p)      parts.push(p);
    const url = `${window.location.origin}${window.location.pathname}#${parts.join('/')}`;
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>コピーしました`;
      setTimeout(() => { menu.style.display = 'none'; }, 800);
    });
  });

  document.addEventListener('click',       () => { menu.style.display = 'none'; });
  document.addEventListener('contextmenu', () => { menu.style.display = 'none'; });
  map.on('movestart', () => { menu.style.display = 'none'; });
}

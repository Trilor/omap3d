/* ================================================================
   attribution.js — MapLibre 出典パネルの動的管理
   init(map, { getBasemap, getOverlay }) で状態ゲッターを注入する
   ================================================================ */

import { BASEMAPS, REGIONAL_CS_LAYERS } from './config.js';

let _map        = null;
let _getBasemap = () => 'orilibre';
let _getOverlay = () => 'none';

export function init(map, { getBasemap, getOverlay }) {
  _map        = map;
  _getBasemap = getBasemap;
  _getOverlay = getOverlay;
}

// ---- 状態 ----
let _lastAttrKey  = null;
let _attrObserver = null;

// ---- ベースマップ出典 ----
export function updateBasemapAttribution() {
  const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
  if (!attrInner) return;
  let attrEl = document.getElementById('basemap-attr');
  if (!attrEl) {
    attrEl = document.createElement('span');
    attrEl.id = 'basemap-attr';
    attrInner.insertBefore(attrEl, attrInner.firstChild);
  } else if (attrEl.parentNode !== attrInner) {
    attrInner.insertBefore(attrEl, attrInner.firstChild);
  }
  const attr = BASEMAPS[_getBasemap()]?.attr;
  attrEl.innerHTML = attr ? attr + ' | ' : '';
}

// ---- MapLibre が出典を書き換えるたびに追加出典を再挿入する MutationObserver ----
export function initAttributionObserver() {
  const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
  if (!attrInner) return false;
  if (_attrObserver) _attrObserver.disconnect();
  _attrObserver = new MutationObserver(() => {
    _attrObserver.disconnect();
    updateBasemapAttribution();
    updatePlateauAttribution();
    updateMagneticAttribution();
    _attrObserver.observe(attrInner, { childList: true, subtree: true });
  });
  _attrObserver.observe(attrInner, { childList: true, subtree: true });
  updateBasemapAttribution();
  updatePlateauAttribution();
  updateMagneticAttribution();
  return true;
}

// ---- 都道府県別CS出典（ビューポートと重なる地域のみ表示） ----
export function updateRegionalAttribution() {
  let attrEl = document.getElementById('regional-cs-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'regional-cs-attr';
    attrInner.appendChild(attrEl);
  }
  const overlay = _getOverlay();
  const basemap = _getBasemap();
  const key     = overlay !== 'none' ? overlay : basemap;
  const csOn    = (key === 'cs' || key === 'cs-0.5m') && _map.getZoom() >= 16;
  if (!csOn) {
    attrEl.innerHTML = '';
    _lastAttrKey = null;
    return;
  }
  const z = _map.getZoom();
  const b = _map.getBounds();
  const cacheKey = `${z.toFixed(1)},${b.getWest().toFixed(2)},${b.getSouth().toFixed(2)},${b.getEast().toFixed(2)},${b.getNorth().toFixed(2)}`;
  if (cacheKey === _lastAttrKey) return;
  _lastAttrKey = cacheKey;
  const html = REGIONAL_CS_LAYERS
    .filter(l =>
      z >= 16 &&
      b.getWest()  < l.bounds[2] &&
      b.getEast()  > l.bounds[0] &&
      b.getSouth() < l.bounds[3] &&
      b.getNorth() > l.bounds[1]
    )
    .map(l => l.attribution)
    .join(' | ');
  attrEl.innerHTML = html ? ' | ' + html : '';
}

// ---- PLATEAU 出典 ----
export function updatePlateauAttribution() {
  let attrEl = document.getElementById('plateau-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'plateau-attr';
    attrInner.appendChild(attrEl);
  }
  const buildingOn  = document.getElementById('building3d-card')?.classList.contains('active') ?? false;
  const mode        = document.getElementById('sel-building')?.value ?? 'plateau';
  const plateauLink = ' | <a href="https://www.mlit.go.jp/plateau/open-data/" target="_blank">国土交通省3D都市モデルPLATEAU</a>';
  const areaLabel   = document.getElementById('plateau-area-label')?.textContent ?? '';
  attrEl.innerHTML = !buildingOn ? ''
    : mode === 'plateau'          ? plateauLink + '（<a href="https://github.com/shiwaku/mlit-plateau-bldg-pmtiles" target="_blank">shiwaku</a>加工）'
    : mode === 'plateau-lod2-api' ? plateauLink + (areaLabel && areaLabel !== '—' ? `（${areaLabel} LOD2）` : '（LOD2）')
    : mode === 'plateau-lod3-api' ? plateauLink + (areaLabel && areaLabel !== '—' ? `（${areaLabel} LOD3）` : '（LOD3）')
    : '';
}

// ---- 磁北線出典 ----
const MAGNETIC_ATTRIBUTIONS = {
  wmm2020: '<a href="https://www.ngdc.noaa.gov/geomag/WMM/" target="_blank" rel="noopener">WMM2020/NOAA</a>を加工して作成',
  wmm2025: '<a href="https://www.ngdc.noaa.gov/geomag/WMM/" target="_blank" rel="noopener">WMM2025/NOAA</a>を加工して作成',
  gsi2020: '<a href="https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html" target="_blank" rel="noopener">国土地理院 地磁気値(2020.0年値)</a>を加工して作成',
};

export function updateMagneticAttribution() {
  let attrEl = document.getElementById('magnetic-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'magnetic-attr';
    attrInner.appendChild(attrEl);
  }
  const isOn  = document.getElementById('magnetic-card')?.classList.contains('active') ?? false;
  const model = document.getElementById('sel-magnetic-model')?.value ?? 'wmm2025';
  attrEl.innerHTML = isOn ? ' | ' + (MAGNETIC_ATTRIBUTIONS[model] ?? '') : '';
}

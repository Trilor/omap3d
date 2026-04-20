/* ================================================================
   reliefOverlay.js — 色別標高・傾斜・曲率リリーフ
     スライダー UI・DEM サンプリング・タイル同期・パレットピッカー
   ================================================================ */

import {
  QCHIZU_DEM_BASE, DEM5A_BASE,
  RELIEF_PALETTES,
  REGIONAL_RELIEF_LAYERS, REGIONAL_SLOPE_LAYERS, REGIONAL_CURVE_LAYERS,
} from './config.js';
import {
  SLOPE_DATA_MIN, SLOPE_DATA_MAX,
  RELIEF_DATA_MIN, RELIEF_DATA_MAX,
  CURVE_DATA_MIN,  CURVE_DATA_MAX,
} from './protocols.js';
import {
  generateSlopeDataTile, generateReliefDataTile, generateCurveDataTile,
} from './protocols.js';
import {
  COLOR_CONTOUR_Q_IDS, COLOR_CONTOUR_DEM5A_IDS, COLOR_CONTOUR_DEM1A_IDS,
  buildColorContourExpr,
} from './contours.js';

// ---- モジュール状態 ----
let _map = null;
let _getCurrentOverlay = () => 'none';

export function init(map, { getCurrentOverlay }) {
  _map = map;
  _getCurrentOverlay = getCurrentOverlay;
}

// ================================================================
// パレット共通ユーティリティ
// ================================================================

// パレット ID → stops を返す（存在しない場合は rainbow にフォールバック）
export function getReliefPalette(id) {
  return (RELIEF_PALETTES.find(p => p.id === id) ?? RELIEF_PALETTES[0]).stops;
}

// stops → CSS グラデーション文字列
function paletteGradientCss(stops) {
  return `linear-gradient(to right, ${stops.map(p => `rgb(${p.r},${p.g},${p.b}) ${(p.t * 100).toFixed(1)}%`).join(', ')})`;
}

// グラデーショントラック共通描画
function _applyGradientTrack(trackEl, selectedEl, valMin, valMax, sliderMin, sliderMax, palette) {
  if (!trackEl) return;
  const range = sliderMax - sliderMin || 1;
  const L = Math.max(0, Math.min(1, (valMin - sliderMin) / range)) * 100;
  const R = Math.max(0, Math.min(1, (valMax - sliderMin) / range)) * 100;

  const c0 = `rgb(${palette[0].r},${palette[0].g},${palette[0].b})`;
  const c1 = `rgb(${palette[palette.length-1].r},${palette[palette.length-1].g},${palette[palette.length-1].b})`;

  const stops = [`${c0} 0%`, `${c0} ${L.toFixed(2)}%`];
  for (const p of palette) {
    stops.push(`rgb(${p.r},${p.g},${p.b}) ${(L + p.t * (R - L)).toFixed(2)}%`);
  }
  stops.push(`${c1} ${R.toFixed(2)}%`, `${c1} 100%`);
  trackEl.style.background = `linear-gradient(to right, ${stops.join(', ')})`;

  if (selectedEl) {
    const W = trackEl.offsetWidth;
    const selectedH = selectedEl.offsetHeight || 14;
    const radius = selectedH / 2;
    const posMin = (L / 100) * W;
    const posMax = (R / 100) * W;
    const selectedW = Math.max(selectedH, (posMax - posMin) + selectedH);
    selectedEl.style.left = `${posMin - radius}px`;
    selectedEl.style.width = `${selectedW}px`;
    if (selectedW <= selectedH) {
      selectedEl.style.background = `linear-gradient(to right, ${c0} 0%, ${c0} 50%, ${c1} 50%, ${c1} 100%)`;
    } else {
      const innerW = selectedW - selectedH;
      const selStops = [`${c0} 0px`, `${c0} ${radius}px`];
      for (const p of palette) {
        selStops.push(`rgb(${p.r},${p.g},${p.b}) ${(radius + p.t * innerW).toFixed(2)}px`);
      }
      selStops.push(`${c1} ${(selectedW - radius).toFixed(2)}px`, `${c1} 100%`);
      selectedEl.style.background = `linear-gradient(to right, ${selStops.join(', ')})`;
    }
  }
}

// ================================================================
// 色別標高図 デュアルレンジスライダー
// ================================================================

export let crMin = 0;
export let crMax = 500;
export let crPaletteId = 'rainbow';

export function refreshColorReliefTrackLayout() {
  const crCtrls = document.getElementById('color-relief-controls');
  if (!crCtrls || crCtrls.style.display === 'none') return;
  updateGradientTrack();
  const track = document.querySelector('.cr-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => { updateGradientTrack(); });
  }
}

function syncColorReliefUI() {
  const minSlider = document.getElementById('cr-min-slider');
  const maxSlider = document.getElementById('cr-max-slider');
  const minInput  = document.getElementById('cr-min-input');
  const maxInput  = document.getElementById('cr-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.min = maxSlider.min = '0';
  const sMax = parseFloat(minSlider.max);
  crMin = Math.max(crMin, 0);
  if (crMax > sMax) { minSlider.max = maxSlider.max = String(crMax + 100); }

  minSlider.value = crMin;
  maxSlider.value = crMax;
  if (minInput) minInput.value = crMin;
  if (maxInput) maxInput.value = crMax;
}

function updateGradientTrack() {
  const minSlider = document.getElementById('cr-min-slider');
  if (!minSlider) return;
  _applyGradientTrack(
    document.querySelector('.cr-gradient-track'),
    document.querySelector('.cr-selected-track'),
    crMin, crMax,
    parseFloat(minSlider.min), parseFloat(minSlider.max),
    getReliefPalette(crPaletteId)
  );
}

let _crTileTimer = null;
let _crThrottleTime = 0;

function updateColorContourColors() {
  if (!_map) return;
  const expr = buildColorContourExpr(crMin, crMax, getReliefPalette(crPaletteId));
  [...COLOR_CONTOUR_Q_IDS, ...COLOR_CONTOUR_DEM5A_IDS, ...COLOR_CONTOUR_DEM1A_IDS].forEach(id => {
    if (_map.getLayer(id)) _map.setPaintProperty(id, 'line-color', expr);
  });
}

export function applyColorReliefTiles() {
  if (_getCurrentOverlay() === 'color-relief') scheduleDataOverlayDeckSync('color-relief');
}

function updateColorReliefUI() {
  syncColorReliefUI();
  updateGradientTrack();
  const now = Date.now();
  if (now - _crThrottleTime >= 100) {
    _crThrottleTime = now;
    updateColorContourColors();
  }
  applyColorReliefTiles();
}

export function updateColorReliefSource() {
  syncColorReliefUI();
  updateGradientTrack();
  updateColorContourColors();
  clearTimeout(_crTileTimer);
  applyColorReliefTiles();
}

(function initColorReliefSlider() {
  const trackWrap  = document.querySelector('.cr-dual-track');
  const selected   = document.getElementById('cr-selected-track');
  const minHit     = document.getElementById('cr-selected-min-hit');
  const maxHit     = document.getElementById('cr-selected-max-hit');
  const moveHit    = document.getElementById('cr-selected-move-hit');
  const minSlider  = document.getElementById('cr-min-slider');
  const maxSlider  = document.getElementById('cr-max-slider');
  const minInput   = document.getElementById('cr-min-input');
  const maxInput   = document.getElementById('cr-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.addEventListener('input', () => {
    crMin = Math.min(parseInt(minSlider.value, 10), crMax);
    updateColorReliefUI();
  });
  minSlider.addEventListener('change', () => {
    crMin = Math.min(parseInt(minSlider.value, 10), crMax);
    updateColorReliefSource();
  });
  maxSlider.addEventListener('input', () => {
    crMax = Math.max(parseInt(maxSlider.value, 10), crMin);
    updateColorReliefUI();
  });
  maxSlider.addEventListener('change', () => {
    crMax = Math.max(parseInt(maxSlider.value, 10), crMin);
    updateColorReliefSource();
  });

  const applyMinInput = () => {
    const v = parseInt(minInput.value, 10);
    if (isNaN(v)) { minInput.value = crMin; return; }
    crMin = Math.min(v, crMax);
    updateColorReliefSource();
  };
  const applyMaxInput = () => {
    const v = parseInt(maxInput.value, 10);
    if (isNaN(v)) { maxInput.value = crMax; return; }
    crMax = Math.max(v, crMin);
    updateColorReliefSource();
  };
  if (minInput) {
    minInput.addEventListener('change', applyMinInput);
    minInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMinInput(); });
  }
  if (maxInput) {
    maxInput.addEventListener('change', applyMaxInput);
    maxInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMaxInput(); });
  }

  if (trackWrap && selected && minHit && maxHit && moveHit) {
    let dragMode = null;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartMin = 0;
    let dragStartMax = 0;

    function clampCrValues() {
      const lo = parseFloat(minSlider.min);
      const hi = parseFloat(minSlider.max);
      if (dragMode === 'min') {
        crMin = Math.max(lo, Math.min(crMin, crMax));
      } else if (dragMode === 'max') {
        crMax = Math.min(hi, Math.max(crMax, crMin));
      } else if (dragMode === 'move') {
        const span = dragStartMax - dragStartMin;
        if (crMin < lo) { crMin = lo; crMax = lo + span; }
        if (crMax > hi) { crMax = hi; crMin = hi - span; }
      }
    }

    function onDragMove(clientX) {
      const width = trackWrap.clientWidth || 1;
      const scale = (parseFloat(minSlider.max) - parseFloat(minSlider.min)) / width;
      const deltaValue = Math.round((clientX - dragStartX) * scale / 10) * 10;
      if (dragMode === 'min') {
        crMin = dragStartMin + deltaValue;
      } else if (dragMode === 'max') {
        crMax = dragStartMax + deltaValue;
      } else if (dragMode === 'move') {
        crMin = dragStartMin + deltaValue;
        crMax = dragStartMax + deltaValue;
      }
      clampCrValues();
      updateColorReliefUI();
    }

    function finishDrag() {
      if (!dragMode) return;
      dragMode = null;
      dragPointerId = null;
      trackWrap.classList.remove('cr-dragging');
      selected.classList.remove('cr-dragging');
      updateColorReliefSource();
    }

    function startDrag(mode, e) {
      e.preventDefault();
      dragMode = mode;
      dragPointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartMin = crMin;
      dragStartMax = crMax;
      trackWrap.classList.add('cr-dragging');
      selected.classList.add('cr-dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }

    [[minHit, 'min'], [maxHit, 'max'], [moveHit, 'move']].forEach(([el, mode]) => {
      el.addEventListener('pointerdown', (e) => startDrag(mode, e));
    });

    document.addEventListener('pointermove', (e) => {
      if (!dragMode || e.pointerId !== dragPointerId) return;
      onDragMove(e.clientX);
    });
    document.addEventListener('pointerup', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    document.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    selected.addEventListener('lostpointercapture', () => { finishDrag(); });
  }

  updateColorReliefSource();
})();

// ================================================================
// DEMタイル直接サンプリング（queryTerrainElevation 不使用・3D地形有効化不要）
// tileSize:256 設定に合わせて fetchZoom = round(viewZoom + 1)、上限z15
// ================================================================

function _demFetchZoom() {
  return Math.min(15, Math.round(_map.getZoom() + 1));
}

function _lngLatToTileXY(lng, lat, z) {
  const n = 1 << z;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function _lngLatToPixelInTile(lng, lat, z, tx, ty, tileSize) {
  const n = 1 << z;
  const px = ((lng + 180) / 360 * n - tx) * tileSize;
  const latRad = lat * Math.PI / 180;
  const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - ty) * tileSize;
  return {
    px: Math.floor(Math.max(0, Math.min(tileSize - 1, px))),
    py: Math.floor(Math.max(0, Math.min(tileSize - 1, py))),
  };
}

// 地理院 NumPNG 標高デコード（(R×2^16 + G×2^8 + B) × 0.01、負値対応）
function _readNumPng(imgData, px, py) {
  const i = (py * imgData.width + px) * 4;
  if (imgData.data[i + 3] === 0) return null; // nodata
  const v = imgData.data[i] * 65536 + imgData.data[i + 1] * 256 + imgData.data[i + 2];
  return (v >= 8388608 ? v - 16777216 : v) * 0.01;
}

// タイル ImageData キャッシュ（同一サンプリング内の重複 fetch 排除）
const _demDirectCache = new Map();
function _fetchDemImageData(url) {
  if (_demDirectCache.has(url)) return _demDirectCache.get(url);
  const p = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const bm = await createImageBitmap(await r.blob());
      const cv = new OffscreenCanvas(bm.width, bm.height);
      cv.getContext('2d').drawImage(bm, 0, 0);
      bm.close();
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    } catch { return null; }
  })();
  _demDirectCache.set(url, p);
  setTimeout(() => _demDirectCache.delete(url), 60000);
  return p;
}

async function _demElevationAt(lngLat, z) {
  const { x, y } = _lngLatToTileXY(lngLat.lng, lngLat.lat, z);
  const url = z >= 15
    ? `${QCHIZU_DEM_BASE}/${z}/${x}/${y}.webp`
    : `${DEM5A_BASE}/${z}/${x}/${y}.png`;
  const imgData = await _fetchDemImageData(url);
  if (!imgData) return null;
  const { px, py } = _lngLatToPixelInTile(lngLat.lng, lngLat.lat, z, x, y, imgData.width);
  return _readNumPng(imgData, px, py);
}

async function _estimateSlopeDirect(px, py, z, deltaPx) {
  const canvas = _map.getCanvas();
  if (px + deltaPx >= canvas.offsetWidth || py + deltaPx >= canvas.offsetHeight) return null;
  const p00 = _map.unproject([px, py]);
  const p10 = _map.unproject([px + deltaPx, py]);
  const p01 = _map.unproject([px, py + deltaPx]);
  const [h00, h10, h01] = await Promise.all([
    _demElevationAt(p00, z), _demElevationAt(p10, z), _demElevationAt(p01, z),
  ]);
  if (h00 == null || h10 == null || h01 == null) return null;
  const dX = turf.distance(turf.point([p00.lng, p00.lat]), turf.point([p10.lng, p10.lat]), { units: 'kilometers' }) * 1000;
  const dY = turf.distance(turf.point([p00.lng, p00.lat]), turf.point([p01.lng, p01.lat]), { units: 'kilometers' }) * 1000;
  if (!(dX > 0) || !(dY > 0)) return null;
  return Math.atan(Math.sqrt(((h00 - h10) / dX) ** 2 + ((h00 - h01) / dY) ** 2)) * 180 / Math.PI;
}

async function _estimateCurvatureDirect(px, py, z, deltaPx) {
  const canvas = _map.getCanvas();
  if (px - deltaPx < 0 || px + deltaPx >= canvas.offsetWidth ||
      py - deltaPx < 0 || py + deltaPx >= canvas.offsetHeight) return null;
  const pC = _map.unproject([px, py]);
  const pR = _map.unproject([px + deltaPx, py]);
  const pL = _map.unproject([px - deltaPx, py]);
  const pD = _map.unproject([px, py + deltaPx]);
  const pU = _map.unproject([px, py - deltaPx]);
  const [hC, hR, hL, hD, hU] = await Promise.all([
    _demElevationAt(pC, z), _demElevationAt(pR, z), _demElevationAt(pL, z),
    _demElevationAt(pD, z), _demElevationAt(pU, z),
  ]);
  if ([hC, hR, hL, hD, hU].some(h => h == null)) return null;
  const dX = turf.distance(turf.point([pC.lng, pC.lat]), turf.point([pR.lng, pR.lat]), { units: 'kilometers' }) * 1000;
  const dY = turf.distance(turf.point([pC.lng, pC.lat]), turf.point([pD.lng, pD.lat]), { units: 'kilometers' }) * 1000;
  if (!(dX > 0) || !(dY > 0)) return null;
  // プロトコルと同式: neg(Laplacian) / cc
  const laplacian = -((hR - 2 * hC + hL) / (dX * dX) + (hD - 2 * hC + hU) / (dY * dY));
  const pixelLength = 156543.04 * Math.cos(_map.getCenter().lat * Math.PI / 180) / Math.pow(2, _map.getZoom()) * 0.5;
  const cc = pixelLength < 68 ? Math.max(pixelLength / 2, 1.1) : 0.188 * Math.pow(pixelLength, 1.232);
  return laplacian / cc;
}

// ---- 色別標高図: 表示範囲から自動フィット ----
export async function autoFitColorRelief() {
  const GRID = _map.getZoom() <= 9 ? 10 : 20;
  const z = _demFetchZoom();
  const canvas = _map.getCanvas();
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const promises = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      promises.push(_demElevationAt(_map.unproject([(c + 0.5) / GRID * w, (r + 0.5) / GRID * h]), z));
  const elevations = await Promise.all(promises);
  let globalMin = Infinity, globalMax = -Infinity;
  for (const e of elevations) {
    if (e == null) continue;
    if (e < globalMin) globalMin = e;
    if (e > globalMax) globalMax = e;
  }
  if (!isFinite(globalMin) || !isFinite(globalMax)) return;
  const step = 10;
  crMin = Math.max(0, Math.floor(globalMin / step) * step);
  crMax = Math.ceil(globalMax / step) * step;
  if (crMax <= crMin) crMax = crMin + step;
  updateColorReliefSource();
}

document.getElementById('cr-autofit-btn')?.addEventListener('click', autoFitColorRelief);

// ================================================================
// 色別傾斜 デュアルレンジスライダー
// ================================================================

export let srMin = 0;
export let srMax = 45;
export let srPaletteId = 'rainbow';

export function refreshSlopeReliefTrackLayout() {
  const srCtrls = document.getElementById('slope-relief-controls');
  if (!srCtrls || srCtrls.style.display === 'none') return;
  updateSlopeGradientTrack();
  const track = document.getElementById('sr-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => { updateSlopeGradientTrack(); });
  }
}

function syncSlopeReliefUI() {
  const minSlider = document.getElementById('sr-min-slider');
  const maxSlider = document.getElementById('sr-max-slider');
  const minInput  = document.getElementById('sr-min-input');
  const maxInput  = document.getElementById('sr-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.min = maxSlider.min = '0';
  minSlider.max = maxSlider.max = '90';
  srMin = Math.max(0, Math.min(srMin, 90));
  srMax = Math.max(0, Math.min(srMax, 90));

  minSlider.value = srMin;
  maxSlider.value = srMax;
  if (minInput) minInput.value = srMin;
  if (maxInput) maxInput.value = srMax;
}

function updateSlopeGradientTrack() {
  const minSlider = document.getElementById('sr-min-slider');
  if (!minSlider) return;
  _applyGradientTrack(
    document.getElementById('sr-gradient-track'),
    document.getElementById('sr-selected-track'),
    srMin, srMax,
    parseFloat(minSlider.min), parseFloat(minSlider.max),
    getReliefPalette(srPaletteId)
  );
}

let _srTileTimer  = null;
let _srRepaintTimer = null;
let _srDragTileTime = 0;

export function applySlopeReliefTiles() {
  scheduleSlopeDeckSync();
}

function updateSlopeReliefUI() {
  syncSlopeReliefUI();
  updateSlopeGradientTrack();
  scheduleSlopeDeckSync();
}

export function updateSlopeReliefSource() {
  syncSlopeReliefUI();
  updateSlopeGradientTrack();
  scheduleSlopeDeckSync();
}

(function initSlopeReliefSlider() {
  const trackWrap = document.querySelector('#slope-relief-controls .cr-dual-track');
  const selected  = document.getElementById('sr-selected-track');
  const minHit    = document.getElementById('sr-selected-min-hit');
  const maxHit    = document.getElementById('sr-selected-max-hit');
  const moveHit   = document.getElementById('sr-selected-move-hit');
  const minSlider = document.getElementById('sr-min-slider');
  const maxSlider = document.getElementById('sr-max-slider');
  const minInput  = document.getElementById('sr-min-input');
  const maxInput  = document.getElementById('sr-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.addEventListener('input', () => {
    srMin = Math.min(parseInt(minSlider.value, 10), srMax);
    updateSlopeReliefUI();
    const now = Date.now();
    if (now - _srDragTileTime >= 1000) { _srDragTileTime = now; applySlopeReliefTiles(); }
  });
  minSlider.addEventListener('change', () => {
    srMin = Math.min(parseInt(minSlider.value, 10), srMax);
    updateSlopeReliefSource();
  });
  maxSlider.addEventListener('input', () => {
    srMax = Math.max(parseInt(maxSlider.value, 10), srMin);
    updateSlopeReliefUI();
    const now = Date.now();
    if (now - _srDragTileTime >= 1000) { _srDragTileTime = now; applySlopeReliefTiles(); }
  });
  maxSlider.addEventListener('change', () => {
    srMax = Math.max(parseInt(maxSlider.value, 10), srMin);
    updateSlopeReliefSource();
  });

  const applyMinInput = () => {
    const v = parseInt(minInput.value, 10);
    if (isNaN(v)) { minInput.value = srMin; return; }
    srMin = Math.min(v, srMax);
    updateSlopeReliefSource();
  };
  const applyMaxInput = () => {
    const v = parseInt(maxInput.value, 10);
    if (isNaN(v)) { maxInput.value = srMax; return; }
    srMax = Math.max(v, srMin);
    updateSlopeReliefSource();
  };
  if (minInput) {
    minInput.addEventListener('change', applyMinInput);
    minInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMinInput(); });
  }
  if (maxInput) {
    maxInput.addEventListener('change', applyMaxInput);
    maxInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMaxInput(); });
  }

  if (trackWrap && selected && minHit && maxHit && moveHit) {
    let dragMode = null;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartMin = 0;
    let dragStartMax = 0;

    function clampSrValues() {
      const lo = parseFloat(minSlider.min);
      const hi = parseFloat(minSlider.max);
      if (dragMode === 'min') {
        srMin = Math.max(lo, Math.min(srMin, srMax));
      } else if (dragMode === 'max') {
        srMax = Math.min(hi, Math.max(srMax, srMin));
      } else if (dragMode === 'move') {
        const span = dragStartMax - dragStartMin;
        if (srMin < lo) { srMin = lo; srMax = lo + span; }
        if (srMax > hi) { srMax = hi; srMin = hi - span; }
      }
    }

    function onDragMove(clientX) {
      const width = trackWrap.clientWidth || 1;
      const scale = (parseFloat(minSlider.max) - parseFloat(minSlider.min)) / width;
      const deltaValue = Math.round((clientX - dragStartX) * scale);
      if (dragMode === 'min') {
        srMin = dragStartMin + deltaValue;
      } else if (dragMode === 'max') {
        srMax = dragStartMax + deltaValue;
      } else if (dragMode === 'move') {
        srMin = dragStartMin + deltaValue;
        srMax = dragStartMax + deltaValue;
      }
      clampSrValues();
      updateSlopeReliefUI();
      const now = Date.now();
      if (now - _srDragTileTime >= 1000) { _srDragTileTime = now; applySlopeReliefTiles(); }
    }

    function finishDrag() {
      if (!dragMode) return;
      dragMode = null;
      dragPointerId = null;
      trackWrap.classList.remove('cr-dragging');
      selected.classList.remove('cr-dragging');
      _srDragTileTime = 0;
      updateSlopeReliefSource();
    }

    function startDrag(mode, e) {
      e.preventDefault();
      dragMode = mode;
      dragPointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartMin = srMin;
      dragStartMax = srMax;
      trackWrap.classList.add('cr-dragging');
      selected.classList.add('cr-dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }

    [[minHit, 'min'], [maxHit, 'max'], [moveHit, 'move']].forEach(([el, mode]) => {
      el.addEventListener('pointerdown', (e) => startDrag(mode, e));
    });

    document.addEventListener('pointermove', (e) => {
      if (!dragMode || e.pointerId !== dragPointerId) return;
      onDragMove(e.clientX);
    });
    document.addEventListener('pointerup', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    document.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    selected.addEventListener('lostpointercapture', () => { finishDrag(); });
  }

  updateSlopeReliefSource();
})();

export async function autoFitSlopeRelief() {
  const GRID = _map.getZoom() <= 9 ? 10 : 20;
  const z = _demFetchZoom();
  const canvas = _map.getCanvas();
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const deltaPx = 4;
  const promises = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      promises.push(_estimateSlopeDirect((c + 0.5) / GRID * w, (r + 0.5) / GRID * h, z, deltaPx));
  const slopes = await Promise.all(promises);
  let globalMin = Infinity, globalMax = -Infinity;
  for (const s of slopes) {
    if (s == null) continue;
    if (s < globalMin) globalMin = s;
    if (s > globalMax) globalMax = s;
  }
  if (!isFinite(globalMin) || !isFinite(globalMax)) return;
  srMin = Math.max(0, Math.floor(globalMin));
  srMax = Math.min(90, Math.ceil(globalMax));
  if (srMax <= srMin) srMax = Math.min(90, srMin + 1);
  updateSlopeReliefSource();
}

document.getElementById('sr-autofit-btn')?.addEventListener('click', autoFitSlopeRelief);

// ================================================================
// 色別曲率 デュアルレンジスライダー
// ================================================================

export let cvMin = -0.05;
export let cvMax  =  0.05;
export let cvPaletteId = 'rainbow';

export function refreshCurvatureReliefTrackLayout() {
  const cvCtrls = document.getElementById('curvature-relief-controls');
  if (!cvCtrls || cvCtrls.style.display === 'none') return;
  updateCurvatureGradientTrack();
  const track = document.getElementById('cv-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => { updateCurvatureGradientTrack(); });
  }
}

function syncCurvatureReliefUI() {
  const minSlider = document.getElementById('cv-min-slider');
  const maxSlider = document.getElementById('cv-max-slider');
  const minInput  = document.getElementById('cv-min-input');
  const maxInput  = document.getElementById('cv-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.min = maxSlider.min = '-0.1';
  minSlider.max = maxSlider.max = '0.1';
  cvMin = Math.max(-0.1, Math.min(cvMin, 0.1));
  cvMax = Math.max(-0.1, Math.min(cvMax, 0.1));

  minSlider.value = cvMin;
  maxSlider.value = cvMax;
  if (minInput) minInput.value = cvMin.toFixed(3);
  if (maxInput) maxInput.value = cvMax.toFixed(3);
}

function updateCurvatureGradientTrack() {
  const minSlider = document.getElementById('cv-min-slider');
  if (!minSlider) return;
  _applyGradientTrack(
    document.getElementById('cv-gradient-track'),
    document.getElementById('cv-selected-track'),
    cvMin, cvMax,
    parseFloat(minSlider.min), parseFloat(minSlider.max),
    getReliefPalette(cvPaletteId)
  );
}

let _cvTileTimer    = null;
let _cvRepaintTimer = null;
let _cvDragTileTime = 0;

export function applyCurvatureReliefTiles() {
  if (_getCurrentOverlay() === 'curvature') scheduleDataOverlayDeckSync('curvature');
}

function updateCurvatureReliefUI() {
  syncCurvatureReliefUI();
  updateCurvatureGradientTrack();
  if (_getCurrentOverlay() === 'curvature') scheduleDataOverlayDeckSync('curvature');
}

export function updateCurvatureReliefSource() {
  syncCurvatureReliefUI();
  updateCurvatureGradientTrack();
  clearTimeout(_cvTileTimer);
  if (_getCurrentOverlay() === 'curvature') scheduleDataOverlayDeckSync('curvature');
}

(function initCurvatureReliefSlider() {
  const trackWrap = document.querySelector('#curvature-relief-controls .cr-dual-track');
  const selected  = document.getElementById('cv-selected-track');
  const minHit    = document.getElementById('cv-selected-min-hit');
  const maxHit    = document.getElementById('cv-selected-max-hit');
  const moveHit   = document.getElementById('cv-selected-move-hit');
  const minSlider = document.getElementById('cv-min-slider');
  const maxSlider = document.getElementById('cv-max-slider');
  const minInput  = document.getElementById('cv-min-input');
  const maxInput  = document.getElementById('cv-max-input');
  if (!minSlider || !maxSlider) return;

  minSlider.addEventListener('input', () => {
    cvMin = Math.min(parseFloat(minSlider.value), cvMax);
    updateCurvatureReliefUI();
    const now = Date.now();
    if (now - _cvDragTileTime >= 1000) { _cvDragTileTime = now; applyCurvatureReliefTiles(); }
  });
  minSlider.addEventListener('change', () => {
    cvMin = Math.min(parseFloat(minSlider.value), cvMax);
    updateCurvatureReliefSource();
  });
  maxSlider.addEventListener('input', () => {
    cvMax = Math.max(parseFloat(maxSlider.value), cvMin);
    updateCurvatureReliefUI();
    const now = Date.now();
    if (now - _cvDragTileTime >= 1000) { _cvDragTileTime = now; applyCurvatureReliefTiles(); }
  });
  maxSlider.addEventListener('change', () => {
    cvMax = Math.max(parseFloat(maxSlider.value), cvMin);
    updateCurvatureReliefSource();
  });

  const applyMinInput = () => {
    const v = parseFloat(minInput.value);
    if (isNaN(v)) { minInput.value = cvMin.toFixed(3); return; }
    cvMin = Math.min(v, cvMax);
    updateCurvatureReliefSource();
  };
  const applyMaxInput = () => {
    const v = parseFloat(maxInput.value);
    if (isNaN(v)) { maxInput.value = cvMax.toFixed(3); return; }
    cvMax = Math.max(v, cvMin);
    updateCurvatureReliefSource();
  };
  if (minInput) {
    minInput.addEventListener('change', applyMinInput);
    minInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMinInput(); });
  }
  if (maxInput) {
    maxInput.addEventListener('change', applyMaxInput);
    maxInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMaxInput(); });
  }

  if (trackWrap && selected && minHit && maxHit && moveHit) {
    let dragMode = null;
    let dragPointerId = null;
    let dragStartX = 0;
    let dragStartMin = 0;
    let dragStartMax = 0;

    function clampCvValues() {
      const lo = parseFloat(minSlider.min);
      const hi = parseFloat(minSlider.max);
      if (dragMode === 'min') {
        cvMin = Math.max(lo, Math.min(cvMin, cvMax));
      } else if (dragMode === 'max') {
        cvMax = Math.min(hi, Math.max(cvMax, cvMin));
      } else if (dragMode === 'move') {
        const span = dragStartMax - dragStartMin;
        if (cvMin < lo) { cvMin = lo; cvMax = Math.min(hi, lo + span); }
        if (cvMax > hi) { cvMax = hi; cvMin = Math.max(lo, hi - span); }
      }
    }

    function onDragMove(clientX) {
      const width = trackWrap.clientWidth || 1;
      const scale = (parseFloat(minSlider.max) - parseFloat(minSlider.min)) / width;
      const deltaValue = (clientX - dragStartX) * scale;
      if (dragMode === 'min') {
        cvMin = dragStartMin + deltaValue;
      } else if (dragMode === 'max') {
        cvMax = dragStartMax + deltaValue;
      } else if (dragMode === 'move') {
        cvMin = dragStartMin + deltaValue;
        cvMax = dragStartMax + deltaValue;
      }
      clampCvValues();
      updateCurvatureReliefUI();
      const now = Date.now();
      if (now - _cvDragTileTime >= 1000) { _cvDragTileTime = now; applyCurvatureReliefTiles(); }
    }

    function finishDrag() {
      if (!dragMode) return;
      dragMode = null;
      dragPointerId = null;
      trackWrap.classList.remove('cr-dragging');
      selected.classList.remove('cr-dragging');
      _cvDragTileTime = 0;
      updateCurvatureReliefSource();
    }

    function startDrag(mode, e) {
      e.preventDefault();
      dragMode = mode;
      dragPointerId = e.pointerId;
      dragStartX = e.clientX;
      dragStartMin = cvMin;
      dragStartMax = cvMax;
      trackWrap.classList.add('cr-dragging');
      selected.classList.add('cr-dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }

    [[minHit, 'min'], [maxHit, 'max'], [moveHit, 'move']].forEach(([el, mode]) => {
      el.addEventListener('pointerdown', (e) => startDrag(mode, e));
    });

    document.addEventListener('pointermove', (e) => {
      if (!dragMode || e.pointerId !== dragPointerId) return;
      onDragMove(e.clientX);
    });
    document.addEventListener('pointerup', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    document.addEventListener('pointercancel', (e) => {
      if (e.pointerId !== dragPointerId) return;
      finishDrag();
    });
    selected.addEventListener('lostpointercapture', () => { finishDrag(); });
  }

  updateCurvatureReliefSource();
})();

export async function autoFitCurvatureRelief() {
  const GRID = _map.getZoom() <= 9 ? 8 : 15;
  const z = _demFetchZoom();
  const canvas = _map.getCanvas();
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const deltaPx = Math.max(4, Math.round(w / (GRID * 3)));
  const promises = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      promises.push(_estimateCurvatureDirect((c + 0.5) / GRID * w, (r + 0.5) / GRID * h, z, deltaPx));
  const curvatures = await Promise.all(promises);
  let globalMin = Infinity, globalMax = -Infinity;
  for (const cv of curvatures) {
    if (cv == null) continue;
    if (cv < globalMin) globalMin = cv;
    if (cv > globalMax) globalMax = cv;
  }
  if (!isFinite(globalMin) || !isFinite(globalMax)) return;
  const step = 0.001;
  const margin = Math.max((globalMax - globalMin) * 0.1, step);
  cvMin = Math.max(-0.1, Math.round((globalMin - margin) / step) * step);
  cvMax = Math.min( 0.1, Math.round((globalMax + margin) / step) * step);
  if (cvMax <= cvMin) cvMax = Math.min(0.1, cvMin + step);
  updateCurvatureReliefSource();
}

document.getElementById('cv-autofit-btn')?.addEventListener('click', autoFitCurvatureRelief);

// ================================================================
// オーバーレイ別設定マップ
//   各データタイルプロトコルの共通パラメータをここで一元管理する。
//   新しいオーバーレイを追加する場合はここにエントリを足すだけでよい。
// ================================================================
export const OVERLAY_DATA_CONFIGS = {
  slope: {
    dataMin:         SLOPE_DATA_MIN,
    dataMax:         SLOPE_DATA_MAX,
    getRenderMin:    () => srMin,
    getRenderMax:    () => srMax,
    getPaletteStops: () => getReliefPalette(srPaletteId),
    generateTile:    generateSlopeDataTile,
    regionalLayers:  REGIONAL_SLOPE_LAYERS,
    maplibreSourceId: 'slope-relief',
    maplibreLayerId:  'slope-relief-layer',
    qBaseUrl:        () => `slope-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:       (tileUrl) => tileUrl.replace(/^dem2slope:\/\//, 'slope-data://').replace(/\?.*$/, ''),
    maxZoomBase:     15,
  },
  'color-relief': {
    dataMin:         RELIEF_DATA_MIN,
    dataMax:         RELIEF_DATA_MAX,
    getRenderMin:    () => crMin,
    getRenderMax:    () => crMax,
    getPaletteStops: () => getReliefPalette(crPaletteId),
    generateTile:    generateReliefDataTile,
    regionalLayers:  REGIONAL_RELIEF_LAYERS,
    maplibreSourceId: 'color-relief',
    maplibreLayerId:  'color-relief-layer',
    qBaseUrl:        () => `relief-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:       (tileUrl) => tileUrl.replace(/^dem2relief:\/\//, 'relief-data://').replace(/\?.*$/, ''),
    maxZoomBase:     15,
  },
  curvature: {
    dataMin:         CURVE_DATA_MIN,
    dataMax:         CURVE_DATA_MAX,
    getRenderMin:    () => cvMin,
    getRenderMax:    () => cvMax,
    getPaletteStops: () => getReliefPalette(cvPaletteId),
    generateTile:    generateCurveDataTile,
    regionalLayers:  REGIONAL_CURVE_LAYERS,
    maplibreSourceId: 'curvature-relief',
    maplibreLayerId:  'curvature-relief-layer',
    qBaseUrl:        () => `curve-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:       (tileUrl) => tileUrl.replace(/^dem2curve:\/\//, 'curve-data://').replace(/\?.*$/, ''),
    maxZoomBase:     15,
  },
};

// ================================================================
// 汎用データオーバーレイ MapLibre raster 同期
// ================================================================

export function scheduleDataOverlayDeckSync(overlayKey) {
  if (!scheduleDataOverlayDeckSync._rafs) scheduleDataOverlayDeckSync._rafs = {};
  const rafs = scheduleDataOverlayDeckSync._rafs;
  if (rafs[overlayKey]) cancelAnimationFrame(rafs[overlayKey]);
  rafs[overlayKey] = requestAnimationFrame(() => {
    rafs[overlayKey] = 0;
    _applyDataOverlayRasterTiles(overlayKey);
  });
}

export function scheduleSlopeDeckSync() { scheduleDataOverlayDeckSync('slope'); }

function _applyDataOverlayRasterTiles(overlayKey) {
  if (!_map) return;
  const cfg = OVERLAY_DATA_CONFIGS[overlayKey];
  if (!cfg) return;

  const opacity    = parseFloat(document.getElementById('slider-cs')?.value ?? '1');
  const renderMin  = cfg.getRenderMin();
  const renderMax  = cfg.getRenderMax();
  const stops      = cfg.getPaletteStops();
  const stopsParam = encodeURIComponent(JSON.stringify(stops));

  const makeTileUrl = (suffix = '') =>
    `data-render://${overlayKey}/{z}/{x}/{y}?min=${renderMin}&max=${renderMax}&dataMin=${cfg.dataMin}&dataMax=${cfg.dataMax}&stops=${stopsParam}${suffix}`;

  const src = _map.getSource(cfg.maplibreSourceId);
  if (src) {
    src.setTiles([makeTileUrl()]);
    _map.setPaintProperty(cfg.maplibreLayerId, 'raster-opacity', opacity);
    _map.setLayoutProperty(cfg.maplibreLayerId, 'visibility', 'visible');
  }
}

// ================================================================
// パレットピッカー UI
// ================================================================

function makePalettePicker(containerEl, initialId, onChange) {
  let currentId = initialId;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cascade-btn palette-picker-btn';

  const panel = document.createElement('div');
  panel.className = 'cascade-menu palette-picker-menu';
  document.body.appendChild(panel);

  function syncBtn() {
    const stops = getReliefPalette(currentId);
    btn.style.backgroundImage = `${paletteGradientCss(stops)}, var(--chevron-down)`;
    btn.style.backgroundRepeat = 'no-repeat, no-repeat';
    btn.style.backgroundSize = `calc(100% - 18px) calc(100% - 6px), var(--chevron-size-down)`;
    btn.style.backgroundPosition = 'left 3px center, right var(--chevron-inset) center';
  }

  function buildItems() {
    panel.innerHTML = '';
    for (const pal of RELIEF_PALETTES) {
      const item = document.createElement('div');
      item.className = 'cascade-item palette-picker-item' + (pal.id === currentId ? ' selected' : '');
      item.dataset.id = pal.id;
      item.style.backgroundImage = paletteGradientCss(pal.stops);
      item.title = pal.label;
      panel.appendChild(item);
    }
  }

  function openPanel() {
    document.querySelectorAll('.palette-picker-menu.open').forEach(m => {
      if (m !== panel) m.classList.remove('open');
    });
    buildItems();
    panel.style.visibility = 'hidden';
    panel.classList.add('open');
    const panelH = panel.scrollHeight;
    panel.classList.remove('open');
    panel.style.visibility = '';
    const r = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < panelH && r.top > spaceBelow;
    panel.style.top  = openUp ? `${r.top - panelH - 2}px` : `${r.bottom + 2}px`;
    panel.style.left = `${r.left}px`;
    panel.style.width = `${r.width}px`;
    panel.classList.toggle('open-up', openUp);
    panel.classList.add('open');
  }
  function closePanel() { panel.classList.remove('open', 'open-up'); }

  btn.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  document.addEventListener('mousedown', closePanel);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.contains('open') ? closePanel() : openPanel();
  });
  panel.addEventListener('click', e => {
    const item = e.target.closest('.palette-picker-item');
    if (!item) return;
    currentId = item.dataset.id;
    syncBtn();
    buildItems();
    closePanel();
    onChange(currentId);
  });

  containerEl.appendChild(btn);
  syncBtn();

  return {
    getValue: () => currentId,
    setValue: (id) => { currentId = id; syncBtn(); buildItems(); },
  };
}

// 色別標高図・傾斜・曲率のパレットピッカーを初期化
export function initPalettePickers() {
  const crContainer = document.getElementById('cr-palette-picker');
  if (crContainer) makePalettePicker(crContainer, crPaletteId, id => {
    crPaletteId = id;
    updateColorReliefSource();
  });

  const srContainer = document.getElementById('sr-palette-picker');
  if (srContainer) makePalettePicker(srContainer, srPaletteId, id => {
    srPaletteId = id;
    updateSlopeReliefSource();
  });

  const cvContainer = document.getElementById('cv-palette-picker');
  if (cvContainer) makePalettePicker(cvContainer, cvPaletteId, id => {
    cvPaletteId = id;
    updateCurvatureReliefSource();
  });
}

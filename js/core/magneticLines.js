/* ================================================================
   magneticLines.js — 磁北線の動的生成・色制御
   init(map, { getReadMap }) で map と PCシム用マップゲッターを注入する
   ================================================================ */

import { getDeclination } from './magneticDeclination.js';

let _map       = null;
let _getReadMap = () => null;

export function init(map, { getReadMap = () => null } = {}) {
  _map        = map;
  _getReadMap = getReadMap;
}

// ---- 状態 ----
export let userMagneticInterval = 300;
export function setUserMagneticInterval(val) { userMagneticInterval = val; }

const GLOBAL_MAG_INTERVAL_KM = 500;
const GLOBAL_MAG_EQ_KM_DEG   = Math.PI * 6371 / 180;
const GLOBAL_MAG_DLNG        = GLOBAL_MAG_INTERVAL_KM / GLOBAL_MAG_EQ_KM_DEG;
const GLOBAL_MAG_STEP_KM     = 100;
let   _globalMagneticLines   = null;

/** グローバル磁北線キャッシュをクリア（モデル変更時に呼ぶ） */
export function clearGlobalMagneticCache() { _globalMagneticLines = null; }

/** PCシム readmap に渡す最新データのキャッシュ */
let _lastMagneticNorthData = { type: 'FeatureCollection', features: [] };
export function getLastMagneticNorthData() { return _lastMagneticNorthData; }

// ---- zoom ≤ 3 用固定グローバル磁北線 ----
export function buildGlobalMagneticLines() {
  if (_globalMagneticLines) return _globalMagneticLines;

  const numLines   = Math.round(360 / GLOBAL_MAG_DLNG);
  const actualDlng = 360 / numLines;
  const features   = [];

  for (let i = 0; i < numLines; i++) {
    const lng0 = -180 + i * actualDlng;

    const northPts = [[lng0, 0]];
    let lng = lng0, lat = 0;
    for (let s = 0; s < 120; s++) {
      const decl = getDeclination(lat, lng);
      const next = turf.destination(turf.point([lng, lat]), GLOBAL_MAG_STEP_KM, decl, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      northPts.push([lng, lat]);
      if (lat > 89) break;
    }

    const southPts = [[lng0, 0]];
    lng = lng0; lat = 0;
    for (let s = 0; s < 100; s++) {
      const decl    = getDeclination(lat, lng);
      const bearing = (decl + 180 + 360) % 360;
      const next    = turf.destination(turf.point([lng, lat]), GLOBAL_MAG_STEP_KM, bearing, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      southPts.push([lng, lat]);
      if (lat < -85) break;
    }

    const coords = [...southPts.slice(1).reverse(), ...northPts];
    if (coords.length >= 2) features.push(turf.lineString(coords));
  }

  _globalMagneticLines = turf.featureCollection(features);
  return _globalMagneticLines;
}

// ---- zoom レベルに応じた有効磁北線間隔（m）----
export function getEffectiveMagneticInterval() {
  const z = _map.getZoom();
  if (z <=  1) return 2000000;
  if (z <=  2) return 1000000;
  if (z <=  3) return  500000;
  if (z <=  6) return  200000;
  if (z <=  7) return  100000;
  if (z <=  8) return   50000;
  if (z <=  9) return   20000;
  if (z <= 10) return   10000;
  if (z <= 11) return    5000;
  if (z <= 12) return    2000;
  if (z <= 13) return    1000;
  if (z <= 13.5) return   500;
  return userMagneticInterval;
}

// ---- 磁北線の動的生成 ----
export function updateMagneticNorth() {
  if (!_map.getSource('magnetic-north')) return;

  const center = _map.getCenter();
  const bounds = _map.getBounds();

  if (_map.getZoom() <= 3) {
    const data = buildGlobalMagneticLines();
    _lastMagneticNorthData = data;
    _map.getSource('magnetic-north').setData(data);
    return;
  }

  const intervalM  = getEffectiveMagneticInterval();
  const intervalKm = intervalM / 1000;

  const viewWidth  = turf.distance(
    turf.point([bounds.getWest(), center.lat]),
    turf.point([bounds.getEast(), center.lat]),
    { units: 'kilometers' }
  );
  const viewHeight = turf.distance(
    turf.point([center.lng, bounds.getSouth()]),
    turf.point([center.lng, bounds.getNorth()]),
    { units: 'kilometers' }
  );
  const halfExtentKm = Math.hypot(viewWidth, viewHeight) / 2 * 1.3;
  const stepKm       = Math.min(100, Math.max(0.5, halfExtentKm / 15));
  const MAX_STEPS    = 400;
  const bufDeg       = stepKm / 100;
  const minLat       = Math.max(-70, bounds.getSouth() - bufDeg);
  const maxLat       = Math.min( 89.9, bounds.getNorth() + bufDeg);

  const EQ_KM_PER_DEG = Math.PI * 6371 / 180;
  const refLat        = Math.round(center.lat);
  const declCenter    = getDeclination(center.lat, center.lng);
  const declAtBase    = getDeclination(refLat, center.lng);
  const latDiffKm     = Math.abs(refLat - center.lat) * EQ_KM_PER_DEG;
  const cosLat        = Math.max(0.01, Math.cos(center.lat * Math.PI / 180));
  const cosTheta      = Math.max(0.01, Math.abs(Math.cos(declAtBase * Math.PI / 180)));
  const dLng          = intervalKm / (EQ_KM_PER_DEG * cosLat * cosTheta);
  const driftLngBuf   = Math.abs(Math.sin(declCenter * Math.PI / 180) * latDiffKm / (EQ_KM_PER_DEG * cosLat));

  const westLng  = bounds.getWest()  - bufDeg - driftLngBuf;
  const eastLng  = bounds.getEast()  + bufDeg + driftLngBuf;
  const startIdx = Math.floor(westLng / dLng);
  const endIdx   = Math.ceil (eastLng / dLng);

  function walkMagneticLine(startCoords, towardNorth) {
    const pts = [startCoords];
    let lng = startCoords[0], lat = startCoords[1];
    for (let s = 0; s < MAX_STEPS; s++) {
      const decl    = getDeclination(lat, lng);
      const bearing = towardNorth ? decl : (decl + 180 + 360) % 360;
      const next    = turf.destination(turf.point([lng, lat]), stepKm, bearing, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      pts.push([lng, lat]);
      if (towardNorth ? lat > maxLat : lat < minLat) break;
    }
    return pts;
  }

  const features = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const basePt   = [i * dLng, refLat];
    const northPts = walkMagneticLine(basePt, true);
    const southPts = walkMagneticLine(basePt, false);
    const coords   = [...southPts.slice(1).reverse(), ...northPts];
    if (coords.length >= 2) features.push(turf.lineString(coords));
  }

  const featureCollection = turf.featureCollection(features);
  _lastMagneticNorthData = featureCollection;
  _map.getSource('magnetic-north').setData(featureCollection);
}

// ---- 磁北線カラー ----
export function getMagneticLineColor() {
  return (document.getElementById('sel-magnetic-color')?.value ?? 'black') === 'black'
    ? '#000000'
    : '#00ffff';
}

export function applyMagneticLineColor(targetMap = _map, layerId = 'magnetic-north-layer') {
  if (targetMap?.getLayer?.(layerId)) {
    targetMap.setPaintProperty(layerId, 'line-color', getMagneticLineColor());
    targetMap.triggerRepaint?.();
  }
}

export function handleMagneticColorChange(saveCallback) {
  const readMap = _getReadMap();
  applyMagneticLineColor();
  applyMagneticLineColor(readMap);
  updateMagneticNorth();
  requestAnimationFrame(() => {
    applyMagneticLineColor();
    applyMagneticLineColor(readMap);
  });
  saveCallback?.();
}

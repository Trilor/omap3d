/* ================================================================
   gpxCamera.js — GPX 追尾カメラ・マーカー更新
   ================================================================ */

import { gpxState, GPX_BEARING_TC, GPX_ZOOM_TC } from './gpxState.js';

let _map = null;
export function init(map) { _map = map; }

/* 現在地マーカーの座標を更新 */
export function updateGpxMarker(pos) {
  const src = _map.getSource('gpx-marker');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
    }],
  });
}

/* 視点モードに応じてカメラを更新 */
export function updateCamera(pos, elapsed) {
  if (gpxState.viewMode === '3d') {
    updateCameraChase(pos, elapsed);
  } else {
    _map.easeTo({
      center:  [pos.lng, pos.lat],
      zoom:    15.5,
      pitch:   0,
      bearing: 0,
      duration: 100,
    });
  }
}

/* GPX 追尾カメラ（ローパスフィルタ + 地形高度取得） */
export function updateCameraChase(pos, elapsed) {
  const dt = Math.max(0, elapsed ?? 16) / 1000;
  const bearingAlpha = 1 - Math.exp(-dt / GPX_BEARING_TC);
  const bearingDelta = ((pos.bearing - gpxState.smoothedBearing + 540) % 360) - 180;
  gpxState.smoothedBearing = (gpxState.smoothedBearing + bearingDelta * bearingAlpha + 360) % 360;

  const rawH = _map.queryTerrainElevation(
    { lng: pos.lng, lat: pos.lat }, { exaggerated: false }
  );
  if (rawH !== null) gpxState.cachedTerrainH += (rawH - gpxState.cachedTerrainH) * 0.25;
  const h = gpxState.cachedTerrainH;

  const H       = _map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pos.lat * Math.PI / 180;

  const pitchDeg = Math.max(0, Math.min(_map.getMaxPitch(), gpxState.chasePitch));
  const pitchRad = pitchDeg * Math.PI / 180;
  const camBearing = (gpxState.smoothedBearing + gpxState.bearingOffset + 360) % 360;

  // カメラめり込み防止（後方地点の地形高度）
  const backDistKm = gpxState.camDistM * Math.sin(pitchRad) / 1000;
  const backPt = turf.destination(
    [pos.lng, pos.lat], backDistKm, (camBearing + 180) % 360
  );
  const backH = _map.queryTerrainElevation(
    { lng: backPt.geometry.coordinates[0], lat: backPt.geometry.coordinates[1] },
    { exaggerated: false }
  ) ?? h;

  const zoomAlpha = 1 - Math.exp(-dt / GPX_ZOOM_TC);
  const targetZoom = Math.max(12, Math.min(_map.getMaxZoom(), Math.log2(
    H * 2 * Math.PI * R * Math.cos(lat_rad) /
    (1024 * Math.tan(fov_rad / 2) * Math.max(0.3, gpxState.camDistM * Math.cos(pitchRad)))
  )));
  gpxState.smoothedZoom += (targetZoom - gpxState.smoothedZoom) * zoomAlpha;

  _map.jumpTo({
    center:  [pos.lng, pos.lat],
    bearing: camBearing,
    pitch:   pitchDeg,
    zoom:    gpxState.smoothedZoom,
  });
}

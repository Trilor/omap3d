/* ================================================================
   localMapStore.js — ローカル地図レイヤー（KMZ・画像+JGW）の状態管理
   ================================================================ */

import { OMAP_INITIAL_OPACITY } from '../core/config.js';

let _map = null;

export function init(map) {
  _map = map;
}

// ---- 状態 ----
export const localMapLayers = [];
export let localMapCounter  = 0;

/* ----------------------------------------------------------------
   toRasterOpacity — 3D地形モード時のガンマ補正
   terrain draping では raster-opacity がリニア空間で合成されるため、
   ^3 で逆補正して知覚的に正しい透明感を再現する。
   ---------------------------------------------------------------- */
export function toRasterOpacity(opacity) {
  return _map?.getTerrain() ? Math.pow(opacity, 3) : opacity;
}

/* ----------------------------------------------------------------
   addLocalMapLayer — Blob + 座標から KMZ 系レイヤーを地図に追加する
   loadKmz / loadImageWithJgw / restoreMapLayersFromDb / importModal 共通処理。
   fitBounds は呼び出し元が責任を持つ。
   ---------------------------------------------------------------- */
export function addLocalMapLayer(imageBlob, coordinates, name, {
  opacity     = OMAP_INITIAL_OPACITY,
  visible     = true,
  terrainId   = null,
  terrainName = null,
  mapSheetId  = null,
} = {}) {
  const objectUrl = URL.createObjectURL(imageBlob);
  const id        = localMapCounter++;
  const sourceId  = `kmz-source-${id}`;
  const layerId   = `kmz-layer-${id}`;

  _map.addSource(sourceId, { type: 'image', url: objectUrl, coordinates });
  _map.addLayer({
    id: layerId, type: 'raster', source: sourceId,
    minzoom: 0, maxzoom: 24,
    paint: {
      'raster-opacity':       visible ? toRasterOpacity(opacity) : 0,
      'raster-fade-duration': 0,
      'raster-resampling':    'linear',
    },
  });

  // オーバーレイ（等高線・CS 立体図）の直下に配置する
  const _anchor = ['color-contour-regular', 'contour-regular', 'color-relief-layer',
    'slope-relief-layer', 'rrim-relief-layer', 'cs-relief-layer'].find(lid => _map.getLayer(lid));
  if (_anchor) {
    _map.moveLayer(layerId, _anchor);
  } else if (_map.getLayer('gpx-track-outline')) {
    _map.moveLayer(layerId, 'gpx-track-outline');
  } else {
    _map.moveLayer(layerId);
  }

  // frames-fill が画像レイヤーより上にある場合は下に移動
  if (_map.getLayer('frames-fill')) {
    const _ids = _map.getStyle().layers.map(l => l.id);
    if (_ids.indexOf('frames-fill') > _ids.indexOf(layerId)) {
      _map.moveLayer('frames-fill', layerId);
    }
  }

  const lngs  = coordinates.map(c => c[0]);
  const lats  = coordinates.map(c => c[1]);
  const entry = {
    id, name, sourceId, layerId, objectUrl,
    visible, opacity,
    coordinates: coordinates.map(c => [...c]),
    bbox: {
      west:  Math.min(...lngs), east:  Math.max(...lngs),
      south: Math.min(...lats), north: Math.max(...lats),
    },
    terrainId,
    terrainName,
    mapSheetId,
    dbId: null,
  };
  localMapLayers.push(entry);
  return entry;
}

/* ================================================================
   gpxState.js — GPX リプレイ機能の共有状態オブジェクトと定数
   ================================================================ */

export const gpxState = {
  trackPoints:     [],
  totalDuration:   0,
  currentTime:     0,
  isPlaying:       false,
  animFrameId:     null,
  lastTimestamp:   null,
  viewMode:        '2d',
  chasePitch:      60,
  camDistM:        50,
  bearingOffset:   0,
  chaseKeys: {
    ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  },
  cachedTerrainH:  0,
  lastBearing:     0,
  smoothedBearing: 0,
  smoothedZoom:    15,
  fileName:        null,
  terrainId:       null,
};

export const GPX_CAM_DIST_MIN = 1;
export const GPX_CAM_DIST_MAX = 500;
// bearing / zoom 平滑化の時定数（秒）
export const GPX_BEARING_TC = 0.35;
export const GPX_ZOOM_TC    = 0.15;

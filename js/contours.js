/* ================================================================
   contours.js — 等高線・DEM レイヤー管理
   ================================================================

   このモジュールが管理するもの:
     - 等高線レイヤー ID 定数
     - mlcontour DemSource への参照（contourState）
     - DEMソースモード（q1m / dem5a / dem1a）
     - タイル URL 生成ヘルパー（buildContourTileUrl 系）
     - 等高線 visibility 一括制御（setAllContourVisibility）
     - ズーム threshold・色別等高線カラー式
   ================================================================ */

// ---- 等高線レイヤー ID 定数 ----
// Q地図1m（通常・色別）
export const contourLayerIds         = ['contour-regular', 'contour-index'];
export const COLOR_CONTOUR_Q_IDS     = ['color-contour-regular', 'color-contour-index'];
// DEM5A 5m（通常・色別）
export const DEM5A_CONTOUR_LAYER_IDS  = ['contour-regular-dem5a', 'contour-index-dem5a'];
export const COLOR_CONTOUR_DEM5A_IDS  = ['color-contour-regular-dem5a', 'color-contour-index-dem5a'];
// 地理院 DEM1A 1m（通常・色別）
export const DEM1A_CONTOUR_LAYER_IDS  = ['contour-regular-dem1a', 'contour-index-dem1a'];
export const COLOR_CONTOUR_DEM1A_IDS  = ['color-contour-regular-dem1a', 'color-contour-index-dem1a'];

// ---- 可変状態（app.js の map.on('load') およびイベントハンドラから直接代入して使う） ----
// オブジェクトのプロパティとして公開することで、ES モジュールの live binding 問題を回避する。
export const contourState = {
  // DEMソースモード: 'q1m'（Q地図1m）/ 'dem5a'（DEM5A 5m）/ 'dem1a'（地理院DEM1A 1m）
  demMode: 'q1m',
  // mlcontour.DemSource インスタンス（map.on('load') 内で初期化）
  q1mSource:    null,
  dem5aSource:  null,
  dem1aSource:  null,
  // 湖水深廃止により常に空配列（将来の拡張用として保持）
  seamlessLayerIds: [],
};

// ---- 全等高線レイヤーに visibility を一括設定する ----
// contourState.demMode に従い Q地図 / DEM5A / DEM1A を排他表示する。
// vis='none' のときは全レイヤー非表示（interval 切り替え時の一時的なフラッシュ防止に使用）。
// @param {maplibregl.Map} map  MapLibre マップインスタンス（app.js から渡す）
// @param {'visible'|'none'} vis
export function setAllContourVisibility(map, vis) {
  const qVis     = (vis === 'visible' && contourState.demMode === 'q1m')   ? 'visible' : 'none';
  const dem5aVis = (vis === 'visible' && contourState.demMode === 'dem5a') ? 'visible' : 'none';
  const dem1aVis = (vis === 'visible' && contourState.demMode === 'dem1a') ? 'visible' : 'none';
  for (const id of contourLayerIds)         if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', qVis);
  for (const id of DEM5A_CONTOUR_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', dem5aVis);
  for (const id of DEM1A_CONTOUR_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', dem1aVis);
  // 湖水深は DEM モードに関わらず等高線トグルに従う（廃止後も seamlessLayerIds が残る場合に備える）
  for (const id of contourState.seamlessLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
}

// ---- 色別等高線の line-color MapLibre 式を生成 ----
// DEM2RELIEF_PALETTE に対応した補間式。min/max は色別標高図の crMin/crMax と共有する。
export function buildColorContourExpr(min, max, paletteStops) {
  const range = (max - min) || 1;
  // paletteStops 省略時は虹色（後方互換）
  const stops = paletteStops ?? [
    { t: 0.00, r:   0, g:   6, b: 251 },
    { t: 0.17, r:   0, g: 146, b: 251 },
    { t: 0.33, r:   0, g: 231, b: 251 },
    { t: 0.50, r: 138, g: 247, b:   8 },
    { t: 0.67, r: 242, g: 249, b:  11 },
    { t: 0.83, r: 242, g: 138, b:   9 },
    { t: 1.00, r: 242, g:  72, b:  11 },
  ];
  const toHex = p => '#' + [p.r, p.g, p.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const expr = ['interpolate', ['linear'], ['get', 'ele']];
  for (const p of stops) {
    expr.push(min + p.t * range, toHex(p));
  }
  return expr;
}

// ---- 等高線間隔ごとの mlcontour zoom threshold 設定を生成 ----
// mlcontour の仕様: thresholds の値は [minor, major] の順（小さい間隔が先）
//   level=0 → minor（主曲線）: intervalM ごとに 1 本
//   level=1 → major（計曲線）: intervalM × 5 ごとに 1 本
export function buildContourThresholds(intervalM) {
  // zoom 0〜15 の全レベルに thresholds を設定する（OriLibre ContourIntervalControl と同じアプローチ）
  // 一部の zoom にしか設定しないと setTiles() 後もキャッシュが残り即時反映されない
  //
  // z0〜13 は getEffectiveContourInterval() の自動間隔に合わせた固定値を設定することで、
  // 低ズームで細かい等高線タイルを生成する無駄を防ぐ。
  // z14 以上はユーザー設定間隔（intervalM）を使用する。
  const fixedByZoom = [
  //  z0    z1    z2    z3    z4    z5    z6    z7    z8   z9   z10  z11  z12  z13
    200,  200,  200,  200,  200,  200,  200,  200,  200, 100,   50,  25,  10,   5,
  ];
  const thresholds = {};
  for (let z = 0; z < fixedByZoom.length; z++) {
    const iv = fixedByZoom[z];
    thresholds[z] = [iv, iv * 5];
  }
  for (let z = fixedByZoom.length; z <= 15; z++) {
    thresholds[z] = [intervalM, intervalM * 5];
  }
  return thresholds;
}

// ---- タイル URL 生成 ----
// 3 つの等高線 DEM ソース共通の contourProtocolUrl 生成ロジック
function _buildContourTileUrlFrom(demSource, intervalM) {
  if (!demSource) return null;
  return demSource.contourProtocolUrl({
    thresholds: buildContourThresholds(intervalM),
    contourLayer: 'contours',
    elevationKey: 'ele',
    levelKey: 'level',
    extent: 4096,
    buffer: 1,
  });
}

// Q地図 1m DEM ソースのタイル URL
export function buildContourTileUrl(intervalM)         { return _buildContourTileUrlFrom(contourState.q1mSource,   intervalM); }
// DEM5A 5m DEM ソースのタイル URL
export function buildSeamlessContourTileUrl(intervalM) { return _buildContourTileUrlFrom(contourState.dem5aSource, intervalM); }
// 地理院 DEM1A 1m DEM ソースのタイル URL
export function buildDem1aContourTileUrl(intervalM)    { return _buildContourTileUrlFrom(contourState.dem1aSource, intervalM); }

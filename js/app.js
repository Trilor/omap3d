/* ================================================================
   app.js — アプリケーション本体（地図初期化・KMZ・GPX・UI）
   ================================================================ */

import {
  QCHIZU_DEM_BASE, QCHIZU_PROXY_BASE, DEM5A_BASE, DEM1A_BASE,
  // LAKEDEPTH_BASE, LAKEDEPTH_STANDARD_BASE, // 湖水深タイルは廃止（2026-03-23）
  TERRAIN_URL, CS_RELIEF_URL,
  REGIONAL_CS_LAYERS,
  INITIAL_CENTER, INITIAL_ZOOM, INITIAL_PITCH, INITIAL_BEARING,
  TERRAIN_EXAGGERATION, OMAP_INITIAL_OPACITY, CS_INITIAL_OPACITY,
  RASTER_BASEMAPS
} from './config.js';


// ベースマップ切替の状態管理
// oriLibreLayers: isomizer が追加したレイヤーを [{ id, defaultVisibility }] 形式で保持
let oriLibreLayers = [];
let currentBasemap = 'orilibre';
let oriLibreCachedStyle = null; // isomizer構築完了後のスタイルをキャッシュ（読図マップ用）
let _globeBgEl = null;
let _updateGlobeBg = null;

/*
  ========================================================
  MapLibre GL JS マップの初期化
  new maplibregl.Map() でマップオブジェクトを生成します。
  style はベースマップと DEM ソースだけを持つ最小構成で定義します。
  KMZ から読み込んだ画像レイヤーは後から動的に追加します。
  ========================================================
*/
const map = new maplibregl.Map({

  container: 'map',
  attributionControl: false,
  preserveDrawingBuffer: true, // スクリーンショット・サムネイル生成時に map.getCanvas() をピクセル読み取りするために必要
  style: {
    version: 8,
    // OriLibreのisomizerがベクタースタイルを動的に注入するための基本設定
    // glyphs/spriteはOpenMapTiles互換を使用（isomizer内部のシンボルが動作するよう）
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sprite: 'https://openmaptiles.github.io/osm-bright-gl-style/sprite',

    sources: {

      /*
        --- ソース① 標高（DEM）データ ---
        3D地形のために初期styleに含める必要がある（setTerrainで参照するため）
      */
      'terrain-dem': {
        type: 'raster-dem',
        tiles: [TERRAIN_URL],
        tileSize: 256,
        minzoom: 1,
        maxzoom: 16, // Q地図1m の上限（z16タイルを z17+ でオーバーズーム）
        encoding: 'terrarium',
        attribution: '',
      }

      ,
    }

    ,

    // OriLibreのisomizerがload時にlayersを動的に追加するため、初期は空
    layers: [],
  }

  ,

  center: INITIAL_CENTER,
  zoom: INITIAL_ZOOM,
  pitch: INITIAL_PITCH,
  bearing: INITIAL_BEARING,
  minZoom: 0,
  maxZoom: 24,
  maxPitch: 85,
  locale: {
    'NavigationControl.ZoomIn':           'ズームイン',
    'NavigationControl.ZoomOut':          'ズームアウト',
    'NavigationControl.ResetBearing':     '北を上にリセット',
    'FullscreenControl.Enter':            '全画面表示',
    'FullscreenControl.Exit':             '全画面表示を終了',
    'GeolocateControl.FindMyLocation':    '現在地を表示',
    'GeolocateControl.LocationNotAvailable': '現在地を取得できません',
    'AttributionControl.ToggleAttribution': '出典を表示',
    'AttributionControl.MapFeedback':     'マップのフィードバック',
    'LogoControl.Title':                  'MapLibre',
  },
});

// 出典表示（customAttribution で固定表示、都道府県別CS出典は updateRegionalAttribution で追記）
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution:
    '(<a href="https://www.geospatial.jp/ckan/dataset/qchizu_94dem_99gsi" target="_blank">Q地図1mDEM</a>' +
    ' | <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル[PNG標高DEM5A/湖水深/基準水面標高]</a>' +
    ' | <a href="https://www.ngdc.noaa.gov/geomag/WMM/" target="_blank">WMM/NOAA</a>)' +
    ' を加工して作成',
}), 'bottom-right');

// 出典パネルの開閉を監視し、縮尺コントロールを出典の上に移動（重なり防止）
// MutationObserver: 開閉クラスの変化を検知
// ResizeObserver  : 複数行への折り返しなど高さ変化を都度追従
{
  requestAnimationFrame(() => {
    const attribEl = document.querySelector('.maplibregl-ctrl-attrib');
    const scaleEl  = document.getElementById('scale-ctrl-container');
    if (!attribEl || !scaleEl) return;

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--attrib-h', attribEl.getBoundingClientRect().height + 'px'
      );
    };

    // クラス変化（開く/閉じる）に反応
    new MutationObserver(() => {
      const open = attribEl.classList.contains('maplibregl-compact-show');
      scaleEl.classList.toggle('above-attrib', open);
      if (open) updateHeight();
    }).observe(attribEl, { attributes: true, attributeFilter: ['class'] });

    // 出典の高さが変わるたびに（複数行折り返しを含む）--attrib-h を更新
    new ResizeObserver(updateHeight).observe(attribEl);
  });
}

/*
  ========================================================
  3Dコントロール（NavigationControl）の追加
  ズームボタン・コンパスボタンを右上に追加します。
  visualizePitch: true でコンパスが現在の傾きを視覚的に示します。
  右クリックドラッグ / Ctrl+ドラッグ で Pitch / Bearing を操作できます（MapLibre標準動作）。
  ========================================================
*/
map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');

map.addControl(new maplibregl.NavigationControl({
  visualizePitch: true
}),
  'top-right'
);

/*
  ========================================================
  現在位置取得ボタン（GeolocateControl）
  オリリブレと同様のスタイルで右上に配置。
  enableHighAccuracy: true  → GPS使用（室内でも試みる）
  trackUserLocation: true   → 移動中は自動追従
  showUserHeading: true     → 向きも表示
  ========================================================
*/
map.addControl(new maplibregl.GeolocateControl({
  positionOptions: {
    enableHighAccuracy: true
  }

  ,
  trackUserLocation: true,
  showUserHeading: true,
}),
  'top-right'
);


/*
  ========================================================
  地図エクスポート機能（@watergis/maplibre-gl-export）
  印刷アイコンボタンを右上に追加。PDF / PNG / JPG で出力可能。
  ========================================================
*/
// UMDビルドでは globalThis.MaplibreExportControl が名前空間オブジェクト
// その中にクラス・定数が全てまとまっている
const _exp = window.MaplibreExportControl;
map.addControl(new _exp.MaplibreExportControl({
  PageSize: _exp.Size.A4,
  PageOrientation: _exp.PageOrientation.Landscape,
  Format: _exp.Format.PNG,
  DPI: _exp.DPI[96],
  Crosshair: false,
  PrintableArea: true,
  Local: 'ja',
}), 'top-right');


/*
  ========================================================
  マップの読み込み完了後に 3D Terrain を有効化する
  map.on('load', ...) はスタイル・タイルの初期読み込みが完了したタイミングで発火します。
  ========================================================
*/
// 等高線レイヤーIDリスト（isomizer完了後に収集）
// Q地図1m 等高線レイヤーID（DEM5A・DEM1A と同じ固定定数方式）
const contourLayerIds = ['contour-regular', 'contour-index'];
const COLOR_CONTOUR_Q_IDS    = ['color-contour-regular', 'color-contour-index'];
const COLOR_CONTOUR_DEM5A_IDS = ['color-contour-regular-dem5a', 'color-contour-index-dem5a'];
const COLOR_CONTOUR_DEM1A_IDS = ['color-contour-regular-dem1a', 'color-contour-index-dem1a'];
// 湖水深等高線レイヤーIDリスト（等高線トグルに連動）
let seamlessContourLayerIds = [];
// DEMソースモード: 'q1m'（Q地図1m）/ 'dem5a'（DEM5A 5m）/ 'dem1a'（地理院DEM1A 1m）
let contourDemMode = 'q1m';
// DEM5A・DEM1A 専用レイヤーID
const DEM5A_CONTOUR_LAYER_IDS = ['contour-regular-dem5a', 'contour-index-dem5a'];
const DEM1A_CONTOUR_LAYER_IDS = ['contour-regular-dem1a', 'contour-index-dem1a'];

// 全等高線レイヤーに visibility を一括設定するヘルパー。
// contourDemMode に従い Q地図 / DEM5A / DEM1A を排他表示する。
// vis='none' のときは全レイヤー非表示（interval 切り替え時の一時的なフラッシュに使用）。
function setAllContourVisibility(vis) {
  const qVis     = (vis === 'visible' && contourDemMode === 'q1m')   ? 'visible' : 'none';
  const dem5aVis = (vis === 'visible' && contourDemMode === 'dem5a') ? 'visible' : 'none';
  const dem1aVis = (vis === 'visible' && contourDemMode === 'dem1a') ? 'visible' : 'none';
  for (const id of contourLayerIds)         if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', qVis);
  for (const id of DEM5A_CONTOUR_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', dem5aVis);
  for (const id of DEM1A_CONTOUR_LAYER_IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', dem1aVis);
  // 湖水深は DEM モードに関わらず等高線トグルに従う
  for (const id of seamlessContourLayerIds) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
}

// 色別等高線の line-color 式を生成（DEM2RELIEF_PALETTE に対応したMapLibre補間式）
// min/max は色別標高図の crMin/crMax と共有する
function buildColorContourExpr(min, max) {
  const range = (max - min) || 1;
  return ['interpolate', ['linear'], ['get', 'ele'],
    min + 0.00 * range, '#0006FB',
    min + 0.17 * range, '#0092FB',
    min + 0.33 * range, '#00E7FB',
    min + 0.50 * range, '#8AF708',
    min + 0.67 * range, '#F2F90B',
    min + 0.83 * range, '#F28A09',
    min + 1.00 * range, '#F2480B',
  ];
}

// 等高線間隔ごとのzoom threshold設定を生成
// mlcontourの仕様: thresholds の値は [minor, major] の順（小さい間隔が先）
//   level=0 → minor（主曲線）: intervalM ごとに1本
//   level=1 → major（計曲線）: intervalM × 5 ごとに1本
function buildContourThresholds(intervalM) {
  // zoom 0〜15 の全レベルに thresholds を設定する（OriLibre ContourIntervalControl と同じアプローチ）
  // 一部のzoomにしか設定しないと setTiles() 後もキャッシュが残り即時反映されない
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

// contour-source の tiles URL を生成（demSource は load 内で初期化）
let contourDemSource = null;
let seamlessContourDemSource = null; // DEM5A 5m 等高線ソース（Q地図と独立・排他切り替え）
let dem1aContourDemSource = null;    // 地理院DEM1A 1m 等高線ソース

function buildContourTileUrl(intervalM) {
  if (!contourDemSource) return null;
  return contourDemSource.contourProtocolUrl({
    thresholds: buildContourThresholds(intervalM),
    contourLayer: 'contours',
    elevationKey: 'ele',
    levelKey: 'level',
    extent: 4096,
    buffer: 1,
  });
}

function buildSeamlessContourTileUrl(intervalM) {
  if (!seamlessContourDemSource) return null;
  return seamlessContourDemSource.contourProtocolUrl({
    thresholds: buildContourThresholds(intervalM),
    contourLayer: 'contours',
    elevationKey: 'ele',
    levelKey: 'level',
    extent: 4096,
    buffer: 1,
  });
}

function buildDem1aContourTileUrl(intervalM) {
  if (!dem1aContourDemSource) return null;
  return dem1aContourDemSource.contourProtocolUrl({
    thresholds: buildContourThresholds(intervalM),
    contourLayer: 'contours',
    elevationKey: 'ele',
    levelKey: 'level',
    extent: 4096,
    buffer: 1,
  });
}

/*
  ========================================================
  湖水深等高線関連コード — 廃止（2026-03-23 コメントアウト）
  window.fetch オーバーライド・湖底標高合成・lakeContourDemSource
  ========================================================
*/
// const LAKE_ELEV_PREFIX = 'https://lake-elevation.internal/tiles/';
// const _origFetch = window.fetch.bind(window);
// async function _nodataNumPngResponse() { ... }
// async function synthesizeLakeElevationTile(url) { ... }
// window.fetch = function(input, init) { ... };
// let lakeContourDemSource = null;
// function buildLakeContourTileUrl(intervalM) { ... }

map.on('load', async () => {

  /*
  ========================================================
  ① ラスターベースマップのソースとレイヤーを追加（isomizer より先に配置 → 下層に固定）
  visibility: 'none' で非表示にしておき、ベースマップ切替時に表示する。
  setStyle() を使わないことで、後から追加する KMZ / CS立体図 / 等高線 / 磁北線レイヤーが
  消えないようにしている（visibility 切替方式）。
  ========================================================
  */
  Object.entries(RASTER_BASEMAPS).filter(([, cfg]) => cfg.url).forEach(([key, cfg]) => {
    map.addSource(key, {
      type: 'raster',
      tiles: [cfg.url],
      tileSize: 256,
      maxzoom: cfg.maxzoom,
      attribution: cfg.attr,
    });
    map.addLayer({
      id: key + '-layer',
      type: 'raster',
      source: key,
      layout: { visibility: 'none' },
      paint: { 'raster-fade-duration': 0 },
    });
  });

  /*
  ========================================================
  ② mlcontour DemSource を初期化して等高線ソースを追加
  isomizer より先に contour-source を登録しておくことで、
  isomizer（design-plan.yml）がこのソースを参照してスタイリングできる。
  ========================================================
*/
  // Q地図 1m 等高線ソース
  // Cloudflare Worker プロキシ経由で CORS を解決し、worker: true（バックグラウンドスレッド）で安定動作させる
  try {
    contourDemSource = new mlcontour.DemSource({
      url: `${QCHIZU_PROXY_BASE}/{z}/{x}/{y}.webp`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 16,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    contourDemSource.setupMaplibre(maplibregl);
    map.addSource('contour-source', {
      type: 'vector',
      tiles: [buildContourTileUrl(userContourInterval)],
      maxzoom: 15, // z15タイルをz16以上でオーバーズーム
      attribution: '',
    });
    console.log('Q地図 1m 等高線ソース登録完了');
  } catch (e) {
    console.warn('Q地図 DemSource の初期化に失敗:', e);
  }

  // 湖水深等高線 — 廃止（2026-03-23 コメントアウト）
  // try {
  //   lakeContourDemSource = new mlcontour.DemSource({ url: `${LAKE_ELEV_PREFIX}{z}/{x}/{y}.png`, ... });
  //   lakeContourDemSource.setupMaplibre(maplibregl);
  //   map.addSource('contour-source-lake', { ... });
  // } catch (e) { ... }

  // DEM5A 5m 等高線ソース（Q地図と完全独立・標高タイルのある範囲で全域描画）
  try {
    seamlessContourDemSource = new mlcontour.DemSource({
      url: `${DEM5A_BASE}/{z}/{x}/{y}.png`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 15,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    seamlessContourDemSource.setupMaplibre(maplibregl);
    map.addSource('contour-source-dem5a', {
      type: 'vector',
      tiles: [buildSeamlessContourTileUrl(userContourInterval)],
      maxzoom: 15, // z15タイルをz16以上でオーバーズーム
      attribution: '',
    });
    console.log('DEM5A 等高線ソース登録完了');
  } catch (e) {
    console.warn('DEM5A DemSource の初期化に失敗:', e);
  }

  // 地理院 DEM1A 1m 等高線ソース（DEM5Aと同設定・maxzoomのみ17）
  try {
    dem1aContourDemSource = new mlcontour.DemSource({
      url: `${DEM1A_BASE}/{z}/{x}/{y}.png`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 17,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    dem1aContourDemSource.setupMaplibre(maplibregl);
    map.addSource('contour-source-dem1a', {
      type: 'vector',
      tiles: [buildDem1aContourTileUrl(userContourInterval)],
      maxzoom: 15, // z15タイルをz16以上でオーバーズーム
      attribution: '',
    });
    console.log('DEM1A 等高線ソース登録完了');
  } catch (e) {
    console.warn('DEM1A DemSource の初期化に失敗:', e);
  }

  /*
      ========================================================
      ③ OriLibre（isomizer）でベクタースタイルを構築
      isomizer は contour-source を参照してISOM2017スタイルの等高線レイヤーを生成する。
      ========================================================
    */
  // isomizer が追加するレイヤーを特定するため、呼び出し前のレイヤーIDをスナップショット
  const snapshotBeforeIsomizer = new Set(map.getStyle().layers.map(l => l.id));

  try {
    const { isomizer } = await import('./isomizer/isomizer.js');
    await isomizer(map);
    console.log('OriLibre スタイル構築完了');

    // isomizer完了後、ベースマップ（ofm/gsivt）のfill系レイヤーの minzoom を 0 に下げる。
    // OriLibreのスタイルレイヤーには低ズーム非表示のminzoomが設定されているものがあり、
    // これを解除することで低ズームでも陸地色が表示され続けるようにする。
    // ただし line レイヤーは除外する（低ズームで日本陸地の黒輪郭が出るのを防ぐ）。
    map.getStyle().layers.forEach(layer => {
      if ((layer.source === 'ofm' || layer.source === 'gsivt') && (layer.minzoom || 0) > 0
          && layer.type !== 'line') {
        map.setLayerZoomRange(layer.id, 0, layer.maxzoom !== undefined ? layer.maxzoom : 24);
      }
    });

    // gsivt の line レイヤーはズーム9未満で非表示にする
    // （低ズームで日本陸地の黒輪郭が出る原因のため minzoom を引き上げる）
    map.getStyle().layers.forEach(layer => {
      if (layer.source === 'gsivt' && layer.type === 'line' && (layer.minzoom ?? 0) < 9) {
        map.setLayerZoomRange(layer.id, 9, layer.maxzoom ?? 24);
      }
    });

    // isomizer が追加したレイヤーを収集（ベースマップ切替で一括 visibility 制御するため）
    // contour-source のレイヤーは除外（等高線はベースマップ切替の影響を受けない）
    oriLibreLayers = map.getStyle().layers
      .filter(l => !snapshotBeforeIsomizer.has(l.id) && l.source !== 'contour-source')
      .map(l => ({ id: l.id, defaultVisibility: l.layout?.visibility ?? 'visible' }));
    console.log(`OriLibre レイヤー収集完了: ${oriLibreLayers.length} レイヤー`);

    // 読図マップ用にOriLibreスタイルをキャッシュ（ベースマップ切替後も正しく参照できるよう）
    oriLibreCachedStyle = map.getStyle();

    // ── 低ズームで外洋が緑一色になる問題を修正 ──────────────────────────────
    // OriLibre の海記号は gsivt/waterarea（国土地理院ベクタータイル、日本域のみ）を使用。
    // 外洋（太平洋・日本海等）は gsivt の対象外であり、低ズームでは
    // ofm/landcover（植生フィル）が全域を緑で塗るため、外洋が緑に見える。
    //
    // 対策: ofm/water フィルを gsivt レイヤー群の直前（ofm/landcover の上）に挿入
    //       → ofm が水域ポリゴンを持つズームで、海を水色で上書き
    //
    // background は OriLibre デフォルトの緑のまま維持（陸地の下地色として利用）
    // 結果:  外洋 → ofm/water フィル（水色）が landcover を上書き
    //        陸地 → ofm/landcover（緑）→ OriLibre 通常表示
    const firstGsivtLayerId = map.getStyle().layers
      .find(l => !snapshotBeforeIsomizer.has(l.id) && l.source === 'gsivt')?.id;
    if (firstGsivtLayerId) {
      map.addLayer({
        id: 'water-ocean-fill',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'water',
        maxzoom: 8,   // z8以上は gsivt/waterarea が正確なので非表示
        paint: { 'fill-color': '#00ffff' },
      }, firstGsivtLayerId);
      // ベースマップ切替で非表示にできるよう oriLibreLayers に登録
      oriLibreLayers.push({ id: 'water-ocean-fill', defaultVisibility: 'visible' });
    }

    // ── 3D建物ソース（PLATEAU 全国 LOD1 PMTiles）──────────────────────────────
    // レイヤーの追加は updateBuildingLayer() が担当する。
    map.addSource('plateau-lod1', {
      type: 'vector',
      url: 'pmtiles://https://shiworks.xsrv.jp/pmtiles-data/plateau/PLATEAU_2022_LOD1.pmtiles',
    });
    // ofm ソースは isomizer が追加済み（OriLibre 使用時のみ存在）
    // 初期レイヤーを追加（デフォルト: PLATEAU）
    updateBuildingLayer();

    // isomizer の project-config.yml が別のcenterを持つ場合があるため、
    // 完了後に京都大学（INITIAL_CENTER）へ強制的に戻す
    map.jumpTo({
      center: INITIAL_CENTER, zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, bearing: INITIAL_BEARING
    });
  }

  catch (e) {
    console.warn('OriLibre の読み込みに失敗しました。フォールバックとして淡色地図を使用します。', e);

    map.addSource('basemap-fallback', {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
    });

    map.addLayer({
      id: 'basemap-fallback-layer', type: 'raster', source: 'basemap-fallback'
    });
  }

  // Q地図1m 等高線レイヤーを DEM5A と同じフローで直接 addLayer（isomizer 非依存）
  // isomizer が contour-source 用レイヤーを生成することがあるが、
  // ここで明示的に追加したレイヤーが制御の基準となる。
  // 初期 visibility: 'none' → setAllContourVisibility() で切り替え（DEM5A と同じ挙動）
  if (map.getSource('contour-source')) {
    map.addLayer({
      id: 'contour-regular',
      type: 'line',
      source: 'contour-source',
      'source-layer': 'contours',
      filter: ['!=', ['get', 'level'], 1], // level=0: 主曲線（細線）
      layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#c86400', 'line-width': 1.0, 'line-opacity': 0.85 },
    });
    map.addLayer({
      id: 'contour-index',
      type: 'line',
      source: 'contour-source',
      'source-layer': 'contours',
      filter: ['==', ['get', 'level'], 1], // level=1: 計曲線（太線、5本ごと）
      layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#c86400', 'line-width': 1.79, 'line-opacity': 1.0 },
    });
  }

  // 等高線レイヤーを追加（湖水深 + DEM5A + DEM1A）。Q地図レイヤーは上で追加済み。
  // DEMソースはユーザーが排他切り替え（setContourDemMode参照）。
  // 描画順（上から）: Q地図 > DEM5A > DEM1A（常に全部addするが visibility で排他切り替え）> 湖水深
  if (contourLayerIds.length > 0) {
    const firstQchizuId = contourLayerIds[0];

    // ① DEM5A等高線（Q地図の下）
    if (map.getSource('contour-source-dem5a')) {
      map.addLayer({
        id: 'contour-regular-dem5a',
        type: 'line',
        source: 'contour-source-dem5a',
        'source-layer': 'contours',
        filter: ['!=', ['get', 'level'], 1],
        layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c86400', 'line-width': 1.0, 'line-opacity': 0.85 },
      }, firstQchizuId);
      map.addLayer({
        id: 'contour-index-dem5a',
        type: 'line',
        source: 'contour-source-dem5a',
        'source-layer': 'contours',
        filter: ['==', ['get', 'level'], 1],
        layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c86400', 'line-width': 1.79, 'line-opacity': 1.0 },
      }, firstQchizuId);
    }

    // ① DEM1A等高線（DEM5Aの下）
    if (map.getSource('contour-source-dem1a')) {
      map.addLayer({
        id: 'contour-regular-dem1a',
        type: 'line',
        source: 'contour-source-dem1a',
        'source-layer': 'contours',
        filter: ['!=', ['get', 'level'], 1],
        layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c86400', 'line-width': 1.0, 'line-opacity': 0.85 },
      }, firstQchizuId);
      map.addLayer({
        id: 'contour-index-dem1a',
        type: 'line',
        source: 'contour-source-dem1a',
        'source-layer': 'contours',
        filter: ['==', ['get', 'level'], 1],
        layout: { 'visibility': 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#c86400', 'line-width': 1.79, 'line-opacity': 1.0 },
      }, firstQchizuId);
    }

    // ② 湖水深等高線 — 廃止（2026-03-23 コメントアウト）
    // if (map.getSource('contour-source-lake')) { ... }

    // seamlessContourLayerIds は湖水深廃止により空配列
    seamlessContourLayerIds = [];

    // OriLibre の水域フィルレイヤーが等高線の上に配置されるため最上位へ移動。
    // 移動順: DEM1A < DEM5A < Q地図 の順（Q地図が最終的に一番上）。
    ['contour-regular-dem1a', 'contour-index-dem1a',
     'contour-regular-dem5a', 'contour-index-dem5a',
     ...contourLayerIds,
    ].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
    console.log('等高線レイヤー追加完了（Q地図 + DEM5A + DEM1A）');
  }

  // 色別等高線レイヤー（オーバーレイ「色別等高線」選択時に表示）
  // 各 DEM ソースに対応した 3 セットを追加し、contourDemMode に応じて排他表示する
  {
    const colorExpr = buildColorContourExpr(crMin, crMax);
    const addColorContourPair = (suffix, sourceId) => {
      if (!map.getSource(sourceId)) return;
      map.addLayer({
        id: `color-contour-regular${suffix}`,
        type: 'line', source: sourceId, 'source-layer': 'contours',
        filter: ['!=', ['get', 'level'], 1],
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colorExpr, 'line-width': 0.9, 'line-opacity': 1.0 },
      });
      map.addLayer({
        id: `color-contour-index${suffix}`,
        type: 'line', source: sourceId, 'source-layer': 'contours',
        filter: ['==', ['get', 'level'], 1],
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': colorExpr, 'line-width': 1.8, 'line-opacity': 1.0 },
      });
    };
    addColorContourPair('', 'contour-source');
    addColorContourPair('-dem5a', 'contour-source-dem5a');
    addColorContourPair('-dem1a', 'contour-source-dem1a');
    console.log('色別等高線レイヤー追加完了');
  }

  /*
      ========================================================
      ② ラスターレイヤーを追加（OriLibreベクタースタイルの上層）
      レイヤースタック順（上が前面）:
        KMZ（後から動的追加・常に最上層）
        ↑ 都道府県別CS立体図（0.5m）
        ↑ CS立体図（全国・5m）
        ↑ OriLibreベクタースタイル群（最下層）
      ========================================================
    */

  // 色別標高図（dem2relief://プロトコル・相対カラースケール）
  // min/max パラメータはスライダー操作時に setTiles() で動的更新する
  map.addSource('color-relief', {
    type: 'raster',
    tiles: ['dem2relief://mapdata.qchizu.xyz/03_dem/52_gsi/all_2026/1_01/{z}/{x}/{y}.webp?min=0&max=500&_init=1'],
    tileSize: 512,
    minzoom: 5,
    maxzoom: 15, // Q地図DEMタイルの提供上限(16)よりひとつ下。これ以上のズームはオーバーズームで補完
    attribution: '',
  });
  map.addLayer({
    id: 'color-relief-layer',
    type: 'raster',
    source: 'color-relief',
    // visibility:none で追加すると WebGL シェーダーが未初期化のまま残り
    // 初回レンダリング時に draw_raster.ts で TypeError が発生するため、
    // 常に visible を維持し opacity=0 で非表示制御する
    layout: { visibility: 'visible' },
    paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  });

  // CS立体図（ブラウザ生成・Q地図DEMから動的生成）
  map.addSource('cs-relief', {
    type: 'raster',
    tiles: [CS_RELIEF_URL],
    tileSize: 512,
    minzoom: 5,
    maxzoom: 16,
    attribution: '',
  });

  map.addLayer({

    id: 'cs-relief-layer',
    type: 'raster',
    source: 'cs-relief',
    layout: { visibility: 'none' },
    paint: {
      'raster-opacity': CS_INITIAL_OPACITY,
      // // 乗算（Multiply）の代替：白浮きを防ぎコントラストを強調する
      // 'raster-contrast': 0.2,
      // 'raster-brightness-max': 0.8,
      // 'raster-fade-duration': 150,
    }

    ,
  });

  /*
      ========================================================
      ③ 3D Terrain（地形立体化）の有効化
      OriLibre / ラスターレイヤー追加後にsetTerrainすることで
      ベクタースタイルとも整合が取れる。
      ========================================================
    */
  map.setTerrain({
    source: 'terrain-dem',
    exaggeration: TERRAIN_EXAGGERATION,
  });

  // 都道府県別CS立体図（0.5m）のソース・レイヤーを動的追加
  // ソースの minzoom を 17 に下げることで、ズーム17でも表示可能にする
  // （z=17 では地域DEMが無い場合でも Q地図 DEM にフォールバックして描画）
  REGIONAL_CS_LAYERS.forEach(layer => {
    const srcCfg = {
      type: 'raster',
      tiles: [layer.tileUrl],
      tileSize: 256,
      minzoom: Math.min(layer.minzoom, 17),
      maxzoom: layer.maxzoom,
      bounds: layer.bounds,
      attribution: '', // 動的表示に切り替えるため MapLibre の自動収集は無効化
    };
    if (layer.scheme) srcCfg.scheme = layer.scheme;
    map.addSource(layer.sourceId, srcCfg);

    map.addLayer({

      id: layer.layerId,
      type: 'raster',
      source: layer.sourceId,
      layout: {
        visibility: 'none',
      },
      paint: {
        'raster-opacity': 1.0,
        'raster-fade-duration': 150,
      }

      ,
    });
  });

  // 磁北線 GeoJSON ソース＋レイヤー
  map.addSource('magnetic-north', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'magnetic-north-layer',
    type: 'line',
    source: 'magnetic-north',
    layout: { visibility: 'visible' },
    paint: {
      'line-color': '#0055cc',
      'line-width': 0.8,
      'line-opacity': 1.0,
    },
  });
  updateMagneticNorth();

  // 都道府県別CS出典の動的更新 — タイル読み込み完了を待たず即時反映するため moveend を使用
  map.on('moveend', updateRegionalAttribution);
  // スクロールズーム時に moveend が連続発火するため debounce でまとめて1回だけ実行する
  let _magnNorthTimer;
  map.on('moveend', () => {
    clearTimeout(_magnNorthTimer);
    _magnNorthTimer = setTimeout(updateMagneticNorth, 200);
  });
  // zoomend で等高線間隔を更新する（zoom イベントだとズーム中に setTiles が呼ばれてキャッシュが
  // クリアされ等高線が一瞬消えるため、ズーム完了後に一度だけ実行する）
  map.on('zoomend', updateContourAutoInterval);
  // 起動時は zoom イベントが発火しないため、load 完了後に一度だけ初期化する
  updateContourAutoInterval();

  // 初期ベースマップ（OriLibre）の出典を表示
  // MapLibreはsource追加のたびに .maplibregl-ctrl-attrib-inner を書き換えるため
  // MutationObserver で監視し、書き換えられるたびに先頭スパンを再挿入する
  (function retryInitAttr(attempts) {
    if (!initAttributionObserver() && attempts > 0) {
      setTimeout(() => retryInitAttr(attempts - 1), 300);
    }
  })(15);

  // ④ Globe投影（ズーム7以下で地球が球体に見える広域表示）
  // MapLibre v5 以降で利用可能。高ズームではメルカトルに自動移行する。
  map.setProjection({ type: 'globe' });

  // ズーム7以下（globe表示時）は宇宙空間を黒背景で表現する
  _globeBgEl = document.getElementById('map');
  _updateGlobeBg = () => {
    if (!_globeBgEl) return;
    const highZoomColor = simActive ? '#dbeff9' : '#fff';
    _globeBgEl.style.backgroundColor = map.getZoom() < 7 ? '#000' : highZoomColor;
  };
  map.on('zoom', _updateGlobeBg);
  _updateGlobeBg();

  // ⑤ テレインマスタ → フレームの順で自動読み込みする
  autoLoadTerrains();

  console.log('3D OMap Viewer 初期化完了（OriLibreベースマップ）');
});


/* ========================================================
    KMZ 読み込み済みレイヤーの管理リスト
    各エントリは以下の情報を保持します：
      id        : 連番（ユニークなソース/レイヤーIDの生成に使用）
      name      : ファイル名（UIに表示）
      sourceId  : MapLibre に登録したソースのID
      layerId   : MapLibre に登録したレイヤーのID
      objectUrl : 画像のObjectURL（不要になったら revoke が必要）
    ======================================================== */
const kmzLayers = [];
let kmzCounter = 0;

// MapLibre の 3D 地形（terrain draping）モードでは、ラスターレイヤーを
// WebGL フレームバッファに合成する際にアルファがリニア空間で処理されるため、
// raster-opacity が視覚的に非線形に見える（0.5 → ほぼ不透明）。
// 地形 ON 時はガンマ補正の逆変換（^2.5）を適用し、知覚的に正しい透明感を再現する。
function toRasterOpacity(opacity) {
  return map.getTerrain() ? Math.pow(opacity, 3) : opacity;
}

// 地図種別・サブタイプの日本語表示マップ
const MAP_TYPE_JA    = { sprint: 'スプリント', forest: 'フォレスト' };
const MAP_SUBTYPE_JA = { stadium: 'スタジアム', school: '学校', park: '公園', urban: '市街地', campus: 'キャンパス' };


// HTML 特殊文字をエスケープしてインジェクションを防ぐ
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ========================================================
    GPX リプレイ機能：状態管理変数
    ======================================================== */

// GPXのトラックポイント配列（{lng, lat, relTime}の形式）
let gpxTrackPoints = [];
// アニメーション開始からの経過時間（ミリ秒）: 0 〜 totalDuration
let gpxTotalDuration = 0;
// 現在の再生位置（ミリ秒）
let gpxCurrentTime = 0;
// 再生中かどうか
let gpxIsPlaying = false;
// requestAnimationFrameのID（キャンセルに使用）
let gpxAnimFrameId = null;
// 前フレームのタイムスタンプ（差分計算用）
let gpxLastTimestamp = null;
// 視点モード: '2d'＝俯瞰（上空固定） / '3d'＝PCシム追尾カメラ
let gpxViewMode = '2d';
// 3D 追尾カメラ独自パラメータ（PC シムとは独立）
let gpxChasePitch  = 60;   // ピッチ（deg）
let gpxCamDistM    = 50;   // カメラ距離（m）
let gpxBearingOffset = 0;  // 進行方向からの bearing オフセット（deg）
const GPX_CAM_DIST_MIN = 1;
const GPX_CAM_DIST_MAX = 500;
// 矢印キー押下状態（3D モード専用）
const gpxChaseKeys = {
  ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
};
// 追尾カメラ用の地形高度キャッシュ（queryTerrainElevation が null のときに維持）
let _gpxCachedTerrainH = 0;
// 前フレームの進行方向（端点など bearing=0 になる箇所の補完用）
let _lastGpxBearing = 0;
// bearing / zoom のローパスフィルタ値（カクカク防止）
let _smoothedGpxBearing = 0;
let _smoothedGpxZoom    = 15;
// bearing 平滑化の時定数（秒）。大きいほど滑らかで遅延が増す
const GPX_BEARING_TC = 0.35;
const GPX_ZOOM_TC    = 0.15;


/* ========================================================
    KMZ ファイルを処理するメイン関数
    引数 file : ユーザーが選択した File オブジェクト
    ======================================================== */
async function loadKmz(file) {
  try {
    /*
      --- ステップ① JSZip で KMZ（ZIP）を解凍する ---
      file.arrayBuffer() でファイルの中身をバイト列として読み込み、
      JSZip.loadAsync() に渡すことで ZIP の中身を展開します。
      zip.files はファイルパスをキー、ZipObject を値とするオブジェクトです。
    */
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // ZIP 内のすべてのファイルパスを配列にまとめる
    const fileNames = Object.keys(zip.files);

    /*
      --- ステップ② KML ファイルを特定する ---
      KMZ の中には通常 "doc.kml" という名前で KML が入っています。
      ただし名前が異なる場合もあるため、拡張子 .kml で検索します。
    */
    const kmlFileName = fileNames.find(name => name.toLowerCase().endsWith('.kml'));

    if (!kmlFileName) {
      alert('エラー：KMZファイルの中にKMLファイルが見つかりませんでした。\nファイルが正しい形式かどうかを確認してください。');
      return;
    }

    // KML ファイルの内容をテキスト（文字列）として取得する
    const kmlText = await zip.files[kmlFileName].async('text');

    /*
      --- ステップ③ KML を XML として解析（パース）する ---
      DOMParser は HTML や XML をブラウザのDOM構造に変換する標準APIです。
      これにより、XML のタグ名で要素を検索できるようになります。
    */
    const parser = new DOMParser();
    const kmlDom = parser.parseFromString(kmlText, 'text/xml');

    // XML パース失敗時は parseerror 要素が返るため先に確認する
    if (kmlDom.getElementsByTagName('parsererror').length > 0) {
      alert('エラー：KMLファイルのXML解析に失敗しました。\nファイルが壊れているか、文字コードが対応していない可能性があります。');
      return;
    }

    /*
      --- ステップ④ GroundOverlay タグを探す ---
      GroundOverlay は KML の「画像を地図上の指定範囲に貼り付ける」要素です。
      オリエンテーリングマップの KMZ では通常ここにマップ画像の情報が入っています。
    */
    // getElementsByTagNameNS('*', tag) は名前空間を問わずローカル名で検索するため
    // xmlns="http://www.opengis.net/kml/2.2" 付き KML でも確実に動作する。
    const kmlGet = (root, tag) => root.getElementsByTagNameNS('*', tag)[0]
      ?? root.getElementsByTagName(tag)[0];

    const groundOverlay = kmlGet(kmlDom, 'GroundOverlay');

    if (!groundOverlay) {
      alert('エラー：KMLファイルの中にGroundOverlay要素が見つかりませんでした。\nこのKMZはオーバーレイ画像を含んでいない可能性があります。');
      return;
    }

    /*
      --- ステップ⑤ LatLonBox から座標情報を取り出す ---
      LatLonBox は画像を貼り付ける矩形の緯度経度範囲と回転角を定義します。
      各タグの textContent を数値に変換して取得します。
    */
    const latLonBox = kmlGet(groundOverlay, 'LatLonBox');

    if (!latLonBox) {
      alert('エラー：GroundOverlay の中に LatLonBox 要素が見つかりませんでした。');
      return;
    }

    // テキストで書かれた緯度経度を数値に変換する
    const north = parseFloat(kmlGet(latLonBox, 'north')?.textContent);
    const south = parseFloat(kmlGet(latLonBox, 'south')?.textContent);
    const east  = parseFloat(kmlGet(latLonBox, 'east')?.textContent);
    const west  = parseFloat(kmlGet(latLonBox, 'west')?.textContent);
    // rotation は省略されることもあるので、ない場合は 0 とする
    const rotation = parseFloat(kmlGet(latLonBox, 'rotation')?.textContent ?? '0');

    if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) {
      alert('エラー：LatLonBox の座標値が正しく読み取れませんでした。');
      return;
    }

    /*
      --- ステップ⑥ MapLibre の coordinates 配列を計算する ---

      MapLibre の image source の coordinates は以下の順番で4点を指定します：
        [ 左上(TL), 右上(TR), 右下(BR), 左下(BL) ]
        = [ [西,北], [東,北], [東,南], [西,南] ]
      （※ 経度が先、緯度が後 = [lng, lat] の順）

      KML の LatLonBox には rotation（反時計回り、単位:度）が含まれる場合があります。
      rotation が 0 でない場合、単純に north/south/east/west を組み合わせるだけでは
      画像が傾いた状態で正しく配置されません。

      そのため、矩形の中心を基準に各コーナーを回転させて計算します。
    */

    // 矩形の中心座標（経度・緯度）
    const cx = (east + west) / 2;
    const cy = (north + south) / 2;

    // 中心から各コーナーまでの幅・高さの半分
    const hw = (east - west) / 2; // 水平方向の半幅
    const hh = (north - south) / 2; // 垂直方向の半高さ

    // KML の rotation は反時計回りなので、sin/cos に渡す角度は正の方向が反時計回り
    const rad = rotation * Math.PI / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // ★追加: 地球の丸みによる経度の縮み（アスペクト比）を中心緯度から計算
    const latCos = Math.cos(cy * Math.PI / 180);

    /*
      回転変換の式：
      経緯度の長さの違いを補正して回転させないと、画像が歪んで角度がズレるため
      一旦スケールを合わせて回転させ、その後経度を元に戻します。
    */
    function rotateCorner(dx, dy) {
      // 経度方向の差分を、緯度方向と同じスケール比率に合わせる
      const dxScaled = dx * latCos;
      
      // スケールを合わせた状態で回転計算
      const rxScaled = dxScaled * cosR - dy * sinR;
      const ry = dxScaled * sinR + dy * cosR;
      
      // 経度を元の度単位のスケールに戻して足し合わせる
      return [
        cx + (rxScaled / latCos), // 回転後の経度
        cy + ry                   // 回転後の緯度
      ];
    }

    // MapLibre の coordinates 配列（TL → TR → BR → BL の順）
    const coordinates = [rotateCorner(-hw, +hh),
    // 左上（TL）
    rotateCorner(+hw, +hh),
    // 右上（TR）
    rotateCorner(+hw, -hh),
    // 右下（BR）
    rotateCorner(-hw, -hh),
      // 左下（BL）
    ];

    /*
      --- ステップ⑦ KML 内の画像ファイルを特定して ObjectURL を生成する ---
      GroundOverlay > Icon > href タグに画像ファイルのパスが書かれています。
      そのファイルを ZIP から取り出し、Blob → ObjectURL に変換します。
    */
    const iconEl = kmlGet(groundOverlay, 'Icon');
    const iconHref = iconEl ? kmlGet(iconEl, 'href')?.textContent?.trim() : undefined;

    if (!iconHref) {
      alert('エラー：GroundOverlay に Icon/href が見つかりませんでした。');
      return;
    }

    // ZIP 内でのファイルパスを検索（階層付きパスに対応）
    const imgEntry = zip.files[iconHref] ?? zip.files[fileNames.find(n => n.endsWith('/' + iconHref) || n === iconHref)];

    if (!imgEntry) {
      alert(`エラー：KMZ内に画像ファイル "${iconHref}" が見つかりませんでした。`);
      return;
    }

    // 画像をバイナリとして取り出し、Blob に変換する
    const imgBlob = await imgEntry.async('blob');

    /*
      URL.createObjectURL() は Blob をブラウザ内で使えるメモリURL（"blob:..." 形式）に変換します。
      この URL は通常の https:// のように MapLibre から参照できます。
      レイヤーを削除する際には URL.revokeObjectURL() でメモリを解放することが重要です。
    */
    const objectUrl = URL.createObjectURL(imgBlob);

    /*
      --- ステップ⑧ MapLibre にソースとレイヤーを追加する ---
      各 KMZ に一意の ID を付けて管理します。
    */
    const id = kmzCounter++;
    const sourceId = `kmz-source-${id}`;
    const layerId = `kmz-layer-${id}`;

    /*
      type: 'image' は「指定した4点の座標に画像を貼り付ける」特殊なソースタイプです。
      url         : 表示する画像のURL（ObjectURL を使用）
      coordinates : [ TL, TR, BR, BL ] の順番で [lng, lat] 配列を4つ指定
    */
    map.addSource(sourceId, {
      type: 'image',
      url: objectUrl,
      coordinates: coordinates,
    });

    map.addLayer({
      id: layerId,
      type: 'raster',
      source: sourceId,
      minzoom: 0,
      maxzoom: 24,
      paint: {
        'raster-opacity': toRasterOpacity(OMAP_INITIAL_OPACITY),
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
      },
    });
    // レイヤーを確実に上層へ移動（等高線・CSレイヤーより上、GPXレイヤーより下）
    // GPXレイヤーが存在する場合はその直下に挿入し、GPXが常に最前面になるようにする
    if (map.getLayer('gpx-track-outline')) {
      map.moveLayer(layerId, 'gpx-track-outline');
    } else {
      map.moveLayer(layerId);
    }

    // --- ステップ⑨ 地図全体が収まる範囲にフィット ---
    // 回転後コーナー座標（coordinates）から正確な BBox を計算する。
    const allLngs = coordinates.map(c => c[0]);
    const allLats = coordinates.map(c => c[1]);
    const bboxWest = Math.min(...allLngs);
    const bboxEast = Math.max(...allLngs);
    const bboxSouth = Math.min(...allLats);
    const bboxNorth = Math.max(...allLats);
    // サイドバー（左約 300px）を考慮した非対称 padding を指定する。
    // padding.left を大きくすることでパネル右の可視エリアにKMZが収まる。
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? 300;

    map.fitBounds([[bboxWest, bboxSouth], [bboxEast, bboxNorth]],
      {
        padding: {
          top: 60, bottom: 60, left: panelWidth + 30, right: 60
        }

        ,
        pitch: INITIAL_PITCH,
        duration: 600,
        maxZoom: 19, // 過度なズームインを防ぎKMZ全体を表示
      });
    // fitBounds後も画像が最上層になるよう moveLayer
    map.moveLayer(layerId);

    // 管理リストに追加（visible・opacityも保持して個別制御できるようにする）
    const entry = {
      id,
      name: file.name,
      sourceId, layerId, objectUrl,
      visible: true, opacity: OMAP_INITIAL_OPACITY,
      bbox: { west: bboxWest, east: bboxEast, south: bboxSouth, north: bboxNorth },
    };
    kmzLayers.push(entry);

    // UIの一覧を更新する
    renderKmzList();

    console.log(`KMZ 読み込み完了: ${file.name}`, { coordinates, rotation });

  }

  catch (err) {
    console.error('KMZ読み込みエラー:', err);

    alert(`KMZファイルの読み込み中にエラーが発生しました。\n詳細: ${err.message}`);
  }
}


/* =====================================================================
   画像（JPG/PNG）＋ JGW ワールドファイル 読み込み
   ===================================================================== */

// ---- JGD2011 平面直角座標系 全19系の原点パラメータ ----
// 各要素: [緯度原点(°), 経度原点(°)]
// インデックス 0 は未使用（系番号は 1 始まり）
const JGD2011_ZONE_PARAMS = [
  null,
  [33,   129.5             ],  // 第1系  長崎・鹿児島南部
  [33,   131               ],  // 第2系  福岡・佐賀・熊本・大分・宮崎・鹿児島北部
  [36,   132.16666666667   ],  // 第3系  山口・島根・広島
  [33,   133.5             ],  // 第4系  香川・愛媛・徳島・高知
  [36,   134.33333333333   ],  // 第5系  兵庫・鳥取・岡山
  [36,   136               ],  // 第6系  京都・大阪・福井・滋賀・三重・奈良・和歌山
  [36,   137.16666666667   ],  // 第7系  石川・富山・岐阜・愛知
  [36,   138.5             ],  // 第8系  新潟・長野・山梨・静岡
  [36,   139.83333333333   ],  // 第9系  東京・福島・栃木・茨城・埼玉・千葉・神奈川
  [40,   140.83333333333   ],  // 第10系 青森・秋田・山形・岩手・宮城
  [44,   140.25            ],  // 第11系 北海道（小樽・旭川・帯広・釧路方面）
  [44,   142.25            ],  // 第12系 北海道（札幌・函館方面）
  [44,   144.25            ],  // 第13系 北海道（網走・北見・紋別方面）
  [26,   142               ],  // 第14系 小笠原諸島
  [26,   127.5             ],  // 第15系 沖縄本島
  [26,   124               ],  // 第16系 石垣島・西表島
  [26,   131               ],  // 第17系 大東島
  [20,   136               ],  // 第18系 沖ノ鳥島
  [26,   154               ],  // 第19系 南鳥島
];

// JGD2011 第n系の proj4 文字列を返す
function getJgd2011Proj4(zone) {
  const [lat0, lon0] = JGD2011_ZONE_PARAMS[zone];
  // GRS80 楕円体、中央経線係数 0.9999、原点 (lat0, lon0)、フォールスイースティング/ノーシング = 0
  return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
}

// ---- JGW（World File）の6行テキストを解析 ----
function parseJgw(text) {
  // 行1: A — x 方向のピクセルサイズ（東向き正、度 or メートル/ピクセル）
  // 行2: D — y 軸周りの回転（通常 0）
  // 行3: B — x 軸周りの回転（通常 0）
  // 行4: E — y 方向のピクセルサイズ（南向き負）
  // 行5: C — 左上ピクセル中心の x 座標（経度 or 東距 [m]）
  // 行6: F — 左上ピクセル中心の y 座標（緯度 or 北距 [m]）
  const vals = text.trim().split(/\r?\n/).map(l => parseFloat(l.trim()));
  if (vals.length < 6 || vals.some(isNaN)) return null;
  return { A: vals[0], D: vals[1], B: vals[2], E: vals[3], C: vals[4], F: vals[5] };
}

// ---- 画像 + JGW を MapLibre に追加 ----
async function loadImageWithJgw(imageFile, jgwText, crsValue) {
  // ① 画像の Object URL を生成し、ピクセルサイズ（W×H）を取得する
  const objectUrl = URL.createObjectURL(imageFile);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload  = () => resolve(i);
    i.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('画像の読み込みに失敗しました')); };
    i.src = objectUrl;
  });
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // ② JGW を解析する
  const jgw = parseJgw(jgwText);
  if (!jgw) {
    URL.revokeObjectURL(objectUrl);
    throw new Error('JGWファイルの解析に失敗しました（数値6行が必要です）');
  }

  // ③ アフィン変換で4コーナーの CRS 座標を計算する
  // x = A*col + B*row + C,  y = D*col + E*row + F
  const corner = (col, row) => [
    jgw.A * col + jgw.B * row + jgw.C,  // x（東距 or 経度）
    jgw.D * col + jgw.E * row + jgw.F,  // y（北距 or 緯度）
  ];
  const cornersXY = [
    corner(0,     0    ),  // TL（左上）
    corner(W - 1, 0    ),  // TR（右上）
    corner(W - 1, H - 1),  // BR（右下）
    corner(0,     H - 1),  // BL（左下）
  ];

  // ④ CRS → WGS84（緯度経度）に変換する
  let coordinates;
  if (crsValue === 'wgs84') {
    // WGS84 の場合はそのまま [lng, lat] として使用する
    coordinates = cornersXY;
  } else {
    // JGD2011 平面直角座標系 → WGS84 変換
    const zone    = parseInt(crsValue.replace('jgd', ''), 10);
    const fromCRS = getJgd2011Proj4(zone);
    const toCRS   = '+proj=longlat +datum=WGS84 +no_defs';
    // proj4(fromCRS, toCRS, [easting, northing]) → [lng, lat]
    coordinates = cornersXY.map(([x, y]) => proj4(fromCRS, toCRS, [x, y]));
  }

  // ⑤ MapLibre にソース（type:'image'）とレイヤー（type:'raster'）を追加する
  const id       = kmzCounter++;
  const sourceId = `kmz-source-${id}`;
  const layerId  = `kmz-layer-${id}`;
  map.addSource(sourceId, { type: 'image', url: objectUrl, coordinates });
  map.addLayer({
    id: layerId, type: 'raster', source: sourceId,
    minzoom: 0, maxzoom: 24,
    paint: {
      'raster-opacity':       toRasterOpacity(OMAP_INITIAL_OPACITY),
      'raster-fade-duration': 0,
      'raster-resampling':    'linear',
    },
  });

  // GPX 軌跡レイヤーの下に挿入する（KMZ と同じ扱い）
  if (map.getLayer('gpx-track-outline')) {
    map.moveLayer(layerId, 'gpx-track-outline');
  } else {
    map.moveLayer(layerId);
  }
  // frames-fill が KMZ レイヤーより上にある場合は下に移動
  if (map.getLayer('frames-fill')) {
    const styleLayers = map.getStyle().layers.map(l => l.id);
    const fillIdx = styleLayers.indexOf('frames-fill');
    const imgIdx  = styleLayers.indexOf(layerId);
    if (fillIdx > imgIdx && fillIdx >= 0 && imgIdx >= 0) {
      map.moveLayer('frames-fill', layerId);
    }
  }

  // ⑥ 管理リストに追加して UI を更新する
  const lngs = coordinates.map(c => c[0]);
  const lats = coordinates.map(c => c[1]);
  kmzLayers.push({
    id, name: imageFile.name,
    sourceId, layerId, objectUrl,
    visible: true, opacity: OMAP_INITIAL_OPACITY,
    bbox: { west: Math.min(...lngs), east: Math.max(...lngs), south: Math.min(...lats), north: Math.max(...lats) },
  });
  renderKmzList();

  // ⑦ 追加した画像の範囲にカメラをフィットさせる
  const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? 300;
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: { top: 60, bottom: 60, left: panelWidth + 30, right: 60 },
      pitch: INITIAL_PITCH, duration: 600, maxZoom: 19 }
  );
  console.log(`画像+JGW 読み込み完了: ${imageFile.name}`, { crsValue, coordinates });
}

/* ---- 画像+JGW モーダルの状態 ---- */
let imgwModalImages  = [];   // 選択中の画像ファイル配列（File[]）
let imgwModalJgwFile = null; // 選択中のワールドファイル（File | null）

// モーダルを開く。drag&drop 時は preImages / preJgw を事前セットできる
function openImgwModal(preImages, preJgw) {
  imgwModalImages  = preImages || [];
  imgwModalJgwFile = preJgw   || null;
  updateImgwModalUI();
  document.getElementById('imgw-modal').style.display = 'flex';
}

// モーダルを閉じて状態をリセットする
function closeImgwModal() {
  document.getElementById('imgw-modal').style.display = 'none';
  imgwModalImages  = [];
  imgwModalJgwFile = null;
}

// モーダル内の表示を選択状態に合わせて更新する
function updateImgwModalUI() {
  // --- 画像ファイルリスト ---
  const imgBtn  = document.getElementById('imgw-img-btn');
  const imgList = document.getElementById('imgw-img-list');
  if (imgwModalImages.length > 0) {
    imgList.innerHTML = imgwModalImages
      .map(f => `<div class="imgw-file-item">${escHtml(f.name)}</div>`).join('');
    imgBtn.classList.add('has-files');
    imgBtn.textContent = `画像を変更（現在 ${imgwModalImages.length} 枚）`;
  } else {
    imgList.innerHTML = '';
    imgBtn.classList.remove('has-files');
    imgBtn.textContent = '画像を選択（JPG / PNG）';
  }

  // --- ワールドファイル ---
  const jgwBtn  = document.getElementById('imgw-jgw-btn');
  const jgwName = document.getElementById('imgw-jgw-name');
  if (imgwModalJgwFile) {
    jgwName.innerHTML = `<div class="imgw-file-item">${escHtml(imgwModalJgwFile.name)}</div>`;
    jgwBtn.classList.add('has-files');
    jgwBtn.textContent = 'ワールドファイルを変更';
  } else {
    jgwName.innerHTML = '';
    jgwBtn.classList.remove('has-files');
    jgwBtn.textContent = 'ワールドファイルを選択（JGW / PGW / TFW）';
  }

  // --- 配置ボタンの有効/無効 ---
  document.getElementById('imgw-place-btn').disabled =
    imgwModalImages.length === 0 || imgwModalJgwFile === null;
}

// 「地図に配置」ボタン押下時の処理
async function executeImgwPlace() {
  const crsValue = document.getElementById('imgw-crs-select').value;
  const placeBtn = document.getElementById('imgw-place-btn');
  placeBtn.disabled = true;
  placeBtn.textContent = '配置中…';

  try {
    const jgwText = await imgwModalJgwFile.text();
    // 選択した全画像に同じワールドファイル（位置情報）を適用する
    for (const imgFile of imgwModalImages) {
      await loadImageWithJgw(imgFile, jgwText, crsValue);
    }
    closeImgwModal();
  } catch (err) {
    console.error('画像+JGW 読み込みエラー:', err);
    alert(`読み込みエラー: ${err.message}`);
    placeBtn.disabled = false;
    placeBtn.textContent = '地図に配置';
  }
}


/* ====================================================================
   フレームベース 地図カタログ システム
   mapFrames: GeoJSON から読み込んだフレーム（枠）を管理する配列
   各エントリ構造:
   · id            — GeoJSON feature.id（文字列）
   · properties    — GeoJSON の properties オブジェクト（terrain_id 含む）
   · coordinates   — 4隅 [[lng,lat],...] (TL→TR→BR→BL)
   · opacity       — 透過率 0–1（画像切り替え時も維持）
   · images        — [{ id, name, url }] 割り当て済み画像
   · activeImageId — 表示中の画像 id（null = 未割当）
   · sourceId      — MapLibre image source ID（null = 未割当）
   · layerId       — MapLibre raster layer ID（null = 未割当）
   ==================================================================== */

// terrain_type/terrain_subtype に基づくカラー式（frames-src・terrain-boundary-src 共用）
// terrain_type/terrain_subtype は updateFrameGeoJsonSource/updateTerrainBoundarySource で terrainMap から注入される
const FRAME_COLOR_EXPR = [
  'case',
  ['==', ['get', 'terrain_subtype'], 'stadium'], '#7c3fff',
  ['==', ['get', 'terrain_type'],    'forest'],  '#c8a000',
  ['==', ['get', 'terrain_type'],    'sprint'],  '#ff7700',
  '#888888',
];

// ---- 地方 → 都道府県 マッピング（Miller Columnsブラウザ用）----
const REGION_PREF_MAP = {
  '北海道':   ['北海道'],
  '東北':     ['青森県','岩手県','宮城県','秋田県','山形県','福島県'],
  '関東':     ['東京都','茨城県','栃木県','群馬県','埼玉県','千葉県','神奈川県'],
  '中部':     ['新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県'],
  '近畿':     ['京都府','大阪府','三重県','滋賀県','兵庫県','奈良県','和歌山県'],
  '中国':     ['鳥取県','島根県','岡山県','広島県','山口県'],
  '四国':     ['徳島県','香川県','愛媛県','高知県'],
  '九州・沖縄': ['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'],
  '海外':     [],
};
// 都道府県 → 地方 の逆引きマップを生成する
const PREF_TO_REGION = {};
for (const [region, prefs] of Object.entries(REGION_PREF_MAP)) {
  for (const p of prefs) PREF_TO_REGION[p] = region;
}
function prefToRegion(pref) { return PREF_TO_REGION[pref] ?? '海外'; }

// Miller Columns ブラウザの選択状態
let millerRegion  = null; // 選択中の地方
let millerPref    = null; // 選択中の都道府県
let millerTerrain = null; // 選択中の terrain_id

const mapFrames = [];
const terrainMap = new Map(); // terrain_id → { name, prefecture, terrain_type, terrain_subtype, description, geometry }
let   activeTypeFilter   = '';   // '' | 'sprint' | 'forest'
let   selectedTerrainId  = null; // クリック時にハイライト中のテレインID
let   frameImgCounter    = 0;   // 画像ごとのユニーク ID カウンター
let   currentFramePicker = null; // 現在画像ピッカーを開いているフレーム ID
let   frameHoverPopup    = null; // ホバー用ポップアップ（単一共有）
let   frameClickPopup    = null; // クリック用ポップアップ（単一共有）

// ---- 汎用：MapLibre に image ソース + raster レイヤーを追加・更新する ----
function addImageLayerToMap(sourceId, layerId, imageUrl, coordinates, opacity) {
  if (map.getSource(sourceId)) {
    // ソースが既存 → 座標は変えず画像だけ差し替える
    map.getSource(sourceId).updateImage({ url: imageUrl });
    return;
  }
  map.addSource(sourceId, { type: 'image', url: imageUrl, coordinates });
  map.addLayer({
    id: layerId, type: 'raster', source: sourceId,
    minzoom: 0, maxzoom: 24,
    paint: {
      'raster-opacity':       toRasterOpacity(opacity),
      'raster-fade-duration': 0,
      'raster-resampling':    'linear',
    },
  });
  // オーバーレイ（色別等高線・色別標高図・CS立体図）の下、ベースマップの上に配置する
  // → オーバーレイが常に地図画像より前面に表示される
  const overlayAnchor = ['color-contour-regular', 'color-relief-layer', 'cs-relief-layer']
    .find(id => map.getLayer(id));
  if (overlayAnchor) {
    map.moveLayer(layerId, overlayAnchor);
  } else if (map.getLayer('gpx-track-outline')) {
    map.moveLayer(layerId, 'gpx-track-outline');
  } else if (map.getLayer('frames-outline')) {
    map.moveLayer(layerId, 'frames-outline');
  } else {
    map.moveLayer(layerId);
  }
}

// ---- GeoJSON 解析: Feature → mapFrames エントリに変換 ----
function featureToFrameEntry(feature) {
  const ring = feature.geometry?.coordinates?.[0];
  if (!ring || ring.length < 4) return null;
  // GeoJSON は [lng,lat] 順。ポリゴン頂点 0–3 を TL,TR,BR,BL として取得する
  const coordinates = [ring[0], ring[1], ring[2], ring[3]];
  return {
    id:           String(feature.id ?? feature.properties?.event_name ?? Math.random()),
    properties:   { ...feature.properties },
    coordinates,
    opacity:      0.8,
    images:       [],
    activeImageId: null,
    sourceId:     null,
    layerId:      null,
  };
}

// ---- GeoJSON を読み込んで terrainMap / mapFrames に追加し枠を描画する ----
// terrains.geojson（feature.id があり terrain_id プロパティがない）と
// frames.geojson（terrain_id プロパティがある）の両形式を自動判別して処理する。
function loadFramesGeojson(geojson) {
  if (!geojson?.features) { alert('GeoJSONの形式が正しくありません。'); return; }

  let addedTerrains = 0;
  let addedFrames   = 0;

  for (const feature of geojson.features) {
    if (feature.geometry?.type !== 'Polygon') continue;

    const props = feature.properties ?? {};

    // terrains 形式: terrain_id プロパティがなく feature.id がある
    if (!props.terrain_id && feature.id) {
      const tid = String(feature.id);
      if (!terrainMap.has(tid)) {
        terrainMap.set(tid, { ...props, geometry: feature.geometry });
        addedTerrains++;
      }
      continue;
    }

    // frames 形式: terrain_id プロパティがある
    const entry = featureToFrameEntry(feature);
    if (!entry) continue;
    if (mapFrames.find(f => f.id === entry.id)) continue;
    mapFrames.push(entry);
    addedFrames++;
  }

  // MapLibre GeoJSON ソースを更新（既存は置き換え）
  updateFrameGeoJsonSource();
  updateTerrainBoundarySource();
  renderMillerColumns();
  console.log(`読み込み完了: テレイン ${addedTerrains} 件、フレーム ${addedFrames} 件`);
}

// ---- frames-src GeoJSON ソース / レイヤーを作成または更新する ----
function updateFrameGeoJsonSource() {
  // 現在の mapFrames 全件を含む FeatureCollection を生成する
  const fc = {
    type: 'FeatureCollection',
    features: mapFrames.map(f => {
      const t = terrainMap.get(f.properties.terrain_id) ?? {};
      return {
        type: 'Feature',
        id:   f.id,
        properties: {
          ...f.properties,
          terrain_type:    t.terrain_type    ?? '',
          terrain_subtype: t.terrain_subtype ?? '',
          _hasImage: f.images.length > 0,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[ ...f.coordinates, f.coordinates[0] ]],
        },
      };
    }),
  };

  if (map.getSource('frames-src')) {
    map.getSource('frames-src').setData(fc);
    return;
  }

  // 初回追加: ソースとレイヤーを作成する
  map.addSource('frames-src', { type: 'geojson', data: fc });

  // 塗り潰しレイヤー（クリック判定用 + 薄い面表示）
  // 既存の画像レイヤー（KMZ・フレーム画像）より下に配置して、地図の後ろに隠れるようにする
  {
    const existingStyleLayers = map.getStyle().layers.map(l => l.id);
    const imageLayerIds = new Set([
      ...kmzLayers.map(e => e.layerId),
      ...mapFrames.map(e => e.layerId).filter(Boolean),
    ]);
    const firstImgLayerId = existingStyleLayers.find(id => imageLayerIds.has(id));
    map.addLayer({
      id: 'frames-fill', type: 'fill', source: 'frames-src',
      paint: { 'fill-color': FRAME_COLOR_EXPR, 'fill-opacity': 0.001 },
    }, firstImgLayerId); // undefined なら末尾に追加（画像なし時）
  }

  // 枠線: map_type/map_subtype で色分け（実線）
  map.addLayer({
    id: 'frames-outline', type: 'line', source: 'frames-src',
    paint: { 'line-color': FRAME_COLOR_EXPR, 'line-width': 2.5 },
  });

  // ホバーハイライト: feature-state で opacity を切り替える
  map.addLayer({
    id: 'frames-hover', type: 'line', source: 'frames-src',
    paint: {
      'line-color': '#ff9900',
      'line-width': 4.0,
      'line-opacity': ['case', ['boolean', ['feature-state', 'hovered'], false], 1, 0],
    },
  });
}

// ---- テレイン境界 GeoJSON ソース / レイヤーを作成または更新する ----
// terrains.geojson の geometry を使用してテレイン境界を描画する。
// クリック時の selected feature-state でハイライト表示に対応する。
function updateTerrainBoundarySource() {
  const features = [];
  for (const [id, t] of terrainMap) {
    if (!t.geometry) continue;
    features.push({
      type: 'Feature',
      id,
      properties: {
        terrain_type:    t.terrain_type    ?? '',
        terrain_subtype: t.terrain_subtype ?? '',
      },
      geometry: t.geometry,
    });
  }

  const fc = { type: 'FeatureCollection', features };

  if (map.getSource('terrain-boundary-src')) {
    map.getSource('terrain-boundary-src').setData(fc);
    return;
  }
  if (features.length === 0) return;

  map.addSource('terrain-boundary-src', { type: 'geojson', data: fc });

  // テレイン境界: 薄い塗り（frames-outline の上・frames-hover の下）
  // タップ非対応: クリック/ホバーハンドラーは frames-fill のみ対象のため自動的に無効
  const beforeHover = map.getLayer('frames-hover') ? 'frames-hover' : undefined;
  map.addLayer({
    id: 'terrain-boundary-fill', type: 'fill', source: 'terrain-boundary-src',
    paint: {
      'fill-color': FRAME_COLOR_EXPR,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.15,
        0.06,
      ],
    },
  }, beforeHover);

  // テレイン境界: 破線アウトライン
  map.addLayer({
    id: 'terrain-boundary-outline', type: 'line', source: 'terrain-boundary-src',
    paint: {
      'line-color': FRAME_COLOR_EXPR,
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.0, 1.5],
      'line-dasharray': [5, 4],
    },
  }, beforeHover);
}

// ---- テレイン選択ハイライトを更新する ----
function selectTerrain(terrainId) {
  if (selectedTerrainId && map.getSource('terrain-boundary-src')) {
    map.setFeatureState({ source: 'terrain-boundary-src', id: selectedTerrainId }, { selected: false });
  }
  selectedTerrainId = terrainId;
  if (selectedTerrainId && map.getSource('terrain-boundary-src')) {
    map.setFeatureState({ source: 'terrain-boundary-src', id: selectedTerrainId }, { selected: true });
  }
}

// ---- フレーム feature-state を更新する ----
function updateFrameFeatureState(frameId) {
  const frame = mapFrames.find(f => f.id === frameId);
  if (!frame) return;
  map.setFeatureState(
    { source: 'frames-src', id: frameId },
    { hasImage: frame.images.length > 0 }
  );
  // ソースデータも更新して _hasImage プロパティを同期する
  updateFrameGeoJsonSource();
}

// ---- Miller Columns: フィルター後のフレーム一覧を取得する ----
function getFilteredFrames() {
  const q = (document.getElementById('catalog-search')?.value ?? '').trim().toLowerCase();
  return mapFrames.filter(f => {
    const t = terrainMap.get(f.properties.terrain_id);
    if (activeTypeFilter && (t?.terrain_type ?? '') !== activeTypeFilter) return false;
    if (!q) return true;
    const en     = (f.properties.event_name ?? '').toLowerCase();
    const tn     = (t?.name ?? f.properties.terrain_id ?? '').toLowerCase();
    const pref   = (t?.prefecture ?? '').toLowerCase();
    const author = (t?.author    ?? '').toLowerCase();
    const copy   = (t?.copyright ?? '').toLowerCase();
    return en.includes(q) || tn.includes(q) || pref.includes(q) || author.includes(q) || copy.includes(q);
  });
}

// ---- Miller Columns: フレームが存在する地方一覧を返す ----
function getAvailableRegions(frames) {
  const set = new Set();
  for (const f of frames) {
    const t = terrainMap.get(f.properties.terrain_id);
    const pref = t?.prefecture ?? '';
    set.add(prefToRegion(pref));
  }
  // REGION_PREF_MAP の定義順で並べる
  return Object.keys(REGION_PREF_MAP).filter(r => set.has(r));
}

// ---- Miller Columns: 指定地方内でフレームが存在する都道府県一覧を返す ----
function getAvailablePrefs(frames, region) {
  const set = new Set();
  for (const f of frames) {
    const t = terrainMap.get(f.properties.terrain_id);
    const pref = t?.prefecture ?? '';
    if (prefToRegion(pref) === region) set.add(pref);
  }
  // 地方定義の順序を維持し、未定義のものは末尾に追加する
  const ordered = (REGION_PREF_MAP[region] ?? []).filter(p => set.has(p));
  const extra   = [...set].filter(p => !ordered.includes(p));
  return [...ordered, ...extra];
}

// ---- Miller Columns: 指定都道府県内でフレームが存在するテレイン一覧を返す ----
function getAvailableTerrains(frames, pref) {
  const seen = new Map(); // terrain_id → terrain info
  for (const f of frames) {
    const t  = terrainMap.get(f.properties.terrain_id);
    const fp = t?.prefecture ?? '';
    if (fp === pref) {
      const tid = f.properties.terrain_id ?? '__orphan__';
      if (!seen.has(tid)) seen.set(tid, t ?? { name: tid });
    }
  }
  return [...seen.entries()].map(([id, t]) => ({ id, name: t?.name ?? id }));
}

// ---- Miller Columns: 地方を選択する ----
function selectMillerRegion(region) {
  millerRegion  = region;
  millerPref    = null;
  millerTerrain = null;
  selectTerrain(null);
  renderMillerColumns();
}

// ---- Miller Columns: 都道府県を選択する ----
function selectMillerPref(pref) {
  millerPref    = pref;
  millerTerrain = null;
  selectTerrain(null);
  renderMillerColumns();
}

// ---- Miller Columns: テレインを選択し地図にフォーカスする ----
function selectMillerTerrain(terrainId) {
  millerTerrain = terrainId;
  selectTerrain(terrainId);
  renderMillerColumns();
  // テレイン中心へ移動（ズームレベルは変えない）
  const t = terrainMap.get(terrainId);
  if (t?.geometry) {
    const coords = t.geometry.coordinates[0];
    const lngs = coords.map(c => c[0]);
    const lats  = coords.map(c => c[1]);
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    map.easeTo({ center: [centerLng, centerLat], duration: 600 });
  }
}

// ---- パンくず: 区切り文字を生成する ----
function makeBcSep() {
  const sep = document.createElement('span');
  sep.className = 'miller-bc-sep';
  sep.textContent = '›';
  return sep;
}

// ---- パンくず: テキスト表示のみ（クリック・ドロップダウンなし） ----
function makeBcDropdown(level, current) {
  const wrap = document.createElement('span');
  wrap.className = 'miller-bc-item';
  wrap.textContent = current;
  return wrap;
}

// ---- パンくずバーを更新する ----
function updateMillerBreadcrumb() {
  const bc = document.getElementById('miller-breadcrumb');
  if (!bc) return;
  bc.innerHTML = '';

  // ルート（全国）
  const root = document.createElement('span');
  root.className = 'miller-bc-root';
  root.textContent = '全国';
  bc.appendChild(root);

  if (millerRegion) {
    bc.appendChild(makeBcSep());
    bc.appendChild(makeBcDropdown('region', millerRegion));
  }
  if (millerPref) {
    bc.appendChild(makeBcSep());
    bc.appendChild(makeBcDropdown('pref', millerPref));
  }
  if (millerTerrain) {
    const t = terrainMap.get(millerTerrain);
    bc.appendChild(makeBcSep());
    const span = document.createElement('span');
    span.className = 'miller-bc-current';
    span.textContent = t?.name ?? millerTerrain;
    bc.appendChild(span);
  }
}

// ---- Miller Columns メイン描画関数（地方 → 都道府県 → テレイン + フレーム一覧）----
function renderMillerColumns() {
  // 列ヘッダーを保持しつつ列内アイテムだけを差し替えるユーティリティ
  function resetCol(id) {
    const col = document.getElementById(id);
    if (!col) return col;
    const hd = col.querySelector('.miller-col-hd');
    col.innerHTML = '';
    if (hd) col.appendChild(hd);
    return col;
  }

  if (mapFrames.length === 0) {
    resetCol('miller-col-region');
    resetCol('miller-col-pref');
    resetCol('miller-col-terrain');
    const fl = document.getElementById('miller-frame-list');
    if (fl) fl.innerHTML = '<div class="miller-empty">GeoJSONを読み込んでください</div>';
    updateMillerBreadcrumb();
    return;
  }

  const frames   = getFilteredFrames();
  const regions  = getAvailableRegions(frames);
  const prefs    = millerRegion  ? getAvailablePrefs(frames, millerRegion)      : [];
  const terrains = millerPref    ? getAvailableTerrains(frames, millerPref)      : [];

  // 地方列
  const regionCol = resetCol('miller-col-region');
  if (regionCol) {
    if (regions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'miller-item disabled';
      empty.textContent = '—';
      regionCol.appendChild(empty);
    } else {
      for (const r of regions) {
        const terrainCount = getAvailablePrefs(frames, r).reduce((sum, p) => sum + getAvailableTerrains(frames, p).length, 0);
        const item = document.createElement('div');
        item.className = 'miller-item' + (r === millerRegion ? ' selected' : '');
        item.title = r;
        item.addEventListener('click', () => selectMillerRegion(r));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'miller-item-name';
        nameSpan.textContent = r;
        const countSpan = document.createElement('span');
        countSpan.className = 'miller-item-count';
        countSpan.textContent = terrainCount;
        item.appendChild(nameSpan);
        item.appendChild(countSpan);
        regionCol.appendChild(item);
      }
    }
  }

  // 都道府県列
  const prefCol = resetCol('miller-col-pref');
  if (prefCol) {
    for (const p of prefs) {
      const terrainCount = getAvailableTerrains(frames, p).length;
      const item = document.createElement('div');
      item.className = 'miller-item' + (p === millerPref ? ' selected' : '');
      item.title = p;
      item.addEventListener('click', () => selectMillerPref(p));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'miller-item-name';
      nameSpan.textContent = p;
      const countSpan = document.createElement('span');
      countSpan.className = 'miller-item-count';
      countSpan.textContent = terrainCount;
      item.appendChild(nameSpan);
      item.appendChild(countSpan);
      prefCol.appendChild(item);
    }
  }

  // テレイン列
  const terrainCol = resetCol('miller-col-terrain');
  if (terrainCol) {
    for (const { id, name } of terrains) {
      const frameCount = frames.filter(f => f.properties.terrain_id === id).length;
      const item = document.createElement('div');
      item.className = 'miller-item' + (id === millerTerrain ? ' selected' : '');
      item.title = name;
      item.addEventListener('click', () => selectMillerTerrain(id));
      const nameSpan = document.createElement('span');
      nameSpan.className = 'miller-item-name';
      nameSpan.textContent = name;
      const countSpan = document.createElement('span');
      countSpan.className = 'miller-item-count';
      countSpan.textContent = frameCount;
      item.appendChild(nameSpan);
      item.appendChild(countSpan);
      terrainCol.appendChild(item);
    }
  }

  // 下部フレームツリーを更新
  renderFrameTree();

  // 検索/フィルター中に選択状態がフレームゼロになった場合は空メッセージ表示
  if (frames.length === 0 && mapFrames.length > 0) {
    const regionColEl = document.getElementById('miller-col-region');
    if (regionColEl) {
      const hd = regionColEl.querySelector('.miller-col-hd');
      regionColEl.innerHTML = '';
      if (hd) regionColEl.appendChild(hd);
      const empty = document.createElement('div');
      empty.className = 'miller-item disabled';
      empty.textContent = '検索結果なし';
      regionColEl.appendChild(empty);
    }
  }

  updateMillerBreadcrumb();

  // 読図地図タブのスマートスロットを同期
  renderReadmapSlots();
}

// ---- 読図地図タブ: スマートスロット（枠への自動配置UI）を描画する ----
function renderReadmapSlots() {
  const container = document.getElementById('readmap-smart-slots');
  if (!container) return;
  container.innerHTML = '';

  if (mapFrames.length === 0) {
    container.innerHTML = '<div class="readmap-slot-hint">テレインタブでGeoJSONを読み込むと<br>枠への自動配置スロットが表示されます</div>';
    return;
  }
  if (!millerTerrain) {
    container.innerHTML = '<div class="readmap-slot-hint">テレインタブで走る場所を選ぶと、<br>位置合わせ不要のアップロード枠が出現します</div>';
    return;
  }

  const frames = mapFrames.filter(f => f.properties?.terrain_id === millerTerrain);
  if (frames.length === 0) {
    container.innerHTML = '<div class="readmap-slot-hint">このテレインには大会枠データがありません</div>';
    return;
  }

  frames.forEach(frame => {
    const hasImg    = frame.images.length > 0;
    const eventName = frame.properties?.event_name ?? '（名称なし）';

    const slot = document.createElement('div');
    slot.className = 'readmap-slot' + (hasImg ? ' readmap-slot-filled' : '');
    slot.innerHTML = `
      <div class="readmap-slot-label">${escHtml(eventName)}</div>
      ${hasImg ? `<div class="readmap-slot-img">📄 ${escHtml(frame.images[frame.images.length - 1].name)}</div>` : ''}
      <button class="readmap-slot-btn" data-frame-id="${escHtml(frame.id)}">
        ${hasImg ? '🔄 画像を変更' : '📷 画像を選択して自動配置'}
      </button>
    `;
    slot.querySelector('.readmap-slot-btn').addEventListener('click', () => {
      openFrameImgPicker(frame.id);
    });
    container.appendChild(slot);
  });
}

// ========================================================
// フレームツリー（下部エリア）
// ========================================================

// FRAME_COLOR_EXPR と同ロジックで枠の色を返す
function getFrameColor(frame) {
  const p       = frame.properties;
  const subtype = (p.terrain_subtype ?? '').toLowerCase();
  const type    = (p.terrain_type    ?? '').toLowerCase();
  if (subtype === 'stadium') return '#7c3fff';
  if (type    === 'forest')  return '#c8a000';
  if (type    === 'sprint')  return '#ff7700';
  return '#888888';
}

// フレームツリー全体を再描画する
function renderFrameTree() {
  const treeEl  = document.getElementById('frame-tree-list');
  const hdEl    = document.getElementById('terrain-selected-hd');
  const nameEl  = document.getElementById('terrain-selected-name');
  if (!treeEl) { renderOtherMapsTree(); return; }
  treeEl.innerHTML = '';

  if (!millerTerrain) {
    if (hdEl) hdEl.style.display = 'none';
    const hint = document.createElement('div');
    hint.className = 'tree-empty-hint';
    hint.textContent = '上のリストからテレインを選択してください';
    treeEl.appendChild(hint);
    renderOtherMapsTree();
    return;
  }

  if (hdEl) hdEl.style.display = '';
  const t = terrainMap.get(millerTerrain);
  if (nameEl) nameEl.textContent = t?.name ?? millerTerrain;

  const frames = mapFrames
    .filter(f => f.properties.terrain_id === millerTerrain)
    .sort((a, b) => (b.properties.event_date ?? '').localeCompare(a.properties.event_date ?? ''));

  if (frames.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'tree-empty-hint';
    hint.textContent = 'このテレインの枠データはありません';
    treeEl.appendChild(hint);
  } else {
    // event_name でグループ化（日付降順で挿入済みのため先頭が最新）
    const groupMap = new Map(); // eventName → { date, frames[] }
    for (const frame of frames) {
      const en = frame.properties.event_name ?? '（名称なし）';
      if (!groupMap.has(en)) {
        groupMap.set(en, { date: frame.properties.event_date ?? '', frames: [] });
      }
      groupMap.get(en).frames.push(frame);
    }
    let isFirst = true;
    for (const [eventName, group] of groupMap) {
      treeEl.appendChild(buildEventGroupEl(eventName, group.date, group.frames, isFirst));
      isFirst = false;
    }
  }
  renderOtherMapsTree();
}

// イベントグループ（アコーディオン）の DOM を構築する
function buildEventGroupEl(eventName, eventDate, frames, initialOpen = true) {
  const groupEl = document.createElement('div');
  groupEl.className = 'event-group';

  // グループヘッダー
  const hdEl = document.createElement('div');
  hdEl.className = 'event-group-hd';

  const toggleEl = document.createElement('span');
  toggleEl.className = 'event-group-toggle';
  toggleEl.textContent = initialOpen ? '▼' : '▶';

  const nameEl = document.createElement('span');
  nameEl.className = 'event-group-name';
  nameEl.textContent = eventName;
  nameEl.title = eventName;

  hdEl.appendChild(toggleEl);
  hdEl.appendChild(nameEl);

  if (eventDate) {
    const dateEl = document.createElement('span');
    dateEl.className = 'event-group-date';
    dateEl.textContent = eventDate;
    hdEl.appendChild(dateEl);
  }

  groupEl.appendChild(hdEl);

  // グループ本体（折りたたみ可）
  const bodyEl = document.createElement('div');
  bodyEl.className = 'event-group-body';
  if (!initialOpen) bodyEl.style.display = 'none';

  frames.forEach((frame, idx) => bodyEl.appendChild(buildFrameRowEl(frame, idx)));
  groupEl.appendChild(bodyEl);

  // アコーディオン開閉
  hdEl.addEventListener('click', () => {
    const open = bodyEl.style.display !== 'none';
    bodyEl.style.display = open ? 'none' : '';
    toggleEl.textContent = open ? '▶' : '▼';
  });

  return groupEl;
}

// コンパクトなフレーム行（1行）の DOM を構築する
function buildFrameRowEl(frame, index) {
  const color = getFrameColor(frame);
  const p     = frame.properties;
  // コース名: course_name > name（event_name と異なる場合）> コース N
  const label = p.course_name
    ?? (p.name && p.name !== p.event_name ? p.name : null)
    ?? `コース ${index + 1}`;

  const wrapEl = document.createElement('div');
  wrapEl.className = 'frame-row-wrap';

  const rowEl = document.createElement('div');
  rowEl.className = 'frame-row';
  rowEl.dataset.frameId = frame.id;

  // 表示チェックボックス
  const visChk = document.createElement('input');
  visChk.type = 'checkbox';
  visChk.className = 'frame-row-vis';
  visChk.checked = true;
  visChk.title = '表示/非表示';
  visChk.addEventListener('change', e => {
    e.stopPropagation();
    if (map.getLayer(frame.layerId)) {
      map.setPaintProperty(frame.layerId, 'raster-opacity',
        visChk.checked ? toRasterOpacity(frame.opacity) : 0);
    }
  });

  // 枠色アイコン
  const iconEl = document.createElement('span');
  iconEl.className = 'tree-node-icon-sq';
  iconEl.style.cssText = `background:transparent;border-color:${color}`;

  // ラベル
  const labelEl = document.createElement('span');
  labelEl.className = 'frame-row-label';
  labelEl.textContent = label;
  labelEl.title = label;

  // 不透明度スライダー
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'setting-slider frame-row-slider';
  slider.min = '0'; slider.max = '100'; slider.step = '1';
  slider.value = String(Math.round((frame.opacity ?? 0.8) * 100));
  slider.addEventListener('click', e => e.stopPropagation());
  slider.addEventListener('input', () => {
    frame.opacity = parseInt(slider.value, 10) / 100;
    if (map.getLayer(frame.layerId) && visChk.checked) {
      map.setPaintProperty(frame.layerId, 'raster-opacity', toRasterOpacity(frame.opacity));
    }
  });

  // 移動ボタン →
  const flyBtn = document.createElement('button');
  flyBtn.className = 'frame-row-btn';
  flyBtn.title = 'この枠へ移動';
  flyBtn.textContent = '→';
  flyBtn.addEventListener('click', e => {
    e.stopPropagation();
    const lngs = frame.coordinates.map(c => c[0]);
    const lats  = frame.coordinates.map(c => c[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 600 }
    );
  });

  // スクリーンショットボタン
  const printBtn = document.createElement('button');
  printBtn.className = 'frame-row-btn';
  printBtn.title = '枠に合わせてスクリーンショット';
  printBtn.textContent = '🖨';
  printBtn.addEventListener('click', e => {
    e.stopPropagation();
    captureFrameShot(frame);
  });

  // 地図読込ボタン（クリックでファイル選択、ドロップもできる）
  const loadBtn = document.createElement('button');
  loadBtn.className = 'frame-row-btn frame-row-load-btn' + (frame.images.length > 0 ? ' has-image' : '');
  loadBtn.title = frame.images.length > 0 ? '地図を追加読込' : '地図を読み込む';
  loadBtn.textContent = '📎';
  loadBtn.addEventListener('click', e => {
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.kmz';
    input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of Array.from(input.files ?? [])) {
        if (/\.kmz$/i.test(file.name)) {
          await openImportModalFromKmz(file);
        } else {
          openImportModalWithCoords(URL.createObjectURL(file), frame.coordinates, file.name);
        }
      }
    });
    input.click();
  });

  rowEl.appendChild(visChk);
  rowEl.appendChild(iconEl);
  rowEl.appendChild(labelEl);
  rowEl.appendChild(slider);
  rowEl.appendChild(flyBtn);
  rowEl.appendChild(printBtn);
  rowEl.appendChild(loadBtn);

  // ドラッグ＆ドロップ（行全体がターゲット）
  rowEl.addEventListener('dragover', e => { e.preventDefault(); rowEl.classList.add('drag-over'); });
  rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drag-over'));
  rowEl.addEventListener('drop', async e => {
    e.preventDefault();
    rowEl.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => /\.(jpe?g|png|kmz)$/i.test(f.name));
    for (const file of files) {
      if (/\.kmz$/i.test(file.name)) {
        await openImportModalFromKmz(file);
      } else {
        openImportModalWithCoords(URL.createObjectURL(file), frame.coordinates, file.name);
      }
    }
  });

  wrapEl.appendChild(rowEl);

  // 画像サブリスト（2枚以上の時だけ表示）
  if (frame.images.length > 1) {
    const imgListEl = document.createElement('div');
    imgListEl.className = 'frame-row-imglist';
    frame.images.forEach(img => {
      const item = document.createElement('div');
      item.className = 'frame-row-imgitem' + (img.id === frame.activeImageId ? ' active' : '');
      item.textContent = img.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');
      item.title = img.name;
      item.addEventListener('click', () => {
        switchFrameImage(frame.id, img.id);
        imgListEl.querySelectorAll('.frame-row-imgitem').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
      });
      imgListEl.appendChild(item);
    });
    wrapEl.appendChild(imgListEl);
  }

  return wrapEl;
}

// ---- レイヤーコントロール行（トグル＋不透明度スライダー）の共通ヘルパー ----
// onToggle(visible: boolean), onOpacity(pct: number) を受け取り DOM を返す
function _makeLayerCtrlRow(initialVisible, initialPct, onToggle, onOpacity) {
  const row = document.createElement('div');
  row.className = 'tree-child-ctrl-row';

  // トグルスイッチ
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'toggle-switch toggle-sm';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.checked = initialVisible;
  const toggleSliderEl = document.createElement('span');
  toggleSliderEl.className = 'toggle-slider';
  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleSliderEl);
  toggleInput.addEventListener('change', () => onToggle(toggleInput.checked));

  // 不透明度スライダー
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'setting-slider tree-opacity-slider';
  slider.min = '0'; slider.max = '100'; slider.step = '1';
  slider.value = String(initialPct);

  const valLabel = document.createElement('span');
  valLabel.className = 'tree-opacity-val';
  valLabel.textContent = initialPct + '%';

  slider.addEventListener('input', () => {
    valLabel.textContent = slider.value + '%';
    onOpacity(parseInt(slider.value, 10));
  });

  row.appendChild(toggleLabel);
  row.appendChild(slider);
  row.appendChild(valLabel);
  return row;
}

// 「その他の地図」ノードの子要素（kmzLayers）を再描画する
function renderOtherMapsTree() {
  const otherEl = document.getElementById('frame-tree-other-children');
  if (!otherEl) return;
  otherEl.innerHTML = '';

  if (kmzLayers.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'tree-child-drop-hint';
    hint.textContent = '🖼 枠がない地図をドロップ、または ＋ で追加';
    otherEl.appendChild(hint);
    return;
  }

  kmzLayers.forEach(entry => {
    const shortName = entry.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');

    // 名前行
    const childEl = document.createElement('div');
    childEl.className = 'tree-child-item';
    const iconSpan = document.createElement('span');
    iconSpan.textContent = '🗺️';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-child-name';
    nameSpan.title = entry.name;
    nameSpan.textContent = shortName;
    childEl.appendChild(iconSpan);
    childEl.appendChild(nameSpan);
    childEl.addEventListener('click', () => {
      if (entry.bbox) {
        const pw = document.getElementById('sidebar')?.offsetWidth ?? 300;
        map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: 60, bottom: 60, left: pw + 30, right: 60 }, duration: 600 }
        );
      }
    });
    otherEl.appendChild(childEl);

    // コントロール行（トグル + 不透明度スライダー）
    otherEl.appendChild(_makeLayerCtrlRow(
      entry.visible !== false,
      Math.round((entry.opacity ?? 0.8) * 100),
      (visible) => {
        entry.visible = visible;
        if (map.getLayer(entry.layerId)) {
          map.setPaintProperty(entry.layerId, 'raster-opacity',
            visible ? toRasterOpacity(entry.opacity) : 0);
        }
      },
      (pct) => {
        entry.opacity = pct / 100;
        if (map.getLayer(entry.layerId) && entry.visible !== false) {
          map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
        }
      }
    ));
  });
}

// ---- フレームエントリの DOM 要素を構築する（詳細コントロール付き・互換性のため保持）----
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildFrameEntryEl(frame) {
  const p         = frame.properties;
  const hasImages = frame.images.length > 0;
  const pct       = Math.round(frame.opacity * 100);
  const div = document.createElement('div');
  div.className = 'frame-entry';
  div.dataset.frameId = frame.id;

  // --- ヘッダー行 ---
  const header = document.createElement('div');
  header.className = 'frame-entry-header';
  header.innerHTML = `
    <input type="checkbox" class="frame-vis-chk" ${hasImages ? 'checked' : ''} title="画像レイヤーの表示/非表示" />
    <span class="frame-status-dot ${hasImages ? 'has-image' : ''}"></span>
    <span class="frame-event-name" title="${escHtml(p.event_name ?? '')}">${escHtml(p.event_name ?? '（名称なし）')}</span>
    <button class="frame-img-pick-btn" title="画像を割り当て" onclick="openFrameImgPicker('${frame.id}')">📷</button>
  `;
  div.appendChild(header);

  // --- 画像コントロール（画像ありの場合のみ表示）---
  if (hasImages) {
    const ctrl = document.createElement('div');
    ctrl.className = 'frame-controls';
    ctrl.innerHTML = `
      <select class="frame-img-select" title="表示する画像を選択">
        ${frame.images.map(img =>
          `<option value="${img.id}" ${img.id === frame.activeImageId ? 'selected' : ''}>${escHtml(img.name)}</option>`
        ).join('')}
      </select>
      <div class="opacity-row">
        <input type="range" id="fslider-${frame.id}" min="0" max="100" step="5" value="${pct}" />
        <span class="opacity-val" id="fval-${frame.id}">${pct}%</span>
      </div>`;
    div.appendChild(ctrl);

    // プルダウン変更
    ctrl.querySelector('.frame-img-select').addEventListener('change', (e) => {
      switchFrameImage(frame.id, e.target.value);
    });
    // スライダー
    const sliderEl = ctrl.querySelector(`#fslider-${frame.id}`);
    const valEl    = ctrl.querySelector(`#fval-${frame.id}`);
    updateSliderGradient(sliderEl, '#2563eb');
    sliderEl.addEventListener('input', () => {
      frame.opacity = parseInt(sliderEl.value) / 100;
      valEl.textContent = sliderEl.value + '%';
      updateSliderGradient(sliderEl, '#2563eb');
      if (frame.layerId && map.getLayer(frame.layerId)) {
        map.setPaintProperty(frame.layerId, 'raster-opacity', toRasterOpacity(frame.opacity));
      }
    });
  }

  // チェックボックス（表示/非表示）
  const chk = header.querySelector('.frame-vis-chk');
  chk.addEventListener('change', (e) => {
    if (!frame.layerId) return;
    map.setLayoutProperty(frame.layerId, 'visibility', e.target.checked ? 'visible' : 'none');
  });

  // エントリクリックで地図をフレームにジャンプ
  header.querySelector('.frame-event-name').addEventListener('click', () => {
    const lngs = frame.coordinates.map(c => c[0]);
    const lats  = frame.coordinates.map(c => c[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 600 }
    );
  });

  return div;
}

// ---- 画像ピッカーを開く（全フレームで共有する hidden input を使用）----
function openFrameImgPicker(frameId, fromPopup = false) {
  currentFramePicker = { frameId, fromPopup };
  document.getElementById('frame-img-input').click();
}

// ---- 選択した画像ファイルをフレームに割り当てる ----
async function addImagesToFrame(frameId, files) {
  const frame = mapFrames.find(f => f.id === frameId);
  if (!frame) return;

  for (const file of files) {
    const imgId = frameImgCounter++;
    const url   = URL.createObjectURL(file);
    frame.images.push({ id: imgId, name: file.name, url });

    // 最初の画像のとき MapLibre ソース＋レイヤーを新規作成する
    if (frame.sourceId === null) {
      const n       = kmzCounter++;
      frame.sourceId = `kmz-source-${n}`;
      frame.layerId  = `kmz-layer-${n}`;
      frame.activeImageId = imgId;
    }
    // 最初の画像のみ自動で表示する（追加画像はプルダウンで手動切替）
    if (frame.activeImageId === imgId) {
      addImageLayerToMap(frame.sourceId, frame.layerId, url, frame.coordinates, frame.opacity);
    }
  }

  // フレーム枠のスタイルと一覧を更新する
  updateFrameFeatureState(frameId);
  renderMillerColumns();

  // 最初に読み込んだ時だけ地図をフレームにフィットさせる
  if (frame.images.length <= files.length) {
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? 300;
    const lngs = frame.coordinates.map(c => c[0]);
    const lats  = frame.coordinates.map(c => c[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: 60, bottom: 60, left: panelWidth + 30, right: 60 },
        pitch: INITIAL_PITCH, duration: 600, maxZoom: 19 }
    );
  }
}

// ---- フレームの表示画像を切り替える ----
function switchFrameImage(frameId, imageIdRaw) {
  const frame = mapFrames.find(f => f.id === frameId);
  if (!frame || !frame.sourceId) return;
  const imageId = parseInt(imageIdRaw, 10);
  const img     = frame.images.find(i => i.id === imageId);
  if (!img) return;
  // 座標はそのまま、画像 URL のみ差し替える
  map.getSource(frame.sourceId).updateImage({ url: img.url });
  frame.activeImageId = imageId;
}

// 重複リストからひとつを選んで単一フレームポップアップに切り替える
function _selectOverlapFrame(frameId) {
  if (frameClickPopup) {
    const lngLat = frameClickPopup.getLngLat();
    frameClickPopup.remove();
    frameClickPopup = null;
    showFrameClickPopup(lngLat, [frameId]);
  }
}

// ---- 地図クリック時: フレームポップアップを表示する ----
function showFrameClickPopup(lngLat, frameIds) {
  if (frameClickPopup) { frameClickPopup.remove(); frameClickPopup = null; }
  if (!frameIds || frameIds.length === 0) return;

  let html;
  if (frameIds.length === 1) {
    html = buildFramePopupHtml(frameIds[0]);
  } else {
    // 複数フレーム重複時: 選択メニューを表示する
    html = `<div class="frame-popup">
      <div style="font-size:11px;color:#666;margin-bottom:6px;">この地点に複数の枠があります:</div>
      <ul class="frame-overlap-list">` +
      frameIds.map(fid => {
        const f = mapFrames.find(x => x.id === fid);
        const p = f?.properties ?? {};
        const dot = f?.images.length > 0 ? '●' : '○';
        return `<li class="frame-overlap-item" onclick="_selectOverlapFrame('${fid}')" data-fid="${fid}">
          <span style="color:${f?.images.length > 0 ? '#2563eb' : '#bbb'}">${dot}</span>
          <span>${escHtml(p.event_name ?? fid)}</span>
          ${(() => { const _t = terrainMap.get(p.terrain_id); return _t?.terrain_type ? `<span class="frame-badge ${_t.terrain_type}" style="font-size:9px">${escHtml(MAP_TYPE_JA[_t.terrain_type] ?? _t.terrain_type)}</span>` : ''; })()}
        </li>`;
      }).join('') +
      `</ul></div>`;
  }

  frameClickPopup = new maplibregl.Popup({ maxWidth: '280px', closeButton: true })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
}

// ---- フレームポップアップ HTML を組み立てる ----
function buildFramePopupHtml(frameId) {
  const frame = mapFrames.find(f => f.id === frameId);
  if (!frame) return '';
  const p         = frame.properties;
  const hasImages = frame.images.length > 0;
  const t          = terrainMap.get(p.terrain_id) ?? {};
  const typeKey    = t.terrain_type    ?? '';
  const subtypeKey = t.terrain_subtype ?? '';
  const terrainName = t.name ?? p.terrain_id ?? '';
  const typeBadgeH    = typeKey    ? `<span class="frame-badge ${typeKey}">${escHtml(MAP_TYPE_JA[typeKey] ?? typeKey)}</span>` : '';
  const subtypeBadgeH = subtypeKey ? `<span class="frame-badge subtype">${escHtml(MAP_SUBTYPE_JA[subtypeKey] ?? subtypeKey)}</span>` : '';

  return `<div class="frame-popup">
    <div class="frame-popup-title">
      ${escHtml(p.event_name ?? '（名称なし）')}
    </div>
    <div class="frame-popup-meta">
      📍 ${escHtml(terrainName)} ${typeBadgeH}${subtypeBadgeH}
      ${p.event_date ? ` ／ 📅 ${escHtml(p.event_date)}` : ''}
      ${p.description ? `<br><span style="color:#999">${escHtml(p.description)}</span>` : ''}
    </div>
    ${hasImages ? `
    <select class="frame-popup-select" onchange="switchFrameImage('${frameId}', this.value)">
      ${frame.images.map(img =>
        `<option value="${img.id}" ${img.id === frame.activeImageId ? 'selected' : ''}>${escHtml(img.name)}</option>`
      ).join('')}
    </select>` : ''}
    <button class="frame-popup-upload" onclick="openFrameImgPicker('${frameId}', true)">
      ${hasImages ? '＋ 画像を追加' : '📷 画像を選択'}
    </button>
  </div>`;
}

// ---- 起動時に data/terrains.geojson → data/frames.geojson の順で自動読み込みする ----
async function autoLoadTerrains() {
  try {
    const res = await fetch('./data/terrains.geojson');
    if (res.ok) {
      const data = await res.json();
      for (const f of (data.features ?? [])) {
        if (!f.id) continue;
        terrainMap.set(String(f.id), { ...f.properties, geometry: f.geometry });
      }
    }
  } catch (_) { /* ローカルファイルシステムでは fetch が失敗する場合があるため無視する */ }
  // terrains 読み込み後にフレームを読み込む
  await autoLoadFrames();
}

async function autoLoadFrames() {
  try {
    const res = await fetch('./data/frames.geojson');
    if (!res.ok) return; // ファイルが無ければ静かにスキップする
    const geojson = await res.json();
    loadFramesGeojson(geojson);
  } catch (_) {
    // ローカルファイルシステムでは fetch が失敗する場合があるため無視する
  }
}


/*
  ========================================================
  読み込み済みKMZレイヤーの一覧をUIに描画する
  ========================================================
*/
/*
  KMZレイヤー一覧をUIに描画する。
  各エントリに表示/非表示チェックボックス・透明度スライダー・削除ボタンを追加。
*/
function renderKmzList() {
  const listEl = document.getElementById('kmz-list');
  listEl.innerHTML = '';

  // 読図地図セレクトのKMZオプションを同期
  updateReadmapBgKmzOptions();

  if (kmzLayers.length === 0) return;

  kmzLayers.forEach(entry => {
    // 名前（拡張子なし）
    const shortName = entry.name.replace(/\.kmz$/i, '');
    const pct = Math.round(entry.opacity * 100);

    const rowEl = document.createElement('div');
    rowEl.className = 'layer-row';
    rowEl.dataset.id = entry.id;

    rowEl.innerHTML = `
      <div class="layer-label-row">
        <input type="checkbox" id="chk-kmz-${entry.id}" ${entry.visible ? 'checked' : ''} />
        <label class="layer-name${entry.visible ? '' : ' disabled'}" for="chk-kmz-${entry.id}" title="${entry.name}">${shortName}</label>
        <button class="kmz-del-btn" title="削除" onclick="removeKmzLayer(${entry.id})">✕</button>
      </div>
      <div class="opacity-row">
        <input type="range" id="slider-kmz-${entry.id}" min="0" max="100" step="5" value="${pct}" ${entry.visible ? '' : 'disabled'} />
        <span class="opacity-val" id="val-kmz-${entry.id}">${pct}%</span>
      </div>`;
    listEl.appendChild(rowEl);

    // チェックボックス：表示/非表示
    rowEl.querySelector(`#chk-kmz-${entry.id}`).addEventListener('change', (e) => {
      entry.visible = e.target.checked;
      const label = rowEl.querySelector('.layer-name');
      const slider = rowEl.querySelector(`#slider-kmz-${entry.id}`);
      label.classList.toggle('disabled', !entry.visible);
      slider.disabled = !entry.visible;

      if (map.getLayer(entry.layerId)) {
        map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
      }
    });

    // スライダー：透明度
    const sliderEl = rowEl.querySelector(`#slider-kmz-${entry.id}`);
    const valEl = rowEl.querySelector(`#val-kmz-${entry.id}`);
    updateSliderGradient(sliderEl, '#2563eb');

    sliderEl.addEventListener('input', () => {
      entry.opacity = parseInt(sliderEl.value) / 100;
      valEl.textContent = sliderEl.value + '%';
      updateSliderGradient(sliderEl, '#2563eb');

      if (entry.visible && map.getLayer(entry.layerId)) {
        map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
      }
    });
  });

  // シミュレータータブの読図地図リストも同期して更新
  renderSimReadmapList();
  // 「その他の地図」ツリーも更新
  renderOtherMapsTree();
}


// シミュレータータブの読図地図リストを更新
let activeReadmapId = null;

function renderSimReadmapList() {
  const listEl = document.getElementById('sim-readmap-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (kmzLayers.length === 0) {
    listEl.innerHTML = '<div class="sim-readmap-empty">地図が読み込まれていません</div>';
    // activeReadmapId をリセット
    activeReadmapId = null;
    return;
  }

  // activeReadmapId が未設定 or 既存エントリにない場合は先頭に設定
  if (!activeReadmapId || !kmzLayers.find(e => e.id === activeReadmapId)) {
    activeReadmapId = kmzLayers[0].id;
    // sel-readmap-bg も同期
    const selReadmap = document.getElementById('sel-readmap-bg');
    if (selReadmap) {
      const opt = selReadmap.querySelector(`option[value="kmz-${activeReadmapId}"]`);
      if (opt) selReadmap.value = opt.value;
    }
  }

  kmzLayers.forEach(entry => {
    const shortName = entry.name.replace(/\.kmz$/i, '').replace(/\.(jpg|jpeg|png)$/i, '');
    const isActive = (entry.id === activeReadmapId);

    const item = document.createElement('div');
    item.className = 'sim-map-item' + (isActive ? ' active' : '');

    item.innerHTML = `
      <span class="sim-map-dot"></span>
      <span class="sim-map-name" title="${escHtml(entry.name)}">${escHtml(shortName)}</span>
      <button class="sim-map-fly-btn" title="この地図へ移動">→</button>
    `;

    // クリックで読図地図を選択
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('sim-map-fly-btn')) return;
      activeReadmapId = entry.id;
      // sel-readmap-bg を同期（KMZオプションは updateReadmapBgKmzOptions が追加）
      const selReadmap = document.getElementById('sel-readmap-bg');
      if (selReadmap) {
        const opt = selReadmap.querySelector(`option[value="kmz-${entry.id}"]`);
        if (opt) selReadmap.value = opt.value;
      }
      renderSimReadmapList();
    });

    // 移動ボタン：地図の範囲へフライ
    item.querySelector('.sim-map-fly-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (entry.bbox) {
        const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? 300;
        map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: 60, bottom: 60, left: panelWidth + 30, right: 60 },
            pitch: INITIAL_PITCH, duration: 600 }
        );
      }
    });

    listEl.appendChild(item);
  });
}


/*
  KMZレイヤーを地図とリストから削除する
*/
function removeKmzLayer(id) {
  const idx = kmzLayers.findIndex(e => e.id === id);
  if (idx === -1) return;

  const entry = kmzLayers[idx];
  if (map.getLayer(entry.layerId)) map.removeLayer(entry.layerId);
  if (map.getSource(entry.sourceId)) map.removeSource(entry.sourceId);
  URL.revokeObjectURL(entry.objectUrl);
  kmzLayers.splice(idx, 1);
  renderKmzList();
}


/* ========================================================
    時間を MM:SS 形式にフォーマットする
    引数 ms : ミリ秒
    ======================================================== */
function formatMMSS(ms) {
  // ミリ秒 → 秒に変換し、分と秒を算出する
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const ss = (totalSec % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/* ========================================================
    シークバーのグラデーションを現在値に合わせて更新する
    ======================================================== */
function updateSeekBarGradient() {
  const bar = document.getElementById('seek-bar');
  const max = parseFloat(bar.max) || 1;
  const pct = (parseFloat(bar.value) / max) * 100;
  bar.style.background =
    `linear-gradient(to right, #2563eb ${pct}%, #d0d0d0 ${pct}%)`;
}

/* ========================================================
    時間表示パネルを更新する（現在時間 / 総時間）
    ======================================================== */
function updateTimeDisplay() {
  document.getElementById('time-current').textContent = formatMMSS(gpxCurrentTime);
  document.getElementById('time-total').textContent = formatMMSS(gpxTotalDuration);
}

/* ========================================================
    GPXのレイヤーを地図から削除する（再読み込み時のクリーンアップ）
    ======================================================== */
function removeGpxLayers() {
  const layerIds = [
    'gpx-marker-inner', 'gpx-marker-outer',
    'gpx-track-line', 'gpx-track-outline',
  ];
  const sourceIds = ['gpx-marker', 'gpx-track'];

  // レイヤーを先に削除してからソースを削除する（順序重要）
  layerIds.forEach(id => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  sourceIds.forEach(id => {
    if (map.getSource(id)) map.removeSource(id);
  });
}

/* ========================================================
    GPXファイルを処理するメイン関数
    引数 file : ユーザーが選択した File オブジェクト
    ======================================================== */
async function loadGpx(file) {
  try {
    // ファイルをテキストとして読み込む
    const text = await file.text();

    // DOMParser で GPX（XMLフォーマット）を解析する
    const parser = new DOMParser();
    const gpxDom = parser.parseFromString(text, 'application/xml');

    // trkpt 要素（トラックポイント）をすべて取得する（外部ライブラリ不使用・ネイティブDOM API）
    const trkptEls = gpxDom.querySelectorAll('trkpt');

    // ---- トラックポイントを配列化する ----
    // trkpt の lon/lat 属性から経度・緯度を取得し、
    // 子要素の <time> から ISO8601 文字列をミリ秒のタイムスタンプに変換する
    const points = Array.from(trkptEls).map(pt => ({
      lng: parseFloat(pt.getAttribute('lon')),
      lat: parseFloat(pt.getAttribute('lat')),
      time: pt.querySelector('time')
        ? new Date(pt.querySelector('time').textContent).getTime()
        : null,
    }));

    if (points.length < 2) {
      alert('GPXファイルにトラックポイントが見つかりませんでした。\ntrkデータを含むファイルをご使用ください。');
      return;
    }

    // 時刻でソートする（念のため）
    points.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

    // 時刻データがない場合：インデックスベースで1秒間隔を設定
    const hasTime = points.some(p => p.time !== null);
    if (!hasTime) {
      console.warn('GPXに時刻データがありません。インデックスベースで代替します。');
      points.forEach((p, i) => { p.time = i * 1000; });
    }

    // 各ポイントに開始時刻からの相対時間（relTime）を付与する
    // relTime = 0 〜 totalDuration（ミリ秒）がシークバーの値に対応する
    const t0 = points[0].time;
    points.forEach(p => { p.relTime = (p.time ?? 0) - t0; });

    // アニメーション管理変数を初期化する
    gpxTrackPoints = points;
    gpxTotalDuration = points[points.length - 1].relTime;
    gpxCurrentTime = 0;
    gpxIsPlaying = false;
    gpxLastTimestamp = null;
    // 追尾カメラ用キャッシュ・オフセットをリセット
    _gpxCachedTerrainH = map.queryTerrainElevation(
      { lng: points[0].lng, lat: points[0].lat }, { exaggerated: false }
    ) ?? 0;
    _lastGpxBearing  = 0;
    gpxBearingOffset = 0;
    // ローパスフィルタ値を先頭セグメントの bearing でスナップ初期化
    if (points.length >= 2) {
      _smoothedGpxBearing = turf.bearing(
        turf.point([points[0].lng, points[0].lat]),
        turf.point([points[1].lng, points[1].lat])
      );
    } else {
      _smoothedGpxBearing = 0;
    }
    _smoothedGpxZoom = 15;

    // 再生中ならキャンセルする
    if (gpxAnimFrameId) {
      cancelAnimationFrame(gpxAnimFrameId);
      gpxAnimFrameId = null;
    }

    // ---- 既存のGPXレイヤーを削除して新規追加 ----
    removeGpxLayers();

    // 軌跡全体を表す GeoJSON LineString を手動で構築する（外部ライブラリ不使用）
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: points.map(p => [p.lng, p.lat]),
        },
        properties: {},
      }],
    };

    // 軌跡全体のGeoJSONソースを追加する（LineStringレイヤー）
    map.addSource('gpx-track', { type: 'geojson', data: geojson });

    // 軌跡の白い外枠（見やすさのため）
    map.addLayer({
      id: 'gpx-track-outline',
      type: 'line',
      source: 'gpx-track',
      paint: {
        'line-color': '#ffffff',
        'line-width': 5,
        'line-opacity': 0.75,
      },
    });

    // 軌跡の赤ライン
    map.addLayer({
      id: 'gpx-track-line',
      type: 'line',
      source: 'gpx-track',
      paint: {
        'line-color': '#e63030',
        'line-width': 3,
        'line-opacity': 0.9,
      },
    });

    // 現在地マーカーのGeoJSONソース（アニメーション中に座標を更新する）
    const markerGeoJson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [points[0].lng, points[0].lat] },
      }],
    };
    map.addSource('gpx-marker', { type: 'geojson', data: markerGeoJson });

    // 現在地マーカーの外側の白い輪
    map.addLayer({
      id: 'gpx-marker-outer',
      type: 'circle',
      source: 'gpx-marker',
      paint: {
        'circle-radius': 12,
        'circle-color': '#ffffff',
        'circle-opacity': 0.75,
      },
    });

    // 現在地マーカーの内側の赤い点
    map.addLayer({
      id: 'gpx-marker-inner',
      type: 'circle',
      source: 'gpx-marker',
      paint: {
        'circle-radius': 7,
        'circle-color': '#e63030',
        'circle-opacity': 1.0,
      },
    });

    // ---- シークバーと時間表示を初期化する ----
    const seekBar = document.getElementById('seek-bar');
    seekBar.min = 0;
    seekBar.max = gpxTotalDuration;
    seekBar.value = 0;
    updateSeekBarGradient();
    updateTimeDisplay();

    // 再生ボタンを▶にリセットする
    document.getElementById('play-pause-btn').textContent = '▶';

    // ---- タイムラインパネルを表示する ----
    document.getElementById('timeline-panel').style.display = 'flex';

    // GPX読み込み状態をUIパネルに表示する
    const gpxStatusEl = document.getElementById('gpx-status');
    gpxStatusEl.style.display = 'block';
    gpxStatusEl.textContent =
      `✓ ${file.name}（${points.length}pts・${formatMMSS(gpxTotalDuration)}）`;

    // 地図をGPXトラック全体が見えるようにズームする
    const lngs = points.map(p => p.lng);
    const lats = points.map(p => p.lat);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 80, duration: 600 }
    );

    console.log(`GPX読み込み完了: ${file.name}、${points.length}ポイント、総時間 ${formatMMSS(gpxTotalDuration)}`);

  } catch (err) {
    console.error('GPX読み込みエラー:', err);
    alert(`GPXファイルの読み込み中にエラーが発生しました。\n詳細: ${err.message}`);
  }
}

/* ========================================================
    現在地マーカーの座標を更新する
    引数 pos : { lng, lat } オブジェクト
    ======================================================== */
function updateGpxMarker(pos) {
  const src = map.getSource('gpx-marker');
  if (!src) return;

  // setData() でGeoJSONを差し替えて現在地を移動させる
  src.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
    }],
  });
}

/* ========================================================
    currentTime の位置をGPXトラックポイント間で線形補間して返す
    引数 t : 現在の相対時間（ミリ秒、0 〜 gpxTotalDuration）
    返値 : { lng, lat, bearing } または null（ポイント不足時）

    【処理の流れ】
    1. gpxTrackPoints 配列を先頭から順番に走査する
    2. t が p0.relTime 以上かつ p1.relTime 以下のセグメントを特定する
    3. セグメント内での進行割合（ratio）を計算する
      ratio = (t - p0.relTime) / (p1.relTime - p0.relTime)
    4. 経度・緯度をそれぞれ ratio で線形補間する
    5. Turf.js で p0→p1 の方位角（bearing）を計算して返す
    ======================================================== */
function interpolateGpxPosition(t) {
  if (gpxTrackPoints.length < 2) return null;

  // 配列の末尾を超えた場合は最後のポイントを返す
  if (t >= gpxTotalDuration) {
    const last = gpxTrackPoints[gpxTrackPoints.length - 1];
    return { lng: last.lng, lat: last.lat, bearing: 0 };
  }

  // t が含まれるセグメントを線形探索する
  for (let i = 0; i < gpxTrackPoints.length - 1; i++) {
    const p0 = gpxTrackPoints[i];
    const p1 = gpxTrackPoints[i + 1];

    // t がこのセグメント（p0〜p1）の範囲内かどうかを確認する
    if (t >= p0.relTime && t <= p1.relTime) {
      // セグメント内での経過時間の割合を求める（0.0 〜 1.0）
      const segDuration = p1.relTime - p0.relTime;
      const ratio = segDuration > 0 ? (t - p0.relTime) / segDuration : 0;

      // 経度と緯度をそれぞれ線形補間する
      // 例：ratio=0.3 なら p0 から 30% 進んだ位置
      const lng = p0.lng + (p1.lng - p0.lng) * ratio;
      const lat = p0.lat + (p1.lat - p0.lat) * ratio;

      // Turf.js で p0 から p1 への方位角（北を0°として時計回り）を計算する
      // これを 1人称視点でのカメラの向きに使用する
      let bearing = 0;
      try {
        const from = turf.point([p0.lng, p0.lat]);
        const to = turf.point([p1.lng, p1.lat]);
        bearing = turf.bearing(from, to);
      } catch (e) {
        // Turf.js エラー時は前回の bearing を維持（0 で代替）
      }

      return { lng, lat, bearing };
    }
  }

  // 該当セグメントが見つからない場合は先頭ポイントを返す
  const first = gpxTrackPoints[0];
  return { lng: first.lng, lat: first.lat, bearing: 0 };
}

/* ========================================================
    視点モードに応じてカメラを更新する
    引数 pos : { lng, lat, bearing } オブジェクト

    【視点モード別の設定（仕様書 §5-3 より）】
    - 1人称（ドローン）視点:
        Zoom 18〜19, Pitch 70〜75, Bearing = 進行方向
    - 3人称（俯瞰）視点:
        Zoom 15〜16, Pitch 45〜50, Bearing = 0（北固定）
    両モードとも Center は現在地座標に追従する
    ======================================================== */
function updateCamera(pos, elapsed) {
  if (gpxViewMode === '3d') {
    // 3D 追尾視点：setCameraFromPlayer() と同じロジックで GPX 位置を追尾
    updateCameraChase(pos, elapsed);
  } else {
    // 2D 俯瞰視点：北向き固定・現在地を追従
    map.easeTo({
      center: [pos.lng, pos.lat],
      zoom: 15.5,
      pitch: 0,
      bearing: 0,
      duration: 100,
    });
  }
}

/* ========================================================
    GPX 追尾カメラ（PC シムと同じ画角・設定）
    setCameraFromPlayer() と同じロジックを GPX 位置で実行する。
    pcCamDistM・pcPitch を共有することで PC シムの設定値がそのまま反映される。
    ======================================================== */
function updateCameraChase(pos, elapsed) {
  // ── bearing のローパスフィルタ（カクカク防止） ──────────────────────
  // GPS 記録間隔が粗いと bearing がセグメント境界で突変するため、
  // 指数平滑化で滑らかに追従させる。時定数 GPX_BEARING_TC 秒。
  // ユーザーの矢印キーによる gpxBearingOffset は平滑化後に加算するため
  // レスポンスを損なわない。
  const dt = Math.max(0, elapsed ?? 16) / 1000; // 実経過時間（秒）
  const bearingAlpha = 1 - Math.exp(-dt / GPX_BEARING_TC);
  // 角度の最短経路で差分を求めて wraparound を回避する
  const bearingDelta = ((pos.bearing - _smoothedGpxBearing + 540) % 360) - 180;
  _smoothedGpxBearing = (_smoothedGpxBearing + bearingDelta * bearingAlpha + 360) % 360;

  // 地形標高取得（タイル未読み込み時はキャッシュ維持）
  const rawH = map.queryTerrainElevation(
    { lng: pos.lng, lat: pos.lat }, { exaggerated: false }
  );
  if (rawH !== null) _gpxCachedTerrainH += (rawH - _gpxCachedTerrainH) * 0.25;
  const h = _gpxCachedTerrainH;

  const H       = map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pos.lat * Math.PI / 180;

  // GPX 独自のピッチ・カメラ距離を使用（PC シムとは独立）
  const pitchDeg = Math.max(0, Math.min(map.getMaxPitch(), gpxChasePitch));
  const pitchRad = pitchDeg * Math.PI / 180;
  // 平滑化済み進行方向 + ユーザーオフセット
  const camBearing = (_smoothedGpxBearing + gpxBearingOffset + 360) % 360;

  // 後方地点の地形高度を取得してカメラのめり込みを防止
  const backDistKm = gpxCamDistM * Math.sin(pitchRad) / 1000;
  const backPt = turf.destination(
    [pos.lng, pos.lat], backDistKm, (camBearing + 180) % 360
  );
  const backH = map.queryTerrainElevation(
    { lng: backPt.geometry.coordinates[0], lat: backPt.geometry.coordinates[1] },
    { exaggerated: false }
  ) ?? h;

  // zoom のローパスフィルタ（距離変更時に滑らかに変化）
  const zoomAlpha = 1 - Math.exp(-dt / GPX_ZOOM_TC);
  const targetZoom = Math.max(12, Math.min(map.getMaxZoom(), Math.log2(
    H * 2 * Math.PI * R * Math.cos(lat_rad) /
    (1024 * Math.tan(fov_rad / 2) * Math.max(0.3, gpxCamDistM * Math.cos(pitchRad)))
  )));
  _smoothedGpxZoom += (targetZoom - _smoothedGpxZoom) * zoomAlpha;

  map.jumpTo({
    center:  [pos.lng, pos.lat],
    bearing: camBearing,
    pitch:   pitchDeg,
    zoom:    _smoothedGpxZoom,
  });
}

/* ========================================================
    アニメーションループ（requestAnimationFrame で毎フレーム呼ばれる）
    引数 timestamp : ブラウザが提供する現在時刻（ミリ秒）

    【ループの流れ】
    1. 前フレームとの差分時間（elapsed）を計算する
    2. 再生速度（speed）を掛けてシミュレーション時間を進める
    3. シークバーと時間表示を更新する
    4. interpolateGpxPosition() で現在地を補間して求める
    5. マーカーとカメラを更新する
    6. 再生中であれば次フレームをリクエストする
    ======================================================== */
function gpxAnimationLoop(timestamp) {
  // 前フレームとの実経過時間を計算する（ミリ秒）
  const elapsed = gpxLastTimestamp !== null ? timestamp - gpxLastTimestamp : 0;
  gpxLastTimestamp = timestamp;

  // ── 3D モード: 矢印キーによる視点調整（毎フレーム滑らかに更新） ──
  if (gpxViewMode === '3d') {
    const dt = Math.max(0, elapsed) / 1000; // 秒
    const BEARING_RATE = 90; // deg/s
    const PITCH_RATE   = 60; // deg/s
    if (gpxChaseKeys.ArrowLeft)  gpxBearingOffset = (gpxBearingOffset - BEARING_RATE * dt + 360) % 360;
    if (gpxChaseKeys.ArrowRight) gpxBearingOffset = (gpxBearingOffset + BEARING_RATE * dt) % 360;
    if (gpxChaseKeys.ArrowUp)    gpxChasePitch = Math.min(85, gpxChasePitch + PITCH_RATE * dt);
    if (gpxChaseKeys.ArrowDown)  gpxChasePitch = Math.max(0,  gpxChasePitch - PITCH_RATE * dt);
  }

  // 再生速度セレクトの値を読み取る（10x, 30x, 60x, 120x）
  const speed = parseInt(document.getElementById('speed-select').value, 10) || 30;

  // シミュレーション時間を speed 倍で進める
  // elapsed=33ms（約30fps）+ speed=30 → 990ms/frame 進む（約1分/秒の速度）
  gpxCurrentTime += elapsed * speed;

  // 終端に達したら停止する
  if (gpxCurrentTime >= gpxTotalDuration) {
    gpxCurrentTime = gpxTotalDuration;
    gpxIsPlaying = false;
    document.getElementById('play-pause-btn').textContent = '▶';
  }

  // シークバーの値と表示を更新する
  const seekBar = document.getElementById('seek-bar');
  seekBar.value = gpxCurrentTime;
  updateSeekBarGradient();
  updateTimeDisplay();

  // 現在時間に対応する地図上の座標を補間して求める
  const pos = interpolateGpxPosition(gpxCurrentTime);

  if (pos) {
    // 進行方向をキャッシュ（端点で bearing=0 になる箇所の補完）
    if (pos.bearing !== 0) _lastGpxBearing = pos.bearing;
    else pos.bearing = _lastGpxBearing;
    // 現在地マーカーと視点カメラを更新する（elapsed を平滑化に使用）
    updateGpxMarker(pos);
    updateCamera(pos, elapsed);
  }

  // まだ再生中であれば次のフレームをリクエストする
  if (gpxIsPlaying) {
    gpxAnimFrameId = requestAnimationFrame(gpxAnimationLoop);
  }
}

/* ========================================================
    再生 / 一時停止の切り替え
    ======================================================== */
function toggleGpxPlayPause() {
  if (gpxTrackPoints.length === 0) return;

  gpxIsPlaying = !gpxIsPlaying;
  document.getElementById('play-pause-btn').textContent = gpxIsPlaying ? '⏸' : '▶';

  if (gpxIsPlaying) {
    // 終端まで再生済みの場合は先頭から再生し直す
    if (gpxCurrentTime >= gpxTotalDuration) gpxCurrentTime = 0;
    gpxLastTimestamp = null;
    gpxAnimFrameId = requestAnimationFrame(gpxAnimationLoop);
  } else {
    // 一時停止：アニメーションフレームをキャンセルする
    if (gpxAnimFrameId) {
      cancelAnimationFrame(gpxAnimFrameId);
      gpxAnimFrameId = null;
    }
    gpxLastTimestamp = null;
  }
}

/* ========================================================
    視点モードを切り替える（1人称 ↔ 3人称）
    ======================================================== */
function toggleGpx3dMode() {
  gpxViewMode = (gpxViewMode === '2d') ? '3d' : '2d';
  const btn = document.getElementById('gpx-3d-btn');
  const panel = document.getElementById('timeline-panel');
  if (gpxViewMode === '3d') {
    btn.textContent = '3D';
    btn.classList.add('active');
    panel.classList.add('gpx-3d');
    // 3D に切り替えたとき bearing オフセットをリセット
    gpxBearingOffset = 0;
  } else {
    btn.textContent = '2D';
    btn.classList.remove('active');
    panel.classList.remove('gpx-3d');
    // 2D 復帰時はすべての矢印キーをリセット
    Object.keys(gpxChaseKeys).forEach(k => { gpxChaseKeys[k] = false; });
  }
}

/* ========================================================
    地名検索（国土地理院 地名検索API）
    候補一覧を表示し、タップ／クリックで flyTo。
    ======================================================== */

// 都道府県コード（JIS X 0401）→ 都道府県名
const PREF_NAMES = {
  '01':'北海道','02':'青森県','03':'岩手県','04':'宮城県','05':'秋田県',
  '06':'山形県','07':'福島県','08':'茨城県','09':'栃木県','10':'群馬県',
  '11':'埼玉県','12':'千葉県','13':'東京都','14':'神奈川県','15':'新潟県',
  '16':'富山県','17':'石川県','18':'福井県','19':'山梨県','20':'長野県',
  '21':'岐阜県','22':'静岡県','23':'愛知県','24':'三重県','25':'滋賀県',
  '26':'京都府','27':'大阪府','28':'兵庫県','29':'奈良県','30':'和歌山県',
  '31':'鳥取県','32':'島根県','33':'岡山県','34':'広島県','35':'山口県',
  '36':'徳島県','37':'香川県','38':'愛媛県','39':'高知県','40':'福岡県',
  '41':'佐賀県','42':'長崎県','43':'熊本県','44':'大分県','45':'宮崎県',
  '46':'鹿児島県','47':'沖縄県'
};

// addressCode の上位2桁で都道府県を、title の先頭から市区町村を抽出
function parseResultMeta(item) {
  const prefCode = (item.properties?.addressCode || '').slice(0, 2);
  const pref = PREF_NAMES[prefCode] || '';
  const title = item.properties?.title || '';
  let city = '';
  if (pref && title.startsWith(pref)) {
    const rest = title.slice(pref.length);
    // 番地・丁目などの数字が始まる手前までを市区町村名として取得
    const m = rest.match(/^([^0-9０-９\-－]+)/);
    city = m ? m[1] : rest;
  }
  return { pref, city };
}

let _searchTimer = null; // デバウンス用タイマー
let _searchAbort  = null; // 進行中リクエストのキャンセル用

function updateClearBtn() {
  const hasValue = document.getElementById('unified-search-input').value.length > 0;
  document.getElementById('unified-search-clear').style.display = hasValue ? 'block' : 'none';
}

function clearSearch() {
  const input = document.getElementById('unified-search-input');
  input.value = '';
  document.getElementById('unified-search-msg').textContent = '';
  document.getElementById('unified-search-results').innerHTML = '';
  updateClearBtn();
  input.focus();
}

// テレインカタログをローカル検索して結果を返す（即時）
function searchTerrains(q) {
  if (!q || terrainMap.size === 0) return [];
  const ql = q.toLowerCase();
  const seen = new Set();
  const results = [];

  // terrainMap から名前・都道府県・作成者で検索
  for (const [tid, t] of terrainMap) {
    if (seen.has(tid)) continue;
    const name = (t.name ?? '').toLowerCase();
    const pref = (t.prefecture ?? '').toLowerCase();
    const auth = (t.author ?? '').toLowerCase();
    if (name.includes(ql) || pref.includes(ql) || auth.includes(ql)) {
      seen.add(tid);
      results.push({ tid, t });
    }
  }
  // mapFrames のイベント名でも追加検索
  for (const f of mapFrames) {
    const tid = f.properties.terrain_id ?? '';
    if (seen.has(tid)) continue;
    if ((f.properties.event_name ?? '').toLowerCase().includes(ql)) {
      seen.add(tid);
      results.push({ tid, t: terrainMap.get(tid) ?? {} });
    }
  }

  // 各テレインの bounds を frames から計算して付与
  return results.slice(0, 8).map(({ tid, t }) => {
    const frames = mapFrames.filter(f => f.properties.terrain_id === tid);
    let bbox = null;
    if (frames.length > 0) {
      const lngs = frames.flatMap(f => f.coordinates.map(c => c[0]));
      const lats  = frames.flatMap(f => f.coordinates.map(c => c[1]));
      bbox = { west: Math.min(...lngs), east: Math.max(...lngs), south: Math.min(...lats), north: Math.max(...lats) };
    } else if (t.geometry?.coordinates?.[0]) {
      const ring = t.geometry.coordinates[0];
      const lngs = ring.map(c => c[0]);
      const lats  = ring.map(c => c[1]);
      bbox = { west: Math.min(...lngs), east: Math.max(...lngs), south: Math.min(...lats), north: Math.max(...lats) };
    }
    return { tid, name: t.name ?? tid, prefecture: t.prefecture ?? '', terrain_type: t.terrain_type ?? '', bbox };
  });
}

function searchPlace() {
  const query   = document.getElementById('unified-search-input').value.trim();
  const msg     = document.getElementById('unified-search-msg');
  const results = document.getElementById('unified-search-results');

  if (!query) {
    results.innerHTML = '';
    msg.textContent   = '';
    return;
  }

  // 前のリクエストをキャンセル
  if (_searchAbort) { _searchAbort.abort(); }
  _searchAbort = new AbortController();

  results.innerHTML = '';
  msg.textContent = '';

  // ① テレイン検索（即時・ローカル）
  const terrainHits = searchTerrains(query);
  terrainHits.forEach(t => {
    const el = document.createElement('div');
    el.className = 'place-result-item';

    const iconEl = document.createElement('span');
    iconEl.className = 'result-source-icon';
    iconEl.textContent = '🗺';
    el.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'place-result-name';
    nameEl.textContent = t.name;
    el.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'place-result-meta';
    const prefEl = document.createElement('span');
    prefEl.textContent = t.prefecture;
    metaEl.appendChild(prefEl);
    if (t.terrain_type) {
      const badge = document.createElement('span');
      badge.className = `result-type-badge result-type-${t.terrain_type}`;
      badge.textContent = t.terrain_type === 'sprint' ? 'スプリント' : 'フォレスト';
      metaEl.appendChild(badge);
    }
    el.appendChild(metaEl);

    el.addEventListener('click', () => {
      if (t.bbox) {
        const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? 300;
        map.fitBounds([[t.bbox.west, t.bbox.south], [t.bbox.east, t.bbox.north]], {
          padding: { top: 60, bottom: 60, left: panelWidth + 30, right: 60 },
          duration: 800,
        });
      }
      document.getElementById('unified-search-input').value = t.name;
      updateClearBtn();
    });
    results.appendChild(el);
  });

  // ② 地理院API（非同期）
  msg.textContent = '地名を検索中…';
  msg.style.color = '#888';

  fetch(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`,
    { signal: _searchAbort.signal }
  )
    .then(r => r.json())
    .then(data => {
      msg.textContent = '';
      if (!data || data.length === 0) {
        if (terrainHits.length === 0) {
          msg.textContent = '見つかりませんでした';
          msg.style.color = '#c00';
        }
        return;
      }
      data.forEach(item => {
        if (!item?.geometry?.coordinates || !item?.properties) return;
        const [lng, lat] = item.geometry.coordinates;
        const { pref, city } = parseResultMeta(item);

        const el = document.createElement('div');
        el.className = 'place-result-item';

        const iconEl = document.createElement('span');
        iconEl.className = 'result-source-icon';
        iconEl.textContent = '📍';
        el.appendChild(iconEl);

        const nameEl = document.createElement('span');
        nameEl.className = 'place-result-name';
        nameEl.textContent = item.properties.title;
        el.appendChild(nameEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'place-result-meta';
        const prefEl = document.createElement('span');
        prefEl.textContent = pref;
        metaEl.appendChild(prefEl);
        if (city) {
          const cityEl = document.createElement('span');
          cityEl.textContent = city;
          metaEl.appendChild(cityEl);
        }
        el.appendChild(metaEl);

        el.addEventListener('click', () => {
          map.flyTo({ center: [lng, lat], zoom: 15, duration: 1500 });
          document.getElementById('unified-search-input').value = item.properties.title;
          msg.textContent = '';
          updateClearBtn();
        });
        results.appendChild(el);
      });
    })
    .catch(e => {
      if (e.name === 'AbortError') return; // キャンセルは無視
      msg.textContent = '';
    });
}

// Enter キー
document.getElementById('unified-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(_searchTimer); searchPlace(); }
});

// 入力中のライブ検索（350ms デバウンス）+ クリアボタン表示制御
document.getElementById('unified-search-input').addEventListener('input', () => {
  updateClearBtn();
  clearTimeout(_searchTimer);
  const q = document.getElementById('unified-search-input').value.trim();
  if (!q) {
    document.getElementById('unified-search-results').innerHTML = '';
    document.getElementById('unified-search-msg').textContent = '';
    return;
  }
  _searchTimer = setTimeout(searchPlace, 350);
});

// クリアボタン
document.getElementById('unified-search-clear').addEventListener('click', clearSearch);

/* ========================================================
    ファイル選択ボタンの制御
    ======================================================== */

// ---- 統合インポートボタン（KMZ / 画像 → すべて位置合わせモーダルへ） ----
const mapImportInputTop = document.getElementById('map-import-input-top');
document.getElementById('map-import-btn-top').addEventListener('click', () => mapImportInputTop.click());
mapImportInputTop.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    if (/\.kmz$/i.test(file.name)) {
      await openImportModalFromKmz(file);
    } else if (/\.(jpe?g|png)$/i.test(file.name)) {
      openImportModal(file);
    }
  }
  e.target.value = '';
});

// 「その他の地図」ドロップターゲット（手動位置合わせの受け皿）
const otherMapsDropTarget = document.getElementById('other-maps-drop-target');
if (otherMapsDropTarget) {
  otherMapsDropTarget.addEventListener('dragover', e => { e.preventDefault(); otherMapsDropTarget.classList.add('drag-over'); });
  otherMapsDropTarget.addEventListener('dragleave', () => otherMapsDropTarget.classList.remove('drag-over'));
  otherMapsDropTarget.addEventListener('drop', async e => {
    e.preventDefault();
    otherMapsDropTarget.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => /\.(jpe?g|png|kmz)$/i.test(f.name));
    for (const file of files) {
      if (/\.kmz$/i.test(file.name)) await openImportModalFromKmz(file);
      else openImportModal(file);
    }
  });
}

// GPXファイル選択ボタン
const gpxFileInput = document.getElementById('gpx-file-input');
const gpxUploadBtn = document.getElementById('gpx-upload-btn');
gpxUploadBtn.addEventListener('click', () => gpxFileInput.click());

// GPXファイルが選択されたら loadGpx を呼び出す（単一ファイル）
gpxFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await loadGpx(file);
  e.target.value = ''; // 同じファイルを再選択できるようにリセット
});

// ---- 視点切り替えボタン ----
document.getElementById('gpx-3d-btn').addEventListener('click', toggleGpx3dMode);

// ---- 再生/一時停止ボタン ----
document.getElementById('play-pause-btn').addEventListener('click', toggleGpxPlayPause);

// ---- シークバー（スクラブ）----
document.getElementById('seek-bar').addEventListener('input', (e) => {
  // スクラブ中は一時停止したままマーカーとカメラだけ更新する
  gpxCurrentTime = parseInt(e.target.value, 10);
  updateSeekBarGradient();
  updateTimeDisplay();

  const pos = interpolateGpxPosition(gpxCurrentTime);
  if (pos) {
    // シーク時は bearing をスナップ初期化して遅延なく即時追従させる
    _smoothedGpxBearing = pos.bearing;
    updateGpxMarker(pos);
    updateCamera(pos, 16);
  }
});


// ---- 画像+JGW モーダルのイベントリスナー ----

// モーダルを閉じるボタン
document.getElementById('imgw-modal-close-btn').addEventListener('click', closeImgwModal);

// モーダル外（オーバーレイ）クリックで閉じる
document.getElementById('imgw-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeImgwModal();
});

// Step 1: 画像ファイル選択
const imgwImgInput = document.getElementById('imgw-img-input');
document.getElementById('imgw-img-btn').addEventListener('click', () => imgwImgInput.click());
imgwImgInput.addEventListener('change', (e) => {
  imgwModalImages = Array.from(e.target.files);
  updateImgwModalUI();
  e.target.value = ''; // 同じファイルを再選択できるようにリセット
});

// Step 2: ワールドファイル選択
const imgwJgwInput = document.getElementById('imgw-jgw-input');
document.getElementById('imgw-jgw-btn').addEventListener('click', () => imgwJgwInput.click());
imgwJgwInput.addEventListener('change', (e) => {
  imgwModalJgwFile = e.target.files[0] || null;
  updateImgwModalUI();
  e.target.value = ''; // 同じファイルを再選択できるようにリセット
});

// 「地図に配置」ボタン
document.getElementById('imgw-place-btn').addEventListener('click', executeImgwPlace);

// ---- 地図カタログ: GeoJSON 読み込み ----
const geojsonFileInput = document.getElementById('geojson-file-input');
document.getElementById('geojson-load-btn').addEventListener('click', () => geojsonFileInput.click());
geojsonFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text   = await file.text();
    const geojson = JSON.parse(text);
    loadFramesGeojson(geojson);
  } catch (err) {
    alert(`GeoJSON の読み込みに失敗しました:\n${err.message}`);
  }
  e.target.value = '';
});

// ---- 地図カタログ: フレーム画像ピッカー（全フレームで共有）----
document.getElementById('frame-img-input').addEventListener('change', async (e) => {
  if (currentFramePicker && e.target.files.length > 0) {
    await addImagesToFrame(currentFramePicker.frameId, Array.from(e.target.files));
    // ポップアップが開いている場合は内容を更新する
    if (currentFramePicker.fromPopup && frameClickPopup) {
      const lngLat = frameClickPopup.getLngLat();
      frameClickPopup.remove();
      frameClickPopup = null;
      showFrameClickPopup(lngLat, [currentFramePicker.frameId]);
    }
  }
  currentFramePicker = null;
  e.target.value = '';
});

// ---- 地図カタログ: 検索バー ----
document.getElementById('catalog-search').addEventListener('input', () => {
  renderMillerColumns();
});

// ---- map_type チップフィルター ----
document.querySelectorAll('.type-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    activeTypeFilter = chip.dataset.type;
    document.querySelectorAll('.type-chip').forEach(c => c.classList.toggle('active', c.dataset.type === activeTypeFilter));
    renderMillerColumns();
  });
});

// ---- 地図カタログ: 地図クリックでフレームポップアップ + テレインハイライト ----
map.on('click', (e) => {
  if (!map.getLayer('frames-fill')) return;
  const features = map.queryRenderedFeatures(e.point, { layers: ['frames-fill'] });
  if (features.length === 0) {
    selectTerrain(null); // フレーム外クリックでハイライト解除
    return;
  }
  showFrameClickPopup(e.lngLat, features.map(f => String(f.id)));
  // クリックしたフレームの親テレインをハイライト
  const clickedFrame = mapFrames.find(f => f.id === String(features[0].id));
  if (clickedFrame) selectTerrain(clickedFrame.properties.terrain_id ?? null);
});

// ---- 地図カタログ: ホバーで枠をハイライト ----
let _hoveredFrameId = null;
map.on('mousemove', (e) => {
  if (!map.getLayer('frames-fill')) return;
  const features = map.queryRenderedFeatures(e.point, { layers: ['frames-fill'] });
  if (features.length > 0) {
    const fid = String(features[0].id);
    if (_hoveredFrameId !== fid) {
      if (_hoveredFrameId) {
        map.setFeatureState({ source: 'frames-src', id: _hoveredFrameId }, { hovered: false });
      }
      _hoveredFrameId = fid;
      map.setFeatureState({ source: 'frames-src', id: fid }, { hovered: true });
    }
    map.getCanvas().style.cursor = 'pointer';
  } else {
    if (_hoveredFrameId) {
      map.setFeatureState({ source: 'frames-src', id: _hoveredFrameId }, { hovered: false });
      _hoveredFrameId = null;
    }
    map.getCanvas().style.cursor = '';
  }
});
map.on('mouseleave', () => {
  if (_hoveredFrameId) {
    map.setFeatureState({ source: 'frames-src', id: _hoveredFrameId }, { hovered: false });
    _hoveredFrameId = null;
    map.getCanvas().style.cursor = '';
  }
});


/* ========================================================
    ドラッグ＆ドロップの制御
    ブラウザウィンドウ全体にドラッグしたとき、オーバーレイを表示して
    ドロップされたファイルを loadKmz に渡します。
    ======================================================== */

const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0; // 子要素への出入りで誤作動しないようにカウンター管理

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;

  // ファイルがドラッグされているときだけオーバーレイを表示する
  if (e.dataTransfer.types.includes('Files')) {
    dropOverlay.classList.add('visible');
  }
});

document.addEventListener('dragleave', () => {
  dragCounter--;

  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => {
  // デフォルト動作（ブラウザがファイルを開く）を止める
  e.preventDefault();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');

  const allFiles = Array.from(e.dataTransfer.files);

  // ファイルを種類別に振り分ける
  const kmzFiles = allFiles.filter(f => /\.kmz$/i.test(f.name));
  const gpxFiles = allFiles.filter(f => /\.gpx$/i.test(f.name));
  const imgFiles = allFiles.filter(f => /\.(jpe?g|png)$/i.test(f.name));
  const jgwFiles = allFiles.filter(f => /\.(jgw|pgw|tfw|wld)$/i.test(f.name));

  if (kmzFiles.length === 0 && gpxFiles.length === 0 &&
      imgFiles.length === 0 && jgwFiles.length === 0) {
    alert('.kmz・.gpx・または 画像+ワールドファイル をドロップしてください。');
    return;
  }

  // KMZ もモーダル経由に統一。GPX は即座に処理する
  for (const file of kmzFiles) await openImportModalFromKmz(file);
  for (const file of gpxFiles) await loadGpx(file);

  // 画像は統合インポートモーダルへ（1枚ずつ）
  // ワールドファイル付きの場合は従来の imgwModal にフォールバック
  if (imgFiles.length > 0 && jgwFiles.length === 0) {
    for (const file of imgFiles) openImportModal(file);
  } else if (imgFiles.length > 0 || jgwFiles.length > 0) {
    openImgwModal(
      imgFiles.length > 0 ? imgFiles       : [],
      jgwFiles.length > 0 ? jgwFiles[0]    : null,
    );
  }
});


/* ========================================================
    UIスライダー・チェックボックスのイベントリスナー設定
    ======================================================== */

// ---- スライダーのグラデーション更新ヘルパー ----
// color: スライダーのアクセントカラー（デフォルト：グリーン系）
function updateSliderGradient(input, color) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', pct + '%');

  if (color) {
    input.style.background = `linear-gradient(to right, ${color} ${pct}%, #d0d0d0 ${pct}%)`;
  }
}

// ユーザーが手動で設定した磁北線間隔（m）。zoom > 10 のときに使用する。
let userMagneticInterval = 300;

// ── グローバル（zoom ≤ 3）用 固定磁北線キャッシュ ──
// 起動後に一度だけ計算し、zoom ≤ 3 の間は再計算なしで使い回す。
// 赤道（lat=0）を起点に 500km 間隔で全球に 80 本配置。
const GLOBAL_MAG_INTERVAL_KM = 500;                          // 赤道での線間隔
const GLOBAL_MAG_EQ_KM_DEG   = Math.PI * 6371 / 180;        // ≈ 111.195 km/deg
const GLOBAL_MAG_DLNG        = GLOBAL_MAG_INTERVAL_KM / GLOBAL_MAG_EQ_KM_DEG; // ≈ 4.49°
const GLOBAL_MAG_STEP_KM     = 100;                          // ウォーク時のステップ距離
let   _globalMagneticLines   = null;                         // キャッシュ（null = 未計算）

/**
 * zoom ≤ 3 用の固定磁北線セットを計算してキャッシュする。
 * 2 回目以降はキャッシュを返すだけ。
 *
 * 配置方法：
 *   numLines = round(360 / dLng) 本をちょうど均等配置することで
 *   ±180° 付近の重複・欠落を防ぐ。
 *   各線の開始経度 = -180 + i * (360 / numLines)
 *
 * 南方向は -89° まで延長（南極大陸をカバー）。
 * geomag の入力緯度は ±89° でクランプして極付近の発散を防ぐ。
 */
function buildGlobalMagneticLines() {
  if (_globalMagneticLines) return _globalMagneticLines;

  // ちょうど numLines 本を均等配置（重複なし）
  const numLines    = Math.round(360 / GLOBAL_MAG_DLNG); // ≈ 80 本
  const actualDlng  = 360 / numLines;                    // 実際の経度間隔（≈ 4.5°）
  const features    = [];

  for (let i = 0; i < numLines; i++) {
    const lng0 = -180 + i * actualDlng;

    // 赤道から北方向（89° でクランプ）
    const northPts = [[lng0, 0]];
    let lng = lng0, lat = 0;
    for (let s = 0; s < 120; s++) {
      const decl = geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;
      const next = turf.destination(turf.point([lng, lat]), GLOBAL_MAG_STEP_KM, decl, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      northPts.push([lng, lat]);
      if (lat > 89) break;
    }

    // 赤道から南方向（zoom ≤ 3 専用。-85° でクランプ）
    const southPts = [[lng0, 0]];
    lng = lng0; lat = 0;
    for (let s = 0; s < 100; s++) {
      const decl    = geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;
      const bearing = (decl + 180 + 360) % 360;
      const next    = turf.destination(turf.point([lng, lat]), GLOBAL_MAG_STEP_KM, bearing, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      southPts.push([lng, lat]);
      if (lat < -85) break;
    }

    // 南端 → 赤道 → 北端 の順に結合して 1 本の LineString にする
    const coords = [...southPts.slice(1).reverse(), ...northPts];
    if (coords.length >= 2) features.push(turf.lineString(coords));
  }

  _globalMagneticLines = turf.featureCollection(features);
  return _globalMagneticLines;
}

// zoom レベルに応じた有効な磁北線間隔（m）を返す
// 各ズームで画面内に約 7〜15 本表示されることを目安に設定。
// 広域ズーム（z≤4）では間隔を大きくして本数を抑えつつ画面全体をカバーする。
// ※ nHalf = min(30, ceil(halfExtentKm / intervalKm)) がキャップに当たらないよう調整。
//   z≤1 ≈ 全球      → 2000km  (nHalf≈7, 約15本)
//   z≤2 ≈ 1:100M   → 1000km  (nHalf≈7, 約15本)
//   z≤3 ≈ 1:50M    →  500km  (nHalf≈7, 約15本)
//   z≤6 ≈ 1:5M–    →  200km  (z4もここに含む, nHalf≈9, 約19本)
//   z7  ≈ 1:2.5M   →  100km
//   z8  ≈ 1:1.2M   →   50km
//   z9  ≈ 1:600K   →   20km
//   z10 ≈ 1:300K   →   10km
//   z11 ≈ 1:150K   →    5km
//   z12 ≈ 1:75K    →    2km
//   z13 ≈ 1:35K    →    1km
//   z13.5 ≈ 1:17K    →  500m（OL 1:15,000 向け）
//   z14+ ≈ 1:8K–   → ユーザー設定（デフォルト 250m）
function getEffectiveMagneticInterval() {
  const z = map.getZoom();
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
  if (z <= 13.5) return     500;
  return userMagneticInterval;
}

// 磁北線の動的生成（曲線ポリライン版）
// 各磁北線を「一定ステップごとに geomag で偏角を再計算しながら進む多角線」として生成する。
// これにより広域表示時の地域差（偏角の曲がり具合）を正確に表現できる。
// zoom レベルに応じた自動間隔切り替え＆セレクト表示の同期も行う。
function updateMagneticNorth() {
  if (!map.getSource('magnetic-north')) return;

  const center = map.getCenter();
  const bounds = map.getBounds();

  // zoom ≤ 3: 固定グローバル磁北線キャッシュを使用（再計算なし）
  if (map.getZoom() <= 3) {
    const data = buildGlobalMagneticLines();
    _lastMagneticNorthData = data;
    map.getSource('magnetic-north').setData(data);
    // UI表示（500km 固定）
    const optCurrent = document.getElementById('opt-magnetic-north-current');
    if (optCurrent) {
      optCurrent.textContent = '500 km';
      document.getElementById('sel-magnetic-north-interval').selectedIndex = 0;
    }
    return;
  }

  // zoom レベルに応じた有効間隔を取得し、セレクト先頭オプションに反映
  const intervalM  = getEffectiveMagneticInterval();
  const intervalKm = intervalM / 1000;
  const displayText = intervalM >= 1000 ? (intervalM / 1000) + ' km' : intervalM + ' m';
  const optCurrent = document.getElementById('opt-magnetic-north-current');
  if (optCurrent) {
    optCurrent.textContent = displayText;
    document.getElementById('sel-magnetic-north-interval').selectedIndex = 0;
  }

  // ステップ距離を動的決定：視野の対角を15分割、広域は最大100km・拡大時は最小0.5km
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
  const stepKm = Math.min(100, Math.max(0.5, halfExtentKm / 15));

  // フェイルセーフ：最大ステップ数（無限ループ防止）
  const MAX_STEPS = 400;

  // 打ち切り緯度境界（Bounds + 1ステップ分バッファ）
  // ±70° でクランプ：それ以上は geomag の偏角が不安定になり線が暴走するため
  const bufDeg = stepKm / 100;
  const minLat = Math.max(-70, bounds.getSouth() - bufDeg);
  const maxLat = Math.min( 89.9, bounds.getNorth() + bufDeg);

  // ── 絶対座標グリッド方式 ──
  // 経度グリッドを赤道基準の固定値にし、東西パンで線がズレないようにする。
  // 緯度の基準点を最近傍整数度にスナップし、南北パンでのズレを最小化する。
  // （0.5° ≈ 55km 以上パンしない限り基準点は変わらない）
  const EQ_KM_PER_DEG = Math.PI * 6371 / 180; // ≈ 111.195 km/deg（赤道）
  const dLng   = intervalKm / EQ_KM_PER_DEG;
  const refLat = Math.round(center.lat); // 最近傍整数度にスナップした基準緯度

  // 磁気偏角による経度ドリフト補正バッファ
  // refLat（整数度）からビューポート中心まで線がウォークする際、磁気偏角により
  // 経度方向にドリフトが生じる（日本では南向きウォーク時に東へ最大 ~0.1° ずれる）。
  // このドリフト量を推定し、grid 生成範囲を東西に拡張して画面全体をカバーする。
  const declCenter = geomag.field(
    Math.max(-89.9, Math.min(89.9, center.lat)), center.lng
  ).declination;
  const latDiffKm   = Math.abs(refLat - center.lat) * EQ_KM_PER_DEG;
  const cosLat      = Math.max(0.01, Math.cos(center.lat * Math.PI / 180));
  const driftLngBuf = Math.abs(Math.sin(declCenter * Math.PI / 180) * latDiffKm / (EQ_KM_PER_DEG * cosLat));

  // ビューポートをカバーする経度範囲のグリッドインデックス（ドリフト補正込み）
  const westLng  = bounds.getWest()  - bufDeg - driftLngBuf;
  const eastLng  = bounds.getEast()  + bufDeg + driftLngBuf;
  const startIdx = Math.floor(westLng / dLng);
  const endIdx   = Math.ceil (eastLng / dLng);

  /**
   * 基点座標から1方向へ多角線座標を生成する。
   * 各ステップで現在地点の geomag 偏角を再計算して軌道修正する。
   * @param {number[]} startCoords [lng, lat]
   * @param {boolean}  towardNorth true=磁北方向, false=磁南方向
   * @returns {number[][]} 座標配列（startCoords を先頭に含む）
   */
  function walkMagneticLine(startCoords, towardNorth) {
    const pts = [startCoords];
    let lng = startCoords[0];
    let lat = startCoords[1];
    for (let s = 0; s < MAX_STEPS; s++) {
      // 現在地点の偏角を WMM で再計算（緯度を ±89.9° にクランプして極付近の発散を防ぐ）
      const decl    = geomag.field(Math.max(-89.9, Math.min(89.9, lat)), lng).declination;
      const bearing = towardNorth ? decl : (decl + 180 + 360) % 360;
      const next    = turf.destination(turf.point([lng, lat]), stepKm, bearing, { units: 'kilometers' });
      lng = next.geometry.coordinates[0];
      lat = next.geometry.coordinates[1];
      pts.push([lng, lat]);
      // 緯度のみで打ち切り（経度は全球を巡回するため判定しない）
      if (towardNorth ? lat > maxLat : lat < minLat) break;
    }
    return pts;
  }

  const features = [];
  for (let i = startIdx; i <= endIdx; i++) {
    // 固定経度グリッド × スナップ済み基準緯度の基点から南北両方向に伸ばす
    const basePt   = [i * dLng, refLat];
    const northPts = walkMagneticLine(basePt, true);
    const southPts = walkMagneticLine(basePt, false);
    // 南端 → 基点 → 北端 の順に結合して1本の LineString にする
    const coords   = [...southPts.slice(1).reverse(), ...northPts];
    if (coords.length >= 2) {
      features.push(turf.lineString(coords));
    }
  }

  const featureCollection = turf.featureCollection(features);
  _lastMagneticNorthData = featureCollection;
  map.getSource('magnetic-north').setData(featureCollection);
}

// 都道府県別CS出典の動的表示
// 要素を lazy に取得し、ビューポートと bounds が重なる都道府県のみ出典を表示する。
// map.on('load') の外で定義することで chkCs ハンドラーからも呼び出せる。
let _lastAttrKey = null; // bounds+zoom のキャッシュ（変化がなければ更新をスキップ）
// ベースマップ切替時に出典の先頭を更新する（OriLibreのみリンクを表示）
// MapLibreが出典テキストを書き換えるたびに先頭スパンを再挿入するObserver
let _attrObserver = null;

function updateBasemapAttribution() {
  const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
  if (!attrInner) return;
  let attrEl = document.getElementById('basemap-attr');
  if (!attrEl) {
    attrEl = document.createElement('span');
    attrEl.id = 'basemap-attr';
    attrInner.insertBefore(attrEl, attrInner.firstChild);
  } else if (attrEl.parentNode !== attrInner) {
    // MapLibreの書き換えで別の場所に移動した場合は先頭に戻す
    attrInner.insertBefore(attrEl, attrInner.firstChild);
  }
  const attr = RASTER_BASEMAPS[currentBasemap]?.attr;
  attrEl.innerHTML = attr ? attr + ' | ' : '';
}

function initAttributionObserver() {
  const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
  if (!attrInner) return false; // DOM未準備
  if (_attrObserver) _attrObserver.disconnect();
  _attrObserver = new MutationObserver(() => {
    // 監視を一時停止してDOM操作し、無限ループを防ぐ
    _attrObserver.disconnect();
    updateBasemapAttribution();
    updatePlateauAttribution();
    _attrObserver.observe(attrInner, { childList: true, subtree: true });
  });
  _attrObserver.observe(attrInner, { childList: true, subtree: true });
  updateBasemapAttribution();
  updatePlateauAttribution();
  return true;
}

function updateRegionalAttribution() {
  let attrEl = document.getElementById('regional-cs-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'regional-cs-attr';
    attrInner.appendChild(attrEl);
  }
  const _csOverlay  = currentOverlay;
  const _csBasemap  = currentBasemap;
  const _csKey      = _csOverlay !== 'none' ? _csOverlay : _csBasemap;
  const csRegionalOn = (_csKey === 'cs' || _csKey === 'cs-0.5m') && map.getZoom() >= 17;
  if (!csRegionalOn) {
    attrEl.innerHTML = '';
    _lastAttrKey = null;
    return;
  }
  const z = map.getZoom();
  const b = map.getBounds();
  // bounds + zoom を0.01° / 0.1zoom 精度で文字列化してキャッシュキーにする
  const key = `${z.toFixed(1)},${b.getWest().toFixed(2)},${b.getSouth().toFixed(2)},${b.getEast().toFixed(2)},${b.getNorth().toFixed(2)}`;
  if (key === _lastAttrKey) return; // 変化なし → スキップ
  _lastAttrKey = key;
  const html = REGIONAL_CS_LAYERS
    .filter(l =>
      z >= Math.min(l.minzoom, 17) &&
      b.getWest()  < l.bounds[2] &&
      b.getEast()  > l.bounds[0] &&
      b.getSouth() < l.bounds[3] &&
      b.getNorth() > l.bounds[1]
    )
    .map(l => l.attribution)
    .join(' | ');
  attrEl.innerHTML = html ? ' | ' + html : '';
}

function updatePlateauAttribution() {
  let attrEl = document.getElementById('plateau-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'plateau-attr';
    attrInner.appendChild(attrEl);
  }
  const buildingOn = document.getElementById('chk-building')?.checked ?? false;
  const mode       = document.getElementById('sel-building')?.value ?? 'plateau';
  const plateauLink = ' | <a href="https://www.mlit.go.jp/plateau/open-data/" target="_blank">国土交通省3D都市モデルPLATEAU</a>';
  attrEl.innerHTML = !buildingOn ? ''
    : mode === 'plateau'     ? plateauLink + '（<a href="https://github.com/shiwaku/mlit-plateau-bldg-pmtiles" target="_blank">shiwaku</a>加工）'
    : mode === 'plateau-lod2' ? plateauLink + '（京都市左京区 LOD2 2024）'
    : '';
}

// ---- CS立体図 オーバーレイ制御 ----
// 0.5m モードはズーム17以上で地域CSを表示し、ズーム17未満は1mに自動フォールバック
let currentOverlay = 'none'; // 選択中のオーバーレイキー（'none' = オーバーレイなし）

function updateCsVisibility() {
  const basemap    = currentBasemap;
  const overlayOn  = currentOverlay !== 'none';
  const overlay    = currentOverlay;

  // 色別標高図の表示制御（visibility ではなく opacity で切替 — WebGL 初期化を常時維持するため）
  const showColorRelief = overlay === 'color-relief';
  if (map.getLayer('color-relief-layer')) {
    const crOpacity = showColorRelief ? parseFloat(document.getElementById('slider-cs').value) : 0;
    map.setPaintProperty('color-relief-layer', 'raster-opacity', crOpacity);
  }
  // スライダーはカード選択だけで表示（オーバーレイトグルのON/OFFに依存しない）
  const crCtrls = document.getElementById('color-relief-controls');
  if (crCtrls) crCtrls.style.display = (currentOverlay === 'color-relief') ? '' : 'none';

  // 色別等高線の表示制御（contourDemMode に応じて排他表示）
  const showColorContour = overlay === 'color-contour';
  const ccBaseVis = showColorContour ? 'visible' : 'none';
  COLOR_CONTOUR_Q_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourDemMode === 'q1m') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM5A_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourDemMode === 'dem5a') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM1A_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourDemMode === 'dem1a') ? 'visible' : 'none');
  });

  // CS立体図: color-relief 選択時は非表示
  const csOverlay = (showColorRelief || showColorContour) ? 'none' : overlay;
  const csKey = csOverlay !== 'none' ? csOverlay
              : basemap.startsWith('cs-') ? basemap
              : null;

  const z = map.getZoom();
  // 'cs'（統合キー）または旧 'cs-0.5m'（ベースマップ用に残存）はプログレッシブ表示
  // z>=17 で 1m を下敷きにした上に 0.5m を重ねる。旧 'cs-1m' は 1m のみ。
  const show1m  = !!csKey && csKey !== 'none';
  const show05m = !!csKey && csKey !== 'cs-1m' && z >= 17;

  if (map.getLayer('cs-relief-layer')) {
    map.setLayoutProperty('cs-relief-layer', 'visibility', show1m ? 'visible' : 'none');
  }
  REGIONAL_CS_LAYERS.forEach(layer => {
    if (map.getLayer(layer.layerId)) {
      map.setLayoutProperty(layer.layerId, 'visibility', show05m ? 'visible' : 'none');
      if (show05m) {
        // 表示時にスライダーの現在値を反映（初期値 1.0 のままになるのを防ぐ）
        map.setPaintProperty(layer.layerId, 'raster-opacity', parseFloat(sliderCs.value));
      }
    }
  });

  // なし選択時はスライダーを無効化
  document.getElementById('slider-cs').disabled = !overlayOn;
  updateRegionalAttribution();
}

// 読み込み中インジケーター（中央・オーバーレイ選択時）
const _mapLoadingEl = document.getElementById('map-loading');
let _mapLoadingIdleRegistered = false;

function showMapLoading() {
  if (_mapLoadingEl) _mapLoadingEl.style.display = 'flex';
  if (_mapLoadingIdleRegistered) return;
  _mapLoadingIdleRegistered = true;
  map.once('idle', hideMapLoading);
}
function hideMapLoading() {
  _mapLoadingIdleRegistered = false;
  if (_mapLoadingEl) _mapLoadingEl.style.display = 'none';
}

// タイル生成インジケーター（右下・地図移動/ズーム時）
const _mapTileLoadingEl = document.getElementById('map-tile-loading');
let _mapTileLoadingIdleRegistered = false;

function showMapTileLoading() {
  if (_mapTileLoadingEl) _mapTileLoadingEl.style.display = 'flex';
  if (_mapTileLoadingIdleRegistered) return;
  _mapTileLoadingIdleRegistered = true;
  map.once('idle', hideMapTileLoading);
}
function hideMapTileLoading() {
  _mapTileLoadingIdleRegistered = false;
  if (_mapTileLoadingEl) _mapTileLoadingEl.style.display = 'none';
}

// CS立体図レイヤーが現在表示中かどうか
function isCsLayerVisible() {
  return !!(map.getLayer('cs-relief-layer') &&
    map.getLayoutProperty('cs-relief-layer', 'visibility') === 'visible');
}

function isGeneratingLayer() {
  return isCsLayerVisible() || currentOverlay === 'color-relief';
}

map.on('movestart', () => {
  if (isGeneratingLayer()) showMapTileLoading();
});

// オーバーレイカードのクリックハンドラー
document.getElementById('overlay-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.bm-card');
  if (!card) return;
  document.querySelectorAll('#overlay-cards .bm-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  currentOverlay = card.dataset.key;
  updateCsVisibility();
  // CS立体図・色別標高図選択時はローディング表示（idle で非表示）
  if (currentOverlay === 'cs' || currentOverlay === 'color-relief') showMapLoading();
  else hideMapLoading();
  // 色別標高図選択時はタイルを即座にリクエスト（visibility:none 中はMapLibreがフェッチしないため）
  if (currentOverlay === 'color-relief') applyColorReliefTiles();
});

// （chk-overlay 削除のため、トグルイベントリスナーは不要）

// ズーム17の境界を跨いだとき 0.5m ↔ 1m を自動切替
map.on('zoomend', updateCsVisibility);


// ---- 色別標高図 デュアルレンジスライダー ----
// DEM タイルベース URL（プロトコルを除いたパス部分）
const COLOR_RELIEF_DEM_BASE = 'mapdata.qchizu.xyz/03_dem/52_gsi/all_2026/1_01';

// 現在の min/max 値
let crMin = 0;
let crMax = 500;

// crMin/crMax をスライダーの range に収まるよう動的拡張し、全UIを同期
function syncColorReliefUI() {
  const minSlider = document.getElementById('cr-min-slider');
  const maxSlider = document.getElementById('cr-max-slider');
  const minInput  = document.getElementById('cr-min-input');
  const maxInput  = document.getElementById('cr-max-input');
  if (!minSlider || !maxSlider) return;

  // 下限は 0 固定、上限は crMax に応じて動的拡張
  minSlider.min = maxSlider.min = '0';
  const sMax = parseFloat(minSlider.max);
  crMin = Math.max(crMin, 0);
  if (crMax > sMax) { minSlider.max = maxSlider.max = String(crMax + 100); }

  // スライダーつまみ位置を同期
  minSlider.value = crMin;
  maxSlider.value = crMax;

  // 数値入力欄を同期
  if (minInput) minInput.value = crMin;
  if (maxInput) maxInput.value = crMax;
}

// パレット定義（protocols.js の DEM2RELIEF_PALETTE と同色）
const CR_PALETTE = [
  { t: 0.00, r:   0, g:   6, b: 251 }, // #0006FB
  { t: 0.17, r:   0, g: 146, b: 251 }, // #0092FB
  { t: 0.33, r:   0, g: 231, b: 251 }, // #00E7FB
  { t: 0.50, r: 138, g: 247, b:   8 }, // #8AF708
  { t: 0.67, r: 242, g: 249, b:  11 }, // #F2F90B
  { t: 0.83, r: 242, g: 138, b:   9 }, // #F28A09
  { t: 1.00, r: 242, g:  72, b:  11 }, // #F2480B
];

// バーのグラデーションを動的に更新する
// min より左は最初の色、max より右は最後の色でベタ塗り、間は全パレットグラデーション
function updateGradientTrack() {
  const track     = document.querySelector('.cr-gradient-track');
  const minSlider = document.getElementById('cr-min-slider');
  if (!track || !minSlider) return;

  const tMin  = parseFloat(minSlider.min);
  const tMax  = parseFloat(minSlider.max);
  const range = tMax - tMin || 1;

  const L = Math.max(0, Math.min(1, (crMin - tMin) / range)) * 100; // 左つまみ位置(%)
  const R = Math.max(0, Math.min(1, (crMax - tMin) / range)) * 100; // 右つまみ位置(%)

  const c0 = `rgb(${CR_PALETTE[0].r},${CR_PALETTE[0].g},${CR_PALETTE[0].b})`;
  const c1 = `rgb(${CR_PALETTE[CR_PALETTE.length-1].r},${CR_PALETTE[CR_PALETTE.length-1].g},${CR_PALETTE[CR_PALETTE.length-1].b})`;

  const stops = [];
  // 左端〜min: 最初の色でベタ塗り
  stops.push(`${c0} 0%`);
  stops.push(`${c0} ${L.toFixed(2)}%`);
  // min〜max: 全パレットグラデーション
  for (const p of CR_PALETTE) {
    const pos = (L + p.t * (R - L)).toFixed(2);
    stops.push(`rgb(${p.r},${p.g},${p.b}) ${pos}%`);
  }
  // max〜右端: 最後の色でベタ塗り
  stops.push(`${c1} ${R.toFixed(2)}%`);
  stops.push(`${c1} 100%`);

  track.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}

// タイル再フェッチのデバウンスタイマー
let _crTileTimer = null;

// 色別等高線の line-color を crMin/crMax に合わせて再設定
function updateColorContourColors() {
  const expr = buildColorContourExpr(crMin, crMax);
  [...COLOR_CONTOUR_Q_IDS, ...COLOR_CONTOUR_DEM5A_IDS, ...COLOR_CONTOUR_DEM1A_IDS].forEach(id => {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', expr);
  });
}

// タイル URL を更新して地図に反映
let _crRepaintTimer = null;
function applyColorReliefTiles() {
  if (!map.getSource('color-relief')) return;
  map.getSource('color-relief').setTiles([
    `dem2relief://${COLOR_RELIEF_DEM_BASE}/{z}/{x}/{y}.webp?min=${crMin}&max=${crMax}`
  ]);
  clearTimeout(_crRepaintTimer);
  let remaining = 20; // 20 × 100ms = 2 秒
  const repaint = () => {
    map.triggerRepaint();
    if (--remaining > 0) _crRepaintTimer = setTimeout(repaint, 100);
  };
  repaint();
}

// ドラッグ中は UI のみ即座に更新し、タイル再フェッチはデバウンス（300ms）
function updateColorReliefUI() {
  syncColorReliefUI();
  updateGradientTrack();
  updateColorContourColors();
  clearTimeout(_crTileTimer);
  _crTileTimer = setTimeout(applyColorReliefTiles, 300);
}

// 確定時（ドラッグ終了・数値入力・自動フィット）はタイルを即座に更新
function updateColorReliefSource() {
  syncColorReliefUI();
  updateGradientTrack();
  updateColorContourColors();
  clearTimeout(_crTileTimer);
  applyColorReliefTiles();
}

// 双方向バインディング初期化
(function initColorReliefSlider() {
  const minSlider = document.getElementById('cr-min-slider');
  const maxSlider = document.getElementById('cr-max-slider');
  const minInput  = document.getElementById('cr-min-input');
  const maxInput  = document.getElementById('cr-max-input');
  if (!minSlider || !maxSlider) return;

  // ── スライダー: ドラッグ中は UI のみ即時更新、離したときにタイル確定 ──
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

  // ── 数値入力 → スライダー・地図（フォーカス離脱・Enter 確定時のみ反映・入力中は補正しない） ──
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

  // 初期状態を反映
  updateColorReliefSource();
})();

// ---- 色別標高図: 表示範囲から自動フィット ----
// 画面内を 8×8 グリッドでサンプリング。
// スクリーン座標ベースで等間隔サンプリング。
// getBounds() の lng/lat 均等分割より描画済みキャンバス領域に忠実で
// テレインタイルが確実にロードされているエリアのみを対象にできる。
// exaggerated:false で地形誇張の影響を受けない実際の標高値を取得する。
function autoFitColorRelief() {
  // 低ズームでは地形タイルの同時リクエスト数を抑えるためグリッドを縮小
  const GRID = map.getZoom() <= 9 ? 10 : 20; // 10×10=100点 or 20×20=400点
  const canvas = map.getCanvas();
  const w = canvas.width;
  const h = canvas.height;

  let globalMin = Infinity, globalMax = -Infinity;

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const px = (c + 0.5) / GRID * w;
      const py = (r + 0.5) / GRID * h;
      const lngLat = map.unproject([px, py]);
      const elev = map.queryTerrainElevation(lngLat, { exaggerated: false });
      if (elev == null) continue;
      if (elev < globalMin) globalMin = elev;
      if (elev > globalMax) globalMax = elev;
    }
  }

  if (!isFinite(globalMin) || !isFinite(globalMax)) return;

  const step = 10;
  crMin = Math.max(0, Math.floor(globalMin / step) * step);
  crMax = Math.ceil(globalMax  / step) * step;
  if (crMax <= crMin) crMax = crMin + step;

  updateColorReliefSource();
}

document.getElementById('cr-autofit-btn')?.addEventListener('click', autoFitColorRelief);

// ---- CS立体図 透明度スライダー（全国・地域別共通） ----
const sliderCs = document.getElementById('slider-cs');
updateSliderGradient(sliderCs, '#6a8fa0');

sliderCs.addEventListener('input', () => {
  const v = parseFloat(sliderCs.value);
  updateSliderGradient(sliderCs, '#6a8fa0');
  if (map.getLayer('cs-relief-layer')) {
    map.setPaintProperty('cs-relief-layer', 'raster-opacity', v);
  }
  REGIONAL_CS_LAYERS.forEach(layer => {
    if (map.getLayer(layer.layerId)) {
      map.setPaintProperty(layer.layerId, 'raster-opacity', v);
    }
  });
  // 色別標高図: 選択中のときのみ opacity を更新（非表示時は 0 を維持）
  if (currentOverlay === 'color-relief' && map.getLayer('color-relief-layer')) {
    map.setPaintProperty('color-relief-layer', 'raster-opacity', v);
  }
});


// ---- deck.gl 遅延ロード（PLATEAU LOD2 選択時のみ読み込む）----
// deck.gl v9 は luma.gl v9 の頂点属性バリデーション (size: 1) で PLATEAU b3dm が読めない
// ため、安定動作する v8.9 系を使用する。
const PLATEAU_LOD2_URL =
  'https://assets.cms.plateau.reearth.io/assets/e9/114ee3-8a65-4d3f-8494-11e8ffcf3dc5' +
  '/26100_kyoto-shi_city_2024_citygml_1_op_bldg_3dtiles_26103_sakyo-ku_lod2/tileset.json';

let _deckOverlay = null; // deck.MapboxOverlay インスタンス（初回のみ生成）

// deck.gl v8.9 + loaders.gl v3 を動的に読み込む
function _loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`スクリプトの読み込みに失敗: ${url}`));
    document.head.appendChild(s);
  });
}

async function _loadDeckGl() {
  if (window.deck) return;
  // loaders.gl 3D Tiles を先に読み込み、次に deck.gl 本体
  await _loadScript('https://unpkg.com/@loaders.gl/3d-tiles@3.4.14/dist/dist.min.js');
  await _loadScript('https://unpkg.com/deck.gl@8.9.35/dist.min.js');
}

function _initDeckOverlay() {
  if (_deckOverlay || !window.deck) return;
  _deckOverlay = new deck.MapboxOverlay({ layers: [] });
  map.addControl(_deckOverlay);
}

async function _applyDeckLod2(visible) {
  if (!visible) {
    _deckOverlay?.setProps({ layers: [] });
    return;
  }
  showMapLoading(); // ロード開始時にくるくるを表示
  try {
    await _loadDeckGl();
    _initDeckOverlay();
    _deckOverlay.setProps({
      layers: [
        new deck.Tile3DLayer({
          id: 'plateau-lod2',
          data: PLATEAU_LOD2_URL,
          loader: window.loaders?.Tiles3DLoader,
          opacity: 0.8,
          pointSize: 1,
          // PBR ライティングを無効化してテクスチャ色をフラットに描画
          _subLayerProps: {
            scenegraph: { _lighting: 'flat' },
          },
          onTilesetLoad: (tileset) => {
            // tileset.json 解析完了後も個別タイル(b3dm)が生成中のため
            // isLoaded が true になるまで rAF でポーリングし続ける
            const waitUntilLoaded = () => {
              if (tileset.isLoaded) { hideMapLoading(); return; }
              requestAnimationFrame(waitUntilLoaded);
            };
            requestAnimationFrame(waitUntilLoaded);
          },
          // PLATEAU は楕円体高のため地形とずれる → onTileLoad で高度補正
          onTileLoad: (tile) => {
            if (tile.content?.cartographicOrigin) {
              const o = tile.content.cartographicOrigin;
              tile.content.cartographicOrigin = new Float64Array([o[0], o[1], o[2] - 40]);
            }
          },
        }),
      ],
    });
  } catch (e) {
    hideMapLoading();
    console.error('PLATEAU LOD2 の表示に失敗:', e);
  }
}

// ---- 3D建物レイヤー切替 ----
/* 建物モード: 'ofm'（OpenFreeMap） | 'plateau'（PLATEAU LOD1 全国） | 'plateau-lod2'（PLATEAU LOD2 3D Tiles）
   3D地形の ON/OFF とは独立して制御可能。 */
const BUILDING_CFG = {
  ofm: {
    source:      'ofm',
    sourceLayer: 'building',
    height: ['coalesce', ['get', 'render_height'], 3],
    base:   ['coalesce', ['get', 'render_min_height'], 0],
  },
  plateau: {
    source:      'plateau-lod1',
    sourceLayer: 'PLATEAU',
    height: ['coalesce', ['get', 'measuredHeight'], 3],
    base:   0,
  },
};

async function updateBuildingLayer() {
  const mode       = document.getElementById('sel-building')?.value ?? 'plateau';
  const buildingOn = document.getElementById('chk-building')?.checked ?? true;

  // 既存 MapLibre レイヤーを一旦削除
  if (map.getLayer('building-3d')) map.removeLayer('building-3d');

  // LOD2 モード: deck.gl Tile3DLayer で表示
  if (mode === 'plateau-lod2') {
    await _applyDeckLod2(buildingOn);
    updatePlateauAttribution();
    return;
  }
  // LOD2 以外: deck.gl レイヤーをクリア
  _deckOverlay?.setProps({ layers: [] });

  if (!buildingOn) { updatePlateauAttribution(); return; }

  const cfg = BUILDING_CFG[mode];
  if (!cfg || !map.getSource(cfg.source)) return; // ソース未追加なら無視

  map.addLayer({
    id: 'building-3d',
    type: 'fill-extrusion',
    source: cfg.source,
    'source-layer': cfg.sourceLayer,
    minzoom: 14,
    paint: {
      'fill-extrusion-height':  cfg.height,
      'fill-extrusion-base':    cfg.base,
      'fill-extrusion-color':   'rgb(150, 150, 150)',
      'fill-extrusion-opacity': 0.7,
    },
  });
  updatePlateauAttribution();
}

document.getElementById('sel-building').addEventListener('change', updateBuildingLayer);
document.getElementById('chk-building').addEventListener('change', updateBuildingLayer);

// ---- 地形誇張 チェックボックス + スライダー ----
const chkExaggeration = document.getElementById('chk-exaggeration');
const sliderExaggeration = document.getElementById('slider-exaggeration');
const valExaggeration = document.getElementById('val-exaggeration');
updateSliderGradient(sliderExaggeration, '#6a8fa0');

// チェックOFF → setTerrain(null) で地形を完全に平坦化（傾けても立体にならない）
// チェックON  → setTerrain でスライダー値の誇張率を復元
chkExaggeration.addEventListener('change', () => {
  const isOn = chkExaggeration.checked;
  sliderExaggeration.disabled = !isOn;
  document.querySelector('label[for="chk-exaggeration"]').classList.toggle('disabled', !isOn);
  valExaggeration.textContent = parseFloat(sliderExaggeration.value).toFixed(1) + '×';
  updateSliderGradient(sliderExaggeration, '#6a8fa0');
  if (isOn) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: parseFloat(sliderExaggeration.value) });
  } else {
    map.setTerrain(null);
  }
  // 地形 ON/OFF で raster-opacity の補正有無が変わるため、全KMZレイヤーを再適用する
  kmzLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
  });
});

sliderExaggeration.addEventListener('input', () => {
  let v = parseFloat(sliderExaggeration.value);
  // キリのいい倍率に吸い付く
  if (v >= 0.9 && v <= 1.1) {
    v = 1.0;
  } else if (v >= 1.9 && v <= 2.1) {
    v = 2.0;
  } else if (v >= 2.9) {
    v = 3.0;
  }
  sliderExaggeration.value = String(v);
  valExaggeration.textContent = v.toFixed(1) + '×';
  updateSliderGradient(sliderExaggeration, '#6a8fa0');
  map.setTerrain({ source: 'terrain-dem', exaggeration: v });
});

// ---- 等高線 チェックボックス ----
const chkContour = document.getElementById('chk-contour');
const selContour = document.getElementById('sel-contour-interval');
const optContourCurrent = document.getElementById('opt-contour-current');

// ユーザーが手動で選んだ等高線間隔（m）。zoom > 15（16以上）のときに使用する。
let userContourInterval = 5;
// 最後に適用した間隔（連続 moveend での無駄な setTiles を防ぐ）
let lastAppliedContourInterval = null;
// z≤7 で等高線を非表示済みかどうか（moveend のたびに重複 setLayoutProperty するのを防ぐ）
let contourHiddenByLowZoom = false;

// zoom レベルに応じた有効な等高線間隔（m）を返す
// 地理院地形図スケールとの対応：
//   z8  ≈ 1:1,000,000 → 200m（国スケール・山脈骨格）
//   z9  ≈ 1:500,000   → 100m
//   z10 ≈ 1:250,000   → 50m（20万図相当）
//   z11 ≈ 1:125,000   → 25m（5万図=20m に近似）
//   z12 ≈ 1:62,500    → 10m（2.5万図の標準 10m）
//   z13 ≈ 1:31,000    → 5m
//   z14+ ≈ 1:15,500–  → ユーザー設定（デフォルト 5m）
function getEffectiveContourInterval() {
  const z = map.getZoom();
  if (z <=  8) return 200;
  if (z <=  9) return 100;
  if (z <= 10) return  50;
  if (z <= 11) return  25;
  if (z <= 12) return  10;
  if (z <= 13) return   5;
  return userContourInterval;
}

// 等高線タイルを intervalM に切り替える（旧タイルをフラッシュしてから URL を更新）
// Q地図 + DEM5Aフォールバック + 湖水深ソースを同時に更新する。
function applyContourInterval(intervalM) {
  const newUrl      = buildContourTileUrl(intervalM);
  const newUrlDem5a = buildSeamlessContourTileUrl(intervalM);
  const newUrlDem1a = buildDem1aContourTileUrl(intervalM);
  // 湖水深等高線は廃止（2026-03-23）
  // const newUrlLake  = buildLakeContourTileUrl(intervalM);
  // 各ソースを個別にチェック（1つが未登録でも他のソースは更新し続ける）
  const hasQchizu = newUrl      && map.getSource('contour-source');
  const hasDem5a  = newUrlDem5a && map.getSource('contour-source-dem5a');
  const hasDem1a  = newUrlDem1a && map.getSource('contour-source-dem1a');
  // const hasLake   = newUrlLake  && map.getSource('contour-source-lake');
  if (!hasQchizu && !hasDem5a && !hasDem1a) return;
  // visibility:none で一旦消すとフリックが起きるため、表示を維持したまま setTiles のみ実行
  if (hasQchizu) map.getSource('contour-source').setTiles([newUrl]);
  if (hasDem5a)  map.getSource('contour-source-dem5a').setTiles([newUrlDem5a]);
  if (hasDem1a)  map.getSource('contour-source-dem1a').setTiles([newUrlDem1a]);
  // if (hasLake)   map.getSource('contour-source-lake').setTiles([newUrlLake]);
  // 初期 visibility:none で追加されるため、ここで visible に設定する（フリック防止のため none は経由しない）
  if (chkContour.checked) setAllContourVisibility('visible');
  lastAppliedContourInterval = intervalM;
}

// moveend 時に zoom に応じた間隔へ自動切り替え＆セレクト表示を更新
function updateContourAutoInterval() {
  if (!chkContour.checked) return;

  const z = map.getZoom();

  // zoom ≤ 7 では等高線を非表示
  if (z <= 7) {
    // 既に非表示済みなら setLayoutProperty の重複呼び出しを省略
    if (!contourHiddenByLowZoom) {
      setAllContourVisibility('none');
      contourHiddenByLowZoom = true;
    }
    if (optContourCurrent) {
      optContourCurrent.textContent = '非表示';
      selContour.selectedIndex = 0;
    }
    lastAppliedContourInterval = null; // zoom上昇時に再描画させる
    return;
  }
  contourHiddenByLowZoom = false; // z>7 に戻ったらフラグをリセット

  const intervalM = getEffectiveContourInterval();
  if (optContourCurrent) {
    optContourCurrent.textContent = intervalM + ' m';
    selContour.selectedIndex = 0;
  }
  // z0-z13 の等高線間隔は buildContourThresholds 内で固定値としてURLに埋め込み済みのため、
  // ズームレベルが変わっても URL は変化しない → setTiles を呼ばない。
  // z≤7 から復帰した場合（lastAppliedContourInterval === null）のみ再適用する。
  if (lastAppliedContourInterval === null) {
    applyContourInterval(userContourInterval);
  }
}

chkContour.addEventListener('change', () => {
  const vis = chkContour.checked ? 'visible' : 'none';
  setAllContourVisibility(vis);
  selContour.disabled = !chkContour.checked;
  document.querySelector('label[for="chk-contour"]').classList.toggle('disabled', !chkContour.checked);
});

// ---- 等高線 間隔セレクト ----
selContour.addEventListener('change', () => {
  const val = parseFloat(selContour.value);
  if (val) {
    // value='' の先頭オプション（auto表示）以外を選んだ場合はユーザー設定として保存
    userContourInterval = val;
    applyContourInterval(val);
    if (optContourCurrent) {
      optContourCurrent.textContent = val + ' m';
      selContour.selectedIndex = 0;
    }
  }
});


// ---- 等高線 DEMソース切り替え ----
const selContourDem = document.getElementById('sel-contour-dem');
selContourDem.addEventListener('change', () => {
  contourDemMode = selContourDem.value; // 'q1m' / 'dem5a' / 'dem1a'
  if (chkContour.checked) {
    setAllContourVisibility('visible');
  }
  // 色別等高線オーバーレイ選択中の場合はソース切り替えに追従
  if (currentOverlay === 'color-contour') updateCsVisibility();
  // 地形は常に全ソース合成のため DEMソース切り替えに連動しない
});

// ---- 磁北線 チェックボックス + セレクト ----
const chkMagneticNorth = document.getElementById('chk-magnetic-north');
const selMagneticNorth = document.getElementById('sel-magnetic-north-interval');

chkMagneticNorth.addEventListener('change', () => {
  const vis = chkMagneticNorth.checked ? 'visible' : 'none';
  selMagneticNorth.disabled = !chkMagneticNorth.checked;
  document.querySelector('label[for="chk-magnetic-north"]').classList.toggle('disabled', !chkMagneticNorth.checked);
  if (map.getLayer('magnetic-north-layer')) {
    map.setLayoutProperty('magnetic-north-layer', 'visibility', vis);
  }
});

selMagneticNorth.addEventListener('change', () => {
  const val = parseInt(selMagneticNorth.value, 10);
  if (val) {
    // value='' の先頭オプション（auto表示）以外を選んだ場合はユーザー設定として保存
    userMagneticInterval = val;
  }
  updateMagneticNorth();
});

// ---- ベースマップ切替 ----
/**
 * ベースマップを切り替える。
 * setStyle() を使わず visibility の切り替えのみで実現するため、
 * KMZ / GPX / CS立体図 / 等高線 / 磁北線など後から追加した動的レイヤーには一切影響しない。
 *
 * レイヤー構成（下層 → 上層）:
 *   [ラスターベースマップ群] ← このグループを切り替える
 *   [OriLibre ベクターレイヤー群（isomizer 生成）]
 *   [等高線・CS立体図・KMZ・GPX・磁北線 …常時保持]
 *
 * @param {string} key - RASTER_BASEMAPS のキー、または 'orilibre'
 */
function switchBasemap(key) {
  currentBasemap = key;

  // ① ラスターベースマップを全て非表示（url を持つエントリのみ）
  Object.keys(RASTER_BASEMAPS).filter(k => RASTER_BASEMAPS[k].url).forEach(k => {
    if (map.getLayer(k + '-layer')) map.setLayoutProperty(k + '-layer', 'visibility', 'none');
  });

  if (key === 'orilibre') {
    // ② OriLibre レイヤーを元の visibility に戻す
    oriLibreLayers.forEach(({ id, defaultVisibility }) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', defaultVisibility);
    });
    // isomizer 失敗時のフォールバックレイヤーも復元
    if (map.getLayer('basemap-fallback-layer')) {
      map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'visible');
    }
  } else if (key.startsWith('cs-')) {
    // CS立体図をベースマップとして使用: OriLibre・ラスターを全て非表示にして CS のみ表示
    oriLibreLayers.forEach(({ id }) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    if (map.getLayer('basemap-fallback-layer')) {
      map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'none');
    }
    // CS レイヤーの表示は updateCsVisibility に委譲
  } else {
    // ③ OriLibre レイヤーを全て非表示
    oriLibreLayers.forEach(({ id }) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    if (map.getLayer('basemap-fallback-layer')) {
      map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'none');
    }
    // ④ 選択したラスターレイヤーを表示
    if (map.getLayer(key + '-layer')) map.setLayoutProperty(key + '-layer', 'visibility', 'visible');
  }

  // CS 表示状態を更新（ベースマップとしての CS も updateCsVisibility で管理）
  updateCsVisibility();
  // 出典先頭のベースマップ表記を更新
  updateBasemapAttribution();
}

// ---- ベースマップカード クリック処理 ----
document.getElementById('basemap-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.bm-card');
  if (!card) return;
  document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  switchBasemap(card.dataset.key);
});

// ---- 枠スクリーンショット ----
// 指定した枠の bounding box にカメラをフィットさせ、idle 後に PNG ダウンロード
function captureFrameShot(frame) {
  const coords = frame.coordinates; // [[lng,lat], ...]
  const lngs = coords.map(c => c[0]);
  const lats  = coords.map(c => c[1]);
  const bounds = [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];

  // 現在の pitch / bearing を保存して 2D（真上）に一時切り替え
  const prevPitch   = map.getPitch();
  const prevBearing = map.getBearing();

  map.easeTo({ pitch: 0, bearing: 0, duration: 0 });
  map.fitBounds(bounds, { padding: 10, duration: 0 });

  map.once('idle', () => {
    const canvas = map.getCanvas();
    const link   = document.createElement('a');
    const safeName = (frame.properties.event_name ?? frame.properties.name ?? 'frame')
      .replace(/[\\/:*?"<>|]/g, '_');
    link.download = `teledrop_${safeName}.png`;
    link.href     = canvas.toDataURL('image/png');
    link.click();

    // pitch / bearing を復元
    map.easeTo({ pitch: prevPitch, bearing: prevBearing, duration: 300 });
  });
}

// ---- 枠 GeoJSON エクスポート ----
// 地方→都道府県→テレインの3段カスケードダイアログ。
// 解決値: { pref, terrainId, terrainName, isNew, eventName } または null（キャンセル）
function promptTerrainInfo() {
  return new Promise(resolve => {
    const dialog      = document.getElementById('export-terrain-dialog');
    const regionList  = document.getElementById('export-region-list');
    const prefRow     = document.getElementById('export-pref-row');
    const prefList    = document.getElementById('export-pref-list');
    const terrainRow  = document.getElementById('export-terrain-row');
    const terrainList = document.getElementById('export-terrain-list');
    const nameInp     = document.getElementById('export-terrain-name');
    const eventRow    = document.getElementById('export-event-row');
    const eventList   = document.getElementById('export-event-list');
    const eventInp    = document.getElementById('export-event-name');
    const detailRow   = document.getElementById('export-detail-row');
    const dateInp     = document.getElementById('export-event-date');
    const scaleInp    = document.getElementById('export-scale');
    const mapSizeInp  = document.getElementById('export-map-size');
    const okBtn       = document.getElementById('export-dialog-ok');
    const cancelBtn   = document.getElementById('export-dialog-cancel');

    // 状態リセット
    let selRegion = null, selPref = null, selTerrainId = null, selTerrainName = null;
    let selEventName = null;
    regionList.innerHTML = '';
    prefRow.style.display = 'none';
    prefList.innerHTML = '';
    terrainRow.style.display = 'none';
    terrainList.innerHTML = '';
    nameInp.style.display = 'none';
    nameInp.value = '';
    eventRow.style.display = 'none';
    eventList.innerHTML = '';
    eventInp.style.display = 'none';
    eventInp.value = '';
    detailRow.style.display = 'none';
    dateInp.value = '';
    scaleInp.value = '';
    mapSizeInp.value = '';
    okBtn.disabled = true;
    dialog.style.display = 'flex';

    function updateOk() {
      const terrainOk = selTerrainId === '__new__' ? nameInp.value.trim() !== '' : selTerrainId !== null;
      const eventOk   = selEventName === '__new__' ? eventInp.value.trim() !== '' : selEventName !== null;
      const detailOk  = dateInp.value.trim() !== '' && scaleInp.value !== '' && mapSizeInp.value !== '';
      okBtn.disabled = !(terrainOk && eventOk && detailOk);
    }

    // Step1: 地方ピルを生成
    for (const region of Object.keys(REGION_PREF_MAP)) {
      const btn = document.createElement('button');
      btn.className = 'export-pill-btn';
      btn.textContent = region;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        regionList.querySelectorAll('.export-pill-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selRegion = region;
        selPref = null; selTerrainId = null; selTerrainName = null; selEventName = null;
        eventRow.style.display = 'none';

        // Step2: 都道府県を展開
        prefList.innerHTML = '';
        const prefs = REGION_PREF_MAP[region];
        if (prefs.length === 0) {
          // 海外など都道府県なし → テレイン選択へ直行
          prefRow.style.display = 'none';
          buildTerrainList(null);
        } else {
          prefRow.style.display = '';
          terrainRow.style.display = 'none';
          terrainList.innerHTML = '';
          nameInp.style.display = 'none';
          okBtn.disabled = true;
          for (const pref of prefs) {
            const pb = document.createElement('button');
            pb.className = 'export-pill-btn';
            pb.textContent = pref;
            pb.type = 'button';
            pb.addEventListener('click', () => {
              prefList.querySelectorAll('.export-pill-btn').forEach(b => b.classList.remove('active'));
              pb.classList.add('active');
              selPref = pref;
              selTerrainId = null; selTerrainName = null; selEventName = null;
              eventRow.style.display = 'none';
              buildTerrainList(pref);
            });
            prefList.appendChild(pb);
          }
        }
      });
      regionList.appendChild(btn);
    }

    // Step3: テレイン一覧を生成（pref=null なら海外扱い）
    function buildTerrainList(pref) {
      terrainRow.style.display = '';
      terrainList.innerHTML = '';
      nameInp.style.display = 'none';
      nameInp.value = '';
      selTerrainId = null; selTerrainName = null;
      eventRow.style.display = 'none';
      okBtn.disabled = true;

      // terrainMap から該当都道府県のテレインを列挙
      const matched = [];
      for (const [tid, tdata] of terrainMap.entries()) {
        if (pref === null || tdata.prefecture === pref) {
          matched.push({ id: tid, name: tdata.name });
        }
      }
      matched.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

      for (const t of matched) {
        const ib = document.createElement('button');
        ib.className = 'export-item-btn';
        ib.textContent = t.name;
        ib.type = 'button';
        ib.addEventListener('click', () => {
          terrainList.querySelectorAll('.export-item-btn').forEach(b => b.classList.remove('active'));
          ib.classList.add('active');
          selTerrainId = t.id;
          selTerrainName = t.name;
          nameInp.style.display = 'none';
          nameInp.value = '';
          selEventName = null;
          buildEventList(t.id);
        });
        terrainList.appendChild(ib);
      }

      // 「その他（新規）」
      const newBtn = document.createElement('button');
      newBtn.className = 'export-item-btn';
      newBtn.textContent = 'その他（新規）';
      newBtn.type = 'button';
      newBtn.addEventListener('click', () => {
        terrainList.querySelectorAll('.export-item-btn').forEach(b => b.classList.remove('active'));
        newBtn.classList.add('active');
        selTerrainId = '__new__';
        selTerrainName = null;
        nameInp.style.display = '';
        nameInp.value = '';
        nameInp.focus();
        selEventName = null;
        // 新規テレインの場合は大会名も新規入力のみ
        buildEventList(null);
        updateOk();
      });
      terrainList.appendChild(newBtn);
    }

    // Step4: 大会名一覧を生成（terrainId=null なら既存なしで新規入力のみ）
    function buildEventList(terrainId) {
      eventRow.style.display = '';
      eventList.innerHTML = '';
      eventInp.style.display = 'none';
      eventInp.value = '';
      selEventName = null;
      okBtn.disabled = true;

      // 同テレインに紐づく既存大会名を mapFrames から収集（重複排除）
      const existing = [];
      if (terrainId && terrainId !== '__new__') {
        const seen = new Set();
        for (const f of mapFrames) {
          const en = f.properties?.event_name;
          if (f.properties?.terrain_id === terrainId && en && !seen.has(en)) {
            seen.add(en);
            existing.push(en);
          }
        }
        existing.sort((a, b) => a.localeCompare(b, 'ja'));
      }

      // 大会名選択時に詳細フォームを表示し、既存データがあれば prefill する
      function onEventSelect(en) {
        selEventName = en;
        eventInp.style.display = 'none';
        eventInp.value = '';
        detailRow.style.display = '';
        dateInp.value = '';
        scaleInp.value = '';
        mapSizeInp.value = '';
        // 既存の大会データから prefill
        if (en && en !== '__new__') {
          const src = mapFrames.find(f =>
            f.properties?.terrain_id === selTerrainId && f.properties?.event_name === en
          );
          if (src) {
            dateInp.value    = src.properties.event_date  ?? '';
            scaleInp.value   = src.properties.scale       ?? '';
            mapSizeInp.value = src.properties.map_size    ?? '';
          }
        }
        updateOk();
      }

      for (const en of existing) {
        const ib = document.createElement('button');
        ib.className = 'export-item-btn';
        ib.textContent = en;
        ib.type = 'button';
        ib.addEventListener('click', () => {
          eventList.querySelectorAll('.export-item-btn').forEach(b => b.classList.remove('active'));
          ib.classList.add('active');
          onEventSelect(en);
        });
        eventList.appendChild(ib);
      }

      // 「新規入力」
      const newEvBtn = document.createElement('button');
      newEvBtn.className = 'export-item-btn';
      newEvBtn.textContent = '新規入力';
      newEvBtn.type = 'button';
      newEvBtn.addEventListener('click', () => {
        eventList.querySelectorAll('.export-item-btn').forEach(b => b.classList.remove('active'));
        newEvBtn.classList.add('active');
        selEventName = '__new__';
        eventInp.style.display = '';
        eventInp.value = '';
        eventInp.focus();
        detailRow.style.display = '';
        dateInp.value = '';
        scaleInp.value = '';
        mapSizeInp.value = '';
        updateOk();
      });
      eventList.appendChild(newEvBtn);
    }

    nameInp.addEventListener('input', updateOk);
    eventInp.addEventListener('input', updateOk);
    dateInp.addEventListener('input', updateOk);
    scaleInp.addEventListener('change', updateOk);
    mapSizeInp.addEventListener('change', updateOk);

    function finish(result) {
      dialog.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() {
      if (okBtn.disabled) return;
      const pref = selPref ?? '海外';
      const terrainName = selTerrainId === '__new__' ? nameInp.value.trim() : selTerrainName;
      const eventName   = selEventName === '__new__' ? eventInp.value.trim() : selEventName;
      if (!terrainName) { nameInp.focus(); return; }
      if (!eventName)   { eventInp.focus(); return; }
      finish({
        pref,
        terrainId:   selTerrainId === '__new__' ? null : selTerrainId,
        terrainName,
        isNew:       selTerrainId === '__new__',
        eventName,
        eventDate:   dateInp.value   || null,
        scale:       scaleInp.value  || null,
        mapSize:     mapSizeInp.value || null,
      });
    }
    function onCancel() { finish(null); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function exportFramesAsGeoJson() {
  // 手動配置で追加した枠（mapFrames）を GeoJSON FeatureCollection として出力する
  const targets = mapFrames.filter(f => f.id.startsWith('img-import-'));
  if (targets.length === 0) { alert('エクスポートできる枠がありません。\n先に地図画像を位置合わせして読み込んでください。'); return; }

  const info = await promptTerrainInfo();
  if (!info) return; // キャンセル

  // 既存テレインを再利用するか、新規作成するか
  const terrainId = info.isNew ? `terrain_manual_${Date.now()}` : info.terrainId;

  // 全枠の座標からバウンディングボックスを生成してテレイン geometry とする
  const allCoords = targets.flatMap(f => f.coordinates);
  const lngs = allCoords.map(c => c[0]);
  const lats  = allCoords.map(c => c[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);

  // 既存テレインの場合はその geometry を再利用（または bbox で上書き）
  let terrainFeature;
  if (info.isNew) {
    terrainFeature = {
      type: 'Feature',
      id: terrainId,
      properties: {
        name: info.terrainName,
        prefecture: info.pref,
        terrain_type: 'sprint',
        terrain_subtype: null,
        description: '',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat], [minLng, maxLat]]],
      },
    };
  } else {
    // 既存テレインの情報を terrainMap から取得してそのまま出力（移植性のため）
    const existing = terrainMap.get(terrainId);
    terrainFeature = {
      type: 'Feature',
      id: terrainId,
      properties: {
        name: existing?.name ?? info.terrainName,
        prefecture: existing?.prefecture ?? info.pref,
        terrain_type: existing?.terrain_type ?? 'sprint',
        terrain_subtype: existing?.terrain_subtype ?? null,
        description: existing?.description ?? '',
      },
      geometry: existing?.geometry ?? {
        type: 'Polygon',
        coordinates: [[[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat], [minLng, maxLat]]],
      },
    };
  }

  const fc = {
    type: 'FeatureCollection',
    features: [
      // テレイン feature を先頭に含める → インポート時に terrainMap に自動登録される
      terrainFeature,
      ...targets.map(f => ({
        type: 'Feature',
        id: f.id,
        properties: { ...f.properties, terrain_id: terrainId, event_name: info.eventName, event_date: info.eventDate, scale: info.scale, map_size: info.mapSize },
        geometry: {
          type: 'Polygon',
          coordinates: [[...f.coordinates, f.coordinates[0]]],
        },
      })),
    ],
  };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const dateStr = (info.eventDate ?? '').replace(/-/g, '');
  a.download = `${dateStr}_${info.eventName}_${info.terrainName}_${info.pref}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

document.getElementById('btn-export-frames-geojson')?.addEventListener('click', exportFramesAsGeoJson);

// 「その他の地図」セクションのエクスポートボタン
// img-import-* フレームが1件以上あれば表示する
function syncImgExportBtn() {
  const btn = document.getElementById('btn-export-img-geojson');
  if (!btn) return;
  const hasImport = mapFrames.some(f => f.id.startsWith('img-import-'));
  btn.style.display = hasImport ? '' : 'none';
}
document.getElementById('btn-export-img-geojson')?.addEventListener('click', exportFramesAsGeoJson);

// ---- サムネイル生成関連 ----

// ---- OriLibre サムネイル生成（正方形） ----
const ORILIBRE_THUMB_KEY = 'orilibre-thumb';
const ORILIBRE_THUMB_SIZE = 256;
const BASEMAP_THUMB_KEYS = [
  'orilibre', 'gsi-std', 'gsi-pale', 'gsi-photo', 'osm', 'cs-1m', 'cs-0.5m'
];

function applyOriLibreThumb(dataUrl) {
  const el = document.querySelector('.bm-orilibre');
  if (!el) return;
  el.style.backgroundImage = `url("${dataUrl}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
}

function loadOriLibreThumb() {
  const dataUrl = localStorage.getItem(ORILIBRE_THUMB_KEY);
  if (dataUrl) applyOriLibreThumb(dataUrl);
}

function setBasemapCardThumb(key, dataUrl) {
  const card = document.querySelector(`#basemap-cards .bm-card[data-key="${key}"]`);
  if (!card) return;
  const img = card.querySelector('img.bm-card-img');
  if (img) {
    img.src = dataUrl;
    return;
  }
  const box = card.querySelector('.bm-card-img');
  if (!box) return;
  box.style.backgroundImage = `url("${dataUrl}")`;
  box.style.backgroundSize = 'cover';
  box.style.backgroundPosition = 'center';
}

function loadBasemapThumbs() {
  BASEMAP_THUMB_KEYS.forEach((key) => {
    const dataUrl = localStorage.getItem(`bm-thumb-${key}`);
    if (dataUrl) setBasemapCardThumb(key, dataUrl);
  });
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function waitForMapIdle(timeoutMs = 3500) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve();
    }, timeoutMs);
    map.once('idle', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function captureAllBasemapThumbs() {
  const btn = document.getElementById('btn-orilibre-thumb');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中...';
  }

  const prevBasemap = currentBasemap;
  const prevActive = document.querySelector('#basemap-cards .bm-card.active');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const canvas = map.getCanvas();
  const size = Math.min(canvas.width, canvas.height);
  const sx = Math.round((canvas.width - size) / 2);
  const sy = Math.round((canvas.height - size) / 2);

  for (const key of BASEMAP_THUMB_KEYS) {
    switchBasemap(key);
    document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
    const card = document.querySelector(`#basemap-cards .bm-card[data-key="${key}"]`);
    if (card) card.classList.add('active');

    // CS立体図は csdem:// プロトコルで TF.js GPU 演算するため1タイル0.5〜2秒かかる。
    // zoom18 で16枚以上になると4秒では足りず白くなるため、CS系は15秒に拡張。
    const idleTimeout = key.startsWith('cs-') ? 15000 : 4000;
    await waitForMapIdle(idleTimeout);
    // idle後にフレームバッファへの最終描画を確実に完了させる
    // （idleはタイルロード完了を示すが、描画はその後のrAFで行われる場合がある）
    // CS立体図はTF.js GPU演算で遅延するため特に重要
    await new Promise(r => {
      map.once('render', r);
      map.triggerRepaint();
    });

    const out = document.createElement('canvas');
    out.width = ORILIBRE_THUMB_SIZE;
    out.height = ORILIBRE_THUMB_SIZE;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, sx, sy, size, size, 0, 0, ORILIBRE_THUMB_SIZE, ORILIBRE_THUMB_SIZE);

    const dataUrl = out.toDataURL('image/png');
    setBasemapCardThumb(key, dataUrl);
    localStorage.setItem(`bm-thumb-${key}`, dataUrl);
    if (key === 'orilibre') localStorage.setItem(ORILIBRE_THUMB_KEY, dataUrl);
    downloadDataUrl(dataUrl, `basemap-${key}-${stamp}.png`);
  }

  if (prevBasemap) switchBasemap(prevBasemap);
  document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
  if (prevActive) prevActive.classList.add('active');

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'OriLibreサムネ生成';
  }
}

const btnOriLibreThumb = document.getElementById('btn-orilibre-thumb');
if (btnOriLibreThumb) btnOriLibreThumb.addEventListener('click', captureAllBasemapThumbs);

// ---- 色別標高図サムネイル生成 ----
async function captureColorReliefThumb() {
  const btn = document.getElementById('btn-color-relief-thumb');
  if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }

  // 色別標高図に切り替え
  const prevOverlay = currentOverlay;
  currentOverlay = 'color-relief';
  document.querySelectorAll('#overlay-cards .bm-card').forEach(c => {
    c.classList.toggle('active', c.dataset.key === 'color-relief');
  });
  updateCsVisibility();
  applyColorReliefTiles();

  await waitForMapIdle(5000);
  await new Promise(r => { map.once('render', r); map.triggerRepaint(); });

  const canvas = map.getCanvas();
  const size = Math.min(canvas.width, canvas.height);
  const sx = Math.round((canvas.width - size) / 2);
  const sy = Math.round((canvas.height - size) / 2);
  const out = document.createElement('canvas');
  out.width = ORILIBRE_THUMB_SIZE;
  out.height = ORILIBRE_THUMB_SIZE;
  out.getContext('2d').drawImage(canvas, sx, sy, size, size, 0, 0, ORILIBRE_THUMB_SIZE, ORILIBRE_THUMB_SIZE);

  const dataUrl = out.toDataURL('image/png');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadDataUrl(dataUrl, `color-relief-${stamp}.png`);

  // 元のオーバーレイに戻す
  currentOverlay = prevOverlay;
  document.querySelectorAll('#overlay-cards .bm-card').forEach(c => {
    c.classList.toggle('active', c.dataset.key === prevOverlay);
  });
  updateCsVisibility();
  if (prevOverlay === 'color-relief') applyColorReliefTiles();

  if (btn) { btn.disabled = false; btn.textContent = '色別標高図サムネ生成'; }
}

const btnColorReliefThumb = document.getElementById('btn-color-relief-thumb');
if (btnColorReliefThumb) btnColorReliefThumb.addEventListener('click', captureColorReliefThumb);

// ---- サムネイル生成関連ここまで ----

// ---- サイドバーナビゲーション ----
let _sidebarCurrentPanel = 'sim';
let _sidebarOpen = true;

// サイドバー幅をCSS変数に反映（検索ボックス・出典の左位置が連動する）
function updateSidebarWidth() {
  // モバイルではサイドバーは下部に配置するため幅は 0
  if (window.matchMedia('(max-width: 768px)').matches) {
    document.documentElement.style.setProperty('--sidebar-w', '0px');
    return;
  }
  const sidebar = document.getElementById('sidebar');
  const w = sidebar ? sidebar.offsetWidth : 296;
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
}

document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    const sbPanel = document.getElementById('sidebar-panel');
    if (_sidebarCurrentPanel === panel && _sidebarOpen) {
      // 同じアイコン → パネルを閉じる
      sbPanel.classList.add('sb-hidden');
      btn.classList.remove('active');
      _sidebarOpen = false;
    } else {
      sbPanel.classList.remove('sb-hidden');
      document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar-section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + panel).classList.add('active');
      _sidebarCurrentPanel = panel;
      _sidebarOpen = true;
    }
    // CSSアニメーション完了後に幅を反映
    // display:none は即時反映されるため rAF 1フレームで幅を取得可能
    requestAnimationFrame(updateSidebarWidth);
  });
});


// ---- 縮尺セレクト（現在の縮尺をリアルタイム表示 ＋ プリセット選択でズーム） ----
// CSS仕様上 1 CSS inch = 96 CSS pixel（devicePixelRatio に依存しない定数）
// MapLibre の getZoom() は CSS pixel 基準のため、物理DPIではなく CSS PPI を使う
const SCREEN_DPI = 96;

// 現在の地図ズーム・中心緯度から縮尺分母を計算する
// 計算式: 地上分解能(m/px) = 156543.034 × cos(緯度) / 2^zoom
// 縮尺分母 = 地上分解能 × DPI / 1インチ(m換算)
function calcScaleDenominator() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const groundRes = 156543.03392 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
  return Math.round(groundRes * SCREEN_DPI / 0.0254);
}

// 縮尺分母からズームレベルを計算して地図を移動するヘルパー
function zoomToScale(targetScale) {
  if (!targetScale) return;
  const center = map.getCenter();
  const targetGroundRes = targetScale * 0.0254 / SCREEN_DPI;
  const zoom = Math.log2(156543.03392 * Math.cos(center.lat * Math.PI / 180) / targetGroundRes);
  map.easeTo({ zoom, duration: 600 });
}

const selScale = document.getElementById('sel-scale');
const optCurrentScale = document.getElementById('opt-current-scale');

// 先頭オプション（現在の縮尺＋ズーム）のテキストを更新し、先頭を選択状態に戻す
function updateScaleDisplay() {
  const s = calcScaleDenominator();
  const z = map.getZoom().toFixed(1);
  optCurrentScale.textContent = `1 : ${s.toLocaleString()} (z${z})`;
  selScale.selectedIndex = 0;
}

// 地図の移動・ズームに連動してリアルタイム更新
map.on('move', updateScaleDisplay);
map.on('zoom', updateScaleDisplay);
map.once('idle', updateScaleDisplay);

// プリセット選択時 → その縮尺にズーム（map.on('move') が発火して先頭オプションに自動復帰）
selScale.addEventListener('change', () => {
  const val = parseInt(selScale.value, 10);
  if (val) zoomToScale(val);
});

map.once('idle', () => { updateSidebarWidth(); });


// スライダーの初期値をUIに反映（値を設定してからグラデーションを更新する）
sliderCs.value = CS_INITIAL_OPACITY;
updateSliderGradient(sliderCs, '#6a8fa0'); // 値変更後に再計算


sliderExaggeration.value = TERRAIN_EXAGGERATION;
valExaggeration.textContent = TERRAIN_EXAGGERATION.toFixed(1) + '×';
updateSliderGradient(sliderExaggeration, '#6a8fa0'); // 値変更後に再計算


/* ================================================================
   O-シミュレーターモード
   FPS風の操作インターフェース:
     ・左手ジョイスティック（nipplejs）で走行移動
     ・右半分スワイプでカメラ首振り（bearing / pitch）
     ・ミニマップ（右上）がヘディングアップで連動回転
   ================================================================ */

// ---- 定数 ----
const SIM_ZOOM  = 22;
const SIM_PITCH    = 80; // モバイルシム用ピッチ（低空ドローン視点）
const PC_SIM_PITCH = 80; // PCシム用ピッチ（水平に近い視点：鉛直から80°= 地平線より10°上）
// キロ5分 = 時速12km = 秒速3.333m
const SIM_MAX_SPEED_MPS = 12000 / 3600;
const SIM_MINIMAP_ZOOM  = 16;
const SIM_FLOOR_CLEARANCE_M = 4; // 地形上の最低クリアランス（メートル）

// ---- 状態変数 ----
let simActive    = false;
let simMiniMap   = null; // 第2 MapLibre インスタンス（ミニマップ）
let simJoystick  = null; // nipplejs インスタンス
let simJoyData   = { force: 0, angle: 0 }; // force: 0〜1, angle: radians
let simAnimFrame = null; // requestAnimationFrame ID
// 地形フロア用
let simTargetZoom = SIM_ZOOM; // ユーザーが希望するズームレベル（スライダー/キーで更新）

/* ----------------------------------------------------------------
   toggleSimMode: トグルボタンの onClick
   ---------------------------------------------------------------- */
function toggleSimMode() {
  if (simActive) stopSimMode();
  else           startSimMode();
}

/* ----------------------------------------------------------------
   startSimMode: シミュレーターを起動する
   ---------------------------------------------------------------- */
function startSimMode() {
  simActive = true;
  simTargetZoom = SIM_ZOOM;
  if (_updateGlobeBg) _updateGlobeBg();

  // ① 通常の地図操作を全て無効化
  map.dragPan.disable();
  map.dragRotate.disable();
  map.scrollZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disable();
  map.keyboard.disable();

  // ② カメラをシム視点へ（完了後にミニマップを初期化）
  map.easeTo({ zoom: SIM_ZOOM, pitch: SIM_PITCH, duration: 800 });

  // ④ UIを切り替え
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('unified-search').style.display = 'none';
  document.getElementById('scale-ctrl-container').style.display = 'none';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = 'none';
  document.getElementById('sim-overlay').style.display = 'flex';
  const btn = document.getElementById('sim-toggle-btn');
  btn.textContent = 'モバイルシミュレーター終了';
  btn.classList.add('sim-active');

  // ズームスライダーを SIM_ZOOM にリセット
  const zSlider = document.getElementById('sim-zoom-slider');
  zSlider.value = SIM_ZOOM;
  document.getElementById('sim-zoom-val').textContent = SIM_ZOOM;

  // ⑤ ミニマップを初期化（easeTo完了後に生成して描画崩れを防ぐ）
  setTimeout(initSimMinimap, 850);

  // ⑥ ジョイスティック初期化
  initSimJoystick();

  // ⑦ 視点操作ゾーン初期化
  initSimLookZone();

  // ⑧ 3D現在位置マーカーを追加（常時ON）
  addSimPosMarker();

  // ⑨ アニメーションループ開始
  simLoop();
}

/* ----------------------------------------------------------------
   stopSimMode: シミュレーターを終了する
   ---------------------------------------------------------------- */
function stopSimMode() {
  simActive = false;
  if (_updateGlobeBg) _updateGlobeBg();

  // ループ停止
  if (simAnimFrame) { cancelAnimationFrame(simAnimFrame); simAnimFrame = null; }

  // ジョイスティック破棄
  if (simJoystick) { simJoystick.destroy(); simJoystick = null; }
  simJoyData = { force: 0, angle: 0 };

  // ミニマップ破棄
  if (simMiniMap) { simMiniMap.remove(); simMiniMap = null; }

  // UIを元に戻す
  document.getElementById('sidebar').style.display = '';
  document.getElementById('unified-search').style.display = '';
  document.getElementById('scale-ctrl-container').style.display = '';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = '';
  document.getElementById('sim-overlay').style.display = 'none';
  const btn = document.getElementById('sim-toggle-btn');
  btn.textContent = 'モバイルシミュレーター開始';
  btn.classList.remove('sim-active');

  // 地図操作を復元
  map.dragPan.enable();
  map.dragRotate.enable();
  map.scrollZoom.enable();
  map.doubleClickZoom.enable();
  map.touchZoomRotate.enable();
  map.keyboard.enable();

  // 3D現在位置マーカーを削除
  removeSimPosMarker();

  // ピッチを戻す
  map.easeTo({ pitch: INITIAL_PITCH, duration: 600 });
}

/* ----------------------------------------------------------------
   initSimMinimap: 第2 MapLibre マップ（ミニマップ）を生成する
   背景: 地理院タイル（軽量ラスター）
   KMZ: 現在ロード済みのレイヤーを全て複製して追加
   ---------------------------------------------------------------- */
function initSimMinimap() {
  if (simMiniMap) return;

  simMiniMap = new maplibregl.Map({
    container: 'sim-minimap-map',
    style: {
      version: 8,
      sources: {
        'mini-base': {
          type: 'raster',
          tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '',
          maxzoom: 18,
        },
      },
      layers: [{ id: 'mini-base', type: 'raster', source: 'mini-base' }],
    },
    center:      map.getCenter(),
    zoom:        SIM_MINIMAP_ZOOM,
    bearing:     0, // 常に北上（回転はCSS側で担当）
    pitch:       0,
    interactive: false,
    attributionControl: false,
  });

  simMiniMap.on('load', () => {
    // KMZ画像レイヤーを全て複製してミニマップに追加
    syncKmzToMinimap();
  });
}

/* ----------------------------------------------------------------
   syncKmzToMinimap: 現在の kmzLayers を全てミニマップに追加
   ミニマップのスタイルロード後か、新規KMZ追加時に呼ぶ
   ---------------------------------------------------------------- */
function syncKmzToMinimap() {
  if (!simMiniMap || !simMiniMap.isStyleLoaded()) return;
  kmzLayers.forEach(entry => {
    // 既に追加済みならスキップ
    if (simMiniMap.getSource(entry.sourceId)) return;
    // メインマップのソーススペックを取得（url + coordinates を含む）
    const spec = map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    simMiniMap.addSource(entry.sourceId, spec);
    simMiniMap.addLayer({
      id:      entry.layerId + '-mini',
      type:    'raster',
      source:  entry.sourceId,
      paint:   { 'raster-opacity': 0.88, 'raster-fade-duration': 0 },
    });
  });
}

/* ----------------------------------------------------------------
   initSimJoystick: nipplejs 仮想ジョイスティックを生成する
   ---------------------------------------------------------------- */
function initSimJoystick() {
  if (simJoystick) { simJoystick.destroy(); simJoystick = null; }
  simJoyData = { force: 0, angle: 0 };

  simJoystick = nipplejs.create({
    zone:     document.getElementById('sim-joystick-zone'),
    mode:     'static',
    position: { left: '70px', top: '70px' },
    color:    'white',
    size:     120,
  });

  simJoystick.on('move', (evt, data) => {
    simJoyData.force = Math.min(data.force, 1.0);
    // angle.radian: 0=右, π/2=上, π=左, 3π/2=下
    simJoyData.angle = data.angle.radian;
  });

  simJoystick.on('end', () => { simJoyData.force = 0; });
}

/* ----------------------------------------------------------------
   initSimLookZone: 右半分のスワイプで bearing / pitch を操作する
   ---------------------------------------------------------------- */
function initSimLookZone() {
  const zone = document.getElementById('sim-look-zone');
  let lastX = 0, lastY = 0;

  function onTouchStart(e) {
    const t = e.touches[0];
    lastX = t.clientX;
    lastY = t.clientY;
    e.preventDefault();
  }

  function onTouchMove(e) {
    const t = e.touches[0];
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX;
    lastY = t.clientY;

    // 水平スワイプ → bearing（左右首振り）
    map.setBearing(map.getBearing() + dx * 0.35);

    // 垂直スワイプ → pitch（上下首振り, 50〜85°）
    // dy < 0（上スワイプ）= より水平に見る = pitch増加
    const newPitch = Math.max(50, Math.min(85, map.getPitch() - dy * 0.25));
    map.setPitch(newPitch);

    e.preventDefault();
  }

  // 毎回 startSim で呼ばれるのでリスナーはゾーン再生成時のみ追加
  // （stopSimMode でゾーンは非表示になるため多重登録は問題なし）
  zone.addEventListener('touchstart', onTouchStart, { passive: false });
  zone.addEventListener('touchmove',  onTouchMove,  { passive: false });
}

/* ----------------------------------------------------------------
   simLoop: アニメーションループ（毎フレーム呼ばれる）
   ① ジョイスティック入力を移動量に変換して map.setCenter()
   ② ミニマップの center 同期 + CSS rotate でヘディングアップ回転
   ---------------------------------------------------------------- */
function simLoop() {
  if (!simActive) return;

  // ── 移動 ──────────────────────────────────────────────────────
  if (simJoyData.force > 0.05) {
    const bearing    = map.getBearing();
    // nipplejs angle: 0=右/East, 90=上/North, 180=左/West, 270=下/South
    // MapLibre bearing: 0=North, 90=East → 変換: moveAngle = bearing + (90 - joystickDeg)
    const joystickDeg = simJoyData.angle * (180 / Math.PI);
    const moveAngleDeg = bearing + (90 - joystickDeg);

    // 速度: 最大 SIM_MAX_SPEED_MPS、力の割合で比例スケール
    // 距離 = 速度[m/s] × (1/60)[s] ÷ 1000 → [km]（60fps仮定）
    const distKm = (SIM_MAX_SPEED_MPS * simJoyData.force) / 60 / 1000;

    const c    = map.getCenter();
    const dest = turf.destination([c.lng, c.lat], distKm, moveAngleDeg);
    map.setCenter(dest.geometry.coordinates);
  }

  // ── ミニマップ同期 ──────────────────────────────────────────────
  if (simMiniMap) {
    simMiniMap.setCenter(map.getCenter());
    // bearing の逆回転で常に進行方向が上（ヘディングアップ）
    const b = map.getBearing();
    document.getElementById('sim-minimap-inner').style.transform =
      `rotate(${-b}deg)`;
  }

  // ── 地形フロア（setZoom のみ。setFreeCameraOptions は使用しない） ──
  enforceTerrainFloor();

  // ── 3D現在位置マーカー更新 ──
  updateSimPosMarker();

  simAnimFrame = requestAnimationFrame(simLoop);
}

/* ----------------------------------------------------------------
   focusMinimapOnSegment（将来拡張用プレースホルダー）
   コースの2点間区間がミニマップに収まるよう表示範囲を自動調整する。
   @param {[number,number]} pointA - [lng, lat] 区間始点
   @param {[number,number]} pointB - [lng, lat] 区間終点
   ---------------------------------------------------------------- */
function focusMinimapOnSegment(pointA, pointB) {
  if (!simMiniMap) return;
  const bounds = [
    [Math.min(pointA[0], pointB[0]), Math.min(pointA[1], pointB[1])],
    [Math.max(pointA[0], pointB[0]), Math.max(pointA[1], pointB[1])],
  ];
  simMiniMap.fitBounds(bounds, { padding: 30, duration: 400 });
}

// ---- トグルボタンのイベント ----
document.getElementById('sim-toggle-btn')?.addEventListener('click', toggleSimMode);


/* ================================================================
   3D 現在位置マーカー（シム中に map.getCenter() を赤点で表示）
   ================================================================ */
let simPosMarker = null; // maplibregl.Marker インスタンス

function addSimPosMarker() {
  if (simPosMarker) return;
  const el = document.createElement('div');
  el.style.cssText = `
    width: 22px; height: 22px; border-radius: 50%;
    background: #e63030;
    border: 4px solid rgba(255,255,255,0.85);
    box-shadow: 0 0 8px rgba(0,0,0,0.55);
    pointer-events: none;
  `;
  simPosMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat(map.getCenter())
    .addTo(map);
}

function removeSimPosMarker() {
  if (simPosMarker) { simPosMarker.remove(); simPosMarker = null; }
}

function updateSimPosMarker(lng, lat) {
  if (!simPosMarker) return;
  if (lng !== undefined) simPosMarker.setLngLat({ lng, lat });
  else simPosMarker.setLngLat(map.getCenter()); // モバイルシム用
}

// 読図マップ 現在位置ドット のオン/オフ
document.getElementById('chk-readmap-dot').addEventListener('change', e => {
  const d = e.target.checked ? '' : 'none';
  document.getElementById('pc-sim-readmap-dot').style.display = d;
  document.getElementById('pc-sim-readmap-arrow').style.display = d;
});



/* ================================================================
   PC O-シミュレーターモード
   Pointer Lock API + WASD + マウス視点 + Space/右クリック読図
   ================================================================ */

// ---- 状態変数 ----
let _simStartLng = null, _simStartLat = null; // クリック待ちで記録した開始座標
let _simPickingActive = false;               // クリック待ちモード中か

let pcSimActive    = false;
let pcSimAnimFrame = null;
let pcSimLastTime  = null;
let pcSimReadMap   = null;  // 読図用 MapLibre インスタンス
let pcSimReadOpen  = false; // 読図マップ表示中か

// ---- フォローカメラ用パラメータ ----
let pcPlayerLng  = null;  // プレイヤーの経度
let pcPlayerLat  = null;  // プレイヤーの緯度
let pcBearing    = 0;     // カメラの向き（deg, 北=0）
let pcPitch      = SIM_PITCH; // カメラのピッチ（deg, 0=真下 ～ 85=水平）
let pcCamDistM   = 50;    // カメラ ↔ プレイヤー間の距離（m）
const PC_CAM_DIST_MIN = 1;
const PC_CAM_DIST_MAX = 500;
let smoothedSlopeAdj  = 0;  // 地形傾斜による自動ピッチ補正（deg、ローパスフィルタ済み）
let _cachedTerrainH   = 0;  // queryTerrainElevation が null のときに使うキャッシュ値

// キー押下状態（Pointer Lock 有無に関わらず追跡）
const pcSimKeys = {
  KeyW: false, KeyA: false, KeyS: false, KeyD: false,
  ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
};

// ---- 速度スライダー ----
const pcSimSpeedSlider = document.getElementById('pc-sim-speed');
const pcSimSpeedValEl  = document.getElementById('pc-sim-speed-val');

pcSimSpeedSlider.addEventListener('input', () => {
  pcSimSpeedValEl.textContent = pcSimSpeedSlider.value + 'km/h';
  updateSliderGradient(pcSimSpeedSlider, '#1a6aab');
});
// 初期グラデーション反映
updateSliderGradient(pcSimSpeedSlider, '#1a6aab');

function getPcSimSpeedKmh() {
  return parseFloat(pcSimSpeedSlider.value) || 50;
}

/* ----------------------------------------------------------------
   PCシム開始: Pointer Lock をリクエストし、ロック成功後にループ起動
   ---------------------------------------------------------------- */
async function startPcSim() {
  const mapEl = document.getElementById('map');
  try {
    await mapEl.requestPointerLock({ unadjustedMovement: true });
  } catch (e) {
    // unadjustedMovement 非対応ブラウザはフォールバック
    try {
      await mapEl.requestPointerLock();
    } catch (e2) {
      console.warn('Pointer Lock 失敗:', e2);
    }
  }
}

/* ----------------------------------------------------------------
   Pointer Lock の変化を監視 → ロック成功時に onPcSimLocked を呼ぶ
   ---------------------------------------------------------------- */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === document.getElementById('map')) {
    if (!pcSimActive) onPcSimLocked();
  } else {
    if (pcSimActive) stopPcSim();
  }
});
document.addEventListener('pointerlockerror', (e) => {
  console.error('Pointer Lock エラー:', e);
});

/* ----------------------------------------------------------------
   onPcSimLocked: Pointer Lock 成功後の初期化処理
   ---------------------------------------------------------------- */
function onPcSimLocked() {
  pcSimActive = true;

  // ① 地図操作を全て無効化
  map.dragPan.disable();
  map.dragRotate.disable();
  map.scrollZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disable();
  map.keyboard.disable();

  // ② プレイヤー位置・カメラパラメータを初期化（クリック位置優先、なければ地図中心）
  const c    = (_simStartLng != null) ? { lng: _simStartLng, lat: _simStartLat } : map.getCenter();
  _simStartLng = null; _simStartLat = null;
  pcPlayerLng = c.lng;
  pcPlayerLat = c.lat;
  pcBearing   = map.getBearing();
  pcPitch     = PC_SIM_PITCH;
  pcCamDistM  = 100;

  // キャッシュ・ズームスムージングを現在値で初期化
  _cachedTerrainH  = map.queryTerrainElevation({ lng: pcPlayerLng, lat: pcPlayerLat }, { exaggerated: false }) ?? 0;

  // ③ カメラをプレイヤー視点へ即配置
  setCameraFromPlayer();

  // ③-b KMZ・フレーム画像を3D地面から一時非表示（Spaceキーの読図マップのみで使用）
  kmzLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', 'none');
    }
  });
  mapFrames.forEach(frame => {
    if (frame.layerId && map.getLayer(frame.layerId)) {
      map.setLayoutProperty(frame.layerId, 'visibility', 'none');
    }
  });

  // ④ UIを更新
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('unified-search').style.display = 'none';
  document.getElementById('scale-ctrl-container').style.display = 'none';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = 'none';
  const btn = document.getElementById('pc-sim-toggle-btn');
  btn.textContent = '[Esc]でシミュレーター終了';
  btn.classList.add('pc-sim-active');
  const hintOn = document.getElementById('chk-sim-hint')?.checked ?? true;
  document.getElementById('pc-sim-hint').style.display = hintOn ? 'block' : 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'block';

  addSimPosMarker();
  // 読図マップは初回 openPcReadMap() 時に遅延初期化（非表示コンテナでのWebGL失敗を防ぐ）

  // ⑤ イベントリスナー登録
  document.addEventListener('mousemove',    onPcSimMouseMove);
  document.addEventListener('mousedown',    onPcSimMouseDown);
  document.addEventListener('mouseup',      onPcSimMouseUp);
  document.addEventListener('contextmenu',  onPcSimContextMenu);

  // ⑥ ループ開始
  pcSimLastTime  = null;
  pcSimAnimFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   stopPcSim: モード終了 & 全リソースを解放
   ---------------------------------------------------------------- */
function stopPcSim() {
  pcSimActive = false;

  if (pcSimAnimFrame) { cancelAnimationFrame(pcSimAnimFrame); pcSimAnimFrame = null; }

  // 読図マップを閉じて破棄
  closePcReadMap();
  if (pcSimReadMap) { pcSimReadMap.remove(); pcSimReadMap = null; }

  removeSimPosMarker();

  // キー状態・補正値リセット
  Object.keys(pcSimKeys).forEach(k => { pcSimKeys[k] = false; });
  smoothedSlopeAdj = 0;

  // UI 復元
  document.getElementById('sidebar').style.display = '';
  document.getElementById('unified-search').style.display = '';
  document.getElementById('scale-ctrl-container').style.display = '';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = '';
  const btn = document.getElementById('pc-sim-toggle-btn');
  btn.textContent = 'PC シミュレーター開始';
  btn.classList.remove('pc-sim-active');
  document.getElementById('pc-sim-hint').style.display = 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'none';

  // KMZ・フレーム画像の表示を復元
  kmzLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
  });
  mapFrames.forEach(frame => {
    if (frame.layerId && map.getLayer(frame.layerId)) {
      map.setLayoutProperty(frame.layerId, 'visibility', 'visible');
    }
  });

  // 地図操作を復元
  map.dragPan.enable();
  map.dragRotate.enable();
  map.scrollZoom.enable();
  map.doubleClickZoom.enable();
  map.touchZoomRotate.enable();
  map.keyboard.enable();
  map.easeTo({ pitch: INITIAL_PITCH, duration: 600 });

  // イベントリスナー解除
  document.removeEventListener('mousemove',   onPcSimMouseMove);
  document.removeEventListener('mousedown',   onPcSimMouseDown);
  document.removeEventListener('mouseup',     onPcSimMouseUp);
  document.removeEventListener('contextmenu', onPcSimContextMenu);
}

/* ----------------------------------------------------------------
   enforceTerrainFloor: カメラ altitude を地形の上に保つ
   設計方針:
   - simBaseZ に頼らず fc.position.z（実際のカメラ altitude）で毎フレーム直接判定
   - サンプル範囲: カメラ eye → center → 前方 SIM_LOOKAHEAD_KM
     ※ ピッチが高いほど eye が center から遠く、後方から前方まで広くカバー
   - zoom変換: alt(z) = cameraZ * 2^(currentZoom − z) より
       floorZoom = currentZoom − log2(floorAltMerc / cameraZ)
   - zoom-out（地面回避）は即座（factor 1.0）、zoom-in（復帰）はゆっくり（0.05）
   ---------------------------------------------------------------- */
const SIM_FLOOR_SAMPLE_N = 12;   // サンプル点数（N+1 点）
const SIM_LOOKAHEAD_KM   = 0.03; // center 前方ルックアヘッド距離（30m）

/* ----------------------------------------------------------------
   setCameraFromPlayer: PCシム用フォローカメラ
   center = プレイヤー位置（MapLibre は terrain 有効時に center 座標の地形面を
   自動的に画面中央へ投影するため、前方シフトは不要）。
   cameraAlt = h + pcCamDistM * cos(pitch) で zoom を計算。
   ---------------------------------------------------------------- */
function setCameraFromPlayer() {
  if (pcPlayerLng === null) return;

  // 地形標高取得 — null（タイル未読み込み）の場合はキャッシュ維持。
  // 急降下時にカメラが後方地形にめり込まないよう、高さをスムージング更新する。
  const rawH = map.queryTerrainElevation(
    { lng: pcPlayerLng, lat: pcPlayerLat }, { exaggerated: false }
  );
  if (rawH !== null) _cachedTerrainH += (rawH - _cachedTerrainH) * 0.25;
  const h = _cachedTerrainH;

  const H       = map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pcPlayerLat * Math.PI / 180;

  let effectivePitch = Math.max(0, Math.min(map.getMaxPitch(), pcPitch + smoothedSlopeAdj));
  const pitchRad = effectivePitch * Math.PI / 180;

  // カメラの後方地上点の地形高度を取得し、カメラが後方地形にめり込まないよう保証する。
  // （pitch=80°では水平98m後方・垂直17mにカメラが位置するため、後方が上り坂だと地形貫通しやすい）
  const backDistKm = pcCamDistM * Math.sin(pitchRad) / 1000;
  const backPt = turf.destination([pcPlayerLng, pcPlayerLat], backDistKm, (pcBearing + 180) % 360);
  const backH = map.queryTerrainElevation(
    { lng: backPt.geometry.coordinates[0], lat: backPt.geometry.coordinates[1] },
    { exaggerated: false }
  ) ?? h;

  const cameraAlt = Math.max(
    h + Math.max(0.3, pcCamDistM * Math.cos(pitchRad)),
    backH + Math.max(1, Math.min(8, pcCamDistM * 0.3)) // 後方地形マージンをカメラ距離に比例させる
  );

  // zoom 計算は地形面からのカメラ相対高度（pcCamDistM * cos(pitch)）を基準にする。
  // cameraAlt（絶対標高）を使うと山岳地では数十mになり高ズームに届かなくなるため。
  const relativeAlt = Math.max(0.3, pcCamDistM * Math.cos(pitchRad));
  const targetZoom = Math.max(12, Math.min(map.getMaxZoom(), Math.log2(
    H * 2 * Math.PI * R * Math.cos(lat_rad) /
    (1024 * Math.tan(fov_rad / 2) * relativeAlt)
  )));

  map.jumpTo({
    center:  [pcPlayerLng, pcPlayerLat],
    bearing: pcBearing,
    pitch:   effectivePitch,
    zoom:    targetZoom
  });
}

function enforceTerrainFloor() {
  if (pcSimActive) return; // PCシムは setCameraFromPlayer で制御
  if (!map.getTerrain()) return;

  const center  = map.getCenter();
  const bearing = map.getBearing();
  const exag    = map.getTerrain()?.exaggeration ?? 1.0;

  const fc = map.getFreeCameraOptions();
  if (!fc?.position) return;
  const eyeLL  = fc.position.toLngLat?.() ?? center;
  const cameraZ = fc.position.z; // カメラの実際の altitude（mercator単位）

  // center 前方 SIM_LOOKAHEAD_KM の点（進行方向の地形を先読み）
  const fwdPt = turf.destination([center.lng, center.lat], SIM_LOOKAHEAD_KM, bearing);
  const fwdLL = { lng: fwdPt.geometry.coordinates[0], lat: fwdPt.geometry.coordinates[1] };

  // eye → center → fwdLL を SIM_FLOOR_SAMPLE_N+1 点でサンプリング
  // t=0: eye, t=0.75: center, t=1.0: fwdLL
  let maxElevM = 0;
  for (let i = 0; i <= SIM_FLOOR_SAMPLE_N; i++) {
    const t = i / SIM_FLOOR_SAMPLE_N;
    let lng, lat;
    if (t <= 0.75) {
      // eye → center（全サンプルの 75%）
      const s = t / 0.75;
      lng = eyeLL.lng + (center.lng - eyeLL.lng) * s;
      lat = eyeLL.lat + (center.lat - eyeLL.lat) * s;
    } else {
      // center → fwdLL（残り 25%）
      const s = (t - 0.75) / 0.25;
      lng = center.lng + (fwdLL.lng - center.lng) * s;
      lat = center.lat + (fwdLL.lat - center.lat) * s;
    }
    const e = map.queryTerrainElevation({ lng, lat }, { exaggerated: false });
    if (e !== null) maxElevM = Math.max(maxElevM, e);
  }

  // 必要なフロア altitude → mercator 単位
  const zpm          = maplibregl.MercatorCoordinate.fromLngLat([center.lng, center.lat], 1).z;
  const floorAltM    = Math.max(SIM_FLOOR_CLEARANCE_M, maxElevM * exag + SIM_FLOOR_CLEARANCE_M);
  const floorAltMerc = floorAltM * zpm;

  // 現在カメラ altitude から必要なズームを計算
  // alt(z) = cameraZ * 2^(currentZoom − z)  →  floorZoom = currentZoom − log2(floorAltMerc / cameraZ)
  const currentZoom   = map.getZoom();
  const floorZoom     = currentZoom - Math.log2(floorAltMerc / cameraZ);
  const effectiveZoom = Math.min(simTargetZoom, floorZoom);

  const diff = effectiveZoom - currentZoom;
  if (Math.abs(diff) < 0.005) return;

  // zoom-out（地面に近い）は即座に修正、zoom-in（地形を離れた後）はゆっくり戻す
  const factor = diff < 0 ? 1.0 : 0.05;
  map.setZoom(currentZoom + diff * factor);
}

/* ----------------------------------------------------------------
   pcSimLoop: rAF アニメーションループ
   ① deltaTime を使った正確な WASD 移動
   ② 矢印キーによる滑らかな bearing / pitch 変更
   ③ 読図マップ open 中はセンターと回転を更新
   ---------------------------------------------------------------- */
function pcSimLoop(timestamp) {
  if (!pcSimActive) return;

  // --- deltaTime（秒）を計算 ---
  const dt = pcSimLastTime ? Math.min((timestamp - pcSimLastTime) / 1000, 0.1) : 0.016;
  pcSimLastTime = timestamp;

  // ── WASD 移動（pcPlayerLng/Lat を直接更新） ──────────────────────
  const fwd   = (pcSimKeys.KeyW ? 1 : 0) - (pcSimKeys.KeyS ? 1 : 0);
  const right = (pcSimKeys.KeyD ? 1 : 0) - (pcSimKeys.KeyA ? 1 : 0);

  if (fwd !== 0 || right !== 0) {
    const len        = Math.sqrt(fwd * fwd + right * right);
    const distKm     = (getPcSimSpeedKmh() / 3600) * dt;
    const moveBearing = pcBearing + Math.atan2(right / len, fwd / len) * (180 / Math.PI);
    const dest = turf.destination([pcPlayerLng, pcPlayerLat], distKm, moveBearing);
    pcPlayerLng = dest.geometry.coordinates[0];
    pcPlayerLat = dest.geometry.coordinates[1];
  }

  // ── 矢印キー視点（pcBearing / pcPitch を更新） ───────────────────
  const ARROW_BEARING_RATE = 90;  // deg/s
  const ARROW_PITCH_RATE   = 60;  // deg/s

  if (pcSimKeys.ArrowLeft)  pcBearing = (pcBearing - ARROW_BEARING_RATE * dt + 360) % 360;
  if (pcSimKeys.ArrowRight) pcBearing = (pcBearing + ARROW_BEARING_RATE * dt) % 360;
  if (pcSimKeys.ArrowUp)    pcPitch   = Math.min(85, pcPitch + ARROW_PITCH_RATE * dt);
  if (pcSimKeys.ArrowDown)  pcPitch   = Math.max(0,  pcPitch - ARROW_PITCH_RATE * dt);

  // ── 地形傾斜による自動ピッチ補正 ─────────────────────────────────
  // 進行方向 25m 先との高度差からスロープ角を推定し、
  // ローパスフィルタ（時定数 1.4s）で平滑化して酔い防止
  if (map.getTerrain()) {
    const SLOPE_SAMPLE_KM = 0.025; // 25m 先をサンプリング
    const SLOPE_INFLUENCE  = 0.40; // 傾斜角の何割を補正に使うか
    const MAX_SLOPE_ADJ    = 20;   // 最大補正量（deg）
    const SMOOTH_TC        = 1.4;  // 平滑化時定数（秒）

    const elevNow = map.queryTerrainElevation(
      { lng: pcPlayerLng, lat: pcPlayerLat }, { exaggerated: false }
    ) ?? 0;
    const fwdPt = turf.destination([pcPlayerLng, pcPlayerLat], SLOPE_SAMPLE_KM, pcBearing);
    const elevFwd = map.queryTerrainElevation(
      { lng: fwdPt.geometry.coordinates[0], lat: fwdPt.geometry.coordinates[1] },
      { exaggerated: false }
    ) ?? elevNow;

    // slopeDeg: 正=上り、負=下り
    const slopeDeg = Math.atan2(elevFwd - elevNow, SLOPE_SAMPLE_KM * 1000) * (180 / Math.PI);
    const targetAdj = Math.max(-MAX_SLOPE_ADJ, Math.min(MAX_SLOPE_ADJ, slopeDeg * SLOPE_INFLUENCE));

    // ローパスフィルタ（急激な補正を抑制）
    smoothedSlopeAdj += (targetAdj - smoothedSlopeAdj) * Math.min(dt / SMOOTH_TC, 1);
  }

  // ── カメラを配置（プレイヤーを常に画面中央に） ───────────────────
  setCameraFromPlayer();

  // ── 読図マップ同期 ──────────────────────────────────────────────
  if (pcSimReadOpen && pcSimReadMap) {
    pcSimReadMap.setCenter([pcPlayerLng, pcPlayerLat]);
    document.getElementById('pc-sim-readmap-inner').style.transform =
      `rotate(${-pcBearing}deg)`;
  }

  updateSimPosMarker(pcPlayerLng, pcPlayerLat);

  pcSimAnimFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   マウスイベントハンドラ
   ---------------------------------------------------------------- */
function onPcSimMouseMove(e) {
  if (!pcSimActive || !document.pointerLockElement) return;

  const MOUSE_BEARING_SENS = 0.15; // deg/px
  const MOUSE_PITCH_SENS   = 0.10; // deg/px

  pcBearing = (pcBearing + e.movementX * MOUSE_BEARING_SENS + 360) % 360;
  // movementY < 0（マウス上移動）→ pitch 増加（より水平視点）
  pcPitch = Math.max(0, Math.min(85, pcPitch - e.movementY * MOUSE_PITCH_SENS));
}

function onPcSimMouseDown(e) {
  if (!pcSimActive) return;
  if (e.button === 2) openPcReadMap(); // 右クリック → 読図
}

function onPcSimMouseUp(e) {
  if (!pcSimActive) return;
  if (e.button === 2) closePcReadMap();
}

function onPcSimContextMenu(e) {
  if (pcSimActive) e.preventDefault(); // 右クリックメニューを抑止
}

/* ----------------------------------------------------------------
   キーボードイベントハンドラ（グローバル）
   WASD / 矢印 の押下状態を管理し、Space で読図を開閉する
   ---------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  // PC シムのキー操作
  if (e.code in pcSimKeys) {
    pcSimKeys[e.code] = true;
    if (pcSimActive) e.preventDefault();
  }
  if (pcSimActive && e.code === 'Space') {
    e.preventDefault();
    openPcReadMap();
  }
  // I/O キー：カメラ距離（PCシム中 or GPX 3D中）
  if ((pcSimActive || gpxViewMode === '3d') && (e.code === 'KeyI' || e.code === 'KeyO')) {
    e.preventDefault();
    if (pcSimActive) {
      if (e.code === 'KeyI') pcCamDistM = Math.max(PC_CAM_DIST_MIN, pcCamDistM * 0.7);
      else                   pcCamDistM = Math.min(PC_CAM_DIST_MAX, pcCamDistM * 1.4);
    } else {
      if (e.code === 'KeyI') gpxCamDistM = Math.max(GPX_CAM_DIST_MIN, gpxCamDistM * 0.7);
      else                   gpxCamDistM = Math.min(GPX_CAM_DIST_MAX, gpxCamDistM * 1.4);
    }
  }
  // GPX 3D モードの矢印キー（PC シム非アクティブ時のみ）
  if (gpxViewMode === '3d' && !pcSimActive && e.code in gpxChaseKeys) {
    gpxChaseKeys[e.code] = true;
    e.preventDefault();
  }
  // W/S キー：GPX 再生中に時間を進める/戻す（2D/3D 両モード対応、PCシム非アクティブ時）
  if (!pcSimActive && gpxTrackPoints.length > 0 && (e.code === 'KeyW' || e.code === 'KeyS')) {
    e.preventDefault();
    const SEEK_STEP = 5000; // 5秒
    if (e.code === 'KeyW') gpxCurrentTime = Math.min(gpxTotalDuration, gpxCurrentTime + SEEK_STEP);
    else                   gpxCurrentTime = Math.max(0, gpxCurrentTime - SEEK_STEP);
    const seekBar = document.getElementById('seek-bar');
    seekBar.value = gpxCurrentTime;
    updateSeekBarGradient();
    updateTimeDisplay();
    const pos = interpolateGpxPosition(gpxCurrentTime);
    if (pos) {
      _smoothedGpxBearing = pos.bearing; // W/S シーク時もスナップ
      updateGpxMarker(pos);
      updateCamera(pos, 16);
    }
  }
});

// モバイルシム：ズームスライダー操作
document.getElementById('sim-zoom-slider').addEventListener('input', function () {
  const z = parseFloat(this.value);
  simTargetZoom = z;
  map.setZoom(z);
  document.getElementById('sim-zoom-val').textContent = z.toFixed(1);
});

document.addEventListener('keyup', (e) => {
  if (e.code in pcSimKeys) pcSimKeys[e.code] = false;
  if (e.code in gpxChaseKeys) gpxChaseKeys[e.code] = false;
  if (pcSimActive && e.code === 'Space') closePcReadMap();
});

/* ----------------------------------------------------------------
   getReadmapBaseStyle: 選択された背景キーに対応する MapLibre style を返す
   ---------------------------------------------------------------- */
function getReadmapBaseStyle(bgKey) {
  // OriLibre はisomizer構築完了時のキャッシュを使用
  // （map.getStyle()はベースマップ切替後に別スタイルを返すため、キャッシュが必要）
  if (bgKey === 'orilibre') {
    return oriLibreCachedStyle ?? map.getStyle();
  }
  // KMZ選択時 → 地理院淡色を薄い下地として使用
  const tileKey = bgKey.startsWith('kmz-')
    ? 'gsi-pale'
    : (!RASTER_BASEMAPS[bgKey] ? 'gsi-std' : bgKey);

  const bm = RASTER_BASEMAPS[tileKey];
  return {
    version: 8,
    sources: {
      'pc-read-base': {
        type: 'raster',
        tiles: [bm.url],
        tileSize: 256,
        attribution: '',
        maxzoom: bm.maxzoom,
      },
    },
    layers: [{ id: 'pc-read-base', type: 'raster', source: 'pc-read-base' }],
  };
}

/* ----------------------------------------------------------------
   syncReadmapOriLibre: OriLibre読図マップに磁北線・等高線設定を同期
   initPcReadMap の load コールバック、updateMagneticNorth、
   applyContourInterval などから呼ばれる。
   ---------------------------------------------------------------- */
// 直近の磁北線 GeoJSON（読図マップへの同期用キャッシュ）
let _lastMagneticNorthData = { type: 'FeatureCollection', features: [] };

function syncReadmapOriLibre() {
  if (!pcSimReadMap || !pcSimReadMap.isStyleLoaded()) return;
  if (document.getElementById('sel-readmap-bg').value !== 'orilibre') return;

  // ── 等高線: tile URL と visibility を同期 ──────────────────────
  if (pcSimReadMap.getSource('contour-source') && lastAppliedContourInterval) {
    const newUrl = buildContourTileUrl(lastAppliedContourInterval);
    if (newUrl) pcSimReadMap.getSource('contour-source').setTiles([newUrl]);
  }
  const contourVis = chkContour.checked ? 'visible' : 'none';
  for (const id of contourLayerIds) {
    if (!pcSimReadMap.getLayer(id)) continue;
    // symbol レイヤー（数値ラベル）は常に非表示
    const vis = pcSimReadMap.getLayer(id).type === 'symbol' ? 'none' : contourVis;
    pcSimReadMap.setLayoutProperty(id, 'visibility', vis);
  }

  // ── 磁北線: ソース・レイヤーを初回追加してから GeoJSON を同期 ──
  const magnVis = chkMagneticNorth.checked ? 'visible' : 'none';
  if (!pcSimReadMap.getSource('magnetic-north')) {
    pcSimReadMap.addSource('magnetic-north', {
      type: 'geojson',
      data: _lastMagneticNorthData,
    });
    pcSimReadMap.addLayer({
      id: 'magnetic-north-layer',
      type: 'line',
      source: 'magnetic-north',
      layout: { visibility: magnVis },
      paint: {
        'line-color': '#0055cc',
        'line-width': 0.8,
        'line-opacity': 1.0,
      },
    });
  } else {
    pcSimReadMap.getSource('magnetic-north').setData(_lastMagneticNorthData);
    if (pcSimReadMap.getLayer('magnetic-north-layer')) {
      pcSimReadMap.setLayoutProperty('magnetic-north-layer', 'visibility', magnVis);
    }
  }
}

/* ----------------------------------------------------------------
   initPcReadMap: 読図用 MapLibre インスタンスを生成
   選択中の読図地図設定を反映したベースで初期化する。
   ---------------------------------------------------------------- */
function initPcReadMap() {
  if (pcSimReadMap) return;

  // 選択中の読図地図背景を取得
  const bgKey = document.getElementById('sel-readmap-bg').value;

  pcSimReadMap = new maplibregl.Map({
    container: 'pc-sim-readmap-map',
    style:       getReadmapBaseStyle(bgKey),
    center:      [pcPlayerLng ?? map.getCenter().lng, pcPlayerLat ?? map.getCenter().lat],
    zoom:        16,
    bearing:     0,
    pitch:       0,
    interactive: false,
    attributionControl: false,
  });

  pcSimReadMap.on('load', () => {
    syncKmzToPcReadMap(bgKey);
    syncReadmapOriLibre();
    // ロード完了後に rotation・resize を適用（遅延初期化の場合に必要）
    document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcBearing}deg)`;
    pcSimReadMap.resize();
  });
}

/* ----------------------------------------------------------------
   syncKmzToPcReadMap: kmzLayers を読図マップに複製
   bgKey が 'kmz-{id}' の場合は対象 KMZ のみ表示、それ以外は全 KMZ を重ねる。
   ---------------------------------------------------------------- */
function syncKmzToPcReadMap(bgKey) {
  if (!pcSimReadMap || !pcSimReadMap.isStyleLoaded()) return;
  // bgKey が省略された場合は現在の選択値を参照
  bgKey = bgKey ?? document.getElementById('sel-readmap-bg').value;

  // KMZ モードかどうかと、選択された KMZ の id を判定
  const isKmzMode   = bgKey.startsWith('kmz-');
  const selectedKmzId = isKmzMode ? parseInt(bgKey.slice(4)) : -1;

  kmzLayers.forEach(entry => {
    if (pcSimReadMap.getSource(entry.sourceId)) return;
    const spec = map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    pcSimReadMap.addSource(entry.sourceId, spec);
    pcSimReadMap.addLayer({
      id:     entry.layerId + '-pcread',
      type:   'raster',
      source: entry.sourceId,
      paint: {
        // KMZ モードは選択 KMZ のみ全表示、他は非表示。ベースマップモードは全表示。
        'raster-opacity':       isKmzMode ? (entry.id === selectedKmzId ? 1.0 : 0.0) : 0.92,
        'raster-fade-duration': 0,
      },
    });
  });
}

/* ----------------------------------------------------------------
   updateReadmapBgKmzOptions: 読図地図セレクトの KMZ オプションを同期
   KMZ 追加・削除時（renderKmzList）から呼ばれる。
   ---------------------------------------------------------------- */
function updateReadmapBgKmzOptions() {
  const sel = document.getElementById('sel-readmap-bg');
  if (!sel) return;

  const currentVal = sel.value;

  // data-kmz 属性付き option（KMZ 区切り線＋KMZ 項目）を全て削除してから再構築
  [...sel.options].filter(o => o.dataset.kmz).forEach(o => o.remove());

  if (kmzLayers.length > 0) {
    // KMZ ファイルを先頭（index=0）から順に挿入（読み込んだ地図が最上部に来るよう）
    // 区切り線（KMZ の後に配置）
    const sep = new Option('──────');
    sep.disabled = true;
    sep.dataset.kmz = '1';
    sel.insertBefore(sep, sel.options[0]);

    // KMZ ファイルを逆順で index=0 に挿入することで先頭に降順追加
    [...kmzLayers].reverse().forEach(entry => {
      const shortName = entry.name.replace(/\.kmz$/i, '');
      const opt = new Option(`🗺 ${shortName}`, `kmz-${entry.id}`);
      opt.dataset.kmz = '1';
      sel.insertBefore(opt, sel.options[0]);
    });
  }

  // 選択値を維持。削除されたKMZが選択されていた場合は 'orilibre' に戻す。
  const validVals = new Set([
    'orilibre', 'gsi-std', 'gsi-pale', 'gsi-photo', 'osm',
    ...kmzLayers.map(e => `kmz-${e.id}`),
  ]);
  sel.value = validVals.has(currentVal) ? currentVal : 'orilibre';
}

/* ----------------------------------------------------------------
   openPcReadMap / closePcReadMap: 読図マップの表示・非表示
   ---------------------------------------------------------------- */
function openPcReadMap() {
  if (pcSimReadOpen) return;
  pcSimReadOpen = true;

  const overlay = document.getElementById('pc-sim-readmap-overlay');
  overlay.classList.add('visible');

  if (!pcSimReadMap) {
    // 初回: オーバーレイが visible になってから初期化（WebGL コンテキストを正常サイズで生成）
    initPcReadMap();
    return;
  }

  pcSimReadMap.setCenter([pcPlayerLng ?? map.getCenter().lng, pcPlayerLat ?? map.getCenter().lat]);
  document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcBearing}deg)`;
  pcSimReadMap.resize();
}

function closePcReadMap() {
  if (!pcSimReadOpen) return;
  pcSimReadOpen = false;
  document.getElementById('pc-sim-readmap-overlay').classList.remove('visible');
}

// ---- 開始位置クリック待ちモード ----
function enterSimStartPicking() {
  if (_simPickingActive || pcSimActive) return;
  _simPickingActive = true;
  document.getElementById('sim-start-cursor').style.display = 'block';
  document.getElementById('sim-start-hint-overlay').style.display = 'block';
  document.addEventListener('mousemove', _onSimPickMouseMove);
  document.getElementById('map').addEventListener('click', _onSimPickClick);
  document.addEventListener('keydown', _onSimPickKeydown);
}

function exitSimStartPicking() {
  if (!_simPickingActive) return;
  _simPickingActive = false;
  document.getElementById('sim-start-cursor').style.display = 'none';
  document.getElementById('sim-start-hint-overlay').style.display = 'none';
  document.removeEventListener('mousemove', _onSimPickMouseMove);
  document.getElementById('map').removeEventListener('click', _onSimPickClick);
  document.removeEventListener('keydown', _onSimPickKeydown);
}

function _onSimPickMouseMove(e) {
  const cursor = document.getElementById('sim-start-cursor');
  cursor.style.left = e.clientX + 'px';
  cursor.style.top  = e.clientY + 'px';
}

function _onSimPickClick(e) {
  const rect  = document.getElementById('map').getBoundingClientRect();
  const lngLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
  _simStartLng = lngLat.lng;
  _simStartLat = lngLat.lat;
  exitSimStartPicking();
  startPcSim();
}

function _onSimPickKeydown(e) {
  if (e.key === 'Escape') exitSimStartPicking();
}

// ---- PCシムボタンのイベント ----
document.getElementById('pc-sim-toggle-btn').addEventListener('click', () => {
  if (pcSimActive) stopPcSim();
  else enterSimStartPicking();
});


// ---- 読図地図セレクト変更 ----
// PC シム起動中に変更した場合は読図マップを即座に再構築する。
document.getElementById('sel-readmap-bg').addEventListener('change', () => {
  if (pcSimReadMap && pcSimActive) {
    closePcReadMap();
    pcSimReadMap.remove();
    pcSimReadMap = null;
    // 次回 openPcReadMap() 時に新設定で再初期化
  }
});

// シミュレーターボタンは CSS で display:block 設定済み。JSによる上書き不要。


/* =======================================================================
   地図画像 位置合わせモーダル（基本モード）
   ======================================================================= */

// 用紙サイズ定数（mm）: [幅, 高さ] 縦置き基準
const PAPER_SIZES_MM = { A4: [210, 297], A3: [297, 420], B4: [257, 364], B3: [364, 515] };

// ---- KMZ から画像と座標を抽出して位置合わせモーダルを開く ----
// loadKmz() の①〜⑦相当の処理を行い、直接マップ追加する代わりにモーダルへ渡す
async function openImportModalFromKmz(file) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const fileNames = Object.keys(zip.files);
    const kmlFileName = fileNames.find(n => n.toLowerCase().endsWith('.kml'));
    if (!kmlFileName) { alert('KMZ内にKMLファイルが見つかりません。'); return; }

    const kmlDom = new DOMParser().parseFromString(await zip.files[kmlFileName].async('text'), 'text/xml');
    if (kmlDom.getElementsByTagName('parseerror').length > 0) { alert('KML解析エラー。'); return; }

    const kmlGet = (root, tag) => root.getElementsByTagNameNS('*', tag)[0] ?? root.getElementsByTagName(tag)[0];
    const groundOverlay = kmlGet(kmlDom, 'GroundOverlay');
    if (!groundOverlay) { alert('GroundOverlay要素が見つかりません。'); return; }

    const latLonBox = kmlGet(groundOverlay, 'LatLonBox');
    if (!latLonBox) { alert('LatLonBox要素が見つかりません。'); return; }

    const north    = parseFloat(kmlGet(latLonBox, 'north')?.textContent);
    const south    = parseFloat(kmlGet(latLonBox, 'south')?.textContent);
    const east     = parseFloat(kmlGet(latLonBox, 'east')?.textContent);
    const west     = parseFloat(kmlGet(latLonBox, 'west')?.textContent);
    const rotation = parseFloat(kmlGet(latLonBox, 'rotation')?.textContent ?? '0');
    if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) { alert('LatLonBoxの座標値が読み取れません。'); return; }

    // KMZ と同じ回転計算（loadKmz と同ロジック）
    const cx = (east + west) / 2, cy = (north + south) / 2;
    const hw = (east - west) / 2, hh = (north - south) / 2;
    const rad = rotation * Math.PI / 180, cosR = Math.cos(rad), sinR = Math.sin(rad);
    const latCos = Math.cos(cy * Math.PI / 180);
    const rotateCorner = (dx, dy) => {
      const dxs = dx * latCos;
      return [cx + (dxs * cosR - dy * sinR) / latCos, cy + (dxs * sinR + dy * cosR)];
    };
    const kmzCoords = [
      rotateCorner(-hw, +hh), rotateCorner(+hw, +hh),
      rotateCorner(+hw, -hh), rotateCorner(-hw, -hh),
    ];

    // 画像を抽出してObjectURLを生成
    const iconHref = kmlGet(kmlGet(groundOverlay, 'Icon'), 'href')?.textContent?.trim();
    if (!iconHref) { alert('Icon/hrefが見つかりません。'); return; }
    const imgEntry = zip.files[iconHref] ?? zip.files[fileNames.find(n => n.endsWith('/' + iconHref) || n === iconHref)];
    if (!imgEntry) { alert(`KMZ内に画像 "${iconHref}" が見つかりません。`); return; }

    const imgUrl = URL.createObjectURL(await imgEntry.async('blob'));

    // モーダルをKMZ座標で開く（用紙サイズ設定UIは不要なので非表示）
    openImportModalWithCoords(imgUrl, kmzCoords, file.name);
  } catch (err) {
    console.error('KMZモーダル展開エラー:', err);
    alert(`KMZの読み込みに失敗しました: ${err.message}`);
  }
}

let _previewMap      = null;  // プレビュー用 MapLibre インスタンス
let _importImgFile   = null;  // インポート中の画像 File
let _importImgUrl    = null;  // 対応する ObjectURL
let _importImgAspect = null;  // 元画像の縦横比（width / height）
let _importCoords    = null;  // 現在の4隅座標 [[lng,lat]*4] TL→TR→BR→BL
// let _importCornerMarkers = []; // 微調整モードの4隅マーカー（廃止：拡大縮小モードに統合）
// let _fineTuneActive  = false; // 微調整モード中か（廃止）
let _scaleCornerMarkers = []; // 拡大縮小モードの4隅マーカー
let _importCenter    = null;  // 中心マーカー位置 {lng, lat}（マーカードラッグで更新）
let _importBaseCoords = null; // KMZモード：ドラッグ前の基準4隅座標（回転前）

// Undo/Redo 履歴
let _importHistory = []; // undo スタック
let _importFuture  = []; // redo スタック

// RAF（アニメーションフレーム）スロットル用（ドラッグ高速化）
let _importDragRafId = null;

// 磁気偏角キャッシュ（ドラッグ中に毎回計算しないよう dragend で更新）
let _cachedImportDecl = 0;

// スケール補正
let _importScaleVal        = 100;  // 現在のスケール倍率（パーセント）
let _importBaseScaleCoords = null; // スケール100%時の4隅座標（平行移動・回転と連動して更新）

// Hitboxドラッグ（平行移動）用
let _isDraggingImage          = false;
let _dragStartLngLat          = null;
let _dragStartCoords          = null;
let _dragStartCenter          = null;
let _dragStartBaseScaleCoords = null; // 平行移動開始時の _importBaseScaleCoords
let _dragStartFixedPoints      = null; // 平行移動開始時の固定点配列
let _dragStartPendingFixedPoint = null; // 平行移動開始時の仮固定点
let _importFixedPoints         = [];   // 固定点配列 [{lng, lat}]（最大2）
let _importFixedPointMarkers   = [];   // 固定点DOM要素配列
let _importFixedPointOverlay   = null; // 固定点描画オーバーレイ
let _importPendingFixedPoint   = null; // 追加中の仮固定点 {lng, lat}
let _isSettingFixedPoint       = false; // 固定点選択待ち（クリックで仮固定点を作る）
let _isPlacingFixedPoint       = false; // 仮固定点を画像と一緒にドラッグして位置合わせ中

// ヒットボックス + 回転ハンドル初期化フラグ
let _imgInteractionInited = false;
let _imgEventsAdded       = false;
let _fixedPointOverlayEventsAdded = false;


// 背景切替: setStyle を使わず visibility 操作のみで行うため
// OriLibre 初期化時のレイヤー一覧を保存（{id, vis} 形式）
let _previewOriLibreLayers = [];

function _ensureFixedPointOverlay() {
  if (!_previewMap) return;
  const container = _previewMap.getContainer();
  if (!_importFixedPointOverlay || !_importFixedPointOverlay.isConnected) {
    const el = document.createElement('div');
    el.id = '_import-fixed-point-overlay';
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;';
    container.appendChild(el);
    _importFixedPointOverlay = el;
  }
  if (!_fixedPointOverlayEventsAdded) {
    _fixedPointOverlayEventsAdded = true;
    const onReproject = () => _positionFixedPointDom();
    _previewMap.on('move', onReproject);
    _previewMap.on('resize', onReproject);
  }
}

function _positionFixedPointDom() {
  if (!_previewMap || !_importFixedPointOverlay) return;
  _importFixedPointMarkers.forEach((el) => {
    const lng = parseFloat(el.dataset.lng || 'NaN');
    const lat = parseFloat(el.dataset.lat || 'NaN');
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const p = _previewMap.project([lng, lat]);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  });
}

function _renderFixedPointMarkers() {
  _ensureFixedPointOverlay();
  _importFixedPointMarkers.forEach(m => m.remove());
  _importFixedPointMarkers = [];
  if (!_previewMap || !_importFixedPointOverlay) return;
  _importFixedPoints.forEach((pt, i) => {
    const el = document.createElement('div');
    // pointer-events:auto でホバー・ドラッグを有効化
    el.style.cssText =
      'width:14px;height:14px;background:#e54848;border:2px solid #fff;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);position:absolute;transform:translate(-50%,-50%);' +
      'pointer-events:auto;cursor:grab;';
    const num = document.createElement('span');
    num.textContent = String(i + 1);
    num.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'font-size:9px;font-weight:bold;color:#fff;line-height:1;pointer-events:none;';
    el.appendChild(num);
    el.dataset.lng = String(pt.lng);
    el.dataset.lat = String(pt.lat);

    // ---- ドラッグで固定点を再配置 ----
    el.addEventListener('mousedown', (startEvt) => {
      startEvt.stopPropagation(); // マップの pan 開始を抑制
      startEvt.preventDefault();
      _importSaveState();
      el.style.cursor = 'grabbing';
      const idx = i; // クロージャで添字を保持
      const onMove = (e) => {
        if (!_previewMap) return;
        const rect   = _previewMap.getContainer().getBoundingClientRect();
        const lngLat = _previewMap.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        _importFixedPoints[idx] = { lng: lngLat.lng, lat: lngLat.lat };
        el.dataset.lng = String(lngLat.lng);
        el.dataset.lat = String(lngLat.lat);
        _positionFixedPointDom();
      };
      const onUp = () => {
        el.style.cursor = 'grab';
        // 固定点移動後：逆スケール変換でベース座標を再構築（画像は動かさない）
        _updateBaseScaleCoords();
        _updateFixedPointStatus();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    _importFixedPointOverlay.appendChild(el);
    _importFixedPointMarkers.push(el);
  });
  if (_importPendingFixedPoint) {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#e54848;border:2px dashed #fff;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);opacity:0.9;position:absolute;transform:translate(-50%,-50%);';
    el.dataset.lng = String(_importPendingFixedPoint.lng);
    el.dataset.lat = String(_importPendingFixedPoint.lat);
    _importFixedPointOverlay.appendChild(el);
    _importFixedPointMarkers.push(el);
  }
  _positionFixedPointDom();
}

function _updateFixedPointStatus() {
  const st = document.getElementById('import-fixed-point-status');
  const ct = document.getElementById('import-fixed-point-count');
  if (ct) ct.textContent = `${_importFixedPoints.length} / 2`;
  if (!st) return;
  if (_isPlacingFixedPoint) {
    st.textContent = '位置合わせ中: 画像をドラッグして離すと固定点を確定';
  } else if (_isSettingFixedPoint) {
    st.textContent = `点選択中: ${_importFixedPoints.length + 1}点目を地図上でクリック`;
  } else if (_importFixedPoints.length > 0) {
    st.textContent = `固定点設定済み: ${_importFixedPoints.length}点（通常平行移動は無効）`;
  } else {
    st.textContent = '待機中';
  }
  const setBtn = document.getElementById('import-fixed-point-set');
  const commitBtn = document.getElementById('import-fixed-point-commit');
  if (setBtn) {
    setBtn.classList.toggle('active', _isSettingFixedPoint || _isPlacingFixedPoint);
    setBtn.disabled = _importFixedPoints.length >= 2;
  }
  if (commitBtn) {
    commitBtn.disabled = !_importPendingFixedPoint;
  }
}

function _setFixedPointSettingMode(on) {
  _isSettingFixedPoint = !!on && _importFixedPoints.length < 2;
  if (!_isSettingFixedPoint) _isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  if (_previewMap) {
    _previewMap.getCanvas().style.cursor = _isSettingFixedPoint ? 'crosshair' : '';
  }
  _updateFixedPointStatus();
}

function _setPendingFixedPoint(lng, lat) {
  _importPendingFixedPoint = { lng, lat };
  _isSettingFixedPoint = false;
  _isPlacingFixedPoint = true;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _commitPendingFixedPoint() {
  if (!_importPendingFixedPoint || _importFixedPoints.length >= 2) return;
  _importFixedPoints.push({ ..._importPendingFixedPoint });
  _importPendingFixedPoint = null;
  _isPlacingFixedPoint = false;
  _isSettingFixedPoint = false;
  _updateBaseScaleCoords();
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _clearImportFixedPoints() {
  _importFixedPoints = [];
  _importPendingFixedPoint = null;
  _isSettingFixedPoint = false;
  _isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _getImportTransformOrigin() {
  if (_importFixedPoints.length > 0) {
    const sum = _importFixedPoints.reduce((acc, pt) => ({ lng: acc.lng + pt.lng, lat: acc.lat + pt.lat }), { lng: 0, lat: 0 });
    return [sum.lng / _importFixedPoints.length, sum.lat / _importFixedPoints.length];
  }
  if (_importCenter) return [_importCenter.lng, _importCenter.lat];
  return null;
}

function _rotateCoordsAroundPivot(coords, angleDeg, pivot) {
  const poly = turf.polygon([[...coords, coords[0]]]);
  const rot  = turf.transformRotate(poly, angleDeg, { pivot });
  return rot.geometry.coordinates[0].slice(0, 4);
}

function _recalcImportCenterFromCoords() {
  if (!_importCoords) return;
  _importCenter = {
    lng: _importCoords.reduce((s, c) => s + c[0], 0) / 4,
    lat: _importCoords.reduce((s, c) => s + c[1], 0) / 4,
  };
}

function _transformCoordsByPivotMove(startCoords, pivot, startMovePoint, currentMovePoint) {
  // MapLibre の描画座標系（WebMercator）上で相似変換することで、
  // 固定点と画像の見た目位置をズーム変更時も一致させる。
  const toMc = (lngLat) => {
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lngLat[0], lat: lngLat[1] });
    return [mc.x, mc.y];
  };
  const toLngLat = (xy) => {
    const ll = new maplibregl.MercatorCoordinate(xy[0], xy[1], 0).toLngLat();
    return [ll.lng, ll.lat];
  };

  const p  = toMc(pivot);
  const s0 = toMc(startMovePoint);
  const s1 = toMc(currentMovePoint);
  const v0 = [s0[0] - p[0], s0[1] - p[1]];
  const v1 = [s1[0] - p[0], s1[1] - p[1]];
  const len0 = Math.hypot(v0[0], v0[1]);
  const len1 = Math.hypot(v1[0], v1[1]);
  const scale = len0 > 1e-12 ? (len1 / len0) : 1;
  const a0 = Math.atan2(v0[1], v0[0]);
  const a1 = Math.atan2(v1[1], v1[0]);
  const da = a1 - a0;
  const cos = Math.cos(da);
  const sin = Math.sin(da);

  return startCoords.map((c) => {
    const q = toMc(c);
    const vx = q[0] - p[0];
    const vy = q[1] - p[1];
    const rx = (vx * cos - vy * sin) * scale;
    const ry = (vx * sin + vy * cos) * scale;
    return toLngLat([p[0] + rx, p[1] + ry]);
  });
}

function _applyPendingFixedPointPlacement(currentLngLat) {
  if (!_isPlacingFixedPoint || !_dragStartCoords || !_dragStartLngLat || !currentLngLat) return;
  const dx = currentLngLat.lng - _dragStartLngLat.lng;
  const dy = currentLngLat.lat - _dragStartLngLat.lat;
  const hasPivot = (_dragStartFixedPoints || []).length >= 1;
  if (hasPivot && _dragStartPendingFixedPoint) {
    const pivot = [_dragStartFixedPoints[0].lng, _dragStartFixedPoints[0].lat];
    const startMove = [_dragStartPendingFixedPoint.lng, _dragStartPendingFixedPoint.lat];
    const currentMove = [currentLngLat.lng, currentLngLat.lat];
    _importCoords = _transformCoordsByPivotMove(_dragStartCoords, pivot, startMove, currentMove);
    _recalcImportCenterFromCoords();
    _importFixedPoints = _dragStartFixedPoints.map(pt => ({ ...pt }));
    _importPendingFixedPoint = { lng: currentLngLat.lng, lat: currentLngLat.lat };
  } else if (_dragStartPendingFixedPoint) {
    _importCoords = _dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
    if (_dragStartBaseScaleCoords)
      _importBaseScaleCoords = _dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
    _importPendingFixedPoint = { lng: _dragStartPendingFixedPoint.lng + dx, lat: _dragStartPendingFixedPoint.lat + dy };
  }
  _updateBaseScaleCoords();
  _renderFixedPointMarkers();
}

// ---- 用紙サイズ＋縮尺 → 実世界サイズ（メートル）を計算 ----
function _calcImportSizeMm() {
  const paperKey    = document.getElementById('import-paper-size').value;
  const orientation = document.getElementById('import-orientation').value;
  let [paperWmm, paperHmm] = PAPER_SIZES_MM[paperKey] || [210, 297];
  if (orientation === 'landscape') [paperWmm, paperHmm] = [paperHmm, paperWmm];

  let effWmm = paperWmm;
  let effHmm = paperHmm;
  if (_importImgAspect && _importImgAspect > 0) {
    const paperAspect = paperWmm / paperHmm;
    if (_importImgAspect > paperAspect) {
      effWmm = paperWmm;
      effHmm = effWmm / _importImgAspect;
    } else {
      effHmm = paperHmm;
      effWmm = effHmm * _importImgAspect;
    }
  }
  return {
    paperWmm,
    paperHmm,
    effWmm,
    effHmm,
    marginXmm: Math.max(0, (paperWmm - effWmm) / 2),
    marginYmm: Math.max(0, (paperHmm - effHmm) / 2),
  };
}

function _importCalcSizeM() {
  const scaleEl    = document.getElementById('import-scale');
  const scale      = scaleEl.value === 'custom'
    ? (parseFloat(document.getElementById('import-scale-custom').value) || 10000)
    : parseInt(scaleEl.value, 10);
  const { effWmm, effHmm } = _calcImportSizeMm();
  // mm × 縮尺 ÷ 1000 = 実世界メートル
  return [effWmm / 1000 * scale, effHmm / 1000 * scale];
}

// ---- 中心座標＋サイズ(m)＋磁北補正角(deg) → 4隅 [TL,TR,BR,BL] ----
// オリエンテーリング地図は磁北が真上のため、declination 分だけ回転させる
function _importCalcCorners(lng, lat, widthM, heightM, decl) {
  const center = [lng, lat];
  const hw = widthM  / 2 / 1000; // km
  const hh = heightM / 2 / 1000; // km
  // Turf.destination: bearing は真北(0)から時計回り
  const up   = decl;       // 地図の「上」= 磁北方向
  const down = decl + 180;
  const L    = decl - 90;  // 左
  const R    = decl + 90;  // 右
  const dest = (pt, dist, bear) =>
    turf.getCoord(turf.destination(pt, dist, bear, { units: 'kilometers' }));

  const top    = dest(center, hh, up);
  const bottom = dest(center, hh, down);
  return [
    dest(top,    hw, L),  // TL
    dest(top,    hw, R),  // TR
    dest(bottom, hw, R),  // BR
    dest(bottom, hw, L),  // BL
  ];
}

// ---- 画像ソース/レイヤーを更新して再描画 ----
// 既存ソースがある場合は updateImage + triggerRepaint でドラッグ中のリアルタイム表示を実現。
// 初回のみ addSource + addLayer で生成する。
function _replaceImageSource() {
  if (!_previewMap || !_importImgUrl || !_importCoords) return;
  const src = _previewMap.getSource('_import-img');
  if (src) {
    // ドラッグ中の高速パス:
    // 画像URL再設定を伴う updateImage は高コストになりやすいため、
    // 利用可能なら setCoordinates で座標のみ更新する。
    if (typeof src.setCoordinates === 'function') {
      src.setCoordinates(_importCoords);
    } else {
      src.updateImage({ url: _importImgUrl, coordinates: _importCoords });
    }
    _previewMap.triggerRepaint();
  } else {
    // 初回: ソース・レイヤーを追加（透明度スライダーの現在値を反映）
    const initOpacity = (parseInt(document.getElementById('import-opacity')?.value ?? '70', 10)) / 100;
    _previewMap.addSource('_import-img', { type: 'image', url: _importImgUrl, coordinates: _importCoords });
    _previewMap.addLayer({ id: '_import-layer', type: 'raster', source: '_import-img', paint: { 'raster-opacity': initOpacity } });
  }
  // ヒットボックスの初期化 & 更新（ドラッグ中はスキップして軽量化）
  _initImgInteraction();
  if (!_isDraggingImage) {
    _updateHitbox();
    enterScaleMode();
  }
  // 常時有効の4隅マーカーを同期
  if (_scaleCornerMarkers.length === 4) {
    _scaleCornerMarkers.forEach((m, i) => m.setLngLat(_importCoords[i]));
  }
}

// ---- RAFスロットル付き _replaceImageSource（ドラッグ中の高速リアルタイム更新） ----
// leading-edge: 既に RAF がキューに入っていれば追加しない。
// これにより「マウス移動の最初のイベントで即時更新」が保証され、trailing-edge より遅延が少ない。
function _replaceImageSourceRaf() {
  if (_importDragRafId) return; // 既にキュー済み
  _importDragRafId = requestAnimationFrame(() => {
    _importDragRafId = null;
    _replaceImageSource();
  });
}

/* =======================================================================
   ヒットボックス（透明ポリゴン）＆ アンテナ型回転ハンドル ヘルパー群
   ======================================================================= */

// ---- _importCoords から GeoJSON ポリゴンを生成 ----
function _importCoordsToPolygon() {
  if (!_importCoords) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[..._importCoords, _importCoords[0]]] }
  };
}

// ---- スケール UI を現在の _importScaleVal に同期 ----
function _syncScaleUI() {
  const el    = document.getElementById('import-scale-adj');
  const valEl = document.getElementById('import-scale-adj-val');
  if (el)    el.value = Math.min(110, Math.max(90, _importScaleVal));
  if (valEl) valEl.textContent = _importScaleVal.toFixed(1) + '%';
  if (el) updateSliderGradient(el, '#2563eb');
}

// ---- _importBaseScaleCoords × _importScaleVal → _importCoords を再計算（Turf.js） ----
function _applyImportScale() {
  if (!_importBaseScaleCoords) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[..._importBaseScaleCoords, _importBaseScaleCoords[0]]]);
  const scaled = turf.transformScale(poly, _importScaleVal / 100, { origin });
  _importCoords = scaled.geometry.coordinates[0].slice(0, 4);
}

// ---- _importCoords の逆スケールで _importBaseScaleCoords を再構築 ----
// （4隅ドラッグ後など、coords 側が先に確定したときに呼ぶ）
function _updateBaseScaleCoords() {
  if (!_importCoords || _importScaleVal <= 0) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[..._importCoords, _importCoords[0]]]);
  const base   = turf.transformScale(poly, 100 / _importScaleVal, { origin });
  _importBaseScaleCoords = base.geometry.coordinates[0].slice(0, 4);
}

// ---- 現在の _importScaleVal を座標へ反映（画像/KMZ 両モード） ----
function _updateImportScale() {
  if (_importBaseCoords) {
    _applyKmzTransform();
  } else {
    _applyImportScale();
    _replaceImageSource();
  }
}

// ---- ヒットボックスポリゴンソースを最新座標で更新 ----
function _updateHitbox() {
  if (!_previewMap || !_importCoords) return;
  const src = _previewMap.getSource('_import-hitbox');
  if (src) src.setData(_importCoordsToPolygon());
}


// ---- 画像モード専用：キャッシュした偏角で回転のみ再計算し現在スケールを適用 ----
function _updateImportRotation() {
  if (!_importCenter || !_importImgUrl || !_previewMap) return;
  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  // 回転0°（磁北補正のみ）のベースから、指定の回転補正を適用
  const origin = _getImportTransformOrigin() ?? [_importCenter.lng, _importCenter.lat];
  const baseNoRot = _importCalcCorners(_importCenter.lng, _importCenter.lat, wM, hM, _cachedImportDecl);
  _importBaseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  // 現在のスケール倍率を適用して _importCoords を確定
  _applyImportScale();
  _replaceImageSource();
}


// ---- ヒットボックス + ドラッグ平行移動 を初期化（冪等） ----
function _initImgInteraction() {
  if (!_previewMap || !_importCoords) return;

  // --- ヒットボックスのソース・レイヤー（なければ追加） ---
  if (!_previewMap.getSource('_import-hitbox')) {
    _previewMap.addSource('_import-hitbox', { type: 'geojson', data: _importCoordsToPolygon() });
    _previewMap.addLayer({
      id: '_import-hitbox-layer', type: 'fill', source: '_import-hitbox',
      // fill-opacity: 0 だとクリックを拾えない場合があるため極小値を使用
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 }
    });
    _imgInteractionInited = true;
  }

  // --- イベントリスナーは一度だけ追加 ---
  if (!_imgEventsAdded) {
    _imgEventsAdded = true;

    // カーソル制御
    _previewMap.on('mouseenter', '_import-hitbox-layer', () => {
      if (!_isDraggingImage) {
        _previewMap.getCanvas().style.cursor = (_isSettingFixedPoint || _isPlacingFixedPoint) ? 'crosshair' : 'move';
      }
    });
    _previewMap.on('mouseleave', '_import-hitbox-layer', () => {
      if (!_isDraggingImage) _previewMap.getCanvas().style.cursor = '';
    });

    // mousedown → ドラッグ開始（hitboxレイヤー上）
    _previewMap.on('mousedown', '_import-hitbox-layer', (e) => {
      // 固定点追加モード中は、クリック保持ですぐドラッグ位置合わせに入る
      if (_isSettingFixedPoint && _importFixedPoints.length < 2) {
        e.preventDefault();
        _importSaveState();
        _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
        _isDraggingImage = true;
        _dragStartLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        _dragStartCoords = _importCoords.map(c => [...c]);
        _dragStartCenter = _importCenter ? { ..._importCenter } : null;
        _dragStartBaseScaleCoords = _importBaseScaleCoords ? _importBaseScaleCoords.map(c => [...c]) : null;
        _dragStartFixedPoints = _importFixedPoints.map(pt => ({ ...pt }));
        _dragStartPendingFixedPoint = _importPendingFixedPoint ? { ..._importPendingFixedPoint } : null;
        _previewMap.dragPan.disable();
        _previewMap.getCanvas().style.cursor = 'crosshair';
        return;
      }
      if (((_importFixedPoints.length > 0) || _isSettingFixedPoint) && !_isPlacingFixedPoint) return; // 固定点設定済み時は通常移動を無効化
      e.preventDefault();
      _importSaveState();
      _isDraggingImage = true;
      _dragStartLngLat          = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      _dragStartCoords          = _importCoords.map(c => [...c]);
      _dragStartCenter          = _importCenter          ? { ..._importCenter }          : null;
      _dragStartBaseScaleCoords = _importBaseScaleCoords ? _importBaseScaleCoords.map(c => [...c]) : null;
      _dragStartFixedPoints = _importFixedPoints.map(pt => ({ ...pt }));
      _dragStartPendingFixedPoint = _importPendingFixedPoint ? { ..._importPendingFixedPoint } : null;
      _previewMap.dragPan.disable();
      _previewMap.getCanvas().style.cursor = _isPlacingFixedPoint ? 'crosshair' : 'grabbing';
    });

    // mousemove → ドラッグ中に座標をリアルタイム更新
    _previewMap.on('mousemove', (e) => {
      if (!_isDraggingImage) return;
      const dx = e.lngLat.lng - _dragStartLngLat.lng;
      const dy = e.lngLat.lat - _dragStartLngLat.lat;
      _importCenter = _dragStartCenter
        ? { lng: _dragStartCenter.lng + dx, lat: _dragStartCenter.lat + dy }
        : null;
      if (_importBaseCoords) {
        // KMZモード: _importCenter を更新して _applyKmzTransform（RAF）
        if (_isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
        }
        if (_isPlacingFixedPoint) {
          _replaceImageSourceRaf();
        } else {
          if (_importDragRafId) cancelAnimationFrame(_importDragRafId);
          _importDragRafId = requestAnimationFrame(() => {
            _importDragRafId = null;
            _applyKmzTransform();
          });
        }
      } else {
        // 画像モード: 全隅・ベース座標を直接平行移動 → RAFで再描画
        if (_isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
        } else {
          _importCoords = _dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
          if (_dragStartBaseScaleCoords)
            _importBaseScaleCoords = _dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
        }
        _replaceImageSourceRaf();
      }
    });

    // mouseup → ドラッグ終了
    _previewMap.on('mouseup', () => {
      if (!_isDraggingImage) return;
      _isDraggingImage = false;
      _previewMap.dragPan.enable();
      _previewMap.getCanvas().style.cursor = '';
      // ドラッグ終了後: ヒットボックスを正確な位置に更新
      _updateHitbox();
      // ドラッグ終了後に磁気偏角キャッシュを更新
      if (_importCenter) {
        try { _cachedImportDecl = geomag.field(_importCenter.lat, _importCenter.lng).declination ?? 0; } catch (e) {}
      }
      if (_isPlacingFixedPoint && _importPendingFixedPoint) {
        _commitPendingFixedPoint();
      }
    });

    // 固定点設定モード: 次のクリック位置を仮固定点にする
    _previewMap.on('click', (e) => {
      if (!_isSettingFixedPoint) return;
      if (_importFixedPoints.length >= 2) return;
      _importSaveState();
      _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
      _updateFixedPointStatus();
      _replaceImageSource();
    });

  }
}

// ---- Undo/Redo：現在の座標・中心・回転値を履歴に保存 ----
function _importSaveState() {
  if (!_importCoords) return;
  _importHistory.push({
    coords : _importCoords.map(c => [...c]),
    center : _importCenter ? { ..._importCenter } : null,
    rotation: document.getElementById('import-rotation')?.value ?? '0',
    scaleVal: _importScaleVal,
    baseScaleCoords: _importBaseScaleCoords ? _importBaseScaleCoords.map(c => [...c]) : null,
    fixedPoints: _importFixedPoints.map(pt => ({ ...pt })),
  });
  _importFuture = []; // 新操作でredo履歴をクリア
}

// ---- Undo：一つ前の状態を復元 ----
function _importUndo() {
  if (_importHistory.length === 0) return;
  // 現在の状態をredo用に保存
  if (_importCoords) {
    _importFuture.push({
      coords : _importCoords.map(c => [...c]),
      center : _importCenter ? { ..._importCenter } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: _importScaleVal,
      baseScaleCoords: _importBaseScaleCoords ? _importBaseScaleCoords.map(c => [...c]) : null,
      fixedPoints: _importFixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = _importHistory.pop();
  _importRestoreState(state);
}

// ---- Redo：一つ先の状態に進む ----
function _importRedo() {
  if (_importFuture.length === 0) return;
  if (_importCoords) {
    _importHistory.push({
      coords : _importCoords.map(c => [...c]),
      center : _importCenter ? { ..._importCenter } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: _importScaleVal,
      baseScaleCoords: _importBaseScaleCoords ? _importBaseScaleCoords.map(c => [...c]) : null,
      fixedPoints: _importFixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = _importFuture.pop();
  _importRestoreState(state);
}

// ---- 状態を復元して再描画 ----
function _importRestoreState(state) {
  _importCoords = state.coords.map(c => [...c]);
  _importCenter = state.center ? { ...state.center } : null;
  _importScaleVal = Number.isFinite(state.scaleVal) ? state.scaleVal : 100;
  _importBaseScaleCoords = state.baseScaleCoords
    ? state.baseScaleCoords.map(c => [...c])
    : null;
  if (Array.isArray(state.fixedPoints)) {
    _importFixedPoints = state.fixedPoints.map(pt => ({ ...pt })).slice(0, 2);
  } else if (state.fixedPoint) {
    _importFixedPoints = [{ ...state.fixedPoint }];
  } else {
    _importFixedPoints = [];
  }
  _importPendingFixedPoint = null;
  _isSettingFixedPoint = false;
  _isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
  if (!_importBaseScaleCoords) _updateBaseScaleCoords();
  _syncScaleUI();
  const rotEl = document.getElementById('import-rotation');
  if (rotEl) {
    rotEl.value = state.rotation;
    document.getElementById('import-rotation-val').textContent =
      parseFloat(state.rotation).toFixed(2);
  }
  // 常時有効の4隅マーカーも更新
  if (_scaleCornerMarkers.length === 4) {
    _scaleCornerMarkers.forEach((m, i) => m.setLngLat(_importCoords[i]));
  }
  // 旧・微調整モード（廃止）: if (_fineTuneActive && _importCornerMarkers.length === 4) { _importCornerMarkers.forEach(...) }
  _replaceImageSource();
}

// ---- プレビューマップ上のソース/マーカーを最新設定に更新（画像モード用） ----
function _updateImportPreview() {
  if (!_previewMap || !_importImgUrl) return;

  // 中心位置：マーカーがなければマップ中心で初期化
  if (!_importCenter) {
    const mc = _previewMap.getCenter();
    _importCenter = { lng: mc.lng, lat: mc.lat };
  }
  const c = _importCenter;

  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  let decl = 0;
  try { decl = geomag.field(c.lat, c.lng).declination ?? 0; } catch (e) {}
  _cachedImportDecl = decl; // ドラッグ用キャッシュを更新
  // 用紙サイズ・縮尺変更時はスケールをリセットしてベース座標を再構築
  _importScaleVal        = 100;
  const origin = _getImportTransformOrigin() ?? [c.lng, c.lat];
  const baseNoRot = _importCalcCorners(c.lng, c.lat, wM, hM, decl);
  _importBaseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  _importCoords = _importBaseScaleCoords.map(p => [...p]);
  _syncScaleUI();

  // 初回のみ: 画像全体にフィット
  if (!_previewMap.getSource('_import-img')) {
    const lngs = _importCoords.map(p => p[0]), lats = _importCoords.map(p => p[1]);
    _previewMap.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 0 }
    );
  }

  // 画像ソース更新 → _initImgInteraction も内部で呼ばれる
  _replaceImageSource();
}

// ---- ラスター背景スタイル定義（OSM/GSI 共通ベース） ----
const _PREVIEW_RASTER_STYLE = {
  version: 8,
  sources: {
    'bg-osm':       { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],                                    tileSize: 256, attribution: '© OpenStreetMap contributors' },
    'bg-gsi-std':   { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],                          tileSize: 256, attribution: '国土地理院' },
    'bg-gsi-pale':  { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],                         tileSize: 256, attribution: '国土地理院' },
    'bg-gsi-photo': { type: 'raster', tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],                tileSize: 256, attribution: '国土地理院' },
  },
  layers: [
    { id: 'bg-osm-layer',       type: 'raster', source: 'bg-osm',       layout: { visibility: 'visible' } },
    { id: 'bg-gsi-std-layer',   type: 'raster', source: 'bg-gsi-std',   layout: { visibility: 'none' } },
    { id: 'bg-gsi-pale-layer',  type: 'raster', source: 'bg-gsi-pale',  layout: { visibility: 'none' } },
    { id: 'bg-gsi-photo-layer', type: 'raster', source: 'bg-gsi-photo', layout: { visibility: 'none' } },
  ],
};

// ---- ラスター背景のプレビューマップに等高線・磁北線を追加 ----
// OriLibre の場合は oriLibreCachedStyle に既に含まれているため不要。
function _addPreviewContourAndNorth(m) {
  // 等高線
  if (chkContour.checked && contourDemSource) {
    const iv  = getEffectiveContourInterval();
    const url = contourDemMode === 'dem5a' ? buildSeamlessContourTileUrl(iv)
              : contourDemMode === 'dem1a' ? buildDem1aContourTileUrl(iv)
              : buildContourTileUrl(iv);
    if (url) {
      m.addSource('prev-contour', { type: 'vector', tiles: [url], maxzoom: 14, attribution: '' });
      m.addLayer({ id: 'prev-contour-regular', type: 'line', source: 'prev-contour', 'source-layer': 'contours',
        filter: ['!=', ['get', 'level'], 1],
        paint: { 'line-color': '#c86400', 'line-width': 1.0, 'line-opacity': 0.85 } });
      m.addLayer({ id: 'prev-contour-index', type: 'line', source: 'prev-contour', 'source-layer': 'contours',
        filter: ['==', ['get', 'level'], 1],
        paint: { 'line-color': '#c86400', 'line-width': 1.79, 'line-opacity': 1.0 } });
    }
    // 湖水深等高線 — 廃止（2026-03-23 コメントアウト）
    // const lakeUrl = buildLakeContourTileUrl(iv);
    // if (lakeUrl && lakeContourDemSource) { ... }
  }
  // 磁北線
  if (chkMagneticNorth.checked && _lastMagneticNorthData.features.length > 0) {
    m.addSource('prev-magnetic-north', { type: 'geojson', data: _lastMagneticNorthData });
    m.addLayer({ id: 'prev-magnetic-north-layer', type: 'line', source: 'prev-magnetic-north',
      paint: { 'line-color': '#0055cc', 'line-width': 0.8, 'line-opacity': 1.0 } });
  }
}

// ---- モーダル共通初期化（previewMap生成） ----
// onLoad: マップ読み込み完了後に呼ぶコールバック
function _openImportOverlay(imgUrl, onLoad) {
  _importImgUrl           = imgUrl;
  _importCoords           = null;
  _previewOriLibreLayers  = [];
  _importCenter         = null;
  _importBaseCoords     = null;
  _importHistory        = [];
  _importFuture         = [];
  _cachedImportDecl     = 0;
  _importScaleVal       = 100;
  _importBaseScaleCoords = null;
  _clearImportFixedPoints();
  _isDraggingImage      = false;
  _imgInteractionInited = false;
  _imgEventsAdded       = false;
  // 4隅マーカーを作り直す
  _scaleCornerMarkers.forEach(m => m.remove());
  _scaleCornerMarkers = [];
  // 透明度スライダーを初期値に
  const opEl = document.getElementById('import-opacity');
  if (opEl) { opEl.value = '70'; document.getElementById('import-opacity-val').textContent = '70'; }
  const rotEl = document.getElementById('import-rotation');
  if (rotEl) { rotEl.value = '0'; document.getElementById('import-rotation-val').textContent = '0.00'; }
  _syncScaleUI();
  _updateFixedPointStatus();
  if (opEl) updateSliderGradient(opEl, '#2563eb');
  if (rotEl) updateSliderGradient(rotEl, '#2563eb');
  document.getElementById('import-overlay').classList.add('visible');

  if (_previewMap) { _previewMap.remove(); _previewMap = null; }

  // 初期背景: OriLibreが利用可能なら優先（地理院タイルより高品質）
  const bgSel = document.getElementById('import-bg-select');
  const initBg = oriLibreCachedStyle ? 'orilibre' : 'osm';
  if (bgSel) bgSel.value = initBg;

  const initStyle = (initBg === 'orilibre') ? oriLibreCachedStyle : _PREVIEW_RASTER_STYLE;

  _previewMap = new maplibregl.Map({
    container: 'import-preview-map',
    style: initStyle,
    center: map.getCenter(),
    zoom: Math.max(map.getZoom(), 12),
    pitch: 0, bearing: 0,
    attributionControl: false,
  });

  _previewMap.on('load', () => {
    if (_previewMap.getTerrain()) _previewMap.setTerrain(null);

    if (initBg === 'orilibre') {
      // OriLibre 初期化時: 全レイヤーIDと初期 visibility を記録
      _previewOriLibreLayers = _previewMap.getStyle().layers.map(l => ({
        id: l.id,
        vis: l.layout?.visibility ?? 'visible',
      }));
      // ラスター背景ソース/レイヤーを事前追加（初期非表示）
      // これにより以降の背景切替は setStyle なし visibility 操作のみで済む
      const rs = _PREVIEW_RASTER_STYLE;
      Object.entries(rs.sources).forEach(([id, src]) => {
        if (!_previewMap.getSource(id)) _previewMap.addSource(id, src);
      });
      rs.layers.forEach(l => {
        if (!_previewMap.getLayer(l.id)) {
          _previewMap.addLayer({ ...l, layout: { ...(l.layout || {}), visibility: 'none' } });
        }
      });
    } else {
      // ラスター初期化時: 等高線・磁北線を追加
      _addPreviewContourAndNorth(_previewMap);
    }

    onLoad();
  });
}

// ---- 画像縦横比から最適な用紙サイズ・向きを自動推定してUIに反映 ----
// ---- 画像ファイルから開く（用紙サイズ設定UI表示・A4デフォルト） ----
function openImportModal(imageFile) {
  _importImgFile = imageFile;
  _importImgAspect = null;
  // 画像モード: コントロールパネル全体を表示（用紙サイズ含む）
  document.getElementById('import-controls').style.display = '';
  document.getElementById('import-image-only-ctrl').style.display = '';
  // 用紙サイズはA4固定、向きは画像の縦横比から自動判断
  document.getElementById('import-paper-size').value = 'A4';
  const imgUrl = URL.createObjectURL(imageFile);
  const tmp = new Image();
  tmp.onload  = () => {
    _importImgAspect = (tmp.width > 0 && tmp.height > 0) ? (tmp.width / tmp.height) : null;
    document.getElementById('import-orientation').value = tmp.width >= tmp.height ? 'landscape' : 'portrait';
    _openImportOverlay(imgUrl, _updateImportPreview);
  };
  tmp.onerror = () => {
    _importImgAspect = null;
    document.getElementById('import-orientation').value = 'portrait';
    _openImportOverlay(imgUrl, _updateImportPreview);
  };
  tmp.src = imgUrl;
}

// ---- KMZ: 現在の _importCenter + 回転スライダーで座標を再計算 ----
function _applyKmzTransform() {
  if (!_previewMap || !_importBaseCoords || !_importCenter) return;
  const { lng: cLng, lat: cLat } = _importCenter;
  const rotDeg = parseFloat(document.getElementById('import-rotation')?.value ?? '0');

  // _importBaseCoords の重心（基準中心）を算出
  const baseLngs = _importBaseCoords.map(c => c[0]);
  const baseLats = _importBaseCoords.map(c => c[1]);
  const baseCLng = (Math.min(...baseLngs) + Math.max(...baseLngs)) / 2;
  const baseCLat = (Math.min(...baseLats) + Math.max(...baseLats)) / 2;
  const baseCtr  = turf.point([baseCLng, baseCLat]);
  const newCtr   = turf.point([cLng, cLat]);

  // 各隅を基準中心からの距離・方位で算出し、まず平行移動して新中心に配置
  const rawCoords = _importBaseCoords.map(([lng, lat]) => {
    const pt   = turf.point([lng, lat]);
    const dist = turf.distance(baseCtr, pt, { units: 'kilometers' });
    const bear = turf.bearing(baseCtr, pt);
    return turf.getCoord(turf.destination(newCtr, dist, bear, { units: 'kilometers' }));
  });
  // 回転補正は中心または固定点を軸に適用
  const origin = _getImportTransformOrigin() ?? [cLng, cLat];
  const rotatedRaw = Math.abs(rotDeg) < 1e-9
    ? rawCoords
    : _rotateCoordsAroundPivot(rawCoords, rotDeg, origin);
  // KMZ変換後のコードをスケール100%ベースとして保存し、現在スケールを適用
  _importBaseScaleCoords = rotatedRaw;
  _applyImportScale();
  _syncScaleUI();
  _replaceImageSource();
}

// ---- KMZ座標付きで開く（回転のみ表示、用紙サイズUI非表示） ----
function openImportModalWithCoords(imgUrl, coords, label) {
  _importImgFile = null;
  _importImgAspect = null;
  // KMZモード: コントロールパネルを表示し、用紙サイズ・縮尺部分は非表示
  document.getElementById('import-controls').style.display = '';
  document.getElementById('import-image-only-ctrl').style.display = 'none';

  // 中心座標をローカル変数で先に計算（クロージャで参照）
  const lats = coords.map(c => c[1]), lngs = coords.map(c => c[0]);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

  // _openImportOverlay がリセットするため、状態変数は onLoad コールバック内で初期化する
  _openImportOverlay(imgUrl, () => {
    // ここで初期化（_openImportOverlay によるリセット後に設定）
    _importBaseCoords = coords.map(c => [...c]); // 回転前の基準座標
    _importCoords     = coords.map(c => [...c]);
    _importScaleVal   = 100;
    _importBaseScaleCoords = coords.map(c => [...c]);
    _syncScaleUI();
    _importCenter     = { lng: centerLng, lat: centerLat };

    // KMZ画像全体が収まるようfitBounds（即時・アニメーションなし）
    _previewMap.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 0 }
    );

    // 画像ソース + hitbox を一括初期化
    _replaceImageSource();
  });
}

/* ---- 微調整モード（廃止：拡大縮小モードに統合）----
function enterFineTuneMode() {
  if (!_previewMap || !_importCoords) return;
  _fineTuneActive = true;
  if (_previewMap.getLayer('_import-hitbox-layer'))
    _previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'none');
  _previewMap.getCanvas().style.cursor = '';
  _importCornerMarkers = _importCoords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#ff9900;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i];
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord).addTo(_previewMap);
    marker.on('dragstart', () => { _importSaveState(); });
    marker.on('drag', () => { const ll = marker.getLngLat(); _importCoords[i] = [ll.lng, ll.lat]; _replaceImageSourceRaf(); });
    return marker;
  });
}
function exitFineTuneMode() {
  _fineTuneActive = false;
  _importCornerMarkers.forEach(m => m.remove()); _importCornerMarkers = [];
  if (_previewMap && _previewMap.getLayer('_import-hitbox-layer'))
    _previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'visible');
}
*/

// ---- 4隅マーカーを常時表示（固定点があれば固定点中心、なければ対角固定で相似拡大縮小） ----
function enterScaleMode() {
  if (!_previewMap || !_importCoords) return;
  if (_scaleCornerMarkers.length === 4) {
    _scaleCornerMarkers.forEach((m, i) => m.setLngLat(_importCoords[i]));
    return;
  }

  // 4隅にドラッグ可能なマーカーを配置
  _scaleCornerMarkers = _importCoords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#2288ff;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i] + '（ドラッグで拡大縮小）';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord)
      .addTo(_previewMap);

    // dragstart/drag 用クロージャ変数
    let fixedCoord    = null; // 固定する座標（固定点 or 対角コーナー）
    let startCoords   = null; // ドラッグ開始時の全隅座標
    let startDist     = 0;    // ドラッグ開始時のドラッグ隅→固定隅の距離
    let savedScaleVal = 100;  // ドラッグ開始時のスケール倍率

    marker.on('dragstart', () => {
      _importSaveState();
      if (_importFixedPoints.length > 0) {
        fixedCoord = _getImportTransformOrigin();
      } else {
        const oppIdx = (i + 2) % 4;                 // 対角コーナーのインデックス
        fixedCoord   = [..._importCoords[oppIdx]];  // 固定点（対角）
      }
      startCoords    = _importCoords.map(c => [...c]);
      savedScaleVal  = _importScaleVal;
      const cosLat   = Math.cos(fixedCoord[1] * Math.PI / 180);
      const dx0      = (startCoords[i][0] - fixedCoord[0]) * cosLat;
      const dy0      =  startCoords[i][1] - fixedCoord[1];
      startDist      = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    });

    marker.on('drag', () => {
      if (!fixedCoord || startDist < 1e-9) return;
      const ll     = marker.getLngLat();
      const cosLat = Math.cos(fixedCoord[1] * Math.PI / 180);
      const dx1    = (ll.lng - fixedCoord[0]) * cosLat;
      const dy1    =  ll.lat - fixedCoord[1];
      const scale  = Math.sqrt(dx1 * dx1 + dy1 * dy1) / startDist;
      // 全隅を固定点からの相似拡大縮小で再計算
      _importCoords = startCoords.map(([lng, lat]) => {
        const dx = (lng - fixedCoord[0]) * cosLat;
        const dy =  lat - fixedCoord[1];
        return [fixedCoord[0] + dx * scale / cosLat, fixedCoord[1] + dy * scale];
      });
      // 中心を4隅重心で再計算
      _importCenter = {
        lng: _importCoords.reduce((s, c) => s + c[0], 0) / 4,
        lat: _importCoords.reduce((s, c) => s + c[1], 0) / 4,
      };
      // スケール倍率を更新しUIと逆変換ベース座標を同期
      _importScaleVal = savedScaleVal * scale;
      _syncScaleUI();
      _updateBaseScaleCoords();
      // 全マーカーを最新座標に移動
      _scaleCornerMarkers.forEach((m, j) => m.setLngLat(_importCoords[j]));
      _replaceImageSourceRaf();
    });

    return marker;
  });
}

// ---- 4隅マーカー解除 ----
function exitScaleMode() {
  _scaleCornerMarkers.forEach(m => m.remove());
  _scaleCornerMarkers = [];
}

// ---- モーダルを閉じる（revokeUrl=false のとき ObjectURL を解放しない） ----
function closeImportModal(revokeUrl = true) {
  _scaleCornerMarkers.forEach(m => m.remove());
  _scaleCornerMarkers = [];
  _importFixedPointMarkers.forEach(m => m.remove());
  _importFixedPointMarkers = [];
  if (_importFixedPointOverlay && _importFixedPointOverlay.isConnected) {
    _importFixedPointOverlay.remove();
  }
  _importFixedPointOverlay = null;
  _fixedPointOverlayEventsAdded = false;
  _clearImportFixedPoints();
  // _importCornerMarkers.forEach(m => m.remove()); _importCornerMarkers = []; // 旧・微調整モード（廃止）
  // _fineTuneActive = false; // 廃止
  _isDraggingImage        = false;
  _imgInteractionInited   = false;
  _imgEventsAdded         = false;
  document.getElementById('import-overlay').classList.remove('visible');
  if (_previewMap)         { _previewMap.remove(); _previewMap = null; }
  if (revokeUrl && _importImgUrl) { URL.revokeObjectURL(_importImgUrl); }
  _importImgUrl  = null;
  _importImgFile = null;
  _importCoords  = null;
}

// ---- イベントリスナー ----


// 閉じる・キャンセル
document.getElementById('import-overlay-close-btn').addEventListener('click', () => closeImportModal());
document.getElementById('import-cancel-btn').addEventListener('click', () => closeImportModal());

// 縮尺「手入力」切り替え
document.getElementById('import-scale').addEventListener('change', (e) => {
  document.getElementById('import-scale-custom').style.display =
    e.target.value === 'custom' ? 'block' : 'none';
  _importSaveState();
  _updateImportPreview();
});

// 設定変更 → プレビュー再計算（画像モード）・状態保存
['import-paper-size', 'import-orientation'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => { _importSaveState(); _updateImportPreview(); });
});
document.getElementById('import-scale-custom').addEventListener('input', _updateImportPreview);

// 背景地図切り替え（setStyle を使わず visibility 操作のみ、画像レイヤーに触れない）
document.getElementById('import-bg-select').addEventListener('change', (e) => {
  if (!_previewMap) return;
  const val = e.target.value;
  const toOriLibre = (val === 'orilibre');
  const rasterLayerMap = {
    'osm':       'bg-osm-layer',
    'gsi-std':   'bg-gsi-std-layer',
    'gsi-pale':  'bg-gsi-pale-layer',
    'gsi-photo': 'bg-gsi-photo-layer',
  };

  // OriLibreレイヤー: 初期化時に記録した ID リストで表示/非表示を一括切り替え
  _previewOriLibreLayers.forEach(({ id, vis }) => {
    if (_previewMap.getLayer(id))
      _previewMap.setLayoutProperty(id, 'visibility', toOriLibre ? vis : 'none');
  });

  // ラスターレイヤー: 選択したものだけ表示
  Object.entries(rasterLayerMap).forEach(([key, layerId]) => {
    if (_previewMap.getLayer(layerId))
      _previewMap.setLayoutProperty(layerId, 'visibility', !toOriLibre && key === val ? 'visible' : 'none');
  });

  // 画像ソース/レイヤーには一切触れないので、読み込んだ地図画像はそのまま表示され続ける
});

// 回転スライダー → プレビュー再計算
document.getElementById('import-rotation').addEventListener('input', (e) => {
  document.getElementById('import-rotation-val').textContent = parseFloat(e.target.value).toFixed(2);
  updateSliderGradient(e.target, '#2563eb');
  // KMZモードと画像モードで処理を分岐
  if (_importBaseCoords) {
    _applyKmzTransform();
  } else {
    _updateImportRotation();
  }
});

// range操作の開始時に一度だけ状態保存（Undoを1ステップに保つ）
function _bindRangePreSave(id) {
  const el = document.getElementById(id);
  if (!el) return;
  let armed = false;
  const arm = () => {
    if (armed) return;
    _importSaveState();
    armed = true;
  };
  el.addEventListener('pointerdown', arm);
  el.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
      arm();
    }
  });
  el.addEventListener('change', () => { armed = false; });
}

// ±0.05° 微調整ボタン
function _applyRotationAdj(delta) {
  const rotEl = document.getElementById('import-rotation');
  if (!rotEl) return;
  _importSaveState(); // 変更前にundo用保存
  const newVal = Math.min(2, Math.max(-2, parseFloat(rotEl.value) + delta));
  rotEl.value = newVal;
  document.getElementById('import-rotation-val').textContent = newVal.toFixed(2);
  updateSliderGradient(rotEl, '#2563eb');
  if (_importBaseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
}
document.getElementById('import-rotation-minus').addEventListener('click', () => _applyRotationAdj(-0.05));
document.getElementById('import-rotation-plus') .addEventListener('click', () => _applyRotationAdj( 0.05));
document.getElementById('import-rotation-reset').addEventListener('click', () => {
  const rotEl = document.getElementById('import-rotation');
  if (!rotEl) return;
  _importSaveState();
  rotEl.value = '0';
  document.getElementById('import-rotation-val').textContent = '0.00';
  updateSliderGradient(rotEl, '#2563eb');
  if (_importBaseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
});

// 固定点の追加/解除
document.getElementById('import-fixed-point-set').addEventListener('click', () => {
  if (!_previewMap || !_importCoords) return;
  if (_importFixedPoints.length >= 2) return;
  _setFixedPointSettingMode(true);
  _importPendingFixedPoint = null;
  _renderFixedPointMarkers();
});
document.getElementById('import-fixed-point-commit').addEventListener('click', () => {
  if (!_importPendingFixedPoint) return;
  _importSaveState();
  _commitPendingFixedPoint();
  _updateBaseScaleCoords();
  _replaceImageSource();
});
document.getElementById('import-fixed-point-clear').addEventListener('click', () => {
  if (_importFixedPoints.length === 0 && !_importPendingFixedPoint) return;
  _importSaveState();
  _clearImportFixedPoints();
  _updateBaseScaleCoords();
  _replaceImageSource();
});

// スケール補正スライダー/微調整ボタン
document.getElementById('import-scale-adj').addEventListener('input', (e) => {
  _importScaleVal = parseFloat(e.target.value);
  _syncScaleUI();
  _updateImportScale();
});
function _applyScaleAdj(delta) {
  const scaleEl = document.getElementById('import-scale-adj');
  if (!scaleEl) return;
  _importSaveState(); // 変更前にundo用保存
  const cur = parseFloat(scaleEl.value);
  const newVal = Math.min(110, Math.max(90, cur + delta));
  _importScaleVal = newVal;
  _syncScaleUI();
  _updateImportScale();
}
document.getElementById('import-scale-adj-minus').addEventListener('click', () => _applyScaleAdj(-0.1));
document.getElementById('import-scale-adj-plus') .addEventListener('click', () => _applyScaleAdj( 0.1));
document.getElementById('import-scale-adj-reset').addEventListener('click', () => {
  _importSaveState();
  _importScaleVal = 100;
  _syncScaleUI();
  _updateImportScale();
});
_bindRangePreSave('import-rotation');
_bindRangePreSave('import-scale-adj');

document.getElementById('import-undo-btn').addEventListener('click', _importUndo);
document.getElementById('import-redo-btn').addEventListener('click', _importRedo);

// 透明度スライダー → プレビューマップのraster-opacity をリアルタイム変更
document.getElementById('import-opacity').addEventListener('input', (e) => {
  const opacity = parseInt(e.target.value, 10) / 100;
  document.getElementById('import-opacity-val').textContent = e.target.value;
  updateSliderGradient(e.target, '#2563eb');
  if (_previewMap && _previewMap.getLayer('_import-layer')) {
    _previewMap.setPaintProperty('_import-layer', 'raster-opacity', opacity);
  }
});

// Undo/Redo キーボードショートカット（モーダルが開いているときのみ有効）
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('import-overlay').classList.contains('visible')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'z' || e.key === 'Z') {
    if (e.shiftKey) {
      // Ctrl+Shift+Z → Redo
      e.preventDefault();
      _importRedo();
    } else {
      // Ctrl+Z → Undo
      e.preventDefault();
      _importUndo();
    }
  } else if (e.key === 'y' || e.key === 'Y') {
    // Ctrl+Y → Redo
    e.preventDefault();
    _importRedo();
  }
});

// 決定ボタン → メインマップにレイヤーを追加・枠を作成してモーダルを閉じる
document.getElementById('import-decide-btn').addEventListener('click', () => {
  if (!_importCoords || !_importImgUrl) return;
  const uid     = `img-import-${Date.now()}`;
  const name    = _importImgFile?.name ?? '手動配置地図';
  const keepUrl = _importImgUrl;
  _importImgUrl = null; // closeImportModal での revoke を防ぐ

  // 画像をメインマップに追加（表示）
  addImageLayerToMap(uid + '-src', uid + '-layer', keepUrl, _importCoords, OMAP_INITIAL_OPACITY);

  // kmzList UI に登録
  const lngs = _importCoords.map(c => c[0]);
  const lats  = _importCoords.map(c => c[1]);
  kmzLayers.push({
    id: kmzCounter++, name,
    sourceId: uid + '-src', layerId: uid + '-layer',
    objectUrl: keepUrl,
    visible: true, opacity: OMAP_INITIAL_OPACITY,
    bbox: { west: Math.min(...lngs), east: Math.max(...lngs),
            south: Math.min(...lats), north: Math.max(...lats) },
  });
  renderKmzList();

  // 枠を mapFrames に追加して地図上に描画
  mapFrames.push({
    id: uid,
    properties: { name },
    coordinates: _importCoords.map(c => [...c]),
    opacity: OMAP_INITIAL_OPACITY,
    images: [{ id: uid, name, url: keepUrl }],
    activeImageId: uid,
    sourceId: uid + '-src',
    layerId:  uid + '-layer',
  });
  updateFrameGeoJsonSource();
  renderFrameTree();
  syncImgExportBtn();

  closeImportModal(false);
});

// ============================================================
// モバイル ボトムシート ドラッグ制御
// touchstart / touchmove / touchend で上下にスワイプし、
// 離した位置に最も近い 3段階（min / mid / full）へスナップする。
// ============================================================
(function initBottomSheet() {
  const MQ         = window.matchMedia('(max-width: 768px)');
  const panel      = document.getElementById('sidebar-panel');
  const handle     = document.getElementById('sheet-handle');
  const miniLabel  = document.getElementById('sheet-mini-label');
  const miniStart  = document.getElementById('sheet-mini-start-btn');
  if (!panel || !handle) return;

  const NAV_H  = 54;  // ボトムナビゲーションバーの高さ (px)
  const MIN_H  = 72;  // 最小展開: ハンドル(22px) + ミニバー(50px)

  // 3段階のスナップ高さ（mid / full は画面高さに依存するため動的）
  function sh() {
    return {
      min:  MIN_H,
      mid:  Math.round(window.innerHeight * 0.50),
      full: window.innerHeight - NAV_H - 28,
    };
  }

  let snapState  = 'min';
  let dragStartY = 0;
  let dragStartH = 0;
  let dragging   = false;

  function applyHeight(h, animate) {
    panel.style.transition = animate
      ? 'height 0.32s cubic-bezier(0.4,0,0.2,1)'
      : 'none';
    panel.style.height = h + 'px';
  }

  function snapTo(state, animate = true) {
    snapState = state;
    applyHeight(sh()[state], animate);
    panel.classList.toggle('sheet-min',  state === 'min');
    panel.classList.toggle('sheet-mid',  state === 'mid');
    panel.classList.toggle('sheet-full', state === 'full');
  }

  function nearestSnap(h) {
    const s = sh();
    return [
      { k: 'min',  v: s.min  },
      { k: 'mid',  v: s.mid  },
      { k: 'full', v: s.full },
    ].reduce((a, b) => Math.abs(a.v - h) <= Math.abs(b.v - h) ? a : b).k;
  }

  // ---- タッチドラッグ ----
  handle.addEventListener('touchstart', e => {
    if (!MQ.matches) return;
    dragging   = true;
    dragStartY = e.touches[0].clientY;
    dragStartH = panel.getBoundingClientRect().height;
    panel.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    if (!dragging || !MQ.matches) return;
    const dy = dragStartY - e.touches[0].clientY;
    const s  = sh();
    panel.style.height = Math.max(s.min, Math.min(s.full, dragStartH + dy)) + 'px';
  }, { passive: true });

  handle.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    snapTo(nearestSnap(panel.getBoundingClientRect().height));
  });

  // ---- ナビボタンタップ: 開くときは mid に展開、閉じるときは min にスナップ ----
  // 注: 一般ハンドラ（3881行）が先に実行され _sidebarOpen を更新済み
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!MQ.matches) return;
      if (_sidebarOpen) {
        // パネルを開いた/切り替えた → min なら mid へ展開
        if (snapState === 'min') snapTo('mid');
      } else {
        // 同じアイコンを再タップしてパネルを閉じた → min にスワイプダウン
        snapTo('min');
      }
    });
  });

  // ---- ミニバー「開始」ボタン → シミュレーター本体ボタンに委譲 ----
  if (miniStart) {
    miniStart.addEventListener('click', () => {
      document.getElementById('pc-sim-toggle-btn')?.click();
    });
  }

  // ---- ミニバーラベル: アクティブパネル名を表示 ----
  const PANEL_NAMES = { terrain: 'テレイン', readmap: '読図地図', '3denv': '3D環境' };
  function updateMiniLabel() {
    const active = document.querySelector('.sidebar-nav-btn.active');
    const key    = active?.dataset?.panel ?? 'terrain';
    if (miniLabel) miniLabel.textContent = PANEL_NAMES[key] ?? key;
  }
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn =>
    btn.addEventListener('click', updateMiniLabel)
  );
  updateMiniLabel();

  // ---- リサイズ: スナップ高さを再計算 ----
  window.addEventListener('resize', () => {
    if (MQ.matches) snapTo(snapState, false);
  });

  // ---- デスクトップ ↔ モバイル 切り替え ----
  MQ.addEventListener('change', e => {
    if (e.matches) {
      snapTo('min', false);
    } else {
      panel.style.height     = '';
      panel.style.transition = '';
      panel.classList.remove('sheet-min', 'sheet-mid', 'sheet-full');
    }
    updateSidebarWidth();
  });

  // ---- 初期化 ----
  if (MQ.matches) snapTo('min', false);
})();


// ============================================================
// 印刷・エクスポートダイアログ
// 右上の maplibre-gl-export ボタンをクリックしたとき、
// 独自ダイアログを表示して PNG / JPEG / PDF を出力する。
// ============================================================
(function initPrintDialog() {
  // 用紙サイズ定義（縦向き基準: [width_mm, height_mm]）
  const PAPER_SIZES_MM = {
    A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210],
    B2: [515, 728], B3: [364, 515], B4: [257, 364], B5: [182, 257],
  };

  let _previewMap = null;  // プレビュー用 MapLibre インスタンス
  let _dialogOpen = false;

  const overlay        = document.getElementById('print-overlay');
  const closeBtn       = document.getElementById('print-overlay-close-btn');
  const cancelBtn      = document.getElementById('print-cancel-btn');
  const exportBtn      = document.getElementById('print-export-btn');
  const selPaper       = document.getElementById('print-paper-size');
  const selOrientation = document.getElementById('print-orientation');
  const selScale       = document.getElementById('print-scale');
  const selFormat      = document.getElementById('print-format');
  const selDpi         = document.getElementById('print-dpi');
  const infoEl         = document.getElementById('print-info');

  if (!overlay) return; // HTML が存在しない場合はスキップ

  // 向きを考慮した用紙寸法 [width_mm, height_mm] を返す
  function getPaperDim() {
    const [pw, ph] = PAPER_SIZES_MM[selPaper.value] || [210, 297];
    return selOrientation.value === 'landscape'
      ? [Math.max(pw, ph), Math.min(pw, ph)]
      : [Math.min(pw, ph), Math.max(pw, ph)];
  }

  // 指定 DPI・縮尺・緯度に対応したエクスポートズームを計算
  // 導出: 156543 × cos(lat) / 2^z = 0.0254 × scale / dpi
  function calcExportZoom(dpi, scale, lat) {
    return Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) * dpi / (0.0254 * scale));
  }

  // プレビューマップ中心から印刷範囲の GeoJSON ポリゴンを計算して更新
  function updateRectangle() {
    if (!_previewMap) return;
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = parseInt(selScale.value, 10);
    const c = _previewMap.getCenter();
    const groundW = (pw_mm / 1000) * scale;  // 印刷幅（地上m）
    const groundH = (ph_mm / 1000) * scale;  // 印刷高（地上m）
    const dLng = groundW / (111320 * Math.cos(c.lat * Math.PI / 180));
    const dLat = groundH / 110540;
    const coords = [[
      [c.lng - dLng/2, c.lat + dLat/2],
      [c.lng + dLng/2, c.lat + dLat/2],
      [c.lng + dLng/2, c.lat - dLat/2],
      [c.lng - dLng/2, c.lat - dLat/2],
      [c.lng - dLng/2, c.lat + dLat/2],
    ]];
    const src = _previewMap.getSource('print-area');
    if (src) src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: coords } }] });
  }

  // 出力サイズ情報を更新
  function updateInfo() {
    const [pw_mm, ph_mm] = getPaperDim();
    const dpi = parseInt(selDpi.value, 10);
    const scale = parseInt(selScale.value, 10);
    const outW = Math.round(pw_mm / 25.4 * dpi);
    const outH = Math.round(ph_mm / 25.4 * dpi);
    const groundW = Math.round((pw_mm / 1000) * scale);
    const groundH = Math.round((ph_mm / 1000) * scale);
    infoEl.textContent = `出力: ${outW}×${outH} px\n範囲: ${groundW}×${groundH} m`;
  }

  // ダイアログを開く
  function openDialog() {
    if (_dialogOpen) return;
    _dialogOpen = true;
    overlay.classList.add('visible');

    if (!_previewMap) {
      // 現在のスタイルを取得（地形は除去して 2D 表示）
      const rawStyle = map.getStyle();
      const previewStyle = { ...rawStyle, terrain: undefined };

      _previewMap = new maplibregl.Map({
        container: 'print-preview-map',
        style: previewStyle,
        center: map.getCenter(),
        zoom: Math.max(map.getZoom() - 1, 8),
        bearing: 0,
        pitch: 0,
        interactive: true,
        attributionControl: false,
        preserveDrawingBuffer: false,
      });

      _previewMap.on('load', () => {
        // 印刷範囲を表す GeoJSON ソース・レイヤーを追加
        _previewMap.addSource('print-area', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // 半透明の塗り
        _previewMap.addLayer({
          id: 'print-area-fill',
          type: 'fill',
          source: 'print-area',
          paint: { 'fill-color': 'rgba(255,255,255,0.08)' },
        });
        // 赤の破線枠
        _previewMap.addLayer({
          id: 'print-area-line',
          type: 'line',
          source: 'print-area',
          paint: { 'line-color': '#dd0000', 'line-width': 2, 'line-dasharray': [4, 2] },
        });
        updateRectangle();
      });

      // プレビューマップが移動するたびに矩形を再描画（常に中心に表示）
      _previewMap.on('move', updateRectangle);
    } else {
      // 再度開いたときはメインマップの中心に合わせる
      _previewMap.setCenter(map.getCenter());
      updateRectangle();
    }
    updateInfo();
  }

  // ダイアログを閉じる
  function closeDialog() {
    _dialogOpen = false;
    overlay.classList.remove('visible');
  }

  // エクスポート実行
  async function execExport() {
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = parseInt(selScale.value, 10);
    const dpi   = parseInt(selDpi.value, 10);
    const fmt   = selFormat.value;
    const outW  = Math.round(pw_mm / 25.4 * dpi);
    const outH  = Math.round(ph_mm / 25.4 * dpi);

    // 大きすぎる場合は警告
    if (outW > 8192 || outH > 8192) {
      alert(`出力サイズ ${outW}×${outH}px は大きすぎます。\nDPI または用紙サイズを小さくしてください。`);
      return;
    }

    exportBtn.disabled = true;
    exportBtn.textContent = '生成中...';
    showMapLoading();

    try {
      // エクスポート時の中心はプレビューマップの中心を使用
      const center = _previewMap ? _previewMap.getCenter() : map.getCenter();
      const zoom   = calcExportZoom(dpi, scale, center.lat);

      // 隠しコンテナを生成（画面外に配置）
      const container = document.createElement('div');
      container.style.cssText =
        `position:fixed;left:-${outW + 100}px;top:0;width:${outW}px;height:${outH}px;visibility:hidden;`;
      document.body.appendChild(container);

      // 現在のスタイルをそのまま利用（地形のみ除去して平面化）
      const rawStyle   = map.getStyle();
      const exportStyle = { ...rawStyle, terrain: undefined };

      const exportMap = new maplibregl.Map({
        container,
        style: exportStyle,
        center,
        zoom,
        bearing: map.getBearing(),
        pitch: 0,
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0,
      });

      // タイル読み込み完了（idle）を最大30秒待機
      await new Promise((resolve) => {
        exportMap.once('idle', resolve);
        setTimeout(resolve, 30000);
      });

      // マップ canvas → 出力 canvas（DPR 補正）
      const srcCanvas = exportMap.getCanvas();
      const outCanvas = document.createElement('canvas');
      outCanvas.width  = outW;
      outCanvas.height = outH;
      outCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, outW, outH);

      exportMap.remove();
      container.remove();

      const mimeType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
      const dataURL  = outCanvas.toDataURL(mimeType, 0.92);

      if (fmt === 'pdf') {
        await exportAsPdf(dataURL, pw_mm, ph_mm);
      } else {
        const a = document.createElement('a');
        a.href = dataURL;
        a.download = `map_export.${fmt}`;
        a.click();
      }
    } catch (e) {
      console.error('エクスポートエラー:', e);
      alert('エクスポートに失敗しました:\n' + e.message);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'エクスポート';
      hideMapLoading();
    }
  }

  // jsPDF を使って PDF に変換してダウンロード
  async function exportAsPdf(dataURL, pw_mm, ph_mm) {
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('jsPDF の読み込みに失敗しました'));
        document.head.appendChild(s);
      });
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: pw_mm > ph_mm ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [pw_mm, ph_mm],
    });
    doc.addImage(dataURL, 'PNG', 0, 0, pw_mm, ph_mm);
    doc.save('map_export.pdf');
  }

  // maplibre-gl-export のボタンクリックを横取りして独自ダイアログを表示
  // capture フェーズで先にイベントを捕捉し、ライブラリの動作を抑制する
  map.once('idle', () => {
    // maplibre-gl-export はボタン自体に class="maplibregl-export-control" を付与する
    const tryIntercept = () => {
      const btn = document.querySelector('.maplibregl-export-control');
      if (btn) {
        // capture フェーズで先に捕捉してライブラリのクリックハンドラを抑制
        btn.addEventListener('click', (e) => {
          e.stopImmediatePropagation();
          e.stopPropagation();
          e.preventDefault();
          openDialog();
        }, true);
      } else {
        setTimeout(tryIntercept, 200);
      }
    };
    tryIntercept();
  });

  // コントロール変更時の更新
  [selPaper, selOrientation, selScale].forEach(el => {
    el.addEventListener('change', updateRectangle);
  });
  [selPaper, selOrientation, selScale, selDpi].forEach(el => {
    el.addEventListener('change', updateInfo);
  });

  // ダイアログ操作イベント
  closeBtn.addEventListener('click', closeDialog);
  cancelBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
  exportBtn.addEventListener('click', execExport);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _dialogOpen) closeDialog();
  });

  // 初期情報表示
  updateInfo();
})();


// ============================================================
// 開発用テーマカラーピッカー
// メインカラーを選ぶと他の変数を自動導出して :root に即時反映
// ============================================================
(function initDevColorPicker() {
  const picker  = document.getElementById('dev-primary-color');
  const label   = document.getElementById('dev-color-label');
  const copyBtn = document.getElementById('dev-color-copy');
  if (!picker) return;

  // hex → [h(0-360), s(0-100), l(0-100)]
  function hexToHsl(hex) {
    let r = parseInt(hex.slice(1,3),16)/255;
    let g = parseInt(hex.slice(3,5),16)/255;
    let b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h=0, s=0, l=(max+min)/2;
    if (max !== min) {
      const d = max-min;
      s = l>0.5 ? d/(2-max-min) : d/(max+min);
      switch(max){
        case r: h=((g-b)/d+(g<b?6:0))/6; break;
        case g: h=((b-r)/d+2)/6; break;
        case b: h=((r-g)/d+4)/6; break;
      }
    }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }

  // [h,s,l] → hex
  function hslToHex(h,s,l) {
    s=Math.max(0,Math.min(100,s))/100;
    l=Math.max(0,Math.min(100,l))/100;
    const a=s*Math.min(l,1-l);
    const f=n=>{ const k=(n+h/30)%12; return Math.round(255*(l-a*Math.max(Math.min(k-3,9-k,1),-1))).toString(16).padStart(2,'0'); };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  // hex → rgba文字列
  function hexToRgba(hex, a) {
    const r=parseInt(hex.slice(1,3),16);
    const g=parseInt(hex.slice(3,5),16);
    const b=parseInt(hex.slice(5,7),16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function applyTheme(hex) {
    const [h,s,l] = hexToHsl(hex);
    const root = document.documentElement;
    const hover = hslToHex(h, s, l-10);
    const dark  = hslToHex(h, s, l-20);
    const light = hslToHex(h, Math.max(0,s-40), Math.min(97,l+38));
    root.style.setProperty('--primary',       hex);
    root.style.setProperty('--primary-hover', hover);
    root.style.setProperty('--primary-dark',  dark);
    root.style.setProperty('--primary-light', light);
    root.style.setProperty('--primary-alpha', hexToRgba(hex, 0.12));
    label.textContent = hex;
    label.style.color = hex;
    // スライダーのグラデーションを再描画
    document.querySelectorAll('input[type="range"]').forEach(el => {
      const pct = ((el.value - el.min) / (el.max - el.min) * 100).toFixed(1);
      el.style.background = `linear-gradient(to right, ${hex} ${pct}%, #d0d0d0 ${pct}%)`;
    });
  }

  picker.addEventListener('input', () => applyTheme(picker.value));

  // ---- 文字色トグル（白⇔黒） ----
  const onCheck = document.getElementById('dev-on-primary-check');
  const onKnob  = document.getElementById('dev-on-primary-knob');
  if (onCheck && onKnob) {
    function applyOnPrimary(isDark) {
      const root = document.documentElement;
      if (isDark) {
        root.style.setProperty('--on-primary',       '#111111');
        root.style.setProperty('--on-primary-muted', 'rgba(0,0,0,0.60)');
        onKnob.textContent = '⚫黒';
      } else {
        root.style.setProperty('--on-primary',       '#ffffff');
        root.style.setProperty('--on-primary-muted', 'rgba(255,255,255,0.65)');
        onKnob.textContent = '⚪白';
      }
    }
    onCheck.addEventListener('change', () => applyOnPrimary(onCheck.checked));
  }

  copyBtn.addEventListener('click', () => {
    const [h,s,l] = hexToHsl(picker.value);
    const onPrimary = (onCheck?.checked) ? '#111111' : '#ffffff';
    const onMuted   = (onCheck?.checked) ? 'rgba(0,0,0,0.60)' : 'rgba(255,255,255,0.65)';
    const css = [
      `--primary:            ${picker.value};`,
      `--primary-hover:      ${hslToHex(h,s,l-10)};`,
      `--primary-dark:       ${hslToHex(h,s,l-20)};`,
      `--primary-light:      ${hslToHex(h,Math.max(0,s-40),Math.min(97,l+38))};`,
      `--primary-alpha:      ${hexToRgba(picker.value,0.12)};`,
      `--on-primary:         ${onPrimary};`,
      `--on-primary-muted:   ${onMuted};`,
    ].join('\n');
    navigator.clipboard.writeText(css).then(() => {
      copyBtn.textContent = '✓ copied';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    });
  });
})();

/* ================================================================
   地図右クリック → Google マップで開くメニュー
   ================================================================ */
(function () {
  const menu   = document.getElementById('map-context-menu');
  const anchor = document.getElementById('ctx-open-googlemap');
  if (!menu || !anchor) return;

  // MapLibre の contextmenu イベント（右クリック位置の lngLat を取得）
  map.on('contextmenu', (e) => {
    if (pcSimActive) return; // PCシム中は無効
    const { lng, lat } = e.lngLat;
    const z = Math.round(map.getZoom());
    anchor.href = `https://www.google.com/maps/@${lat.toFixed(6)},${lng.toFixed(6)},${z}z`;
    menu.style.left = `${e.originalEvent.clientX}px`;
    menu.style.top  = `${e.originalEvent.clientY}px`;
    menu.style.display = 'block';
    e.preventDefault();
  });

  // メニュー外クリック・地図ドラッグで閉じる
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  document.addEventListener('contextmenu', (ev) => {
    if (!ev.target.closest('#map-context-menu')) menu.style.display = 'none';
  });
  map.on('movestart', () => { menu.style.display = 'none'; });
})();

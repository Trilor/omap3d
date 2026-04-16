/* ================================================================
   app.js — アプリケーション本体（地図初期化・KMZ・GPX・UI）
   ================================================================

   【モジュール構成】
     config.js       定数・URL・初期値
     protocols.js    gsjdem:// / dem2cs:// / dem2relief:// / dem2curve:// プロトコル登録
     contours.js     等高線・DEM レイヤー管理（本ファイルからインポート）

   【本ファイルの内容（論理セクション）】
     §1  Import
     §2  マップ初期化・コントロール追加
     §3  map.on('load') ハンドラ
           ① ラスターベースマップ ソース/レイヤー
           ② 等高線 DemSource 初期化
           ③ isomizer（OriLibre ベクタースタイル）
           ④ CS 立体図・色別標高図・磁北線ソース/レイヤー
           ⑤ テレインマスタ自動読み込み（autoLoadTerrains）
     §4  KMZ 読み込み・レイヤー管理（loadKmz / renderLocalMapList）
     §5  JGW + 画像（worldfile 位置合わせ）
     §6  フレーム / テレイン境界（GeoJSON・mapFrames・terrainMap）
     §7  Miller Columns UI（地図インポートタブ）
     §8  GPX 再生（loadGpx・gpxAnimationLoop・カメラ制御）
     §9  UI イベントハンドラ（ファイル選択・D&D・スライダー等）
     §10 出典（Attribution）動的管理
     §11 ベースマップ切り替え（switchBasemap）
     §12 CS 立体図・色別標高図・ベースマップカード
     §13 等高線 UI イベント（間隔・DEMソース切り替え）
     §14 3D ビル（PLATEAU LOD1/LOD2）
     §15 PCシミュレーター（pcSim）
     §16 地図インポートモーダル（画像 + 縮尺/回転）
     §17 プレビューマップ生成
     §18 その他 UI（カラーピッカー・右クリックメニュー）

   ================================================================ */

import { getDeclination, setDeclinationModel } from './magneticDeclination.js';
import { initCoursePlanner, setMapLayersGetter, setCourseMapVisible, getCoursesSummary, createCourseForTerrain, setActiveCourse, setCourseTerrainId, createEvent, loadEvent, loadCourseSet, getActiveEventId, getActiveCourseSetId, showAllControlsTab, deleteEvent, deleteCourseSet, createCourseSet, moveCourseSet, getActiveEventName, addCourseToActiveEvent, deleteCourseById, renameEvent, renameCourseSet, renameCourse, migrateCourseSets, flushSave } from './course.js';
import {
  saveMapLayer, getAllMapLayers, deleteMapLayer,
  updateMapLayerState, clearAllMapLayers, estimateStorageUsage,
} from './mapImageDb.js';
import {
  generateSlopeDataTile, generateReliefDataTile, generateCurveDataTile,
  SLOPE_DATA_MIN, SLOPE_DATA_MAX, RELIEF_DATA_MIN, RELIEF_DATA_MAX, CURVE_DATA_MIN, CURVE_DATA_MAX,
} from './protocols.js';
import {
  QCHIZU_DEM_BASE, QCHIZU_PROXY_BASE, DEM5A_BASE, DEM1A_BASE,
  // LAKEDEPTH_BASE, LAKEDEPTH_STANDARD_BASE, // 湖水深タイルは廃止（2026-03-23）
  TERRAIN_URL, CS_RELIEF_URL,
  REGIONAL_CS_LAYERS, REGIONAL_RRIM_LAYERS,
  REGIONAL_RELIEF_LAYERS, REGIONAL_SLOPE_LAYERS, REGIONAL_CURVE_LAYERS,
  INITIAL_CENTER, INITIAL_ZOOM, INITIAL_PITCH, INITIAL_BEARING,
  TERRAIN_EXAGGERATION, OMAP_INITIAL_OPACITY, CS_INITIAL_OPACITY,
  EASE_DURATION, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR, SIDEBAR_DEFAULT_WIDTH,
  BASEMAPS,
  DEVICE_PPI_DATA, DEFAULT_DEVICE_PPI,
  RELIEF_PALETTES,
} from './config.js';

import {
  contourState,
  contourLayerIds, DEM5A_CONTOUR_LAYER_IDS, DEM1A_CONTOUR_LAYER_IDS,
  COLOR_CONTOUR_Q_IDS, COLOR_CONTOUR_DEM5A_IDS, COLOR_CONTOUR_DEM1A_IDS,
  setAllContourVisibility, buildColorContourExpr, buildContourThresholds,
  buildContourTileUrl, buildSeamlessContourTileUrl, buildDem1aContourTileUrl,
} from './contours.js';

import {
  searchTerrainsApi,
  initTerrainLayers,
  updateSearchTerrainSource,
  updateWorkspaceTerrainSource,
  setHoverTerrain,
} from './terrain-search.js';

import {
  getWsTerrains, getWsTerrain, saveWsTerrain, deleteWsTerrain, updateWsTerrainVisibility,
  getWsEvents, getCoursesByEvent,
  saveWsMapSheet, getMapSheetsByEvent, getWsMapSheet, deleteWsMapSheet,
  getCourseSetsForEvent, getCourseSetsForTerrain, getWsCourseSet, saveWsCourseSet,
  getCoursesBySet,
} from './workspace-db.js';


// ベースマップ切替の状態管理
// oriLibreLayers: isomizer が追加したレイヤーを [{ id, defaultVisibility }] 形式で保持
let oriLibreLayers = [];
let currentBasemap = 'orilibre';
let oriLibreCachedStyle = null; // isomizer構築完了後のスタイルをキャッシュ（読図マップ用）
let _globeBgEl = null;
let _updateGlobeBg = null;

// ---- 初期化順の影響を受ける共有状態（早期宣言） ----
// map.on('load') 内や関数参照がファイル後半の宣言より先に走っても TDZ で落ちないようにする。
var userContourInterval = 5;
var lastAppliedContourInterval = null;
var _plateauCurrentLod = null;
var _plateauCurrentDatasetSignature = '';
var _plateauCurrentGeoidSignature = '';
var selMagneticCombined = null;
var selMagneticModel = null;
var selMagneticColor = null;

/*
  ========================================================
  MapLibre GL JS マップの初期化
  new maplibregl.Map() でマップオブジェクトを生成します。
  style はベースマップと DEM ソースだけを持つ最小構成で定義します。
  KMZ から読み込んだ画像レイヤーは後から動的に追加します。
  ========================================================
*/
let _restoredFromStorage = false; // localStorageから位置を復元した場合true（OriLibreのjumpTo抑制用）

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
        maxzoom: 15, // DEM5A の上限（z15タイルを z16+ で MapLibre がオーバーズーム）
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

  // デフォルト値（後続のスプレッドで上書きされる）
  center: INITIAL_CENTER,
  zoom: INITIAL_ZOOM,
  pitch: INITIAL_PITCH,
  bearing: INITIAL_BEARING,
  // URLハッシュがない場合は localStorage の最終状態を復元（後に書くことで上書き優先）
  ...((() => {
    const _LS_KEY = 'teledrop-map-state';
    if (!location.hash) {
      try {
        const s = JSON.parse(localStorage.getItem(_LS_KEY));
        if (s) {
          _restoredFromStorage = true;
          return { center: [s.lng, s.lat], zoom: s.zoom, pitch: s.pitch, bearing: s.bearing };
        }
      } catch {}
    }
    return {};
  })()),
  minZoom: 0,
  maxZoom: 24,
  maxPitch: 85,
  locale: {
    'NavigationControl.ZoomIn':           'ズームイン',
    'NavigationControl.ZoomOut':          'ズームアウト',
    'NavigationControl.ResetBearing':     '真北を上にする',
    'FullscreenControl.Enter':            '全画面表示',
    'FullscreenControl.Exit':             '全画面表示を終了',
    'GeolocateControl.FindMyLocation':    '現在地を表示',
    'GeolocateControl.LocationNotAvailable': '現在地を取得できません',
    'AttributionControl.ToggleAttribution': '出典を表示',
    'AttributionControl.MapFeedback':     'マップのフィードバック',
    'LogoControl.Title':                  'MapLibre',
  },
  // URL ハッシュに地図状態を自動保存・復元（#zoom/lat/lng/bearing/pitch 形式）
  // 再読込時に同じ位置・向き・傾きで復元される（MapLibre / OSM 標準形式）。
  hash: true,
});

// 出典表示（customAttribution で固定表示、都道府県別CS出典は updateRegionalAttribution で追記）
// 磁北線出典は updateMagneticAttribution() で動的に切り替え
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution:
    '<a href="https://www.geospatial.jp/ckan/dataset/qchizu_94dem_99gsi" target="_blank" rel="noopener">Q地図1mDEM</a>' +
    '/<a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">地理院DEM5A</a>' +
    '/<a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">地理院DEM10B</a>' +
    'を加工して作成',
}), 'bottom-right');

// 出典パネルの開閉に応じて縮尺コントロールを移動（重なり防止）
// MutationObserver: compact-show クラスの変化（開閉）を検知して .above-attrib を付与
// ResizeObserver  : 出典の高さ変化（テキスト量・折り返し）を常時追従して --attrib-h を更新
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

    new MutationObserver(() => {
      const open = attribEl.classList.contains('maplibregl-compact-show');
      scaleEl.classList.toggle('above-attrib', open);
    }).observe(attribEl, { attributes: true, attributeFilter: ['class'] });

    new ResizeObserver(updateHeight).observe(attribEl);
    updateHeight();
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

// 磁北を上にするカスタムコントロール
// NavigationControl の compass（真北リセット）ボタンの直下に配置する。
// 地図中央の磁気偏角を getDeclination() で取得し、その分だけ bearing を回転させる。
const magneticNorthControl = {
  onAdd(m) {
    this._map = m;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = '磁北を上にする';
    // U字磁石SVGアイコン（コンパスと同配色: N極=濃色#333, S極=淡色#ccc）
    // maplibregl-ctrl-icon を使い MapLibre のボタンスタイルに準拠
    const icon = document.createElement('span');
    icon.className = 'maplibregl-ctrl-icon';
    icon.setAttribute('aria-hidden', 'true');
    // U字磁石を二色のJ字で構成:
    // 中心x=14.5, アーム上端y=4, 弧中心y=16, 外径r=9, 内径r=3
    // 左J(N極#333): 外左縦→内縁弧CW→底→外弧CCW で閉じる
    // 右J(S極#ccc): 外右縦→内縁弧CCW→底→外弧CW で閉じる
    icon.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 29 29">' +
      // 左J(N極#333): 内弧=CCW(sweep=0)で9時→6時短弧、外弧=CW(sweep=1)で6時→9時短弧
      '<path d="M5.5,4 L11.5,4 L11.5,16 A3,3,0,0,0,14.5,19 L14.5,25 A9,9,0,0,1,5.5,16 Z" fill="#333"/>' +
      // 右J(S極#ccc): 内弧=CW(sweep=1)で3時→6時短弧、外弧=CCW(sweep=0)で6時→3時短弧
      '<path d="M23.5,4 L17.5,4 L17.5,16 A3,3,0,0,1,14.5,19 L14.5,25 A9,9,0,0,0,23.5,16 Z" fill="#ccc"/>' +
      '</svg>'
    )}")`;
    btn.appendChild(icon);
    btn.addEventListener('click', () => {
      const center = m.getCenter();
      const decl   = getDeclination(center.lat, center.lng);
      // MapLibre bearing = 地図上方が真北から時計回りに何度か
      // 磁北を上にする = 地図上方を磁北方向（真北から decl 度）に向ける → bearing = decl
      m.easeTo({ bearing: decl, pitch: 0, duration: 300 });
    });
    this._container.appendChild(btn);
    return this._container;
  },
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = undefined;
  },
};
map.addControl(magneticNorthControl, 'top-right');

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
  マップの読み込み完了後に 3D Terrain を有効化する
  map.on('load', ...) はスタイル・タイルの初期読み込みが完了したタイミングで発火します。
  ========================================================
*/
// contourState・buildContourTileUrl 系・setAllContourVisibility は contours.js からインポート済み

map.on('load', async () => {

  /*
  ========================================================
  ① ラスターベースマップのソースとレイヤーを追加（isomizer より先に配置 → 下層に固定）
  visibility: 'none' で非表示にしておき、ベースマップ切替時に表示する。
  setStyle() を使わないことで、後から追加する KMZ / CS立体図 / 等高線 / 磁北線レイヤーが
  消えないようにしている（visibility 切替方式）。
  ========================================================
  */
  // MapLibre の式: fetchZoom = round(viewZoom + log2(512 / tileSize))
  // DPR=1.5 のとき tileSize=171 → round(viewZoom + 1.58) → viewZoom+2 のタイルを取得
  // → 256px タイルを ~171 CSS px（=256物理px）に縮小表示 → シャープ（Q地図と同等）
  // DPR=1.0 のとき tileSize=256 → round(viewZoom + 1.0) → 通常どおり viewZoom+1
  const _rasterTileSize = Math.round(256 / (window.devicePixelRatio || 1));

  Object.entries(BASEMAPS).filter(([, cfg]) => cfg.url).forEach(([key, cfg]) => {
    map.addSource(key, {
      type: 'raster',
      tiles: [cfg.url],
      tileSize: _rasterTileSize,
      maxzoom: cfg.maxzoom,
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
    // worker: true 使用時は絶対 URL が必要（Worker 内では相対パスが解決されないため）
    contourState.q1mSource = new mlcontour.DemSource({
      url: `${location.origin}${QCHIZU_PROXY_BASE}/{z}/{x}/{y}.webp`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 16,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    contourState.q1mSource.setupMaplibre(maplibregl);
    map.addSource('contour-source', {
      type: 'vector',
      tiles: [buildContourTileUrl(userContourInterval)],
      minzoom: 3,
      maxzoom: 15, // z15タイルをz16以上でオーバーズーム
      attribution: '',
    });
    console.log('Q地図 1m 等高線ソース登録完了');
  } catch (e) {
    console.warn('Q地図 DemSource の初期化に失敗:', e);
  }


  // DEM5A 5m 等高線ソース（Q地図と完全独立・標高タイルのある範囲で全域描画）
  try {
    contourState.dem5aSource = new mlcontour.DemSource({
      url: `${DEM5A_BASE}/{z}/{x}/{y}.png`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 15,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    contourState.dem5aSource.setupMaplibre(maplibregl);
    map.addSource('contour-source-dem5a', {
      type: 'vector',
      tiles: [buildSeamlessContourTileUrl(userContourInterval)],
      minzoom: 3,
      maxzoom: 15, // z15タイルをz16以上でオーバーズーム
      attribution: '',
    });
    console.log('DEM5A 等高線ソース登録完了');
  } catch (e) {
    console.warn('DEM5A DemSource の初期化に失敗:', e);
  }

  // 地理院 DEM1A 1m 等高線ソース（DEM5Aと同設定・maxzoomのみ17）
  try {
    contourState.dem1aSource = new mlcontour.DemSource({
      url: `${DEM1A_BASE}/{z}/{x}/{y}.png`,
      encoding: 'numpng',
      minzoom: 0,
      maxzoom: 17,
      worker: true,
      cacheSize: 100,
      timeoutMs: 30_000,
    });
    contourState.dem1aSource.setupMaplibre(maplibregl);
    map.addSource('contour-source-dem1a', {
      type: 'vector',
      tiles: [buildDem1aContourTileUrl(userContourInterval)],
      minzoom: 3,
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
      .map(l => ({
        id: l.id,
        defaultVisibility: l.layout?.visibility ?? 'visible',
        ...(l.type === 'background' ? { origBgColor: l.paint?.['background-color'] } : {}),
      }));
    console.log(`OriLibre レイヤー収集完了: ${oriLibreLayers.length} レイヤー`);

    // backgroundレイヤーを最下層に移動（ラスターベースマップの下に配置）
    // ベースマップ切替時に色を変えるだけで済むようにする
    const bgInit = oriLibreLayers.find(l => l.id.endsWith('-background'));
    if (bgInit && map.getLayer(bgInit.id)) {
      const firstId = map.getStyle().layers[0]?.id;
      if (firstId && firstId !== bgInit.id) map.moveLayer(bgInit.id, firstId);
    }

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

    // isomizer の project-config.yml が別のcenterを持つ場合があるため完了後に位置を復元する。
    // ただし以下の場合は上書きしない:
    //   - URLハッシュあり: MapLibreのhash:trueが復元済み
    //   - localStorageから復元済み: Map初期化時に前回位置を適用済み
    if (!location.hash && !_restoredFromStorage) {
      map.jumpTo({
        center: INITIAL_CENTER, zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, bearing: INITIAL_BEARING
      });
    }
  }

  catch (e) {
    console.warn('OriLibre の読み込みに失敗しました。フォールバックとして淡色地図を使用します。', e);

    map.addSource('basemap-fallback', {
      type: 'raster',
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
      tileSize: _rasterTileSize,
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

    // contourState.seamlessLayerIds は湖水深廃止により空配列
    contourState.seamlessLayerIds = [];

    // OriLibre の水域フィルレイヤーが等高線の上に配置されるため最上位へ移動。
    // 移動順: DEM1A < DEM5A < Q地図 の順（Q地図が最終的に一番上）。
    ['contour-regular-dem1a', 'contour-index-dem1a',
     'contour-regular-dem5a', 'contour-index-dem5a',
     ...contourLayerIds,
    ].forEach(id => { if (map.getLayer(id)) map.moveLayer(id); });
    console.log('等高線レイヤー追加完了（Q地図 + DEM5A + DEM1A）');
  }

  // 色別等高線レイヤー（オーバーレイ「色別等高線」選択時に表示）
  // 各 DEM ソースに対応した 3 セットを追加し、contourState.demMode に応じて排他表示する
  {
    const colorExpr = buildColorContourExpr(crMin, crMax, getReliefPalette(crPaletteId));
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

  // 色別標高図（data-render:// プロトコル経由で CPU 着色）
  // 初期タイルは空ダミー。選択時に scheduleDataOverlayDeckSync が setTiles() で差し替える。
  map.addSource('color-relief', {
    type: 'raster',
    tiles: ['data-render-init://{z}/{x}/{y}'],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 15,
    attribution: '',
  });
  // 等高線レイヤーの下（beforeId）に挿入 — terrain 互換・描画順を保証
  map.addLayer({
    id: 'color-relief-layer',
    type: 'raster',
    source: 'color-relief',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);

  // 傾斜量図（data-render:// プロトコル経由で CPU 着色）
  map.addSource('slope-relief', {
    type: 'raster',
    tiles: ['data-render-init://{z}/{x}/{y}'],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 15,
    attribution: '',
  });
  map.addLayer({
    id: 'slope-relief-layer',
    type: 'raster',
    source: 'slope-relief',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);

  // 色別曲率図（data-render:// プロトコル経由で CPU 着色）
  map.addSource('curvature-relief', {
    type: 'raster',
    tiles: ['data-render-init://{z}/{x}/{y}'],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 15,
    attribution: '',
  });
  map.addLayer({
    id: 'curvature-relief-layer',
    type: 'raster',
    source: 'curvature-relief',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);


  // 赤色立体地図（dem2rrim://プロトコル）
  map.addSource('rrim-relief', {
    type: 'raster',
    tiles: [`dem2rrim://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp?_init=1`],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 15, // z16+ は MapLibre がオーバーズーム（DEM5A 上限に合わせる）
    attribution: '',
  });
  map.addLayer({
    id: 'rrim-relief-layer',
    type: 'raster',
    source: 'rrim-relief',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);

  // CS立体図（ブラウザ生成・Q地図DEMから動的生成）
  map.addSource('cs-relief', {
    type: 'raster',
    tiles: [CS_RELIEF_URL],
    tileSize: 256,
    minzoom: 5,
    maxzoom: 15, // z16+ は MapLibre がオーバーズーム（DEM5A 上限に合わせる）
    attribution: '',
  });

  map.addLayer({
    id: 'cs-relief-layer',
    type: 'raster',
    source: 'cs-relief',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': CS_INITIAL_OPACITY, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
  }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);

  // ── Q地図専用オーバーレイ（z16実データ・各メインソースの上に重ねる） ──────────────
  // Q地図1m は z16 タイルを持つため、各オーバーレイを Q地図のみモード（qonly=1）で
  // minzoom:16/maxzoom:16 の独立ソースとして追加。
  // z16+ でメインソースのオーバーズームに替わって Q地図 z16 の高品質データを表示する。
  // Q地図カバレッジ外では null タイルを返すためメインソースのオーバーズームが透けて見える。
  const _qBase = QCHIZU_DEM_BASE.replace(/^https?:\/\//, '');
  [
    // rrim/cs は MapLibre ネイティブ描画のため z16 高解像度ソースを保持
    { id: 'rrim-qchizu', proto: 'dem2rrim', params: '',  opacity: 'none', init: 0 },
    { id: 'cs-qchizu',   proto: 'dem2cs',   params: '',  opacity: 'none', init: CS_INITIAL_OPACITY },
  ].forEach(({ id, proto, params, opacity, init }) => {
    const qs = params ? `${params}&qonly=1` : 'qonly=1';
    map.addSource(id, {
      type: 'raster',
      tiles: [`${proto}://${_qBase}/{z}/{x}/{y}.webp?${qs}`],
      tileSize: 256,
      minzoom: 16,
      maxzoom: 16, // Q地図1m z16 実データ・z17+ は MapLibre がオーバーズーム
      attribution: '',
    });
    map.addLayer({
      id: `${id}-layer`,
      type: 'raster',
      source: id,
      layout: { visibility: opacity },
      paint: { 'raster-opacity': init, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
    }, map.getLayer('contour-regular-dem1a') ? 'contour-regular-dem1a' : undefined);
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
  // 地域別CS・RRIM共通のソース/レイヤー追加関数
  // minzoom はサーバー側の実際の下限値（config で定義）。表示制御は visibility で別途行う。
  function _addRegionalLayer(layer) {
    const srcCfg = {
      type: 'raster',
      tiles: [layer.tileUrl],
      tileSize: 256,
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
      bounds: layer.bounds,
      attribution: '',
    };
    if (layer.scheme) srcCfg.scheme = layer.scheme;
    map.addSource(layer.sourceId, srcCfg);
    // 等高線レイヤーの直下に挿入し、等高線が常に上に重なるようにする
    const beforeContour = ['contour-regular-dem1a', 'contour-regular-dem5a', 'contour-regular']
      .find(id => map.getLayer(id));
    map.addLayer({
      id: layer.layerId,
      type: 'raster',
      source: layer.sourceId,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 1.0, 'raster-fade-duration': 0, 'raster-opacity-transition': { duration: 0, delay: 0 } },
    }, beforeContour);
  }

  REGIONAL_CS_LAYERS.forEach(_addRegionalLayer);
  REGIONAL_RRIM_LAYERS.forEach(_addRegionalLayer);
  REGIONAL_RELIEF_LAYERS.forEach(_addRegionalLayer);
  REGIONAL_SLOPE_LAYERS.forEach(_addRegionalLayer);
  REGIONAL_CURVE_LAYERS.forEach(_addRegionalLayer);

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
      'line-color': getMagneticLineColor(),
      'line-width': 0.8,
      'line-opacity': 1.0,
    },
  });
  updateMagneticNorth();

  // 磁北線出典の初期表示
  updateMagneticAttribution();

  // 都道府県別CS出典の動的更新 — タイル読み込み完了を待たず即時反映するため moveend を使用
  // 地図移動のたびに状態を localStorage に保存（ハッシュなし再訪時の復元用）
  const _LS_MAP_KEY = 'teledrop-map-state';
  map.on('moveend', () => {
    const c = map.getCenter();
    try {
      localStorage.setItem(_LS_MAP_KEY, JSON.stringify({
        lat: c.lat, lng: c.lng,
        zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      }));
    } catch {}
  });

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

  // ズームに応じて空の色を補間するヘルパー
  function _lerpHex(a, b, t) {
    const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
    const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl2 = Math.round(ab + (bb - ab) * t);
    return '#' + [r, g, bl2].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  // ズームに応じて空と背景を更新する（globe低ズーム→宇宙空間表現）
  // 多段階カラーストップ補間ヘルパー（stops: [[t, '#rrggbb'], ...]）
  function _lerpMulti(stops, t) {
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
      if (t <= t1) return _lerpHex(c0, c1, (t - t0) / (t1 - t0));
    }
    return stops[stops.length - 1][1];
  }

  // z7（カーマン線）→z11（対流圏）で段階的に遷移
  // 空: 黒→濃紺→深青→空青
  // 地平線: 濃紺→中青→水色（白は使わない）
  _updateGlobeBg = () => {
    if (!_globeBgEl) return;
    const z = map.getZoom();
    const t = Math.max(0, Math.min(1, (z - 7) / 4));

    // z7〜z11: 現在と同じ速度で遷移（t=0→4/11）
    // z11〜z12: 残り（4/11→1）を1ズームで一気に完了。z12以降は最大値固定
    const t2 = z <= 11
      ? Math.max(0, (z - 7) / 11)
      : Math.min(1, 4 / 11 + (z - 11) * (7 / 11));

    // 上空: 黒→濃紺→深青→明青
    const skyColor     = _lerpMulti([[0,'#000000'],[0.2,'#000033'],[0.5,'#002277'],[0.8,'#003a99'],[1,'#0055cc']], t2);
    // 地平線: 常に上空より薄め。高ズームで薄い水色へ
    const horizonColor = _lerpMulti([[0,'#000820'],[0.2,'#001a4d'],[0.5,'#1a4499'],[0.8,'#4488cc'],[1,'#87ceeb']], t2);
    const bgColor      = horizonColor;
    // 地平線色の広がりも高ズームほど拡大（0.2=宇宙→0.8=地上）
    const skyHorizonBlend = 0.2 + 0.6 * t2;

    _globeBgEl.style.backgroundColor = bgColor;
    map.setSky({
      'sky-color':          skyColor,
      'sky-horizon-blend':  skyHorizonBlend,
      'horizon-color':      horizonColor,
      'horizon-fog-blend':  0,
      'fog-color':          horizonColor,
      'atmosphere-blend':   0,
    });
  };
  map.on('zoom', _updateGlobeBg);
  _updateGlobeBg();

  // ⑤ テレイン検索レイヤーを初期化する（Phase 1: ダミーデータ）
  initTerrainLayers(map);
  // マップロード前に検索が完了していた場合、キャッシュ結果をレイヤーに反映する
  if (_lastTerrainResults) updateSearchTerrainSource(map, _lastTerrainResults);

  // UI状態全体をlocalStorageから復元（リロード時維持）
  restoreUiState();

  // IndexedDB に保存された地図を復元する（非同期・失敗しても継続）
  restoreMapLayersFromDb();

  // コースセットへの DB 移行（v4→v5: controlDefs を course_sets ストアへ）
  migrateCourseSets().catch(e => console.warn('migrateCourseSets:', e));

  // コースプランナー初期化（localMapLayers の参照を渡す）
  setMapLayersGetter(() => localMapLayers);
  initCoursePlanner(map);

  // 地図が安定表示されたらURLをフル状態に更新（Google Maps方式）
  // hash:true がハッシュを確定した後に updateShareableUrl を呼ぶことで
  // https://teledrop.pages.dev/ → https://teledrop.pages.dev/?overlay=cs#15/35.02/135.78 に自動遷移する
  map.once('idle', () => {
    updateShareableUrl();
    renderExplorer();
  });

  console.log('3D OMap Viewer 初期化完了（OriLibreベースマップ）');
});


/* ========================================================
    ローカル地図レイヤーの管理リスト
    KMZ・画像+JGW・IndexedDB 復元のすべてを一元管理する。
    各エントリは以下の情報を保持します：
      id        : 連番（ユニークなソース/レイヤーIDの生成に使用）
      name      : ファイル名（UIに表示）
      sourceId  : MapLibre に登録したソースのID（"kmz-source-N"）
      layerId   : MapLibre に登録したレイヤーのID（"kmz-layer-N"）
      objectUrl : 画像のObjectURL（不要になったら revoke が必要）
      dbId      : IndexedDB のレコード id（null = 未保存）
    ======================================================== */
const localMapLayers = [];
let localMapCounter = 0;

/* =====================================================================
   _addLocalMapLayerFromBlob — Blob + 座標から KMZ 系レイヤーを地図に追加する内部ヘルパー

   loadKmz / loadImageWithJgw / restoreMapLayersFromDb の共通処理をまとめる。
   fitBounds は呼び出し元が責任を持つ（引数で制御）。
   ===================================================================== */
function _addLocalMapLayerFromBlob(imageBlob, coordinates, name, {
  opacity     = OMAP_INITIAL_OPACITY,
  visible     = true,
  terrainId   = null,
  terrainName = null,
  mapSheetId  = null,   // コース枠 ID（null = 未割り当て）
} = {}) {
  const objectUrl = URL.createObjectURL(imageBlob);
  const id        = localMapCounter++;
  const sourceId  = `kmz-source-${id}`;
  const layerId   = `kmz-layer-${id}`;

  map.addSource(sourceId, { type: 'image', url: objectUrl, coordinates });
  map.addLayer({
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
    'slope-relief-layer', 'rrim-relief-layer', 'cs-relief-layer'].find(lid => map.getLayer(lid));
  if (_anchor) {
    map.moveLayer(layerId, _anchor);
  } else if (map.getLayer('gpx-track-outline')) {
    map.moveLayer(layerId, 'gpx-track-outline');
  } else {
    map.moveLayer(layerId);
  }

  // frames-fill が画像レイヤーより上にある場合は下に移動
  if (map.getLayer('frames-fill')) {
    const _ids = map.getStyle().layers.map(l => l.id);
    if (_ids.indexOf('frames-fill') > _ids.indexOf(layerId)) {
      map.moveLayer('frames-fill', layerId);
    }
  }

  const lngs  = coordinates.map(c => c[0]);
  const lats  = coordinates.map(c => c[1]);
  const entry = {
    id, name, sourceId, layerId, objectUrl,
    visible, opacity,
    coordinates: coordinates.map(c => [...c]),  // 4隅座標（TL→TR→BR→BL）。枠スナップ・DB保存に使用
    bbox: {
      west:  Math.min(...lngs), east:  Math.max(...lngs),
      south: Math.min(...lats), north: Math.max(...lats),
    },
    terrainId,   // テレイン紐づけ（null = 未分類）
    terrainName, // 表示名キャッシュ
    mapSheetId,  // コース枠 ID（null = 枠なし / 未割り当て）
    dbId: null,  // IndexedDB に保存後にセットされる
  };
  localMapLayers.push(entry);
  return entry;
}

/* =====================================================================
   restoreMapLayersFromDb — IndexedDB に保存された地図を起動時に復元する
   ===================================================================== */
async function restoreMapLayersFromDb() {
  let saved;
  try {
    saved = await getAllMapLayers();
  } catch (err) {
    console.warn('IndexedDB 読み込みエラー（地図の復元をスキップ）:', err);
    return;
  }
  if (!saved || saved.length === 0) return;

  for (const rec of saved) {
    try {
      const entry = _addLocalMapLayerFromBlob(
        rec.imageBlob, rec.coordinates, rec.name,
        {
          opacity:     rec.opacity,
          visible:     rec.visible,
          terrainId:   rec.terrainId   ?? null,
          terrainName: rec.terrainName ?? null,
          mapSheetId:  rec.mapSheetId  ?? null,
        }
      );
      entry.dbId = rec.id;
    } catch (err) {
      console.warn(`DB レコード id=${rec.id} の復元に失敗:`, err);
    }
  }
  renderLocalMapList();
  console.log(`IndexedDB から ${saved.length} 件の地図を復元しました`);
}

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
const gpxState = {
  trackPoints:     [],       // GPXのトラックポイント配列（{lng, lat, relTime}の形式）
  totalDuration:   0,        // 総再生時間（ミリ秒）
  currentTime:     0,        // 現在の再生位置（ミリ秒）
  isPlaying:       false,    // 再生中かどうか
  animFrameId:     null,     // requestAnimationFrameのID（キャンセルに使用）
  lastTimestamp:   null,     // 前フレームのタイムスタンプ（差分計算用）
  viewMode:        '2d',     // 視点モード: '2d'＝俯瞰 / '3d'＝追尾カメラ
  chasePitch:      60,       // 3D追尾カメラ ピッチ（deg）
  camDistM:        50,       // 3D追尾カメラ距離（m）
  bearingOffset:   0,        // 進行方向からの bearing オフセット（deg）
  chaseKeys: {               // 矢印キー押下状態（3D モード専用）
    ArrowLeft: false, ArrowRight: false, ArrowUp: false, ArrowDown: false,
  },
  cachedTerrainH:  0,        // 地形高度キャッシュ（queryTerrainElevation が null のときに維持）
  lastBearing:     0,        // 前フレームの進行方向（端点などbearing=0の補完用）
  smoothedBearing: 0,        // bearing ローパスフィルタ値（カクカク防止）
  smoothedZoom:    15,       // zoom ローパスフィルタ値
  fileName:        null,     // 読み込んだ GPX ファイル名（レイヤーパネル表示用）
  terrainId:       null,     // 関連付けられたワークスペーステレイン ID（null = 未分類）
};
const GPX_CAM_DIST_MIN = 1;
const GPX_CAM_DIST_MAX = 500;
// bearing / zoom 平滑化の時定数（秒）。大きいほど滑らかで遅延が増す
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
      --- ステップ⑧ MapLibre にソースとレイヤーを追加する（_addLocalMapLayerFromBlob ヘルパー）---
      レイヤー生成・配置・localMapLayers 登録を共通ヘルパーに委譲する。
    */
    const entry = _addLocalMapLayerFromBlob(imgBlob, coordinates, file.name, {
      terrainId:   null,
      terrainName: null,
    });

    // --- ステップ⑨ 地図全体が収まる範囲にフィット ---
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
    map.fitBounds(
      [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
      {
        padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                   left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
        pitch: INITIAL_PITCH,
        duration: EASE_DURATION,
        maxZoom: 19,
      }
    );
    // fitBounds 後も画像が最前面になるよう moveLayer
    map.moveLayer(entry.layerId);

    // IndexedDB に非同期保存（失敗しても動作継続）
    saveMapLayer({ type: 'kmz', name: file.name, imageBlob: imgBlob,
                   coordinates, opacity: entry.opacity, visible: true,
                   terrainId:   entry.terrainId,
                   terrainName: entry.terrainName })
      .then(dbId => { entry.dbId = dbId; renderOtherMapsTree(); renderExplorer(); })
      .catch(e => console.warn('KMZ の DB 保存に失敗:', e));

    // UIの一覧を更新する
    renderLocalMapList();

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
  // ① 画像サイズ（W×H）を取得するために一時 ObjectURL を使う
  //    後で _addLocalMapLayerFromBlob が改めて ObjectURL を生成するため、ここでは revoke する
  const _tmpUrl = URL.createObjectURL(imageFile);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload  = () => resolve(i);
    i.onerror = () => { URL.revokeObjectURL(_tmpUrl); reject(new Error('画像の読み込みに失敗しました')); };
    i.src = _tmpUrl;
  });
  URL.revokeObjectURL(_tmpUrl);
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

  // ⑤ _addLocalMapLayerFromBlob で MapLibre への追加・localMapLayers 登録を行う
  //    imageFile は File オブジェクトなので Blob として直接渡せる
  const entry = _addLocalMapLayerFromBlob(imageFile, coordinates, imageFile.name, {
    terrainId:   null,
    terrainName: null,
  });

  // ⑥ UI を更新する
  renderLocalMapList();

  // ⑦ 追加した画像の範囲にカメラをフィットさせる
  const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
  map.fitBounds(
    [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
    { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                 left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
      pitch: INITIAL_PITCH, duration: EASE_DURATION, maxZoom: 19 }
  );

  // IndexedDB に非同期保存
  saveMapLayer({ type: 'image-jgw', name: imageFile.name, imageBlob: imageFile,
                 coordinates, opacity: entry.opacity, visible: true,
                 terrainId:   entry.terrainId,
                 terrainName: entry.terrainName })
    .then(dbId => { entry.dbId = dbId; renderOtherMapsTree(); renderExplorer(); })
    .catch(e => console.warn('画像+JGW の DB 保存に失敗:', e));

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


// terrainMap スタブ（Phase 1: 空 Map。Phase 2 で Supabase データに差し替え）
// レイヤーパネルの名前表示など、参照しているコードが壊れないよう残す。
const terrainMap = new Map();

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
  const overlayAnchor = ['color-contour-regular', 'color-relief-layer', 'slope-relief-layer', 'cs-relief-layer']
      .find(id => map.getLayer(id));
  if (overlayAnchor) {
    map.moveLayer(layerId, overlayAnchor);
  } else if (map.getLayer('gpx-track-outline')) {
    map.moveLayer(layerId, 'gpx-track-outline');
  } else {
    map.moveLayer(layerId);
  }
}


// 「その他の地図」ノードの子要素（localMapLayers）を再描画する
function renderOtherMapsTree() {
  const otherEl = document.getElementById('frame-tree-other-children');
  if (!otherEl) return;
  otherEl.innerHTML = '';

  if (localMapLayers.length === 0) {
    _updateStorageInfoBar();
    return;
  }

  localMapLayers.forEach(entry => {
    const shortName = entry.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');

    // ---- 名前行 ----
    const childEl = document.createElement('div');
    childEl.className = 'tree-child-item';

    // 地図アイコン
    const iconSpan = document.createElement('span');
    iconSpan.textContent = '🗺️';
    childEl.appendChild(iconSpan);

    // DB 保存済みバッジ（💾）
    if (entry.dbId != null) {
      const badge = document.createElement('span');
      badge.className = 'tree-saved-badge';
      badge.title = 'ストレージに保存済み（次回起動時も表示されます）';
      badge.textContent = '💾';
      childEl.appendChild(badge);
    }

    // ファイル名ラベル（クリックで地図へジャンプ）
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-child-name';
    nameSpan.title = entry.name;
    nameSpan.textContent = shortName;
    nameSpan.addEventListener('click', () => {
      if (entry.bbox) {
        const pw = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
        map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                       left: pw + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
            duration: EASE_DURATION }
        );
      }
    });
    childEl.appendChild(nameSpan);

    // 削除ボタン
    const delBtn = document.createElement('button');
    delBtn.className = 'tree-child-del-btn';
    delBtn.title = 'この地図を削除';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeLocalMapLayer(entry.id);
    });
    childEl.appendChild(delBtn);

    otherEl.appendChild(childEl);

    // ---- コントロール行（トグル + 不透明度スライダー）----
    otherEl.appendChild(_makeLayerCtrlRow(
      entry.visible !== false,
      Math.round((entry.opacity ?? 0.8) * 100),
      (visible) => {
        entry.visible = visible;
        if (map.getLayer(entry.layerId)) {
          map.setPaintProperty(entry.layerId, 'raster-opacity',
            visible ? toRasterOpacity(entry.opacity) : 0);
        }
        // DB に可視状態を同期する
        if (entry.dbId != null) {
          updateMapLayerState(entry.dbId, { visible }).catch(() => {});
        }
      },
      (pct) => {
        entry.opacity = pct / 100;
        if (map.getLayer(entry.layerId) && entry.visible !== false) {
          map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
        }
        // DB に不透明度を同期する
        if (entry.dbId != null) {
          updateMapLayerState(entry.dbId, { opacity: entry.opacity }).catch(() => {});
        }
      }
    ));
  });

  // ストレージ情報バーを更新する
  _updateStorageInfoBar();
}

/** ストレージ情報バーの表示/非表示と使用量テキストを更新する */
function _updateStorageInfoBar() {
  const bar = document.getElementById('storage-info-bar');
  if (!bar) return;
  const hasDbLayers = localMapLayers.some(e => e.dbId != null);
  bar.style.display = hasDbLayers ? '' : 'none';
  if (!hasDbLayers) return;
  estimateStorageUsage().then(({ usage }) => {
    const el = bar.querySelector('.storage-usage-text');
    if (el) el.textContent = usage
      ? `ストレージ使用量: 約 ${(usage / 1024 / 1024).toFixed(1)} MB`
      : 'ストレージ使用量: ---';
  }).catch(() => {});
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
function renderLocalMapList() {
  const listEl = document.getElementById('kmz-list');
  listEl.innerHTML = '';

  // 読図地図セレクトのオプションを同期
  updateReadmapBgKmzOptions();

  if (localMapLayers.length === 0) return;

  localMapLayers.forEach(entry => {
    // 名前（拡張子なし）
    const shortName = entry.name.replace(/\.kmz$/i, '');
    const pct = Math.round(entry.opacity * 100);

    const rowEl = document.createElement('div');
    rowEl.className = 'layer-row';
    rowEl.dataset.id = entry.id;

    rowEl.innerHTML = `
      <div class="layer-label-row">
        <label class="toggle-switch">
          <input type="checkbox" id="chk-kmz-${entry.id}" ${entry.visible ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <label class="layer-name${entry.visible ? '' : ' disabled'}" for="chk-kmz-${entry.id}" title="${entry.name}">${shortName}</label>
        <button class="kmz-del-btn" title="削除" onclick="removeLocalMapLayer(${entry.id})">✕</button>
      </div>
      <div class="opacity-row">
        <input type="range" class="ui-slider" id="slider-kmz-${entry.id}" min="0" max="100" step="5" value="${pct}" ${entry.visible ? '' : 'disabled'} />
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
    updateSliderGradient(sliderEl);

    sliderEl.addEventListener('input', () => {
      entry.opacity = parseInt(sliderEl.value) / 100;
      valEl.textContent = sliderEl.value + '%';
      updateSliderGradient(sliderEl);

      if (entry.visible && map.getLayer(entry.layerId)) {
        map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
      }
    });
  });

  // シミュレータータブの読図地図リストも同期して更新
  renderSimReadmapList();
  // 「その他の地図」ツリーも更新
  renderOtherMapsTree();
  // エクスプローラーも同期
  renderExplorer();
}


/* =====================================================================
   レイヤーパネル — 2画面ナビゲーション管理
   ・List view  : お気に入りテレイン + レイヤーがあるテレインの一覧
   ・Detail view: 選択テレインのクイックアクション + レイヤーリスト
   地図クリック（テレインポリゴン・画像レイヤー）で Detail view に遷移する。
   ===================================================================== */

// ---- お気に入りテレインの永続化 ----
const _favTerrains = new Set(
  JSON.parse(localStorage.getItem('fav-terrains') ?? '[]')
);
function _saveFavTerrains() {
  localStorage.setItem('fav-terrains', JSON.stringify([..._favTerrains]));
}
function _toggleFavTerrain(tid) {
  if (_favTerrains.has(tid)) { _favTerrains.delete(tid); }
  else                       { _favTerrains.add(tid); }
  _saveFavTerrains();
}

// ---- レイヤーパネルのビュー状態 ----
let _layersView     = 'list'; // 'list' | 'detail'
let _layersDetailId = null;   // detail view で表示中の terrain ID（null = 未分類）

/** サイドバーの指定パネルを強制的に開く（同一パネルのトグル閉じを防ぐ） */
function _openSidebarPanel(panelId) {
  const sbPanel = document.getElementById('sidebar-panel');
  document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar-section').forEach(s => s.classList.remove('active'));
  const navBtn = document.querySelector(`.sidebar-nav-btn[data-panel="${panelId}"]`);
  if (navBtn) navBtn.classList.add('active');
  const sec = document.getElementById('panel-' + panelId);
  if (sec) sec.classList.add('active');
  if (sbPanel) sbPanel.classList.remove('sb-hidden');
  _sidebarCurrentPanel = panelId;
  _sidebarOpen = true;
  requestAnimationFrame(updateSidebarWidth);
}

/**
 * レイヤータブを開いて指定テレインの詳細へ遷移する。
 * terrainId を省略すると一覧に戻る。
 * @param {string|null|undefined} terrainId
 */
function openLayersPanel(terrainId) {
  _openSidebarPanel('layers');
  if (terrainId !== undefined) {
    showLayersDetail(terrainId);
  } else {
    showLayersList();
  }
}

/** レイヤーパネルを一覧ビューに切り替えて再描画する */
function showLayersList() {
  _layersView = 'list';
  const listEl   = document.getElementById('layers-view-list');
  const detailEl = document.getElementById('layers-view-detail');
  if (listEl)   listEl.style.display   = '';
  if (detailEl) detailEl.style.display = 'none';
  _renderLayersList();
}

/** レイヤーパネルを詳細ビューに切り替えて再描画する */
function showLayersDetail(terrainId) {
  _layersView     = 'detail';
  _layersDetailId = terrainId ?? null;
  const listEl   = document.getElementById('layers-view-list');
  const detailEl = document.getElementById('layers-view-detail');
  if (listEl)   listEl.style.display   = 'none';
  if (detailEl) detailEl.style.display = '';
  _renderLayersDetail(_layersDetailId);
}

/** renderLayersPanel — 現在のビュー状態に合わせて再描画する */
function renderLayersPanel() {
  if (_layersView === 'detail') {
    _renderLayersDetail(_layersDetailId);
  } else {
    _renderLayersList();
  }
}

/* ---- List view: テレインフォルダ一覧 ---- */
function _renderLayersList() {
  const listEl = document.getElementById('layers-view-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  // 表示対象: お気に入り ∪ レイヤーがあるテレイン ∪ 未分類(null)
  const terrainIdsWithLayers = new Set(localMapLayers.map(e => e.terrainId));
  const hasUncategorized = terrainIdsWithLayers.has(null);
  const hasGpx = gpxState.trackPoints.length > 0;

  // お気に入り + レイヤー持ちテレイン (null 除く) を unified Set で列挙
  const allIds = new Set([..._favTerrains]);
  terrainIdsWithLayers.forEach(id => { if (id !== null) allIds.add(id); });

  // テレイン名でソートして表示
  const sortedIds = [...allIds].sort((a, b) => {
    const na = terrainMap.get(a)?.name ?? a;
    const nb = terrainMap.get(b)?.name ?? b;
    return na.localeCompare(nb, 'ja');
  });

  if (sortedIds.length === 0 && !hasUncategorized && !hasGpx) {
    const hint = document.createElement('div');
    hint.className = 'layers-empty-hint';
    hint.innerHTML =
      'テレインタブでテレインを選択し、<br>☆ をタップしてお気に入りに追加すると<br>ここにフォルダが表示されます。';
    listEl.appendChild(hint);
    return;
  }

  // ---- テレインフォルダアイテム ----
  sortedIds.forEach(tid => {
    const layerCount = localMapLayers.filter(e => e.terrainId === tid).length;
    const isFav = _favTerrains.has(tid);
    const terrainName = terrainMap.get(tid)?.name ?? tid;

    const item = document.createElement('div');
    item.className = 'layers-list-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');

    // ★ お気に入りボタン
    const starBtn = document.createElement('button');
    starBtn.className = 'layers-list-star' + (isFav ? ' active' : '');
    starBtn.title = isFav ? 'お気に入りから削除' : 'お気に入りに追加';
    starBtn.setAttribute('aria-label', isFav ? 'お気に入りから削除' : 'お気に入りに追加');
    starBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

    // テレイン名
    const nameSpan = document.createElement('span');
    nameSpan.className = 'layers-list-name';
    nameSpan.textContent = terrainName;

    // レイヤー数バッジ（0件でも表示）
    const badge = document.createElement('span');
    badge.className = 'layers-list-badge';
    badge.textContent = layerCount;

    // 右矢印
    const arrow = document.createElement('span');
    arrow.className = 'layers-list-arrow';
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

    item.appendChild(starBtn);
    item.appendChild(nameSpan);
    item.appendChild(badge);
    item.appendChild(arrow);
    listEl.appendChild(item);

    // クリック → 詳細ビューへ（starBtn 除く）
    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.layers-list-star')) return;
      showLayersDetail(tid);
    });
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') showLayersDetail(tid);
    });

    // ★ ボタン
    starBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _toggleFavTerrain(tid);
      _renderLayersList(); // 一覧を再描画（お気に入りが0になればアイテムが消える場合も）
    });
  });

  // ---- 未分類フォルダ ----
  if (hasUncategorized) {
    const uncatCount = localMapLayers.filter(e => e.terrainId === null).length;
    const item = document.createElement('div');
    item.className = 'layers-list-item layers-list-item--uncat';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');

    const icon = document.createElement('span');
    icon.className = 'layers-list-folder-icon';
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'layers-list-name';
    nameSpan.textContent = '未分類';

    const badge = document.createElement('span');
    badge.className = 'layers-list-badge';
    badge.textContent = uncatCount;

    const arrow = document.createElement('span');
    arrow.className = 'layers-list-arrow';
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

    item.appendChild(icon);
    item.appendChild(nameSpan);
    item.appendChild(badge);
    item.appendChild(arrow);
    listEl.appendChild(item);

    item.addEventListener('click', () => showLayersDetail(null));
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') showLayersDetail(null);
    });
  }

  // ---- GPX アイテム（常時表示） ----
  if (hasGpx) {
    const gpxItem = _makeGpxListItem();
    listEl.appendChild(gpxItem);
  }
}

/* ---- Detail view: テレイン詳細 ---- */
function _renderLayersDetail(tid) {
  const body = document.getElementById('layers-detail-body');
  const titleEl = document.getElementById('layers-detail-title');
  const favBtn  = document.getElementById('layers-fav-btn');
  const favIcon = document.getElementById('layers-fav-icon');
  if (!body) return;

  // ---- ナビバーの更新 ----
  const terrainName = (tid === null)
    ? '未分類'
    : (terrainMap.get(tid)?.name ?? tid ?? '未選択');

  if (titleEl) titleEl.textContent = terrainName;

  // お気に入りボタン（未分類には不要）
  if (favBtn) {
    favBtn.style.display = (tid === null) ? 'none' : '';
    if (tid !== null && favIcon) {
      const isFav = _favTerrains.has(tid);
      favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
      favBtn.title = isFav ? 'お気に入りから削除' : 'お気に入りに追加';
      favBtn.classList.toggle('active', isFav);
    }
  }

  // ---- レイヤー一覧 ----
  body.innerHTML = '';

  const entries = localMapLayers.filter(e => e.terrainId === tid);
  const hasGpx  = gpxState.trackPoints.length > 0;

  if (entries.length === 0 && !hasGpx) {
    const hint = document.createElement('div');
    hint.className = 'layers-empty-hint';
    hint.textContent = tid === null
      ? '未分類のレイヤーはありません'
      : '画像を追加かGPXを追加でデータを読み込んでください';
    body.appendChild(hint);
    return;
  }

  // 画像レイヤーセクション
  if (entries.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'layers-detail-section';
    const secLabel = document.createElement('div');
    secLabel.className = 'layers-detail-section-label';
    secLabel.textContent = '画像レイヤー';
    sec.appendChild(secLabel);
    entries.forEach(e => sec.appendChild(_makeLayerItem(e)));
    body.appendChild(sec);
  }

  // GPX セクション
  if (hasGpx) {
    body.appendChild(_makeGpxDetailItem());
  }
}

/* ---- リスト用 GPX アイテム ---- */
function _makeGpxListItem() {
  const item = document.createElement('div');
  item.className = 'layers-list-item layers-list-item--gpx';

  const icon = document.createElement('span');
  icon.className = 'layers-list-folder-icon';
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  const gpxVis = map.getLayer('gpx-track')
    ? map.getLayoutProperty('gpx-track', 'visibility') !== 'none' : true;

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'layers-gpx-chk';
  chk.checked = gpxVis;
  chk.title = 'GPXトラックの表示/非表示';

  const name = document.createElement('span');
  name.className = 'layers-list-name' + (gpxVis ? '' : ' disabled');
  name.textContent = gpxState.fileName ?? 'GPXトラック';

  item.appendChild(icon);
  item.appendChild(chk);
  item.appendChild(name);

  chk.addEventListener('change', () => {
    const vis = chk.checked ? 'visible' : 'none';
    name.classList.toggle('disabled', !chk.checked);
    ['gpx-track', 'gpx-track-outline', 'gpx-marker'].forEach(lid => {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    });
  });

  return item;
}

/* ---- 詳細ビュー内 GPX アイテム ---- */
function _makeGpxDetailItem() {
  const sec = document.createElement('div');
  sec.className = 'layers-detail-section';

  const secLabel = document.createElement('div');
  secLabel.className = 'layers-detail-section-label';
  secLabel.textContent = 'GPXトラック';
  sec.appendChild(secLabel);

  const item = document.createElement('div');
  item.className = 'layer-item';

  const row = document.createElement('div');
  row.className = 'layer-item-row1';

  const gpxVis = map.getLayer('gpx-track')
    ? map.getLayoutProperty('gpx-track', 'visibility') !== 'none' : true;

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'layer-item-chk';
  chk.checked = gpxVis;

  const name = document.createElement('span');
  name.className = 'layer-item-name' + (gpxVis ? '' : ' disabled');
  name.textContent = gpxState.fileName ?? 'トラック';

  row.appendChild(chk);
  row.appendChild(name);
  item.appendChild(row);
  sec.appendChild(item);

  chk.addEventListener('change', () => {
    const vis = chk.checked ? 'visible' : 'none';
    name.classList.toggle('disabled', !chk.checked);
    ['gpx-track', 'gpx-track-outline', 'gpx-marker'].forEach(lid => {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
    });
  });

  return sec;
}

/** レイヤー1件分のアイテム要素を生成する */
function _makeLayerItem(entry) {
  const item = document.createElement('div');
  item.className = 'layer-item';

  const row1 = document.createElement('div');
  row1.className = 'layer-item-row1';

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'layer-item-chk';
  chk.checked = entry.visible;

  const name = document.createElement('span');
  name.className = 'layer-item-name' + (entry.visible ? '' : ' disabled');
  name.textContent = entry.name.replace(/\.(kmz|jpg|jpeg|png|tif|tiff)$/i, '');
  name.title = entry.name;

  const delBtn = document.createElement('button');
  delBtn.className = 'layer-item-del';
  delBtn.title = '削除';
  delBtn.innerHTML = '✕';

  row1.appendChild(chk);
  row1.appendChild(name);
  row1.appendChild(delBtn);
  item.appendChild(row1);

  // 透明度スライダー行
  const row2 = document.createElement('div');
  row2.className = 'layer-item-row2';
  const pct = Math.round(entry.opacity * 100);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'ui-slider layer-item-slider';
  slider.min = 0; slider.max = 100; slider.step = 5; slider.value = pct;
  slider.disabled = !entry.visible;
  const valSpan = document.createElement('span');
  valSpan.className = 'layer-item-opacity-val';
  valSpan.textContent = pct + '%';
  row2.appendChild(slider);
  row2.appendChild(valSpan);
  item.appendChild(row2);

  // チェックボックス：表示/非表示
  chk.addEventListener('change', () => {
    entry.visible = chk.checked;
    name.classList.toggle('disabled', !entry.visible);
    slider.disabled = !entry.visible;
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
    if (entry.dbId != null) {
      updateMapLayerState(entry.dbId, { visible: entry.visible }).catch(() => {});
    }
    // kmz-list 側も同期
    const masterChk = document.getElementById(`chk-kmz-${entry.id}`);
    if (masterChk) masterChk.checked = entry.visible;
  });

  // スライダー：透明度
  updateSliderGradient(slider);
  slider.addEventListener('input', () => {
    entry.opacity = parseInt(slider.value) / 100;
    valSpan.textContent = slider.value + '%';
    updateSliderGradient(slider);
    if (entry.visible && map.getLayer(entry.layerId)) {
      map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
    if (entry.dbId != null) {
      updateMapLayerState(entry.dbId, { opacity: entry.opacity }).catch(() => {});
    }
    // kmz-list 側も同期
    const masterSlider = document.getElementById(`slider-kmz-${entry.id}`);
    if (masterSlider) { masterSlider.value = slider.value; updateSliderGradient(masterSlider); }
    const masterVal = document.getElementById(`val-kmz-${entry.id}`);
    if (masterVal) masterVal.textContent = slider.value + '%';
  });

  // 削除ボタン
  delBtn.addEventListener('click', () => {
    removeLocalMapLayer(entry.id);
  });

  return item;
}


// シミュレータータブの読図地図リストを更新
let activeReadmapId = null;

function renderSimReadmapList() {
  const listEl = document.getElementById('sim-readmap-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (localMapLayers.length === 0) {
    listEl.innerHTML = '<div class="sim-readmap-empty">地図が読み込まれていません</div>';
    // activeReadmapId をリセット
    activeReadmapId = null;
    return;
  }

  // activeReadmapId が未設定 or 既存エントリにない場合は先頭に設定
  if (!activeReadmapId || !localMapLayers.find(e => e.id === activeReadmapId)) {
    activeReadmapId = localMapLayers[0].id;
    // sel-readmap-bg も同期
    const selReadmap = document.getElementById('sel-readmap-bg');
    if (selReadmap) {
      const opt = selReadmap.querySelector(`option[value="kmz-${activeReadmapId}"]`);
      if (opt) selReadmap.value = opt.value;
    }
  }

  localMapLayers.forEach(entry => {
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
        const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
        map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD, left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
            pitch: INITIAL_PITCH, duration: EASE_DURATION }
        );
      }
    });

    listEl.appendChild(item);
  });
}


/*
  ローカル地図レイヤーを地図・リスト・IndexedDB から削除する
*/
function removeLocalMapLayer(id) {
  const idx = localMapLayers.findIndex(e => e.id === id);
  if (idx === -1) return;

  const entry = localMapLayers[idx];
  if (map.getLayer(entry.layerId))  map.removeLayer(entry.layerId);
  if (map.getSource(entry.sourceId)) map.removeSource(entry.sourceId);
  URL.revokeObjectURL(entry.objectUrl);
  // IndexedDB に保存済みなら削除する
  if (entry.dbId != null) {
    deleteMapLayer(entry.dbId).catch(e => console.warn('DB 削除失敗:', e));
  }
  localMapLayers.splice(idx, 1);
  renderLocalMapList();
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
  bar.style.setProperty('--pct', pct + '%');
}

/* ========================================================
    時間表示パネルを更新する（現在時間 / 総時間）
    ======================================================== */
function updateTimeDisplay() {
  document.getElementById('time-current').textContent = formatMMSS(gpxState.currentTime);
  document.getElementById('time-total').textContent = formatMMSS(gpxState.totalDuration);
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
    gpxState.trackPoints = points;
    gpxState.totalDuration = points[points.length - 1].relTime;
    gpxState.currentTime = 0;
    gpxState.isPlaying = false;
    gpxState.lastTimestamp = null;
    // 追尾カメラ用キャッシュ・オフセットをリセット
    gpxState.cachedTerrainH = map.queryTerrainElevation(
      { lng: points[0].lng, lat: points[0].lat }, { exaggerated: false }
    ) ?? 0;
    gpxState.lastBearing  = 0;
    gpxState.bearingOffset = 0;
    // ローパスフィルタ値を先頭セグメントの bearing でスナップ初期化
    if (points.length >= 2) {
      gpxState.smoothedBearing = turf.bearing(
        turf.point([points[0].lng, points[0].lat]),
        turf.point([points[1].lng, points[1].lat])
      );
    } else {
      gpxState.smoothedBearing = 0;
    }
    gpxState.smoothedZoom = 15;

    // 再生中ならキャンセルする
    if (gpxState.animFrameId) {
      cancelAnimationFrame(gpxState.animFrameId);
      gpxState.animFrameId = null;
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
    seekBar.max = gpxState.totalDuration;
    seekBar.value = 0;
    updateSeekBarGradient();
    updateTimeDisplay();

    // 再生ボタンを▶にリセットする
    document.getElementById('play-pause-btn').textContent = '▶';

    // ---- タイムラインパネルを表示する ----
    document.getElementById('timeline-panel').style.display = 'flex';

    // GPX読み込み状態をUIパネルに表示する
    gpxState.fileName = file.name;
    const gpxStatusEl = document.getElementById('gpx-status');
    gpxStatusEl.style.display = 'block';
    gpxStatusEl.textContent =
      `✓ ${file.name}（${points.length}pts・${formatMMSS(gpxState.totalDuration)}）`;
    renderExplorer();

    // 地図をGPXトラック全体が見えるようにズームする
    const lngs = points.map(p => p.lng);
    const lats = points.map(p => p.lat);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 80, duration: EASE_DURATION }
    );

    console.log(`GPX読み込み完了: ${file.name}、${points.length}ポイント、総時間 ${formatMMSS(gpxState.totalDuration)}`);

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
    引数 t : 現在の相対時間（ミリ秒、0 〜 gpxState.totalDuration）
    返値 : { lng, lat, bearing } または null（ポイント不足時）

    【処理の流れ】
    1. gpxState.trackPoints 配列を先頭から順番に走査する
    2. t が p0.relTime 以上かつ p1.relTime 以下のセグメントを特定する
    3. セグメント内での進行割合（ratio）を計算する
      ratio = (t - p0.relTime) / (p1.relTime - p0.relTime)
    4. 経度・緯度をそれぞれ ratio で線形補間する
    5. Turf.js で p0→p1 の方位角（bearing）を計算して返す
    ======================================================== */
function interpolateGpxPosition(t) {
  if (gpxState.trackPoints.length < 2) return null;

  // 配列の末尾を超えた場合は最後のポイントを返す
  if (t >= gpxState.totalDuration) {
    const last = gpxState.trackPoints[gpxState.trackPoints.length - 1];
    return { lng: last.lng, lat: last.lat, bearing: 0 };
  }

  // t が含まれるセグメントを線形探索する
  for (let i = 0; i < gpxState.trackPoints.length - 1; i++) {
    const p0 = gpxState.trackPoints[i];
    const p1 = gpxState.trackPoints[i + 1];

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
  const first = gpxState.trackPoints[0];
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
  if (gpxState.viewMode === '3d') {
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
    pcSimState.camDistM・pcSimState.pitch を共有することで PC シムの設定値がそのまま反映される。
    ======================================================== */
function updateCameraChase(pos, elapsed) {
  // ── bearing のローパスフィルタ（カクカク防止） ──────────────────────
  // GPS 記録間隔が粗いと bearing がセグメント境界で突変するため、
  // 指数平滑化で滑らかに追従させる。時定数 GPX_BEARING_TC 秒。
  // ユーザーの矢印キーによる gpxState.bearingOffset は平滑化後に加算するため
  // レスポンスを損なわない。
  const dt = Math.max(0, elapsed ?? 16) / 1000; // 実経過時間（秒）
  const bearingAlpha = 1 - Math.exp(-dt / GPX_BEARING_TC);
  // 角度の最短経路で差分を求めて wraparound を回避する
  const bearingDelta = ((pos.bearing - gpxState.smoothedBearing + 540) % 360) - 180;
  gpxState.smoothedBearing = (gpxState.smoothedBearing + bearingDelta * bearingAlpha + 360) % 360;

  // 地形標高取得（タイル未読み込み時はキャッシュ維持）
  const rawH = map.queryTerrainElevation(
    { lng: pos.lng, lat: pos.lat }, { exaggerated: false }
  );
  if (rawH !== null) gpxState.cachedTerrainH += (rawH - gpxState.cachedTerrainH) * 0.25;
  const h = gpxState.cachedTerrainH;

  const H       = map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pos.lat * Math.PI / 180;

  // GPX 独自のピッチ・カメラ距離を使用（PC シムとは独立）
  const pitchDeg = Math.max(0, Math.min(map.getMaxPitch(), gpxState.chasePitch));
  const pitchRad = pitchDeg * Math.PI / 180;
  // 平滑化済み進行方向 + ユーザーオフセット
  const camBearing = (gpxState.smoothedBearing + gpxState.bearingOffset + 360) % 360;

  // 後方地点の地形高度を取得してカメラのめり込みを防止
  const backDistKm = gpxState.camDistM * Math.sin(pitchRad) / 1000;
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
    (1024 * Math.tan(fov_rad / 2) * Math.max(0.3, gpxState.camDistM * Math.cos(pitchRad)))
  )));
  gpxState.smoothedZoom += (targetZoom - gpxState.smoothedZoom) * zoomAlpha;

  map.jumpTo({
    center:  [pos.lng, pos.lat],
    bearing: camBearing,
    pitch:   pitchDeg,
    zoom:    gpxState.smoothedZoom,
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
  const elapsed = gpxState.lastTimestamp !== null ? timestamp - gpxState.lastTimestamp : 0;
  gpxState.lastTimestamp = timestamp;

  // ── 3D モード: 矢印キーによる視点調整（毎フレーム滑らかに更新） ──
  if (gpxState.viewMode === '3d') {
    const dt = Math.max(0, elapsed) / 1000; // 秒
    const BEARING_RATE = 90; // deg/s
    const PITCH_RATE   = 60; // deg/s
    if (gpxState.chaseKeys.ArrowLeft)  gpxState.bearingOffset = (gpxState.bearingOffset - BEARING_RATE * dt + 360) % 360;
    if (gpxState.chaseKeys.ArrowRight) gpxState.bearingOffset = (gpxState.bearingOffset + BEARING_RATE * dt) % 360;
    if (gpxState.chaseKeys.ArrowUp)    gpxState.chasePitch = Math.min(85, gpxState.chasePitch + PITCH_RATE * dt);
    if (gpxState.chaseKeys.ArrowDown)  gpxState.chasePitch = Math.max(0,  gpxState.chasePitch - PITCH_RATE * dt);
  }

  // 再生速度セレクトの値を読み取る（10x, 30x, 60x, 120x）
  const speed = parseInt(document.getElementById('speed-select').value, 10) || 30;

  // シミュレーション時間を speed 倍で進める
  // elapsed=33ms（約30fps）+ speed=30 → 990ms/frame 進む（約1分/秒の速度）
  gpxState.currentTime += elapsed * speed;

  // 終端に達したら停止する
  if (gpxState.currentTime >= gpxState.totalDuration) {
    gpxState.currentTime = gpxState.totalDuration;
    gpxState.isPlaying = false;
    document.getElementById('play-pause-btn').textContent = '▶';
  }

  // シークバーの値と表示を更新する
  const seekBar = document.getElementById('seek-bar');
  seekBar.value = gpxState.currentTime;
  updateSeekBarGradient();
  updateTimeDisplay();

  // 現在時間に対応する地図上の座標を補間して求める
  const pos = interpolateGpxPosition(gpxState.currentTime);

  if (pos) {
    // 進行方向をキャッシュ（端点で bearing=0 になる箇所の補完）
    if (pos.bearing !== 0) gpxState.lastBearing = pos.bearing;
    else pos.bearing = gpxState.lastBearing;
    // 現在地マーカーと視点カメラを更新する（elapsed を平滑化に使用）
    updateGpxMarker(pos);
    updateCamera(pos, elapsed);
  }

  // まだ再生中であれば次のフレームをリクエストする
  if (gpxState.isPlaying) {
    gpxState.animFrameId = requestAnimationFrame(gpxAnimationLoop);
  }
}

/* ========================================================
    再生 / 一時停止の切り替え
    ======================================================== */
function toggleGpxPlayPause() {
  if (gpxState.trackPoints.length === 0) return;

  gpxState.isPlaying = !gpxState.isPlaying;
  document.getElementById('play-pause-btn').textContent = gpxState.isPlaying ? '⏸' : '▶';

  if (gpxState.isPlaying) {
    // 終端まで再生済みの場合は先頭から再生し直す
    if (gpxState.currentTime >= gpxState.totalDuration) gpxState.currentTime = 0;
    gpxState.lastTimestamp = null;
    gpxState.animFrameId = requestAnimationFrame(gpxAnimationLoop);
  } else {
    // 一時停止：アニメーションフレームをキャンセルする
    if (gpxState.animFrameId) {
      cancelAnimationFrame(gpxState.animFrameId);
      gpxState.animFrameId = null;
    }
    gpxState.lastTimestamp = null;
  }
}

/* ========================================================
    視点モードを切り替える（1人称 ↔ 3人称）
    ======================================================== */
function toggleGpx3dMode() {
  gpxState.viewMode = (gpxState.viewMode === '2d') ? '3d' : '2d';
  const btn = document.getElementById('gpx-3d-btn');
  const panel = document.getElementById('timeline-panel');
  if (gpxState.viewMode === '3d') {
    btn.textContent = '3D';
    btn.classList.add('active');
    panel.classList.add('gpx-3d');
    // 3D に切り替えたとき bearing オフセットをリセット
    gpxState.bearingOffset = 0;
  } else {
    btn.textContent = '2D';
    btn.classList.remove('active');
    panel.classList.remove('gpx-3d');
    // 2D 復帰時はすべての矢印キーをリセット
    Object.keys(gpxState.chaseKeys).forEach(k => { gpxState.chaseKeys[k] = false; });
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
// ---- 検索履歴ユーティリティ ----
const _HISTORY_MAX = 10;

function _historyLoad(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
}
function _historySave(key, item) {
  const list = _historyLoad(key).filter(v => v !== item);
  list.unshift(item);
  localStorage.setItem(key, JSON.stringify(list.slice(0, _HISTORY_MAX)));
}
function _historyDelete(key, item) {
  const list = _historyLoad(key).filter(v => v !== item);
  localStorage.setItem(key, JSON.stringify(list));
}

// unified-search 履歴ドロップダウンを表示（入力が空のときのみ）
function _showUnifiedHistory() {
  const results = document.getElementById('unified-search-results');
  const msg     = document.getElementById('unified-search-msg');
  const list    = _historyLoad('sh_unified');
  if (list.length === 0) { results.innerHTML = ''; msg.textContent = ''; return; }
  results.innerHTML = '';
  msg.textContent = '';
  const header = document.createElement('div');
  header.className = 'search-history-header';
  header.textContent = '最近の検索';
  results.appendChild(header);
  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'place-result-item search-history-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'result-source-icon';
    iconEl.textContent = '🕐';
    el.appendChild(iconEl);
    const nameEl = document.createElement('span');
    nameEl.className = 'place-result-name';
    nameEl.textContent = item;
    el.appendChild(nameEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'search-history-del';
    delBtn.setAttribute('aria-label', '履歴から削除');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      _historyDelete('sh_unified', item);
      _showUnifiedHistory();
    });
    el.appendChild(delBtn);
    el.addEventListener('click', () => {
      document.getElementById('unified-search-input').value = item;
      updateClearBtn();
      results.innerHTML = '';
      clearTimeout(_searchTimer);
      searchPlace();
    });
    results.appendChild(el);
  });
}

// catalog-search 履歴ドロップダウンを表示
function _showCatalogHistory() {
  const container = document.getElementById('catalog-search-history');
  if (!container) return;
  const list = _historyLoad('sh_catalog');
  if (list.length === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
  container.innerHTML = '';
  container.style.display = 'block';
  const header = document.createElement('div');
  header.className = 'search-history-header';
  header.textContent = '最近の検索';
  container.appendChild(header);
  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'place-result-item search-history-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'result-source-icon';
    iconEl.textContent = '🕐';
    el.appendChild(iconEl);
    const nameEl = document.createElement('span');
    nameEl.className = 'place-result-name';
    nameEl.textContent = item;
    el.appendChild(nameEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'search-history-del';
    delBtn.setAttribute('aria-label', '履歴から削除');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      _historyDelete('sh_catalog', item);
      _showCatalogHistory();
    });
    el.appendChild(delBtn);
    el.addEventListener('click', () => {
      const inp = document.getElementById('catalog-search');
      if (inp) { inp.value = item; inp.dispatchEvent(new Event('input')); }
      container.style.display = 'none';
    });
    container.appendChild(el);
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

  // 地理院API（非同期）で地名検索
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
        msg.textContent = '見つかりませんでした';
        msg.style.color = '#c00';
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
          _historySave('sh_unified', item.properties.title);
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

// フォーカス時: 入力が空なら履歴を表示
document.getElementById('unified-search-input').addEventListener('focus', () => {
  const q = document.getElementById('unified-search-input').value.trim();
  if (!q) _showUnifiedHistory();
});

// 入力中のライブ検索（350ms デバウンス）+ クリアボタン表示制御
document.getElementById('unified-search-input').addEventListener('input', () => {
  updateClearBtn();
  clearTimeout(_searchTimer);
  const q = document.getElementById('unified-search-input').value.trim();
  if (!q) {
    _showUnifiedHistory();
    document.getElementById('unified-search-msg').textContent = '';
    return;
  }
  document.getElementById('unified-search-results').innerHTML = '';
  _searchTimer = setTimeout(searchPlace, 350);
});

// フォーカスを外したとき履歴を閉じる（候補クリックは mousedown で先に発火するため delay）
document.getElementById('unified-search-input').addEventListener('blur', () => {
  setTimeout(() => {
    const q = document.getElementById('unified-search-input').value.trim();
    if (!q) {
      document.getElementById('unified-search-results').innerHTML = '';
      document.getElementById('unified-search-msg').textContent = '';
    }
  }, 200);
});

// クリアボタン
document.getElementById('unified-search-clear').addEventListener('click', clearSearch);

/* ========================================================
    レイヤーパネル — 詳細ビューのイベントハンドラ
    ======================================================== */

// 戻るボタン
document.getElementById('layers-back-btn')?.addEventListener('click', () => {
  showLayersList();
});

// お気に入りボタン（ヘッダー右端）
document.getElementById('layers-fav-btn')?.addEventListener('click', () => {
  if (_layersDetailId === null) return; // 未分類はお気に入り対象外
  _toggleFavTerrain(_layersDetailId);
  _renderLayersDetail(_layersDetailId); // アイコン更新
  // 一覧ビューに戻ったときに反映されるよう list も再描画（非表示なので軽量）
  _renderLayersList();
});

// ---- クイックアクションボタン ----

// 画像を追加 → 既存の画像+JGW モーダルを開く（インポートモーダル経由）
document.getElementById('layers-qa-image')?.addEventListener('click', () => {
  const input = document.getElementById('map-import-input-top');
  if (input) input.click();
});

// GPXを追加 → 既存の GPX ファイル選択をトリガー
document.getElementById('layers-qa-gpx')?.addEventListener('click', () => {
  const input = document.getElementById('gpx-file-input');
  if (input) input.click();
});

// コース作成 → コースタブに切り替え
document.getElementById('layers-qa-course')?.addEventListener('click', () => {
  _openSidebarPanel('course');
});

/* ========================================================
    ファイル選択ボタンの制御
    ======================================================== */

// ---- ストレージ全消去ボタン ----
document.getElementById('storage-clear-btn')?.addEventListener('click', async () => {
  if (!confirm('ストレージに保存されたすべての地図を削除しますか？\n地図の表示データは失われます。')) return;
  try {
    await clearAllMapLayers();
    // localMapLayers から DB バック済みエントリを地図ごと削除する
    const toRemove = localMapLayers.filter(e => e.dbId != null).map(e => e.id);
    for (const id of toRemove) removeLocalMapLayer(id);
    _updateStorageInfoBar();
  } catch (e) {
    console.error('ストレージ消去エラー:', e);
    alert('ストレージの消去に失敗しました。');
  }
});

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
  if (file) { await loadGpx(file); renderExplorer(); }
  e.target.value = ''; // 同じファイルを再選択できるようにリセット
});

// ---- 視点切り替えボタン ----
document.getElementById('gpx-3d-btn').addEventListener('click', toggleGpx3dMode);

// ---- 再生/一時停止ボタン ----
document.getElementById('play-pause-btn').addEventListener('click', toggleGpxPlayPause);

// ---- シークバー（スクラブ）----
document.getElementById('seek-bar').addEventListener('input', (e) => {
  // スクラブ中は一時停止したままマーカーとカメラだけ更新する
  gpxState.currentTime = parseInt(e.target.value, 10);
  updateSeekBarGradient();
  updateTimeDisplay();

  const pos = interpolateGpxPosition(gpxState.currentTime);
  if (pos) {
    // シーク時は bearing をスナップ初期化して遅延なく即時追従させる
    gpxState.smoothedBearing = pos.bearing;
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

// ================================================================
// テレイン検索 UI
// ================================================================

const MAP_TYPE_JA_SEARCH = { sprint: 'スプリント', forest: 'フォレスト' };

/**
 * 検索結果テレインのカードリストを描画する
 * @param {Array} terrains
 */
async function renderTerrainSearchResults(terrains) {
  const res = document.getElementById('terrain-search-results');
  if (!res) return;
  res.innerHTML = '';

  if (terrains.length === 0) {
    res.innerHTML = '<div class="terrain-search-empty">該当するテレインが見つかりません</div>';
    return;
  }

  // ワークスペースに追加済みの公式テレイン ID セットを取得
  const wsTerrains = await getWsTerrains();
  const wsPublicIds = new Set(wsTerrains.filter(t => t.source === 'public').map(t => t.id));

  terrains.forEach(t => {
    const card = document.createElement('div');
    const isLocal = t.source === 'local';
    card.className = 'terrain-card' + (isLocal ? ' terrain-card-local' : '');

    const typeKey       = t.type ?? 'other';
    const typeLabelText = MAP_TYPE_JA_SEARCH[typeKey] ?? typeKey;
    const prefText      = t.prefecture ? escHtml(t.prefecture) : '';

    // ソースバッジ（公式 / ローカル）
    const sourceBadgeHtml = isLocal
      ? '<span class="terrain-source-badge terrain-source-local">ローカル</span>'
      : '<span class="terrain-source-badge terrain-source-public">公式</span>';

    // 追加ボタン: ローカルテレインは常に「ワークスペース表示」ボタン、公式は追加/追加済み
    const alreadyAdded = !isLocal && wsPublicIds.has(t.id);
    const actionHtml = isLocal
      ? `<button class="terrain-add-btn terrain-goto-btn" title="エクスプローラーで開く">→</button>`
      : `<button class="terrain-add-btn" ${alreadyAdded ? 'disabled title="追加済み"' : 'title="ワークスペースに追加"'}>${alreadyAdded ? '追加済' : '＋'}</button>`;

    card.innerHTML = `
      <div class="terrain-card-info">
        <div class="terrain-card-name">
          ${escHtml(t.name)}
          ${sourceBadgeHtml}
        </div>
        <div class="terrain-card-meta">
          ${prefText ? `<span class="terrain-card-pref">${prefText}</span>` : ''}
          <span class="terrain-type-badge ${escHtml(typeKey)}">${escHtml(typeLabelText)}</span>
        </div>
      </div>
      <div class="terrain-card-actions">
        ${actionHtml}
      </div>
    `;

    // カードホバー → 境界ハイライト
    card.addEventListener('mouseenter', () => { card.classList.add('hovered'); setHoverTerrain(map, t.id); });
    card.addEventListener('mouseleave', () => { card.classList.remove('hovered'); setHoverTerrain(map, null); });

    // カードクリック → 地図フライ
    card.addEventListener('click', e => {
      if (e.target.closest('.terrain-add-btn')) return;
      if (t.center) {
        map.easeTo({ center: t.center, zoom: Math.max(map.getZoom(), 12), duration: EASE_DURATION });
      }
    });

    const actionBtn = card.querySelector('.terrain-add-btn');
    if (isLocal) {
      // ローカルテレイン → エクスプローラータブへジャンプ
      actionBtn?.addEventListener('click', () => {
        _focusTerrainId = t.id;
        _explorerCollapsed[t.id] = false;
        _openSidebarPanel('layers');
        renderExplorer();
      });
    } else {
      // 公式テレイン → ワークスペースに追加 → エクスプローラータブへ切替
      actionBtn?.addEventListener('click', async () => {
        if (actionBtn.disabled) return;
        await saveWsTerrain({ ...t, source: 'public', visible: true });
        actionBtn.disabled = true;
        actionBtn.textContent = '追加済';
        const wsAll = await getWsTerrains();
        updateWorkspaceTerrainSource(map, wsAll);
        _focusTerrainId = t.id;
        _explorerCollapsed[t.id] = false;
        _openSidebarPanel('layers');
        await renderExplorer();
      });
    }

    res.appendChild(card);
  });
}

/**
 * ワークスペーステレイン一覧を描画する
 */
async function renderWorkspaceTerrainList() {
  const listEl = document.getElementById('workspace-terrain-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const terrains = await getWsTerrains();
  if (terrains.length === 0) {
    listEl.innerHTML = '<div class="tree-empty-hint">検索結果の「＋」でテレインを追加</div>';
    return;
  }

  terrains.forEach(t => {
    const row = document.createElement('div');
    row.className = 'ws-terrain-row' + (t.visible === false ? ' hidden-terrain' : '');

    const isVisible = t.visible !== false;

    row.innerHTML = `
      <button class="ws-terrain-eye${isVisible ? '' : ' hidden'}" title="${isVisible ? '非表示にする' : '表示する'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          ${isVisible
            ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'}
        </svg>
      </button>
      <span class="ws-terrain-name" title="${escHtml(t.name)}">${escHtml(t.name)}</span>
      <button class="ws-terrain-fly" title="この場所へ移動">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
      </button>
      <button class="ws-terrain-del" title="ワークスペースから削除">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>
      </button>
    `;

    // 目玉トグル
    row.querySelector('.ws-terrain-eye').addEventListener('click', async () => {
      const newVis = t.visible === false;
      await updateWsTerrainVisibility(t.id, newVis);
      t.visible = newVis;
      const all = await getWsTerrains();
      updateWorkspaceTerrainSource(map, all);
      renderWorkspaceTerrainList();
    });

    // フライボタン
    row.querySelector('.ws-terrain-fly').addEventListener('click', () => {
      if (t.center) map.easeTo({ center: t.center, zoom: Math.max(map.getZoom(), 12), duration: EASE_DURATION });
    });

    // 削除ボタン
    row.querySelector('.ws-terrain-del').addEventListener('click', async () => {
      await deleteWsTerrain(t.id);
      const all = await getWsTerrains();
      updateWorkspaceTerrainSource(map, all);
      renderWorkspaceTerrainList();
    });

    listEl.appendChild(row);
  });
}

// 起動時にワークスペーステレインを復元して描画
getWsTerrains().then(all => {
  if (all.length > 0) {
    map.once('idle', () => updateWorkspaceTerrainSource(map, all));
  }
  renderExplorer();
}).catch(() => {});

// ---- 地図カタログ: GeoJSON 読み込み ----
// ---- テレイン検索: 検索バー・チップフィルター ----
/** テレイン検索を外部から起動できるよう公開（タブ切り替え用） */
let _runTerrainSearch    = null;
/** 最後の検索結果キャッシュ — マップロード後にレイヤーへ反映するために保持 */
let _lastTerrainResults  = null;

(function () {
  let _searchTimer = null;
  let _activeType  = '';

  async function _runSearch() {
    const q    = (document.getElementById('catalog-search')?.value ?? '').trim();
    const res  = document.getElementById('terrain-search-results');
    if (!res) return;

    // ローディング表示
    res.innerHTML = '<div class="terrain-search-loading">検索中…</div>';

    const results = await searchTerrainsApi(q, { types: _activeType ? [_activeType] : [] });

    // マップがロード済みならレイヤーも更新、まだなら結果だけキャッシュ
    // （updateSearchTerrainSource は initTerrainLayers 後にしか呼べない）
    _lastTerrainResults = results;
    if (map.loaded()) updateSearchTerrainSource(map, results);

    renderTerrainSearchResults(results);
  }

  // 入力（デバウンス 300ms）
  document.getElementById('catalog-search')?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(_runSearch, 300);
  });

  // チップフィルター
  document.querySelectorAll('.map-type-chips .type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _activeType = chip.dataset.type;
      document.querySelectorAll('.map-type-chips .type-chip')
        .forEach(c => c.classList.toggle('active', c.dataset.type === _activeType));
      _runSearch();
    });
  });

  // タブ切り替え用に外部公開
  _runTerrainSearch = _runSearch;

  // マップロードを待たず即時に初回検索を実行（UIカードはすぐ表示）
  _runSearch();
})();

// ================================================================
// ローカルテレイン作成 — 地図上のポリゴン描画 + 名前入力
//
// テレインは複雑なポリゴン形状（矩形ではない）。
// クリックで頂点を追加、最初の頂点付近をクリックまたはダブルクリックで閉じる。
// Enter で確定。ESC / Backspace で操作。
// ================================================================

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let _drawing      = false;
  let _vertices     = [];   // [[lng, lat], ...]
  let _svgEl        = null;
  let _polyEl       = null; // 確定済みポリゴン面
  let _previewEl    = null; // カーソル追従プレビュー線
  let _snapCircle   = null; // 先頭頂点スナップ円
  let _dotEls       = [];   // 各頂点の点
  let _lastClickMs  = 0;    // ダブルクリック判定用

  const mapCanvas = map.getCanvas();

  /** ピクセル座標を取得（配列形式） */
  function _getPx(e) {
    const r = mapCanvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** 地理座標配列をピクセル配列に変換 */
  function _lngLatsToPx(coords) {
    return coords.map(([lng, lat]) => {
      const p = map.project([lng, lat]);
      return [p.x, p.y];
    });
  }

  /** SVG points 属性文字列 */
  function _ptsStr(pxArr) {
    return pxArr.map(([x, y]) => `${x},${y}`).join(' ');
  }

  /** SVG を再描画する */
  function _redrawSvg(cursorPx) {
    if (!_svgEl) return;
    const vPx = _lngLatsToPx(_vertices);

    // ポリゴン面（頂点 3 以上で閉じる）
    if (vPx.length >= 3) {
      _polyEl.setAttribute('points', _ptsStr([...vPx, vPx[0]]));
    } else if (vPx.length === 2) {
      _polyEl.setAttribute('points', _ptsStr(vPx));
    } else {
      _polyEl.setAttribute('points', '');
    }

    // カーソル追従プレビュー線
    if (cursorPx && vPx.length >= 1) {
      const last = vPx[vPx.length - 1];
      _previewEl.setAttribute('x1', last[0]); _previewEl.setAttribute('y1', last[1]);
      _previewEl.setAttribute('x2', cursorPx[0]); _previewEl.setAttribute('y2', cursorPx[1]);
    } else {
      _previewEl.setAttribute('x1', 0); _previewEl.setAttribute('y1', 0);
      _previewEl.setAttribute('x2', 0); _previewEl.setAttribute('y2', 0);
    }

    // 各頂点の点を再描画
    _dotEls.forEach(d => d.remove());
    _dotEls = [];
    vPx.forEach(([x, y]) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4);
      c.setAttribute('fill', '#16a34a');
      c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.5');
      _svgEl.appendChild(c);
      _dotEls.push(c);
    });

    // 先頭頂点スナップ円（頂点 3 以上のとき表示）
    if (vPx.length >= 3) {
      _snapCircle.setAttribute('cx', vPx[0][0]); _snapCircle.setAttribute('cy', vPx[0][1]);
      _snapCircle.setAttribute('display', 'block');
    } else {
      _snapCircle.setAttribute('display', 'none');
    }
  }

  /** ドローモードを開始する */
  function _startDrawMode() {
    _drawing  = true;
    _vertices = [];
    document.getElementById('add-local-terrain-btn')?.classList.add('active');
    mapCanvas.style.cursor = 'crosshair';
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.boxZoom.disable();

    const container = map.getContainer();
    _svgEl = document.createElementNS(SVG_NS, 'svg');
    _svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9000;';

    _polyEl = document.createElementNS(SVG_NS, 'polygon');
    _polyEl.setAttribute('fill', 'rgba(22,163,74,0.15)');
    _polyEl.setAttribute('stroke', '#16a34a');
    _polyEl.setAttribute('stroke-width', '2');
    _polyEl.setAttribute('stroke-dasharray', '6,3');
    _svgEl.appendChild(_polyEl);

    _previewEl = document.createElementNS(SVG_NS, 'line');
    _previewEl.setAttribute('stroke', '#16a34a');
    _previewEl.setAttribute('stroke-width', '1.5');
    _previewEl.setAttribute('stroke-dasharray', '4,4');
    _svgEl.appendChild(_previewEl);

    _snapCircle = document.createElementNS(SVG_NS, 'circle');
    _snapCircle.setAttribute('r', 10);
    _snapCircle.setAttribute('fill', 'rgba(22,163,74,0.2)');
    _snapCircle.setAttribute('stroke', '#16a34a');
    _snapCircle.setAttribute('stroke-width', '2');
    _snapCircle.setAttribute('display', 'none');
    _svgEl.appendChild(_snapCircle);

    container.appendChild(_svgEl);
    _showDrawHint('クリックで頂点を追加 / 最初の点に戻るかダブルクリックで完成 / Enter で確定 / ESC でキャンセル');
  }

  /** ドローモードを終了してリソースを解放する */
  function _endDrawMode() {
    _drawing  = false;
    _vertices = [];
    _dotEls   = [];
    mapCanvas.style.cursor = '';
    document.getElementById('add-local-terrain-btn')?.classList.remove('active');
    map.dragPan.enable();
    map.scrollZoom.enable();
    map.boxZoom.enable();
    _svgEl?.remove();
    _svgEl = null; _polyEl = null; _previewEl = null; _snapCircle = null;
    _hideDrawHint();
  }

  /** 描画ヒントバーを表示 */
  function _showDrawHint(msg) {
    let hint = document.getElementById('terrain-draw-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'terrain-draw-hint';
      hint.className = 'terrain-draw-hint';
      map.getContainer().appendChild(hint);
    }
    hint.textContent = msg;
  }

  /** 描画ヒントバーを非表示 */
  function _hideDrawHint() { document.getElementById('terrain-draw-hint')?.remove(); }

  /** 先頭頂点に近いか（12px 以内でスナップ）*/
  function _nearFirst(px) {
    if (_vertices.length < 3) return false;
    const fp = map.project(_vertices[0]);
    return Math.hypot(px[0] - fp.x, px[1] - fp.y) < 12;
  }

  /** ポリゴンを確定してダイアログへ */
  async function _finishPolygon() {
    if (_vertices.length < 3) { _endDrawMode(); return; }
    const coords = [..._vertices];
    _endDrawMode();
    await _showNameDialog(coords);
  }

  /** ローカルテレイン名入力ダイアログ */
  function _showNameDialog(polygonCoords) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'local-terrain-dialog-overlay';
      overlay.innerHTML = `
        <div class="local-terrain-dialog">
          <div class="local-terrain-dialog-title">ローカルテレインを作成</div>
          <label class="local-terrain-dialog-label">テレイン名
            <input id="ltd-name" type="text" class="local-terrain-dialog-input" placeholder="例: 地元の森" maxlength="60" />
          </label>
          <label class="local-terrain-dialog-label">都道府県（任意）
            <input id="ltd-pref" type="text" class="local-terrain-dialog-input" placeholder="例: 東京都" maxlength="20" />
          </label>
          <div class="local-terrain-dialog-btns">
            <button id="ltd-cancel" class="local-terrain-dialog-btn cancel">キャンセル</button>
            <button id="ltd-ok"     class="local-terrain-dialog-btn ok">作成</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const nameInput = overlay.querySelector('#ltd-name');
      const prefInput = overlay.querySelector('#ltd-pref');
      requestAnimationFrame(() => nameInput?.focus());

      async function _confirm() {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }

        // 重心を計算
        const sumLng = polygonCoords.reduce((s, [lng]) => s + lng, 0);
        const sumLat = polygonCoords.reduce((s, [, lat]) => s + lat, 0);
        const center = [sumLng / polygonCoords.length, sumLat / polygonCoords.length];

        // Bounding Box
        const lngs = polygonCoords.map(([lng]) => lng);
        const lats  = polygonCoords.map(([, lat]) => lat);
        const bbox  = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];

        // GeoJSON Polygon（閉じた ring）
        const boundary = {
          type: 'Polygon',
          coordinates: [[...polygonCoords, polygonCoords[0]]],
        };

        const id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        await saveWsTerrain({
          id, name,
          source:     'local',
          prefecture: prefInput.value.trim() || null,
          region:     null,
          type:       'other',
          tags:       [],
          center, bbox, boundary,
          visible:    true,
        });

        const wsAll = await getWsTerrains();
        updateWorkspaceTerrainSource(map, wsAll);
        _focusTerrainId = id;
        _explorerCollapsed[id] = false;
        _openSidebarPanel('layers');
        await renderExplorer();

        overlay.remove();
        resolve(true);
      }

      overlay.querySelector('#ltd-ok').addEventListener('click', _confirm);
      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') _confirm(); });
      overlay.querySelector('#ltd-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
      overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  // ── イベントリスナー ──

  document.getElementById('add-local-terrain-btn')?.addEventListener('click', () => {
    if (_drawing) { _endDrawMode(); return; }
    _startDrawMode();
  });

  mapCanvas.addEventListener('click', async e => {
    if (!_drawing) return;
    e.stopPropagation();

    const now = Date.now();
    const isDouble = (now - _lastClickMs) < 350;
    _lastClickMs = now;

    const px = _getPx(e);

    if (isDouble) {
      // ダブルクリック: 直前に追加した仮頂点を1つ除去して確定
      if (_vertices.length > 0) _vertices.pop();
      await _finishPolygon();
      return;
    }

    // 先頭頂点スナップ → 閉じる
    if (_nearFirst(px)) {
      await _finishPolygon();
      return;
    }

    // 頂点を追加
    const ll = map.unproject(px);
    _vertices.push([ll.lng, ll.lat]);
    _redrawSvg(px);
  });

  mapCanvas.addEventListener('mousemove', e => {
    if (!_drawing || _vertices.length === 0) return;
    _redrawSvg(_getPx(e));
  });

  document.addEventListener('keydown', async e => {
    if (!_drawing) return;
    if (e.key === 'Escape')    { _endDrawMode(); return; }
    if (e.key === 'Enter' && _vertices.length >= 3) { await _finishPolygon(); return; }
    if (e.key === 'Backspace' && _vertices.length > 0) {
      _vertices.pop();
      _redrawSvg(null);
    }
  });
})();

// ---- 地図クリック: 画像レイヤーのクリック判定（bbox の矩形範囲で判定）----
// raster レイヤーは queryRenderedFeatures 対象外のため bbox で代替する
map.on('click', (e) => {
  const { lng, lat } = e.lngLat;
  const hitImage = localMapLayers.find(entry =>
    entry.visible &&
    lng >= entry.bbox.west && lng <= entry.bbox.east &&
    lat >= entry.bbox.south && lat <= entry.bbox.north
  );
  if (hitImage) openLayersPanel(hitImage.terrainId);
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
  // relatedTarget が null（ブラウザ外からの drag）かつ Files を含む場合のみ表示
  if (e.dataTransfer.types.includes('Files') && e.relatedTarget === null) {
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
  // ファイルが含まれない drop（スライダードラッグ等のブラウザ誤検知）は無視する
  if (allFiles.length === 0) return;

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
  for (const file of gpxFiles) { await loadGpx(file); renderExplorer(); }

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
function updateSliderGradient(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', pct + '%');
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
      const decl = getDeclination(lat, lng);
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
      const decl    = getDeclination(lat, lng);
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
    return;
  }

  // zoom レベルに応じた有効間隔を取得
  const intervalM  = getEffectiveMagneticInterval();
  const intervalKm = intervalM / 1000;

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
  const refLat = Math.round(center.lat); // 最近傍整数度にスナップした基準緯度

  // 磁北線の基準点（refLat, center.lng）で偏角 θ を求め、
  // 線に垂直な方向の間隔が intervalM になるよう経度グリッド間隔を補正する。
  // 東西方向の実間隔は interval / cosθ に広げる必要がある。
  const declCenter = getDeclination(center.lat, center.lng);
  const declAtBase = getDeclination(refLat, center.lng);
  const latDiffKm   = Math.abs(refLat - center.lat) * EQ_KM_PER_DEG;
  const cosLat      = Math.max(0.01, Math.cos(center.lat * Math.PI / 180));
  const cosTheta    = Math.max(0.01, Math.abs(Math.cos(declAtBase * Math.PI / 180)));
  const dLng        = intervalKm / (EQ_KM_PER_DEG * cosLat * cosTheta);
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
      const decl    = getDeclination(lat, lng);
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
    attrInner.insertBefore(attrEl, attrInner.firstChild);
  }
  const attr = BASEMAPS[currentBasemap]?.attr;
  attrEl.innerHTML = attr ? attr + ' | ' : '';
}

function initAttributionObserver() {
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
  const csRegionalOn = (_csKey === 'cs' || _csKey === 'cs-0.5m') && map.getZoom() >= 16;
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

function updatePlateauAttribution() {
  let attrEl = document.getElementById('plateau-attr');
  if (!attrEl) {
    const attrInner = document.querySelector('.maplibregl-ctrl-attrib-inner');
    if (!attrInner) return;
    attrEl = document.createElement('span');
    attrEl.id = 'plateau-attr';
    attrInner.appendChild(attrEl);
  }
  const buildingOn = document.getElementById('building3d-card')?.classList.contains('active') ?? false;
  const mode       = document.getElementById('sel-building')?.value ?? 'plateau';
  const plateauLink = ' | <a href="https://www.mlit.go.jp/plateau/open-data/" target="_blank">国土交通省3D都市モデルPLATEAU</a>';
  const areaLabel = document.getElementById('plateau-area-label')?.textContent ?? '';
  attrEl.innerHTML = !buildingOn ? ''
    : mode === 'plateau'          ? plateauLink + '（<a href="https://github.com/shiwaku/mlit-plateau-bldg-pmtiles" target="_blank">shiwaku</a>加工）'
    : mode === 'plateau-lod2-api' ? plateauLink + (areaLabel && areaLabel !== '—' ? `（${areaLabel} LOD2）` : '（LOD2）')
    : mode === 'plateau-lod3-api' ? plateauLink + (areaLabel && areaLabel !== '—' ? `（${areaLabel} LOD3）` : '（LOD3）')
    : '';
}

// 磁北線モデル別の出典情報
const MAGNETIC_ATTRIBUTIONS = {
  wmm2020: '<a href="https://www.ngdc.noaa.gov/geomag/WMM/" target="_blank" rel="noopener">WMM2020/NOAA</a>を加工して作成',
  wmm2025: '<a href="https://www.ngdc.noaa.gov/geomag/WMM/" target="_blank" rel="noopener">WMM2025/NOAA</a>を加工して作成',
  gsi2020: '<a href="https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html" target="_blank" rel="noopener">国土地理院 地磁気値(2020.0年値)</a>を加工して作成',
};

/** 磁北線の出典表示を選択中モデルに合わせて更新する */
function updateMagneticAttribution() {
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

// ---- CS立体図 オーバーレイ制御 ----
// 0.5m モードはズーム17以上で地域CSを表示し、ズーム17未満は1mに自動フォールバック
let currentOverlay = 'none'; // 選択中のオーバーレイキー（'none' = オーバーレイなし）

function updateCsVisibility() {
  const basemap    = currentBasemap;
  const overlayOn  = currentOverlay !== 'none';
  const overlay    = currentOverlay;

  const sliderVal = parseFloat(document.getElementById('slider-cs').value);
  const z = map.getZoom();

  // 非選択の data-render レイヤーを非表示にする
  Object.keys(OVERLAY_DATA_CONFIGS).forEach(key => {
    if (key === overlay) return;
    const cfg = OVERLAY_DATA_CONFIGS[key];
    if (map.getLayer(cfg.maplibreLayerId)) {
      map.setLayoutProperty(cfg.maplibreLayerId, 'visibility', 'none');
    }
  });

  // 選択中のオーバーレイは data-render:// プロトコル経由で raster タイルを更新
  if (overlay in OVERLAY_DATA_CONFIGS) {
    scheduleDataOverlayDeckSync(overlay);
  }
  const showColorRelief     = overlay === 'color-relief';
  const showSlopeRelief     = overlay === 'slope';
  const showCurvatureRelief = overlay === 'curvature';
  const showRrimRelief      = overlay === 'rrim';
  if (map.getLayer('rrim-relief-layer')) {
    map.setLayoutProperty('rrim-relief-layer', 'visibility', showRrimRelief ? 'visible' : 'none');
    if (map.getLayer('rrim-qchizu-layer')) map.setLayoutProperty('rrim-qchizu-layer', 'visibility', showRrimRelief ? 'visible' : 'none');
    if (showRrimRelief) {
      map.setPaintProperty('rrim-relief-layer', 'raster-opacity', sliderVal);
      if (map.getLayer('rrim-qchizu-layer')) map.setPaintProperty('rrim-qchizu-layer', 'raster-opacity', sliderVal);
    }
  }
  // スライダーはカード選択だけで表示（オーバーレイトグルのON/OFFに依存しない）
  const crCtrls = document.getElementById('color-relief-controls');
  if (crCtrls) crCtrls.style.display = (currentOverlay === 'color-relief' || currentOverlay === 'color-contour') ? '' : 'none';
  if (currentOverlay === 'color-relief' || currentOverlay === 'color-contour') refreshColorReliefTrackLayout();
  const srCtrls = document.getElementById('slope-relief-controls');
  if (srCtrls) srCtrls.style.display = currentOverlay === 'slope' ? '' : 'none';
  if (currentOverlay === 'slope') refreshSlopeReliefTrackLayout();
  const cvCtrls = document.getElementById('curvature-relief-controls');
  if (cvCtrls) cvCtrls.style.display = currentOverlay === 'curvature' ? '' : 'none';
  if (currentOverlay === 'curvature') refreshCurvatureReliefTrackLayout();

  // 色別等高線の表示制御（contourState.demMode に応じて排他表示）
  const showColorContour = overlay === 'color-contour';
  const ccBaseVis = showColorContour ? 'visible' : 'none';
  COLOR_CONTOUR_Q_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'q1m') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM5A_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'dem5a') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM1A_IDS.forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'dem1a') ? 'visible' : 'none');
  });

  // CS立体図: 他の生成系オーバーレイ選択時は非表示
  const csOverlay = (showColorRelief || showColorContour || showSlopeRelief || showCurvatureRelief || showRrimRelief) ? 'none' : overlay;
  const csKey = csOverlay !== 'none' ? csOverlay
              : basemap.startsWith('cs-') ? basemap
              : null;

  // 'cs'（統合キー）または旧 'cs-0.5m'（ベースマップ用に残存）はプログレッシブ表示
  // z>=17 で 1m を下敷きにした上に 0.5m を重ねる。旧 'cs-1m' は 1m のみ。
  const show1m  = !!csKey && csKey !== 'none';
  const show05m = !!csKey && csKey !== 'cs-1m' && z >= 16;

  if (map.getLayer('cs-relief-layer')) {
    map.setLayoutProperty('cs-relief-layer', 'visibility', show1m ? 'visible' : 'none');
    if (map.getLayer('cs-qchizu-layer')) map.setLayoutProperty('cs-qchizu-layer', 'visibility', show1m ? 'visible' : 'none');
    if (show1m) {
      map.setPaintProperty('cs-relief-layer', 'raster-opacity', parseFloat(sliderCs.value));
      if (map.getLayer('cs-qchizu-layer')) map.setPaintProperty('cs-qchizu-layer', 'raster-opacity', parseFloat(sliderCs.value));
    }
  }
  REGIONAL_CS_LAYERS.forEach(layer => {
    if (map.getLayer(layer.layerId)) {
      map.setLayoutProperty(layer.layerId, 'visibility', show05m ? 'visible' : 'none');
      if (show05m) {
        map.setPaintProperty(layer.layerId, 'raster-opacity', parseFloat(sliderCs.value));
      }
    }
  });

  // 赤色立体図: rrim 選択時 z>=17 で地域DEMレイヤーを重ねる
  const showRrim05m = showRrimRelief && z >= 16;
  REGIONAL_RRIM_LAYERS.forEach(layer => {
    if (map.getLayer(layer.layerId)) {
      map.setLayoutProperty(layer.layerId, 'visibility', showRrim05m ? 'visible' : 'none');
      if (showRrim05m) {
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
  return isCsLayerVisible() || currentOverlay === 'color-relief' || currentOverlay === 'slope' || currentOverlay === 'curvature' || currentOverlay === 'rrim';
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
  updateShareableUrl();
  saveUiState();
  updateCsVisibility();
  // CS立体図・生成系オーバーレイ選択時はローディング表示（idle で非表示）
  if (currentOverlay === 'cs' || currentOverlay === 'color-relief' || currentOverlay === 'slope' || currentOverlay === 'curvature' || currentOverlay === 'rrim') showMapLoading();
  else hideMapLoading();
  // 色別標高図選択時はタイルを即座にリクエスト（visibility:none 中はMapLibreがフェッチしないため）
  // 自動フィット成功時は updateXReliefSource() 内で applyXTiles() が再呼び出しされるが、
  // 地形データ未ロード時のフォールバックとして先に applyXTiles() を実行しておく
  if (currentOverlay === 'color-relief') { applyColorReliefTiles(); autoFitColorRelief(); }
  if (currentOverlay === 'slope') { applySlopeReliefTiles(); autoFitSlopeRelief(); }
  if (currentOverlay === 'curvature') { applyCurvatureReliefTiles(); autoFitCurvatureRelief(); }
  // 色別等高線は visibility 変更後に再描画を明示的に発火させる必要がある
  if (currentOverlay === 'color-contour') map.triggerRepaint();
});

// （chk-overlay 削除のため、トグルイベントリスナーは不要）

// ズーム17の境界を跨いだとき 0.5m ↔ 1m を自動切替
map.on('zoomend', updateCsVisibility);

// ズーム変化時にオーバーレイを再同期（data-render:// の stops パラメータ更新）
map.on('zoomend', () => {
  if (currentOverlay in OVERLAY_DATA_CONFIGS) scheduleDataOverlayDeckSync(currentOverlay);
});

// ---- deck.gl 建物レイヤー: 地図移動・ズーム変更で位置連動自動更新 ----
function _onMapMoveForPlateau() {
  const mode = document.getElementById('sel-building')?.value ?? '';
  if (mode !== 'plateau-lod2-api' && mode !== 'plateau-lod3-api') return;
  if (!document.getElementById('building3d-card')?.classList.contains('active')) return;
  const lod = mode === 'plateau-lod2-api' ? 2 : 3;
  // デバウンス: 連続移動中は最後の moveend から 300ms 後に実行
  clearTimeout(_plateauAutoTimer);
  _plateauAutoTimer = setTimeout(() => _autoShowPlateauByPosition(lod), 300);
}
map.on('moveend', _onMapMoveForPlateau);
map.on('zoomend', _onMapMoveForPlateau);


// ---- 色別標高図 デュアルレンジスライダー ----
// 現在の min/max 値
let crMin = 0;
let crMax = 500;

function refreshColorReliefTrackLayout() {
  const crCtrls = document.getElementById('color-relief-controls');
  if (!crCtrls || crCtrls.style.display === 'none') return;
  updateGradientTrack();
  const track = document.querySelector('.cr-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => {
      updateGradientTrack();
    });
  }
}

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

// 現在選択中のパレット ID（色別標高図・傾斜・曲率それぞれ独立）
let crPaletteId = 'rainbow';
let srPaletteId = 'rainbow';
let cvPaletteId = 'rainbow';

// パレット ID → stops を返すヘルパー（存在しない場合は rainbow にフォールバック）
function getReliefPalette(id) {
  return (RELIEF_PALETTES.find(p => p.id === id) ?? RELIEF_PALETTES[0]).stops;
}

// パレット stops から CSS グラデーション文字列を生成
function paletteGradientCss(stops) {
  return `linear-gradient(to right, ${stops.map(p => `rgb(${p.r},${p.g},${p.b}) ${(p.t * 100).toFixed(1)}%`).join(', ')})`;
}

// グラデーショントラック共通描画ヘルパー
// trackEl: .cr-gradient-track 相当要素, selectedEl: .cr-selected-track 相当要素
// valMin/valMax: 現在の min/max 値, sliderMin/sliderMax: スライダーの範囲, palette: stops 配列
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

// 色別標高図トラック更新
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

// タイル再フェッチのデバウンスタイマー（updateColorReliefSource での clearTimeout 用に残す）
let _crTileTimer = null;
// input 中の色別等高線更新スロットル（100ms）
let _crThrottleTime = 0;

// 色別等高線の line-color を crMin/crMax/パレットに合わせて再設定
function updateColorContourColors() {
  const expr = buildColorContourExpr(crMin, crMax, getReliefPalette(crPaletteId));
  [...COLOR_CONTOUR_Q_IDS, ...COLOR_CONTOUR_DEM5A_IDS, ...COLOR_CONTOUR_DEM1A_IDS].forEach(id => {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', expr);
  });
}

// タイル URL を更新して地図に反映（data-render:// 経由）
function applyColorReliefTiles() {
  if (currentOverlay === 'color-relief') scheduleDataOverlayDeckSync('color-relief');
}

// ドラッグ中は UI を即座に更新し、RAF デバウンスでタイルを更新（傾斜・曲率と同じ挙動）
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
  const trackWrap  = document.querySelector('.cr-dual-track');
  const selected   = document.getElementById('cr-selected-track');
  const minHit     = document.getElementById('cr-selected-min-hit');
  const maxHit     = document.getElementById('cr-selected-max-hit');
  const moveHit    = document.getElementById('cr-selected-move-hit');
  const minSlider = document.getElementById('cr-min-slider');
  const maxSlider = document.getElementById('cr-max-slider');
  const minInput  = document.getElementById('cr-min-input');
  const maxInput  = document.getElementById('cr-max-input');
  if (!minSlider || !maxSlider) return;

  // ── スライダー: ドラッグ中は UI 即時更新 + 1秒スロットルでタイル更新、離したときに確定 ──
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
        if (crMin < lo) {
          crMin = lo;
          crMax = lo + span;
        }
        if (crMax > hi) {
          crMax = hi;
          crMin = hi - span;
        }
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

    [ [minHit, 'min'], [maxHit, 'max'], [moveHit, 'move'] ].forEach(([el, mode]) => {
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
    selected.addEventListener('lostpointercapture', () => {
      finishDrag();
    });
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

// ================================================================
// DEMタイル直接サンプリング（queryTerrainElevation 不使用・3D地形有効化不要）
// tileSize:256 設定に合わせて fetchZoom = round(viewZoom + 1)、上限z15
// ================================================================

function _demFetchZoom() {
  return Math.min(15, Math.round(map.getZoom() + 1));
}

// lng/lat → タイル座標 (z, x, y)
function _lngLatToTileXY(lng, lat, z) {
  const n = 1 << z;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

// lng/lat → タイル内ピクセル座標
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

// タイル ImageData のキャッシュ（同一サンプリング内の重複 fetch を排除）
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

// lngLat の標高を DEM タイルから直接取得
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

// 傾斜角（度）を DEM 直接サンプリングで計算
async function _estimateSlopeDirect(px, py, z, deltaPx) {
  const canvas = map.getCanvas();
  if (px + deltaPx >= canvas.offsetWidth || py + deltaPx >= canvas.offsetHeight) return null;
  const p00 = map.unproject([px, py]);
  const p10 = map.unproject([px + deltaPx, py]);
  const p01 = map.unproject([px, py + deltaPx]);
  const [h00, h10, h01] = await Promise.all([
    _demElevationAt(p00, z), _demElevationAt(p10, z), _demElevationAt(p01, z),
  ]);
  if (h00 == null || h10 == null || h01 == null) return null;
  const dX = turf.distance(turf.point([p00.lng, p00.lat]), turf.point([p10.lng, p10.lat]), { units: 'kilometers' }) * 1000;
  const dY = turf.distance(turf.point([p00.lng, p00.lat]), turf.point([p01.lng, p01.lat]), { units: 'kilometers' }) * 1000;
  if (!(dX > 0) || !(dY > 0)) return null;
  return Math.atan(Math.sqrt(((h00 - h10) / dX) ** 2 + ((h00 - h01) / dY) ** 2)) * 180 / Math.PI;
}

// 曲率を DEM 直接サンプリングで計算（estimateScreenCurvature と同一の cc 正規化を適用）
async function _estimateCurvatureDirect(px, py, z, deltaPx) {
  const canvas = map.getCanvas();
  if (px - deltaPx < 0 || px + deltaPx >= canvas.offsetWidth ||
      py - deltaPx < 0 || py + deltaPx >= canvas.offsetHeight) return null;
  const pC = map.unproject([px, py]);
  const pR = map.unproject([px + deltaPx, py]);
  const pL = map.unproject([px - deltaPx, py]);
  const pD = map.unproject([px, py + deltaPx]);
  const pU = map.unproject([px, py - deltaPx]);
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
  const pixelLength = 156543.04 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom()) * 0.5;
  const cc = pixelLength < 68 ? Math.max(pixelLength / 2, 1.1) : 0.188 * Math.pow(pixelLength, 1.232);
  return laplacian / cc;
}

async function autoFitColorRelief() {
  const GRID = map.getZoom() <= 9 ? 10 : 20;
  const z = _demFetchZoom();
  const canvas = map.getCanvas();
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  const promises = [];
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      promises.push(_demElevationAt(map.unproject([(c + 0.5) / GRID * w, (r + 0.5) / GRID * h]), z));
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

// ---- 色別傾斜 デュアルレンジスライダー ----
let srMin = 0;
let srMax = 45;

function refreshSlopeReliefTrackLayout() {
  const srCtrls = document.getElementById('slope-relief-controls');
  if (!srCtrls || srCtrls.style.display === 'none') return;
  updateSlopeGradientTrack();
  const track = document.getElementById('sr-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => {
      updateSlopeGradientTrack();
    });
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

let _srTileTimer = null;
let _srRepaintTimer = null;
let _srDragTileTime = 0; // ドラッグ中タイル更新スロットル（1秒に1回）

function applySlopeReliefTiles() {
  scheduleSlopeDeckSync();
}

function updateSlopeReliefUI() {
  syncSlopeReliefUI();
  updateSlopeGradientTrack();
  scheduleSlopeDeckSync();
}

function updateSlopeReliefSource() {
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
        if (srMin < lo) {
          srMin = lo;
          srMax = lo + span;
        }
        if (srMax > hi) {
          srMax = hi;
          srMin = hi - span;
        }
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
    selected.addEventListener('lostpointercapture', () => {
      finishDrag();
    });
  }

  updateSlopeReliefSource();
})();


async function autoFitSlopeRelief() {
  const GRID = map.getZoom() <= 9 ? 10 : 20;
  const z = _demFetchZoom();
  const canvas = map.getCanvas();
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

// ---- 色別曲率 デュアルレンジスライダー ----
// CS立体図の曲率レイヤー（L2/L4）と同じスケールに合わせたデフォルト範囲
let cvMin = -0.05;
let cvMax =  0.05;

function refreshCurvatureReliefTrackLayout() {
  const cvCtrls = document.getElementById('curvature-relief-controls');
  if (!cvCtrls || cvCtrls.style.display === 'none') return;
  updateCurvatureGradientTrack();
  const track = document.getElementById('cv-gradient-track');
  if ((track?.offsetWidth ?? 0) === 0) {
    requestAnimationFrame(() => {
      updateCurvatureGradientTrack();
    });
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

let _cvTileTimer = null;
let _cvRepaintTimer = null;
let _cvDragTileTime = 0; // ドラッグ中タイル更新スロットル（1秒に1回）

function applyCurvatureReliefTiles() {
  if (currentOverlay === 'curvature') scheduleDataOverlayDeckSync('curvature');
}

function updateCurvatureReliefUI() {
  syncCurvatureReliefUI();
  updateCurvatureGradientTrack();
  if (currentOverlay === 'curvature') scheduleDataOverlayDeckSync('curvature');
}

function updateCurvatureReliefSource() {
  syncCurvatureReliefUI();
  updateCurvatureGradientTrack();
  clearTimeout(_cvTileTimer);
  if (currentOverlay === 'curvature') scheduleDataOverlayDeckSync('curvature');
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
    selected.addEventListener('lostpointercapture', () => {
      finishDrag();
    });
  }

  updateCurvatureReliefSource();
})();

// ---- 色別曲率: 表示範囲から自動フィット ----
async function autoFitCurvatureRelief() {
  const GRID = map.getZoom() <= 9 ? 8 : 15;
  const z = _demFetchZoom();
  const canvas = map.getCanvas();
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  // deltaPx: グリッドサイズに対応した有限差分幅（小さすぎると noisy）
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
  // 余白 10% を加えてスライダー上限内に収める
  const margin = Math.max((globalMax - globalMin) * 0.1, step);
  cvMin = Math.max(-0.1, Math.round((globalMin - margin) / step) * step);
  cvMax = Math.min( 0.1, Math.round((globalMax + margin) / step) * step);
  if (cvMax <= cvMin) cvMax = Math.min(0.1, cvMin + step);
  updateCurvatureReliefSource();
}

document.getElementById('cv-autofit-btn')?.addEventListener('click', autoFitCurvatureRelief);

// ---- CS立体図 透明度スライダー（全国・地域別共通） ----
const sliderCs = document.getElementById('slider-cs');
updateSliderGradient(sliderCs);

sliderCs.addEventListener('input', () => {
  const v = parseFloat(sliderCs.value);
  updateSliderGradient(sliderCs);
  if (map.getLayer('cs-relief-layer')) {
    map.setPaintProperty('cs-relief-layer', 'raster-opacity', v);
    if (map.getLayer('cs-qchizu-layer')) map.setPaintProperty('cs-qchizu-layer', 'raster-opacity', v);
  }
  REGIONAL_CS_LAYERS.forEach(layer => {
    if (map.getLayer(layer.layerId)) {
      map.setPaintProperty(layer.layerId, 'raster-opacity', v);
    }
  });
  // 色別標高図・傾斜図・色別曲率図は data-render:// 経由（opacity は raster-opacity で制御）
  if (currentOverlay === 'color-relief') scheduleDataOverlayDeckSync('color-relief');
  if (currentOverlay === 'slope') scheduleSlopeDeckSync();
  if (currentOverlay === 'rrim' && map.getLayer('rrim-relief-layer')) {
    map.setPaintProperty('rrim-relief-layer', 'raster-opacity', v);
    if (map.getLayer('rrim-qchizu-layer')) map.setPaintProperty('rrim-qchizu-layer', 'raster-opacity', v);
  }
  if (currentOverlay === 'curvature') scheduleDataOverlayDeckSync('curvature');
  if (currentOverlay === 'rrim') {
    REGIONAL_RRIM_LAYERS.forEach(layer => {
      if (map.getLayer(layer.layerId)) map.setPaintProperty(layer.layerId, 'raster-opacity', v);
    });
  }
  updateShareableUrl();
  saveUiState();
  });


// ---- deck.gl 遅延ロード（PLATEAU LOD2/LOD3 選択時のみ読み込む）----
// deck.gl v9 は luma.gl v9 の頂点属性バリデーション (size: 1) で PLATEAU b3dm が読めない
// ため、安定動作する v8.9 系を使用する。

// ---- PLATEAU 公式 API から建物モデルデータを動的取得 ----
// API: https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets?type=bldg&format=3dtiles
// キャッシュしてセッション中の重複リクエストを防ぐ
const PLATEAU_API_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets?type=bldg&format=3dtiles';
const PLATEAU_GEOID_API_URL_2011 = 'https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh2011/cgi/geoidcalc.pl';
let _plateauApiCache = null; // { lod2: [...], lod3: [...] } | null
const _plateauGeoidCache = new Map(); // key: "lat,lng"（小数第3位丸め） -> geoidHeight(m)

async function _fetchPlateauDatasets() {
  if (_plateauApiCache) return _plateauApiCache;
  const res = await fetch(PLATEAU_API_URL);
  if (!res.ok) throw new Error('PLATEAU API fetch failed: ' + res.status);
  const json = await res.json();
  const datasets = json.datasets ?? json;
  const lod2 = datasets.filter(d => String(d.lod) === '2');
  const lod3 = datasets.filter(d => String(d.lod) === '3');
  console.log(`PLATEAU API: 全${datasets.length}件 LOD2=${lod2.length}件 LOD3=${lod3.length}件`);
  _plateauApiCache = { lod2, lod3 };
  return _plateauApiCache;
}

// ---- PLATEAU 位置連動：逆ジオコーダーで地図中心の市区町村を特定して自動表示 ----
// 地理院逆ジオコーダー API（市区町村コード・名称を返す）
const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

// 現在表示中の PLATEAU データ状態
_plateauCurrentLod = _plateauCurrentLod ?? null; // 最後に表示した lod（2 or 3）
_plateauCurrentDatasetSignature = _plateauCurrentDatasetSignature ?? ''; // 最後に表示した tileset 群の署名
_plateauCurrentGeoidSignature = _plateauCurrentGeoidSignature ?? ''; // 最後に適用したジオイド高署名
let _plateauAutoTimer       = null; // moveend デバウンスタイマー

// 地域ラベルを更新する
function _updatePlateauAreaLabel(text) {
  const el = document.getElementById('plateau-area-label');
  if (el) el.innerHTML = text || '—';
}

// PLATEAU エリアラベルの表示/非表示
function _showPlateauAreaLabel() {
  const el = document.getElementById('plateau-area-label');
  if (el) el.style.display = '';
}
function _hidePlateauAreaLabel() {
  const el = document.getElementById('plateau-area-label');
  if (el) el.style.display = 'none';
}

function _getApproxJapaneseGeoidHeight(latDeg) {
  return latDeg >= 41 ? 31
    : latDeg >= 38 ? 35
    : latDeg >= 34 ? 38
    : 37;
}

function _getPlateauGeoidCacheKey(lng, lat) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function _extractGeoidHeightValue(payload) {
  if (payload == null) return null;
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const found = _extractGeoidHeightValue(value);
      if (Number.isFinite(found)) return found;
    }
    return null;
  }
  if (typeof payload === 'object') {
    const direct = Number(payload.geoidHeight);
    if (Number.isFinite(direct)) return direct;
    for (const value of Object.values(payload)) {
      const found = _extractGeoidHeightValue(value);
      if (Number.isFinite(found)) return found;
    }
  }
  return null;
}

async function _fetchPlateauGeoidHeight(lng, lat) {
  const cacheKey = _getPlateauGeoidCacheKey(lng, lat);
  if (_plateauGeoidCache.has(cacheKey)) return _plateauGeoidCache.get(cacheKey);

  const params = new URLSearchParams({
    outputType: 'json',
    latitude: lat.toFixed(8),
    longitude: lng.toFixed(8),
  });
  const res = await fetch(`${PLATEAU_GEOID_API_URL_2011}?${params.toString()}`);
  if (!res.ok) throw new Error(`ジオイド高 API fetch failed: ${res.status}`);
  const payload = await res.json();
  const geoidHeight = _extractGeoidHeightValue(payload);
  if (!Number.isFinite(geoidHeight)) {
    throw new Error('ジオイド高 API の応答から geoidHeight を取得できませんでした');
  }
  _plateauGeoidCache.set(cacheKey, geoidHeight);
  return geoidHeight;
}

function _resetPlateauDeckState() {
  _plateauCurrentLod = null;
  _plateauCurrentDatasetSignature = '';
  _plateauCurrentGeoidSignature = '';
}

// 地図中心の市区町村コードを地理院逆ジオコーダーで取得
// 返り値: { muniCd: "13101", lv01Nm: "千代田区" } | null
async function _reverseGeocode(lng, lat) {
  const url = `${GSI_REVERSE_URL}?lat=${lat}&lon=${lng}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const result = json.results ?? null;
  console.log('逆ジオコーダー結果:', result);
  return result;
}

function _getPlateauGridSamplePoints() {
  const bounds = map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const lngs = [west, (west + east) / 2, east];
  const lats = [south, (south + north) / 2, north];
  const points = [];
  for (const lat of lats) {
    for (const lng of lngs) {
      points.push({ lng, lat });
    }
  }
  return points;
}

function _findPlateauDatasetEntry(datasets, muniCd) {
  return datasets.find(d => String(d.city_code) === muniCd)
      ?? datasets.find(d => d.ward_code && String(d.ward_code) === muniCd)
      ?? datasets.find(d => String(d.city_code) === muniCd.slice(0, 4) + '0' && !d.ward);
}

function _buildPlateauAreaSummary(entries) {
  if (!entries.length) return '対象地域外';
  const labels = entries.map(({ entry }) => `${entry.pref} ${entry.ward ? `${entry.city} ${entry.ward}` : entry.city}`);
  return labels.join('<br>');
}

// 市区町村コード（5桁）でPLATEAUデータセットを検索して表示
async function _autoShowPlateauByPosition(lod) {
  if (!document.getElementById('building3d-card')?.classList.contains('active')) return;
  if (map.getZoom() < 15) {
    _deckPlateauLayers = [];
    _commitDeckLayers();
    _resetPlateauDeckState();
    _updatePlateauAreaLabel('ズーム15以上で表示');
    return;
  }
  try {
    const samplePoints = _getPlateauGridSamplePoints();
    const cache = await _fetchPlateauDatasets();
    const datasets = lod === 2 ? cache.lod2 : cache.lod3;

    // ① 9点を並列で逆ジオコーディング
    const reverseResults = await Promise.all(samplePoints.map(async (point) => {
      const geo = await _reverseGeocode(point.lng, point.lat);
      if (!geo?.muniCd) return null;
      const muniCd = String(geo.muniCd).padStart(5, '0');
      const entry = _findPlateauDatasetEntry(datasets, muniCd);
      if (!entry) return null;
      let geoidHeight;
      try {
        geoidHeight = await _fetchPlateauGeoidHeight(point.lng, point.lat);
      } catch (geoidError) {
        geoidHeight = _getApproxJapaneseGeoidHeight(point.lat);
        console.warn('PLATEAU ジオイド高 API 取得失敗。概算値で補正します:', geoidError);
      }
      return { point, muniCd, entry, geoidHeight };
    }));

    const grouped = new Map();
    for (const result of reverseResults) {
      if (!result) continue;
      const key = result.entry.url;
      if (!grouped.has(key)) {
        grouped.set(key, { entry: result.entry, muniCodes: new Set(), geoidHeights: [] });
      }
      const item = grouped.get(key);
      item.muniCodes.add(result.muniCd);
      item.geoidHeights.push(result.geoidHeight);
    }

    const matchedEntries = Array.from(grouped.values()).map((item) => ({
      entry: item.entry,
      muniCodes: Array.from(item.muniCodes).sort(),
      geoidHeight: item.geoidHeights.reduce((sum, value) => sum + value, 0) / item.geoidHeights.length,
    })).sort((a, b) => a.entry.url.localeCompare(b.entry.url));

    if (!matchedEntries.length) {
      _deckPlateauLayers = [];
      _commitDeckLayers();
      _resetPlateauDeckState();
      _updatePlateauAreaLabel(`データなし（LOD${lod}）`);
      updatePlateauAttribution();
      return;
    }

    const datasetSignature = matchedEntries.map(({ entry, muniCodes }) => `${entry.url}|${muniCodes.join(',')}`).join('||');
    const geoidSignature = matchedEntries.map(({ entry, geoidHeight }) => `${entry.url}|${geoidHeight.toFixed(2)}`).join('||');

    if (lod === _plateauCurrentLod
      && datasetSignature === _plateauCurrentDatasetSignature
      && geoidSignature === _plateauCurrentGeoidSignature) {
      _updatePlateauAreaLabel(_buildPlateauAreaSummary(matchedEntries));
      return;
    }

    // ② 必要な tileset 群をまとめて表示
    _plateauCurrentLod = lod;
    _plateauCurrentDatasetSignature = datasetSignature;
    _plateauCurrentGeoidSignature = geoidSignature;
    _updatePlateauAreaLabel(_buildPlateauAreaSummary(matchedEntries));
    await _applyDeckTile3D(matchedEntries);
    updatePlateauAttribution();

  } catch (e) {
    console.error('PLATEAU 自動取得失敗:', e);
    _updatePlateauAreaLabel('取得エラー: ' + (e?.message ?? e));
  }
}

// LOD2/LOD3 モードに切り替えたときにエリアラベルを表示して位置から検索
async function _initPlateauAutoMode(lod) {
  _showPlateauAreaLabel();
  _updatePlateauAreaLabel('取得中…');
  // LOD が変わった場合はキャッシュを無効化して再検索
  if (lod !== _plateauCurrentLod) {
    _resetPlateauDeckState();
  }
  await _autoShowPlateauByPosition(lod);
}

var _deckOverlay = null; // deck.MapboxOverlay インスタンス（PLATEAU 専用）
var _deckPlateauLayers = []; // PLATEAU 用 deck.gl レイヤー群

function _commitDeckLayers() {
  if (!_deckOverlay) return;
  _deckOverlay.setProps({ layers: [..._deckPlateauLayers] });
}

// ================================================================
// オーバーレイ別設定マップ
//   各データタイルプロトコルの共通パラメータをここで一元管理する。
//   新しいオーバーレイを追加する場合はここにエントリを足すだけでよい。
// ================================================================
const OVERLAY_DATA_CONFIGS = {
  slope: {
    dataMin:        SLOPE_DATA_MIN,
    dataMax:        SLOPE_DATA_MAX,
    getRenderMin:   () => srMin,
    getRenderMax:   () => srMax,
    getPaletteStops: () => getReliefPalette(srPaletteId),
    generateTile:   generateSlopeDataTile,
    regionalLayers: REGIONAL_SLOPE_LAYERS,
    // MapLibre raster ソース ID（map.on('load') で既に addSource 済み）
    maplibreSourceId: 'slope-relief',
    maplibreLayerId:  'slope-relief-layer',
    // 数値タイル URL テンプレート（fetchDataTileCached に渡す paramsUrl 生成用）
    qBaseUrl:       () => `slope-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:      (tileUrl) => tileUrl.replace(/^dem2slope:\/\//, 'slope-data://').replace(/\?.*$/, ''),
    maxZoomBase:    15,
  },
  'color-relief': {
    dataMin:        RELIEF_DATA_MIN,
    dataMax:        RELIEF_DATA_MAX,
    getRenderMin:   () => crMin,
    getRenderMax:   () => crMax,
    getPaletteStops: () => getReliefPalette(crPaletteId),
    generateTile:   generateReliefDataTile,
    regionalLayers: REGIONAL_RELIEF_LAYERS,
    maplibreSourceId: 'color-relief',
    maplibreLayerId:  'color-relief-layer',
    qBaseUrl:       () => `relief-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:      (tileUrl) => tileUrl.replace(/^dem2relief:\/\//, 'relief-data://').replace(/\?.*$/, ''),
    maxZoomBase:    15,
  },
  curvature: {
    dataMin:        CURVE_DATA_MIN,
    dataMax:        CURVE_DATA_MAX,
    getRenderMin:   () => cvMin,
    getRenderMax:   () => cvMax,
    getPaletteStops: () => getReliefPalette(cvPaletteId),
    generateTile:   generateCurveDataTile,
    regionalLayers: REGIONAL_CURVE_LAYERS,
    maplibreSourceId: 'curvature-relief',
    maplibreLayerId:  'curvature-relief-layer',
    qBaseUrl:       () => `curve-data://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`,
    toDataUrl:      (tileUrl) => tileUrl.replace(/^dem2curve:\/\//, 'curve-data://').replace(/\?.*$/, ''),
    maxZoomBase:    15,
  },
};

// ================================================================
// 汎用データオーバーレイ MapLibre raster 同期
//   MapLibre の既存 raster ソース（slope-relief 等）の tiles を
//   slope-render://{z}/{x}/{y}?overlayKey=slope&min=...&max=...&palette=...
//   に差し替えることで、プロトコルハンドラ側でキャッシュ+色塗りを行う。
// ================================================================
function scheduleDataOverlayDeckSync(overlayKey) {
  // RAF でデバウンス（連続呼び出しを1フレームにまとめる）
  if (!scheduleDataOverlayDeckSync._rafs) scheduleDataOverlayDeckSync._rafs = {};
  const rafs = scheduleDataOverlayDeckSync._rafs;
  if (rafs[overlayKey]) cancelAnimationFrame(rafs[overlayKey]);
  rafs[overlayKey] = requestAnimationFrame(() => {
    rafs[overlayKey] = 0;
    _applyDataOverlayRasterTiles(overlayKey);
  });
}

// 後方互換エイリアス
function scheduleSlopeDeckSync() { scheduleDataOverlayDeckSync('slope'); }

function _applyDataOverlayRasterTiles(overlayKey) {
  const cfg = OVERLAY_DATA_CONFIGS[overlayKey];
  if (!cfg) return;

  const opacity   = parseFloat(document.getElementById('slider-cs')?.value ?? '1');
  const renderMin = cfg.getRenderMin();
  const renderMax = cfg.getRenderMax();
  const stops     = cfg.getPaletteStops();
  // stops を JSON で URL に乗せる（プロトコルハンドラで復元）
  const stopsParam = encodeURIComponent(JSON.stringify(stops));

  const makeTileUrl = (suffix = '') =>
    `data-render://${overlayKey}/{z}/{x}/{y}?min=${renderMin}&max=${renderMax}&dataMin=${cfg.dataMin}&dataMax=${cfg.dataMax}&stops=${stopsParam}${suffix}`;

  const src = map.getSource(cfg.maplibreSourceId);
  if (src) {
    src.setTiles([makeTileUrl()]);
    map.setPaintProperty(cfg.maplibreLayerId, 'raster-opacity', opacity);
    map.setLayoutProperty(cfg.maplibreLayerId, 'visibility', 'visible');
  }
}

// deck.gl v8.9 + loaders.gl v3 は index.html で事前読み込み済み
// window.deck の存在を確認するだけで済む（動的ロード不要）
async function _loadDeckGl() {
  if (window.deck) return;
  // 万一 window.deck が未定義の場合は次フレームまで待機して再確認
  await new Promise(r => requestAnimationFrame(r));
  if (!window.deck) throw new Error('deck.gl の読み込みに失敗しました');
}

function _initDeckOverlay() {
  if (_deckOverlay || !window.deck) return;
  // interleaved: true で deck.gl を MapLibre の WebGL パイプライン内に挿入する。
  _deckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(_deckOverlay);
  _commitDeckLayers();
}



// 指定 tileset.json URL の PLATEAU 3D Tiles を deck.gl で表示する汎用関数
// （LOD2・LOD3 共用。visible=false で非表示）
async function _applyDeckTile3D(tilesetEntries) {
  if (!tilesetEntries?.length) {
    _deckPlateauLayers = [];
    _commitDeckLayers();
    return;
  }
  showMapLoading();
  try {
    await _loadDeckGl();
    _initDeckOverlay();
    let remainingTilesets = tilesetEntries.length;
    _deckPlateauLayers = tilesetEntries.map(({ entry, geoidHeight }, index) => new deck.Tile3DLayer({
          id: `plateau-lod-${index}`,
          data: entry.url,
          loader: window.loaders?.Tiles3DLoader,
          opacity: 0.8,
          pointSize: 1,
          // PBR ライティングを無効化してテクスチャ色をフラットに描画
          _subLayerProps: {
            scenegraph: { _lighting: 'flat' },
          },
          onTilesetLoad: (tileset) => {
            const waitUntilLoaded = () => {
              if (tileset.isLoaded) {
                remainingTilesets -= 1;
                if (remainingTilesets <= 0) hideMapLoading();
                return;
              }
              requestAnimationFrame(waitUntilLoaded);
            };
            requestAnimationFrame(waitUntilLoaded);
          },
          // PLATEAU は楕円体高で、地形は標高ベースのためジオイド高分だけ下げる
          onTileLoad: (tile) => {
            if (tile.content?.cartographicOrigin) {
              const o = tile.content.cartographicOrigin;
              tile.content.cartographicOrigin = new Float64Array([o[0], o[1], o[2] - geoidHeight]);
            }
          },
        }));
    _commitDeckLayers();
  } catch (e) {
    hideMapLoading();
    console.error('PLATEAU 3D Tiles の表示に失敗:', e);
  }
}

// ---- 3D建物レイヤー切替 ----
/* 建物モード:
   'ofm'              OpenFreeMap（MapLibre fill-extrusion）
   'plateau'          PLATEAU LOD1 全国（MapLibre fill-extrusion）
   'plateau-lod2-api' PLATEAU LOD2 API動的取得（deck.gl Tile3DLayer）
   'plateau-lod3-api' PLATEAU LOD3 API動的取得（deck.gl Tile3DLayer）
   3D地形の ON/OFF とは独立して制御可能。 */
var BUILDING_CFG = {
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
  const buildingOn = document.getElementById('building3d-card')?.classList.contains('active') ?? true;

  // 既存 MapLibre レイヤーを一旦削除
  if (map.getLayer('building-3d')) map.removeLayer('building-3d');

  // PLATEAU LOD2/LOD3 API モード: 地図位置から自動取得して deck.gl で描画
  if (mode === 'plateau-lod2-api' || mode === 'plateau-lod3-api') {
    const lod = mode === 'plateau-lod2-api' ? 2 : 3;
    if (!buildingOn) {
      _deckPlateauLayers = [];
      _commitDeckLayers();
      _resetPlateauDeckState();
      _hidePlateauAreaLabel();
      updatePlateauAttribution();
    } else {
      await _initPlateauAutoMode(lod);
    }
    return;
  }

  // API モード以外: エリアラベルを非表示・deck.gl レイヤーをクリア
  _hidePlateauAreaLabel();
  _resetPlateauDeckState();
  _deckPlateauLayers = [];
  _commitDeckLayers();

  if (!buildingOn) { updatePlateauAttribution(); return; }

  const cfg = BUILDING_CFG[mode];
  if (!cfg || !map.getSource(cfg.source)) return; // ソース未追加なら無視

  map.addLayer({
    id: 'building-3d',
    type: 'fill-extrusion',
    source: cfg.source,
    'source-layer': cfg.sourceLayer,
    minzoom: 15,
    paint: {
      'fill-extrusion-height':  cfg.height,
      'fill-extrusion-base':    cfg.base,
      'fill-extrusion-color':   'rgb(150, 150, 150)',
      'fill-extrusion-opacity': 0.7,
    },
  });
  updatePlateauAttribution();
}

document.getElementById('sel-building').addEventListener('change', () => {
  updateBuildingLayer();
  updateShareableUrl();
  saveUiState();
});

// ---- 3D建物カード クリックでトグル ----
const building3dCard = document.getElementById('building3d-card');
function syncTerrainRasterOpacity() {
  // 地形 ON/OFF で raster-opacity の補正有無が変わるため、全KMZレイヤーを再適用する
  localMapLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
  });
}

async function setBuilding3dEnabled(enabled, { updateCard = true } = {}) {
  if (updateCard) building3dCard.classList.toggle('active', !!enabled);
  await updateBuildingLayer();
}

building3dCard.addEventListener('click', (e) => {
  if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
  void setBuilding3dEnabled(!building3dCard.classList.contains('active'), { updateCard: true });
  updateShareableUrl();
  saveUiState();
});

// ---- 3D地形カード クリックでトグル + 誇張率セレクト ----
const terrain3dCard = document.getElementById('terrain3d-card');
const selTerrainExaggeration = document.getElementById('sel-terrain-exaggeration');
// ズームレベルがこの値未満のとき3D地形を自動非表示にする
const TERRAIN_AUTO_HIDE_ZOOM = 5;

function setTerrain3dEnabled(enabled, { updateCard = true } = {}) {
  if (updateCard) terrain3dCard.classList.toggle('active', !!enabled);
  if (enabled) {
    // ズームレベルが閾値未満のときは map.setTerrain を呼ばない（zoom イベントで復元される）
    if (map.getZoom() >= TERRAIN_AUTO_HIDE_ZOOM) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: parseFloat(selTerrainExaggeration.value) });
    }
  } else {
    map.setTerrain(null);
  }
  syncTerrainRasterOpacity();
}

terrain3dCard.addEventListener('click', (e) => {
  if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
  setTerrain3dEnabled(!terrain3dCard.classList.contains('active'), { updateCard: true });
  updateShareableUrl();
  saveUiState();
});

selTerrainExaggeration.addEventListener('change', () => {
  if (terrain3dCard.classList.contains('active')) {
    setTerrain3dEnabled(true, { updateCard: false });
  }
  updateShareableUrl();
  saveUiState();
});

// ---- ズームレベル5未満で3D地形を自動非表示 ----
// カードのON/OFF状態は変えず、map.setTerrain()のみ制御する。
map.on('zoom', () => {
  if (!terrain3dCard.classList.contains('active')) return; // もともとオフなら何もしない
  const zoom = map.getZoom();
  const terrainOn = !!map.getTerrain();
  if (zoom < TERRAIN_AUTO_HIDE_ZOOM && terrainOn) {
    map.setTerrain(null);
    syncTerrainRasterOpacity();
  } else if (zoom >= TERRAIN_AUTO_HIDE_ZOOM && !terrainOn) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: parseFloat(selTerrainExaggeration.value) });
    syncTerrainRasterOpacity();
  }
});

// ---- 等高線 タイルカード ----
const contourCard = document.getElementById('contour-card');
const selContourDem      = document.getElementById('sel-contour-dem');
const selContourInterval = document.getElementById('sel-contour-interval');

// ユーザーが手動で選んだ等高線間隔（m）。zoom > 15（16以上）のときに使用する。
userContourInterval = Number.isFinite(userContourInterval) ? userContourInterval : 5;
// 最後に適用した間隔（連続 moveend での無駄な setTiles を防ぐ）
lastAppliedContourInterval = lastAppliedContourInterval ?? null;

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
  // setTiles でタイルキャッシュをクリアして新 URL を設定する。
  // 空配列を一度セットしてから新 URL をセットすることで、
  // MapLibre のタイルキャッシュを確実にフラッシュしてタイル再取得を強制する。
  if (hasQchizu) { map.getSource('contour-source').setTiles([]); map.getSource('contour-source').setTiles([newUrl]); }
  if (hasDem5a)  { map.getSource('contour-source-dem5a').setTiles([]); map.getSource('contour-source-dem5a').setTiles([newUrlDem5a]); }
  if (hasDem1a)  { map.getSource('contour-source-dem1a').setTiles([]); map.getSource('contour-source-dem1a').setTiles([newUrlDem1a]); }
  // if (hasLake)   map.getSource('contour-source-lake').setTiles([newUrlLake]);
  // 初期 visibility:none で追加されるため、ここで visible に設定する（フリック防止のため none は経由しない）
  if (contourCard.classList.contains('active')) setAllContourVisibility(map, 'visible');
  // マップがアイドル状態でもレンダーループを確実に起動してタイル再描画を促す
  map.triggerRepaint();
  lastAppliedContourInterval = intervalM;
}

// moveend 時に zoom に応じた間隔へ自動切り替え＆セレクト表示を更新
function updateContourAutoInterval() {
  if (!contourCard.classList.contains('active')) return;

  // z0-z13 の等高線間隔は buildContourThresholds 内で固定値としてURLに埋め込み済みのため、
  // ズームレベルが変わっても URL は変化しない → setTiles を呼ばない。
  if (lastAppliedContourInterval === null) {
    applyContourInterval(userContourInterval);
  }
}

// ---- 等高線カード クリックでトグル ----
contourCard.addEventListener('click', (e) => {
  // セレクト（カスタムセレクトのボタン含む）のクリックはトグルしない
  if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
  const isActive = contourCard.classList.toggle('active');
  const vis = isActive ? 'visible' : 'none';
  setAllContourVisibility(map, vis);
  updateShareableUrl();
  saveUiState();
});

// ---- 等高線 DEMソースセレクト ----
selContourDem.addEventListener('change', () => {
  contourState.demMode = selContourDem.value; // 'q1m' / 'dem5a'
  if (contourCard.classList.contains('active')) {
    setAllContourVisibility(map, 'visible');
  }
  // 色別等高線オーバーレイ選択中の場合はソース切り替えに追従
  if (currentOverlay === 'color-contour') {
    updateCsVisibility();
    map.triggerRepaint();
  }
  updateShareableUrl();
  saveUiState();
});

// ---- 等高線 間隔セレクト ----
selContourInterval.addEventListener('change', () => {
  const iv = parseFloat(selContourInterval.value);
  if (iv) {
    userContourInterval = iv;
    applyContourInterval(iv);
  }
  updateShareableUrl();
  saveUiState();
});

// ---- 磁北線 タイルカード ----
const magneticCard = document.getElementById('magnetic-card');
selMagneticCombined = document.getElementById('sel-magnetic-combined');
selMagneticModel    = document.getElementById('sel-magnetic-model');
selMagneticColor    = document.getElementById('sel-magnetic-color');

function getMagneticLineColor() {
  return (selMagneticColor?.value ?? 'black') === 'black'
    ? '#000000'
    : '#00ffff';
}

function applyMagneticLineColor(targetMap = map, layerId = 'magnetic-north-layer') {
  if (targetMap?.getLayer?.(layerId)) {
    targetMap.setPaintProperty(layerId, 'line-color', getMagneticLineColor());
    targetMap.triggerRepaint?.();
  }
}

// ---- 磁北線カード クリックでトグル ----
magneticCard?.addEventListener('click', (e) => {
  if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
  const isActive = magneticCard.classList.toggle('active');
  if (map.getLayer('magnetic-north-layer')) {
    map.setLayoutProperty('magnetic-north-layer', 'visibility', isActive ? 'visible' : 'none');
  }
  updateMagneticAttribution();
  updateShareableUrl();
  saveUiState();
});

// ---- 磁北線 モデルセレクト ----
selMagneticModel?.addEventListener('change', async () => {
  await setDeclinationModel(selMagneticModel.value);
  _globalMagneticLines = null; // グローバル磁北線キャッシュをクリア
  updateMagneticNorth();
  updateMagneticAttribution();
  updateShareableUrl();
  saveUiState();
});
// 初期モデルをロード（国土地理院2020 がデフォルト）
if (selMagneticModel) setDeclinationModel(selMagneticModel.value);

// ---- 磁北線 間隔セレクト ----
selMagneticCombined?.addEventListener('change', () => {
  const val = parseInt(selMagneticCombined.value, 10);
  if (val) {
    userMagneticInterval = val;
  }
  updateMagneticNorth();
  updateShareableUrl();
  saveUiState();
});

function handleMagneticColorChange() {
  applyMagneticLineColor();
  applyMagneticLineColor(pcSimState.readMap);
  updateMagneticNorth();
  requestAnimationFrame(() => {
    applyMagneticLineColor();
    applyMagneticLineColor(pcSimState.readMap);
  });
  saveUiState();
}

selMagneticColor?.addEventListener('input', handleMagneticColorChange);
selMagneticColor?.addEventListener('change', handleMagneticColorChange);

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
 * @param {string} key - BASEMAPS のキー、または 'orilibre'
 */
function switchBasemap(key) {
  currentBasemap = key;

  // ① すべてのベースマップレイヤーを非表示
  Object.keys(BASEMAPS).filter(k => BASEMAPS[k].url).forEach(k => {
    if (map.getLayer(k + '-layer')) map.setLayoutProperty(k + '-layer', 'visibility', 'none');
  });
  oriLibreLayers.forEach(({ id }) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  });
  if (map.getLayer('basemap-fallback-layer')) {
    map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'none');
  }

  // ② 選択されたベースマップのレイヤーを表示
  if (key === 'orilibre') {
    oriLibreLayers.forEach(({ id, defaultVisibility }) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', defaultVisibility);
    });
    if (map.getLayer('basemap-fallback-layer')) {
      map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'visible');
    }
  } else if (!key.startsWith('cs-')) {
    if (map.getLayer(key + '-layer')) map.setLayoutProperty(key + '-layer', 'visibility', 'visible');
  }

  // ③ backgroundレイヤー（初期化時に最下層へ移動済み）の色を切り替えて常に表示
  const bgLayer = oriLibreLayers.find(l => l.id.endsWith('-background'));
  if (bgLayer && map.getLayer(bgLayer.id)) {
    const bgColor = key === 'orilibre' ? bgLayer.origBgColor : (BASEMAPS[key]?.bgColor ?? '#ffffff');
    map.setPaintProperty(bgLayer.id, 'background-color', bgColor);
    map.setLayoutProperty(bgLayer.id, 'visibility', 'visible');
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
  updateShareableUrl();
  saveUiState();
});


// ---- サムネイル生成関連 ----

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- 開発者向け: 地図中央切り取り PNG 出力ツール ----
(function () {
  const overlay   = document.getElementById('dev-crop-overlay');
  const svg       = document.getElementById('dev-crop-svg');
  const toggleBtn = document.getElementById('dev-crop-frame-toggle');
  if (!overlay || !svg || !toggleBtn) return;

  let frameVisible = false;
  let cropW = 256, cropH = 256; // 現在選択中の出力サイズ

  // 枠の SVG を再描画する（ウィンドウリサイズ時も呼ぶ）
  function _drawFrame() {
    if (!frameVisible) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = vw / 2, cy = vh / 2;
    // 枠はDPR等を無視した「CSS px」での中央範囲
    const fw = cropW, fh = cropH;
    const x1 = cx - fw / 2, y1 = cy - fh / 2;
    const x2 = cx + fw / 2, y2 = cy + fh / 2;
    svg.innerHTML = `
      <defs>
        <mask id="dev-hole">
          <rect width="100%" height="100%" fill="white"/>
          <rect x="${x1}" y="${y1}" width="${fw}" height="${fh}" fill="black"/>
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(0,0,0,0.35)" mask="url(#dev-hole)"/>
      <rect x="${x1}" y="${y1}" width="${fw}" height="${fh}"
            fill="none" stroke="#ff3" stroke-width="1.5" stroke-dasharray="4 2"/>
      <text x="${cx}" y="${y1 - 4}" fill="#ff3" font-size="11" text-anchor="middle"
            font-family="monospace">${fw} × ${fh}</text>`;
  }

  // 枠表示切り替え
  toggleBtn.addEventListener('click', () => {
    frameVisible = !frameVisible;
    overlay.style.display = frameVisible ? '' : 'none';
    toggleBtn.textContent = frameVisible ? '非表示' : '表示';
    toggleBtn.style.background = frameVisible ? '#333' : '#fff';
    toggleBtn.style.color      = frameVisible ? '#ff3' : '';
    if (frameVisible) _drawFrame();
  });
  window.addEventListener('resize', _drawFrame);

  // 出力ボタン
  document.querySelectorAll('.dev-crop-btn').forEach(btn => {
    btn.style.cssText = 'padding:1px 7px;font-size:10px;border:1px solid #aaa;border-radius:3px;background:#fff;cursor:pointer';
    btn.addEventListener('click', () => {
      cropW = parseInt(btn.dataset.w, 10);
      cropH = parseInt(btn.dataset.h, 10);
      // ボタン選択状態を更新
      document.querySelectorAll('.dev-crop-btn').forEach(b => {
        b.style.background = b === btn ? '#333' : '#fff';
        b.style.color      = b === btn ? '#fff' : '';
      });
      _drawFrame();
      _exportCrop(cropW, cropH);
    });
  });

  // 地図中央を cropW×cropH で切り取って PNG ダウンロード
  function _exportCrop(outW, outH) {
    map.once('idle', () => {
      const canvas = map.getCanvas();
      const dpr    = window.devicePixelRatio || 1;
      // CSS px での地図キャンバスの中心
      const cssCx  = canvas.offsetWidth  / 2;
      const cssCy  = canvas.offsetHeight / 2;
      // 物理ピクセルに変換
      const px = Math.round((cssCx - outW / 2) * dpr);
      const py = Math.round((cssCy - outH / 2) * dpr);
      const pw = Math.round(outW * dpr);
      const ph = Math.round(outH * dpr);

      // 切り取り用 canvas に描画
      const out = document.createElement('canvas');
      out.width  = outW;
      out.height = outH;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvas, px, py, pw, ph, 0, 0, outW, outH);

      const link = document.createElement('a');
      link.download = `crop_${outW}x${outH}.png`;
      link.href     = out.toDataURL('image/png');
      link.click();
    });
    map.triggerRepaint();
  }
})();

// ---- サムネイル生成関連ここまで ----

// ---- サイドバーナビゲーション ----
let _sidebarCurrentPanel = 'sim';
let _sidebarOpen = true;

// サイドバー幅をCSS変数に反映（検索ボックス・縮尺の左位置が連動する）
function updateSidebarWidth() {
  const mobile = window.matchMedia('(max-width: 768px)').matches;
  const sidebar = document.getElementById('sidebar');
  const w = (!mobile && sidebar) ? sidebar.offsetWidth : 0;
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
}
window.addEventListener('resize', updateSidebarWidth);
updateSidebarWidth();

// ---- UI状態の永続化（localStorage）----
const _UI_STATE_KEY = 'teledrop-ui-state';

function saveUiState() {
  try {
    localStorage.setItem(_UI_STATE_KEY, JSON.stringify({
      basemap:             currentBasemap,
      overlay:             currentOverlay,
      overlayOpacity:      sliderCs.value,
      contourVisible:      contourCard.classList.contains('active'),
      contourDem:          selContourDem.value,
      contourInterval:     selContourInterval.value,
      magneticVisible:     magneticCard.classList.contains('active'),
      magneticModel:       selMagneticModel.value,
      magneticInterval:    selMagneticCombined.value,
      magneticColor:       selMagneticColor.value,
      terrain3d:           terrain3dCard.classList.contains('active'),
      terrainExaggeration: selTerrainExaggeration.value,
      building:            building3dCard.classList.contains('active'),
      buildingSrc:         document.getElementById('sel-building')?.value ?? 'plateau',
      sidebarPanel:        _sidebarCurrentPanel,
      sidebarOpen:         _sidebarOpen,
    }));
  } catch {}
}

// URLクエリパラメータを更新する（Q地図MapLibre版と同方式: ?params#hash）
// デフォルト値は省略してURLを短く保つ
function updateShareableUrl() {
  const p = new URLSearchParams(location.search);

  // ベースマップ（デフォルト: orilibre → 省略）
  if (currentBasemap && currentBasemap !== 'orilibre') p.set('base', currentBasemap);
  else p.delete('base');

  // オーバーレイ（デフォルト: none → 省略）
  if (currentOverlay && currentOverlay !== 'none') p.set('overlay', currentOverlay);
  else p.delete('overlay');

  // 透明度（デフォルト: 1.0 → 省略）
  const opacity = parseFloat(sliderCs.value);
  if (Math.abs(opacity - 1.0) > 0.005) p.set('opacity', opacity);
  else p.delete('opacity');

  // 等高線（ON = デフォルト → 省略; OFF時のみ明示）
  if (contourCard.classList.contains('active')) {
    p.delete('contour');
    const ci = selContourInterval.value;
    if (ci !== '5') p.set('cont_int', ci); else p.delete('cont_int');
    const cd = selContourDem.value;
    if (cd !== 'q1m') p.set('cont_dem', cd); else p.delete('cont_dem');
  } else {
    p.set('contour', '0'); p.delete('cont_int'); p.delete('cont_dem');
  }

  // 磁北線（ON = デフォルト → 省略; OFF時のみ明示）
  if (magneticCard.classList.contains('active')) {
    p.delete('magnetic');
    const mi = selMagneticCombined.value;
    if (mi !== '300') p.set('mag_int', mi); else p.delete('mag_int');
    const mm = selMagneticModel.value;
    if (mm !== 'gsi2020') p.set('mag_model', mm); else p.delete('mag_model');
  } else {
    p.set('magnetic', '0'); p.delete('mag_int'); p.delete('mag_model');
  }

  // 3D地形（OFF → 省略）
  if (terrain3dCard.classList.contains('active')) {
    p.set('terrain', '1');
    const ex = selTerrainExaggeration.value;
    if (ex !== '1') p.set('exag', ex); else p.delete('exag');
  } else {
    p.delete('terrain'); p.delete('exag');
  }

  // 建物（OFF → 省略）
  if (building3dCard.classList.contains('active')) {
    p.set('building', '1');
    const bs = document.getElementById('sel-building')?.value ?? 'plateau';
    if (bs !== 'plateau') p.set('bld_src', bs); else p.delete('bld_src');
  } else {
    p.delete('building'); p.delete('bld_src');
  }

  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
}

function restoreUiState() {
  try {
    // URLクエリ（シェアURL）を最優先、次にlocalStorage
    const up = new URLSearchParams(location.search);
    const s  = JSON.parse(localStorage.getItem(_UI_STATE_KEY) || 'null') || {};

    // ベースマップ：URL > localStorage
    const targetBase = up.get('base') || s.basemap;
    if (targetBase) {
      const card = document.querySelector(`#basemap-cards .bm-card[data-key="${targetBase}"]`);
      if (card) {
        document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        switchBasemap(targetBase);
      }
    }

    // 透明度：URL > localStorage
    const targetOpacity = up.has('opacity') ? parseFloat(up.get('opacity')) : parseFloat(s.overlayOpacity ?? 1);
    sliderCs.value = targetOpacity;
    updateSliderGradient(sliderCs);

    // 等高線DEMソース：URL > localStorage
    const targetContDem = up.get('cont_dem') || s.contourDem;
    if (targetContDem) {
      selContourDem.value = targetContDem;
      selContourDem._csRefresh?.();
      contourState.demMode = targetContDem;
    }
    // 等高線間隔：URL > localStorage
    const targetContInt = up.get('cont_int') || s.contourInterval;
    if (targetContInt) {
      selContourInterval.value = targetContInt;
      selContourInterval._csRefresh?.();
      userContourInterval = parseFloat(targetContInt) || 5;
    }
    // 等高線表示：URL > localStorage（デフォルトON）
    const contourOn = up.has('contour') ? up.get('contour') !== '0' : (s.contourVisible ?? true);
    if (contourOn) {
      contourCard.classList.add('active');
      applyContourInterval(userContourInterval);
      setAllContourVisibility(map, 'visible');
    }

    // 磁北線モデル：URL > localStorage
    const targetMagModel = up.get('mag_model') || s.magneticModel;
    if (targetMagModel) { selMagneticModel.value = targetMagModel; selMagneticModel._csRefresh?.(); }
    if (s.magneticColor) {
      selMagneticColor.value = s.magneticColor; selMagneticColor._csRefresh?.();
      applyMagneticLineColor();
    }
    // 磁北線間隔：URL > localStorage
    const targetMagInt = up.get('mag_int') || s.magneticInterval;
    if (targetMagInt) {
      selMagneticCombined.value = targetMagInt;
      selMagneticCombined._csRefresh?.();
      userMagneticInterval = parseInt(targetMagInt, 10) || 300;
    }
    // 磁北線表示：URL > localStorage（デフォルトON）
    const magneticOn = up.has('magnetic') ? up.get('magnetic') !== '0' : (s.magneticVisible ?? true);
    if (magneticOn) {
      magneticCard.classList.add('active');
      if (map.getLayer('magnetic-north-layer')) {
        map.setLayoutProperty('magnetic-north-layer', 'visibility', 'visible');
      }
      updateMagneticAttribution();
    }

    // 地形誇張倍率：URL > localStorage
    const targetExag = up.get('exag') || s.terrainExaggeration;
    if (targetExag) { selTerrainExaggeration.value = targetExag; selTerrainExaggeration._csRefresh?.(); }
    // 3D地形表示：URL > localStorage
    const terrainOn = up.has('terrain') ? up.get('terrain') === '1' : !!s.terrain3d;
    setTerrain3dEnabled(terrainOn, { updateCard: true });

    // 建物ソース：URL > localStorage
    const targetBldSrc = up.get('bld_src') || s.buildingSrc || 'plateau';
    const selBldEl = document.getElementById('sel-building');
    if (selBldEl) { selBldEl.value = targetBldSrc; selBldEl._csRefresh?.(); }
    // 建物表示：URL > localStorage
    const buildingOn = up.has('building') ? up.get('building') === '1' : !!s.building;
    void setBuilding3dEnabled(buildingOn, { updateCard: true });

    // オーバーレイ：URL > localStorage
    const targetOverlay = up.get('overlay') || s.overlay;
    if (targetOverlay && targetOverlay !== 'none') {
      const card = document.querySelector(`#overlay-cards .bm-card[data-key="${targetOverlay}"]`);
      if (card) {
        document.querySelectorAll('#overlay-cards .bm-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        currentOverlay = targetOverlay;
        updateCsVisibility();
        if (['cs', 'color-relief', 'slope', 'curvature', 'rrim'].includes(currentOverlay)) showMapLoading();
      }
    }

    // タブ（サイドバーパネル）：localStorageのみ（他者に強制しない個人設定）
    if (s.sidebarPanel) {
      _sidebarCurrentPanel = s.sidebarPanel;
      _sidebarOpen = s.sidebarOpen !== false;
      const btn = document.querySelector(`.sidebar-nav-btn[data-panel="${s.sidebarPanel}"]`);
      const sbPanel = document.getElementById('sidebar-panel');
      document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar-section').forEach(ss => ss.classList.remove('active'));
      if (_sidebarOpen && btn) {
        sbPanel.classList.remove('sb-hidden');
        btn.classList.add('active');
        const panelEl = document.getElementById('panel-' + s.sidebarPanel);
        if (panelEl) panelEl.classList.add('active');
      } else {
        sbPanel.classList.add('sb-hidden');
      }
      requestAnimationFrame(updateSidebarWidth);
    }
  } catch {}
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
      // テレインタブを開いたとき、まだ一度も検索していなければ初回検索を実行
      if (panel === 'terrain') _runTerrainSearch?.();
    }
    // CSSアニメーション完了後に幅を反映
    // display:none は即時反映されるため rAF 1フレームで幅を取得可能
    requestAnimationFrame(updateSidebarWidth);
    saveUiState();
  });
});


// パネル閉じるボタン（✕）
document.querySelectorAll('.sidebar-close-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const sbPanel = document.getElementById('sidebar-panel');
    sbPanel.classList.add('sb-hidden');
    document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
    _sidebarOpen = false;
    requestAnimationFrame(updateSidebarWidth);
  });
});

// ================================================================
// Phase 1 — 左パネル Pin/Overlay モード ＋ 右パネル
// ================================================================

// ピン留め状態（true=固定Push / false=オーバーレイ、localStorage で永続化）
let _sidebarPinned = localStorage.getItem('teledrop-sidebar-pinned') !== 'false';

/** ピン状態を CSS クラスに反映する */
function _updatePinMode() {
  const panel = document.getElementById('sidebar-panel');
  if (!panel) return;
  panel.classList.toggle('lp-overlay', !_sidebarPinned);
  document.querySelectorAll('.sidebar-pin-btn').forEach(b =>
    b.classList.toggle('is-pinned', _sidebarPinned)
  );
  requestAnimationFrame(updateSidebarWidth);
}

// 起動時に反映
_updatePinMode();

// ピンボタン SVG（画鋲アイコン）
const _PIN_BTN_SVG_PINNED  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
const _PIN_BTN_SVG_OVERLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;

/** ピンボタンの SVG を現在の状態に合わせて更新する */
function _refreshPinBtnIcon() {
  document.querySelectorAll('.sidebar-pin-btn').forEach(b => {
    b.innerHTML = _sidebarPinned ? _PIN_BTN_SVG_PINNED : _PIN_BTN_SVG_OVERLAY;
    b.title = _sidebarPinned ? 'フローティング表示に切り替え' : 'パネルを固定する';
  });
}

// 各セクションヘッダーにピンボタンを注入（閉じるボタンの直前）
document.querySelectorAll('.sidebar-section-header').forEach(hd => {
  const btn = document.createElement('button');
  btn.className = 'sidebar-pin-btn' + (_sidebarPinned ? ' is-pinned' : '');
  btn.title     = _sidebarPinned ? 'フローティング表示に切り替え' : 'パネルを固定する';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = _sidebarPinned ? _PIN_BTN_SVG_PINNED : _PIN_BTN_SVG_OVERLAY;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    _sidebarPinned = !_sidebarPinned;
    localStorage.setItem('teledrop-sidebar-pinned', String(_sidebarPinned));
    _updatePinMode();
    _refreshPinBtnIcon();
  });
  const closeBtn = hd.querySelector('.sidebar-close-btn');
  if (closeBtn) hd.insertBefore(btn, closeBtn);
  else          hd.appendChild(btn);
});


// ---- 右パネル ----

/** 右パネルを開く。Phase 3 でコースエディターがここに統合される。*/
/**
 * 右パネルを地図・GPX などの動的コンテンツで開く。
 * コースエディターは非表示、#rp-dynamic-content に contentEl を挿入する。
 */
function openRightPanel(title, contentEl) {
  const panel   = document.getElementById('right-panel');
  if (!panel) return;
  document.getElementById('right-panel-title').textContent = title ?? '';
  // コースエディターを隠して動的コンテンツを表示
  document.getElementById('course-editor-view').style.display = 'none';
  const dynEl = document.getElementById('rp-dynamic-content');
  dynEl.innerHTML = '';
  if (contentEl instanceof HTMLElement) dynEl.appendChild(contentEl);
  panel.classList.add('rp-open');
  document.body.classList.add('rp-open');
}

/** 右パネルを閉じる */
function closeRightPanel() {
  document.getElementById('right-panel')?.classList.remove('rp-open');
  document.body.classList.remove('rp-open');
  document.getElementById('course-editor-view').style.display = 'none';
  document.getElementById('rp-dynamic-content').innerHTML = '';
  setCourseMapVisible(false);
  _explorerActiveId = null;
  renderExplorer();
}

document.getElementById('right-panel-close-btn')?.addEventListener('click', closeRightPanel);

// ---- 右パネル ドラッグリサイズ ----
(function () {
  const RP_W_KEY = 'teledrop-rp-w';
  const RP_W_MIN = 220;
  const RP_W_MAX = 680;

  /** --rp-w をセットし localStorage に保存 */
  function _setRpWidth(px) {
    const clamped = Math.min(RP_W_MAX, Math.max(RP_W_MIN, px));
    document.documentElement.style.setProperty('--rp-w', clamped + 'px');
    localStorage.setItem(RP_W_KEY, String(clamped));
  }

  // 起動時に保存値を復元
  const saved = parseInt(localStorage.getItem(RP_W_KEY), 10);
  if (!isNaN(saved)) _setRpWidth(saved);

  const handle = document.getElementById('rp-resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.style.cursor = 'w-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      // 右パネルは right:0 固定なので幅 = 画面右端 - マウスX
      _setRpWidth(window.innerWidth - ev.clientX);
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// ================================================================
// Phase 2 — エクスプローラー ファイルツリー
// ================================================================

/** 現在選択中のエクスプローラーアイテムの ID */
let _explorerActiveId = null;

/** 表示中のエクスプローラーコンテキストメニュー */
let _explorerCtx = null;

/** コンテキストメニューを閉じる */
function _closeExplorerCtx() {
  _explorerCtx?.remove();
  _explorerCtx = null;
}

/**
 * コンテキストメニューを表示する
 * items: { label, icon?, action, danger?, separator? }[]
 */
function _showExplorerCtx(x, y, items) {
  _closeExplorerCtx();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item' + (item.danger ? ' ctx-menu-danger' : '');
    btn.textContent = item.label;
    btn.addEventListener('click', () => { _closeExplorerCtx(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  _explorerCtx = menu;

  // オーバーフロー補正
  const vw = window.innerWidth, vh = window.innerHeight;
  const { width: mw, height: mh } = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top  = Math.min(y, vh - mh - 8) + 'px';
}

// 外側クリック / Escape でコンテキストメニューを閉じる
document.addEventListener('mousedown', e => {
  if (_explorerCtx && !_explorerCtx.contains(e.target)) _closeExplorerCtx();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _explorerCtx) _closeExplorerCtx();
}, true);

// ---- セクション折りたたみ状態 ----
// キー: 'course' | テレイン ID 文字列 | 'uncategorized'
const _explorerCollapsed = { course: false };

/** 次にファイルインプットが発火したとき関連付けるテレイン ID（null = 未分類） */
let _pendingImportTerrainId = null;
let _pendingGpxTerrainId    = null;

/** 次の renderExplorer でフォーカス展開するテレイン ID */
let _focusTerrainId = null;

// ================================================================
// 右パネル コンテンツビルダー（地図・GPX）
// ================================================================

/**
 * 地図レイヤーの右パネルコンテンツを生成する。
 * 可視トグル・透明度スライダー・中心移動・削除ボタンを含む。
 */
function _buildMapLayerRightPanel(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'rp-map-panel';

  const pct = Math.round(entry.opacity * 100);

  wrap.innerHTML = `
    <div class="rp-section">
      <div class="rp-row">
        <label class="toggle-switch">
          <input type="checkbox" id="rp-vis-${entry.id}" ${entry.visible ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <span class="rp-label">表示</span>
      </div>
      <div class="rp-row rp-opacity-row">
        <span class="rp-label">透明度</span>
        <input type="range" class="ui-slider rp-opacity-slider" min="0" max="100" step="5" value="${pct}" ${entry.visible ? '' : 'disabled'} />
        <span class="rp-opacity-val">${pct}%</span>
      </div>
    </div>
    <div class="rp-section rp-actions">
      <button class="rp-action-btn" id="rp-fitbounds-${entry.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/></svg>
        地図の中心に移動
      </button>
      <button class="rp-action-btn rp-action-danger" id="rp-del-${entry.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        削除
      </button>
    </div>`;

  // 可視トグル
  const visChk = wrap.querySelector(`#rp-vis-${entry.id}`);
  const slider  = wrap.querySelector('.rp-opacity-slider');
  const valSpan = wrap.querySelector('.rp-opacity-val');
  visChk.addEventListener('change', () => {
    entry.visible = visChk.checked;
    slider.disabled = !entry.visible;
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
  });

  // 透明度スライダー
  updateSliderGradient(slider);
  slider.addEventListener('input', () => {
    entry.opacity = parseInt(slider.value) / 100;
    valSpan.textContent = slider.value + '%';
    updateSliderGradient(slider);
    if (entry.visible && map.getLayer(entry.layerId)) {
      map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
  });

  // 中心移動ボタン
  wrap.querySelector(`#rp-fitbounds-${entry.id}`)?.addEventListener('click', () => {
    if (entry.bbox) {
      const b = entry.bbox;
      map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 600 });
    }
  });

  // 削除ボタン
  wrap.querySelector(`#rp-del-${entry.id}`)?.addEventListener('click', () => {
    if (confirm(`「${entry.name}」を削除しますか？`)) {
      removeLocalMapLayer(entry.id);
      closeRightPanel();
      renderExplorer();
    }
  });

  return wrap;
}

/**
 * GPX トラックの右パネルコンテンツを生成する。
 * ファイル情報・再生コントロール・削除ボタンを含む。
 */
function _buildGpxRightPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'rp-gpx-panel';

  const pts   = gpxState.trackPoints.length;
  const dur   = gpxState.totalDuration ?? 0;

  // 既存の formatMMSS を利用（app.js 内で定義済み）
  const durStr = typeof formatMMSS === 'function' ? formatMMSS(dur) : '--:--';

  wrap.innerHTML = `
    <div class="rp-section">
      <div class="rp-info-row"><span class="rp-info-label">ポイント数</span><span class="rp-info-val">${pts.toLocaleString()}</span></div>
      <div class="rp-info-row"><span class="rp-info-label">総時間</span><span class="rp-info-val">${durStr}</span></div>
    </div>
    <div class="rp-section rp-gpx-controls">
      <button class="rp-gpx-playpause rp-action-btn" id="rp-gpx-play">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>${gpxState.isPlaying ? '一時停止' : '再生'}</span>
      </button>
    </div>
    <div class="rp-section rp-actions">
      <button class="rp-action-btn rp-action-danger" id="rp-gpx-del">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        削除
      </button>
    </div>`;

  // 再生/一時停止：既存の play-pause-btn をプログラマチックに click
  wrap.querySelector('#rp-gpx-play')?.addEventListener('click', () => {
    document.getElementById('play-pause-btn')?.click();
    // ボタンラベルを更新
    const span = wrap.querySelector('#rp-gpx-play span');
    if (span) span.textContent = gpxState.isPlaying ? '一時停止' : '再生';
  });

  // 削除ボタン
  wrap.querySelector('#rp-gpx-del')?.addEventListener('click', () => {
    if (confirm('GPXトラックを削除しますか？')) {
      gpxState.trackPoints = [];
      gpxState.fileName = null;
      const src = map.getSource('gpx-source');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
      document.getElementById('gpx-status').innerHTML = '';
      closeRightPanel();
      renderExplorer();
    }
  });

  return wrap;
}

// ================================================================
// Phase 3 — コースエディタービュー切り替え
// ================================================================

/**
 * エクスプローラービューをコースエディタービューへスライドイン。
 * エクスプローラーパネルが閉じていれば先に開く。
 */
/**
 * 右パネルにコースエディターを表示する。
 * #course-editor-view は #right-panel-body に常駐しており、display を切り替えるだけ。
 */
function openCourseEditor() {
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  document.getElementById('right-panel-title').textContent = 'コース';
  // 動的コンテンツを消してコースエディターを表示
  document.getElementById('rp-dynamic-content').innerHTML = '';
  document.getElementById('course-editor-view').style.display = 'block';
  panel.classList.add('rp-open');
  document.body.classList.add('rp-open');
  setCourseMapVisible(true);
}

/** エクスプローラーを再描画する（外部モジュールからも呼び出し可能） */
/** renderExplorer の多重実行を防ぐフラグ */
let _explorerRendering = false;
let _explorerRenderPending = false;

async function renderExplorer() {
  // 既にレンダリング中なら完了後に1回だけ再実行（多重 DB 呼び出し防止）
  if (_explorerRendering) { _explorerRenderPending = true; return; }
  _explorerRendering = true;
  try {
    await _renderExplorerOnce();
  } finally {
    _explorerRendering = false;
    if (_explorerRenderPending) {
      _explorerRenderPending = false;
      renderExplorer();
    }
  }
}

async function _renderExplorerOnce() {
  const treeEl = document.getElementById('explorer-tree');
  if (!treeEl) return;

  // ── すべての非同期データを先に取得してからDOMを一括更新（ちらつき防止）──
  let wsTerrains = [];
  try { wsTerrains = await getWsTerrains(); } catch { /* ignore */ }

  const focusId   = _focusTerrainId;
  _focusTerrainId = null;

  /** 大会・コースセット（+コース）・コース枠をDBから取得してまとめる */
  async function fetchEventsWithSheetsAndCourseSets(terrainId) {
    // ── 大会配下のコースセット ──
    let events = [];
    try { events = await getWsEvents(terrainId); } catch { /* ignore */ }
    const eventsData = await Promise.all(events.map(async ev => {
      let courseSets = [];
      try {
        const sets = await getCourseSetsForEvent(ev.id);
        courseSets = await Promise.all(sets.map(async cs => {
          let courses = [];
          try { courses = await getCoursesBySet(cs.id); } catch { /* ignore */ }
          return { courseSet: cs, courses };
        }));
      } catch { /* ignore */ }
      let sheets = [];
      try { sheets = await getMapSheetsByEvent(ev.id); } catch { /* ignore */ }
      const sheetsWithImages = sheets.map(sheet => ({
        sheet,
        images: localMapLayers.filter(e => e.mapSheetId === sheet.id),
      }));
      return { event: ev, courseSets, sheetsWithImages };
    }));

    // ── 大会に属さないスタンドアロンコースセット（terrain直属）──
    let standaloneSets = [];
    if (terrainId != null) { // null テレインは IDB null インデックス問題を回避
      try {
        const sets = await getCourseSetsForTerrain(terrainId);
        standaloneSets = await Promise.all(sets.map(async cs => {
          let courses = [];
          try { courses = await getCoursesBySet(cs.id); } catch { /* ignore */ }
          return { courseSet: cs, courses };
        }));
      } catch { /* ignore */ }
    }
    return { eventsData, standaloneSets };
  }

  // ── テレインフォルダ（全データを並列取得）──
  const terrainData = await Promise.all(wsTerrains.map(async t => {
    const { eventsData, standaloneSets } = await fetchEventsWithSheetsAndCourseSets(t.id);
    return {
      terrain: t,
      maps:    localMapLayers.filter(e => e.terrainId === t.id && !e.mapSheetId),
      gpx:     (gpxState.fileName && gpxState.terrainId === t.id) ? gpxState : null,
      eventsData,
      standaloneSets,
    };
  }));

  // ── 未分類 ──
  const uncatMaps   = localMapLayers.filter(e => !e.terrainId && !e.mapSheetId);
  const uncatGpx    = (gpxState.fileName && !gpxState.terrainId) ? gpxState : null;
  const { eventsData: uncatEvents } = await fetchEventsWithSheetsAndCourseSets(null);

  // ── 全データ取得完了 → ここで初めて DOM を置換（ちらつきゼロ）──
  const frag = document.createDocumentFragment();

  for (const { terrain, maps, gpx, eventsData, standaloneSets } of terrainData) {
    const folder = _buildTerrainFolder(terrain, maps, gpx, eventsData, standaloneSets);
    if (focusId === terrain.id) {
      folder.classList.add('is-focused');
      requestAnimationFrame(() => folder.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
    frag.appendChild(folder);
  }

  if (uncatMaps.length > 0 || uncatGpx || uncatEvents.length > 0) {
    frag.appendChild(_buildUncategorizedFolder(uncatMaps, uncatGpx, uncatEvents));
  }

  if (wsTerrains.length === 0 && uncatMaps.length === 0 && !uncatGpx && uncatEvents.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'expl-ws-hint';
    hint.innerHTML = '<span>検索タブでテレインを探し「＋」で追加すると<br>ここにフォルダが作成されます</span>';
    frag.appendChild(hint);
  }

  // ── ストレージバー（DB 保存レイヤーがある場合） ──
  const hasDb = localMapLayers.some(e => e.dbId != null);
  if (hasDb) {
    const bar = document.createElement('div');
    bar.className = 'expl-storage-bar';
    bar.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0018 0V5"/><path d="M3 12a9 3 0 0018 0"/></svg>';
    const text = document.createElement('span');
    text.id = 'storage-usage-text';
    text.className = 'storage-usage-text';
    text.textContent = 'ストレージ使用量: ---';
    const clearBtn = document.createElement('button');
    clearBtn.className = 'expl-storage-clear';
    clearBtn.textContent = '全消去';
    clearBtn.id = 'storage-clear-btn';
    clearBtn.title = '保存した地図をすべてストレージから削除する';
    bar.appendChild(text);
    bar.appendChild(clearBtn);
    frag.appendChild(bar);
  }

  // 一括置換（ここでのみ DOM がちらつく可能性があるが、ほぼ1フレーム未満）
  treeEl.innerHTML = '';
  treeEl.appendChild(frag);
}

/**
 * テレインフォルダ DOM を構築して返す
 * @param {object}        terrain
 * @param {Array}         maps       — localMapLayers のうちこのテレインに属するもの（コース枠未割り当て）
 * @param {object|null}   gpx        — gpxState（属する場合のみ）
 * @param {Array}         eventsData — [{ event, courses[], sheetsWithImages[] }]
 */
function _buildTerrainFolder(terrain, maps, gpx, eventsData = [], standaloneSets = []) {
  const collapsed = _explorerCollapsed[terrain.id] ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-terrain-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.terrainId = terrain.id;

  // DnD ドロップターゲット設定（地図・GPXのみ）
  _setupFolderDropTarget(folder, terrain.id);

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-terrain-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  const tfIcon = document.createElement('span');
  tfIcon.className = 'expl-terrain-icon';
  // 山型アイコン（テレイン = 土地・地形）
  tfIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20l4-8 4 8"/><path d="M2 20l6-12 3 6"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-terrain-label';
  lbl.textContent = terrain.name;

  // source バッジ（ローカルテレインのみ表示）
  if (terrain.source === 'local') {
    const srcBadge = document.createElement('span');
    srcBadge.className = 'expl-terrain-source-badge';
    srcBadge.textContent = 'ローカル';
    lbl.appendChild(srcBadge);
  }

  const totalItems = eventsData.length + maps.length + (gpx ? 1 : 0);
  if (totalItems > 0) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    const parts = [];
    if (eventsData.length > 0) parts.push(`大会 ${eventsData.length}`);
    if (maps.length > 0) parts.push(`地図 ${maps.length}`);
    if (gpx) parts.push('GPX');
    badge.textContent = parts.join(' | ');
    lbl.appendChild(badge);
  }

  // ＋ 追加ボタン
  const addPopBtn = _buildAddPopoverBtn(terrain.id);

  // ⋮ ハンバーガーメニューボタン（この場所へ移動 / 削除）
  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-terrain-more';
  moreBtn.title = 'その他';
  moreBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _showExplorerCtx(r.right + 4, r.top, [
      { label: 'この場所へ移動', action: () => {
          if (terrain.center) map.easeTo({ center: terrain.center, zoom: Math.max(map.getZoom(), 12), duration: EASE_DURATION });
        }
      },
      { separator: true },
      { label: 'ワークスペースから削除', danger: true, action: async () => {
          if (!confirm(`「${terrain.name}」をワークスペースから削除しますか？\n関連付けられたファイルは未分類に移動します。`)) return;
          localMapLayers.filter(m => m.terrainId === terrain.id).forEach(m => { m.terrainId = null; });
          if (gpxState.terrainId === terrain.id) gpxState.terrainId = null;
          await deleteWsTerrain(terrain.id);
          const all = await getWsTerrains();
          updateWorkspaceTerrainSource(map, all);
          renderExplorer();
        }
      },
    ]);
  });

  hd.appendChild(chevron);
  hd.appendChild(tfIcon);
  hd.appendChild(lbl);
  hd.appendChild(addPopBtn);
  hd.appendChild(moreBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-terrain-more, .expl-add-pop-btn')) return;
    _explorerCollapsed[terrain.id] = !(_explorerCollapsed[terrain.id] ?? false);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed[terrain.id]);
  });
  folder.appendChild(hd);

  // ── ボディ ──
  const body = document.createElement('div');
  body.className = 'expl-terrain-body';
  eventsData.forEach(({ event, courseSets, sheetsWithImages }) =>
    body.appendChild(_buildEventFolder(event, courseSets, sheetsWithImages)));
  standaloneSets.forEach(({ courseSet, courses }) =>
    body.appendChild(_buildCourseSetFolder(courseSet, courses)));
  maps.forEach(entry => body.appendChild(_buildMapItem(entry)));
  if (gpx) body.appendChild(_buildGpxItem());
  folder.appendChild(body);
  return folder;
}

/**
 * 未分類フォルダ DOM を構築して返す
 * @param {Array}       maps       — localMapLayers のうち terrainId=null のもの（コース枠未割り当て）
 * @param {object|null} gpx        — gpxState（属する場合のみ）
 * @param {Array}       eventsData — [{ event, courseSets[], sheetsWithImages[] }] のうち terrain_id=null のもの
 */
function _buildUncategorizedFolder(maps, gpx, eventsData = []) {
  const collapsed = _explorerCollapsed['uncategorized'] ?? true;

  const folder = document.createElement('div');
  folder.className = 'expl-terrain-folder expl-uncategorized' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.terrainId = 'null'; // DnD ターゲット識別用

  _setupFolderDropTarget(folder, null);

  const hd = document.createElement('div');
  hd.className = 'expl-terrain-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  const ucIcon = document.createElement('span');
  ucIcon.className = 'expl-terrain-icon';
  ucIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-terrain-label expl-uncategorized-label';
  lbl.textContent = '未分類';

  const totalItems = eventsData.length + maps.length + (gpx ? 1 : 0);
  if (totalItems > 0) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    badge.textContent = totalItems + ' 件';
    lbl.appendChild(badge);
  }

  const addPopBtnUc = _buildAddPopoverBtn(null);

  hd.appendChild(chevron);
  hd.appendChild(ucIcon);
  hd.appendChild(lbl);
  hd.appendChild(addPopBtnUc);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-add-pop-btn')) return;
    _explorerCollapsed['uncategorized'] = !(_explorerCollapsed['uncategorized'] ?? true);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed['uncategorized']);
  });
  folder.appendChild(hd);

  const body = document.createElement('div');
  body.className = 'expl-terrain-body';
  eventsData.forEach(({ event, courseSets, sheetsWithImages }) =>
    body.appendChild(_buildEventFolder(event, courseSets, sheetsWithImages)));
  maps.forEach(entry => body.appendChild(_buildMapItem(entry)));
  if (gpx) body.appendChild(_buildGpxItem());
  folder.appendChild(body);
  return folder;
}

/**
 * ＋▾ ポップオーバーボタンを構築して返す
 * @param {string|null} terrainId — null = 未分類
 */
function _buildAddPopoverBtn(terrainId) {
  const btn = document.createElement('button');
  btn.className = 'expl-add-pop-btn';
  btn.title = '追加';
  btn.setAttribute('aria-label', '追加メニュー');
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    _showAddPopover(btn, terrainId);
  });
  return btn;
}

/** ＋ ポップオーバーメニューを表示する */
let _openAddPopover = null;
function _showAddPopover(anchorBtn, terrainId) {
  _openAddPopover?.remove();
  _openAddPopover = null;

  const menu = document.createElement('div');
  menu.className = 'expl-add-popover';

  // SVG アイコン定数（既存コードと同一パス）
  const SVG_EVENT     = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 01-2-2V5h4"/><path d="M18 9h2a2 2 0 002-2V5h-4"/><path d="M6 9a6 6 0 0012 0"/><path d="M12 15v4"/><path d="M8 19h8"/></svg>`;
  const SVG_COURSESET = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>`;
  const SVG_MAP       = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  const SVG_GPX       = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
  const SVG_FILE      = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;

  // ── ヘルパー ──
  const addSection = label => {
    const el = document.createElement('div');
    el.className = 'expl-add-popover-section';
    el.textContent = label;
    menu.appendChild(el);
  };
  const addSep = () => {
    const el = document.createElement('div');
    el.className = 'expl-add-popover-sep';
    menu.appendChild(el);
  };
  const addItem = (svgHtml, label, sub, action) => {
    const btn = document.createElement('button');
    btn.className = 'expl-add-popover-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'expl-add-popover-icon';
    iconEl.innerHTML = svgHtml;
    const wrap = document.createElement('span');
    wrap.className = 'expl-add-popover-text';
    const labelEl = document.createElement('span');
    labelEl.className = 'expl-add-popover-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'expl-add-popover-sub';
      subEl.textContent = sub;
      wrap.appendChild(subEl);
    }
    btn.appendChild(iconEl);
    btn.appendChild(wrap);
    // mousedown を止めないと閉じるリスナーが先に発火してclickが届かない
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _closeAddPopover();
      action();
    });
    menu.appendChild(btn);
  };

  // ── 新規作成 ──
  addSection('新規作成');
  addItem(SVG_EVENT, '大会', null, async () => {
    await createEvent(terrainId, '大会');
    await renderExplorer();
    openCourseEditor();
  });
  addItem(SVG_COURSESET, 'コースセット', null, async () => {
    await createCourseSet(null, terrainId, 'コースセット');
    await renderExplorer();
    openCourseEditor();
  });

  addSep();

  // ── ファイルを読み込み ──
  addSection('ファイルを読み込み');
  addItem(SVG_MAP, '地図画像', 'png / jpg / kmz', () => {
    _pendingImportTerrainId = terrainId;
    document.getElementById('explorer-map-input')?.click();
  });
  addItem(SVG_GPX, 'GPSログ', 'gpx', () => {
    _pendingGpxTerrainId = terrainId;
    document.getElementById('explorer-gpx-input')?.click();
  });
  addItem(SVG_FILE, 'コースデータ', 'ppen / IOF XML', () => {
    document.getElementById('explorer-json-input')?.click();
  });

  document.body.appendChild(menu);
  _openAddPopover = menu;

  // アンカーボタン直下に配置（右端揃え）
  const r = anchorBtn.getBoundingClientRect();
  menu.style.top  = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(4, r.right - menu.offsetWidth) + 'px';

  setTimeout(() => {
    document.addEventListener('mousedown', _closeAddPopover, { once: true });
  }, 0);
}

function _closeAddPopover() {
  _openAddPopover?.remove();
  _openAddPopover = null;
}

// ================================================================
// ドラッグ＆ドロップ
// ================================================================

/** ドラッグ中のアイテム情報 */
let _dndItem = null; // { type:'map'|'gpx'|'course', id:string }

/**
 * フォルダに DnD ドロップターゲットの設定をする
 * @param {HTMLElement}   folder
 * @param {string|null}   terrainId
 */
function _setupFolderDropTarget(folder, terrainId) {
  folder.addEventListener('dragover', e => {
    if (!_dndItem) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    folder.classList.add('dnd-over');
  });
  folder.addEventListener('dragleave', e => {
    if (!folder.contains(e.relatedTarget)) folder.classList.remove('dnd-over');
  });
  folder.addEventListener('drop', async e => {
    e.preventDefault();
    folder.classList.remove('dnd-over');
    if (!_dndItem) return;
    const { type, id } = _dndItem;
    _dndItem = null;
    if (type === 'map') {
      const entry = localMapLayers.find(m => m.id === id);
      if (entry) entry.terrainId = terrainId;
    } else if (type === 'gpx') {
      gpxState.terrainId = terrainId;
    } else if (type === 'courseSet') {
      // コースセットをテレインフォルダ（または未分類）にドロップ → event_id=null, terrain_id=terrainId
      await moveCourseSet(id, { eventId: null, terrainId: terrainId ?? null });
    }
    await renderExplorer();
  });
}

/**
 * アイテム要素に draggable を設定する
 * @param {HTMLElement} el
 * @param {{ type:string, id:string }} item
 */
function _makeDraggable(el, item) {
  el.draggable = true;
  el.classList.add('expl-draggable');
  el.addEventListener('dragstart', e => {
    _dndItem = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.type + ':' + item.id);
    el.classList.add('is-dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('is-dragging');
    _dndItem = null;
    // 全フォルダの dnd-over を解除
    document.querySelectorAll('.dnd-over').forEach(f => f.classList.remove('dnd-over'));
  });
}

/**
 * ラベル要素をインライン入力に置き換えてリネームを行う共通ヘルパー
 * @param {HTMLElement} lbl       — 置き換え対象のラベル要素
 * @param {string}      current   — 現在の名前
 * @param {Function}    onCommit  — async (newName: string) => void
 */
function _startInlineRename(lbl, current, onCommit) {
  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = current;
  input.className = 'expl-inline-rename';
  input.maxLength = 60;
  lbl.replaceWith(input);
  input.focus();
  input.select();
  let _committed = false;
  const commit = async () => {
    if (_committed) return;
    _committed = true;
    const newName = input.value.trim() || current;
    await onCommit(newName);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { _committed = true; input.value = current; input.blur(); }
  });
}

/**
 * イベントの controlDefs からバウンディングボックスを計算して地図を移動する
 * @param {object} event — IndexedDB の events レコード（controlDefs を含む）
 */
function _flyToEventControls(event) {
  const defs = Object.values(event.controlDefs ?? {});
  if (defs.length === 0) return;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const d of defs) {
    if (d.lng < minLng) minLng = d.lng;
    if (d.lng > maxLng) maxLng = d.lng;
    if (d.lat < minLat) minLat = d.lat;
    if (d.lat > maxLat) maxLat = d.lat;
  }
  if (!isFinite(minLng)) return;
  const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
  if (defs.length === 1) {
    map.easeTo({ center: [minLng, minLat], zoom: Math.max(map.getZoom(), 15), duration: EASE_DURATION });
  } else {
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                 left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
      duration: EASE_DURATION, maxZoom: 18,
    });
  }
}

/**
 * 大会フォルダ DOM を構築して返す
 * @param {object} event            — IndexedDB の events レコード（大会）
 * @param {Array}  courseSets       — [{ courseSet, courses[] }]
 * @param {Array}  sheetsWithImages — [{ sheet, images[] }]
 */
function _buildEventFolder(event, courseSets = [], sheetsWithImages = []) {
  const key       = 'event-' + event.id;
  const collapsed = _explorerCollapsed[key] ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-event-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.eventId = event.id;

  // コースセット DnD ドロップターゲット（event フォルダへのドロップ）
  folder.addEventListener('dragover', e => {
    if (!_dndItem || _dndItem.type !== 'courseSet') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    folder.classList.add('dnd-over');
  });
  folder.addEventListener('dragleave', e => {
    if (!folder.contains(e.relatedTarget)) folder.classList.remove('dnd-over');
  });
  folder.addEventListener('drop', async e => {
    e.preventDefault();
    folder.classList.remove('dnd-over');
    if (!_dndItem || _dndItem.type !== 'courseSet') return;
    const { id } = _dndItem;
    _dndItem = null;
    await moveCourseSet(id, { eventId: event.id, terrainId: null });
    await renderExplorer();
  });

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-event-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  // トロフィーアイコン（大会）
  const evIcon = document.createElement('span');
  evIcon.className = 'expl-event-icon';
  evIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 01-2-2V5h4"/><path d="M18 9h2a2 2 0 002-2V5h-4"/><path d="M6 9a6 6 0 0012 0"/><path d="M12 15v4"/><path d="M8 19h8"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-event-label';
  lbl.textContent = event.name;

  // ＋コースセット追加ボタン
  const addCsBtn = document.createElement('button');
  addCsBtn.className = 'expl-event-add-cs-btn';
  addCsBtn.title = 'コースセットを追加';
  addCsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>`;
  addCsBtn.addEventListener('click', async e => {
    e.stopPropagation();
    _explorerCollapsed[key] = false;
    folder.classList.remove('is-collapsed');
    await createCourseSet(event.id, null, 'コースセット');
    await renderExplorer();
    openCourseEditor();
  });

  // 削除ボタン
  const delBtn = document.createElement('button');
  delBtn.className = 'expl-event-del';
  delBtn.title = '大会を削除';
  delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>`;
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`「${event.name}」を削除しますか？\n全コースセット・コース・コース枠が削除されます。`)) return;
    if (_explorerActiveId?.startsWith('courseSet-') || _explorerActiveId?.startsWith('course-')) {
      _explorerActiveId = null;
    }
    await deleteEvent(event.id);
    await renderExplorer();
  });

  // この場所へ移動ボタン
  const flyBtn = document.createElement('button');
  flyBtn.className = 'expl-event-fly';
  flyBtn.title = 'この場所へ移動';
  flyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
  flyBtn.addEventListener('click', e => {
    e.stopPropagation();
    _flyToEventControls(event);
  });

  hd.appendChild(chevron);
  hd.appendChild(evIcon);
  hd.appendChild(lbl);
  hd.appendChild(addCsBtn);
  hd.appendChild(flyBtn);
  hd.appendChild(delBtn);
  // 行全体クリックで開閉（ボタン類のみ除外）
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-event-del, .expl-event-fly, .expl-event-add-cs-btn')) return;
    _explorerCollapsed[key] = !(_explorerCollapsed[key] ?? false);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed[key]);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _showExplorerCtx(e.clientX, e.clientY, [
      { label: '名前を変更', action: () => _startInlineRename(lbl, event.name, async n => {
          await renameEvent(event.id, n);
          await renderExplorer();
        })
      },
      { label: 'コースセットを追加', action: async () => {
          await createCourseSet(event.id, null, 'コースセット');
          await renderExplorer();
        }
      },
      { separator: true },
      { label: '大会を削除', danger: true, action: async () => {
          if (!confirm(`「${event.name}」を削除しますか？\n全コースセット・コース・コース枠が削除されます。`)) return;
          if (_explorerActiveId?.startsWith('courseSet-') || _explorerActiveId?.startsWith('course-')) _explorerActiveId = null;
          await deleteEvent(event.id);
          await renderExplorer();
        }
      },
    ]);
  });
  folder.appendChild(hd);

  // ── ボディ ──
  const body = document.createElement('div');
  body.className = 'expl-event-body';

  // コースセット（フラット配置）
  courseSets.forEach(({ courseSet, courses }) =>
    body.appendChild(_buildCourseSetFolder(courseSet, courses)));

  // コース枠キャンバス
  sheetsWithImages.forEach(({ sheet, images }) =>
    body.appendChild(_buildMapSheetFolder(sheet, images)));

  folder.appendChild(body);
  return folder;
}

/**
 * コースセットフォルダを構築して返す。
 * クリックで展開/折りたたみ + アクティブコースセットのロード（全コントロール表示）。
 * ドラッグで大会/テレインフォルダへ移動可能（DnD type='courseSet'）。
 *
 * @param {object} courseSet — course_sets レコード
 * @param {Array}  courses   — getCoursesBySet() の結果配列
 */
function _buildCourseSetFolder(courseSet, courses = []) {
  const key       = 'courseSet-' + courseSet.id;
  const collapsed = _explorerCollapsed[key] ?? false;
  const isActive  = getActiveCourseSetId() === courseSet.id;

  const folder = document.createElement('div');
  folder.className = 'expl-courseset-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.courseSetId = courseSet.id;

  // ── DnD 設定（このフォルダ自体をドラッグ可能）──
  _makeDraggable(folder, { type: 'courseSet', id: courseSet.id });

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-courseset-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  // Oコントロール二重円アイコン（紫色）
  const csIcon = document.createElement('span');
  csIcon.className = 'expl-courseset-icon';
  csIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>`;

  // ラベル（クリック→開閉+全コントロール表示）
  const lbl = document.createElement('span');
  lbl.className = 'expl-courseset-label';
  lbl.textContent = courseSet.name;
  lbl.title = 'クリック: 全コントロールを表示';

  lbl.addEventListener('click', e => {
    e.stopPropagation();
    const wasCollapsed = _explorerCollapsed[key] ?? false;
    _explorerCollapsed[key] = !wasCollapsed;
    folder.classList.toggle('is-collapsed', !wasCollapsed);
    if (wasCollapsed) {
      (async () => {
        if (getActiveCourseSetId() !== courseSet.id) {
          await loadCourseSet(courseSet.id);
          showAllControlsTab();
          openCourseEditor();
        } else {
          showAllControlsTab();
        }
        _explorerActiveId = 'courseSet-' + courseSet.id;
        renderExplorer();
      })();
    }
  });

  // コース追加ボタン
  const addCourseBtn = document.createElement('button');
  addCourseBtn.className = 'expl-courseset-add-btn';
  addCourseBtn.title = 'コースを追加';
  addCourseBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>`;
  addCourseBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (getActiveCourseSetId() !== courseSet.id) await loadCourseSet(courseSet.id);
    const newCourseId = addCourseToActiveEvent();
    if (newCourseId) _explorerActiveId = 'course-' + newCourseId;
    _explorerCollapsed[key] = false;
    folder.classList.remove('is-collapsed');
    await flushSave(); // 追加直後にDBへ即時反映
    await renderExplorer();
    openCourseEditor();
  });

  // 削除ボタン
  const delBtn = document.createElement('button');
  delBtn.className = 'expl-courseset-del';
  delBtn.title = 'コースセットを削除';
  delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>`;
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`「${courseSet.name}」を削除しますか？\n全コースが削除されます。`)) return;
    if (_explorerActiveId === 'courseSet-' + courseSet.id || _explorerActiveId?.startsWith('course-')) {
      _explorerActiveId = null;
    }
    await deleteCourseSet(courseSet.id);
    await renderExplorer();
  });

  hd.appendChild(chevron);
  hd.appendChild(csIcon);
  hd.appendChild(lbl);
  hd.appendChild(addCourseBtn);
  hd.appendChild(delBtn);
  // 行全体クリックで開閉（ラベルは独自ハンドラあり、ボタン類のみ除外）
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-courseset-del, .expl-courseset-add-btn, .expl-courseset-label')) return;
    _explorerCollapsed[key] = !(_explorerCollapsed[key] ?? false);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed[key]);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _showExplorerCtx(e.clientX, e.clientY, [
      { label: 'この場所へ移動', action: () => _flyToEventControls({ controlDefs: courseSet.controlDefs }) },
      { label: '名前を変更', action: () => _startInlineRename(lbl, courseSet.name, async n => {
          await renameCourseSet(courseSet.id, n);
          await renderExplorer();
        })
      },
      { separator: true },
      { label: 'コースセットを削除', danger: true, action: async () => {
          if (!confirm(`「${courseSet.name}」を削除しますか？`)) return;
          if (_explorerActiveId?.startsWith('courseSet-') || _explorerActiveId?.startsWith('course-')) _explorerActiveId = null;
          await deleteCourseSet(courseSet.id);
          await renderExplorer();
        }
      },
    ]);
  });
  folder.appendChild(hd);

  // ── ボディ（コースアイテム）──
  const body = document.createElement('div');
  body.className = 'expl-courseset-body';

  const activeSummary = isActive ? getCoursesSummary() : [];
  const summaryMap    = new Map(activeSummary.map(s => [s.id, s]));
  courses.forEach(c => {
    const info = {
      id:          c.id,
      name:        c.name,
      courseSetId: courseSet.id,
      eventId:     courseSet.event_id ?? null,
      isActive:    summaryMap.get(c.id)?.isActive ?? false,
      isEmpty:     summaryMap.get(c.id)?.isEmpty  ?? (c.sequence?.length === 0),
    };
    body.appendChild(_buildCourseItem(info));
  });
  folder.appendChild(body);

  return folder;
}

/**
 * コース枠フォルダ（画像位置合わせ用フレーム）を構築して返す
 * @param {object} sheet  — map_sheets レコード
 * @param {Array}  images — このコース枠に紐づく localMapLayers エントリ
 */
function _buildMapSheetFolder(sheet, images = []) {
  const key       = 'sheet-' + sheet.id;
  const collapsed = _explorerCollapsed[key] ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-sheet-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.sheetId = sheet.id;

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-sheet-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  chevron.addEventListener('click', e => {
    e.stopPropagation();
    _explorerCollapsed[key] = !(_explorerCollapsed[key] ?? false);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed[key]);
  });

  const sheetIcon = document.createElement('span');
  sheetIcon.className = 'expl-sheet-icon';
  sheetIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-sheet-label';
  const scaleStr = sheet.scale      ? ` 1:${sheet.scale.toLocaleString()}` : '';
  const sizeStr  = sheet.paper_size ? ` ${sheet.paper_size}` : '';
  lbl.textContent = sheet.name + sizeStr + scaleStr;
  lbl.title = sheet.name;

  if (images.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    badge.textContent = images.length + ' 枚';
    lbl.appendChild(badge);
  }

  // この場所へ移動ボタン
  const flyBtn = document.createElement('button');
  flyBtn.className = 'expl-sheet-fly';
  flyBtn.title = 'この枠の場所へ移動';
  flyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
  flyBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!sheet.coordinates) return;
    const lngs = sheet.coordinates.map(c => c[0]);
    const lats  = sheet.coordinates.map(c => c[1]);
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                   left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
        duration: EASE_DURATION }
    );
  });

  // コース枠削除ボタン
  const delBtn = document.createElement('button');
  delBtn.className = 'expl-sheet-del';
  delBtn.title = 'コース枠を削除（画像は残る）';
  delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg>`;
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm(`「${sheet.name}」を削除しますか？\n（紐づく画像の配置は残ります）`)) return;
    // 紐づく画像の mapSheetId を解除（localMapLayers）
    images.forEach(img => { img.mapSheetId = null; });
    await deleteWsMapSheet(sheet.id);
    await renderExplorer();
  });

  hd.appendChild(chevron);
  hd.appendChild(sheetIcon);
  hd.appendChild(lbl);
  hd.appendChild(flyBtn);
  hd.appendChild(delBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-sheet-fly, .expl-sheet-del, .expl-section-chevron')) return;
    _explorerCollapsed[key] = !(_explorerCollapsed[key] ?? false);
    folder.classList.toggle('is-collapsed', !!_explorerCollapsed[key]);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _showExplorerCtx(e.clientX, e.clientY, [
      { label: '名前を変更', action: () =>
          _startInlineRename(lbl, sheet.name, async n => {
            await saveWsMapSheet({ ...sheet, name: n });
            await renderExplorer();
          })
      },
      { separator: true },
      { label: 'コース枠を削除', danger: true, action: async () => {
          if (!confirm(`「${sheet.name}」を削除しますか？`)) return;
          images.forEach(img => { img.mapSheetId = null; });
          await deleteWsMapSheet(sheet.id);
          await renderExplorer();
        }
      },
    ]);
  });
  folder.appendChild(hd);

  // ── ボディ（画像アイテム）──
  const body = document.createElement('div');
  body.className = 'expl-sheet-body';
  images.forEach(img => body.appendChild(_buildMapItem(img)));
  folder.appendChild(body);

  return folder;
}

/** コースアイテムを構築して返す */
function _buildCourseItem(courseInfo) {
  const row = document.createElement('div');
  row.className = 'expl-item' + (('course-' + courseInfo.id) === _explorerActiveId ? ' is-active' : '');

  // 三角旗アイコン（赤色）
  const icon = document.createElement('span');
  icon.className = 'expl-item-icon expl-course-flag-icon';
  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-item-label';
  lbl.textContent = courseInfo.name;

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
  const openThisCourse = async () => {
    document.querySelectorAll('.expl-item.is-active').forEach(el => el.classList.remove('is-active'));
    row.classList.add('is-active');
    _explorerActiveId = 'course-' + courseInfo.id;
    if (courseInfo.courseSetId && getActiveCourseSetId() !== courseInfo.courseSetId) {
      await loadCourseSet(courseInfo.courseSetId);
    }
    setActiveCourse(courseInfo.id);
    renderExplorer();
    openCourseEditor();
  };

  const deleteThisCourse = async () => {
    if (courseInfo.courseSetId && getActiveCourseSetId() !== courseInfo.courseSetId) {
      await loadCourseSet(courseInfo.courseSetId);
    }
    deleteCourseById(courseInfo.id);
    if (_explorerActiveId === 'course-' + courseInfo.id) _explorerActiveId = null;
    await flushSave(); // 削除直後にDBへ即時反映
    await renderExplorer();
  };

  const renameThisCourse = () => _startInlineRename(lbl, courseInfo.name, async n => {
    await renameCourse(courseInfo.id, n);
    await renderExplorer();
  });


  const _courseCtxItems = () => [
    { label: 'コースを編集', action: openThisCourse },
    { label: '名前を変更',   action: renameThisCourse },
    { separator: true },
    { label: 'JSON エクスポート', action: () => document.getElementById('course-export-btn')?.click() },
    { label: 'IOF XML エクスポート', action: () => document.getElementById('course-xml-btn')?.click() },
    { label: 'Purple Pen (.ppen) エクスポート', action: () => document.getElementById('course-ppen-btn')?.click() },
    { separator: true },
    { label: 'コースを削除', danger: true, action: deleteThisCourse },
  ];

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _showExplorerCtx(r.right + 4, r.top, _courseCtxItems());
  });

  row.addEventListener('click', () => openThisCourse());
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _showExplorerCtx(e.clientX, e.clientY, _courseCtxItems());
  });

  row.appendChild(icon);
  row.appendChild(lbl);
  row.appendChild(moreBtn);

  return row;
}

/** 地図レイヤーのエクスプローラーアイテムを構築して返す */
function _buildMapItem(entry) {
  const row = document.createElement('div');
  row.className = 'expl-item' + (('map-' + entry.id) === _explorerActiveId ? ' is-active' : '');

  const icon = document.createElement('span');
  icon.className = 'expl-item-icon';
  icon.innerHTML = _svgMapIcon();

  const lbl2 = document.createElement('span');
  lbl2.className = 'expl-item-label';
  lbl2.textContent = entry.name;

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;

  const renameMapItem = () => _startInlineRename(lbl2, entry.name, async n => {
    entry.name = n;
    renderOtherMapsTree();
    await renderExplorer();
  });

  const _mapCtxItems = () => [
    { label: '地図を中心に表示', action: () => {
      if (entry.bbox) {
        const b = entry.bbox;
        map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 600 });
      }
    }},
    { label: '名前を変更', action: renameMapItem },
    { separator: true },
    { label: '削除', danger: true, action: () => {
      if (confirm(`「${entry.name}」を削除しますか？`)) {
        removeLocalMapLayer(entry.id);
        renderExplorer();
      }
    }},
  ];

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _showExplorerCtx(r.right + 4, r.top, _mapCtxItems());
  });
  row.addEventListener('click', () => {
    _explorerActiveId = 'map-' + entry.id;
    renderExplorer();
    openRightPanel(entry.name.replace(/\.kmz$/i, ''), _buildMapLayerRightPanel(entry));
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _showExplorerCtx(e.clientX, e.clientY, _mapCtxItems());
  });

  row.appendChild(icon);
  row.appendChild(lbl2);
  row.appendChild(moreBtn);
  _makeDraggable(row, { type: 'map', id: String(entry.id) });
  return row;
}

/** GPX アイテムのエクスプローラー DOM を構築して返す */
function _buildGpxItem() {
  const row = document.createElement('div');
  row.className = 'expl-item' + ('gpx-main' === _explorerActiveId ? ' is-active' : '');

  const icon = document.createElement('span');
  icon.className = 'expl-item-icon';
  icon.innerHTML = _svgGpxIcon();

  const lbl3 = document.createElement('span');
  lbl3.className = 'expl-item-label';
  lbl3.textContent = gpxState.fileName ?? 'GPXトラック';

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
  const renameGpx = () => _startInlineRename(lbl3, gpxState.fileName ?? 'GPXトラック', async n => {
    gpxState.fileName = n;
    await renderExplorer();
  });

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _showExplorerGpxCtx(r.right + 4, r.top, renameGpx);
  });
  row.addEventListener('click', () => {
    _explorerActiveId = 'gpx-main';
    renderExplorer();
    openRightPanel(gpxState.fileName ?? 'GPX', _buildGpxRightPanel());
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _showExplorerGpxCtx(e.clientX, e.clientY, renameGpx);
  });

  row.appendChild(icon);
  row.appendChild(lbl3);
  row.appendChild(moreBtn);
  _makeDraggable(row, { type: 'gpx', id: 'gpx-main' });
  return row;
}

/** GPX コンテキストメニューを表示する */
function _showExplorerGpxCtx(x, y, onRename) {
  _showExplorerCtx(x, y, [
    { label: gpxState.isPlaying ? '一時停止' : '再生',
      action: () => document.getElementById('gpx-play-pause')?.click()
    },
    { label: '名前を変更', action: onRename },
    { separator: true },
    { label: '削除', danger: true, action: () => {
      if (confirm('GPXトラックを削除しますか？')) {
        gpxState.trackPoints = [];
        gpxState.fileName    = null;
        gpxState.terrainId   = null;
        const src = map.getSource('gpx-source');
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
        document.getElementById('gpx-status').innerHTML = '';
        renderExplorer();
      }
    }},
  ]);
}

/** エクスプローラーセクションの DOM を構築して返す */
function _buildExplorerSection(label, key, items, opts = {}) {
  const collapsed = _explorerCollapsed[key] ?? false;

  const section = document.createElement('div');
  section.className = 'expl-section' + (collapsed ? ' is-collapsed' : '');

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-section-hd';

  const chevron = document.createElement('span');
  chevron.className = 'expl-section-chevron';
  chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-section-label';
  lbl.textContent = label;

  const addBtn = document.createElement('button');
  addBtn.className = 'expl-section-add';
  addBtn.title = opts.addTitle ?? '追加';
  addBtn.setAttribute('aria-label', opts.addTitle ?? '追加');
  addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  addBtn.addEventListener('click', e => { e.stopPropagation(); opts.addAction?.(); });

  hd.appendChild(chevron);
  hd.appendChild(lbl);
  hd.appendChild(addBtn);
  hd.addEventListener('click', () => {
    _explorerCollapsed[key] = !_explorerCollapsed[key];
    section.classList.toggle('is-collapsed', _explorerCollapsed[key]);
  });
  section.appendChild(hd);

  // ── ボディ ──
  const body = document.createElement('div');
  body.className = 'expl-section-body';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'expl-empty';
    empty.textContent = 'アイテムがありません';
    body.appendChild(empty);
  } else {
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'expl-item' + (item.id === _explorerActiveId ? ' is-active' : '');

      const icon = document.createElement('span');
      icon.className = 'expl-item-icon';
      icon.innerHTML = opts.itemIcon ?? '';

      const lbl2 = document.createElement('span');
      lbl2.className = 'expl-item-label';
      lbl2.textContent = item.label;

      row.appendChild(icon);
      row.appendChild(lbl2);

      // バッジ（コースバリアント数など）
      if (opts.badgeText) {
        const badge = opts.badgeText(item);
        if (badge) {
          const bdg = document.createElement('span');
          bdg.className = 'expl-item-badge';
          bdg.textContent = badge;
          row.appendChild(bdg);
        }
      }

      // ⋮ ボタン（コンテキストメニュートリガー）
      if (opts.onItemCtx) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'expl-item-more';
        moreBtn.title = 'オプション';
        moreBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
        moreBtn.addEventListener('click', e => {
          e.stopPropagation();
          const r = moreBtn.getBoundingClientRect();
          opts.onItemCtx(item, r.right + 4, r.top);
        });
        row.appendChild(moreBtn);
      }

      // クリック & 右クリック
      row.addEventListener('click', () => opts.onItemClick?.(item));
      if (opts.onItemCtx) {
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          opts.onItemCtx(item, e.clientX, e.clientY);
        });
      }

      body.appendChild(row);
    });
  }

  // フッター（ストレージバーなど）
  if (opts.footer) {
    const footerEl = opts.footer();
    if (footerEl) body.appendChild(footerEl);
  }

  section.appendChild(body);
  return section;
}

// ── アイコン SVG ──
/** コースアイテム: スタート三角旗（赤） */
function _svgCourseIcon() {
  // 旗形SVG（_buildCourseItem では直接インラインするためこの関数は後方互換用）
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
}
/** 地図画像レイヤー: 絵フレーム */
function _svgMapIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}
/** GPX: ルートライン（緑） */
function _svgGpxIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
}

// ── ファイル追加インプットのハンドラ ──
document.getElementById('explorer-map-input')?.addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  const terrainId = _pendingImportTerrainId;
  _pendingImportTerrainId = null;
  e.target.value = '';
  for (const f of files) {
    const prevCount = localMapLayers.length;
    if (/\.kmz$/i.test(f.name)) await loadKmz(f);
    else await loadImageWithJgw(f, null);
    // 新しく追加されたレイヤーにテレイン ID を付与
    const added = localMapLayers.slice(prevCount);
    added.forEach(entry => { entry.terrainId = terrainId ?? null; });
  }
  renderExplorer();
});

document.getElementById('explorer-gpx-input')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const terrainId = _pendingGpxTerrainId;
  _pendingGpxTerrainId = null;
  e.target.value = '';
  await loadGpx(file);
  gpxState.terrainId = terrainId ?? null;
  renderExplorer();
});

document.getElementById('explorer-json-input')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const text = await file.text();
  // course.js の import ハンドラと同じ処理をトリガー
  const courseImportInput = document.getElementById('course-import-file');
  if (courseImportInput) {
    // DataTransfer を使って既存ハンドラに渡す（同ファイルのイベントを再発行）
    const dt = new DataTransfer();
    dt.items.add(file);
    courseImportInput.files = dt.files;
    courseImportInput.dispatchEvent(new Event('change'));
  }
  renderExplorer();
});

// ================================================================
// ---- 縮尺セレクト（現在の縮尺をリアルタイム表示 ＋ プリセット選択でズーム） ----
// モニターの物理PPIを考慮した実寸縮尺を計算・表示する。
// 物理PPI: ユーザーが選択したモニターの実際のピクセル密度
// effectiveDPI（CSS px/inch）= physicalPPI / DPR
// → 地上分解能(m/CSS px) × effectiveDPI / 0.0254(m/inch) = 縮尺分母
const _allDevicePpis = DEVICE_PPI_DATA.flatMap(cat => cat.devices.map(d => d.ppi));
let currentDevicePPI = (() => {
  const saved = parseInt(localStorage.getItem('teledrop-device-ppi'), 10);
  return (saved && _allDevicePpis.includes(saved)) ? saved : DEFAULT_DEVICE_PPI;
})();

// PPI値からデバイス名を返す
function findDeviceName(ppi) {
  for (const cat of DEVICE_PPI_DATA) {
    const dev = cat.devices.find(d => d.ppi === ppi);
    if (dev) return dev.name;
  }
  return `${ppi} ppi`;
}

// カスケードメニューを構築し、イベントを登録する
// メニュー・サブメニューを body 直下に配置し position:fixed で座標を JS 計算することで
// パネルの overflow:hidden によるクリップを回避する
(function buildPpiCascade() {
  const btn   = document.getElementById('ppi-cascade-btn');
  const label = document.getElementById('ppi-cascade-label');
  const menu  = document.getElementById('ppi-cascade-menu');
  if (!btn || !menu) return;

  // body 直下に移動してオーバーフロークリップを回避
  document.body.appendChild(menu);

  // メニュー項目を生成（サブメニューは個別に body に追加）
  const subs = []; // 各カテゴリのサブメニュー要素を保持
  menu.innerHTML = DEVICE_PPI_DATA.map((cat, i) =>
    `<div class="ppi-cascade-cat" data-cat-idx="${i}">
      <span>${cat.category}</span>
      <span class="ppi-cascade-cat-arrow">▶</span>
    </div>`
  ).join('');

  DEVICE_PPI_DATA.forEach((cat, i) => {
    const sub = document.createElement('div');
    sub.className = 'ppi-cascade-sub';
    sub.innerHTML = cat.devices.map(dev =>
      `<div class="ppi-cascade-item${dev.ppi === currentDevicePPI ? ' selected' : ''}" data-ppi="${dev.ppi}">
        <span>${dev.name}</span>
        <span class="ppi-cascade-item-ppi">${dev.ppi} ppi</span>
      </div>`
    ).join('');
    document.body.appendChild(sub);
    subs.push(sub);
  });

  function closeAll() {
    menu.classList.remove('open');
    subs.forEach(s => { s.style.display = ''; });
  }

  // ボタンクリックでメニューを fixed 座標に表示
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('open')) { closeAll(); return; }
    const r = btn.getBoundingClientRect();
    menu.style.top  = (r.bottom + 2) + 'px';
    menu.style.left = r.left + 'px';
    menu.classList.add('open');
  });

  // カテゴリホバーでサブメニューを fixed 座標に表示
  menu.querySelectorAll('.ppi-cascade-cat').forEach(catEl => {
    const idx = parseInt(catEl.dataset.catIdx, 10);
    const sub = subs[idx];
    catEl.addEventListener('mouseenter', () => {
      // 他のカテゴリのサブメニューと .open を閉じる
      menu.querySelectorAll('.ppi-cascade-cat').forEach(c => c.classList.remove('open'));
      subs.forEach(s => { s.style.display = ''; });
      catEl.classList.add('open');
      const r = catEl.getBoundingClientRect();
      sub.style.top  = r.top + 'px';
      sub.style.left = r.right + 'px';
      sub.style.display = 'block';
    });
    // カテゴリ行からサブメニューへ移動した場合は閉じない
    catEl.addEventListener('mouseleave', e => {
      if (sub.contains(e.relatedTarget)) return;
      sub.style.display = '';
      catEl.classList.remove('open');
    });
    sub.addEventListener('mouseleave', e => {
      if (catEl.contains(e.relatedTarget)) return;
      sub.style.display = '';
      catEl.classList.remove('open');
    });
  });

  // 外クリックで閉じる
  document.addEventListener('click', e => {
    if (!btn.contains(e.target) && !menu.contains(e.target) && !subs.some(s => s.contains(e.target))) {
      closeAll();
    }
  });

  // デバイス選択
  subs.forEach(sub => {
    sub.addEventListener('click', e => {
      const item = e.target.closest('.ppi-cascade-item');
      if (!item) return;
      const ppi = parseInt(item.dataset.ppi, 10);
      currentDevicePPI = ppi;
      localStorage.setItem('teledrop-device-ppi', ppi);
      label.textContent = findDeviceName(ppi);
      subs.forEach(s => s.querySelectorAll('.ppi-cascade-item').forEach(el =>
        el.classList.toggle('selected', parseInt(el.dataset.ppi, 10) === ppi)
      ));
      closeAll();
      updateScaleDisplay();
      updatePpiRuler();
      // 手動スライダーをプリセット値に同期
      const _ms = document.getElementById('ppi-manual-slider');
      if (_ms) { _ms.value = ppi; updateSliderGradient(_ms); updatePpiSliderBubble(_ms); }
    });
  });

  // 初期ラベルを設定
  label.textContent = findDeviceName(currentDevicePPI);
})();

// 実寸定規を SVG で描画する
// 目盛り幅は PPI に基づく固定間隔。コンテナ幅に合わせて右端でクリップされる（Inkscape スタイル）
function updatePpiRuler() {
  const svg = document.getElementById('ppi-ruler');
  if (!svg) return;
  const dpr     = window.devicePixelRatio || 1;
  const pxPerMm = currentDevicePPI / (dpr * 25.4); // CSS px per mm

  // SVG 幅 = 親コンテナの実幅（overflow:hidden でクリップ）
  const containerW = svg.parentElement ? svg.parentElement.clientWidth : 0;
  const W   = containerW > 0 ? containerW : 240;
  const H   = 34;
  const BASE = H - 2; // ベースラインY

  svg.setAttribute('width', W);

  const lines = [];
  const texts = [];

  // 左端に "0" ラベルが収まるよう小さなオフセット（文字幅の半分程度）を設ける
  const OX = 16; // 左端オフセット（px）
  const RW = W; // 描画幅（コンテナ全幅）
  // ベースライン（全幅）と 0 目盛り縦線
  lines.push(`<path d="M${OX},${BASE - 16} L${OX},${BASE} L${RW},${BASE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="miter"/>`);
  // 0 ラベル（目盛り中央揃え）
  texts.push(`<text x="${OX}" y="${BASE - 18}" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="500" text-anchor="middle">0</text>`);

  // 1mm 刻みで目盛りを描画し、描画幅を超えたら終了（右端でクリップ）
  for (let mm = 1; OX + mm * pxPerMm <= RW + 0.5; mm++) {
    const x     = OX + mm * pxPerMm;
    const isCm  = mm % 10 === 0;
    const is5mm = mm % 5 === 0;
    const tickH = isCm ? 16 : is5mm ? 10 : 5;
    lines.push(`<line x1="${x.toFixed(2)}" y1="${BASE - tickH}" x2="${x.toFixed(2)}" y2="${BASE}" stroke="currentColor" stroke-width="${isCm ? 1.5 : 1}"/>`);
    if (isCm) {
      texts.push(`<text x="${x.toFixed(2)}" y="${BASE - 18}" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="500" text-anchor="middle">${mm / 10}</text>`);
    }
  }

  svg.innerHTML = lines.join('') + texts.join('');
}

// スライダーつまみの位置に追従してバブルを更新する
// 位置は CSS calc(var(--pct) * (100% - 12px) + 6px) で計算するため offsetWidth 不要
function updatePpiSliderBubble(slider) {
  const bubble = document.getElementById('ppi-slider-bubble');
  const numEl  = document.getElementById('ppi-current-display');
  if (!slider) return;
  const pct = (parseFloat(slider.value) - parseFloat(slider.min))
            / (parseFloat(slider.max)  - parseFloat(slider.min));
  if (bubble) {
    bubble.style.setProperty('--pct', pct);
    bubble.textContent = Math.round(slider.value);
  }
  if (numEl) numEl.textContent = Math.round(slider.value);
}

updatePpiRuler();

// 手動PPIスライダー — ドラッグ中にリアルタイムで定規・縮尺を更新
{
  const _slider = document.getElementById('ppi-manual-slider');
  const _val    = document.getElementById('ppi-manual-val');
  if (_slider) {
    // 初期値を currentDevicePPI に合わせる
    _slider.value = currentDevicePPI;
    updateSliderGradient(_slider);
    updatePpiSliderBubble(_slider);
    _slider.addEventListener('input', () => {
      const ppi = parseInt(_slider.value, 10);
      currentDevicePPI = ppi;
      localStorage.setItem('teledrop-device-ppi', ppi);
      updateSliderGradient(_slider);
      updatePpiSliderBubble(_slider);
      updateScaleDisplay();
      updatePpiRuler();
      // 手動操作時はプリセット選択を解除
      const _lbl = document.getElementById('ppi-cascade-label');
      if (_lbl) _lbl.textContent = 'カスタム';
      document.querySelectorAll('.ppi-cascade-item').forEach(el => el.classList.remove('selected'));
    });
  }
}

// MapLibre GL JS のデフォルト tileSize は 512px
// → ワールド幅 = 512 × 2^zoom CSS px
// → 地上分解能 = 2π × 6378137 × cos(lat) / (512 × 2^zoom)
//              = 78271.51696 × cos(lat) / 2^zoom  [m/CSS px]
// ※ 旧来の Web メルカトル定数 156543.03392 は 256px タイル用であり
//    MapLibre で使うと縮尺分母が 2 倍になるため使用しない
const _MERCATOR_COEFF = 78271.51696; // 2π × 6378137 / 512

// 現在の地図ズーム・中心緯度から縮尺分母を計算する
// effectiveDPI = 物理PPI / DPR （CSS ピクセルあたりの物理インチ逆数）
function calcScaleDenominator() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const groundRes = _MERCATOR_COEFF * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
  const effectiveDPI = currentDevicePPI / (window.devicePixelRatio || 1);
  return Math.round(groundRes * effectiveDPI / 0.0254);
}

// 縮尺分母からズームレベルを計算して地図を移動するヘルパー
function zoomToScale(targetScale) {
  if (!targetScale) return;
  const center = map.getCenter();
  const effectiveDPI = currentDevicePPI / (window.devicePixelRatio || 1);
  const targetGroundRes = targetScale * 0.0254 / effectiveDPI;
  const zoom = Math.log2(_MERCATOR_COEFF * Math.cos(center.lat * Math.PI / 180) / targetGroundRes);
  map.easeTo({ zoom, duration: EASE_DURATION });
}

const selScale = document.getElementById('sel-scale');
const optCurrentScale = document.getElementById('opt-current-scale');

// 先頭オプション（現在の縮尺＋ズーム）のテキストを更新し、先頭を選択状態に戻す
function updateScaleDisplay() {
  const s = calcScaleDenominator();
  const z = map.getZoom().toFixed(1);
  optCurrentScale.textContent = `1 : ${s.toLocaleString()} (z${z})`;
  selScale.selectedIndex = 0;
  selScale._csSync?.(); // カスタムセレクトのボタン表示を同期
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
updateSliderGradient(sliderCs); // 値変更後に再計算


// 3D地形初期倍率をセレクトに反映（TERRAIN_EXAGGERATION = 1.0 なので ×1 がデフォルト選択済み）


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
const mobileSimState = {
  active:     false,                  // シム実行中か
  miniMap:    null,                   // 第2 MapLibre インスタンス（ミニマップ）
  joystick:   null,                   // nipplejs インスタンス
  joyData:    { force: 0, angle: 0 }, // ジョイスティック入力（force: 0〜1, angle: radians）
  animFrame:  null,                   // requestAnimationFrame ID
  targetZoom: SIM_ZOOM,               // ユーザーが希望するズームレベル（スライダー/キーで更新）
  posMarker:  null,                   // maplibregl.Marker インスタンス（現在地表示）
};

/* ----------------------------------------------------------------
   toggleSimMode: トグルボタンの onClick
   ---------------------------------------------------------------- */
function toggleSimMode() {
  if (mobileSimState.active) stopSimMode();
  else           startSimMode();
}

/* ----------------------------------------------------------------
   startSimMode: シミュレーターを起動する
   ---------------------------------------------------------------- */
function startSimMode() {
  mobileSimState.active = true;
  mobileSimState.targetZoom = SIM_ZOOM;
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
  updateSliderGradient(zSlider);

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
  mobileSimState.active = false;
  if (_updateGlobeBg) _updateGlobeBg();

  // ループ停止
  if (mobileSimState.animFrame) { cancelAnimationFrame(mobileSimState.animFrame); mobileSimState.animFrame = null; }

  // ジョイスティック破棄
  if (mobileSimState.joystick) { mobileSimState.joystick.destroy(); mobileSimState.joystick = null; }
  mobileSimState.joyData = { force: 0, angle: 0 };

  // ミニマップ破棄
  if (mobileSimState.miniMap) { mobileSimState.miniMap.remove(); mobileSimState.miniMap = null; }

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
  map.easeTo({ pitch: INITIAL_PITCH, duration: EASE_DURATION });
}

/* ----------------------------------------------------------------
   initSimMinimap: 第2 MapLibre マップ（ミニマップ）を生成する
   背景: 地理院タイル（軽量ラスター）
   KMZ: 現在ロード済みのレイヤーを全て複製して追加
   ---------------------------------------------------------------- */
function initSimMinimap() {
  if (mobileSimState.miniMap) return;

  mobileSimState.miniMap = new maplibregl.Map({
    container: 'sim-minimap-map',
    style: {
      version: 8,
      sources: {
        'mini-base': {
          type: 'raster',
          tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
          tileSize: Math.round(256 / (window.devicePixelRatio || 1)),
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

  mobileSimState.miniMap.on('load', () => {
    // KMZ画像レイヤーを全て複製してミニマップに追加
    syncKmzToMinimap();
  });
}

/* ----------------------------------------------------------------
   syncKmzToMinimap: 現在の localMapLayers を全てミニマップに追加
   ミニマップのスタイルロード後か、新規KMZ追加時に呼ぶ
   ---------------------------------------------------------------- */
function syncKmzToMinimap() {
  if (!mobileSimState.miniMap || !mobileSimState.miniMap.isStyleLoaded()) return;
  localMapLayers.forEach(entry => {
    // 既に追加済みならスキップ
    if (mobileSimState.miniMap.getSource(entry.sourceId)) return;
    // メインマップのソーススペックを取得（url + coordinates を含む）
    const spec = map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    mobileSimState.miniMap.addSource(entry.sourceId, spec);
    mobileSimState.miniMap.addLayer({
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
  if (mobileSimState.joystick) { mobileSimState.joystick.destroy(); mobileSimState.joystick = null; }
  mobileSimState.joyData = { force: 0, angle: 0 };

  mobileSimState.joystick = nipplejs.create({
    zone:     document.getElementById('sim-joystick-zone'),
    mode:     'static',
    position: { left: '70px', top: '70px' },
    color:    'white',
    size:     120,
  });

  mobileSimState.joystick.on('move', (evt, data) => {
    mobileSimState.joyData.force = Math.min(data.force, 1.0);
    // angle.radian: 0=右, π/2=上, π=左, 3π/2=下
    mobileSimState.joyData.angle = data.angle.radian;
  });

  mobileSimState.joystick.on('end', () => { mobileSimState.joyData.force = 0; });
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
  if (!mobileSimState.active) return;

  // ── 移動 ──────────────────────────────────────────────────────
  if (mobileSimState.joyData.force > 0.05) {
    const bearing    = map.getBearing();
    // nipplejs angle: 0=右/East, 90=上/North, 180=左/West, 270=下/South
    // MapLibre bearing: 0=North, 90=East → 変換: moveAngle = bearing + (90 - joystickDeg)
    const joystickDeg = mobileSimState.joyData.angle * (180 / Math.PI);
    const moveAngleDeg = bearing + (90 - joystickDeg);

    // 速度: 最大 SIM_MAX_SPEED_MPS、力の割合で比例スケール
    // 距離 = 速度[m/s] × (1/60)[s] ÷ 1000 → [km]（60fps仮定）
    const distKm = (SIM_MAX_SPEED_MPS * mobileSimState.joyData.force) / 60 / 1000;

    const c    = map.getCenter();
    const dest = turf.destination([c.lng, c.lat], distKm, moveAngleDeg);
    map.setCenter(dest.geometry.coordinates);
  }

  // ── ミニマップ同期 ──────────────────────────────────────────────
  if (mobileSimState.miniMap) {
    mobileSimState.miniMap.setCenter(map.getCenter());
    // bearing の逆回転で常に進行方向が上（ヘディングアップ）
    const b = map.getBearing();
    document.getElementById('sim-minimap-inner').style.transform =
      `rotate(${-b}deg)`;
  }

  // ── 地形フロア（setZoom のみ。setFreeCameraOptions は使用しない） ──
  enforceTerrainFloor();

  // ── 3D現在位置マーカー更新 ──
  updateSimPosMarker();

  mobileSimState.animFrame = requestAnimationFrame(simLoop);
}

/* ----------------------------------------------------------------
   focusMinimapOnSegment（将来拡張用プレースホルダー）
   コースの2点間区間がミニマップに収まるよう表示範囲を自動調整する。
   @param {[number,number]} pointA - [lng, lat] 区間始点
   @param {[number,number]} pointB - [lng, lat] 区間終点
   ---------------------------------------------------------------- */
function focusMinimapOnSegment(pointA, pointB) {
  if (!mobileSimState.miniMap) return;
  const bounds = [
    [Math.min(pointA[0], pointB[0]), Math.min(pointA[1], pointB[1])],
    [Math.max(pointA[0], pointB[0]), Math.max(pointA[1], pointB[1])],
  ];
  mobileSimState.miniMap.fitBounds(bounds, { padding: 30, duration: 400 });
}

// ---- トグルボタンのイベント ----
document.getElementById('sim-toggle-btn')?.addEventListener('click', toggleSimMode);


/* ================================================================
   3D 現在位置マーカー（シム中に map.getCenter() を赤点で表示）
   ================================================================ */
function addSimPosMarker() {
  if (mobileSimState.posMarker) return;
  // const isBird = pcSimState.viewMode === 'bird';  // 鳥瞰モード（非表示中）
  const el = document.createElement('div');
  el.id = 'sim-pos-marker-el';
  el.style.cssText = `
    width: 22px; height: 22px; border-radius: 50%;
    background: #e63030;
    border: 4px solid rgba(255,255,255,0.85);
    box-shadow: 0 0 8px rgba(0,0,0,0.55);
    pointer-events: none;
  `;
  mobileSimState.posMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat(map.getCenter())
    .addTo(map);
}

function removeSimPosMarker() {
  if (mobileSimState.posMarker) { mobileSimState.posMarker.remove(); mobileSimState.posMarker = null; }
}

function updateSimPosMarker(lng, lat) {
  if (!mobileSimState.posMarker) return;
  if (lng !== undefined) mobileSimState.posMarker.setLngLat({ lng, lat });
  else mobileSimState.posMarker.setLngLat(map.getCenter()); // モバイルシム用
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
const pcSimState = {
  active:          false,      // PCシム実行中か
  paused:          false,      // Esc で一時停止中か（ポーズHUD表示中）
  animFrame:       null,       // requestAnimationFrame ID
  lastTime:        null,       // 前フレームのタイムスタンプ
  readMap:         null,       // 読図用 MapLibre インスタンス
  readOpen:        false,      // 読図マップ表示中か
  playerLng:       null,       // プレイヤーの経度
  playerLat:       null,       // プレイヤーの緯度
  bearing:         0,          // カメラの向き（deg, 北=0）
  pitch:           SIM_PITCH,  // カメラのピッチ（deg, 0=真下 〜 85=水平）
  camDistM:        50,         // カメラ ↔ プレイヤー間の距離（m）
  smoothedSlopeAdj: 0,         // 地形傾斜による自動ピッチ補正（deg、ローパスフィルタ済み）
  cachedTerrainH:  0,          // queryTerrainElevation が null のときに使うキャッシュ値
  viewMode:        'terrain',  // 'terrain'（地形追従）| 'bird'（鳥瞰）
  // birdAltM:        200,        // 鳥瞰モードの地形相対高度（m）
  // birdBaseTerrainH: 0,         // 開始地点の地形高（bird mode 絶対高度の基準）
  // birdFloorH:       0,         // ローパス済み飛行基準高度（案A+B）
  startLng:        null,       // クリック待ちで記録した開始座標（経度）
  startLat:        null,       // クリック待ちで記録した開始座標（緯度）
  pickingActive:   false,      // クリック待ちモード中か
  keys: {                      // キー押下状態（Pointer Lock 有無に関わらず追跡）
    KeyW: false, KeyA: false, KeyS: false, KeyD: false,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
    // KeyQ: false, KeyE: false,  // bird mode 高度上昇/下降
  },
};
const PC_CAM_DIST_MIN = 1;
const PC_CAM_DIST_MAX = 500;

// ---- 速度スライダー ----
const pcSimSpeedSlider = document.getElementById('pc-sim-speed');

// 離散速度リスト（スライダーのインデックス 0〜13 に対応）
// ランニング帯を細かく、高速帯は粗くなるよう手動設計
const _SIM_SPEEDS = [10, 12, 15, 20, 30, 60, 100, 300, 600, 900];
function simSpeedFromSlider(idx) {
  const i = Math.max(0, Math.min(_SIM_SPEEDS.length - 1, Math.round(idx)));
  return _SIM_SPEEDS[i];
}

// ---- 乗り物モード SVG アイコン ----
const _SVG_RUNNING = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="3.5" r="1.5"/><path d="M13 5 L11 9 L7 12"/><path d="M11 9 L15 10.5"/><path d="M7 12 L5 17 M7 12 L10 16"/></svg>`;
const _SVG_BICYCLE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="14" r="3.5"/><circle cx="15" cy="14" r="3.5"/><path d="M5 14 L10 7 L15 14 M10 7 L13 7 M13 7 L15 10"/></svg>`;
const _SVG_CAR = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 13 L3 8 Q5 7 7 7 L13 7 Q15 7 17 8 L19 13 Z"/><circle cx="5.5" cy="14.5" r="1.8"/><circle cx="14.5" cy="14.5" r="1.8"/><path d="M7 10 L13 10"/></svg>`;
const _SVG_HIGHWAY = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 L7 3 M17 17 L13 3"/><path d="M9.5 14 L10.5 14 M9 10 L11 10 M8.5 6 L11.5 6"/></svg>`;
const _SVG_SHINKANSEN = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10 Q5 6 8 6 L17 6 L17 14 L8 14 Q5 14 2 10 Z"/><line x1="3" y1="16" x2="17" y2="16"/><line x1="5" y1="14" x2="5" y2="16"/><line x1="14" y1="14" x2="14" y2="16"/></svg>`;
const _SVG_MAGLEV = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 10 Q4 7 8 7.5 L18 7.5 L19 10 L18 12.5 L8 12.5 Q4 13 1 10 Z"/><line x1="3" y1="15" x2="17" y2="15"/><line x1="7" y1="12.5" x2="7" y2="15"/><line x1="15" y1="12.5" x2="15" y2="15"/></svg>`;
const _SVG_AIRPLANE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 11 L7 9 L13 3 Q16 1.5 17.5 4 Q19 6.5 17 9 L19 14.5 L16 15 L12 10.5 L8 12 L9 15.5 L6.5 16 L4 12.5 Z"/></svg>`;

// 速度区分定義（min以上max未満）
const _SIM_MODES = [
  { min: 10,  max: 20,   label: 'ランニング', svg: _SVG_RUNNING },
  { min: 20,  max: 40,   label: '自転車',     svg: _SVG_BICYCLE },
  { min: 40,  max: 100,  label: '自動車',     svg: _SVG_CAR },
  { min: 100, max: 160,  label: '高速道路',   svg: _SVG_HIGHWAY },
  { min: 160, max: 350,  label: '新幹線',     svg: _SVG_SHINKANSEN },
  { min: 350, max: 600,  label: 'リニア',     svg: _SVG_MAGLEV },
  { min: 600, max: 1001, label: '飛行機',     svg: _SVG_AIRPLANE },
];
function getSimSpeedMode(kmh) {
  return _SIM_MODES.find(m => kmh >= m.min && kmh < m.max) || _SIM_MODES[_SIM_MODES.length - 1];
}

// km/h → min:sec/km ペース変換
function kmhToPace(kmh) {
  if (!kmh || kmh <= 0) return '--:--';
  const totalSec = Math.round(3600 / kmh);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// バッジ（thumb追随）・速度数値・ペース・アイコンを更新
function updateSimSpeedBubble(slider) {
  if (!slider) return;
  const pct = (parseFloat(slider.value) - parseFloat(slider.min))
            / (parseFloat(slider.max)  - parseFloat(slider.min));
  const kmh = simSpeedFromSlider(parseFloat(slider.value));
  // バッジ位置（CSS --pct 変数で制御）
  const badge = document.getElementById('pc-sim-speed-badge');
  if (badge) badge.style.setProperty('--pct', pct);
  // 速度・ペース数値（ヘッダー大きい数値 + バッジ）
  const pace = kmhToPace(kmh);
  const numEl  = document.getElementById('pc-sim-speed-num');
  if (numEl) numEl.textContent = kmh;
  const paceEl = document.getElementById('pc-sim-pace-display');
  if (paceEl) paceEl.textContent = pace;
  const badgeNum = document.getElementById('pc-sim-badge-speed');
  if (badgeNum) badgeNum.textContent = kmh;
  updateSimSpeedTicks(slider);
}

// 円ドット着色: 現在値以下のインデックス → 青（tick-active）、それ以上 → グレー
function updateSimSpeedTicks(slider) {
  if (!slider) return;
  const currentIdx = Math.round(parseFloat(slider.value));
  const dots = document.querySelectorAll('#pc-sim-speed-dots .sim-speed-tick');
  dots.forEach(dot => {
    const idx = parseInt(dot.dataset.idx, 10);
    dot.classList.toggle('tick-active',   idx <= currentIdx);
    dot.classList.toggle('tick-current',  idx === currentIdx);
  });
}

pcSimSpeedSlider.addEventListener('input', () => {
  updateSliderGradient(pcSimSpeedSlider);
  updateSimSpeedBubble(pcSimSpeedSlider);
});

// ラベルクリック時にスライダー値を更新（上部tick-lbl / 下部mode-lbl の当たり判定拡大）
pcSimSpeedSlider.closest('.slider-bubble-wrap').addEventListener('click', e => {
  if (e.target === pcSimSpeedSlider) return; // スライダー本体はブラウザが処理
  const rect = pcSimSpeedSlider.getBoundingClientRect();
  const thumbR = 6; // thumb半径（px）
  const pct = Math.max(0, Math.min(1,
    (e.clientX - rect.left - thumbR) / (rect.width - thumbR * 2)
  ));
  const max = parseFloat(pcSimSpeedSlider.max);
  const min = parseFloat(pcSimSpeedSlider.min);
  pcSimSpeedSlider.value = Math.round(pct * (max - min) + min);
  updateSliderGradient(pcSimSpeedSlider);
  updateSimSpeedBubble(pcSimSpeedSlider);
});

// 初期状態を反映
updateSliderGradient(pcSimSpeedSlider);
updateSimSpeedBubble(pcSimSpeedSlider);

function getPcSimSpeedKmh() {
  return simSpeedFromSlider(parseFloat(pcSimSpeedSlider.value)) || 50;
}

/* ---- 飛行高度スライダー（鳥瞰モード） ----
// 対数スケール変換: スライダー内部値(0–1000) → 高度(10–5000 m)、10m単位に丸める
const _BIRD_ALT_MIN = 10, _BIRD_ALT_MAX = 5000;
function birdAltFromSlider(t) {
  const raw = _BIRD_ALT_MIN * Math.pow(_BIRD_ALT_MAX / _BIRD_ALT_MIN, t / 1000);
  return Math.round(raw / 10) * 10;
}
function updateBirdAltBubble(slider) {
  if (!slider) return;
  const pct = (parseFloat(slider.value) - parseFloat(slider.min))
            / (parseFloat(slider.max) - parseFloat(slider.min));
  const m = birdAltFromSlider(parseFloat(slider.value));
  const bubble = document.getElementById('pc-bird-alt-bubble');
  if (bubble) { bubble.style.setProperty('--pct', pct); bubble.textContent = m; }
  const numEl = document.getElementById('pc-bird-alt-num');
  if (numEl) numEl.textContent = m;
  // シム実行中の鳥瞰モードならリアルタイム反映
  if (pcSimState.active && pcSimState.viewMode === 'bird') {
    pcSimState.birdAltM = m;
    // スライダー変更はローパスをバイパスして即時反映
    pcSimState.birdFloorH = pcSimState.birdBaseTerrainH + pcSimState.birdAltM;
  }
}

const birdAltSlider = document.getElementById('pc-bird-alt');
if (birdAltSlider) {
  birdAltSlider.addEventListener('input', () => {
    updateSliderGradient(birdAltSlider);
    updateBirdAltBubble(birdAltSlider);
  });
  updateSliderGradient(birdAltSlider);
  updateBirdAltBubble(birdAltSlider);
}
*/

// シミュレーターモード ボタンセレクト
let _simViewMode = 'terrain'; // 現在選択中のモードを変数で保持（DOM クエリより確実）

function getSimViewMode() {
  return _simViewMode;
}
function syncSimStartButtons() {
  const terrainBtn = document.getElementById('pc-sim-toggle-btn');
  const birdBtn = document.getElementById('pc-sim-bird-btn');
  if (!terrainBtn || !birdBtn) return;

  terrainBtn.textContent = (pcSimState.active && pcSimState.viewMode !== 'bird')
    ? '[Esc]でシミュレーター終了'
    : '地面を走る';
  birdBtn.textContent = (pcSimState.active && pcSimState.viewMode === 'bird')
    ? '[Esc]で飛行終了'
    : '空を飛ぶ';
  terrainBtn.classList.toggle('pc-sim-active', pcSimState.active && pcSimState.viewMode !== 'bird');
  birdBtn.classList.toggle('pc-sim-active', pcSimState.active && pcSimState.viewMode === 'bird');
}
/* setSimViewMode と .sim-view-mode-chips イベントリスナー（非表示中）
function setSimViewMode(mode) {
  _simViewMode = (mode === 'bird') ? 'bird' : 'terrain';
  document.querySelectorAll('.sim-view-mode-chips .type-chip').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.simMode ?? 'terrain') === _simViewMode);
  });
  const altItem = document.getElementById('settings-bird-alt-item');
  if (altItem) altItem.style.display = (_simViewMode === 'bird') ? '' : 'none';
}
document.querySelectorAll('.sim-view-mode-chips .type-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    setSimViewMode(btn.dataset.simMode ?? 'terrain');
  });
});
*/
syncSimStartButtons();

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
   Esc でロック解除 → pausePcSim でポーズHUDを表示
   ポーズから再開 → resumePcSimLocked でループ再開
   ---------------------------------------------------------------- */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === document.getElementById('map')) {
    // ポインターロック取得
    if (!pcSimState.active) {
      onPcSimLocked();           // 新規開始
    } else if (pcSimState.paused) {
      resumePcSimLocked();       // ポーズから再開
    }
  } else {
    // ポインターロック解放
    if (pcSimState.active && !pcSimState.paused) {
      pausePcSim();              // Esc 押下 → ポーズHUD表示
    }
    // paused 中の解放は無視（pausePcSim 内で既に処理済み）
  }
});
document.addEventListener('pointerlockerror', (e) => {
  console.error('Pointer Lock エラー:', e);
});

/* ----------------------------------------------------------------
   onPcSimLocked: Pointer Lock 成功後の初期化処理
   ---------------------------------------------------------------- */
function onPcSimLocked() {
  pcSimState.active = true;

  // ① 地図操作を全て無効化
  map.dragPan.disable();
  map.dragRotate.disable();
  map.scrollZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoomRotate.disable();
  map.keyboard.disable();

  // ② プレイヤー位置・カメラパラメータを初期化（クリック位置優先、なければ地図中心）
  const c    = (pcSimState.startLng != null) ? { lng: pcSimState.startLng, lat: pcSimState.startLat } : map.getCenter();
  pcSimState.startLng = null; pcSimState.startLat = null;
  pcSimState.playerLng = c.lng;
  pcSimState.playerLat = c.lat;
  pcSimState.bearing   = map.getBearing();
  pcSimState.camDistM  = 100;

  // モードはボタンクリック時に pcSimState.viewMode へ直接セット済み
  // pcSimState.birdAltM = birdAltFromSlider(parseFloat(document.getElementById('pc-bird-alt')?.value ?? '482'));
  // 初期ピッチは地形追従固定
  pcSimState.pitch     = PC_SIM_PITCH;
  // // 読図マップのドット・矢印を鳥瞰モード時は青色に（非表示中）
  // document.getElementById('pc-sim-readmap-overlay')?.classList.toggle('bird-mode', pcSimState.viewMode === 'bird');
  pcSimState.smoothedSlopeAdj = 0;

  // キャッシュを現在地の地形高度で初期化
  pcSimState.cachedTerrainH  = map.queryTerrainElevation({ lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }) ?? 0;

  /* bird mode: 開始地点の地形高を基準高度として記録（案A）（非表示中）
  if (pcSimState.viewMode === 'bird') {
    pcSimState.birdBaseTerrainH = pcSimState.cachedTerrainH;
    pcSimState.birdFloorH       = pcSimState.cachedTerrainH + pcSimState.birdAltM;
  }
  */

  // ③ カメラをプレイヤー視点へ即配置
  setCameraFromPlayer();

  // ③-b KMZ・フレーム画像を3D地面から一時非表示（Spaceキーの読図マップのみで使用）
  localMapLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', 'none');
    }
  });

  // ④ UIを更新
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('unified-search').style.display = 'none';
  document.getElementById('scale-ctrl-container').style.display = 'none';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = 'none';
  syncSimStartButtons();
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
  pcSimState.lastTime  = null;
  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   pausePcSim: Esc によるポインターロック解放 → ポーズHUD表示
   アニメーションループを停止し、UI はシミュレーターモードのまま保持する。
   ---------------------------------------------------------------- */
function pausePcSim() {
  pcSimState.paused = true;

  // アニメーションループを停止（再開時に再起動する）
  if (pcSimState.animFrame) { cancelAnimationFrame(pcSimState.animFrame); pcSimState.animFrame = null; }

  // クロスヘアとヒントを隠す（HUD と重ならないように）
  document.getElementById('pc-sim-hint').style.display       = 'none';
  document.getElementById('pc-sim-crosshair').style.display  = 'none';

  // ポーズHUDを表示
  document.getElementById('pc-sim-pause-hud').style.display = 'flex';
}

/* ----------------------------------------------------------------
   resumePcSimLocked: ポーズHUDから「再開」→ ポインターロック再取得後の復帰処理
   ---------------------------------------------------------------- */
function resumePcSimLocked() {
  pcSimState.paused = false;

  // ポーズHUDを隠す
  document.getElementById('pc-sim-pause-hud').style.display = 'none';

  // クロスヘアとヒントを復元
  const hintOn = document.getElementById('chk-sim-hint')?.checked ?? true;
  document.getElementById('pc-sim-hint').style.display      = hintOn ? 'block' : 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'block';

  // アニメーションループを再開
  pcSimState.lastTime  = null;
  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   stopPcSim: モード終了 & 全リソースを解放
   ---------------------------------------------------------------- */
function stopPcSim() {
  pcSimState.active = false;
  pcSimState.paused = false;

  // 鳥瞰モードカラーをリセット（非表示中）
  // document.getElementById('pc-sim-readmap-overlay')?.classList.remove('bird-mode');

  // ポーズHUDを非表示
  document.getElementById('pc-sim-pause-hud').style.display = 'none';

  if (pcSimState.animFrame) { cancelAnimationFrame(pcSimState.animFrame); pcSimState.animFrame = null; }

  // 読図マップを閉じて破棄
  closePcReadMap();
  if (pcSimState.readMap) { pcSimState.readMap.remove(); pcSimState.readMap = null; }

  removeSimPosMarker();
  // 鳥瞰固定ドットを非表示（非表示中）
  // const _birdDot = document.getElementById('pc-sim-pos-dot');
  // if (_birdDot) _birdDot.style.display = 'none';

  // キー状態・補正値リセット
  Object.keys(pcSimState.keys).forEach(k => { pcSimState.keys[k] = false; });
  pcSimState.smoothedSlopeAdj = 0;

  // UI 復元
  document.getElementById('sidebar').style.display = '';
  document.getElementById('unified-search').style.display = '';
  document.getElementById('scale-ctrl-container').style.display = '';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = '';
  syncSimStartButtons();
  document.getElementById('pc-sim-hint').style.display = 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'none';

  // KMZ・フレーム画像の表示を復元
  localMapLayers.forEach(entry => {
    if (map.getLayer(entry.layerId)) {
      map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
  });

  // 地図操作を復元
  map.dragPan.enable();
  map.dragRotate.enable();
  map.scrollZoom.enable();
  map.doubleClickZoom.enable();
  map.touchZoomRotate.enable();
  map.keyboard.enable();
  map.easeTo({ pitch: INITIAL_PITCH, duration: EASE_DURATION });

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
   cameraAlt = h + pcSimState.camDistM * cos(pitch) で zoom を計算。
   ---------------------------------------------------------------- */
function setCameraFromPlayer() {
  if (pcSimState.playerLng === null) return;

  // 地形標高取得 — null（タイル未読み込み）の場合はキャッシュ維持。
  // 急降下時にカメラが後方地形にめり込まないよう、高さをスムージング更新する。
  const rawH = map.queryTerrainElevation(
    { lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }
  );
  if (rawH !== null) pcSimState.cachedTerrainH += (rawH - pcSimState.cachedTerrainH) * 0.25;
  const h = pcSimState.cachedTerrainH;

  const H       = map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pcSimState.playerLat * Math.PI / 180;

  /* ── 鳥瞰モード ──────────────────────────────────────────────────────（非表示中）
  // calculateCameraOptionsFromCameraLngLatAltRotation でカメラ eye を直接配置する。
  // プレイヤーの3D上空点 [playerLng, playerLat, h + birdAltM] を中心に
  // pitch/bearing に従いカメラを後方上方に置くことで、
  // 上空の自分を中心にカメラが回転する。
  // pitch > 60° は同メソッドの想定範囲外で破綻するため 60° に制限する。
  if (pcSimState.viewMode === 'bird') {
    // pitch > 84.3° で内部の dzNormalized < 0.1 ガードが発動して破綻するため 84.3° に制限
    const birdPitch    = Math.max(0, Math.min(84, pcSimState.pitch));
    const birdPitchRad = birdPitch * Math.PI / 180;
    // birdFloorH: 開始地点基準の絶対高度（案A）+ 地形フロア保護のローパス済み値（案B）
    const playerAlt    = pcSimState.birdFloorH;
    const camDist      = pcSimState.camDistM;

    const backKm = camDist * Math.sin(birdPitchRad) / 1000;
    const backPt = turf.destination(
      [pcSimState.playerLng, pcSimState.playerLat],
      Math.max(0.00001, backKm),
      (pcSimState.bearing + 180) % 360
    );
    const cameraAlt = playerAlt + Math.max(1, camDist * Math.cos(birdPitchRad));

    const camOpts = map.calculateCameraOptionsFromCameraLngLatAltRotation(
      new maplibregl.LngLat(backPt.geometry.coordinates[0], backPt.geometry.coordinates[1]),
      cameraAlt,
      pcSimState.bearing,
      birdPitch,
      0
    );
    map.jumpTo(camOpts);
    return;
  }
  */

  // ── 地形追従モード ───────────────────────────────────────────────────
  let effectivePitch = Math.max(0, Math.min(map.getMaxPitch(), pcSimState.pitch + pcSimState.smoothedSlopeAdj));
  const pitchRad = effectivePitch * Math.PI / 180;

  // カメラの後方地上点の地形高度を取得し、カメラが後方地形にめり込まないよう保証する。
  // （pitch=80°では水平98m後方・垂直17mにカメラが位置するため、後方が上り坂だと地形貫通しやすい）
  const backDistKm = pcSimState.camDistM * Math.sin(pitchRad) / 1000;
  const backPt = turf.destination([pcSimState.playerLng, pcSimState.playerLat], backDistKm, (pcSimState.bearing + 180) % 360);
  const backH = map.queryTerrainElevation(
    { lng: backPt.geometry.coordinates[0], lat: backPt.geometry.coordinates[1] },
    { exaggerated: false }
  ) ?? h;

  const cameraAlt = Math.max(
    h + Math.max(0.3, pcSimState.camDistM * Math.cos(pitchRad)),
    backH + Math.max(1, Math.min(8, pcSimState.camDistM * 0.3)) // 後方地形マージンをカメラ距離に比例させる
  );

  // zoom 計算は地形面からのカメラ相対高度（pcSimState.camDistM * cos(pitch)）を基準にする。
  // cameraAlt（絶対標高）を使うと山岳地では数十mになり高ズームに届かなくなるため。
  const relativeAlt = Math.max(0.3, pcSimState.camDistM * Math.cos(pitchRad));
  const targetZoom = Math.max(12, Math.min(map.getMaxZoom(), Math.log2(
    H * 2 * Math.PI * R * Math.cos(lat_rad) /
    (1024 * Math.tan(fov_rad / 2) * relativeAlt)
  )));

  map.jumpTo({
    center:  [pcSimState.playerLng, pcSimState.playerLat],
    bearing: pcSimState.bearing,
    pitch:   effectivePitch,
    zoom:    targetZoom
  });
}

function enforceTerrainFloor() {
  if (pcSimState.active) return; // PCシムは setCameraFromPlayer で制御
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
  const effectiveZoom = Math.min(mobileSimState.targetZoom, floorZoom);

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
  if (!pcSimState.active) return;

  // --- deltaTime（秒）を計算 ---
  const dt = pcSimState.lastTime ? Math.min((timestamp - pcSimState.lastTime) / 1000, 0.1) : 0.016;
  pcSimState.lastTime = timestamp;

  // ── WASD 移動（pcSimState.playerLng/Lat を直接更新） ──────────────────────
  const fwd   = (pcSimState.keys.KeyW ? 1 : 0) - (pcSimState.keys.KeyS ? 1 : 0);
  const right = (pcSimState.keys.KeyD ? 1 : 0) - (pcSimState.keys.KeyA ? 1 : 0);

  if (fwd !== 0 || right !== 0) {
    const len        = Math.sqrt(fwd * fwd + right * right);
    const distKm     = (getPcSimSpeedKmh() / 3600) * dt;
    const moveBearing = pcSimState.bearing + Math.atan2(right / len, fwd / len) * (180 / Math.PI);
    const dest = turf.destination([pcSimState.playerLng, pcSimState.playerLat], distKm, moveBearing);

    if (true) {
      pcSimState.playerLng = dest.geometry.coordinates[0];
      pcSimState.playerLat = dest.geometry.coordinates[1];
    }
  }

  // ── 矢印キー視点（pcSimState.bearing / pcSimState.pitch を更新） ───────────────────
  const ARROW_BEARING_RATE = 90;  // deg/s
  const ARROW_PITCH_RATE   = 60;  // deg/s

  if (pcSimState.keys.ArrowLeft)  pcSimState.bearing = (pcSimState.bearing - ARROW_BEARING_RATE * dt + 360) % 360;
  if (pcSimState.keys.ArrowRight) pcSimState.bearing = (pcSimState.bearing + ARROW_BEARING_RATE * dt) % 360;
  if (pcSimState.keys.ArrowUp)    pcSimState.pitch   = Math.min(84, pcSimState.pitch + ARROW_PITCH_RATE * dt);
  if (pcSimState.keys.ArrowDown)  pcSimState.pitch   = Math.max(0,  pcSimState.pitch - ARROW_PITCH_RATE * dt);

  // ── 地形傾斜による自動ピッチ補正（地形追従モードのみ） ──────────────
  // 進行方向 25m 先との高度差からスロープ角を推定し、
  // ローパスフィルタ（時定数 1.4s）で平滑化して酔い防止
  if (pcSimState.viewMode === 'terrain' && map.getTerrain()) {
    const SLOPE_SAMPLE_KM = 0.025; // 25m 先をサンプリング
    const SLOPE_INFLUENCE  = 0.40; // 傾斜角の何割を補正に使うか
    const MAX_SLOPE_ADJ    = 20;   // 最大補正量（deg）
    const SMOOTH_TC        = 1.4;  // 平滑化時定数（秒）

    const elevNow = map.queryTerrainElevation(
      { lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }
    ) ?? 0;
    const fwdPt = turf.destination([pcSimState.playerLng, pcSimState.playerLat], SLOPE_SAMPLE_KM, pcSimState.bearing);
    const elevFwd = map.queryTerrainElevation(
      { lng: fwdPt.geometry.coordinates[0], lat: fwdPt.geometry.coordinates[1] },
      { exaggerated: false }
    ) ?? elevNow;

    // slopeDeg: 正=上り、負=下り
    const slopeDeg = Math.atan2(elevFwd - elevNow, SLOPE_SAMPLE_KM * 1000) * (180 / Math.PI);
    const targetAdj = Math.max(-MAX_SLOPE_ADJ, Math.min(MAX_SLOPE_ADJ, slopeDeg * SLOPE_INFLUENCE));

    // ローパスフィルタ（急激な補正を抑制）
    pcSimState.smoothedSlopeAdj += (targetAdj - pcSimState.smoothedSlopeAdj) * Math.min(dt / SMOOTH_TC, 1);
  } else {
    // 鳥瞰モード or 地形なし: 傾斜補正をゼロに維持
    pcSimState.smoothedSlopeAdj = 0;
  }

  /* ── bird mode: Q/E 高度制御 + 飛行基準高度更新 ──────────────────────────（非表示中）
  // 通常: ローパスフィルタで地形変化に滑らかに追従
  // Q/E 押下時: ローパスをバイパスしてレート速度で即時変更
  if (pcSimState.viewMode === 'bird') {
    const BIRD_CLEARANCE_M = 0;   // 地形からの最低クリアランス（m）
    const BIRD_FLOOR_TC    = 20;  // ローパス時定数（秒）
    const BIRD_ALT_RATE    = getPcSimSpeedKmh() / 3.6;  // Q/E 高度変化速度 = 移動速度と同じ（m/s）

    const currentTerrain = map.queryTerrainElevation(
      { lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }
    ) ?? pcSimState.cachedTerrainH;
    const floorH = currentTerrain + BIRD_CLEARANCE_M;

    if (pcSimState.keys.KeyQ || pcSimState.keys.KeyE) {
      // Q/E: レートに従って birdAltM を変化させ、ローパスをバイパスして即時反映
      if (pcSimState.keys.KeyQ) {
        const minAltM = floorH - pcSimState.birdBaseTerrainH;  // 現在地形を下限に
        pcSimState.birdAltM = Math.max(minAltM, pcSimState.birdAltM - BIRD_ALT_RATE * dt);
      }
      if (pcSimState.keys.KeyE) {
        pcSimState.birdAltM = Math.min(5000, pcSimState.birdAltM + BIRD_ALT_RATE * dt);
      }
      pcSimState.birdFloorH = Math.max(pcSimState.birdBaseTerrainH + pcSimState.birdAltM, floorH);
    } else {
      // 通常: 目標高度へローパスフィルタで追従
      // birdAltM=0（地表面）のときは即時追従して地面に沿って走る
      const targetH = pcSimState.birdBaseTerrainH + pcSimState.birdAltM;
      const neededH = Math.max(targetH, floorH);
      const tc = pcSimState.birdAltM === 0 ? 0 : BIRD_FLOOR_TC;
      pcSimState.birdFloorH = tc === 0
        ? neededH
        : pcSimState.birdFloorH + (neededH - pcSimState.birdFloorH) * Math.min(1, dt / tc);
    }
  }
  */

  // ── カメラを配置（プレイヤーを常に画面中央に） ───────────────────
  setCameraFromPlayer();

  // ── 読図マップ同期 ──────────────────────────────────────────────
  if (pcSimState.readOpen && pcSimState.readMap) {
    pcSimState.readMap.setCenter([pcSimState.playerLng, pcSimState.playerLat]);
    document.getElementById('pc-sim-readmap-inner').style.transform =
      `rotate(${-pcSimState.bearing}deg)`;
  }

  /* bird mode ドット表示（非表示中）
  if (pcSimState.viewMode === 'bird') {
    // 鳥瞰モード: 画面中央固定の CSS ドット（#pc-sim-pos-dot）でプレイヤー位置を表示
    // maplibregl.Marker は terrain 面に投影されるため altitude が反映されない。
    // setCameraFromPlayer() で center = playerLng/Lat にしているため、
    // 固定中央ドットが常に自分の真上の空中にあるように見える。
    if (mobileSimState.posMarker) mobileSimState.posMarker.getElement().style.display = 'none';
    const dot = document.getElementById('pc-sim-pos-dot');
    if (dot) { dot.style.display = 'block'; dot.style.background = '#0369b0'; }
  } else { */
    const dot = document.getElementById('pc-sim-pos-dot');
    if (dot) { dot.style.display = 'none'; dot.style.background = ''; }
    updateSimPosMarker(pcSimState.playerLng, pcSimState.playerLat);
  /* } */

  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   マウスイベントハンドラ
   ---------------------------------------------------------------- */
function onPcSimMouseMove(e) {
  if (!pcSimState.active || !document.pointerLockElement) return;

  const MOUSE_BEARING_SENS = 0.15; // deg/px
  const MOUSE_PITCH_SENS   = 0.10; // deg/px

  pcSimState.bearing = (pcSimState.bearing + e.movementX * MOUSE_BEARING_SENS + 360) % 360;
  // movementY < 0（マウス上移動）→ pitch 増加（より水平視点）
  pcSimState.pitch = Math.max(0, Math.min(85, pcSimState.pitch - e.movementY * MOUSE_PITCH_SENS));
}

function onPcSimMouseDown(e) {
  if (!pcSimState.active) return;
  if (e.button === 2) openPcReadMap(); // 右クリック → 読図
}

function onPcSimMouseUp(e) {
  if (!pcSimState.active) return;
  if (e.button === 2) closePcReadMap();
}

function onPcSimContextMenu(e) {
  if (pcSimState.active) e.preventDefault(); // 右クリックメニューを抑止
}

/* ----------------------------------------------------------------
   キーボードイベントハンドラ（グローバル）
   WASD / 矢印 の押下状態を管理し、Space で読図を開閉する
   ---------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  // PC シムのキー操作
  if (e.code in pcSimState.keys) {
    pcSimState.keys[e.code] = true;
    if (pcSimState.active) e.preventDefault();
  }
  if (pcSimState.active && e.code === 'Space') {
    e.preventDefault();
    openPcReadMap();
  }
  // I/O キー：カメラ距離（PCシム中 or GPX 3D中）
  if ((pcSimState.active || gpxState.viewMode === '3d') && (e.code === 'KeyI' || e.code === 'KeyO')) {
    e.preventDefault();
    if (pcSimState.active) {
      if (e.code === 'KeyI') pcSimState.camDistM = Math.max(PC_CAM_DIST_MIN, pcSimState.camDistM * 0.7);
      else                   pcSimState.camDistM = Math.min(PC_CAM_DIST_MAX, pcSimState.camDistM * 1.4);
    } else {
      if (e.code === 'KeyI') gpxState.camDistM = Math.max(GPX_CAM_DIST_MIN, gpxState.camDistM * 0.7);
      else                   gpxState.camDistM = Math.min(GPX_CAM_DIST_MAX, gpxState.camDistM * 1.4);
    }
  }
  // GPX 3D モードの矢印キー（PC シム非アクティブ時のみ）
  if (gpxState.viewMode === '3d' && !pcSimState.active && e.code in gpxState.chaseKeys) {
    gpxState.chaseKeys[e.code] = true;
    e.preventDefault();
  }
  // W/S キー：GPX 再生中に時間を進める/戻す（2D/3D 両モード対応、PCシム非アクティブ時）
  if (!pcSimState.active && gpxState.trackPoints.length > 0 && (e.code === 'KeyW' || e.code === 'KeyS')) {
    e.preventDefault();
    const SEEK_STEP = 5000; // 5秒
    if (e.code === 'KeyW') gpxState.currentTime = Math.min(gpxState.totalDuration, gpxState.currentTime + SEEK_STEP);
    else                   gpxState.currentTime = Math.max(0, gpxState.currentTime - SEEK_STEP);
    const seekBar = document.getElementById('seek-bar');
    seekBar.value = gpxState.currentTime;
    updateSeekBarGradient();
    updateTimeDisplay();
    const pos = interpolateGpxPosition(gpxState.currentTime);
    if (pos) {
      gpxState.smoothedBearing = pos.bearing; // W/S シーク時もスナップ
      updateGpxMarker(pos);
      updateCamera(pos, 16);
    }
  }
});

// モバイルシム：ズームスライダー操作
document.getElementById('sim-zoom-slider').addEventListener('input', function () {
  const z = parseFloat(this.value);
  mobileSimState.targetZoom = z;
  map.setZoom(z);
  document.getElementById('sim-zoom-val').textContent = z.toFixed(1);
  updateSliderGradient(this);
});

document.addEventListener('keyup', (e) => {
  if (e.code in pcSimState.keys) pcSimState.keys[e.code] = false;
  if (e.code in gpxState.chaseKeys) gpxState.chaseKeys[e.code] = false;
  if (pcSimState.active && e.code === 'Space') closePcReadMap();
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
    : (!BASEMAPS[bgKey] ? 'gsi-std' : bgKey);

  const bm = BASEMAPS[tileKey];
  return {
    version: 8,
    sources: {
      'pc-read-base': {
        type: 'raster',
        tiles: [bm.url],
        tileSize: Math.round(256 / (window.devicePixelRatio || 1)),
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
var _lastMagneticNorthData = { type: 'FeatureCollection', features: [] };

function syncReadmapOriLibre() {
  if (!pcSimState.readMap || !pcSimState.readMap.isStyleLoaded()) return;
  if (document.getElementById('sel-readmap-bg').value !== 'orilibre') return;

  // ── 等高線: tile URL と visibility を同期 ──────────────────────
  if (pcSimState.readMap.getSource('contour-source') && lastAppliedContourInterval) {
    const newUrl = buildContourTileUrl(lastAppliedContourInterval);
    if (newUrl) pcSimState.readMap.getSource('contour-source').setTiles([newUrl]);
  }
  const contourVis = contourCard.classList.contains('active') ? 'visible' : 'none';
  for (const id of contourLayerIds) {
    if (!pcSimState.readMap.getLayer(id)) continue;
    // symbol レイヤー（数値ラベル）は常に非表示
    const vis = pcSimState.readMap.getLayer(id).type === 'symbol' ? 'none' : contourVis;
    pcSimState.readMap.setLayoutProperty(id, 'visibility', vis);
  }

  // ── 磁北線: ソース・レイヤーを初回追加してから GeoJSON を同期 ──
  const magnVis = magneticCard.classList.contains('active') ? 'visible' : 'none';
  if (!pcSimState.readMap.getSource('magnetic-north')) {
    pcSimState.readMap.addSource('magnetic-north', {
      type: 'geojson',
      data: _lastMagneticNorthData,
    });
    pcSimState.readMap.addLayer({
      id: 'magnetic-north-layer',
      type: 'line',
      source: 'magnetic-north',
      layout: { visibility: magnVis },
      paint: {
        'line-color': getMagneticLineColor(),
        'line-width': 0.8,
        'line-opacity': 1.0,
      },
    });
  } else {
    pcSimState.readMap.getSource('magnetic-north').setData(_lastMagneticNorthData);
    if (pcSimState.readMap.getLayer('magnetic-north-layer')) {
      pcSimState.readMap.setLayoutProperty('magnetic-north-layer', 'visibility', magnVis);
      applyMagneticLineColor(pcSimState.readMap);
    }
  }
}

/* ----------------------------------------------------------------
   initPcReadMap: 読図用 MapLibre インスタンスを生成
   選択中の読図地図設定を反映したベースで初期化する。
   ---------------------------------------------------------------- */
function initPcReadMap() {
  if (pcSimState.readMap) return;

  // 選択中の読図地図背景を取得
  const bgKey = document.getElementById('sel-readmap-bg').value;

  pcSimState.readMap = new maplibregl.Map({
    container: 'pc-sim-readmap-map',
    style:       getReadmapBaseStyle(bgKey),
    center:      [pcSimState.playerLng ?? map.getCenter().lng, pcSimState.playerLat ?? map.getCenter().lat],
    zoom:        16,
    bearing:     0,
    pitch:       0,
    interactive: false,
    attributionControl: false,
  });

  pcSimState.readMap.on('load', () => {
    syncKmzToPcReadMap(bgKey);
    syncReadmapOriLibre();
    // ロード完了後に rotation・resize を適用（遅延初期化の場合に必要）
    document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcSimState.bearing}deg)`;
    pcSimState.readMap.resize();
  });
}

/* ----------------------------------------------------------------
   syncKmzToPcReadMap: localMapLayers を読図マップに複製
   bgKey が 'kmz-{id}' の場合は対象 KMZ のみ表示、それ以外は全 KMZ を重ねる。
   ---------------------------------------------------------------- */
function syncKmzToPcReadMap(bgKey) {
  if (!pcSimState.readMap || !pcSimState.readMap.isStyleLoaded()) return;
  // bgKey が省略された場合は現在の選択値を参照
  bgKey = bgKey ?? document.getElementById('sel-readmap-bg').value;

  // KMZ モードかどうかと、選択された KMZ の id を判定
  const isKmzMode   = bgKey.startsWith('kmz-');
  const selectedKmzId = isKmzMode ? parseInt(bgKey.slice(4)) : -1;

  localMapLayers.forEach(entry => {
    if (pcSimState.readMap.getSource(entry.sourceId)) return;
    const spec = map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    pcSimState.readMap.addSource(entry.sourceId, spec);
    pcSimState.readMap.addLayer({
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
   KMZ 追加・削除時（renderLocalMapList）から呼ばれる。
   ---------------------------------------------------------------- */
function updateReadmapBgKmzOptions() {
  const sel = document.getElementById('sel-readmap-bg');
  if (!sel) return;

  const currentVal = sel.value;

  // data-kmz 属性付き option（KMZ 区切り線＋KMZ 項目）を全て削除してから再構築
  [...sel.options].filter(o => o.dataset.kmz).forEach(o => o.remove());

  if (localMapLayers.length > 0) {
    // KMZ ファイルを先頭（index=0）から順に挿入（読み込んだ地図が最上部に来るよう）
    // 区切り線（KMZ の後に配置）
    const sep = new Option('──────');
    sep.disabled = true;
    sep.dataset.kmz = '1';
    sel.insertBefore(sep, sel.options[0]);

    // KMZ ファイルを逆順で index=0 に挿入することで先頭に降順追加
    [...localMapLayers].reverse().forEach(entry => {
      const shortName = entry.name.replace(/\.kmz$/i, '');
      const opt = new Option(`🗺 ${shortName}`, `kmz-${entry.id}`);
      opt.dataset.kmz = '1';
      sel.insertBefore(opt, sel.options[0]);
    });
  }

  // 選択値を維持。削除されたKMZが選択されていた場合は 'orilibre' に戻す。
  const validVals = new Set([
    'orilibre', 'gsi-std', 'gsi-pale', 'gsi-photo', 'osm',
    ...localMapLayers.map(e => `kmz-${e.id}`),
  ]);
  sel.value = validVals.has(currentVal) ? currentVal : 'orilibre';

  // カスタムセレクトUIにオプション変更を反映
  if (sel._csRefresh) sel._csRefresh();
}

/* ----------------------------------------------------------------
   openPcReadMap / closePcReadMap: 読図マップの表示・非表示
   ---------------------------------------------------------------- */
function openPcReadMap() {
  if (pcSimState.readOpen) return;
  pcSimState.readOpen = true;

  const overlay = document.getElementById('pc-sim-readmap-overlay');
  overlay.classList.add('visible');

  if (!pcSimState.readMap) {
    // 初回: オーバーレイが visible になってから初期化（WebGL コンテキストを正常サイズで生成）
    initPcReadMap();
    return;
  }

  pcSimState.readMap.setCenter([pcSimState.playerLng ?? map.getCenter().lng, pcSimState.playerLat ?? map.getCenter().lat]);
  document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcSimState.bearing}deg)`;
  pcSimState.readMap.resize();
}

function closePcReadMap() {
  if (!pcSimState.readOpen) return;
  pcSimState.readOpen = false;
  document.getElementById('pc-sim-readmap-overlay').classList.remove('visible');
}

// ---- 開始位置クリック待ちモード ----
function enterSimStartPicking() {
  if (pcSimState.pickingActive || pcSimState.active) return;
  pcSimState.pickingActive = true;
  document.getElementById('sim-start-cursor').style.display = 'block';
  document.getElementById('sim-start-hint-overlay').style.display = 'block';
  document.addEventListener('mousemove', _onSimPickMouseMove);
  document.getElementById('map').addEventListener('click', _onSimPickClick);
  document.addEventListener('keydown', _onSimPickKeydown);
}

function exitSimStartPicking() {
  if (!pcSimState.pickingActive) return;
  pcSimState.pickingActive = false;
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
  pcSimState.startLng = lngLat.lng;
  pcSimState.startLat = lngLat.lat;
  exitSimStartPicking();
  startPcSim();
}

function _onSimPickKeydown(e) {
  if (e.key === 'Escape') exitSimStartPicking();
}

// ---- PCシムボタンのイベント ----
document.getElementById('pc-sim-toggle-btn').addEventListener('click', () => {
  if (pcSimState.active) stopPcSim();
  else {
    pcSimState.viewMode = 'terrain'; // ボタンクリック時に直接セット
    enterSimStartPicking();
  }
});

/* 「空を飛ぶ」ボタンのイベントリスナー（非表示中）
document.getElementById('pc-sim-bird-btn').addEventListener('click', () => {
  if (pcSimState.active) stopPcSim();
  else {
    pcSimState.viewMode = 'bird'; // ボタンクリック時に直接セット
    enterSimStartPicking();
  }
});
*/

/* ----------------------------------------------------------------
   システム設定モーダル: 開閉
   ---------------------------------------------------------------- */
function openSysSettingsModal() {
  document.getElementById('sys-settings-modal').style.display = 'flex';
  // バブル位置は CSS calc(--pct) で決まるため即時更新可
  const _ms = document.getElementById('ppi-manual-slider');
  if (_ms) { _ms.value = currentDevicePPI; updateSliderGradient(_ms); updatePpiSliderBubble(_ms); }
  // 定規は clientWidth が必要。二重 rAF でレイアウト確定後に取得する
  requestAnimationFrame(() => requestAnimationFrame(() => { updatePpiRuler(); }));
}
function closeSysSettingsModal() {
  document.getElementById('sys-settings-modal').style.display = 'none';
}

document.getElementById('sys-settings-open-btn').addEventListener('click', openSysSettingsModal);
document.getElementById('sys-settings-close-btn').addEventListener('click', closeSysSettingsModal);

// 左ナビのセクション切り替え
document.getElementById('settings-nav').addEventListener('click', e => {
  const btn = e.target.closest('.settings-nav-item');
  if (!btn) return;
  const sec = btn.dataset.section;
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.settings-section').forEach(s => s.classList.toggle('active', s.id === `settings-sec-${sec}`));
  // 画面・校正セクション表示時に定規を再描画（非表示中は clientWidth=0 のため）
  if (sec === 'display') requestAnimationFrame(() => { updatePpiRuler(); });
});
// モーダル背景クリックで閉じる
document.getElementById('sys-settings-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sys-settings-modal')) closeSysSettingsModal();
});

/* ----------------------------------------------------------------
   ポーズHUD: 再開 / システム設定 / 終了 ボタン
   ---------------------------------------------------------------- */
document.getElementById('pause-hud-resume-btn').addEventListener('click', () => {
  // ポーズHUD を隠してポインターロックを再取得 → resumePcSimLocked が呼ばれる
  document.getElementById('pc-sim-pause-hud').style.display = 'none';
  startPcSim();
});

document.getElementById('pause-hud-settings-btn').addEventListener('click', openSysSettingsModal);

document.getElementById('pause-hud-stop-btn').addEventListener('click', () => {
  stopPcSim();
});


// ---- 読図地図セレクト変更 ----
// PC シム起動中に変更した場合は読図マップを即座に再構築する。
document.getElementById('sel-readmap-bg').addEventListener('change', () => {
  if (pcSimState.readMap && pcSimState.active) {
    closePcReadMap();
    pcSimState.readMap.remove();
    pcSimState.readMap = null;
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

    // Blob を importState.imgBlob に保存しておく（IndexedDB 保存に使用）
    const imgBlob = await imgEntry.async('blob');
    importState.imgBlob = imgBlob;
    importState.imgFile = null;

    const imgUrl = URL.createObjectURL(imgBlob);

    // モーダルをKMZ座標で開く（用紙サイズ設定UIは不要なので非表示）
    openImportModalWithCoords(imgUrl, kmzCoords, file.name);
  } catch (err) {
    console.error('KMZモーダル展開エラー:', err);
    alert(`KMZの読み込みに失敗しました: ${err.message}`);
  }
}

const importState = {
  // 画像情報
  imgFile:          null,   // インポート中の画像 File（画像直接読み込み時のみ）
  imgBlob:          null,   // 画像 Blob（IndexedDB 保存用。KMZ由来でも保持）
  imgUrl:           null,   // 対応する ObjectURL
  imgAspect:        null,   // 元画像の縦横比（width / height）
  coords:           null,   // 現在の4隅座標 [[lng,lat]*4] TL→TR→BR→BL
  center:           null,   // 中心マーカー位置 {lng, lat}
  baseCoords:       null,   // KMZモード：ドラッグ前の基準4隅座標（回転前）
  scaleCornerMarkers: [],   // 拡大縮小モードの4隅マーカー
  _handlers:        null,   // イベントハンドラ参照（closeAlignEditor でのクリーンアップ用）
  // Undo/Redo
  history:          [],     // undo スタック
  future:           [],     // redo スタック
  // スケール補正
  scaleVal:         100,    // 現在のスケール倍率（パーセント）
  baseScaleCoords:  null,   // スケール100%時の4隅座標（平行移動・回転と連動して更新）
  // ドラッグ（平行移動）
  isDragging:           false,
  dragStartLngLat:      null,
  dragStartCoords:      null,
  dragStartCenter:      null,
  dragStartBaseScaleCoords: null,   // 平行移動開始時の baseScaleCoords
  dragStartFixedPoints:     null,   // 平行移動開始時の固定点配列
  dragStartPendingFixedPoint: null, // 平行移動開始時の仮固定点
  dragRafId:        null,   // RAF スロットル用 ID
  // 固定点
  fixedPoints:              [],     // 固定点配列 [{lng, lat}]（最大2）
  fixedPointMarkers:        [],     // 固定点DOM要素配列
  fixedPointOverlay:        null,   // 固定点描画オーバーレイ
  pendingFixedPoint:        null,   // 追加中の仮固定点 {lng, lat}
  isSettingFixedPoint:      false,  // 固定点選択待ち（クリックで仮固定点を作る）
  isPlacingFixedPoint:      false,  // 仮固定点を画像と一緒にドラッグして位置合わせ中
  fixedPointOverlayEventsAdded: false,
  // 初期化フラグ
  interactionInited: false,
  eventsAdded:       false,
  // 磁気偏角キャッシュ（ドラッグ中に毎回計算しないよう dragend で更新）
  cachedDecl:       0,
  // コース枠スナップ / 確定時のコース枠 ID
  // null → 確定時に新規コース枠を作成（アクティブイベントがあれば）
  // 文字列 → 既存コース枠に画像を追加
  activeMapSheetId: null,
};

function _ensureFixedPointOverlay() {
  const container = map.getContainer();
  if (!importState.fixedPointOverlay || !importState.fixedPointOverlay.isConnected) {
    const el = document.createElement('div');
    el.id = '_import-fixed-point-overlay';
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;';
    container.appendChild(el);
    importState.fixedPointOverlay = el;
  }
  if (!importState.fixedPointOverlayEventsAdded) {
    importState.fixedPointOverlayEventsAdded = true;
    const onReproject = () => _positionFixedPointDom();
    map.on('move', onReproject);
    map.on('resize', onReproject);
  }
}

function _positionFixedPointDom() {
  if (!importState.fixedPointOverlay) return;
  importState.fixedPointMarkers.forEach((el) => {
    const lng = parseFloat(el.dataset.lng || 'NaN');
    const lat = parseFloat(el.dataset.lat || 'NaN');
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const p = map.project([lng, lat]);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  });
}

function _renderFixedPointMarkers() {
  _ensureFixedPointOverlay();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (!importState.fixedPointOverlay) return;
  importState.fixedPoints.forEach((pt, i) => {
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
        const rect   = map.getContainer().getBoundingClientRect();
        const lngLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        importState.fixedPoints[idx] = { lng: lngLat.lng, lat: lngLat.lat };
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

    importState.fixedPointOverlay.appendChild(el);
    importState.fixedPointMarkers.push(el);
  });
  if (importState.pendingFixedPoint) {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#e54848;border:2px dashed #fff;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);opacity:0.9;position:absolute;transform:translate(-50%,-50%);';
    el.dataset.lng = String(importState.pendingFixedPoint.lng);
    el.dataset.lat = String(importState.pendingFixedPoint.lat);
    importState.fixedPointOverlay.appendChild(el);
    importState.fixedPointMarkers.push(el);
  }
  _positionFixedPointDom();
}

function _updateFixedPointStatus() {
  const st = document.getElementById('import-fixed-point-status');
  const ct = document.getElementById('import-fixed-point-count');
  if (ct) ct.textContent = `${importState.fixedPoints.length} / 2`;
  if (!st) return;
  if (importState.isPlacingFixedPoint) {
    st.textContent = '位置合わせ中: 画像をドラッグして離すと固定点を確定';
  } else if (importState.isSettingFixedPoint) {
    st.textContent = `点選択中: ${importState.fixedPoints.length + 1}点目を地図上でクリック`;
  } else if (importState.fixedPoints.length > 0) {
    st.textContent = `固定点設定済み: ${importState.fixedPoints.length}点（通常平行移動は無効）`;
  } else {
    st.textContent = '待機中';
  }
  const setBtn = document.getElementById('import-fixed-point-set');
  const commitBtn = document.getElementById('import-fixed-point-commit');
  if (setBtn) {
    setBtn.classList.toggle('active', importState.isSettingFixedPoint || importState.isPlacingFixedPoint);
    setBtn.disabled = importState.fixedPoints.length >= 2;
  }
  if (commitBtn) {
    commitBtn.disabled = !importState.pendingFixedPoint;
  }
}

function _setFixedPointSettingMode(on) {
  importState.isSettingFixedPoint = !!on && importState.fixedPoints.length < 2;
  if (!importState.isSettingFixedPoint) importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  map.getCanvas().style.cursor = importState.isSettingFixedPoint ? 'crosshair' : '';
  _updateFixedPointStatus();
}

function _setPendingFixedPoint(lng, lat) {
  importState.pendingFixedPoint = { lng, lat };
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = true;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _commitPendingFixedPoint() {
  if (!importState.pendingFixedPoint || importState.fixedPoints.length >= 2) return;
  importState.fixedPoints.push({ ...importState.pendingFixedPoint });
  importState.pendingFixedPoint = null;
  importState.isPlacingFixedPoint = false;
  importState.isSettingFixedPoint = false;
  _updateBaseScaleCoords();
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _clearImportFixedPoints() {
  importState.fixedPoints = [];
  importState.pendingFixedPoint = null;
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _getImportTransformOrigin() {
  if (importState.fixedPoints.length > 0) {
    const sum = importState.fixedPoints.reduce((acc, pt) => ({ lng: acc.lng + pt.lng, lat: acc.lat + pt.lat }), { lng: 0, lat: 0 });
    return [sum.lng / importState.fixedPoints.length, sum.lat / importState.fixedPoints.length];
  }
  if (importState.center) return [importState.center.lng, importState.center.lat];
  return null;
}

function _rotateCoordsAroundPivot(coords, angleDeg, pivot) {
  const poly = turf.polygon([[...coords, coords[0]]]);
  const rot  = turf.transformRotate(poly, angleDeg, { pivot });
  return rot.geometry.coordinates[0].slice(0, 4);
}

function _recalcImportCenterFromCoords() {
  if (!importState.coords) return;
  importState.center = {
    lng: importState.coords.reduce((s, c) => s + c[0], 0) / 4,
    lat: importState.coords.reduce((s, c) => s + c[1], 0) / 4,
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
  if (!importState.isPlacingFixedPoint || !importState.dragStartCoords || !importState.dragStartLngLat || !currentLngLat) return;
  const dx = currentLngLat.lng - importState.dragStartLngLat.lng;
  const dy = currentLngLat.lat - importState.dragStartLngLat.lat;
  const hasPivot = (importState.dragStartFixedPoints || []).length >= 1;
  if (hasPivot && importState.dragStartPendingFixedPoint) {
    const pivot = [importState.dragStartFixedPoints[0].lng, importState.dragStartFixedPoints[0].lat];
    const startMove = [importState.dragStartPendingFixedPoint.lng, importState.dragStartPendingFixedPoint.lat];
    const currentMove = [currentLngLat.lng, currentLngLat.lat];
    importState.coords = _transformCoordsByPivotMove(importState.dragStartCoords, pivot, startMove, currentMove);
    _recalcImportCenterFromCoords();
    importState.fixedPoints = importState.dragStartFixedPoints.map(pt => ({ ...pt }));
    importState.pendingFixedPoint = { lng: currentLngLat.lng, lat: currentLngLat.lat };
  } else if (importState.dragStartPendingFixedPoint) {
    importState.coords = importState.dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
    if (importState.dragStartBaseScaleCoords)
      importState.baseScaleCoords = importState.dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
    importState.pendingFixedPoint = { lng: importState.dragStartPendingFixedPoint.lng + dx, lat: importState.dragStartPendingFixedPoint.lat + dy };
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
  if (importState.imgAspect && importState.imgAspect > 0) {
    const paperAspect = paperWmm / paperHmm;
    if (importState.imgAspect > paperAspect) {
      effWmm = paperWmm;
      effHmm = effWmm / importState.imgAspect;
    } else {
      effHmm = paperHmm;
      effWmm = effHmm * importState.imgAspect;
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
  if (!importState.imgUrl || !importState.coords) return;
  const src = map.getSource('_import-img');
  if (src) {
    // ドラッグ中の高速パス:
    // 画像URL再設定を伴う updateImage は高コストになりやすいため、
    // 利用可能なら setCoordinates で座標のみ更新する。
    if (typeof src.setCoordinates === 'function') {
      src.setCoordinates(importState.coords);
    } else {
      src.updateImage({ url: importState.imgUrl, coordinates: importState.coords });
    }
    map.triggerRepaint();
  } else {
    // 初回: ソース・レイヤーを追加（透明度スライダーの現在値を反映）
    const initOpacity = (parseInt(document.getElementById('import-opacity')?.value ?? '70', 10)) / 100;
    map.addSource('_import-img', { type: 'image', url: importState.imgUrl, coordinates: importState.coords });
    map.addLayer({ id: '_import-layer', type: 'raster', source: '_import-img', paint: { 'raster-opacity': initOpacity } });
  }
  // ヒットボックスの初期化 & 更新（ドラッグ中はスキップして軽量化）
  _initImgInteraction();
  if (!importState.isDragging) {
    _updateHitbox();
    enterScaleMode();
  }
  // 常時有効の4隅マーカーを同期
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
  }
}

// ---- RAFスロットル付き _replaceImageSource（ドラッグ中の高速リアルタイム更新） ----
// leading-edge: 既に RAF がキューに入っていれば追加しない。
// これにより「マウス移動の最初のイベントで即時更新」が保証され、trailing-edge より遅延が少ない。
function _replaceImageSourceRaf() {
  if (importState.dragRafId) return; // 既にキュー済み
  importState.dragRafId = requestAnimationFrame(() => {
    importState.dragRafId = null;
    _replaceImageSource();
  });
}

/* =======================================================================
   ヒットボックス（透明ポリゴン）＆ アンテナ型回転ハンドル ヘルパー群
   ======================================================================= */

// ---- importState.coords から GeoJSON ポリゴンを生成 ----
function _importCoordsToPolygon() {
  if (!importState.coords) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[...importState.coords, importState.coords[0]]] }
  };
}

// ---- スケール UI を現在の importState.scaleVal に同期 ----
function _syncScaleUI() {
  const el    = document.getElementById('import-scale-adj');
  const valEl = document.getElementById('import-scale-adj-val');
  if (el)    el.value = Math.min(110, Math.max(90, importState.scaleVal));
  if (valEl) valEl.textContent = importState.scaleVal.toFixed(1) + '%';
  if (el) updateSliderGradient(el);
}

// ---- importState.baseScaleCoords × importState.scaleVal → importState.coords を再計算（Turf.js） ----
function _applyImportScale() {
  if (!importState.baseScaleCoords) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[...importState.baseScaleCoords, importState.baseScaleCoords[0]]]);
  const scaled = turf.transformScale(poly, importState.scaleVal / 100, { origin });
  importState.coords = scaled.geometry.coordinates[0].slice(0, 4);
}

// ---- importState.coords の逆スケールで importState.baseScaleCoords を再構築 ----
// （4隅ドラッグ後など、coords 側が先に確定したときに呼ぶ）
function _updateBaseScaleCoords() {
  if (!importState.coords || importState.scaleVal <= 0) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[...importState.coords, importState.coords[0]]]);
  const base   = turf.transformScale(poly, 100 / importState.scaleVal, { origin });
  importState.baseScaleCoords = base.geometry.coordinates[0].slice(0, 4);
}

// ---- 現在の importState.scaleVal を座標へ反映（画像/KMZ 両モード） ----
function _updateImportScale() {
  if (importState.baseCoords) {
    _applyKmzTransform();
  } else {
    _applyImportScale();
    _replaceImageSource();
  }
}

// ---- ヒットボックスポリゴンソースを最新座標で更新 ----
function _updateHitbox() {
  if (!importState.coords) return;
  const src = map.getSource('_import-hitbox');
  if (src) src.setData(_importCoordsToPolygon());
}


// ---- 画像モード専用：キャッシュした偏角で回転のみ再計算し現在スケールを適用 ----
function _updateImportRotation() {
  if (!importState.center || !importState.imgUrl) return;
  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  // 回転0°（磁北補正のみ）のベースから、指定の回転補正を適用
  const origin = _getImportTransformOrigin() ?? [importState.center.lng, importState.center.lat];
  const baseNoRot = _importCalcCorners(importState.center.lng, importState.center.lat, wM, hM, importState.cachedDecl);
  importState.baseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  // 現在のスケール倍率を適用して importState.coords を確定
  _applyImportScale();
  _replaceImageSource();
}


// ---- ヒットボックス + ドラッグ平行移動 を初期化（冪等） ----
function _initImgInteraction() {
  if (!importState.coords) return;

  // --- ヒットボックスのソース・レイヤー（なければ追加） ---
  if (!map.getSource('_import-hitbox')) {
    map.addSource('_import-hitbox', { type: 'geojson', data: _importCoordsToPolygon() });
    map.addLayer({
      id: '_import-hitbox-layer', type: 'fill', source: '_import-hitbox',
      // fill-opacity: 0 だとクリックを拾えない場合があるため極小値を使用
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 }
    });
    importState.interactionInited = true;
  }

  // --- イベントリスナーは一度だけ追加（_handlers に保存してクリーンアップ可能にする） ---
  if (!importState.eventsAdded) {
    importState.eventsAdded = true;

    // カーソル制御（レイヤーイベントはレイヤー削除時に自動無効化される）
    map.on('mouseenter', '_import-hitbox-layer', () => {
      if (!importState.isDragging) {
        map.getCanvas().style.cursor = (importState.isSettingFixedPoint || importState.isPlacingFixedPoint) ? 'crosshair' : 'move';
      }
    });
    map.on('mouseleave', '_import-hitbox-layer', () => {
      if (!importState.isDragging) map.getCanvas().style.cursor = '';
    });

    // mousedown → ドラッグ開始（hitboxレイヤー上）
    map.on('mousedown', '_import-hitbox-layer', (e) => {
      if (!importState.coords) return;
      // 固定点追加モード中は、クリック保持ですぐドラッグ位置合わせに入る
      if (importState.isSettingFixedPoint && importState.fixedPoints.length < 2) {
        e.preventDefault();
        _importSaveState();
        _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
        importState.isDragging = true;
        importState.dragStartLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        importState.dragStartCoords = importState.coords.map(c => [...c]);
        importState.dragStartCenter = importState.center ? { ...importState.center } : null;
        importState.dragStartBaseScaleCoords = importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null;
        importState.dragStartFixedPoints = importState.fixedPoints.map(pt => ({ ...pt }));
        importState.dragStartPendingFixedPoint = importState.pendingFixedPoint ? { ...importState.pendingFixedPoint } : null;
        map.dragPan.disable();
        map.getCanvas().style.cursor = 'crosshair';
        return;
      }
      if (((importState.fixedPoints.length > 0) || importState.isSettingFixedPoint) && !importState.isPlacingFixedPoint) return;
      e.preventDefault();
      _importSaveState();
      importState.isDragging = true;
      importState.dragStartLngLat          = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      importState.dragStartCoords          = importState.coords.map(c => [...c]);
      importState.dragStartCenter          = importState.center          ? { ...importState.center }          : null;
      importState.dragStartBaseScaleCoords = importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null;
      importState.dragStartFixedPoints = importState.fixedPoints.map(pt => ({ ...pt }));
      importState.dragStartPendingFixedPoint = importState.pendingFixedPoint ? { ...importState.pendingFixedPoint } : null;
      map.dragPan.disable();
      map.getCanvas().style.cursor = importState.isPlacingFixedPoint ? 'crosshair' : 'grabbing';
    });

    // mousemove → ドラッグ中に座標をリアルタイム更新
    const onMouseMove = (e) => {
      if (!importState.isDragging) return;
      const dx = e.lngLat.lng - importState.dragStartLngLat.lng;
      const dy = e.lngLat.lat - importState.dragStartLngLat.lat;
      importState.center = importState.dragStartCenter
        ? { lng: importState.dragStartCenter.lng + dx, lat: importState.dragStartCenter.lat + dy }
        : null;
      if (importState.baseCoords) {
        if (importState.isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
          _replaceImageSourceRaf();
        } else {
          if (importState.dragRafId) cancelAnimationFrame(importState.dragRafId);
          importState.dragRafId = requestAnimationFrame(() => {
            importState.dragRafId = null;
            _applyKmzTransform();
          });
        }
      } else {
        if (importState.isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
        } else {
          importState.coords = importState.dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
          if (importState.dragStartBaseScaleCoords)
            importState.baseScaleCoords = importState.dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
        }
        _replaceImageSourceRaf();
      }
    };

    // mouseup → ドラッグ終了
    const onMouseUp = () => {
      if (!importState.isDragging) return;
      importState.isDragging = false;
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      _updateHitbox();
      if (importState.center) {
        try { importState.cachedDecl = getDeclination(importState.center.lat, importState.center.lng) ?? 0; } catch (e) {}
      }
      if (importState.isPlacingFixedPoint && importState.pendingFixedPoint) {
        _commitPendingFixedPoint();
      }
    };

    // 固定点設定モード: 次のクリック位置を仮固定点にする
    const onMapClick = (e) => {
      if (!importState.isSettingFixedPoint) return;
      if (importState.fixedPoints.length >= 2) return;
      _importSaveState();
      _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
      _updateFixedPointStatus();
      _replaceImageSource();
    };

    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    map.on('click', onMapClick);

    // クリーンアップ用に保存
    importState._handlers = { mousemove: onMouseMove, mouseup: onMouseUp, click: onMapClick };
  }
}

// ---- Undo/Redo：現在の座標・中心・回転値を履歴に保存 ----
function _importSaveState() {
  if (!importState.coords) return;
  importState.history.push({
    coords : importState.coords.map(c => [...c]),
    center : importState.center ? { ...importState.center } : null,
    rotation: document.getElementById('import-rotation')?.value ?? '0',
    scaleVal: importState.scaleVal,
    baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
    fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
  });
  importState.future = []; // 新操作でredo履歴をクリア
}

// ---- Undo：一つ前の状態を復元 ----
function _importUndo() {
  if (importState.history.length === 0) return;
  // 現在の状態をredo用に保存
  if (importState.coords) {
    importState.future.push({
      coords : importState.coords.map(c => [...c]),
      center : importState.center ? { ...importState.center } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: importState.scaleVal,
      baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
      fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = importState.history.pop();
  _importRestoreState(state);
}

// ---- Redo：一つ先の状態に進む ----
function _importRedo() {
  if (importState.future.length === 0) return;
  if (importState.coords) {
    importState.history.push({
      coords : importState.coords.map(c => [...c]),
      center : importState.center ? { ...importState.center } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: importState.scaleVal,
      baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
      fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = importState.future.pop();
  _importRestoreState(state);
}

// ---- 状態を復元して再描画 ----
function _importRestoreState(state) {
  importState.coords = state.coords.map(c => [...c]);
  importState.center = state.center ? { ...state.center } : null;
  importState.scaleVal = Number.isFinite(state.scaleVal) ? state.scaleVal : 100;
  importState.baseScaleCoords = state.baseScaleCoords
    ? state.baseScaleCoords.map(c => [...c])
    : null;
  if (Array.isArray(state.fixedPoints)) {
    importState.fixedPoints = state.fixedPoints.map(pt => ({ ...pt })).slice(0, 2);
  } else if (state.fixedPoint) {
    importState.fixedPoints = [{ ...state.fixedPoint }];
  } else {
    importState.fixedPoints = [];
  }
  importState.pendingFixedPoint = null;
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
  if (!importState.baseScaleCoords) _updateBaseScaleCoords();
  _syncScaleUI();
  const rotEl = document.getElementById('import-rotation');
  if (rotEl) {
    rotEl.value = state.rotation;
    document.getElementById('import-rotation-val').textContent =
      parseFloat(state.rotation).toFixed(2);
  }
  // 常時有効の4隅マーカーも更新
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
  }
  // 旧・微調整モード（廃止）: if (_fineTuneActive && _importCornerMarkers.length === 4) { _importCornerMarkers.forEach(...) }
  _replaceImageSource();
}

// ---- プレビューマップ上のソース/マーカーを最新設定に更新（画像モード用） ----
function _updateImportPreview() {
  if (!importState.imgUrl) return;

  // 中心位置：マーカーがなければメインマップ中心で初期化
  if (!importState.center) {
    const mc = map.getCenter();
    importState.center = { lng: mc.lng, lat: mc.lat };
  }
  const c = importState.center;

  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  let decl = 0;
  try { decl = getDeclination(c.lat, c.lng) ?? 0; } catch (e) {}
  importState.cachedDecl = decl;
  importState.scaleVal        = 100;
  const origin = _getImportTransformOrigin() ?? [c.lng, c.lat];
  const baseNoRot = _importCalcCorners(c.lng, c.lat, wM, hM, decl);
  importState.baseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  importState.coords = importState.baseScaleCoords.map(p => [...p]);
  _syncScaleUI();

  // 初回のみ: メインマップを画像位置にフィット
  if (!map.getSource('_import-img')) {
    const lngs = importState.coords.map(p => p[0]), lats = importState.coords.map(p => p[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: FIT_BOUNDS_PAD, duration: 400 }
    );
  }

  // 画像ソース更新 → _initImgInteraction も内部で呼ばれる
  _replaceImageSource();
}

/* =========================================================================
   地図画像 位置合わせ — 右パネル UI
   ========================================================================= */

/**
 * 位置合わせエディター用の右パネルを構築してイベントリスナーを接続する。
 * @param {boolean} showStep1 - true=画像モード（用紙サイズUI表示）, false=KMZモード
 * @returns {HTMLElement} 右パネルに渡すコンテナ要素
 */
function _buildAlignEditorPanel(showStep1 = true) {
  const wrap = document.createElement('div');
  wrap.id = 'align-editor-panel';
  wrap.className = 'import-controls-wrap';

  wrap.innerHTML = `
    <!-- Undo/Redo -->
    <div id="import-undo-redo-group" class="align-undo-redo">
      <button class="import-undo-redo-btn" id="import-undo-btn" title="元に戻す (Ctrl+Z)">↩</button>
      <button class="import-undo-redo-btn" id="import-redo-btn" title="やり直し (Ctrl+Y)">↪</button>
    </div>

    <!-- 既存の枠に合わせる（ショートカット）-->
    <div class="import-ctrl-section" id="import-snap-section" style="display:none">
      <div class="import-ctrl-section-title">既存の枠に合わせる（ショートカット）</div>
      <div class="import-ctrl-hint">すでに配置済みの地図枠を選ぶと、手動位置合わせをスキップできます。</div>
      <div id="import-snap-list" class="import-snap-list"></div>
    </div>

    <!-- ステップ1：サイズを指定（画像モードのみ） -->
    <div class="import-ctrl-section" id="import-step1-section" style="${showStep1 ? '' : 'display:none'}">
      <div class="import-ctrl-section-title">Step 1 ― サイズを指定</div>
      <div id="import-image-only-ctrl">
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">用紙サイズ</div>
          <select id="import-paper-size" class="import-ctrl-select">
            <option value="A4">A4（210×297 mm）</option>
            <option value="A3">A3（297×420 mm）</option>
            <option value="B4">B4-JIS（257×364 mm）</option>
            <option value="B3">B3-JIS（364×515 mm）</option>
          </select>
        </div>
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">向き</div>
          <select id="import-orientation" class="import-ctrl-select">
            <option value="portrait">縦（Portrait）</option>
            <option value="landscape">横（Landscape）</option>
          </select>
        </div>
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">縮尺</div>
          <select id="import-scale" class="import-ctrl-select">
            <option value="3000">1:3,000</option>
            <option value="4000">1:4,000</option>
            <option value="5000" selected>1:5,000</option>
            <option value="7500">1:7,500</option>
            <option value="10000">1:10,000</option>
            <option value="15000">1:15,000</option>
            <option value="custom">手入力...</option>
          </select>
          <input type="number" id="import-scale-custom" class="import-ctrl-input"
            placeholder="例: 10000" min="500" max="200000" style="display:none;margin-top:4px;" />
        </div>
      </div>
    </div>

    <!-- ステップ2：位置と角度を合わせる -->
    <div class="import-ctrl-section">
      <div class="import-ctrl-section-title">Step ${showStep1 ? '2' : '1'} ― 位置と角度を合わせる</div>
      <div class="import-ctrl-hint">※画像を直接ドラッグして移動できます。</div>
      <div class="import-ctrl-hint">※4隅の青マーカーをドラッグして拡大縮小できます。</div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label import-label-with-reset">
          <span>回転補正&emsp;<span id="import-rotation-val">0.00</span>°</span>
          <button id="import-rotation-reset" class="import-reset-btn" type="button" title="回転補正を初期値に戻す">↺</button>
        </div>
        <div class="import-slider-line">
          <span class="import-slider-side left">-2.0</span>
          <div class="import-slider-wrap" style="--init-pct:50%">
            <input type="range" id="import-rotation" class="ui-slider import-ctrl-slider"
              min="-2" max="2" value="0" step="0.05" />
          </div>
          <span class="import-slider-side right">2.0</span>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-rotation-minus">−0.05°</button>
          <button class="import-rotation-adj-btn" id="import-rotation-plus">+0.05°</button>
        </div>
      </div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label import-label-with-reset">
          <span>スケール補正&emsp;<span id="import-scale-adj-val">100.0%</span></span>
          <button id="import-scale-adj-reset" class="import-reset-btn" type="button" title="スケール補正を初期値に戻す">↺</button>
        </div>
        <div class="import-slider-line">
          <span class="import-slider-side left">90</span>
          <div class="import-slider-wrap" style="--init-pct:50%">
            <input type="range" id="import-scale-adj" class="ui-slider import-ctrl-slider"
              min="90" max="110" value="100" step="0.1" />
          </div>
          <span class="import-slider-side right">110</span>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-scale-adj-minus">−0.1%</button>
          <button class="import-rotation-adj-btn" id="import-scale-adj-plus">+0.1%</button>
        </div>
      </div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label">固定点（最大2点）&emsp;<span id="import-fixed-point-count">0 / 2</span></div>
        <div class="import-ctrl-hint">手順: 1) 点を選ぶ → 2) 画像をドラッグで合わせる → 3) 固定点を確定</div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-fixed-point-set" type="button">① 点を選ぶ</button>
          <button class="import-rotation-adj-btn" id="import-fixed-point-commit" type="button">固定点を確定</button>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-fixed-point-clear" type="button">全解除</button>
        </div>
        <div class="import-ctrl-hint" id="import-fixed-point-status">待機中</div>
      </div>
    </div>

    <!-- 表示設定 -->
    <div class="import-ctrl-section">
      <div class="import-ctrl-section-title">表示設定</div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label">画像の透明度&emsp;<span id="import-opacity-val">70</span>%</div>
        <input type="range" id="import-opacity" class="ui-slider import-ctrl-slider"
          min="0" max="100" value="70" step="1" />
      </div>
    </div>

    <!-- フッターボタン -->
    <div class="align-editor-footer">
      <button id="import-cancel-btn" class="align-cancel-btn">キャンセル</button>
      <button id="import-decide-btn" class="align-decide-btn">この位置で決定</button>
    </div>
  `;

  // --- スライダーグラデーション初期化 ---
  const rotEl   = wrap.querySelector('#import-rotation');
  const scaleEl = wrap.querySelector('#import-scale-adj');
  const opEl    = wrap.querySelector('#import-opacity');
  if (rotEl)   updateSliderGradient(rotEl,   '#2563eb');
  if (scaleEl) updateSliderGradient(scaleEl, '#2563eb');
  if (opEl)    updateSliderGradient(opEl,    '#2563eb');

  // --- イベントリスナー ---

  // キャンセル
  wrap.querySelector('#import-cancel-btn').addEventListener('click', () => closeAlignEditor());

  // 縮尺「手入力」切り替え
  wrap.querySelector('#import-scale')?.addEventListener('change', (e) => {
    wrap.querySelector('#import-scale-custom').style.display = e.target.value === 'custom' ? 'block' : 'none';
    _importSaveState();
    _updateImportPreview();
  });

  // 設定変更 → プレビュー再計算（画像モード）
  ['import-paper-size', 'import-orientation'].forEach(id => {
    wrap.querySelector(`#${id}`)?.addEventListener('change', () => { _importSaveState(); _updateImportPreview(); });
  });
  wrap.querySelector('#import-scale-custom')?.addEventListener('input', _updateImportPreview);

  // 回転スライダー
  rotEl?.addEventListener('input', (e) => {
    wrap.querySelector('#import-rotation-val').textContent = parseFloat(e.target.value).toFixed(2);
    updateSliderGradient(e.target, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  });

  // 回転微調整ボタン
  const _applyRotationAdj = (delta) => {
    if (!rotEl) return;
    _importSaveState();
    const newVal = Math.min(2, Math.max(-2, parseFloat(rotEl.value) + delta));
    rotEl.value = newVal;
    wrap.querySelector('#import-rotation-val').textContent = newVal.toFixed(2);
    updateSliderGradient(rotEl, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  };
  wrap.querySelector('#import-rotation-minus').addEventListener('click', () => _applyRotationAdj(-0.05));
  wrap.querySelector('#import-rotation-plus') .addEventListener('click', () => _applyRotationAdj( 0.05));
  wrap.querySelector('#import-rotation-reset').addEventListener('click', () => {
    if (!rotEl) return;
    _importSaveState();
    rotEl.value = '0';
    wrap.querySelector('#import-rotation-val').textContent = '0.00';
    updateSliderGradient(rotEl, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  });

  // スケール補正スライダー
  scaleEl?.addEventListener('input', (e) => {
    importState.scaleVal = parseFloat(e.target.value);
    _syncScaleUI();
    _updateImportScale();
  });
  const _applyScaleAdj = (delta) => {
    if (!scaleEl) return;
    _importSaveState();
    const newVal = Math.min(110, Math.max(90, parseFloat(scaleEl.value) + delta));
    importState.scaleVal = newVal;
    _syncScaleUI();
    _updateImportScale();
  };
  wrap.querySelector('#import-scale-adj-minus').addEventListener('click', () => _applyScaleAdj(-0.1));
  wrap.querySelector('#import-scale-adj-plus') .addEventListener('click', () => _applyScaleAdj( 0.1));
  wrap.querySelector('#import-scale-adj-reset').addEventListener('click', () => {
    _importSaveState();
    importState.scaleVal = 100;
    _syncScaleUI();
    _updateImportScale();
  });

  // 固定点
  wrap.querySelector('#import-fixed-point-set').addEventListener('click', () => {
    if (!importState.coords) return;
    if (importState.fixedPoints.length >= 2) return;
    _setFixedPointSettingMode(true);
    importState.pendingFixedPoint = null;
    _renderFixedPointMarkers();
  });
  wrap.querySelector('#import-fixed-point-commit').addEventListener('click', () => {
    if (!importState.pendingFixedPoint) return;
    _importSaveState();
    _commitPendingFixedPoint();
    _updateBaseScaleCoords();
    _replaceImageSource();
  });
  wrap.querySelector('#import-fixed-point-clear').addEventListener('click', () => {
    if (importState.fixedPoints.length === 0 && !importState.pendingFixedPoint) return;
    _importSaveState();
    _clearImportFixedPoints();
    _updateBaseScaleCoords();
    _replaceImageSource();
  });

  // 透明度スライダー
  opEl?.addEventListener('input', (e) => {
    const opacity = parseInt(e.target.value, 10) / 100;
    wrap.querySelector('#import-opacity-val').textContent = e.target.value;
    updateSliderGradient(e.target, '#2563eb');
    if (map.getLayer('_import-layer')) {
      map.setPaintProperty('_import-layer', 'raster-opacity', opacity);
    }
  });

  // Undo/Redo ボタン
  wrap.querySelector('#import-undo-btn').addEventListener('click', _importUndo);
  wrap.querySelector('#import-redo-btn').addEventListener('click', _importRedo);

  // range 操作の開始時に一度だけ状態保存（_bindRangePreSave の動的版）
  [rotEl, scaleEl].forEach(el => {
    if (!el) return;
    let armed = false;
    const arm = () => { if (armed) return; _importSaveState(); armed = true; };
    el.addEventListener('pointerdown', arm);
    el.addEventListener('keydown', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') arm();
    });
    el.addEventListener('change', () => { armed = false; });
  });

  // 決定ボタン
  wrap.querySelector('#import-decide-btn').addEventListener('click', async () => {
    if (!importState.coords || !importState.imgUrl) return;

    const name       = importState.imgFile?.name ?? importState.imgLabel ?? '手動配置地図';
    const coords     = importState.coords.map(c => [...c]);
    const blob       = importState.imgBlob ?? null;
    const keepUrl    = importState.imgUrl;
    const terrainId  = importState.snapTerrainId ?? null;
    let   mapSheetId = importState.activeMapSheetId ?? null;

    // closeAlignEditor での revoke を防ぐため先に null にする
    importState.imgUrl           = null;
    importState.imgBlob          = null;
    importState.activeMapSheetId = null;

    // コース枠の決定
    if (!mapSheetId) {
      const activeEventId = getActiveEventId();
      if (activeEventId) {
        const isKmzMode  = (importState.imgFile === null);
        const paperSize  = isKmzMode ? null : (document.getElementById('import-paper-size')?.value || 'A4');
        const scaleSelEl = document.getElementById('import-scale');
        const scaleCustomEl = document.getElementById('import-scale-custom');
        let scale = null;
        if (!isKmzMode && scaleSelEl) {
          const sv = scaleSelEl.value;
          scale = sv === 'custom' ? (parseInt(scaleCustomEl?.value) || null) : parseInt(sv);
        }
        const sheetName = name.replace(/\.(jpe?g|png|kmz)$/i, '') || '地図枠';
        try {
          const newSheet = {
            id:          'ms-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
            event_id:    activeEventId,
            name:        sheetName,
            coordinates: coords,
            paper_size:  paperSize,
            scale,
          };
          await saveWsMapSheet(newSheet);
          mapSheetId = newSheet.id;
        } catch (e) {
          console.warn('import-decide: コース枠の作成に失敗:', e);
        }
      }
    }

    // メインマップにレイヤー追加・localMapLayers 登録
    const entry = _addLocalMapLayerFromBlob(
      blob ? blob : await (await fetch(keepUrl)).blob(),
      coords, name,
      {
        terrainId,
        terrainName: terrainId ? (localMapLayers.find(e => e.terrainId === terrainId)?.terrainName ?? null) : null,
        mapSheetId,
      }
    );

    // IndexedDB 永続化
    if (blob || keepUrl) {
      const saveBlob = blob ?? await (async () => {
        try { return await (await fetch(keepUrl)).blob(); } catch { return null; }
      })();
      if (saveBlob) {
        saveMapLayer({
          type:        'image-import',
          name,
          imageBlob:   saveBlob,
          coordinates: coords,
          opacity:     entry.opacity,
          visible:     true,
          terrainId,
          terrainName: entry.terrainName,
          mapSheetId,
        })
          .then(dbId => { entry.dbId = dbId; renderOtherMapsTree(); renderExplorer(); })
          .catch(e => console.warn('import-decide: DB 保存に失敗:', e));
      }
    }

    // 地図範囲をフィット
    const b = entry.bbox;
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
    map.fitBounds(
      [[b.west, b.south], [b.east, b.north]],
      { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                   left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
        pitch: INITIAL_PITCH, duration: EASE_DURATION, maxZoom: 19 }
    );

    renderLocalMapList();
    closeAlignEditor(false);
  });

  return wrap;
}

/** メインマップの位置合わせ用ソース/レイヤーを削除する */
function _cleanupAlignMapLayers() {
  if (map.getLayer('_import-hitbox-layer')) map.removeLayer('_import-hitbox-layer');
  if (map.getSource('_import-hitbox'))      map.removeSource('_import-hitbox');
  if (map.getLayer('_import-layer'))        map.removeLayer('_import-layer');
  if (map.getSource('_import-img'))         map.removeSource('_import-img');
}

/**
 * 位置合わせエディターを開く（右パネルを使用、プレビューマップなし）
 * @param {string} imgUrl ObjectURL
 * @param {Function} onReady マップ準備完了後のコールバック
 * @param {boolean} showStep1 true=画像モード, false=KMZモード
 */
function openAlignEditor(imgUrl, onReady, showStep1 = true) {
  // 既存の位置合わせ用レイヤーをクリーンアップ
  _cleanupAlignMapLayers();

  // 既存マーカーをクリーンアップ
  exitScaleMode();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (importState.fixedPointOverlay?.isConnected) importState.fixedPointOverlay.remove();
  importState.fixedPointOverlay = null;
  importState.fixedPointOverlayEventsAdded = false;

  // 既存ハンドラをクリーンアップ（前回のエディターセッションの残留防止）
  if (importState._handlers) {
    const h = importState._handlers;
    map.off('mousemove', h.mousemove);
    map.off('mouseup',   h.mouseup);
    map.off('click',     h.click);
    importState._handlers = null;
  }

  // 状態リセット
  importState.imgUrl           = imgUrl;
  importState.coords           = null;
  importState.center           = null;
  importState.baseCoords       = null;
  importState.history          = [];
  importState.future           = [];
  importState.cachedDecl       = 0;
  importState.scaleVal         = 100;
  importState.baseScaleCoords  = null;
  _clearImportFixedPoints();
  importState.isDragging       = false;
  importState.interactionInited = false;
  importState.eventsAdded      = false;

  // 右パネルにコントロールを構築
  const panel = _buildAlignEditorPanel(showStep1);
  openRightPanel('地図画像の位置合わせ', panel);

  // スライダー UI を初期値に同期
  _syncScaleUI();
  _updateFixedPointStatus();

  // マップがロード済みであればすぐにコールバックを実行
  if (map.loaded()) {
    onReady();
  } else {
    map.once('load', onReady);
  }
}

// ---- 画像縦横比から最適な用紙サイズ・向きを自動推定してUIに反映 ----
// ---- 画像ファイルから開く（用紙サイズ設定UI表示・A4デフォルト） ----
/**
 * 位置合わせモーダルの「既存の枠に合わせる」リストを更新する。
 * コース枠（MapSheet）と配置済み地図を一覧し、選択すると座標をスナップする。
 * - アクティブイベントがある場合はそのコース枠を優先表示
 * - フォールバック: mapSheetId 未割り当ての localMapLayers も表示
 * @param {string|null} filterTerrainId — null のときは全件表示
 */
async function _populateImportSnapList(filterTerrainId = null) {
  const section = document.getElementById('import-snap-section');
  const listEl  = document.getElementById('import-snap-list');
  if (!section || !listEl) return;

  // アクティブイベントのコース枠を取得
  let mapSheets = [];
  const activeEventId = getActiveEventId();
  if (activeEventId) {
    try { mapSheets = await getMapSheetsByEvent(activeEventId); } catch { /* ignore */ }
  }

  // コース枠未割り当ての既存配置済み地図（後方互換スナップ候補）
  const legacyCandidates = localMapLayers.filter(e =>
    e.coordinates && e.coordinates.length === 4 &&
    !e.mapSheetId &&
    (filterTerrainId == null || e.terrainId === filterTerrainId)
  );

  if (mapSheets.length === 0 && legacyCandidates.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  listEl.innerHTML = '';

  /** 座標スナップ共通処理 */
  function _applySnapCoords(coords) {
    if (!coords) return;
    importState.coords          = coords.map(c => [...c]);
    importState.baseCoords      = coords.map(c => [...c]);
    importState.baseScaleCoords = coords.map(c => [...c]);
    importState.scaleVal        = 100;
    importState.history         = [];
    importState.future          = [];
    const rotEl = document.getElementById('import-rotation');
    if (rotEl) { rotEl.value = '0'; document.getElementById('import-rotation-val').textContent = '0.00'; }
    _syncScaleUI();
    if (importState.scaleCornerMarkers.length === 4) {
      importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(coords[i]));
    }
    const lngs = coords.map(c => c[0]);
    const lats  = coords.map(c => c[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 40, duration: 400 }
    );
    _replaceImageSource();
    listEl.querySelectorAll('.import-snap-btn').forEach(b => b.classList.remove('active'));
  }

  // ① コース枠（MapSheet）ボタン
  mapSheets.forEach(sheet => {
    const btn = document.createElement('button');
    btn.className = 'import-snap-btn';
    const scaleStr = sheet.scale ? ` 1:${sheet.scale.toLocaleString()}` : '';
    const sizeStr  = sheet.paper_size ? ` ${sheet.paper_size}` : '';
    btn.textContent = `${sheet.name}${sizeStr}${scaleStr}`;
    btn.title = `コース枠「${sheet.name}」に合わせる（確定時はこの枠に画像を追加）`;
    btn.addEventListener('click', () => {
      if (!sheet.coordinates) return;
      _applySnapCoords(sheet.coordinates);
      importState.snapTerrainId    = null;
      importState.activeMapSheetId = sheet.id;   // ← 既存コース枠に追加
      btn.classList.add('active');
    });
    listEl.appendChild(btn);
  });

  // ② 後方互換: コース枠未割り当ての配置済み地図
  legacyCandidates.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'import-snap-btn import-snap-btn-legacy';
    const shortName = e.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');
    btn.textContent = shortName;
    btn.title = `配置済み地図「${shortName}」の枠に合わせる（新規コース枠を作成）`;
    btn.addEventListener('click', () => {
      if (!e.coordinates) return;
      _applySnapCoords(e.coordinates);
      importState.snapTerrainId    = e.terrainId ?? null;
      importState.activeMapSheetId = null;   // ← 新規コース枠を作成
      btn.classList.add('active');
    });
    listEl.appendChild(btn);
  });
}

function openImportModal(imageFile) {
  importState.imgFile          = imageFile;
  importState.imgBlob          = imageFile;  // File は Blob のサブクラス。IndexedDB 保存用に保持
  importState.imgAspect        = null;
  importState.imgLabel         = imageFile.name;
  importState.snapTerrainId    = null;
  importState.activeMapSheetId = null;

  const imgUrl = URL.createObjectURL(imageFile);
  const tmp    = new Image();
  tmp.onload = () => {
    importState.imgAspect = (tmp.width > 0 && tmp.height > 0) ? (tmp.width / tmp.height) : null;
    const isLandscape = tmp.width >= tmp.height;
    openAlignEditor(imgUrl, async () => {
      // 用紙サイズ・向きをパネル構築後に設定
      const pSize = document.getElementById('import-paper-size');
      const pOri  = document.getElementById('import-orientation');
      if (pSize) pSize.value = 'A4';
      if (pOri)  pOri.value  = isLandscape ? 'landscape' : 'portrait';
      _updateImportPreview();
      await _populateImportSnapList();
    }, true);
  };
  tmp.onerror = () => {
    importState.imgAspect = null;
    openAlignEditor(imgUrl, async () => {
      const pOri = document.getElementById('import-orientation');
      if (pOri) pOri.value = 'portrait';
      _updateImportPreview();
      await _populateImportSnapList();
    }, true);
  };
  tmp.src = imgUrl;
}

// ---- KMZ: 現在の importState.center + 回転スライダーで座標を再計算 ----
function _applyKmzTransform() {
  if (!importState.baseCoords || !importState.center) return;
  const { lng: cLng, lat: cLat } = importState.center;
  const rotDeg = parseFloat(document.getElementById('import-rotation')?.value ?? '0');

  // importState.baseCoords の重心（基準中心）を算出
  const baseLngs = importState.baseCoords.map(c => c[0]);
  const baseLats = importState.baseCoords.map(c => c[1]);
  const baseCLng = (Math.min(...baseLngs) + Math.max(...baseLngs)) / 2;
  const baseCLat = (Math.min(...baseLats) + Math.max(...baseLats)) / 2;
  const baseCtr  = turf.point([baseCLng, baseCLat]);
  const newCtr   = turf.point([cLng, cLat]);

  // 各隅を基準中心からの距離・方位で算出し、まず平行移動して新中心に配置
  const rawCoords = importState.baseCoords.map(([lng, lat]) => {
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
  importState.baseScaleCoords = rotatedRaw;
  _applyImportScale();
  _syncScaleUI();
  _replaceImageSource();
}

// ---- KMZ座標付きで開く（回転のみ表示、用紙サイズUI非表示） ----
function openImportModalWithCoords(imgUrl, coords, label) {
  importState.imgFile          = null;
  importState.imgAspect        = null;
  importState.imgLabel         = label ?? '手動配置地図';
  importState.snapTerrainId    = null;
  importState.activeMapSheetId = null;

  const lats = coords.map(c => c[1]), lngs = coords.map(c => c[0]);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

  // showStep1=false でKMZモード（用紙サイズUI非表示）
  openAlignEditor(imgUrl, () => {
    // openAlignEditor によるリセット後に KMZ 座標を設定
    importState.baseCoords      = coords.map(c => [...c]);
    importState.coords          = coords.map(c => [...c]);
    importState.scaleVal        = 100;
    importState.baseScaleCoords = coords.map(c => [...c]);
    _syncScaleUI();
    importState.center = { lng: centerLng, lat: centerLat };

    // KMZ画像全体が収まるようフィット（短いアニメーション）
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: FIT_BOUNDS_PAD, duration: 400 }
    );

    // 画像ソース + hitbox を一括初期化
    _replaceImageSource();

    // 既存のコース枠スナップリストを表示
    _populateImportSnapList();
  }, false);
}

/* ---- 微調整モード（廃止：拡大縮小モードに統合）----
function enterFineTuneMode() {
  if (!importState.previewMap || !importState.coords) return;
  _fineTuneActive = true;
  if (importState.previewMap.getLayer('_import-hitbox-layer'))
    importState.previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'none');
  importState.previewMap.getCanvas().style.cursor = '';
  _importCornerMarkers = importState.coords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#ff9900;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i];
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord).addTo(importState.previewMap);
    marker.on('dragstart', () => { _importSaveState(); });
    marker.on('drag', () => { const ll = marker.getLngLat(); importState.coords[i] = [ll.lng, ll.lat]; _replaceImageSourceRaf(); });
    return marker;
  });
}
function exitFineTuneMode() {
  _fineTuneActive = false;
  _importCornerMarkers.forEach(m => m.remove()); _importCornerMarkers = [];
  if (importState.previewMap && importState.previewMap.getLayer('_import-hitbox-layer'))
    importState.previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'visible');
}
*/

// ---- 4隅マーカーを常時表示（固定点があれば固定点中心、なければ対角固定で相似拡大縮小） ----
function enterScaleMode() {
  if (!importState.coords) return;
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
    return;
  }

  // 4隅にドラッグ可能なマーカーを配置
  importState.scaleCornerMarkers = importState.coords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#2288ff;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i] + '（ドラッグで拡大縮小）';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord)
      .addTo(map);

    // dragstart/drag 用クロージャ変数
    let fixedCoord    = null; // 固定する座標（固定点 or 対角コーナー）
    let startCoords   = null; // ドラッグ開始時の全隅座標
    let startDist     = 0;    // ドラッグ開始時のドラッグ隅→固定隅の距離
    let savedScaleVal = 100;  // ドラッグ開始時のスケール倍率

    marker.on('dragstart', () => {
      _importSaveState();
      if (importState.fixedPoints.length > 0) {
        fixedCoord = _getImportTransformOrigin();
      } else {
        const oppIdx = (i + 2) % 4;                 // 対角コーナーのインデックス
        fixedCoord   = [...importState.coords[oppIdx]];  // 固定点（対角）
      }
      startCoords    = importState.coords.map(c => [...c]);
      savedScaleVal  = importState.scaleVal;
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
      importState.coords = startCoords.map(([lng, lat]) => {
        const dx = (lng - fixedCoord[0]) * cosLat;
        const dy =  lat - fixedCoord[1];
        return [fixedCoord[0] + dx * scale / cosLat, fixedCoord[1] + dy * scale];
      });
      // 中心を4隅重心で再計算
      importState.center = {
        lng: importState.coords.reduce((s, c) => s + c[0], 0) / 4,
        lat: importState.coords.reduce((s, c) => s + c[1], 0) / 4,
      };
      // スケール倍率を更新しUIと逆変換ベース座標を同期
      importState.scaleVal = savedScaleVal * scale;
      _syncScaleUI();
      _updateBaseScaleCoords();
      // 全マーカーを最新座標に移動
      importState.scaleCornerMarkers.forEach((m, j) => m.setLngLat(importState.coords[j]));
      _replaceImageSourceRaf();
    });

    return marker;
  });
}

// ---- 4隅マーカー解除 ----
function exitScaleMode() {
  importState.scaleCornerMarkers.forEach(m => m.remove());
  importState.scaleCornerMarkers = [];
}

// ---- 位置合わせエディターを閉じる（revokeUrl=false のとき ObjectURL を解放しない） ----
function closeAlignEditor(revokeUrl = true) {
  // マーカークリーンアップ
  exitScaleMode();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (importState.fixedPointOverlay?.isConnected) importState.fixedPointOverlay.remove();
  importState.fixedPointOverlay = null;
  importState.fixedPointOverlayEventsAdded = false;
  _clearImportFixedPoints();

  // 状態フラグリセット
  importState.isDragging         = false;
  importState.interactionInited  = false;
  importState.eventsAdded        = false;
  if (importState.isDragging) map.dragPan.enable();

  // メインマップからレイヤー/ソースを削除
  _cleanupAlignMapLayers();

  // イベントハンドラのクリーンアップ
  if (importState._handlers) {
    const h = importState._handlers;
    map.off('mousemove', h.mousemove);
    map.off('mouseup',   h.mouseup);
    map.off('click',     h.click);
    importState._handlers = null;
  }

  if (revokeUrl && importState.imgUrl) { URL.revokeObjectURL(importState.imgUrl); }
  importState.imgUrl  = null;
  importState.imgFile = null;
  importState.coords  = null;

  // 右パネルを閉じる
  closeRightPanel();
}

// 後方互換エイリアス（旧コードが参照している場合に備えて）
const closeImportModal = closeAlignEditor;

// Undo/Redo キーボードショートカット（エディターが開いているときのみ有効）
document.addEventListener('keydown', (e) => {
  if (!importState.coords) return; // エディター未開
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) { _importRedo(); } else { _importUndo(); }
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    _importRedo();
  }
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
// 左パネル + 地図フレームオーバーレイで PNG / JPEG / PDF を出力する。
// ============================================================
(function initPrintDialog() {
  // 用紙サイズ定義（縦向き基準: [width_mm, height_mm]）
  const PAPER_SIZES_MM = {
    A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210],
    B2: [515, 728], B3: [364, 515], B4: [257, 364], B5: [182, 257],
  };

  const exportBtn        = document.getElementById('print-export-btn');
  const selPaper         = document.getElementById('print-paper-size');
  const selOrientation   = document.getElementById('print-orientation');
  const selScaleSelect   = document.getElementById('print-scale-select');
  const scaleCustomRow   = document.getElementById('print-scale-custom-row');
  const scaleCustomInput = document.getElementById('print-scale');
  const selFormat        = document.getElementById('print-format');
  const selDpi           = document.getElementById('print-dpi');
  const selZoom          = document.getElementById('print-zoom');
  const infoEl           = document.getElementById('print-info');
  const frameOverlay     = document.getElementById('print-frame-overlay');
  const frameSvg         = document.getElementById('print-frame-svg');
  const simStartBlock    = document.getElementById('sim-start-block');

  // 現在の縮尺分母を返す
  function getScale() {
    if (selScaleSelect.value === 'custom') {
      return Math.max(500, parseInt(scaleCustomInput.value, 10) || 10000);
    }
    return parseInt(selScaleSelect.value, 10);
  }

  // 手入力行の表示切替
  selScaleSelect.addEventListener('change', () => {
    scaleCustomRow.style.display = selScaleSelect.value === 'custom' ? '' : 'none';
    if (selScaleSelect.value === 'custom') scaleCustomInput.focus();
  });
  const printModeState = {
    active: false,
    prevTerrainEnabled: false,
    prevBuildingEnabled: false,
    prevProjectionType: null,
    prevRenderWorldCopies: null,
    prevMinZoom: null,
    dragPitchWasEnabled: null,
    touchPitchWasEnabled: null,
    dragRotateWasEnabled: null,
    scrollZoomWasEnabled: null,
    doubleClickZoomWasEnabled: null,
    touchZoomRotateWasEnabled: null,
    usedDragRotateFallback: false,
    wheelHandler: null,
    dblClickHandler: null,
    rotateMouseDownHandler: null,
    rotateMouseMoveHandler: null,
    rotateMouseUpHandler: null,
    rotateContextMenuHandler: null,
    isRotating: false,
    rotateStartBearing: 0,
    rotateStartAngle: 0,
    suppressContextMenuOnce: false,
    frameAnchorPx: null,
    frameRefreshRaf: 0,
    frameInsetLeft: 0,
  };

  if (!exportBtn || !frameOverlay) return;

  // 向きを考慮した用紙寸法 [width_mm, height_mm] を返す
  function getPaperDim() {
    const [pw, ph] = PAPER_SIZES_MM[selPaper.value] || [210, 297];
    return selOrientation.value === 'landscape'
      ? [Math.max(pw, ph), Math.min(pw, ph)]
      : [Math.min(pw, ph), Math.max(pw, ph)];
  }

  // 指定 DPI・縮尺・緯度に対応したエクスポートズームを計算
  // MapLibre GL JS は 512px タイル基準: 78271.51696 × cos(lat) / 2^z = 0.0254 × scale / dpi
  function calcExportZoom(dpi, scale, lat) {
    return Math.log2(78271.51696 * Math.cos(lat * Math.PI / 180) * dpi / (0.0254 * scale));
  }

  function getPrintFrameInsetLeft() {
    if (window.matchMedia('(max-width: 768px)').matches) return 0;
    const sidebar = document.getElementById('sidebar');
    return sidebar ? sidebar.offsetWidth : 0;
  }

  function getPrintFrameLayout() {
    printModeState.frameInsetLeft = getPrintFrameInsetLeft();
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = getScale();
    const zoom  = map.getZoom();
    const lat   = map.getCenter().lat;
    // MapLibre GL JS は 512px タイル基準（係数 78271.51696 = 40075016.686 / 512）
    const metersPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, zoom));
    const fW = (pw_mm / 1000 * scale) / metersPerPx;
    const fH = (ph_mm / 1000 * scale) / metersPerPx;
    const ovW = Math.max(0, frameOverlay.offsetWidth - printModeState.frameInsetLeft);
    const ovH = frameOverlay.offsetHeight;
    // 地図有効領域の中心を基準に枠を配置（クランプしない — 枠は画面外に出てよい）
    const centerX = printModeState.frameInsetLeft + ovW / 2;
    const centerY = ovH / 2;
    const x  = Math.round(centerX - fW / 2);
    const y  = Math.round(centerY - fH / 2);
    const bW = Math.round(fW);
    const bH = Math.round(fH);
    return {
      x, y, bW, bH, ovW, ovH,
      anchorPx: [centerX, centerY],
    };
  }

  // 地図上の印刷範囲フレームを SVG で描画（開発用切り取りツールと同方式）
  function updatePrintFrame() {
    if (!frameOverlay.classList.contains('visible')) return;
    const { x, y, bW, bH, anchorPx } = getPrintFrameLayout();
    const [anchorX, anchorY] = anchorPx;
    const crossSize = 10;
    printModeState.frameAnchorPx = anchorPx;
    // SVG hole-mask: 全面 rect に穴を開けて均一なマスクを実現
    frameSvg.innerHTML = `
      <defs>
        <mask id="pf-hole">
          <rect width="100%" height="100%" fill="white"/>
          <rect x="${x}" y="${y}" width="${bW}" height="${bH}" fill="black"/>
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(0,0,0,0.38)" mask="url(#pf-hole)"/>
      <rect x="${x}" y="${y}" width="${bW}" height="${bH}"
            fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="4"/>
      <rect x="${x}" y="${y}" width="${bW}" height="${bH}"
            fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2"/>
      <line x1="${anchorX - crossSize}" y1="${anchorY}" x2="${anchorX + crossSize}" y2="${anchorY}"
            stroke="rgba(0,0,0,0.45)" stroke-width="4" stroke-linecap="round"/>
      <line x1="${anchorX - crossSize}" y1="${anchorY}" x2="${anchorX + crossSize}" y2="${anchorY}"
            stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>
      <line x1="${anchorX}" y1="${anchorY - crossSize}" x2="${anchorX}" y2="${anchorY + crossSize}"
            stroke="rgba(0,0,0,0.45)" stroke-width="4" stroke-linecap="round"/>
      <line x1="${anchorX}" y1="${anchorY - crossSize}" x2="${anchorX}" y2="${anchorY + crossSize}"
            stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="${anchorX}" cy="${anchorY}" r="3.5" fill="rgba(0,0,0,0.45)"/>
      <circle cx="${anchorX}" cy="${anchorY}" r="2.5" fill="rgba(255,255,255,0.98)"/>`;
  }

  // 出力サイズ情報を更新
  function getExportZoom(lat) {
    if (selZoom.value !== 'auto') return parseFloat(selZoom.value);
    return calcExportZoom(parseInt(selDpi.value, 10), getScale(), lat);
  }

  function updateInfo() {
    const [pw_mm, ph_mm] = getPaperDim();
    const dpi   = parseInt(selDpi.value, 10);
    const scale = getScale();
    const outW  = Math.round(pw_mm / 25.4 * dpi);
    const outH  = Math.round(ph_mm / 25.4 * dpi);
    const groundW = Math.round((pw_mm / 1000) * scale);
    const groundH = Math.round((ph_mm / 1000) * scale);
    const lat   = map.getCenter().lat;
    const z     = getExportZoom(lat);
    infoEl.textContent = `出力: ${outW}×${outH} px　ズーム: ${z.toFixed(1)}\n範囲: ${groundW}×${groundH} m`;
  }

  function schedulePrintFrameRefresh() {
    if (!isPrintPanelVisible()) return;
    if (printModeState.frameRefreshRaf) cancelAnimationFrame(printModeState.frameRefreshRaf);
    printModeState.frameRefreshRaf = requestAnimationFrame(() => {
      printModeState.frameRefreshRaf = requestAnimationFrame(() => {
        printModeState.frameRefreshRaf = 0;
        map.resize();
        if (printModeState.active && map.setMinZoom) {
          map.setMinZoom(getPrintModeMinZoom());
        }
        updatePrintFrame();
        updateInfo();
      });
    });
  }

  // 印刷モードが有効かどうか判定（パネルが active かつサイドバーが開いている）
  function isPrintPanelVisible() {
    const printPanel = document.getElementById('panel-print');
    const sbPanel    = document.getElementById('sidebar-panel');
    return printPanel?.classList.contains('active') && !sbPanel?.classList.contains('sb-hidden');
  }

  function lockPrintPitchControls() {
    printModeState.dragPitchWasEnabled  = map.dragPitch?.isEnabled?.() ?? null;
    printModeState.touchPitchWasEnabled = map.touchPitch?.isEnabled?.() ?? null;
    printModeState.dragRotateWasEnabled = map.dragRotate?.isEnabled?.() ?? null;
    printModeState.usedDragRotateFallback = !map.dragPitch?.disable && !!map.dragRotate?.disable;

    if (map.dragPitch?.disable) map.dragPitch.disable();
    else if (map.dragRotate?.disable) map.dragRotate.disable();

    if (map.touchPitch?.disable) map.touchPitch.disable();
  }

  function unlockPrintPitchControls() {
    if (map.dragPitch?.enable && printModeState.dragPitchWasEnabled) map.dragPitch.enable();
    if (map.touchPitch?.enable && printModeState.touchPitchWasEnabled) map.touchPitch.enable();
    if (printModeState.usedDragRotateFallback && map.dragRotate?.enable && printModeState.dragRotateWasEnabled) {
      map.dragRotate.enable();
    }
  }

  function getClampedPrintZoom(nextZoom) {
    const minZoom = getPrintModeMinZoom();
    const maxZoom = map.getMaxZoom?.() ?? 24;
    return Math.max(minZoom, Math.min(maxZoom, nextZoom));
  }

  function getPrintModeMinZoom() {
    const baseMinZoom = printModeState.active && printModeState.prevMinZoom !== null
      ? printModeState.prevMinZoom
      : (map.getMinZoom?.() ?? 0);
    const mapRect = map.getContainer().getBoundingClientRect();
    const { anchorPx } = getPrintFrameLayout();
    const anchorY = Math.max(0, Math.min(mapRect.height, anchorPx[1] - mapRect.top));
    const distTop = Math.max(1, anchorY);
    const distBottom = Math.max(1, mapRect.height - anchorY);
    const anchorLngLat = getPrintFrameAnchorLngLat();
    const latRad = Math.max(-85.05112878, Math.min(85.05112878, anchorLngLat.lat)) * Math.PI / 180;
    const mercatorY = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
    const eps = 1e-6;
    const minWorldFromTop = distTop / Math.max(mercatorY, eps);
    const minWorldFromBottom = distBottom / Math.max(1 - mercatorY, eps);
    const requiredWorldSize = Math.max(minWorldFromTop, minWorldFromBottom, 256 * Math.pow(2, baseMinZoom));
    const verticalLimitMinZoom = Math.log2(requiredWorldSize / 256);
    return Math.max(baseMinZoom, verticalLimitMinZoom);
  }

  function getPrintFrameAnchorLngLat() {
    const mapRect = map.getContainer().getBoundingClientRect();
    const { anchorPx } = getPrintFrameLayout();
    const anchorX = anchorPx[0] - mapRect.left;
    const anchorY = anchorPx[1] - mapRect.top;
    return map.unproject([anchorX, anchorY]);
  }

  function getPrintFrameAnchorClientPx() {
    const { anchorPx } = getPrintFrameLayout();
    return { x: anchorPx[0], y: anchorPx[1] };
  }

  function enablePrintCenterZoom() {
    const container = map.getContainer();
    printModeState.scrollZoomWasEnabled = map.scrollZoom?.isEnabled?.() ?? null;
    printModeState.doubleClickZoomWasEnabled = map.doubleClickZoom?.isEnabled?.() ?? null;
    printModeState.touchZoomRotateWasEnabled = map.touchZoomRotate?.isEnabled?.() ?? null;

    if (map.scrollZoom?.disable) map.scrollZoom.disable();
    if (map.doubleClickZoom?.disable) map.doubleClickZoom.disable();

    printModeState.wheelHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentZoom = map.getZoom();
      const wheelStep = e.deltaMode === 1 ? 0.18 : 0.12;
      const zoomDelta = -Math.sign(e.deltaY || 0) * wheelStep;
      if (!zoomDelta) return;
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.zoomTo(getClampedPrintZoom(currentZoom + zoomDelta), {
        around: anchor,
        duration: 0,
        essential: true,
      });
    };

    printModeState.dblClickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.zoomTo(getClampedPrintZoom(map.getZoom() + 1), {
        around: anchor,
        duration: 120,
        essential: true,
      });
    };

    container.addEventListener('wheel', printModeState.wheelHandler, { passive: false });
    container.addEventListener('dblclick', printModeState.dblClickHandler);
  }

  function disablePrintCenterZoom() {
    const container = map.getContainer();
    if (printModeState.wheelHandler) {
      container.removeEventListener('wheel', printModeState.wheelHandler);
      printModeState.wheelHandler = null;
    }
    if (printModeState.dblClickHandler) {
      container.removeEventListener('dblclick', printModeState.dblClickHandler);
      printModeState.dblClickHandler = null;
    }

    if (map.scrollZoom?.enable && printModeState.scrollZoomWasEnabled) map.scrollZoom.enable();
    if (map.doubleClickZoom?.enable && printModeState.doubleClickZoomWasEnabled) map.doubleClickZoom.enable();
    if (map.touchZoomRotate?.enable && printModeState.touchZoomRotateWasEnabled) map.touchZoomRotate.enable();
  }

  function enablePrintCenterRotate() {
    const container = map.getContainer();
    if (map.dragRotate?.disable) map.dragRotate.disable();

    printModeState.rotateMouseDownHandler = (e) => {
      const isRotateDrag = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
      if (!isRotateDrag) return;
      const anchorClient = getPrintFrameAnchorClientPx();
      printModeState.isRotating = true;
      printModeState.suppressContextMenuOnce = e.button === 2;
      printModeState.rotateStartBearing = map.getBearing();
      printModeState.rotateStartAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
      e.preventDefault();
      e.stopPropagation();
    };

    printModeState.rotateMouseMoveHandler = (e) => {
      if (!printModeState.isRotating) return;
      const anchorClient = getPrintFrameAnchorClientPx();
      const currentAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
      const deltaDeg = (currentAngle - printModeState.rotateStartAngle) * 180 / Math.PI;
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.rotateTo(printModeState.rotateStartBearing - deltaDeg, {
        around: anchor,
        duration: 0,
        essential: true,
      });
      e.preventDefault();
      e.stopPropagation();
    };

    printModeState.rotateMouseUpHandler = () => {
      printModeState.isRotating = false;
      setTimeout(() => { printModeState.suppressContextMenuOnce = false; }, 0);
    };

    printModeState.rotateContextMenuHandler = (e) => {
      if (!printModeState.suppressContextMenuOnce) return;
      e.preventDefault();
      e.stopPropagation();
      printModeState.suppressContextMenuOnce = false;
    };

    container.addEventListener('mousedown', printModeState.rotateMouseDownHandler);
    window.addEventListener('mousemove', printModeState.rotateMouseMoveHandler);
    window.addEventListener('mouseup', printModeState.rotateMouseUpHandler);
    container.addEventListener('contextmenu', printModeState.rotateContextMenuHandler);
  }

  function disablePrintCenterRotate() {
    const container = map.getContainer();
    if (printModeState.rotateMouseDownHandler) {
      container.removeEventListener('mousedown', printModeState.rotateMouseDownHandler);
      printModeState.rotateMouseDownHandler = null;
    }
    if (printModeState.rotateMouseMoveHandler) {
      window.removeEventListener('mousemove', printModeState.rotateMouseMoveHandler);
      printModeState.rotateMouseMoveHandler = null;
    }
    if (printModeState.rotateMouseUpHandler) {
      window.removeEventListener('mouseup', printModeState.rotateMouseUpHandler);
      printModeState.rotateMouseUpHandler = null;
    }
    if (printModeState.rotateContextMenuHandler) {
      container.removeEventListener('contextmenu', printModeState.rotateContextMenuHandler);
      printModeState.rotateContextMenuHandler = null;
    }
    printModeState.isRotating = false;
    printModeState.suppressContextMenuOnce = false;

    if (!printModeState.usedDragRotateFallback && map.dragRotate?.enable && printModeState.dragRotateWasEnabled) {
      map.dragRotate.enable();
    }
  }

  async function enterPrintMode() {
    if (printModeState.active) return;
    printModeState.active = true;
    printModeState.prevTerrainEnabled = terrain3dCard?.classList.contains('active') ?? false;
    printModeState.prevBuildingEnabled = building3dCard?.classList.contains('active') ?? false;
    printModeState.prevProjectionType = map.getProjection?.()?.type ?? null;
    printModeState.prevRenderWorldCopies = map.getRenderWorldCopies?.() ?? null;
    printModeState.prevMinZoom = map.getMinZoom?.() ?? null;

    lockPrintPitchControls();
    if (printModeState.prevProjectionType !== 'mercator') map.setProjection({ type: 'mercator' });
    if (map.setRenderWorldCopies) map.setRenderWorldCopies(true);
    if (map.setMinZoom) map.setMinZoom(getPrintModeMinZoom());
    enablePrintCenterZoom();
    enablePrintCenterRotate();
    map.easeTo({ pitch: 0, duration: 500, essential: true });

    if (printModeState.prevTerrainEnabled) setTerrain3dEnabled(false);
    if (printModeState.prevBuildingEnabled) await setBuilding3dEnabled(false);
    if (simStartBlock) simStartBlock.style.display = 'none';
  }

  async function exitPrintMode() {
    if (!printModeState.active) return;
    printModeState.active = false;
    if (simStartBlock) simStartBlock.style.display = '';

    disablePrintCenterRotate();
    disablePrintCenterZoom();
    unlockPrintPitchControls();
    if (printModeState.prevProjectionType && printModeState.prevProjectionType !== 'mercator') {
      map.setProjection({ type: printModeState.prevProjectionType });
    }
    if (map.setRenderWorldCopies && printModeState.prevRenderWorldCopies !== null) {
      map.setRenderWorldCopies(printModeState.prevRenderWorldCopies);
    }
    if (map.setMinZoom && printModeState.prevMinZoom !== null) {
      map.setMinZoom(printModeState.prevMinZoom);
    }
    setTerrain3dEnabled(!!printModeState.prevTerrainEnabled);
    await setBuilding3dEnabled(!!printModeState.prevBuildingEnabled);
  }

  async function syncFrameVisibility() {
    if (isPrintPanelVisible()) {
      await enterPrintMode();
      frameOverlay.classList.add('visible');
      schedulePrintFrameRefresh();
    } else {
      frameOverlay.classList.remove('visible');
      await exitPrintMode();
    }
  }

  // panel-print の active クラス変化を監視
  const printPanel = document.getElementById('panel-print');
  if (printPanel) {
    new MutationObserver(() => { void syncFrameVisibility(); })
      .observe(printPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // サイドバーパネルの sb-hidden クラス変化を監視（パネルを閉じたときに印刷モード解除）
  const sbPanel = document.getElementById('sidebar-panel');
  if (sbPanel) {
    new MutationObserver(() => { void syncFrameVisibility(); })
      .observe(sbPanel, { attributes: true, attributeFilter: ['class'] });
  }

  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => { void syncFrameVisibility(); });
  });
  document.querySelectorAll('.sidebar-close-btn').forEach(btn => {
    btn.addEventListener('click', () => { void syncFrameVisibility(); });
  });

  // マップ移動・ズームでフレームを更新
  map.on('move', updatePrintFrame);
  map.on('zoom', updatePrintFrame);
  window.addEventListener('resize', schedulePrintFrameRefresh);
  new ResizeObserver(schedulePrintFrameRefresh).observe(frameOverlay);
  new ResizeObserver(schedulePrintFrameRefresh).observe(map.getContainer());

  // 設定変更時の更新
  [selPaper, selOrientation, selScaleSelect].forEach(el => {
    el.addEventListener('change', schedulePrintFrameRefresh);
  });
  scaleCustomInput.addEventListener('input',  schedulePrintFrameRefresh);
  scaleCustomInput.addEventListener('change', updateInfo);
  selDpi.addEventListener('change', updateInfo);
  selZoom.addEventListener('change', updateInfo);

  // エクスポート実行
  async function execExport() {
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = getScale();
    const dpi   = parseInt(selDpi.value, 10);
    const fmt   = selFormat.value;
    const outW  = Math.round(pw_mm / 25.4 * dpi);
    const outH  = Math.round(ph_mm / 25.4 * dpi);

    if (outW > 8192 || outH > 8192) {
      alert(`出力サイズ ${outW}×${outH}px は大きすぎます。\nDPI または用紙サイズを小さくしてください。`);
      return;
    }

    exportBtn.disabled = true;
    exportBtn.textContent = '生成中...';
    showMapLoading();

    try {
      // エクスポート時の中心は印刷フレームのアンカー座標（サイドバーオフセット考慮済み）
      const { anchorPx } = getPrintFrameLayout();
      const center = map.unproject(anchorPx);
      const zoom   = getExportZoom(center.lat);

      const container = document.createElement('div');
      container.style.cssText =
        `position:fixed;left:-${outW + 100}px;top:0;width:${outW}px;height:${outH}px;visibility:hidden;`;
      document.body.appendChild(container);

      const rawStyle    = map.getStyle();
      // テレイン枠・境界レイヤーを除外（印刷出力に枠を含めない）
      const FRAME_LAYER_IDS = new Set([
        'frames-fill', 'frames-outline', 'frames-hover',
        'terrain-boundary-fill', 'terrain-boundary-outline',
      ]);
      const exportStyle = {
        ...rawStyle,
        terrain: undefined,
        layers: rawStyle.layers
          .filter(l => !FRAME_LAYER_IDS.has(l.id))
          .map(l => {
            // raster レイヤーの輪郭線プロパティを除去（MapLibre GL JS 5.x で追加）
            if (l.type !== 'raster') return l;
            const paint = { ...l.paint };
            delete paint['raster-border-color'];
            delete paint['raster-border-width'];
            return { ...l, paint };
          }),
      };

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

  exportBtn.addEventListener('click', execExport);
  void syncFrameVisibility();
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
   地図右クリックメニュー
   ================================================================ */
(function () {
  const menu      = document.getElementById('map-context-menu');
  const anchor    = document.getElementById('ctx-open-googlemap');
  const copyBtn   = document.getElementById('ctx-copy-link');
  if (!menu || !anchor || !copyBtn) return;

  let _lat = 0, _lng = 0;

  // MapLibre の contextmenu イベント（右クリック位置の lngLat を取得）
  map.on('contextmenu', (e) => {
    if (pcSimState.active) return; // PCシム中は無効
    ({ lng: _lng, lat: _lat } = e.lngLat);
    const z = map.getZoom().toFixed(2);
    anchor.href = `https://www.google.com/maps/@${_lat.toFixed(6)},${_lng.toFixed(6)},${z}z`;
    copyBtn.textContent = 'この地点のリンクをコピー';
    // アイコンは SVG 要素なので textContent で消えてしまうため再挿入
    copyBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>この地点のリンクをコピー`;
    menu.style.left = `${e.originalEvent.clientX}px`;
    menu.style.top  = `${e.originalEvent.clientY}px`;
    menu.style.display = 'block';
    e.originalEvent.preventDefault();
    // document の contextmenu リスナーへのバブリングを止めてメニューが即時閉じないようにする
    e.originalEvent.stopPropagation();
  });

  // 「この地点のリンクをコピー」: 右クリック地点を中心にした URL をクリップボードへ
  // MapLibre の hash:'map' と同じ形式 #map=zoom/lat/lng/bearing/pitch で生成する
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

  // 右クリックメニュー以外のクリック・右クリック・地図ドラッグで閉じる
  document.addEventListener('click',        () => { menu.style.display = 'none'; });
  document.addEventListener('contextmenu',  () => { menu.style.display = 'none'; });
  map.on('movestart', () => { menu.style.display = 'none'; });
})();

/* ================================================================
   PalettePicker — グラデーションバー表示のパレット選択ドロップダウン
   ================================================================ */

// containerEl: パレットピッカーを差し込む親要素
// initialId: 初期パレット ID
// onChange(id): パレット変更時コールバック
// 戻り値: { getValue, setValue } API
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
function initPalettePickers() {
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

/* ================================================================
   CustomSelect — ネイティブ <select> をカスケードメニュー風UIに置き換え
   ブラウザはネイティブ select の open 状態をCSSで変更できないため、
   JS でカスタムドロップダウンを構築して .cascade-* クラスで統一する。

   公開API（sel._csRefresh / sel._csSync）:
     sel._csRefresh()  options が変わった後に呼ぶ（一覧を再構築）
     sel._csSync()     sel.value を直接書き換えた後に手動同期
   ================================================================ */
function makeCustomSelect(sel) {
  // ---- ラッパー div（レイアウト担当）----
  // 元 select のクラスをラッパーに移す（flex / width 等のレイアウト CSS を継承する）
  const wrap = document.createElement('div');
  wrap.className = (sel.className ? sel.className + ' ' : '') + 'custom-select-wrap';
  if (sel.id) wrap.setAttribute('data-select-id', sel.id);

  // ---- トリガーボタン（外観担当、.cascade-btn でスタイル済み）----
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cascade-btn';
  btn.disabled = sel.disabled;

  // ---- ドロップダウンパネル（body直下に配置して z-index と overflow を回避）----
  const panel = document.createElement('div');
  panel.className = 'cascade-menu custom-select-menu';

  // ---- DOM 置き換え ----
  // select を非表示のまま DOM に保持することで getElementById / .value 等の JS 互換性を維持する
  sel.style.display = 'none';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(sel);
  document.body.appendChild(panel);

  // ---- オプション一覧を構築 ----
  function buildItems() {
    panel.innerHTML = '';
    Array.from(sel.options).forEach(opt => {
      if (opt.style.display === 'none') return; // 非表示オプションはスキップ
      const item = document.createElement('div');
      item.className = 'cascade-item';
      item.dataset.value = opt.value;
      item.textContent = opt.text;
      if (opt.disabled) {
        item.classList.add('disabled');
        item.style.opacity = '0.4';
        item.style.pointerEvents = 'none';
        item.style.cursor = 'default';
      }
      panel.appendChild(item);
    });
  }

  // ---- ボタン表示テキストと選択状態を同期 ----
  function syncDisplay() {
    const opt = sel.options[sel.selectedIndex];
    btn.textContent = opt ? opt.text : '';
    btn.disabled = sel.disabled;
    panel.querySelectorAll('.cascade-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === sel.value);
    });
  }

  buildItems();
  syncDisplay();

  // ---- メニュー開閉 ----
  function openPanel() {
    // 他の開いているカスタムセレクトをすべて閉じる
    document.querySelectorAll('.custom-select-menu.open').forEach(m => {
      if (m !== panel) m.classList.remove('open');
    });

    // 開くたびに項目を再構築（option テキストが動的に変わる場合に追従）
    buildItems();
    syncDisplay();

    const r = btn.getBoundingClientRect();

    // 実際の高さを計測するために visibility:hidden のまま一時表示
    panel.style.visibility = 'hidden';
    panel.classList.add('open');
    const panelH = Math.min(panel.scrollHeight, Math.floor(window.innerHeight * 0.5));
    panel.classList.remove('open');
    panel.style.visibility = '';

    // 画面下端に収まらない場合は上方向に展開
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < panelH && r.top > spaceBelow;
    if (openUp) {
      panel.style.top = (r.top - panelH - 2) + 'px';
    } else {
      panel.style.top = (r.bottom + 2) + 'px';
    }
    panel.style.left   = r.left + 'px';
    panel.style.minWidth = r.width + 'px';
    panel.classList.toggle('open-up', openUp);
    panel.classList.add('open');
    panel.classList.remove('left');
    hilEl = null;
    // 選択中の項目が見えるようにスクロール
    const selectedItem = panel.querySelector('.selected');
    if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
  }
  function closePanel() { panel.classList.remove('open', 'open-up'); }

  // CSS :hover に依存せず JS でハイライトを管理
  let hilEl = null;
  panel.addEventListener('mouseover', e => {
    const item = e.target.closest('.cascade-item');
    if (!item || item === hilEl) return;
    if (hilEl) hilEl.classList.remove('highlighted');
    item.classList.add('highlighted');
    hilEl = item;
    panel.classList.remove('left');
  });
  panel.addEventListener('mouseleave', () => {
    if (hilEl) { hilEl.classList.remove('highlighted'); hilEl = null; }
    panel.classList.add('left');
  });

  // btn / panel の mousedown は document に伝播させない
  // （伝播すると document の closePanel が先に発火し、click のトグル判定がずれる）
  btn.addEventListener('mousedown',   e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  document.addEventListener('mousedown', closePanel);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (sel.disabled) return;
    panel.classList.contains('open') ? closePanel() : openPanel();
  });
  panel.addEventListener('click', e => {
    const item = e.target.closest('.cascade-item:not(.disabled)');
    if (!item) return;
    sel.value = item.dataset.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    closePanel();
  });

  // ---- programmatic な sel.value 変更を検知して表示を同期 ----
  // （例: document.getElementById('import-paper-size').value = 'A4'）
  const proto = HTMLSelectElement.prototype;
  const origDesc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (origDesc) {
    Object.defineProperty(sel, 'value', {
      get: ()  => origDesc.get.call(sel),
      set: v   => { origDesc.set.call(sel, v); syncDisplay(); },
      configurable: true,
    });
  }
  // change イベント経由の変更にも対応（programmatic な dispatchEvent を含む）
  sel.addEventListener('change', syncDisplay);

  // ---- 公開 API ----
  sel._csRefresh = () => { buildItems(); syncDisplay(); };
  sel._csSync    = syncDisplay;
}

/* すべての <select> 要素をカスタムUIに変換する */
function initCustomSelects() {
  document.querySelectorAll('select').forEach(makeCustomSelect);
}

// DOM 構築完了後に実行（<script type="module"> は defer 相当で DOM 準備済み）
initCustomSelects();
initPalettePickers();

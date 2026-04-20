/* ================================================================
   app.js — アプリケーション本体（地図初期化・KMZ・GPX・UI）
   ================================================================

   【モジュール構成】
     config.js       定数・URL・初期値
     protocols.js    gsjdem:// / dem2cs:// / dem2relief:// / dem2curve:// プロトコル登録
     contours.js     等高線・DEM レイヤー管理（本ファイルからインポート）

   【本ファイルの内容（論理セクション）】
     §1  Import
     §2  グローバル状態変数
     §3  マップ初期化・コントロール追加
     §4  map.on('load') ハンドラ
           ① ラスターベースマップ ソース/レイヤー
           ② 等高線 DemSource 初期化（Q地図/DEM5A/DEM1A）
           ③ isomizer（OriLibre ベクタースタイル）
           ④ CS 立体図・色別標高図・磁北線ソース/レイヤー
           ⑤ テレインマスタ自動読み込み
     §5  ローカル地図リスト描画（renderLocalMapList / renderOtherMapsTree）
     ※ テレイン検索 UI  → js/features/terrainSearch/terrainSearchPanel.js
     §7  CS立体図・オーバーレイ表示制御（updateCsVisibility）
     §8  左パネル・右パネル制御
     §9  エクスプローラー ファイルツリー
     §10 その他 UI（ボトムシート・右クリックメニュー）
     ※ ベースマップ切替   → js/core/basemapController.js
     ※ PLATEAU 3D建物     → js/core/plateauController.js
     ※ レイヤーパネル     → js/ui/layersPanel.js

   ================================================================ */

import { getDeclination, setDeclinationModel } from './core/magneticDeclination.js';
import { initCoursePlanner, setMapLayersGetter, setImportDoneCallback, migrateCourseSets } from './core/course.js';
import {
  init as initLocalMapListPanel,
  renderOtherMapsTree, renderLocalMapList, updateStorageInfoBar,
} from './ui/localMapListPanel.js';

import {
  init as initExplorerController,
  renderExplorer, openCourseEditor, backToTerrainGrid,
  renderTerrainPanelView, renderTerrainGridView,
  setFocusTerrain, setCollapsed as setExplorerCollapsed,
} from './features/explorer/explorerController.js';
import { setActiveId as setExplorerActiveId } from './features/explorer/explorerState.js';
import {
  init as initTerrainSearchPanel, syncSearchLayer,
} from './features/terrainSearch/terrainSearchPanel.js';
import { init as initLocalTerrainDrawer } from './features/localTerrain/localTerrainDrawer.js';
import {
  QCHIZU_DEM_BASE, QCHIZU_PROXY_BASE, DEM5A_BASE, DEM1A_BASE,
  TERRAIN_URL, CS_RELIEF_URL,
  REGIONAL_CS_LAYERS, REGIONAL_RRIM_LAYERS,
  REGIONAL_RELIEF_LAYERS, REGIONAL_SLOPE_LAYERS, REGIONAL_CURVE_LAYERS,
  INITIAL_CENTER, INITIAL_ZOOM, INITIAL_PITCH, INITIAL_BEARING,
  TERRAIN_EXAGGERATION, CS_INITIAL_OPACITY,
  EASE_DURATION, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR, SIDEBAR_DEFAULT_WIDTH,
  BASEMAPS,
} from './core/config.js';

import {
  contourState,
  contourLayerIds, DEM5A_CONTOUR_LAYER_IDS, DEM1A_CONTOUR_LAYER_IDS,
  COLOR_CONTOUR_Q_IDS, COLOR_CONTOUR_DEM5A_IDS, COLOR_CONTOUR_DEM1A_IDS,
  buildColorContourExpr,
  buildContourTileUrl, buildSeamlessContourTileUrl, buildDem1aContourTileUrl,
} from './core/contours.js';

import {
  initTerrainLayers,
  updateWorkspaceTerrainSource,
} from './core/terrainSearch.js';

import {
  getWsTerrains, getWsTerrain, saveWsTerrain,
} from './api/workspace-db.js';

import { makeCustomSelect, initCustomSelects } from './ui/components/customSelect.js';
import {
  openSidebarPanel, closeSidebar,
  isSidebarOpen,
  updateSidebarWidth, initSidebarNav,
} from './ui/uiState.js';
import { on } from './store/eventBus.js';
import { gpxState } from './gpx/gpxState.js';
import {
  init as initGpxCamera,
  updateGpxMarker, updateCamera,
} from './gpx/gpxCamera.js';
import { init as initGpxLoader, loadGpx } from './gpx/gpxLoader.js';
import {
  init as initGpxPlayer,
  updateSeekBarGradient, updateTimeDisplay,
  interpolateGpxPosition, toggleGpxPlayPause, toggleGpx3dMode,
} from './gpx/gpxPlayer.js';
import {
  init as initScaleDisplay,
  getCurrentDevicePPI, updatePpiRuler, updatePpiSliderBubble, updateScaleDisplay,
} from './ui/components/scaleDisplay.js';
import { escHtml } from './utils/dom.js';
import {
  init as initAttribution,
  initAttributionObserver,
  updateBasemapAttribution, updateRegionalAttribution,
  updatePlateauAttribution, updateMagneticAttribution,
} from './core/attribution.js';
import {
  init as initMagneticLines,
  setUserMagneticInterval,
  clearGlobalMagneticCache, getLastMagneticNorthData,
  updateMagneticNorth, getMagneticLineColor,
  handleMagneticColorChange,
} from './core/magneticLines.js';
import {
  init as initLocalMapStore,
  localMapLayers, toRasterOpacity, removeLocalMapLayer,
} from './store/localMapStore.js';
import {
  init as initImportModal,
  openImportModal, openImportModalFromKmz,
} from './ui/modals/importModal.js';
import {
  init as initLocalMapLoader,
  loadKmz, loadImageWithJgw, restoreMapLayersFromDb,
} from './core/localMapLoader.js';
import {
  initImgwModal, openImgwModal,
} from './ui/modals/imgwModal.js';
import {
  init as initPlaceSearch, initListeners as initPlaceSearchListeners,
} from './ui/placeSearch.js';
import { initPrintDialog } from './ui/modals/printDialog.js';
import {
  initSim, pcSimState,
  updateReadmapBgKmzOptions, renderSimReadmapList, syncReadmapOriLibre,
  openPcReadMap, closePcReadMap, stopPcSim,
} from './ui/sim.js';
import {
  init as initReliefOverlay,
  OVERLAY_DATA_CONFIGS,
  scheduleDataOverlayDeckSync, scheduleSlopeDeckSync,
  applyColorReliefTiles, applySlopeReliefTiles, applyCurvatureReliefTiles,
  autoFitColorRelief, autoFitSlopeRelief, autoFitCurvatureRelief,
  refreshColorReliefTrackLayout, refreshSlopeReliefTrackLayout, refreshCurvatureReliefTrackLayout,
  updateColorReliefSource, updateSlopeReliefSource, updateCurvatureReliefSource,
  getReliefPalette, crMin, crMax, crPaletteId,
  initPalettePickers,
} from './core/reliefOverlay.js';
import {
  init as initMapLoading,
  showMapLoading, hideMapLoading,
  showMapTileLoading,
} from './ui/mapLoading.js';
import { init as initDeleteModal } from './ui/modals/deleteModal.js';
import {
  init as initUiStateManager,
  saveUiState, updateShareableUrl, restoreUiState,
} from './store/uiStateManager.js';
import {
  init as initContourController,
  applyContourInterval, updateContourAutoInterval,
  getUserContourInterval, setUserContourInterval,
  getLastAppliedContourInterval,
} from './core/contourController.js';
import {
  init as initBasemapController,
  getCurrentBasemap, getOriLibreLayers, setOriLibreLayers, addOriLibreLayer,
  getOriLibreCachedStyle, setOriLibreCachedStyle, switchBasemap,
} from './core/basemapController.js';
import {
  init as initPlateauController,
  syncTerrainRasterOpacity, setBuilding3dEnabled, setTerrain3dEnabled, updateBuildingLayer,
} from './core/plateauController.js';
import {
  init as initLayersPanel, openLayersPanel, renderLayersPanel,
} from './ui/layersPanel.js';
import { terrainMap } from './store/terrainStore.js';
import {
  init as initOverlayController,
  getCurrentOverlay, setCurrentOverlay, updateCsVisibility,
  isCsLayerVisible, isGeneratingLayer,
} from './core/overlayController.js';

// ================================================================
// §2  グローバル状態変数
// ================================================================

// --- グローブ背景 ---
let _globeBgEl = null;
let _updateGlobeBg = null;

// --- 初期化順の影響を受ける共有状態（TDZ 回避のため var で早期宣言） ---
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


// テレイン検索 UI — map.on('load') より前に初期化して初回検索を即実行する
initTerrainSearchPanel(map, {
  onTerrainNavigate: (terrainId) => {
    setFocusTerrain(terrainId);
    setExplorerCollapsed(terrainId, false);
    openSidebarPanel('layers');
    renderExplorer();
  },
});

// ローカルテレイン描画モジュール初期化
initLocalTerrainDrawer(map, {
  onTerrainCreated: async (terrainId) => {
    setFocusTerrain(terrainId);
    setExplorerCollapsed(terrainId, false);
    openSidebarPanel('layers');
    await renderExplorer();
  },
});

// sidebar:panelChanged — UI 状態を保存
on('sidebar:panelChanged', () => saveUiState());

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
      tiles: [buildContourTileUrl(5)], // 初期値5m; restoreUiState で上書きされる
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
      tiles: [buildSeamlessContourTileUrl(5)], // 初期値5m; restoreUiState で上書きされる
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
      tiles: [buildDem1aContourTileUrl(5)], // 初期値5m; restoreUiState で上書きされる
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
    setOriLibreLayers(map.getStyle().layers
      .filter(l => !snapshotBeforeIsomizer.has(l.id) && l.source !== 'contour-source')
      .map(l => ({
        id: l.id,
        defaultVisibility: l.layout?.visibility ?? 'visible',
        ...(l.type === 'background' ? { origBgColor: l.paint?.['background-color'] } : {}),
      })));
    console.log(`OriLibre レイヤー収集完了: ${getOriLibreLayers().length} レイヤー`);

    // backgroundレイヤーを最下層に移動（ラスターベースマップの下に配置）
    // ベースマップ切替時に色を変えるだけで済むようにする
    const bgInit = getOriLibreLayers().find(l => l.id.endsWith('-background'));
    if (bgInit && map.getLayer(bgInit.id)) {
      const firstId = map.getStyle().layers[0]?.id;
      if (firstId && firstId !== bgInit.id) map.moveLayer(bgInit.id, firstId);
    }

    // 読図マップ用にOriLibreスタイルをキャッシュ（ベースマップ切替後も正しく参照できるよう）
    setOriLibreCachedStyle(map.getStyle());

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
      addOriLibreLayer({ id: 'water-ocean-fill', defaultVisibility: 'visible' });
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

  // ⑤ テレイン検索レイヤーを初期化する
  initTerrainLayers(map);
  // マップロード前に検索が完了していた場合、キャッシュ結果をレイヤーに反映する
  syncSearchLayer();

  // ローディングインジケーターモジュール初期化
  initMapLoading(map);

  // 等高線UIコントローラー初期化（restoreUiState より前に必要）
  initContourController(map, {
    getCurrentOverlay,
    updateCsVisibility,
  });

  // ベースマップ切替コントローラー初期化
  initBasemapController(map, { updateCsVisibility });

  // PLATEAU 3Dビル・地形コントローラー初期化
  initPlateauController(map);

  // オーバーレイ制御コントローラー初期化
  initOverlayController(map);

  // UI状態管理モジュール初期化（restoreUiState より前に必要）
  initUiStateManager({
    getCurrentBasemap,
    getCurrentOverlay,
    setCurrentOverlay,
    getUserContourInterval,
    setUserContourInterval,
    getMap:                  () => map,
    switchBasemap,
    applyContourInterval,
    updateCsVisibility,
    setTerrain3dEnabled,
    setBuilding3dEnabled,
  });

  // UI状態全体をlocalStorageから復元（リロード時維持）
  restoreUiState();

  // IndexedDB に保存された地図を復元する（非同期・失敗しても継続）
  restoreMapLayersFromDb();

  // コースセットへの DB 移行（v4→v5: controlDefs を course_sets ストアへ）
  migrateCourseSets().catch(e => console.warn('migrateCourseSets:', e));

  // コースプランナー初期化（localMapLayers の参照を渡す）
  setMapLayersGetter(() => localMapLayers);
  setImportDoneCallback(() => { renderExplorer(); openCourseEditor(); });
  initCoursePlanner(map);

  // GPX モジュール初期化（map インスタンスを注入）
  initGpxCamera(map);
  initGpxLoader(map);
  initGpxPlayer(map);

  // 縮尺表示・PPI設定モジュール初期化
  initScaleDisplay(map);

  // 出典管理モジュール初期化（currentBasemap / currentOverlay をゲッターで注入）
  initAttribution(map, {
    getBasemap: getCurrentBasemap,
    getOverlay: getCurrentOverlay,
  });

  // 磁北線モジュール初期化（PCシム readmap をゲッターで遅延注入）
  initMagneticLines(map, { getReadMap: () => pcSimState.readMap });

  // レイヤーパネルモジュール初期化
  initLayersPanel(map, { onStorageClear: updateStorageInfoBar });

  // ローカル地図リストパネルモジュール初期化
  initLocalMapListPanel(map, { updateReadmapBgKmzOptions, renderSimReadmapList });

  // エクスプローラーモジュール初期化
  initExplorerController(map, { renderLocalMapList, renderOtherMapsTree });

  // ローカル地図レイヤーストア初期化
  initLocalMapStore(map);

  // 地図インポートモーダル初期化
  initImportModal(map);

  // 削除確認モーダル初期化
  initDeleteModal(map, {
    onTerrainDeleted: () => {
      backToTerrainGrid();
    },
    onEventDeleted: async () => {
      setExplorerActiveId(null);
      await renderExplorer();
    },
    onCourseSetDeleted: async () => {
      setExplorerActiveId(null);
      await renderExplorer();
    },
    onCourseDeleted: async () => {
      setExplorerActiveId(null);
      await renderExplorer();
    },
  });

  // KMZ / 画像+JGW ローダー初期化
  initLocalMapLoader(map);

  // リリーフオーバーレイ初期化
  initReliefOverlay(map, { getCurrentOverlay });

  // シミュレーターモジュール初期化
  initSim(map, {
    getUpdateGlobeBg:              () => _updateGlobeBg,
    getLastAppliedContourInterval,
    getOriLibreCachedStyle,
  });

  // 地名検索初期化
  initPlaceSearch(map);
  initPlaceSearchListeners();

  // 地図が安定表示されたらURLをフル状態に更新（Google Maps方式）
  // hash:true がハッシュを確定した後に updateShareableUrl を呼ぶことで
  // https://teledrop.pages.dev/ → https://teledrop.pages.dev/?overlay=cs#15/35.02/135.78 に自動遷移する
  map.once('idle', () => {
    updateShareableUrl();
    renderExplorer();
  });

  console.log('3D OMap Viewer 初期化完了（OriLibreベースマップ）');
});








// GPXファイル選択ボタン
const gpxFileInput = document.getElementById('gpx-file-input');
const gpxUploadBtn = document.getElementById('gpx-upload-btn');
gpxUploadBtn.addEventListener('click', () => gpxFileInput.click());

// GPXファイルが選択されたら loadGpx を呼び出す（単一ファイル）
gpxFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) { await loadGpx(file); }
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


initImgwModal();



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
  for (const file of gpxFiles) { await loadGpx(file); }

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
// ユーザーが手動で設定した磁北線間隔（m）。zoom > 10 のときに使用する。
// ---- 磁北線 タイルカード ----
const magneticCard = document.getElementById('magnetic-card');
selMagneticCombined = document.getElementById('sel-magnetic-combined');
selMagneticModel    = document.getElementById('sel-magnetic-model');
selMagneticColor    = document.getElementById('sel-magnetic-color');

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
  clearGlobalMagneticCache();
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
  if (val) setUserMagneticInterval(val);
  updateMagneticNorth();
  updateShareableUrl();
  saveUiState();
});

selMagneticColor?.addEventListener('input',  () => handleMagneticColorChange(saveUiState));
selMagneticColor?.addEventListener('change', () => handleMagneticColorChange(saveUiState));


// ---- サムネイル生成関連 ----

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

// ================================================================
map.once('idle', () => { updateSidebarWidth(); });


// スライダーの初期値をUIに反映（値を設定してからグラデーションを更新する）


// 3D地形初期倍率をセレクトに反映（TERRAIN_EXAGGERATION = 1.0 なので ×1 がデフォルト選択済み）


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
  // 注: uiState.js の initSidebarNav が先に実行され isSidebarOpen() が更新済み
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!MQ.matches) return;
      if (isSidebarOpen()) {
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

initPrintDialog(map, { setTerrain3dEnabled, setBuilding3dEnabled });


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




// DOM 構築完了後に実行（<script type="module"> は defer 相当で DOM 準備済み）
initCustomSelects();
initPalettePickers();

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

import { createMap } from './core/mapFactory.js';
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
  CS_RELIEF_URL,
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
  updateSidebarWidth, initSidebarNav,
} from './ui/uiState.js';
import { initBottomSheet } from './ui/bottomSheet.js';
import { init as initMapContextMenu } from './ui/mapContextMenu.js';
import { init as initDropHandler } from './ui/dropHandler.js';
import { init as initMagneticPanel } from './ui/magneticPanel.js';
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
  updateMagneticNorth, getMagneticLineColor,
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
import { initDevTools } from './dev/devTools.js';
import {
  init as initGlobeBackground,
  getUpdateGlobeBg,
} from './features/globe/globeBackground.js';

// ================================================================
// §2  マップ初期化
// ================================================================

// マップ生成・コントロール追加 → js/core/mapFactory.js
const { map, restoredFromStorage } = createMap();


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
    if (!location.hash && !restoredFromStorage) {
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

  // ④ Globe投影・宇宙空間背景 → js/features/globe/globeBackground.js
  initGlobeBackground(map);

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
    getUpdateGlobeBg,
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


initDropHandler({
  onKmz:          file => openImportModalFromKmz(file),
  onGpx:          file => loadGpx(file),
  onImage:        file => openImportModal(file),
  onImageWithJgw: (imgs, jgw) => openImgwModal(imgs, jgw),
});

initMagneticPanel(map, { saveUiState, updateShareableUrl });


// ================================================================
map.once('idle', () => { updateSidebarWidth(); });


// スライダーの初期値をUIに反映（値を設定してからグラデーションを更新する）


// 3D地形初期倍率をセレクトに反映（TERRAIN_EXAGGERATION = 1.0 なので ×1 がデフォルト選択済み）


initBottomSheet();

initPrintDialog(map, { setTerrain3dEnabled, setBuilding3dEnabled });


// 開発用ツール（カラーピッカー・クロップ枠）→ js/dev/devTools.js
initDevTools(map);

initMapContextMenu(map, { isPcSimActive: () => pcSimState.active });

/* ================================================================
   PalettePicker — グラデーションバー表示のパレット選択ドロップダウン
   ================================================================ */




// DOM 構築完了後に実行（<script type="module"> は defer 相当で DOM 準備済み）
initCustomSelects();
initPalettePickers();

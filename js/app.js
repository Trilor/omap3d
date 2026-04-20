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
  setFocusTerrain, setCollapsed as setExplorerCollapsed,
} from './features/explorer/explorerController.js';
import { setActiveId as setExplorerActiveId } from './features/explorer/explorerState.js';
import {
  init as initTerrainSearchPanel, syncSearchLayer,
} from './features/terrainSearch/terrainSearchPanel.js';
import { init as initLocalTerrainDrawer } from './features/localTerrain/localTerrainDrawer.js';

import { initTerrainLayers } from './core/terrainSearch.js';

import { initCustomSelects } from './ui/components/customSelect.js';
import {
  openSidebarPanel,
  updateSidebarWidth,
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
import { init as initScaleDisplay } from './ui/components/scaleDisplay.js';
import { init as initAttribution } from './core/attribution.js';
import { init as initMagneticLines } from './core/magneticLines.js';
import { init as initLocalMapStore, localMapLayers } from './store/localMapStore.js';
import {
  init as initImportModal,
  openImportModal, openImportModalFromKmz,
} from './ui/modals/importModal.js';
import { init as initLocalMapLoader, restoreMapLayersFromDb } from './core/localMapLoader.js';
import {
  initImgwModal, openImgwModal,
} from './ui/modals/imgwModal.js';
import {
  init as initPlaceSearch, initListeners as initPlaceSearchListeners,
} from './ui/placeSearch.js';
import { initPrintDialog } from './ui/modals/printDialog.js';
import {
  initSim, pcSimState,
  updateReadmapBgKmzOptions, renderSimReadmapList,
} from './ui/sim.js';
import { init as initReliefOverlay, initPalettePickers } from './core/reliefOverlay.js';
import { init as initMapLoading } from './ui/mapLoading.js';
import { init as initDeleteModal } from './ui/modals/deleteModal.js';
import {
  init as initUiStateManager,
  saveUiState, updateShareableUrl, restoreUiState,
} from './store/uiStateManager.js';
import {
  init as initContourController,
  applyContourInterval,
  getUserContourInterval, setUserContourInterval,
  getLastAppliedContourInterval,
} from './core/contourController.js';
import {
  init as initBasemapController,
  getCurrentBasemap, getOriLibreCachedStyle, switchBasemap,
} from './core/basemapController.js';
import {
  init as initPlateauController,
  setBuilding3dEnabled, setTerrain3dEnabled,
} from './core/plateauController.js';
import { init as initLayersPanel, openLayersPanel } from './ui/layersPanel.js';
import {
  init as initOverlayController,
  getCurrentOverlay, setCurrentOverlay, updateCsVisibility,
} from './core/overlayController.js';
import { initDevTools } from './dev/devTools.js';
import {
  init as initGlobeBackground,
  getUpdateGlobeBg,
} from './features/globe/globeBackground.js';
import { setupMapLayers } from './features/mapSetup/mapLayerSetup.js';

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

  // ソース・レイヤー追加・イベントハンドラ登録 → js/features/mapSetup/mapLayerSetup.js
  await setupMapLayers(map, { restoredFromStorage });

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

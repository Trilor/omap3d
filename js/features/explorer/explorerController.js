/**
 * explorerController.js — エクスプローラーのエントリーポイント
 *
 * 担当:
 *   - init(map, callbacks) — EventBus リスナー / DOM リスナー登録
 *   - renderExplorer()     — 多重実行防止ロジック付き再描画
 *   - ファイルインプットハンドラ（地図/GPX/コース）
 *   - キーボードショートカット（F2 リネーム / Escape）
 *
 * 使い方: init(map, { renderLocalMapList, renderOtherMapsTree }) を map.on('load') 内で呼ぶ。
 */

import { on } from '../../store/eventBus.js';
import {
  getActiveId, getCtx,
  renameHandlers,
  getSelectedTerrain,
  getPendingImportTerrain, setPendingImportTerrain,
  getPendingGpxTerrain, setPendingGpxTerrain,
  isRendering, setRendering, isRenderPending, setRenderPending,
  getTerrainViewMode,
} from './explorerState.js';
export { setFocusTerrain, setCollapsed } from './explorerState.js';
import {
  init as initRenderer,
  renderExplorerOnce, renderTerrainPanelView, renderTerrainGridView,
  backToTerrainGrid, showAddPopoverAt,
  closeExplorerCtx, showExplorerCtx,
  showTerrainGridContextMenu, openCourseEditor,
} from './explorerRenderer.js';
export { openCourseEditor, backToTerrainGrid, renderTerrainPanelView, renderTerrainGridView } from './explorerRenderer.js';
import { getWsTerrains, renameWsTerrain } from '../../api/workspace-db.js';
import { showTerrainDeleteModal } from '../../ui/modals/deleteModal.js';
import { loadKmz, loadImageWithJgw } from '../../core/localMapLoader.js';
import { loadGpx } from '../../gpx/gpxLoader.js';
import { localMapLayers } from '../../store/localMapStore.js';
import { initSidebarNav } from '../../ui/uiState.js';
import { EASE_DURATION } from '../../core/config.js';

let _map = null;
let _callbacks = {};

/**
 * @param {maplibregl.Map} map
 * @param {{ renderLocalMapList: Function, renderOtherMapsTree: Function }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;

  initRenderer(map, {
    renderLocalMapList:      () => _callbacks.renderLocalMapList?.(),
    renderOtherMapsTree:     () => _callbacks.renderOtherMapsTree?.(),
    onRenderExplorer:        renderExplorer,
    setPendingImportTerrain,
    setPendingGpxTerrain,
  });

  initSidebarNav();
  _initEventBusListeners();
  _initDomListeners();
}

// ================================================================
// 公開 API
// ================================================================

export async function renderExplorer() {
  if (isRendering()) { setRenderPending(true); return; }
  setRendering(true);
  try {
    await renderExplorerOnce();
    if (getTerrainViewMode() === 'grid') renderTerrainGridView();
  } finally {
    setRendering(false);
    if (isRenderPending()) {
      setRenderPending(false);
      renderExplorer();
    }
  }
}

// ================================================================
// EventBus リスナー
// ================================================================

function _initEventBusListeners() {
  on('gpx:loaded', () => renderExplorer());

  on('localmap:changed', () => {
    _callbacks.renderLocalMapList?.();
    _callbacks.renderOtherMapsTree?.();
    renderExplorer();
  });

  on('sidebar:panelChanged', ({ panelId, open }) => {
    if (open && panelId === 'layers') renderTerrainPanelView();
  });
}

// ================================================================
// DOM イベントリスナー
// ================================================================

function _initDomListeners() {
  // コンテキストメニュー — 外側クリック / Escape で閉じる
  document.addEventListener('mousedown', e => {
    if (getCtx() && !getCtx().contains(e.target)) closeExplorerCtx();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && getCtx()) closeExplorerCtx();
    if (e.key === 'F2' && getActiveId()) {
      e.preventDefault();
      const handler = renameHandlers.get(getActiveId());
      if (handler) handler();
    }
  }, true);

  // ワークスペースヘッダー — 戻るボタン
  document.getElementById('ws-header-back-btn')?.addEventListener('click', () => backToTerrainGrid());

  // ワークスペースヘッダー — 追加ボタン
  document.getElementById('ws-header-add-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showAddPopoverAt(r.left, r.bottom + 4, getSelectedTerrain());
  });

  // ワークスペースヘッダー — ⋮ オプションボタン
  document.getElementById('ws-header-more-btn')?.addEventListener('click', async e => {
    e.stopPropagation();
    const selectedTerrain = getSelectedTerrain();
    if (!selectedTerrain) return;
    let terrain = null;
    try {
      const terrains = await getWsTerrains();
      terrain = terrains.find(t => t.id === selectedTerrain);
    } catch { /* ignore */ }
    const isSystem = terrain && terrain.source !== 'local';
    const r = e.currentTarget.getBoundingClientRect();
    showExplorerCtx(r.right + 4, r.top, [
      { label: 'この場所へ移動', action: () => {
          if (terrain?.center) _map.easeTo({ center: terrain.center, zoom: Math.max(_map.getZoom(), 12), duration: EASE_DURATION });
        }
      },
      { label: '名前を変更', disabled: isSystem, action: () => {
          const titleEl = document.getElementById('ws-header-title');
          if (!titleEl || !terrain) return;
          const prev = terrain.name;
          titleEl.contentEditable = 'true';
          titleEl.focus();
          const range = document.createRange();
          range.selectNodeContents(titleEl);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
          const finish = async () => {
            titleEl.contentEditable = 'false';
            const newName = titleEl.textContent.trim();
            if (newName && newName !== prev) {
              try {
                await renameWsTerrain(selectedTerrain, newName);
                await renderExplorer();
              } catch { titleEl.textContent = prev; }
            } else {
              titleEl.textContent = prev;
            }
          };
          titleEl.addEventListener('blur', finish, { once: true });
          titleEl.addEventListener('keydown', ke => {
            if (ke.key === 'Enter') { ke.preventDefault(); titleEl.blur(); }
            if (ke.key === 'Escape') { titleEl.textContent = prev; titleEl.blur(); }
          }, { once: true });
        }
      },
      { separator: true },
      { label: 'ワークスペースから削除', danger: !isSystem, disabled: isSystem, action: () => {
          showTerrainDeleteModal(selectedTerrain);
        }
      },
    ]);
  });

  // テレインカード三点メニュー（委譲）
  document.getElementById('terrain-grid-container')?.addEventListener('click', e => {
    const menuBtn = e.target.closest('.terrain-card-menu-btn');
    if (!menuBtn) return;
    e.stopPropagation();
    const terrainId = menuBtn.dataset.terrainId;
    if (terrainId) showTerrainDeleteModal(terrainId);
  });

  // テレイングリッド右クリック
  document.getElementById('panel-terrain-view-grid')?.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showTerrainGridContextMenu(e.clientX, e.clientY);
  });

  // エクスプローラーツリー右クリック（空白部分 → 追加メニュー）
  document.getElementById('explorer-tree')?.addEventListener('contextmenu', e => {
    const onItem = e.target.closest('.expl-event-hd, .expl-courseset-hd, .expl-terrain-hd, .expl-item, .expl-sheet-hd');
    if (onItem) return;
    e.preventDefault();
    e.stopPropagation();
    showAddPopoverAt(e.clientX, e.clientY, getSelectedTerrain());
  });

  // ファイルインプット — 地図画像 / KMZ
  document.getElementById('explorer-map-input')?.addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    const terrainId = getPendingImportTerrain();
    setPendingImportTerrain(null);
    e.target.value = '';
    for (const f of files) {
      const prevCount = localMapLayers.length;
      if (/\.kmz$/i.test(f.name)) await loadKmz(f);
      else await loadImageWithJgw(f, null);
      const added = localMapLayers.slice(prevCount);
      added.forEach(entry => { entry.terrainId = terrainId ?? null; });
    }
    renderExplorer();
  });

  // ファイルインプット — GPX
  document.getElementById('explorer-gpx-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const terrainId = getPendingGpxTerrain();
    setPendingGpxTerrain(null);
    e.target.value = '';
    await loadGpx(file, { terrainId: terrainId ?? null });
  });

  // ファイルインプット — コースデータ（ppen / IOF XML）
  document.getElementById('explorer-json-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const courseImportInput = document.getElementById('course-import-file');
    if (courseImportInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      courseImportInput.files = dt.files;
      courseImportInput.dispatchEvent(new Event('change'));
    }
    renderExplorer();
  });
}

/**
 * explorerRenderer.js — エクスプローラー DOM 描画・右パネル・コンテキストメニュー
 *
 * 担当:
 *   - 右パネルの開閉・コンテンツビルダー
 *   - コンテキストメニュー・追加ポップオーバー
 *   - ワークスペースヘッダー更新
 *   - テレイングリッド/ツリービュー描画
 *   - エクスプローラーツリー DOM 構築（renderExplorerOnce）
 *   - ドラッグ＆ドロップ設定
 *   - インラインリネームヘルパー
 *
 * 使い方: init(map, callbacks) を呼ぶ。
 */

import {
  getWsTerrains, renameWsTerrain, getWsEvents,
  getCourseSetsForEvent, getCoursesBySet, getMapSheetsByEvent, getCourseSetsForTerrain,
  saveWsMapSheet, deleteWsMapSheet,
} from '../../api/workspace-db.js';
import {
  createEvent, loadCourseSet, createCourseSet, setCourseMapVisible,
  setActiveCourse, setCourseTerrainId, addCourseToActiveEvent, deleteCourseById,
  getCoursesSummary, loadEvent, moveCourseSet, getActiveCourseSetId,
  renameEvent, renameCourseSet, renameCourse, flushSave, showAllControlsTab,
} from '../../core/course.js';
import {
  showTerrainDeleteModal, showEventDeleteModal,
  showCourseSetDeleteModal, showCourseDeleteModal,
} from '../../ui/modals/deleteModal.js';
import { localMapLayers, removeLocalMapLayer, toRasterOpacity } from '../../store/localMapStore.js';
import { gpxState } from '../../gpx/gpxState.js';
import { formatMMSS } from '../../gpx/gpxPlayer.js';
import { openSidebarPanel, isSidebarOpen, updateSidebarWidth } from '../../ui/uiState.js';
import { saveUiState, updateShareableUrl } from '../../store/uiStateManager.js';
import { buildTreeData } from '../../ui/tree/treeStore.js';
import { initRenderer, renderItem } from '../../ui/tree/treeRenderer.js';
import { terrainMap } from '../../store/terrainStore.js';
import { updateSliderGradient } from '../../utils/slider.js';
import { escHtml } from '../../utils/dom.js';
import {
  EASE_DURATION, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR, SIDEBAR_DEFAULT_WIDTH,
} from '../../core/config.js';
import {
  getActiveId, setActiveId,
  getCtx, setCtx,
  renameHandlers,
  isCollapsed, setCollapsed,
  getTerrainViewMode, setTerrainViewMode,
  getSelectedTerrain, setSelectedTerrain,
  getFocusTerrain, setFocusTerrain,
  getDndItem, setDndItem,
  getOpenAddPopover, setOpenAddPopover,
} from './explorerState.js';

let _map = null;
let _callbacks = {}; // { renderLocalMapList, renderOtherMapsTree, onRenderExplorer }

/** @param {maplibregl.Map} map @param {{renderLocalMapList, renderOtherMapsTree, onRenderExplorer}} callbacks */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initRightPanel();
  _initTreeRenderer();
}

// ================================================================
// 右パネル
// ================================================================

function _initRightPanel() {
  const RP_W_KEY = 'teledrop-rp-w';
  const RP_W_MIN = 220;
  const RP_W_MAX = 680;

  function _setRpWidth(px) {
    const clamped = Math.min(RP_W_MAX, Math.max(RP_W_MIN, px));
    document.documentElement.style.setProperty('--rp-w', clamped + 'px');
    localStorage.setItem(RP_W_KEY, String(clamped));
  }
  const saved = parseInt(localStorage.getItem(RP_W_KEY), 10);
  if (!isNaN(saved)) _setRpWidth(saved);

  const handle = document.getElementById('rp-resize-handle');
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      document.body.style.cursor = 'w-resize';
      document.body.style.userSelect = 'none';
      const onMove = (ev) => _setRpWidth(window.innerWidth - ev.clientX);
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
  }

  document.getElementById('right-panel-close-btn')?.addEventListener('click', closeRightPanel);
}

export function openRightPanel(title, contentEl) {
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  document.getElementById('right-panel-title').textContent = title ?? '';
  document.getElementById('course-editor-view').style.display = 'none';
  const dynEl = document.getElementById('rp-dynamic-content');
  dynEl.innerHTML = '';
  if (contentEl instanceof HTMLElement) dynEl.appendChild(contentEl);
  panel.classList.add('rp-open');
  document.body.classList.add('rp-open');
}

export function closeRightPanel() {
  document.getElementById('right-panel')?.classList.remove('rp-open');
  document.body.classList.remove('rp-open');
  document.getElementById('course-editor-view').style.display = 'none';
  document.getElementById('rp-dynamic-content').innerHTML = '';
  setCourseMapVisible(false);
  setActiveId(null);
  _callbacks.onRenderExplorer?.();
}

export function openCourseEditor() {
  const panel = document.getElementById('right-panel');
  if (!panel) return;
  document.getElementById('right-panel-title').textContent = 'コース';
  document.getElementById('rp-dynamic-content').innerHTML = '';
  document.getElementById('course-editor-view').style.display = 'block';
  panel.classList.add('rp-open');
  document.body.classList.add('rp-open');
  setCourseMapVisible(true);
}

export function buildMapLayerRightPanel(entry) {
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

  const visChk  = wrap.querySelector(`#rp-vis-${entry.id}`);
  const slider  = wrap.querySelector('.rp-opacity-slider');
  const valSpan = wrap.querySelector('.rp-opacity-val');
  visChk.addEventListener('change', () => {
    entry.visible = visChk.checked;
    slider.disabled = !entry.visible;
    if (_map.getLayer(entry.layerId)) {
      _map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
  });
  updateSliderGradient(slider);
  slider.addEventListener('input', () => {
    entry.opacity = parseInt(slider.value) / 100;
    valSpan.textContent = slider.value + '%';
    updateSliderGradient(slider);
    if (entry.visible && _map.getLayer(entry.layerId)) {
      _map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
  });
  wrap.querySelector(`#rp-fitbounds-${entry.id}`)?.addEventListener('click', () => {
    if (entry.bbox) {
      const b = entry.bbox;
      _map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 600 });
    }
  });
  wrap.querySelector(`#rp-del-${entry.id}`)?.addEventListener('click', () => {
    if (confirm(`「${entry.name}」を削除しますか？`)) {
      removeLocalMapLayer(entry.id);
      closeRightPanel();
      _callbacks.onRenderExplorer?.();
    }
  });
  return wrap;
}

export function buildGpxRightPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'rp-gpx-panel';
  const pts = gpxState.trackPoints.length;
  const dur = gpxState.totalDuration ?? 0;
  const durStr = formatMMSS(dur);
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

  wrap.querySelector('#rp-gpx-play')?.addEventListener('click', () => {
    document.getElementById('play-pause-btn')?.click();
  });
  wrap.querySelector('#rp-gpx-del')?.addEventListener('click', () => {
    if (confirm('GPXトラックを削除しますか？')) {
      gpxState.trackPoints = [];
      gpxState.fileName    = null;
      gpxState.terrainId   = null;
      const src = _map.getSource('gpx-source');
      if (src) src.setData({ type: 'FeatureCollection', features: [] });
      document.getElementById('gpx-status').innerHTML = '';
      closeRightPanel();
      _callbacks.onRenderExplorer?.();
    }
  });
  return wrap;
}

// ================================================================
// コンテキストメニュー
// ================================================================

export function showExplorerCtx(x, y, items) {
  closeExplorerCtx();
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
    btn.className = 'ctx-menu-item' + (item.danger ? ' ctx-menu-danger' : '') + (item.disabled ? ' ctx-menu-disabled' : '');
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => { closeExplorerCtx(); item.action(); });
    }
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  setCtx(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const { width: mw, height: mh } = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top  = Math.min(y, vh - mh - 8) + 'px';
}

export function closeExplorerCtx() {
  getCtx()?.remove();
  setCtx(null);
}

export function showExplorerGpxCtx(x, y, onRename) {
  showExplorerCtx(x, y, [
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
        const src = _map.getSource('gpx-source');
        if (src) src.setData({ type: 'FeatureCollection', features: [] });
        document.getElementById('gpx-status').innerHTML = '';
        _callbacks.onRenderExplorer?.();
      }
    }},
  ]);
}

// ================================================================
// ＋ポップオーバー
// ================================================================

export function showAddPopover(anchorBtn, terrainId) {
  getOpenAddPopover()?.remove();
  setOpenAddPopover(null);
  const menu = buildAddPopoverMenu(terrainId);
  document.body.appendChild(menu);
  setOpenAddPopover(menu);
  const r = anchorBtn.getBoundingClientRect();
  menu.style.top  = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(4, r.right - menu.offsetWidth) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', closeAddPopover, { once: true });
  }, 0);
}

export function showAddPopoverAt(x, y, terrainId) {
  getOpenAddPopover()?.remove();
  setOpenAddPopover(null);
  const menu = buildAddPopoverMenu(terrainId);
  document.body.appendChild(menu);
  setOpenAddPopover(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - menu.offsetWidth - 4) + 'px';
  menu.style.top  = Math.min(y, vh - menu.offsetHeight - 4) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', closeAddPopover, { once: true });
  }, 0);
}

export function closeAddPopover() {
  getOpenAddPopover()?.remove();
  setOpenAddPopover(null);
}

function buildAddPopoverMenu(terrainId) {
  const menu = document.createElement('div');
  menu.className = 'expl-add-popover';
  const SVG_EVENT     = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 01-2-2V5h4"/><path d="M18 9h2a2 2 0 002-2V5h-4"/><path d="M6 9a6 6 0 0012 0"/><path d="M12 15v4"/><path d="M8 19h8"/></svg>`;
  const SVG_COURSESET = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>`;
  const SVG_MAP       = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  const SVG_GPX       = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
  const SVG_FILE      = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

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
    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeAddPopover();
      action();
    });
    menu.appendChild(btn);
  };

  addSection('新規作成');
  addItem(SVG_EVENT, '大会', null, async () => {
    await createEvent(terrainId, '大会');
    await _callbacks.onRenderExplorer?.();
    openCourseEditor();
  });
  addItem(SVG_COURSESET, 'コースセット', null, async () => {
    await createCourseSet(null, terrainId, 'コースセット');
    await _callbacks.onRenderExplorer?.();
    openCourseEditor();
  });
  addSep();
  addSection('ファイルを読み込み');
  addItem(SVG_MAP, '地図画像', 'png / jpg / kmz', () => {
    _callbacks.setPendingImportTerrain?.(terrainId);
    document.getElementById('explorer-map-input')?.click();
  });
  addItem(SVG_GPX, 'GPSログ', 'gpx', () => {
    _callbacks.setPendingGpxTerrain?.(terrainId);
    document.getElementById('explorer-gpx-input')?.click();
  });
  addItem(SVG_FILE, 'コースデータ', 'ppen / IOF XML', () => {
    document.getElementById('explorer-json-input')?.click();
  });
  return menu;
}

// ================================================================
// ワークスペースヘッダー
// ================================================================

export async function updateWsHeader() {
  const backBtn  = document.getElementById('ws-header-back-btn');
  const titleEl  = document.getElementById('ws-header-title');
  const addBtn   = document.getElementById('ws-header-add-btn');
  const moreBtn  = document.getElementById('ws-header-more-btn');
  if (!titleEl) return;
  const selectedTerrain = getSelectedTerrain();
  if (getTerrainViewMode() === 'grid' || !selectedTerrain) {
    titleEl.textContent = 'テレイン一覧';
    titleEl.removeAttribute('data-system');
    if (backBtn) backBtn.style.display = 'none';
    if (addBtn)  addBtn.style.display  = 'none';
    if (moreBtn) moreBtn.style.display = 'none';
  } else {
    let terrainName = selectedTerrain;
    let isSystem = false;
    try {
      const terrains = await getWsTerrains();
      const terrain  = terrains.find(t => t.id === selectedTerrain);
      if (terrain) {
        terrainName = terrain.name;
        isSystem = terrain.source !== 'local';
      }
    } catch { /* ignore */ }
    titleEl.textContent = terrainName;
    titleEl.dataset.system = isSystem ? '1' : '0';
    if (backBtn) backBtn.style.display = '';
    if (addBtn)  addBtn.style.display  = '';
    if (moreBtn) moreBtn.style.display = '';
  }
}

export function showTerrainGridContextMenu(x, y) {
  showExplorerCtx(x, y, [
    { label: '+ ローカルテレインを追加',
      action: () => document.getElementById('add-local-terrain-btn')?.click()
    }
  ]);
}

// ================================================================
// テレインパネル（グリッド／ツリー）
// ================================================================

export function renderTerrainPanelView() {
  const gridView = document.getElementById('panel-terrain-view-grid');
  const treeView = document.getElementById('panel-terrain-view-tree');
  if (getTerrainViewMode() === 'grid') {
    if (gridView) gridView.style.display = '';
    if (treeView) treeView.style.display = 'none';
    renderTerrainGridView();
  } else {
    if (gridView) gridView.style.display = 'none';
    if (treeView) treeView.style.display = 'flex';
    renderTerrainTreeView();
  }
  updateWsHeader();
}

export function switchTerrainViewMode(mode, terrainId = null) {
  setTerrainViewMode(mode);
  if (mode === 'tree' && terrainId) setSelectedTerrain(terrainId);
  renderTerrainPanelView();
}

export function backToTerrainGrid() {
  setTerrainViewMode('grid');
  setSelectedTerrain(null);
  renderTerrainPanelView();
}

export async function renderTerrainGridView() {
  const container = document.getElementById('terrain-grid-container');
  if (!container) return;
  container.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--text-muted);font-size:11px;">読み込み中…</div>';
  let terrains = [];
  try { terrains = await getWsTerrains(); } catch { /* ignore */ }
  container.innerHTML = '';
  if (terrains.length === 0) {
    container.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--text-muted);">テレインを追加すると表示されます</div>';
    return;
  }
  const terrainDataList = await Promise.all(terrains.map(async terrain => {
    let eventCount = 0;
    try { const events = await getWsEvents(terrain.id); eventCount = events.length; } catch { /* ignore */ }
    return { terrain, eventCount };
  }));
  terrainDataList.forEach(({ terrain, eventCount }) => {
    const card = document.createElement('div');
    card.className = 'terrain-card';
    card.innerHTML = `
      <div class="terrain-card-thumb"></div>
      <div class="terrain-card-info">
        <div class="terrain-card-name">${terrain.name}</div>
        <div class="terrain-card-meta">${eventCount} 大会</div>
      </div>
      <button class="terrain-card-menu-btn" data-terrain-id="${terrain.id}" title="オプション" aria-label="オプション">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg>
      </button>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.terrain-card-menu-btn')) return;
      switchTerrainViewMode('tree', terrain.id);
    });
    card.querySelector('.terrain-card-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      showExplorerCtx(r.right + 4, r.top, [
        { label: 'この場所へ移動', action: () => {
            if (terrain.center) _map.easeTo({ center: terrain.center, zoom: Math.max(_map.getZoom(), 12), duration: EASE_DURATION });
          }
        },
        { separator: true },
        { label: 'ワークスペースから削除', danger: true, action: () => showTerrainDeleteModal(terrain.id) },
      ]);
    });
    container.appendChild(card);
  });
}

function renderTerrainTreeView() {
  _callbacks.onRenderExplorer?.();
}

// ================================================================
// エクスプローラーツリー
// ================================================================

export async function renderExplorerOnce() {
  const treeEl = document.getElementById('explorer-tree');
  if (!treeEl) return;

  let wsTerrains = [];
  try { wsTerrains = await getWsTerrains(); } catch { /* ignore */ }

  const focusId = getFocusTerrain();
  setFocusTerrain(null);

  async function fetchEventsWithSheetsAndCourseSets(terrainId) {
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
    let standaloneSets = [];
    if (terrainId != null) {
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

  const selectedTerrain = getSelectedTerrain();
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

  const uncatMaps  = localMapLayers.filter(e => !e.terrainId && !e.mapSheetId);
  const uncatGpx   = (gpxState.fileName && !gpxState.terrainId) ? gpxState : null;
  const { eventsData: uncatEvents } = await fetchEventsWithSheetsAndCourseSets(null);

  const frag = document.createDocumentFragment();
  const treeItems = buildTreeData({
    terrainData,
    uncatMaps,
    uncatGpx,
    uncatEvents: uncatEvents ?? [],
    selectedTerrainId: selectedTerrain,
  });

  if (selectedTerrain) {
    treeItems.forEach(item => frag.appendChild(renderItem(item)));
    if (treeItems.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'expl-ws-hint';
      hint.innerHTML = '<span>「＋」ボタンで大会やコースを追加できます</span>';
      frag.appendChild(hint);
    }
  } else {
    treeItems.forEach(item => {
      const el = renderItem(item);
      if (item.type === 'terrain' && focusId === item.id) {
        el.classList.add('is-focused');
        requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
      frag.appendChild(el);
    });
  }

  if (!selectedTerrain && wsTerrains.length === 0 && uncatMaps.length === 0 && !uncatGpx && uncatEvents.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'expl-ws-hint';
    hint.innerHTML = '<span>検索タブでテレインを探し「＋」で追加すると<br>ここにフォルダが作成されます</span>';
    frag.appendChild(hint);
  }

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

  treeEl.innerHTML = '';
  treeEl.appendChild(frag);
}

// ================================================================
// ドラッグ＆ドロップ
// ================================================================

export function setupFolderDropTarget(folder, terrainId) {
  folder.addEventListener('dragover', e => {
    if (!getDndItem()) return;
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
    const item = getDndItem();
    if (!item) return;
    const { type, id } = item;
    setDndItem(null);
    if (type === 'map') {
      const entry = localMapLayers.find(m => m.id === id);
      if (entry) entry.terrainId = terrainId;
    } else if (type === 'gpx') {
      gpxState.terrainId = terrainId;
    } else if (type === 'courseSet') {
      await moveCourseSet(id, { eventId: null, terrainId: terrainId ?? null });
    }
    await _callbacks.onRenderExplorer?.();
  });
}

export function makeDraggable(el, item) {
  el.draggable = true;
  el.classList.add('expl-draggable');
  el.addEventListener('dragstart', e => {
    setDndItem(item);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.type + ':' + item.id);
    el.classList.add('is-dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('is-dragging');
    setDndItem(null);
    document.querySelectorAll('.dnd-over').forEach(f => f.classList.remove('dnd-over'));
  });
}

// ================================================================
// インラインリネーム
// ================================================================

export function startInlineRename(lbl, current, onCommit) {
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

// ================================================================
// イベントコントロール flyTo
// ================================================================

export function flyToEventControls(event) {
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
    _map.easeTo({ center: [minLng, minLat], zoom: Math.max(_map.getZoom(), 15), duration: EASE_DURATION });
  } else {
    _map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
      padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                 left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
      duration: EASE_DURATION, maxZoom: 18,
    });
  }
}

// ================================================================
// treeRenderer 初期化
// ================================================================

function _initTreeRenderer() {
  initRenderer({
    collapsed: {
      get: key  => isCollapsed(key),
      set: (key, val) => { setCollapsed(key, val); },
    },
    activeId: {
      get: ()  => getActiveId(),
      set: val => setActiveId(val),
    },
    renameHandlers,
    dnd: {
      get:   () => getDndItem(),
      set:   v  => setDndItem(v),
      clear: () => setDndItem(null),
    },
    startInlineRename,
    showCtx:            showExplorerCtx,
    showExplorerGpxCtx,
    makeDraggable,
    setupFolderDropTarget,
    renderExplorer:     () => _callbacks.onRenderExplorer?.(),
    openCourseEditor,
    openRightPanel,
    buildMapLayerRightPanel: buildMapLayerRightPanel,
    buildGpxRightPanel,
    showTerrainDeleteModal,
    showEventDeleteModal,
    showCourseSetDeleteModal,
    showCourseDeleteModal,
    renameEvent,
    createCourseSet,
    moveCourseSet,
    renameCourseSet,
    renameCourse,
    saveWsMapSheet,
    deleteWsMapSheet,
    removeLocalMapLayer,
    flushSave,
    loadCourseSet,
    getActiveCourseSetId,
    setActiveCourse,
    addCourseToActiveEvent,
    deleteCourseById,
    getCoursesSummary,
    showAllControlsTab,
    flyToEventControls,
    map: _map,
    renderOtherMapsTree: () => _callbacks.renderOtherMapsTree?.(),
    EASE_DURATION,
    FIT_BOUNDS_PAD,
    FIT_BOUNDS_PAD_SIDEBAR,
    SIDEBAR_DEFAULT_WIDTH,
  });
}

/** initRenderer に map を渡す遅延設定（init 後に呼ぶ） */
export function getMap() { return _map; }

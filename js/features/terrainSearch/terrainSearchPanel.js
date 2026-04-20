/**
 * terrainSearchPanel.js — テレイン検索 UI
 *
 * 担当:
 *   - 検索バー入力（デバウンス）・チップフィルター
 *   - 検索結果カードリスト描画（renderTerrainSearchResults）
 *   - ワークスペーステレイン一覧描画（renderWorkspaceTerrainList）
 *   - sidebar:panelChanged で 'terrain' タブ開時に自動再検索
 *
 * 使い方:
 *   1. init(map, callbacks) を app 起動直後に呼ぶ（map.on('load') より前）
 *   2. syncSearchLayer() を map.on('load') 内 initTerrainLayers() の直後に呼ぶ
 */

import { searchTerrainsApi, updateSearchTerrainSource, setHoverTerrain } from '../../core/terrainSearch.js';
import {
  getWsTerrains, saveWsTerrain, deleteWsTerrain, updateWsTerrainVisibility,
} from '../../api/workspace-db.js';
import { on } from '../../store/eventBus.js';
import { escHtml } from '../../utils/dom.js';
import { EASE_DURATION } from '../../core/config.js';

const MAP_TYPE_JA = { sprint: 'スプリント', forest: 'フォレスト' };

let _map      = null;
let _callbacks = {};  // { onTerrainNavigate(terrainId) }
let _lastResults = null;
let _runSearch   = null;

/**
 * @param {maplibregl.Map} map
 * @param {{ onTerrainNavigate: (terrainId: string) => void }} callbacks
 */
export function init(map, callbacks) {
  _map       = map;
  _callbacks = callbacks;
  _initSearchUI();
}

/** map.on('load') 内で initTerrainLayers() の直後に呼ぶ */
export function syncSearchLayer() {
  if (_lastResults && _map) updateSearchTerrainSource(_map, _lastResults);
}

/** 外部からの検索トリガー（sidebar:panelChanged 経由） */
export function runSearch() {
  _runSearch?.();
}

// ================================================================
// 検索 UI 初期化
// ================================================================

function _initSearchUI() {
  let _searchTimer = null;
  let _activeType  = '';

  async function _doSearch() {
    const q   = (document.getElementById('catalog-search')?.value ?? '').trim();
    const res = document.getElementById('terrain-search-results');
    if (!res) return;

    res.innerHTML = '<div class="terrain-search-loading">検索中…</div>';

    const results = await searchTerrainsApi(q, { types: _activeType ? [_activeType] : [] });
    _lastResults = results;
    if (_map?.loaded()) updateSearchTerrainSource(_map, results);
    renderTerrainSearchResults(results);
  }

  // 検索バー（デバウンス 300ms）
  document.getElementById('catalog-search')?.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(_doSearch, 300);
  });

  // チップフィルター
  document.querySelectorAll('.map-type-chips .type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      _activeType = chip.dataset.type;
      document.querySelectorAll('.map-type-chips .type-chip')
        .forEach(c => c.classList.toggle('active', c.dataset.type === _activeType));
      _doSearch();
    });
  });

  // sidebar:panelChanged — terrain タブ開時に再検索
  on('sidebar:panelChanged', ({ panelId, open }) => {
    if (open && panelId === 'terrain') _doSearch();
  });

  _runSearch = _doSearch;

  // 初回検索（マップロードを待たずに即実行）
  _doSearch();
}

// ================================================================
// 検索結果描画
// ================================================================

async function renderTerrainSearchResults(terrains) {
  const res = document.getElementById('terrain-search-results');
  if (!res) return;
  res.innerHTML = '';

  if (terrains.length === 0) {
    res.innerHTML = '<div class="terrain-search-empty">該当するテレインが見つかりません</div>';
    return;
  }

  const wsTerrains  = await getWsTerrains();
  const wsPublicIds = new Set(wsTerrains.filter(t => t.source === 'public').map(t => t.id));

  terrains.forEach(t => {
    const card    = document.createElement('div');
    const isLocal = t.source === 'local';
    card.className = 'terrain-card' + (isLocal ? ' terrain-card-local' : '');

    const typeKey       = t.type ?? 'other';
    const typeLabelText = MAP_TYPE_JA[typeKey] ?? typeKey;
    const prefText      = t.prefecture ? escHtml(t.prefecture) : '';

    const sourceBadgeHtml = isLocal
      ? '<span class="terrain-source-badge terrain-source-local">ローカル</span>'
      : '<span class="terrain-source-badge terrain-source-public">公式</span>';

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

    card.addEventListener('mouseenter', () => { card.classList.add('hovered'); setHoverTerrain(_map, t.id); });
    card.addEventListener('mouseleave', () => { card.classList.remove('hovered'); setHoverTerrain(_map, null); });
    card.addEventListener('click', e => {
      if (e.target.closest('.terrain-add-btn')) return;
      if (t.center) _map?.easeTo({ center: t.center, zoom: Math.max(_map.getZoom(), 12), duration: EASE_DURATION });
    });

    const actionBtn = card.querySelector('.terrain-add-btn');
    if (isLocal) {
      actionBtn?.addEventListener('click', () => _callbacks.onTerrainNavigate?.(t.id));
    } else {
      actionBtn?.addEventListener('click', async () => {
        if (actionBtn.disabled) return;
        await saveWsTerrain({ ...t, source: 'public', visible: true });
        actionBtn.disabled = true;
        actionBtn.textContent = '追加済';
        const wsAll = await getWsTerrains();
        updateWorkspaceTerrainSource(_map, wsAll);
        _callbacks.onTerrainNavigate?.(t.id);
      });
    }

    res.appendChild(card);
  });
}

// ================================================================
// ワークスペーステレイン一覧描画
// ================================================================

export async function renderWorkspaceTerrainList() {
  const listEl = document.getElementById('workspace-terrain-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const terrains = await getWsTerrains();
  if (terrains.length === 0) {
    listEl.innerHTML = '<div class="tree-empty-hint">検索結果の「＋」でテレインを追加</div>';
    return;
  }

  terrains.forEach(t => {
    const row      = document.createElement('div');
    const isVisible = t.visible !== false;
    row.className  = 'ws-terrain-row' + (isVisible ? '' : ' hidden-terrain');

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

    row.querySelector('.ws-terrain-eye').addEventListener('click', async () => {
      const newVis = t.visible === false;
      await updateWsTerrainVisibility(t.id, newVis);
      t.visible = newVis;
      const all = await getWsTerrains();
      updateWorkspaceTerrainSource(_map, all);
      renderWorkspaceTerrainList();
    });

    row.querySelector('.ws-terrain-fly').addEventListener('click', () => {
      if (t.center) _map?.easeTo({ center: t.center, zoom: Math.max(_map.getZoom(), 12), duration: EASE_DURATION });
    });

    row.querySelector('.ws-terrain-del').addEventListener('click', async () => {
      await deleteWsTerrain(t.id);
      const all = await getWsTerrains();
      updateWorkspaceTerrainSource(_map, all);
      renderWorkspaceTerrainList();
    });

    listEl.appendChild(row);
  });
}

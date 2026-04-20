/**
 * layersPanel.js — レイヤーパネル（2画面ナビゲーション）
 *
 * 担当:
 *   - List view  : お気に入りテレイン + レイヤーがあるテレインの一覧
 *   - Detail view: 選択テレインのクイックアクション + レイヤーリスト
 *   - _favTerrains の永続化（localStorage）
 *
 * 使い方: init(map, callbacks) を呼んだ後、各公開関数を使う。
 */

import { localMapLayers, toRasterOpacity, removeLocalMapLayer } from '../../store/localMapStore.js';
import { clearAllMapLayers, updateMapLayerState, estimateStorageUsage } from '../../api/mapImageDb.js';
import { gpxState } from '../gpx/gpxState.js';
import { terrainMap } from '../../store/terrainStore.js';
import { openSidebarPanel } from '../../store/uiState.js';
import { updateSliderGradient } from '../../utils/slider.js';

let _map = null;
let _callbacks = {};

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

/**
 * レイヤータブを開いて指定テレインの詳細へ遷移する。
 * terrainId を省略すると一覧に戻る。
 * @param {string|null|undefined} terrainId
 */
export function openLayersPanel(terrainId) {
  openSidebarPanel('layers');
  if (terrainId !== undefined) {
    showLayersDetail(terrainId);
  } else {
    showLayersList();
  }
}

/** レイヤーパネルを一覧ビューに切り替えて再描画する */
export function showLayersList() {
  _layersView = 'list';
  const listEl   = document.getElementById('layers-view-list');
  const detailEl = document.getElementById('layers-view-detail');
  if (listEl)   listEl.style.display   = '';
  if (detailEl) detailEl.style.display = 'none';
  _renderLayersList();
}

/** レイヤーパネルを詳細ビューに切り替えて再描画する */
export function showLayersDetail(terrainId) {
  _layersView     = 'detail';
  _layersDetailId = terrainId ?? null;
  const listEl   = document.getElementById('layers-view-list');
  const detailEl = document.getElementById('layers-view-detail');
  if (listEl)   listEl.style.display   = 'none';
  if (detailEl) detailEl.style.display = '';
  _renderLayersDetail(_layersDetailId);
}

/** 現在のビュー状態に合わせて再描画する */
export function renderLayersPanel() {
  if (_layersView === 'detail') {
    _renderLayersDetail(_layersDetailId);
  } else {
    _renderLayersList();
  }
}

/**
 * @param {maplibregl.Map} map
 * @param {{ onStorageClear: () => void }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initListeners();
}

// ---- List view: テレインフォルダ一覧 ----
function _renderLayersList() {
  const listEl = document.getElementById('layers-view-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const terrainIdsWithLayers = new Set(localMapLayers.map(e => e.terrainId));
  const hasUncategorized = terrainIdsWithLayers.has(null);
  const hasGpx = gpxState.trackPoints.length > 0;

  const allIds = new Set([..._favTerrains]);
  terrainIdsWithLayers.forEach(id => { if (id !== null) allIds.add(id); });

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

    const starBtn = document.createElement('button');
    starBtn.className = 'layers-list-star' + (isFav ? ' active' : '');
    starBtn.title = isFav ? 'お気に入りから削除' : 'お気に入りに追加';
    starBtn.setAttribute('aria-label', isFav ? 'お気に入りから削除' : 'お気に入りに追加');
    starBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'layers-list-name';
    nameSpan.textContent = terrainName;

    const badge = document.createElement('span');
    badge.className = 'layers-list-badge';
    badge.textContent = layerCount;

    const arrow = document.createElement('span');
    arrow.className = 'layers-list-arrow';
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';

    item.appendChild(starBtn);
    item.appendChild(nameSpan);
    item.appendChild(badge);
    item.appendChild(arrow);
    listEl.appendChild(item);

    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.layers-list-star')) return;
      showLayersDetail(tid);
    });
    item.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') showLayersDetail(tid);
    });

    starBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _toggleFavTerrain(tid);
      _renderLayersList();
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

// ---- Detail view: テレイン詳細 ----
function _renderLayersDetail(tid) {
  const body = document.getElementById('layers-detail-body');
  const titleEl = document.getElementById('layers-detail-title');
  const favBtn  = document.getElementById('layers-fav-btn');
  const favIcon = document.getElementById('layers-fav-icon');
  if (!body) return;

  const terrainName = (tid === null)
    ? '未分類'
    : (terrainMap.get(tid)?.name ?? tid ?? '未選択');

  if (titleEl) titleEl.textContent = terrainName;

  if (favBtn) {
    favBtn.style.display = (tid === null) ? 'none' : '';
    if (tid !== null && favIcon) {
      const isFav = _favTerrains.has(tid);
      favIcon.setAttribute('fill', isFav ? 'currentColor' : 'none');
      favBtn.title = isFav ? 'お気に入りから削除' : 'お気に入りに追加';
      favBtn.classList.toggle('active', isFav);
    }
  }

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

  if (hasGpx) {
    body.appendChild(_makeGpxDetailItem());
  }
}

// ---- リスト用 GPX アイテム ----
function _makeGpxListItem() {
  const item = document.createElement('div');
  item.className = 'layers-list-item layers-list-item--gpx';

  const icon = document.createElement('span');
  icon.className = 'layers-list-folder-icon';
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  const gpxVis = _map.getLayer('gpx-track')
    ? _map.getLayoutProperty('gpx-track', 'visibility') !== 'none' : true;

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
      if (_map.getLayer(lid)) _map.setLayoutProperty(lid, 'visibility', vis);
    });
  });

  return item;
}

// ---- 詳細ビュー内 GPX アイテム ----
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

  const gpxVis = _map.getLayer('gpx-track')
    ? _map.getLayoutProperty('gpx-track', 'visibility') !== 'none' : true;

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
      if (_map.getLayer(lid)) _map.setLayoutProperty(lid, 'visibility', vis);
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

  chk.addEventListener('change', () => {
    entry.visible = chk.checked;
    name.classList.toggle('disabled', !entry.visible);
    slider.disabled = !entry.visible;
    if (_map.getLayer(entry.layerId)) {
      _map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
    if (entry.dbId != null) {
      updateMapLayerState(entry.dbId, { visible: entry.visible }).catch(() => {});
    }
    const masterChk = document.getElementById(`chk-kmz-${entry.id}`);
    if (masterChk) masterChk.checked = entry.visible;
  });

  updateSliderGradient(slider);
  slider.addEventListener('input', () => {
    entry.opacity = parseInt(slider.value) / 100;
    valSpan.textContent = slider.value + '%';
    updateSliderGradient(slider);
    if (entry.visible && _map.getLayer(entry.layerId)) {
      _map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
    if (entry.dbId != null) {
      updateMapLayerState(entry.dbId, { opacity: entry.opacity }).catch(() => {});
    }
    const masterSlider = document.getElementById(`slider-kmz-${entry.id}`);
    if (masterSlider) { masterSlider.value = slider.value; updateSliderGradient(masterSlider); }
    const masterVal = document.getElementById(`val-kmz-${entry.id}`);
    if (masterVal) masterVal.textContent = slider.value + '%';
  });

  delBtn.addEventListener('click', () => {
    removeLocalMapLayer(entry.id);
  });

  return item;
}

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

// ---- イベントリスナー初期化（内部）----
function _initListeners() {
  // 戻るボタン
  document.getElementById('layers-back-btn')?.addEventListener('click', () => {
    showLayersList();
  });

  // お気に入りボタン（ヘッダー右端）
  document.getElementById('layers-fav-btn')?.addEventListener('click', () => {
    if (_layersDetailId === null) return;
    _toggleFavTerrain(_layersDetailId);
    _renderLayersDetail(_layersDetailId);
    _renderLayersList();
  });

  // クイックアクションボタン
  document.getElementById('layers-qa-image')?.addEventListener('click', () => {
    const input = document.getElementById('map-import-input-top');
    if (input) input.click();
  });

  document.getElementById('layers-qa-gpx')?.addEventListener('click', () => {
    const input = document.getElementById('gpx-file-input');
    if (input) input.click();
  });

  document.getElementById('layers-qa-course')?.addEventListener('click', () => {
    openSidebarPanel('course');
  });

  // ストレージ全消去ボタン
  document.getElementById('storage-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('ストレージに保存されたすべての地図を削除しますか？\n地図の表示データは失われます。')) return;
    try {
      await clearAllMapLayers();
      const toRemove = localMapLayers.filter(e => e.dbId != null).map(e => e.id);
      for (const id of toRemove) removeLocalMapLayer(id);
      _updateStorageInfoBar();
      _callbacks.onStorageClear?.();
    } catch (e) {
      console.error('ストレージ消去エラー:', e);
      alert('ストレージの消去に失敗しました。');
    }
  });
}

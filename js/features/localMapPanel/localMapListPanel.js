/**
 * localMapListPanel.js — ローカル地図レイヤー一覧 UI
 *
 * 担当:
 *   - renderOtherMapsTree()  — 「その他の地図」ツリーノード描画
 *   - renderLocalMapList()   — KMZ/画像レイヤーリスト描画（レガシーパネル）
 *   - updateStorageInfoBar() — ストレージ使用量バー更新
 *   - 地図インポートボタン / ドロップターゲット イベントリスナー登録
 *
 * 使い方: init(map, callbacks) を map.on('load') 内で呼ぶ。
 */

import { localMapLayers, removeLocalMapLayer, toRasterOpacity } from '../../store/localMapStore.js';
import { updateMapLayerState, estimateStorageUsage } from '../../api/mapImageDb.js';
import { openImportModal, openImportModalFromKmz } from '../../ui/modals/importModal.js';
import { updateSliderGradient } from '../../utils/slider.js';
import {
  EASE_DURATION, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR, SIDEBAR_DEFAULT_WIDTH,
} from '../../core/config.js';

let _map = null;
let _callbacks = {}; // { updateReadmapBgKmzOptions, renderSimReadmapList }

/**
 * @param {maplibregl.Map} map
 * @param {{ updateReadmapBgKmzOptions: Function, renderSimReadmapList: Function }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initImportListeners();
}

// ================================================================
// 公開 API
// ================================================================

/** 「その他の地図」ツリーノード（#frame-tree-other-children）を再描画する */
export function renderOtherMapsTree() {
  const otherEl = document.getElementById('frame-tree-other-children');
  if (!otherEl) return;
  otherEl.innerHTML = '';

  if (localMapLayers.length === 0) {
    updateStorageInfoBar();
    return;
  }

  localMapLayers.forEach(entry => {
    const shortName = entry.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');

    const childEl = document.createElement('div');
    childEl.className = 'tree-child-item';

    const iconSpan = document.createElement('span');
    iconSpan.textContent = '🗺️';
    childEl.appendChild(iconSpan);

    if (entry.dbId != null) {
      const badge = document.createElement('span');
      badge.className = 'tree-saved-badge';
      badge.title = 'ストレージに保存済み（次回起動時も表示されます）';
      badge.textContent = '💾';
      childEl.appendChild(badge);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-child-name';
    nameSpan.title = entry.name;
    nameSpan.textContent = shortName;
    nameSpan.addEventListener('click', () => {
      if (entry.bbox) {
        const pw = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
        _map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                       left: pw + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
            duration: EASE_DURATION }
        );
      }
    });
    childEl.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'tree-child-del-btn';
    delBtn.title = 'この地図を削除';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeLocalMapLayer(entry.id);
    });
    childEl.appendChild(delBtn);

    otherEl.appendChild(childEl);
    otherEl.appendChild(_makeLayerCtrlRow(
      entry.visible !== false,
      Math.round((entry.opacity ?? 0.8) * 100),
      (visible) => {
        entry.visible = visible;
        if (_map.getLayer(entry.layerId)) {
          _map.setPaintProperty(entry.layerId, 'raster-opacity',
            visible ? toRasterOpacity(entry.opacity) : 0);
        }
        if (entry.dbId != null) updateMapLayerState(entry.dbId, { visible }).catch(() => {});
      },
      (pct) => {
        entry.opacity = pct / 100;
        if (_map.getLayer(entry.layerId) && entry.visible !== false) {
          _map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
        }
        if (entry.dbId != null) updateMapLayerState(entry.dbId, { opacity: entry.opacity }).catch(() => {});
      }
    ));
  });

  updateStorageInfoBar();
}

/** KMZ レイヤーリスト（#kmz-list）を再描画する */
export function renderLocalMapList() {
  const listEl = document.getElementById('kmz-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  _callbacks.updateReadmapBgKmzOptions?.();

  if (localMapLayers.length === 0) {
    _callbacks.renderSimReadmapList?.();
    return;
  }

  localMapLayers.forEach(entry => {
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
        <button class="kmz-del-btn" title="削除" data-id="${entry.id}">✕</button>
      </div>
      <div class="opacity-row">
        <input type="range" class="ui-slider" id="slider-kmz-${entry.id}" min="0" max="100" step="5" value="${pct}" ${entry.visible ? '' : 'disabled'} />
        <span class="opacity-val" id="val-kmz-${entry.id}">${pct}%</span>
      </div>`;
    listEl.appendChild(rowEl);

    rowEl.querySelector('.kmz-del-btn').addEventListener('click', () => removeLocalMapLayer(entry.id));

    rowEl.querySelector(`#chk-kmz-${entry.id}`).addEventListener('change', e => {
      entry.visible = e.target.checked;
      const label  = rowEl.querySelector('.layer-name');
      const slider = rowEl.querySelector(`#slider-kmz-${entry.id}`);
      label.classList.toggle('disabled', !entry.visible);
      slider.disabled = !entry.visible;
      if (_map.getLayer(entry.layerId)) {
        _map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
      }
    });

    const sliderEl = rowEl.querySelector(`#slider-kmz-${entry.id}`);
    const valEl    = rowEl.querySelector(`#val-kmz-${entry.id}`);
    updateSliderGradient(sliderEl);
    sliderEl.addEventListener('input', () => {
      entry.opacity = parseInt(sliderEl.value) / 100;
      valEl.textContent = sliderEl.value + '%';
      updateSliderGradient(sliderEl);
      if (entry.visible && _map.getLayer(entry.layerId)) {
        _map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
      }
    });
  });

  _callbacks.renderSimReadmapList?.();
}

/** ストレージ情報バー（#storage-info-bar）の表示と使用量テキストを更新する */
export function updateStorageInfoBar() {
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

// ================================================================
// 内部ヘルパー
// ================================================================

/**
 * 可視トグル＋不透明度スライダー行を生成して返す
 * @param {boolean}          visible  初期可視状態
 * @param {number}           pct      初期不透明度 0–100
 * @param {(v:boolean)=>void} onVis   可視変更コールバック
 * @param {(p:number)=>void}  onOpacity 不透明度変更コールバック（0–100）
 * @returns {HTMLElement}
 */
function _makeLayerCtrlRow(visible, pct, onVis, onOpacity) {
  const row = document.createElement('div');
  row.className = 'layer-ctrl-row';

  row.innerHTML = `
    <label class="toggle-switch">
      <input type="checkbox" class="lc-vis-chk" ${visible ? 'checked' : ''} />
      <span class="toggle-slider"></span>
    </label>
    <input type="range" class="ui-slider lc-opacity-slider" min="0" max="100" step="5" value="${pct}" ${visible ? '' : 'disabled'} />
    <span class="lc-opacity-val">${pct}%</span>`;

  const chk    = row.querySelector('.lc-vis-chk');
  const slider = row.querySelector('.lc-opacity-slider');
  const valEl  = row.querySelector('.lc-opacity-val');

  updateSliderGradient(slider);

  chk.addEventListener('change', () => {
    slider.disabled = !chk.checked;
    onVis(chk.checked);
  });

  slider.addEventListener('input', () => {
    valEl.textContent = slider.value + '%';
    updateSliderGradient(slider);
    onOpacity(parseInt(slider.value));
  });

  return row;
}

/** 地図インポートボタン／ドロップターゲット リスナー登録 */
function _initImportListeners() {
  const mapImportInputTop = document.getElementById('map-import-input-top');
  document.getElementById('map-import-btn-top')?.addEventListener('click', () => mapImportInputTop?.click());
  mapImportInputTop?.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (/\.kmz$/i.test(file.name)) await openImportModalFromKmz(file);
      else if (/\.(jpe?g|png)$/i.test(file.name)) openImportModal(file);
    }
    e.target.value = '';
  });

  const dropTarget = document.getElementById('other-maps-drop-target');
  if (dropTarget) {
    dropTarget.addEventListener('dragover', e => { e.preventDefault(); dropTarget.classList.add('drag-over'); });
    dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('drag-over'));
    dropTarget.addEventListener('drop', async e => {
      e.preventDefault();
      dropTarget.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => /\.(jpe?g|png|kmz)$/i.test(f.name));
      for (const file of files) {
        if (/\.kmz$/i.test(file.name)) await openImportModalFromKmz(file);
        else openImportModal(file);
      }
    });
  }
}

/**
 * basemapController.js — ベースマップ切り替え制御
 *
 * 担当:
 *   - currentBasemap 状態管理
 *   - oriLibreLayers / oriLibreCachedStyle の保持
 *   - switchBasemap(key) — setStyle 不使用・visibility 切り替えのみ
 *   - ベースマップカードのクリックイベント
 *
 * 使い方: init(map, { updateCsVisibility }) を map.on('load') 内で呼ぶ。
 */

import { BASEMAPS } from './config.js';
import { updateBasemapAttribution } from './attribution.js';
import { saveUiState, updateShareableUrl } from '../store/uiStateManager.js';

let _map = null;
let _callbacks = {};

let _currentBasemap = 'orilibre';
let _oriLibreLayers = [];
let _oriLibreCachedStyle = null;

export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initListeners();
}

export function getCurrentBasemap() { return _currentBasemap; }

export function getOriLibreLayers() { return _oriLibreLayers; }
export function setOriLibreLayers(layers) { _oriLibreLayers = layers; }
export function addOriLibreLayer(layer) { _oriLibreLayers.push(layer); }

export function getOriLibreCachedStyle() { return _oriLibreCachedStyle; }
export function setOriLibreCachedStyle(style) { _oriLibreCachedStyle = style; }

export function switchBasemap(key) {
  _currentBasemap = key;

  // ① すべてのベースマップレイヤーを非表示
  Object.keys(BASEMAPS).filter(k => BASEMAPS[k].url).forEach(k => {
    if (_map.getLayer(k + '-layer')) _map.setLayoutProperty(k + '-layer', 'visibility', 'none');
  });
  _oriLibreLayers.forEach(({ id }) => {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', 'none');
  });
  if (_map.getLayer('basemap-fallback-layer')) {
    _map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'none');
  }

  // ② 選択されたベースマップのレイヤーを表示
  if (key === 'orilibre') {
    _oriLibreLayers.forEach(({ id, defaultVisibility }) => {
      if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', defaultVisibility);
    });
    if (_map.getLayer('basemap-fallback-layer')) {
      _map.setLayoutProperty('basemap-fallback-layer', 'visibility', 'visible');
    }
  } else if (!key.startsWith('cs-')) {
    if (_map.getLayer(key + '-layer')) _map.setLayoutProperty(key + '-layer', 'visibility', 'visible');
  }

  // ③ backgroundレイヤーの色を切り替えて常に表示
  const bgLayer = _oriLibreLayers.find(l => l.id.endsWith('-background'));
  if (bgLayer && _map.getLayer(bgLayer.id)) {
    const bgColor = key === 'orilibre' ? bgLayer.origBgColor : (BASEMAPS[key]?.bgColor ?? '#ffffff');
    _map.setPaintProperty(bgLayer.id, 'background-color', bgColor);
    _map.setLayoutProperty(bgLayer.id, 'visibility', 'visible');
  }

  _callbacks.updateCsVisibility?.();
  updateBasemapAttribution();
}

function _initListeners() {
  document.getElementById('basemap-cards')?.addEventListener('click', (e) => {
    const card = e.target.closest('.bm-card');
    if (!card) return;
    document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    switchBasemap(card.dataset.key);
    updateShareableUrl();
    saveUiState();
  });
}

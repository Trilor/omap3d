/**
 * contourController.js — 等高線 UI 制御
 *
 * 担当:
 *   - 等高線タイルの切り替え（applyContourInterval）
 *   - ズームに応じた自動間隔更新（updateContourAutoInterval）
 *   - 等高線カード・DEM セレクト・間隔セレクトのイベントリスナー
 *
 * 使い方: init(map, callbacks) を map.on('load') 内の早い段階（restoreUiState より前）で呼ぶ。
 */

import {
  buildContourTileUrl, buildSeamlessContourTileUrl, buildDem1aContourTileUrl,
  setAllContourVisibility, contourState,
} from './contours.js';
import { saveUiState, updateShareableUrl } from '../store/uiStateManager.js';

let _map = null;
let _callbacks = {};

let _userContourInterval = 5;
let _lastAppliedContourInterval = null;

/**
 * @param {maplibregl.Map} map
 * @param {{
 *   getCurrentOverlay: () => string,
 *   updateCsVisibility: () => void,
 * }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initListeners();
}

export function getUserContourInterval() { return _userContourInterval; }
export function setUserContourInterval(v) { _userContourInterval = v; }
export function getLastAppliedContourInterval() { return _lastAppliedContourInterval; }

// 等高線タイルを intervalM に切り替える（旧タイルをフラッシュしてから URL を更新）
export function applyContourInterval(intervalM) {
  const contourCard = document.getElementById('contour-card');
  const newUrl      = buildContourTileUrl(intervalM);
  const newUrlDem5a = buildSeamlessContourTileUrl(intervalM);
  const newUrlDem1a = buildDem1aContourTileUrl(intervalM);
  // 各ソースを個別にチェック（1つが未登録でも他のソースは更新し続ける）
  const hasQchizu = newUrl      && _map.getSource('contour-source');
  const hasDem5a  = newUrlDem5a && _map.getSource('contour-source-dem5a');
  const hasDem1a  = newUrlDem1a && _map.getSource('contour-source-dem1a');
  if (!hasQchizu && !hasDem5a && !hasDem1a) return;
  // 空配列を一度セットしてから新 URL をセットすることで
  // MapLibre のタイルキャッシュを確実にフラッシュしてタイル再取得を強制する
  if (hasQchizu) { _map.getSource('contour-source').setTiles([]); _map.getSource('contour-source').setTiles([newUrl]); }
  if (hasDem5a)  { _map.getSource('contour-source-dem5a').setTiles([]); _map.getSource('contour-source-dem5a').setTiles([newUrlDem5a]); }
  if (hasDem1a)  { _map.getSource('contour-source-dem1a').setTiles([]); _map.getSource('contour-source-dem1a').setTiles([newUrlDem1a]); }
  // 初期 visibility:none で追加されるため visible に設定する（フリック防止のため none は経由しない）
  if (contourCard?.classList.contains('active')) setAllContourVisibility(_map, 'visible');
  // マップがアイドル状態でもレンダーループを確実に起動してタイル再描画を促す
  _map.triggerRepaint();
  _lastAppliedContourInterval = intervalM;
}

// moveend 時に zoom に応じた間隔へ自動切り替え
export function updateContourAutoInterval() {
  const contourCard = document.getElementById('contour-card');
  if (!contourCard?.classList.contains('active')) return;

  // z0-z13 の等高線間隔は buildContourThresholds 内で固定値としてURLに埋め込み済みのため、
  // ズームレベルが変わっても URL は変化しない → setTiles を呼ばない。
  if (_lastAppliedContourInterval === null) {
    applyContourInterval(_userContourInterval);
  }
}

// ---- イベントリスナー（内部）----

function _initListeners() {
  const contourCard = document.getElementById('contour-card');
  const selContourDem = document.getElementById('sel-contour-dem');
  const selContourInterval = document.getElementById('sel-contour-interval');

  // 等高線カード クリックでトグル
  contourCard?.addEventListener('click', (e) => {
    if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
    const isActive = contourCard.classList.toggle('active');
    setAllContourVisibility(_map, isActive ? 'visible' : 'none');
    updateShareableUrl();
    saveUiState();
  });

  // 等高線 DEMソースセレクト
  selContourDem?.addEventListener('change', () => {
    contourState.demMode = selContourDem.value;
    if (contourCard?.classList.contains('active')) {
      setAllContourVisibility(_map, 'visible');
    }
    // 色別等高線オーバーレイ選択中の場合はソース切り替えに追従
    if (_callbacks.getCurrentOverlay?.() === 'color-contour') {
      _callbacks.updateCsVisibility?.();
      _map.triggerRepaint();
    }
    updateShareableUrl();
    saveUiState();
  });

  // 等高線 間隔セレクト
  selContourInterval?.addEventListener('change', () => {
    const iv = parseFloat(selContourInterval.value);
    if (iv) {
      _userContourInterval = iv;
      applyContourInterval(iv);
    }
    updateShareableUrl();
    saveUiState();
  });
}

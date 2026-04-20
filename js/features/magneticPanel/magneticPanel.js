/**
 * magneticPanel.js — 磁北線カード UI イベントリスナー
 *
 * 磁北線カードのクリックトグル・モデルセレクト・間隔セレクト・カラーピッカー
 * のイベントを管理する。
 *
 * 使い方: init(map, { saveUiState, updateShareableUrl }) を起動直後に呼ぶ。
 */

import { setDeclinationModel } from '../../core/magneticDeclination.js';
import {
  setUserMagneticInterval,
  clearGlobalMagneticCache,
  updateMagneticNorth,
  handleMagneticColorChange,
} from '../../core/magneticLines.js';
import { updateMagneticAttribution } from '../../core/attribution.js';

/**
 * @param {maplibregl.Map} map
 * @param {{ saveUiState: () => void, updateShareableUrl: () => void }} callbacks
 */
export function init(map, { saveUiState, updateShareableUrl }) {
  const magneticCard      = document.getElementById('magnetic-card');
  const selMagneticModel  = document.getElementById('sel-magnetic-model');
  const selCombined       = document.getElementById('sel-magnetic-combined');
  const selColor          = document.getElementById('sel-magnetic-color');

  // カードクリックで磁北線レイヤーのトグル
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

  // モデルセレクト変更 → 偏角モデル切替
  selMagneticModel?.addEventListener('change', async () => {
    await setDeclinationModel(selMagneticModel.value);
    clearGlobalMagneticCache();
    updateMagneticNorth();
    updateMagneticAttribution();
    updateShareableUrl();
    saveUiState();
  });
  // 初期モデルをロード
  if (selMagneticModel) setDeclinationModel(selMagneticModel.value);

  // 間隔セレクト変更
  selCombined?.addEventListener('change', () => {
    const val = parseInt(selCombined.value, 10);
    if (val) setUserMagneticInterval(val);
    updateMagneticNorth();
    updateShareableUrl();
    saveUiState();
  });

  // カラーピッカー
  selColor?.addEventListener('input',  () => handleMagneticColorChange(saveUiState));
  selColor?.addEventListener('change', () => handleMagneticColorChange(saveUiState));
}

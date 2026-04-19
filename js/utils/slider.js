/* ================================================================
   slider.js — スライダー共通ユーティリティ
   ================================================================ */

/**
 * input[type=range] の現在値を CSS 変数 --pct に反映する。
 * トラックのグラデーション（進捗色）は CSS 側で --pct を参照する。
 */
export function updateSliderGradient(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', pct + '%');
}

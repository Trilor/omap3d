/* ================================================================
   uiPersistence.js — UI状態の localStorage 永続化プリミティブ
   ================================================================ */

export const UI_STATE_KEY = 'teledrop-ui-state';

/** localStorage から保存済みUI状態を読み込む */
export function loadPersistedState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null') || {};
  } catch { return {}; }
}

/** UI状態スナップショットを localStorage に保存する */
export function savePersistedState(state) {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  } catch {}
}

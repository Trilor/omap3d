/* ================================================================
   uiState.js — サイドバーパネル状態管理
   責務: サイドバーの開閉・パネル切替・幅計算・localStorage 永続化

   eventBus イベント:
     emit: sidebar:panelChanged  { panelId, open }
       → パネル切替・開閉のたびに発火
       → app.js がリスナー経由で副作用（検索初期化・saveUiState等）を実行
   ================================================================ */

import { emit } from './eventBus.js';

// ---- 状態 ----
let _currentPanel = 'sim';
let _isOpen       = true;

// ---- ゲッター ----
export const getSidebarPanel = () => _currentPanel;
export const isSidebarOpen   = () => _isOpen;

// ---- サイドバー幅を CSS 変数に反映 ----
// 検索ボックス・縮尺の left 位置が --sidebar-w に連動する
export function updateSidebarWidth() {
  const mobile  = window.matchMedia('(max-width: 768px)').matches;
  const sidebar = document.getElementById('sidebar');
  const w = (!mobile && sidebar) ? sidebar.offsetWidth : 0;
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
}

// ---- パネルを開く（強制・同一パネルのトグル閉じを防ぐ） ----
export function openSidebarPanel(panelId) {
  const sbPanel = document.getElementById('sidebar-panel');
  document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar-section').forEach(s => s.classList.remove('active'));
  document.querySelector(`.sidebar-nav-btn[data-panel="${panelId}"]`)?.classList.add('active');
  document.getElementById('panel-' + panelId)?.classList.add('active');
  sbPanel?.classList.remove('sb-hidden');
  _currentPanel = panelId;
  _isOpen       = true;
  requestAnimationFrame(updateSidebarWidth);
  emit('sidebar:panelChanged', { panelId, open: true });
}

// ---- サイドバーを閉じる ----
export function closeSidebar() {
  document.getElementById('sidebar-panel')?.classList.add('sb-hidden');
  document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
  _isOpen = false;
  requestAnimationFrame(updateSidebarWidth);
  emit('sidebar:panelChanged', { panelId: _currentPanel, open: false });
}

// ---- localStorage からサイドバー状態を復元 ----
// 引数 s: localStorage から読み込んだ UI 状態オブジェクト全体を受け取る
export function restoreSidebarState(s) {
  if (!s?.sidebarPanel) return;
  _currentPanel = s.sidebarPanel;
  _isOpen       = s.sidebarOpen !== false;

  const sbPanel = document.getElementById('sidebar-panel');
  document.querySelectorAll('.sidebar-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sidebar-section').forEach(ss => ss.classList.remove('active'));

  if (_isOpen) {
    const btn    = document.querySelector(`.sidebar-nav-btn[data-panel="${_currentPanel}"]`);
    const panelEl = document.getElementById('panel-' + _currentPanel);
    sbPanel?.classList.remove('sb-hidden');
    btn?.classList.add('active');
    panelEl?.classList.add('active');
  } else {
    sbPanel?.classList.add('sb-hidden');
  }
  requestAnimationFrame(updateSidebarWidth);
}

// ---- サイドバーナビゲーションのイベントリスナーを初期化 ----
// app.js の初期化シーケンスから1回だけ呼ぶ
export function initSidebarNav() {
  // ナビボタン（アイコンバー）
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.panel;
      if (_currentPanel === panel && _isOpen) {
        // 同じタブを再タップ → 閉じる
        closeSidebar();
      } else {
        openSidebarPanel(panel);
      }
    });
  });

  // パネル内 ✕ ボタン
  document.querySelectorAll('.sidebar-close-btn').forEach(btn => {
    btn.addEventListener('click', () => closeSidebar());
  });

  // ウィンドウリサイズで幅を再計算
  window.addEventListener('resize', updateSidebarWidth);
  updateSidebarWidth();
}

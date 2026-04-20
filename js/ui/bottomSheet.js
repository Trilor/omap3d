/**
 * bottomSheet.js — モバイル ボトムシート ドラッグ制御
 *
 * touchstart/touchmove/touchend で上下スワイプし、
 * 離した位置に最も近い 3段階（min/mid/full）へスナップする。
 *
 * 使い方: initBottomSheet() を起動直後に呼ぶ。
 */

import { isSidebarOpen, updateSidebarWidth } from './uiState.js';

export function initBottomSheet() {
  const MQ        = window.matchMedia('(max-width: 768px)');
  const panel     = document.getElementById('sidebar-panel');
  const handle    = document.getElementById('sheet-handle');
  const miniLabel = document.getElementById('sheet-mini-label');
  const miniStart = document.getElementById('sheet-mini-start-btn');
  if (!panel || !handle) return;

  const NAV_H = 54;
  const MIN_H = 72;

  function sh() {
    return {
      min:  MIN_H,
      mid:  Math.round(window.innerHeight * 0.50),
      full: window.innerHeight - NAV_H - 28,
    };
  }

  let snapState  = 'min';
  let dragStartY = 0;
  let dragStartH = 0;
  let dragging   = false;

  function applyHeight(h, animate) {
    panel.style.transition = animate
      ? 'height 0.32s cubic-bezier(0.4,0,0.2,1)'
      : 'none';
    panel.style.height = h + 'px';
  }

  function snapTo(state, animate = true) {
    snapState = state;
    applyHeight(sh()[state], animate);
    panel.classList.toggle('sheet-min',  state === 'min');
    panel.classList.toggle('sheet-mid',  state === 'mid');
    panel.classList.toggle('sheet-full', state === 'full');
  }

  function nearestSnap(h) {
    const s = sh();
    return [
      { k: 'min',  v: s.min  },
      { k: 'mid',  v: s.mid  },
      { k: 'full', v: s.full },
    ].reduce((a, b) => Math.abs(a.v - h) <= Math.abs(b.v - h) ? a : b).k;
  }

  handle.addEventListener('touchstart', e => {
    if (!MQ.matches) return;
    dragging   = true;
    dragStartY = e.touches[0].clientY;
    dragStartH = panel.getBoundingClientRect().height;
    panel.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchmove', e => {
    if (!dragging || !MQ.matches) return;
    const dy = dragStartY - e.touches[0].clientY;
    const s  = sh();
    panel.style.height = Math.max(s.min, Math.min(s.full, dragStartH + dy)) + 'px';
  }, { passive: true });

  handle.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    snapTo(nearestSnap(panel.getBoundingClientRect().height));
  });

  // ナビボタンタップ: 開くときは mid に展開、閉じるときは min にスナップ
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!MQ.matches) return;
      if (isSidebarOpen()) {
        if (snapState === 'min') snapTo('mid');
      } else {
        snapTo('min');
      }
    });
  });

  if (miniStart) {
    miniStart.addEventListener('click', () => {
      document.getElementById('pc-sim-toggle-btn')?.click();
    });
  }

  const PANEL_NAMES = { terrain: 'テレイン', readmap: '読図地図', '3denv': '3D環境' };
  function updateMiniLabel() {
    const active = document.querySelector('.sidebar-nav-btn.active');
    const key    = active?.dataset?.panel ?? 'terrain';
    if (miniLabel) miniLabel.textContent = PANEL_NAMES[key] ?? key;
  }
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn =>
    btn.addEventListener('click', updateMiniLabel)
  );
  updateMiniLabel();

  window.addEventListener('resize', () => {
    if (MQ.matches) snapTo(snapState, false);
  });

  MQ.addEventListener('change', e => {
    if (e.matches) {
      snapTo('min', false);
    } else {
      panel.style.height     = '';
      panel.style.transition = '';
      panel.classList.remove('sheet-min', 'sheet-mid', 'sheet-full');
    }
    updateSidebarWidth();
  });

  if (MQ.matches) snapTo('min', false);
}

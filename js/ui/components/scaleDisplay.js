/* ================================================================
   scaleDisplay.js — 縮尺表示・PPI設定・実寸定規
   依存: config.js (DEVICE_PPI_DATA, DEFAULT_DEVICE_PPI, EASE_DURATION)
   init(map, { updateSliderGradient }) で map と依存関数を注入する
   ================================================================ */

import {
  DEVICE_PPI_DATA, DEFAULT_DEVICE_PPI, EASE_DURATION,
} from '../../core/config.js';

let _map = null;
let _updateSliderGradient = () => {};

export function init(map, { updateSliderGradient } = {}) {
  _map = map;
  if (updateSliderGradient) _updateSliderGradient = updateSliderGradient;

  _map.on('move', updateScaleDisplay);
  _map.on('zoom', updateScaleDisplay);
  _map.once('idle', updateScaleDisplay);

  const selScale = document.getElementById('sel-scale');
  selScale?.addEventListener('change', () => {
    const val = parseInt(selScale.value, 10);
    if (val) zoomToScale(val);
  });

  buildPpiCascade();
  _initManualPpiSlider();
  updatePpiRuler();
}

// ---- PPI 状態 ----
const _allDevicePpis = DEVICE_PPI_DATA.flatMap(cat => cat.devices.map(d => d.ppi));
let _currentDevicePPI = (() => {
  const saved = parseInt(localStorage.getItem('teledrop-device-ppi'), 10);
  return (saved && _allDevicePpis.includes(saved)) ? saved : DEFAULT_DEVICE_PPI;
})();

export const getCurrentDevicePPI = () => _currentDevicePPI;

function _setDevicePPI(ppi) {
  _currentDevicePPI = ppi;
  localStorage.setItem('teledrop-device-ppi', ppi);
}

// ---- PPI値からデバイス名を返す ----
export function findDeviceName(ppi) {
  for (const cat of DEVICE_PPI_DATA) {
    const dev = cat.devices.find(d => d.ppi === ppi);
    if (dev) return dev.name;
  }
  return `${ppi} ppi`;
}

// ---- カスケードメニューを構築 ----
function buildPpiCascade() {
  const btn   = document.getElementById('ppi-cascade-btn');
  const label = document.getElementById('ppi-cascade-label');
  const menu  = document.getElementById('ppi-cascade-menu');
  if (!btn || !menu) return;

  document.body.appendChild(menu);

  const subs = [];
  menu.innerHTML = DEVICE_PPI_DATA.map((cat, i) =>
    `<div class="ppi-cascade-cat" data-cat-idx="${i}">
      <span>${cat.category}</span>
      <span class="ppi-cascade-cat-arrow">▶</span>
    </div>`
  ).join('');

  DEVICE_PPI_DATA.forEach((cat, i) => {
    const sub = document.createElement('div');
    sub.className = 'ppi-cascade-sub';
    sub.innerHTML = cat.devices.map(dev =>
      `<div class="ppi-cascade-item${dev.ppi === _currentDevicePPI ? ' selected' : ''}" data-ppi="${dev.ppi}">
        <span>${dev.name}</span>
        <span class="ppi-cascade-item-ppi">${dev.ppi} ppi</span>
      </div>`
    ).join('');
    document.body.appendChild(sub);
    subs.push(sub);
  });

  function closeAll() {
    menu.classList.remove('open');
    subs.forEach(s => { s.style.display = ''; });
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('open')) { closeAll(); return; }
    const r = btn.getBoundingClientRect();
    menu.style.top  = (r.bottom + 2) + 'px';
    menu.style.left = r.left + 'px';
    menu.classList.add('open');
  });

  menu.querySelectorAll('.ppi-cascade-cat').forEach(catEl => {
    const idx = parseInt(catEl.dataset.catIdx, 10);
    const sub = subs[idx];
    catEl.addEventListener('mouseenter', () => {
      menu.querySelectorAll('.ppi-cascade-cat').forEach(c => c.classList.remove('open'));
      subs.forEach(s => { s.style.display = ''; });
      catEl.classList.add('open');
      const r = catEl.getBoundingClientRect();
      sub.style.top     = r.top + 'px';
      sub.style.left    = r.right + 'px';
      sub.style.display = 'block';
    });
    catEl.addEventListener('mouseleave', e => {
      if (sub.contains(e.relatedTarget)) return;
      sub.style.display = '';
      catEl.classList.remove('open');
    });
    sub.addEventListener('mouseleave', e => {
      if (catEl.contains(e.relatedTarget)) return;
      sub.style.display = '';
      catEl.classList.remove('open');
    });
  });

  document.addEventListener('click', e => {
    if (!btn.contains(e.target) && !menu.contains(e.target) && !subs.some(s => s.contains(e.target))) {
      closeAll();
    }
  });

  subs.forEach(sub => {
    sub.addEventListener('click', e => {
      const item = e.target.closest('.ppi-cascade-item');
      if (!item) return;
      const ppi = parseInt(item.dataset.ppi, 10);
      _setDevicePPI(ppi);
      label.textContent = findDeviceName(ppi);
      subs.forEach(s => s.querySelectorAll('.ppi-cascade-item').forEach(el =>
        el.classList.toggle('selected', parseInt(el.dataset.ppi, 10) === ppi)
      ));
      closeAll();
      updateScaleDisplay();
      updatePpiRuler();
      const _ms = document.getElementById('ppi-manual-slider');
      if (_ms) { _ms.value = ppi; _updateSliderGradient(_ms); updatePpiSliderBubble(_ms); }
    });
  });

  label.textContent = findDeviceName(_currentDevicePPI);
}

// ---- 実寸定規を SVG で描画 ----
export function updatePpiRuler() {
  const svg = document.getElementById('ppi-ruler');
  if (!svg) return;
  const dpr     = window.devicePixelRatio || 1;
  const pxPerMm = _currentDevicePPI / (dpr * 25.4);

  const containerW = svg.parentElement ? svg.parentElement.clientWidth : 0;
  const W   = containerW > 0 ? containerW : 240;
  const H   = 34;
  const BASE = H - 2;

  svg.setAttribute('width', W);

  const lines = [];
  const texts = [];
  const OX = 16;
  const RW = W;
  lines.push(`<path d="M${OX},${BASE - 16} L${OX},${BASE} L${RW},${BASE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="miter"/>`);
  texts.push(`<text x="${OX}" y="${BASE - 18}" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="500" text-anchor="middle">0</text>`);

  for (let mm = 1; OX + mm * pxPerMm <= RW + 0.5; mm++) {
    const x     = OX + mm * pxPerMm;
    const isCm  = mm % 10 === 0;
    const is5mm = mm % 5 === 0;
    const tickH = isCm ? 16 : is5mm ? 10 : 5;
    lines.push(`<line x1="${x.toFixed(2)}" y1="${BASE - tickH}" x2="${x.toFixed(2)}" y2="${BASE}" stroke="currentColor" stroke-width="${isCm ? 1.5 : 1}"/>`);
    if (isCm) {
      texts.push(`<text x="${x.toFixed(2)}" y="${BASE - 18}" font-size="11" fill="currentColor" font-family="system-ui,sans-serif" font-weight="500" text-anchor="middle">${mm / 10}</text>`);
    }
  }

  svg.innerHTML = lines.join('') + texts.join('');
}

// ---- スライダーバブル更新 ----
export function updatePpiSliderBubble(slider) {
  const bubble = document.getElementById('ppi-slider-bubble');
  const numEl  = document.getElementById('ppi-current-display');
  if (!slider) return;
  const pct = (parseFloat(slider.value) - parseFloat(slider.min))
            / (parseFloat(slider.max)  - parseFloat(slider.min));
  if (bubble) { bubble.style.setProperty('--pct', pct); bubble.textContent = Math.round(slider.value); }
  if (numEl)  numEl.textContent = Math.round(slider.value);
}

// ---- 手動PPIスライダー初期化 ----
function _initManualPpiSlider() {
  const _slider = document.getElementById('ppi-manual-slider');
  if (!_slider) return;
  _slider.value = _currentDevicePPI;
  _updateSliderGradient(_slider);
  updatePpiSliderBubble(_slider);
  _slider.addEventListener('input', () => {
    const ppi = parseInt(_slider.value, 10);
    _setDevicePPI(ppi);
    _updateSliderGradient(_slider);
    updatePpiSliderBubble(_slider);
    updateScaleDisplay();
    updatePpiRuler();
    const _lbl = document.getElementById('ppi-cascade-label');
    if (_lbl) _lbl.textContent = 'カスタム';
    document.querySelectorAll('.ppi-cascade-item').forEach(el => el.classList.remove('selected'));
  });
}

// ---- 縮尺計算 ----
const _MERCATOR_COEFF = 78271.51696; // 2π × 6378137 / 512

function calcScaleDenominator() {
  const center = _map.getCenter();
  const zoom   = _map.getZoom();
  const groundRes  = _MERCATOR_COEFF * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
  const effectiveDPI = _currentDevicePPI / (window.devicePixelRatio || 1);
  return Math.round(groundRes * effectiveDPI / 0.0254);
}

function zoomToScale(targetScale) {
  if (!targetScale) return;
  const center = _map.getCenter();
  const effectiveDPI = _currentDevicePPI / (window.devicePixelRatio || 1);
  const targetGroundRes = targetScale * 0.0254 / effectiveDPI;
  const zoom = Math.log2(_MERCATOR_COEFF * Math.cos(center.lat * Math.PI / 180) / targetGroundRes);
  _map.easeTo({ zoom, duration: EASE_DURATION });
}

export function updateScaleDisplay() {
  const selScale      = document.getElementById('sel-scale');
  const optCurrentScale = document.getElementById('opt-current-scale');
  if (!selScale || !optCurrentScale) return;
  const s = calcScaleDenominator();
  const z = _map.getZoom().toFixed(1);
  optCurrentScale.textContent = `1 : ${s.toLocaleString()} (z${z})`;
  selScale.selectedIndex = 0;
  selScale._csSync?.();
}

/**
 * localTerrainDrawer.js — ローカルテレイン ポリゴン描画 + 名前入力ダイアログ
 *
 * 使い方: init(map, { onTerrainCreated }) を map.on('load') より前に呼ぶ。
 *   onTerrainCreated(terrainId) — 作成後に呼ばれる（エクスプローラーへの遷移等）
 */

import { saveWsTerrain, getWsTerrains } from '../../api/workspace-db.js';
import { updateWorkspaceTerrainSource } from '../../core/terrainSearch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let _map = null;
let _callbacks = {};

let _drawing     = false;
let _vertices    = [];
let _svgEl       = null;
let _polyEl      = null;
let _previewEl   = null;
let _snapCircle  = null;
let _dotEls      = [];
let _lastClickMs = 0;

/**
 * @param {maplibregl.Map} map
 * @param {{ onTerrainCreated: (terrainId: string) => void }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initListeners();
}

// ================================================================
// 内部ヘルパー
// ================================================================

function _getPx(e) {
  const r = _map.getCanvas().getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function _lngLatsToPx(coords) {
  return coords.map(([lng, lat]) => {
    const p = _map.project([lng, lat]);
    return [p.x, p.y];
  });
}

function _ptsStr(pxArr) {
  return pxArr.map(([x, y]) => `${x},${y}`).join(' ');
}

function _redrawSvg(cursorPx) {
  if (!_svgEl) return;
  const vPx = _lngLatsToPx(_vertices);

  if (vPx.length >= 3) {
    _polyEl.setAttribute('points', _ptsStr([...vPx, vPx[0]]));
  } else if (vPx.length === 2) {
    _polyEl.setAttribute('points', _ptsStr(vPx));
  } else {
    _polyEl.setAttribute('points', '');
  }

  if (cursorPx && vPx.length >= 1) {
    const last = vPx[vPx.length - 1];
    _previewEl.setAttribute('x1', last[0]); _previewEl.setAttribute('y1', last[1]);
    _previewEl.setAttribute('x2', cursorPx[0]); _previewEl.setAttribute('y2', cursorPx[1]);
  } else {
    _previewEl.setAttribute('x1', 0); _previewEl.setAttribute('y1', 0);
    _previewEl.setAttribute('x2', 0); _previewEl.setAttribute('y2', 0);
  }

  _dotEls.forEach(d => d.remove());
  _dotEls = [];
  vPx.forEach(([x, y]) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4);
    c.setAttribute('fill', '#16a34a');
    c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.5');
    _svgEl.appendChild(c);
    _dotEls.push(c);
  });

  if (vPx.length >= 3) {
    _snapCircle.setAttribute('cx', vPx[0][0]); _snapCircle.setAttribute('cy', vPx[0][1]);
    _snapCircle.setAttribute('display', 'block');
  } else {
    _snapCircle.setAttribute('display', 'none');
  }
}

function _startDrawMode() {
  _drawing  = true;
  _vertices = [];
  document.getElementById('add-local-terrain-btn')?.classList.add('active');
  const canvas = _map.getCanvas();
  canvas.style.cursor = 'crosshair';
  _map.dragPan.disable();
  _map.scrollZoom.disable();
  _map.boxZoom.disable();

  const container = _map.getContainer();
  _svgEl = document.createElementNS(SVG_NS, 'svg');
  _svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9000;';

  _polyEl = document.createElementNS(SVG_NS, 'polygon');
  _polyEl.setAttribute('fill', 'rgba(22,163,74,0.15)');
  _polyEl.setAttribute('stroke', '#16a34a');
  _polyEl.setAttribute('stroke-width', '2');
  _polyEl.setAttribute('stroke-dasharray', '6,3');
  _svgEl.appendChild(_polyEl);

  _previewEl = document.createElementNS(SVG_NS, 'line');
  _previewEl.setAttribute('stroke', '#16a34a');
  _previewEl.setAttribute('stroke-width', '1.5');
  _previewEl.setAttribute('stroke-dasharray', '4,4');
  _svgEl.appendChild(_previewEl);

  _snapCircle = document.createElementNS(SVG_NS, 'circle');
  _snapCircle.setAttribute('r', 10);
  _snapCircle.setAttribute('fill', 'rgba(22,163,74,0.2)');
  _snapCircle.setAttribute('stroke', '#16a34a');
  _snapCircle.setAttribute('stroke-width', '2');
  _snapCircle.setAttribute('display', 'none');
  _svgEl.appendChild(_snapCircle);

  container.appendChild(_svgEl);
  _showDrawHint('クリックで頂点を追加 / 最初の点に戻るかダブルクリックで完成 / Enter で確定 / ESC でキャンセル');
}

function _endDrawMode() {
  _drawing  = false;
  _vertices = [];
  _dotEls   = [];
  _map.getCanvas().style.cursor = '';
  document.getElementById('add-local-terrain-btn')?.classList.remove('active');
  _map.dragPan.enable();
  _map.scrollZoom.enable();
  _map.boxZoom.enable();
  _svgEl?.remove();
  _svgEl = null; _polyEl = null; _previewEl = null; _snapCircle = null;
  _hideDrawHint();
}

function _showDrawHint(msg) {
  let hint = document.getElementById('terrain-draw-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'terrain-draw-hint';
    hint.className = 'terrain-draw-hint';
    _map.getContainer().appendChild(hint);
  }
  hint.textContent = msg;
}

function _hideDrawHint() { document.getElementById('terrain-draw-hint')?.remove(); }

function _nearFirst(px) {
  if (_vertices.length < 3) return false;
  const fp = _map.project(_vertices[0]);
  return Math.hypot(px[0] - fp.x, px[1] - fp.y) < 12;
}

async function _finishPolygon() {
  if (_vertices.length < 3) { _endDrawMode(); return; }
  const coords = [..._vertices];
  _endDrawMode();
  await _showNameDialog(coords);
}

function _showNameDialog(polygonCoords) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'local-terrain-dialog-overlay';
    overlay.innerHTML = `
      <div class="local-terrain-dialog">
        <div class="local-terrain-dialog-title">ローカルテレインを作成</div>
        <label class="local-terrain-dialog-label">テレイン名
          <input id="ltd-name" type="text" class="local-terrain-dialog-input" placeholder="例: 地元の森" maxlength="60" />
        </label>
        <label class="local-terrain-dialog-label">都道府県（任意）
          <input id="ltd-pref" type="text" class="local-terrain-dialog-input" placeholder="例: 東京都" maxlength="20" />
        </label>
        <div class="local-terrain-dialog-btns">
          <button id="ltd-cancel" class="local-terrain-dialog-btn cancel">キャンセル</button>
          <button id="ltd-ok"     class="local-terrain-dialog-btn ok">作成</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#ltd-name');
    const prefInput = overlay.querySelector('#ltd-pref');
    requestAnimationFrame(() => nameInput?.focus());

    async function _confirm() {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      const sumLng = polygonCoords.reduce((s, [lng]) => s + lng, 0);
      const sumLat = polygonCoords.reduce((s, [, lat]) => s + lat, 0);
      const center = [sumLng / polygonCoords.length, sumLat / polygonCoords.length];

      const lngs = polygonCoords.map(([lng]) => lng);
      const lats  = polygonCoords.map(([, lat]) => lat);
      const bbox  = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];

      const boundary = {
        type: 'Polygon',
        coordinates: [[...polygonCoords, polygonCoords[0]]],
      };

      const id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      await saveWsTerrain({
        id, name,
        source:     'local',
        prefecture: prefInput.value.trim() || null,
        region:     null,
        type:       'other',
        tags:       [],
        center, bbox, boundary,
        visible:    true,
      });

      const wsAll = await getWsTerrains();
      updateWorkspaceTerrainSource(_map, wsAll);
      await _callbacks.onTerrainCreated?.(id);

      overlay.remove();
      resolve(true);
    }

    overlay.querySelector('#ltd-ok').addEventListener('click', _confirm);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') _confirm(); });
    overlay.querySelector('#ltd-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

function _initListeners() {
  document.getElementById('add-local-terrain-btn')?.addEventListener('click', () => {
    if (_drawing) { _endDrawMode(); return; }
    _startDrawMode();
  });

  const canvas = _map.getCanvas();

  canvas.addEventListener('click', async e => {
    if (!_drawing) return;
    e.stopPropagation();

    const now = Date.now();
    const isDouble = (now - _lastClickMs) < 350;
    _lastClickMs = now;

    const px = _getPx(e);

    if (isDouble) {
      if (_vertices.length > 0) _vertices.pop();
      await _finishPolygon();
      return;
    }

    if (_nearFirst(px)) {
      await _finishPolygon();
      return;
    }

    const ll = _map.unproject(px);
    _vertices.push([ll.lng, ll.lat]);
    _redrawSvg(px);
  });

  canvas.addEventListener('mousemove', e => {
    if (!_drawing || _vertices.length === 0) return;
    _redrawSvg(_getPx(e));
  });

  document.addEventListener('keydown', async e => {
    if (!_drawing) return;
    if (e.key === 'Escape')    { _endDrawMode(); return; }
    if (e.key === 'Enter' && _vertices.length >= 3) { await _finishPolygon(); return; }
    if (e.key === 'Backspace' && _vertices.length > 0) {
      _vertices.pop();
      _redrawSvg(null);
    }
  });
}

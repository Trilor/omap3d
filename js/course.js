/* ================================================================
   course.js — コースプランナーモジュール（v2）
   IOF 規格オリエンテーリングコース 作成・距離・登高計算

   主な機能:
   · 描画モード（クリックでコントロールを順次追加）
   · 全シンボルを GeoJSON レイヤーで描画（マーカー・レグ線が同一 WebGL フレームで更新）
   · mousedown/mousemove/mouseup によるカスタムドラッグ（ラグなし）
   · Turf.js による距離計算（即時）
   · DEM タイル直接サンプリングによる累積登高計算（非同期）
   · JSON エクスポート / インポート
   ================================================================ */

import { QCHIZU_DEM_BASE, DEM5A_BASE } from './config.js';

// ================================================================
// 定数
// ================================================================
const COURSE_COLOR   = '#c020c0';  // IOF コースオーバープリント（パープルマゼンタ）
const CLIMB_ZOOM     = 14;         // 登高計算用 DEM ズームレベル（DEM5A z14 = 約 10m/px）
const CLIMB_SAMPLE_M = 10;         // 登高サンプリング間隔（m）

// ================================================================
// マップ参照・コース状態
// ================================================================
let _map = null;

const _plan = {
  name:     'コース1',
  controls: [],  // { id, type:'start'|'control'|'finish', lng, lat, code }[]
};

let _nextId     = 0;        // uid 生成カウンタ
let _drawMode   = false;    // 描画モード中か
let _drawFinish = false;    // 次のクリックでフィニッシュを置くか
let _calcTimer  = null;     // 登高計算デバウンス用タイマー
let _legStats   = [];       // [{ distKm, climb }] ← 各レグの統計キャッシュ
let _calcAbort  = null;     // 計算キャンセル用フラグオブジェクト

// ドラッグ状態
let _dragCtrl  = null;      // ドラッグ中のコントロールオブジェクト

// ================================================================
// DEM タイル直接サンプリング（登高計算用）
// app.js の同名実装と同一ロジック。config.js の URL 定数のみ参照。
// ================================================================

const _demCache = new Map();

function _fetchTileData(url) {
  if (_demCache.has(url)) return _demCache.get(url);
  const p = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const bm = await createImageBitmap(await r.blob());
      const cv  = new OffscreenCanvas(bm.width, bm.height);
      cv.getContext('2d').drawImage(bm, 0, 0);
      bm.close();
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    } catch { return null; }
  })();
  _demCache.set(url, p);
  setTimeout(() => _demCache.delete(url), 120_000);
  return p;
}

function _tileXY(lng, lat, z) {
  const n  = 1 << z;
  const x  = Math.floor((lng + 180) / 360 * n);
  const lr = lat * Math.PI / 180;
  const y  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function _pixelInTile(lng, lat, z, tx, ty, tileSize) {
  const n  = 1 << z;
  const px = ((lng + 180) / 360 * n - tx) * tileSize;
  const lr = lat * Math.PI / 180;
  const py = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n - ty) * tileSize;
  return {
    px: Math.floor(Math.max(0, Math.min(tileSize - 1, px))),
    py: Math.floor(Math.max(0, Math.min(tileSize - 1, py))),
  };
}

function _readNumPng(imgData, px, py) {
  const i = (py * imgData.width + px) * 4;
  if (imgData.data[i + 3] === 0) return null;
  const v = imgData.data[i] * 65536 + imgData.data[i + 1] * 256 + imgData.data[i + 2];
  return (v >= 8388608 ? v - 16777216 : v) * 0.01;
}

async function _elevAt(lng, lat, z = CLIMB_ZOOM) {
  const { x, y } = _tileXY(lng, lat, z);
  const url = z >= 15
    ? `${QCHIZU_DEM_BASE}/${z}/${x}/${y}.webp`
    : `${DEM5A_BASE}/${z}/${x}/${y}.png`;
  const imgData = await _fetchTileData(url);
  if (!imgData) return null;
  const { px, py } = _pixelInTile(lng, lat, z, x, y, imgData.width);
  return _readNumPng(imgData, px, py);
}

// ================================================================
// レグ統計計算（距離・累積登高）
// ================================================================

async function _calcLegStats(from, to, abortFlag) {
  const line    = turf.lineString([[from.lng, from.lat], [to.lng, to.lat]]);
  const distKm  = turf.length(line, { units: 'kilometers' });
  const distM   = distKm * 1000;
  const steps   = Math.max(2, Math.ceil(distM / CLIMB_SAMPLE_M));

  const promises = [];
  for (let i = 0; i <= steps; i++) {
    const pt   = turf.along(line, (i / steps) * distKm, { units: 'kilometers' });
    const [lng, lat] = pt.geometry.coordinates;
    promises.push(_elevAt(lng, lat));
  }
  const elevs = await Promise.all(promises);
  if (abortFlag.aborted) return null;

  let climb = 0;
  for (let i = 1; i < elevs.length; i++) {
    if (elevs[i] != null && elevs[i - 1] != null) {
      const d = elevs[i] - elevs[i - 1];
      if (d > 0) climb += d;
    }
  }
  return { distKm, climb: Math.round(climb) };
}

async function _recalcAll() {
  if (_calcAbort) _calcAbort.aborted = true;
  const abortFlag = { aborted: false };
  _calcAbort = abortFlag;

  const ctrls = _plan.controls;
  if (ctrls.length < 2) { _legStats = []; _renderPanel(); return; }

  const climbEl = document.getElementById('course-stat-climb');
  if (climbEl) climbEl.textContent = '計算中…';

  const results = await Promise.all(
    ctrls.slice(1).map((_, i) => _calcLegStats(ctrls[i], ctrls[i + 1], abortFlag))
  );
  if (abortFlag.aborted) return;

  _legStats = results;
  _renderPanel();
}

function _scheduleCalc() {
  if (_calcTimer) clearTimeout(_calcTimer);
  _calcTimer = setTimeout(_recalcAll, 500);
}

// ================================================================
// GeoJSON ソース更新
// ================================================================

/**
 * コントロールポイント＋レグ線を 1 つの FeatureCollection にまとめる。
 * 全レイヤーが同じソースを参照するため、setData 1 回で同一フレームに反映される。
 */
function _buildSourceData() {
  const features = [];

  // コントロールポイント（スタート・コントロール・フィニッシュ）
  _plan.controls.forEach(ctrl => {
    // label: コントロールは下2桁のみ表示（IOF スタイル）。JS 側で計算して渡す
    const label = ctrl.type === 'control' ? String(ctrl.code).slice(-2) : '';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [ctrl.lng, ctrl.lat] },
      properties: { id: ctrl.id, type: ctrl.type, code: ctrl.code, label },
    });
  });

  // レグ線（2点以上ある場合のみ）
  if (_plan.controls.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: _plan.controls.map(c => [c.lng, c.lat]),
      },
      properties: { type: 'leg' },
    });
  }

  return { type: 'FeatureCollection', features };
}

function _refreshSource() {
  const src = _map?.getSource('course-source');
  if (src) src.setData(_buildSourceData());
}

// ================================================================
// スタートシンボル（△）画像のロード
// ================================================================

function _loadStartImage() {
  if (_map.hasImage('course-start-tri')) return;
  // 2x DPI: 64×64 で描いて pixelRatio:2 で登録 → 表示上 32×32px
  // addImage は HTMLCanvasElement を受け付けないため ImageData で渡す
  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const m = SIZE / 2;
  const r = SIZE * 0.36;  // 外接円半径
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.beginPath();
  ctx.moveTo(m,     m - r * 1.15);  // 上頂点
  ctx.lineTo(m + r, m + r * 0.58);  // 右下
  ctx.lineTo(m - r, m + r * 0.58);  // 左下
  ctx.closePath();
  ctx.strokeStyle = COURSE_COLOR;
  ctx.lineWidth   = 4.5;  // pixelRatio:2 換算で実効 2.25px
  ctx.lineJoin    = 'round';
  ctx.stroke();
  // ImageData として取り出して登録（HTMLCanvasElement は addImage 非対応）
  const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
  _map.addImage('course-start-tri', imgData, { pixelRatio: 2, sdf: false });
}

// ================================================================
// MapLibre レイヤー初期化
// ================================================================

const LAYER_IDS = [
  'course-legs',
  'course-ctrl-outer',   // コントロール円・フィニッシュ外円
  'course-finish-inner', // フィニッシュ内円
  'course-start-icon',   // スタート三角
  'course-labels',       // コントロール番号
  'course-hit',          // インタラクション用透明ヒット領域（最前面）
];

function _initLayers() {
  _loadStartImage();

  _map.addSource('course-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // ① レグ線
  _map.addLayer({
    id: 'course-legs', type: 'line', source: 'course-source',
    filter: ['==', ['get', 'type'], 'leg'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color':     COURSE_COLOR,
      'line-width':     1.5,
      'line-dasharray': [5, 2.5],
      'line-opacity':   0.9,
    },
  });

  // ② コントロール円・フィニッシュ外円
  _map.addLayer({
    id: 'course-ctrl-outer', type: 'circle', source: 'course-source',
    filter: ['in', ['get', 'type'], ['literal', ['control', 'finish']]],
    paint: {
      'circle-radius':       12,
      'circle-color':        'rgba(0,0,0,0)',
      'circle-stroke-color': COURSE_COLOR,
      'circle-stroke-width': 2.2,
    },
  });

  // ③ フィニッシュ内円
  _map.addLayer({
    id: 'course-finish-inner', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'type'], 'finish'],
    paint: {
      'circle-radius':       8,
      'circle-color':        'rgba(0,0,0,0)',
      'circle-stroke-color': COURSE_COLOR,
      'circle-stroke-width': 2,
    },
  });

  // ④ スタート三角（Canvas で描いた画像を symbol で表示）
  _map.addLayer({
    id: 'course-start-icon', type: 'symbol', source: 'course-source',
    filter: ['==', ['get', 'type'], 'start'],
    layout: {
      'icon-image':          'course-start-tri',
      'icon-size':           1,
      'icon-allow-overlap':  true,
      'icon-ignore-placement': true,
    },
  });

  // ⑤ コントロール番号ラベル（JS 側で計算した label プロパティを使用）
  _map.addLayer({
    id: 'course-labels', type: 'symbol', source: 'course-source',
    filter: ['==', ['get', 'type'], 'control'],
    layout: {
      'text-field':            ['get', 'label'],  // JS 側で下2桁に加工済み
      'text-size':             10,
      'text-font':             ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': COURSE_COLOR,
    },
  });

  // ⑥ インタラクション用透明ヒット領域（全コントロールを広めの円で覆う）
  _map.addLayer({
    id: 'course-hit', type: 'circle', source: 'course-source',
    filter: ['!=', ['get', 'type'], 'leg'],
    paint: {
      'circle-radius':  18,
      'circle-color':   'rgba(0,0,0,0)',
      'circle-opacity': 0,
    },
  });
}

// ================================================================
// ドラッグ実装（mousedown → mousemove → mouseup）
// ================================================================

function _startDrag(e) {
  if (!e.features?.length) return;
  const id = e.features[0].properties.id;
  _dragCtrl = _plan.controls.find(c => c.id === id);
  if (!_dragCtrl) return;

  e.preventDefault();
  _map.dragPan.disable();
  _map.getCanvas().style.cursor = 'grabbing';

  _map.on('mousemove', _onDrag);
  _map.once('mouseup', _endDrag);
}

function _onDrag(e) {
  if (!_dragCtrl) return;
  _dragCtrl.lng = e.lngLat.lng;
  _dragCtrl.lat = e.lngLat.lat;
  // GeoJSON ソースを更新 → マーカーとレグ線が同一 WebGL フレームで反映（ラグなし）
  _refreshSource();
}

function _endDrag() {
  _map.dragPan.enable();
  _map.getCanvas().style.cursor = _drawMode ? 'crosshair' : '';
  _map.off('mousemove', _onDrag);
  if (_dragCtrl) {
    _dragCtrl = null;
    _scheduleCalc();
    _renderPanel();
  }
}

// ================================================================
// コントロール追加・削除
// ================================================================

function _addControl(lng, lat) {
  const ctrls = _plan.controls;
  let type, code;

  if (ctrls.length === 0) {
    type = 'start'; code = 'S';
  } else if (_drawFinish) {
    type = 'finish'; code = 'F';
    _drawFinish = false;
  } else {
    type = 'control';
    const numCtrl = ctrls.filter(c => c.type === 'control').length;
    code = String(101 + numCtrl);
  }

  const ctrl = { id: 'c' + (_nextId++), type, lng, lat, code };

  // フィニッシュが既にある場合はその直前に挿入
  if (type === 'control') {
    const finIdx = ctrls.findIndex(c => c.type === 'finish');
    if (finIdx !== -1) {
      ctrls.splice(finIdx, 0, ctrl);
      _renumberControls();
      _refreshSource();
      _scheduleCalc();
      _renderPanel();
      return;
    }
  }

  ctrls.push(ctrl);
  if (type === 'finish') _setDrawMode(false);

  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

function _deleteControl(id) {
  const idx = _plan.controls.findIndex(c => c.id === id);
  if (idx === -1) return;
  _plan.controls.splice(idx, 1);
  _renumberControls();
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

function _renumberControls() {
  let n = 0;
  _plan.controls.forEach(c => {
    if (c.type === 'control') c.code = String(101 + n++);
  });
}

// ================================================================
// 描画モード制御
// ================================================================

function _onMapClick(e) {
  // ヒット領域に既存コントロールがある場合は追加しない
  const hits = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
  if (hits.length > 0) return;
  _addControl(e.lngLat.lng, e.lngLat.lat);
  _updateDrawHint();
}

function _setDrawMode(active) {
  _drawMode = active;
  if (active) {
    _map.getCanvas().style.cursor = 'crosshair';
    _map.on('click', _onMapClick);
  } else {
    _map.getCanvas().style.cursor = '';
    _map.off('click', _onMapClick);
    _drawFinish = false;
  }
  _updateDrawModeUI();
  _updateDrawHint();
}

function _updateDrawModeUI() {
  const btn    = document.getElementById('course-draw-toggle');
  const finBtn = document.getElementById('course-add-finish-btn');
  if (!btn) return;

  const hasStart  = _plan.controls.some(c => c.type === 'start');
  const hasFinish = _plan.controls.some(c => c.type === 'finish');

  if (_drawMode) {
    btn.classList.add('course-draw-active');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> 描画終了`;
    if (finBtn) {
      finBtn.style.display = '';
      finBtn.disabled = !hasStart || hasFinish || _drawFinish;
    }
  } else {
    btn.classList.remove('course-draw-active');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 描画開始`;
    if (finBtn) finBtn.style.display = 'none';
  }
}

function _updateDrawHint() {
  const el = document.getElementById('course-draw-hint');
  if (!el) return;
  if (!_drawMode) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  const hasStart  = _plan.controls.some(c => c.type === 'start');
  const hasFinish = _plan.controls.some(c => c.type === 'finish');
  if (!hasStart)       el.textContent = '地図をクリックしてスタート（△）を配置';
  else if (_drawFinish) el.textContent = '地図をクリックしてフィニッシュ（◎）を配置';
  else if (hasFinish)  el.textContent = '地図をクリックでコントロールを追加（フィニッシュの前に挿入）';
  else                 el.textContent = '地図をクリックしてコントロール（○）を追加';
}

// ================================================================
// サイドバーパネル用 SVG（地図レイヤーとは独立）
// ================================================================

function _svgStart(size = 24) {
  const m = size / 2, r = size * 0.36;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <polygon points="${m},${(m - r * 1.15).toFixed(1)} ${(m + r).toFixed(1)},${(m + r * 0.58).toFixed(1)} ${(m - r).toFixed(1)},${(m + r * 0.58).toFixed(1)}"
      fill="none" stroke="${COURSE_COLOR}" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

function _svgControl(code, size = 24) {
  const m = size / 2, r = m - 1.5, fs = Math.round(size * 0.36);
  const label = code ? String(code).slice(-2) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
    <text x="${m}" y="${m + fs * 0.38}" text-anchor="middle" fill="${COURSE_COLOR}"
          font-size="${fs}" font-weight="bold" font-family="sans-serif">${label}</text>
  </svg>`;
}

function _svgFinish(size = 24) {
  const m = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${m - 1.5}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
    <circle cx="${m}" cy="${m}" r="${m - 5}"   fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
  </svg>`;
}

function _ctrlSvg(ctrl) {
  if (ctrl.type === 'start')  return _svgStart();
  if (ctrl.type === 'finish') return _svgFinish();
  return _svgControl(ctrl.code);
}

// ================================================================
// パネル描画
// ================================================================

function _renderPanel() {
  const listEl    = document.getElementById('course-controls-list');
  const emptyEl   = document.getElementById('course-empty-msg');
  const statsSec  = document.getElementById('course-stats-section');
  const distEl    = document.getElementById('course-stat-dist');
  const climbEl   = document.getElementById('course-stat-climb');
  const countEl   = document.getElementById('course-stat-count');
  const clearBtn  = document.getElementById('course-clear-btn');
  const exportBtn = document.getElementById('course-export-btn');
  if (!listEl) return;

  const ctrls = _plan.controls;
  const n     = ctrls.length;

  if (emptyEl)   emptyEl.style.display  = n ? 'none' : '';
  if (statsSec)  statsSec.style.display = n >= 2 ? '' : 'none';
  if (clearBtn)  clearBtn.disabled      = n === 0;
  if (exportBtn) exportBtn.disabled     = n === 0;

  // 合計距離（即時）
  let totalDist = 0;
  for (let i = 1; i < n; i++) {
    totalDist += turf.distance(
      turf.point([ctrls[i - 1].lng, ctrls[i - 1].lat]),
      turf.point([ctrls[i].lng,     ctrls[i].lat]),
      { units: 'kilometers' }
    );
  }
  if (distEl)  distEl.textContent  = n >= 2 ? totalDist.toFixed(2) + ' km' : '—';

  // 累積登高（非同期キャッシュから）
  if (climbEl) {
    if (_legStats.length > 0 && _legStats.every(s => s != null)) {
      climbEl.textContent = _legStats.reduce((s, l) => s + (l?.climb ?? 0), 0) + ' m';
    } else if (n < 2) {
      climbEl.textContent = '—';
    }
  }

  const numCtrls = ctrls.filter(c => c.type === 'control').length;
  if (countEl) countEl.textContent = numCtrls + ' 個';

  // コントロールリスト
  listEl.innerHTML = '';
  ctrls.forEach((ctrl, idx) => {
    const legDist = idx > 0
      ? turf.distance(
          turf.point([ctrls[idx - 1].lng, ctrls[idx - 1].lat]),
          turf.point([ctrl.lng, ctrl.lat]),
          { units: 'kilometers' }
        )
      : null;
    const legStat = _legStats[idx - 1] ?? null;

    const row = document.createElement('div');
    row.className = 'course-ctrl-item'; row.dataset.id = ctrl.id;

    const symDiv = document.createElement('div');
    symDiv.className = 'course-ctrl-sym';
    symDiv.innerHTML = _ctrlSvg(ctrl);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'course-ctrl-info';

    if (ctrl.type === 'start' || ctrl.type === 'finish') {
      const lbl = document.createElement('span');
      lbl.className   = 'course-ctrl-type-label';
      lbl.textContent = ctrl.type === 'start' ? 'スタート' : 'フィニッシュ';
      infoDiv.appendChild(lbl);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'course-ctrl-code-input';
      inp.value = ctrl.code; inp.maxLength = 5;
      inp.title = 'コントロールコードを編集';
      inp.addEventListener('change', () => {
        ctrl.code = inp.value.trim() || ctrl.code;
        inp.value = ctrl.code;
        _refreshSource(); // ラベルレイヤーも同時更新
      });
      infoDiv.appendChild(inp);
    }

    if (legDist != null) {
      const statsDiv = document.createElement('div');
      statsDiv.className = 'course-ctrl-leg-stats';
      statsDiv.textContent = `↔ ${legDist.toFixed(2)} km${legStat ? ` ↑${legStat.climb} m` : ''}`;
      infoDiv.appendChild(statsDiv);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'course-ctrl-del'; delBtn.title = '削除';
    delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener('click', () => _deleteControl(ctrl.id));

    row.appendChild(symDiv); row.appendChild(infoDiv); row.appendChild(delBtn);
    listEl.appendChild(row);
  });

  _updateDrawModeUI();
  _updateDrawHint();
}

// ================================================================
// JSON エクスポート / インポート
// ================================================================

function _exportJSON() {
  const data = {
    version: 1, name: _plan.name,
    controls: _plan.controls.map(c => ({
      type: c.type, code: c.code,
      lng: +c.lng.toFixed(7), lat: +c.lat.toFixed(7),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${_plan.name || 'course'}.json`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function _importJSON(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.controls)) throw new Error('controls フィールドがありません');
    _clearCourse(true);
    if (data.name) {
      _plan.name = data.name;
      const el = document.getElementById('course-name-input');
      if (el) el.value = _plan.name;
    }
    data.controls.forEach(c => {
      _plan.controls.push({ id: 'c' + (_nextId++), type: c.type, lng: c.lng, lat: c.lat, code: c.code });
    });
    _refreshSource();
    _scheduleCalc();
    _renderPanel();
    if (_plan.controls.length > 0) {
      const lngs = _plan.controls.map(c => c.lng);
      const lats  = _plan.controls.map(c => c.lat);
      const bbox  = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
      if (bbox[0] === bbox[2] && bbox[1] === bbox[3])
        _map.flyTo({ center: [bbox[0], bbox[1]], zoom: 15, duration: 600 });
      else
        _map.fitBounds(bbox, { padding: 100, duration: 600 });
    }
  } catch (e) {
    alert('JSON の読み込みに失敗しました: ' + e.message);
  }
}

// ================================================================
// コースクリア
// ================================================================

function _clearCourse(skipConfirm = false) {
  if (_drawMode) _setDrawMode(false);
  if (_calcAbort) _calcAbort.aborted = true;
  _plan.controls = [];
  _legStats      = [];
  _refreshSource();
  _renderPanel();
}

// ================================================================
// UI イベント設定
// ================================================================

function _setupUI() {
  const nameInput = document.getElementById('course-name-input');
  if (nameInput) {
    nameInput.value = _plan.name;
    nameInput.addEventListener('input', () => { _plan.name = nameInput.value || 'コース'; });
  }

  document.getElementById('course-draw-toggle')?.addEventListener('click', () => {
    _setDrawMode(!_drawMode);
  });

  document.getElementById('course-add-finish-btn')?.addEventListener('click', () => {
    _drawFinish = true;
    if (!_drawMode) _setDrawMode(true);
    _updateDrawHint(); _updateDrawModeUI();
  });

  document.getElementById('course-export-btn')?.addEventListener('click', _exportJSON);

  const importFileEl = document.getElementById('course-import-file');
  document.getElementById('course-import-btn')?.addEventListener('click', () => importFileEl?.click());
  importFileEl?.addEventListener('change', () => {
    const f = importFileEl.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = e => _importJSON(e.target.result);
    reader.readAsText(f);
    importFileEl.value = '';
  });

  document.getElementById('course-clear-btn')?.addEventListener('click', () => {
    if (_plan.controls.length === 0) return;
    if (!confirm('コースを全削除しますか？')) return;
    _clearCourse();
  });

  _renderPanel();
}

// ================================================================
// 公開 API — app.js の map.on('load') から呼び出す
// ================================================================

export function initCoursePlanner(map) {
  _map = map;

  // レイヤー追加（ソース・シンボル画像を含む）
  _initLayers();

  // ドラッグ: course-hit レイヤー上の mousedown でカスタムドラッグ開始
  map.on('mousedown', 'course-hit', _startDrag);

  // ホバーカーソル
  map.on('mouseenter', 'course-hit', () => {
    if (!_dragCtrl) map.getCanvas().style.cursor = 'grab';
  });
  map.on('mouseleave', 'course-hit', () => {
    if (!_dragCtrl) map.getCanvas().style.cursor = _drawMode ? 'crosshair' : '';
  });

  _setupUI();
}

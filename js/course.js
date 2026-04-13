/* ================================================================
   course.js — コースプランナーモジュール
   IOF 規格オリエンテーリングコース 作成・距離・登高計算

   主な機能:
   · 描画モード（クリックでコントロールを順次追加）
   · MapLibre HTML マーカー（ドラッグ移動対応）
   · GeoJSON レイヤーによるレグ線描画
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
let _markers    = [];       // { id, marker }[] ← MapLibre Marker インスタンス
let _calcTimer  = null;     // 登高計算デバウンス用タイマー
let _legStats   = [];       // [{ distKm, climb }] ← 各レグの統計キャッシュ
let _calcAbort  = null;     // 計算キャンセル用フラグオブジェクト

// ================================================================
// DEM タイル直接サンプリング（登高計算用）
// app.js の同名実装と同一ロジック。config.js の URL 定数のみ参照。
// ================================================================

// タイル ImageData キャッシュ（重複 fetch 防止・2分 TTL）
const _demCache = new Map();

/** DEM タイル画像の ImageData を取得（キャッシュ付き） */
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

/** lng/lat → タイル座標 (z, x, y) */
function _tileXY(lng, lat, z) {
  const n  = 1 << z;
  const x  = Math.floor((lng + 180) / 360 * n);
  const lr = lat * Math.PI / 180;
  const y  = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** lng/lat → タイル内ピクセル座標 */
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

/** 地理院 NumPNG 標高デコード */
function _readNumPng(imgData, px, py) {
  const i = (py * imgData.width + px) * 4;
  if (imgData.data[i + 3] === 0) return null;
  const v = imgData.data[i] * 65536 + imgData.data[i + 1] * 256 + imgData.data[i + 2];
  return (v >= 8388608 ? v - 16777216 : v) * 0.01;
}

/** lngLat の標高を DEM タイルから直接取得 */
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

/**
 * from → to 間の距離（km）と累積登高（m）を計算する。
 * @param {{ lng, lat }} from
 * @param {{ lng, lat }} to
 * @param {{ aborted: boolean }} abortFlag — 計算を中断するフラグ
 */
async function _calcLegStats(from, to, abortFlag) {
  const line    = turf.lineString([[from.lng, from.lat], [to.lng, to.lat]]);
  const distKm  = turf.length(line, { units: 'kilometers' });
  const distM   = distKm * 1000;
  const steps   = Math.max(2, Math.ceil(distM / CLIMB_SAMPLE_M));

  // サンプリング点を生成
  const promises = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const pt   = turf.along(line, frac * distKm, { units: 'kilometers' });
    const [lng, lat] = pt.geometry.coordinates;
    promises.push(_elevAt(lng, lat));
  }
  const elevs = await Promise.all(promises);
  if (abortFlag.aborted) return null;

  // 累積登高（正の標高差の合計）
  let climb = 0;
  for (let i = 1; i < elevs.length; i++) {
    if (elevs[i] != null && elevs[i - 1] != null) {
      const d = elevs[i] - elevs[i - 1];
      if (d > 0) climb += d;
    }
  }
  return { distKm, climb: Math.round(climb) };
}

/** 全レグの統計を（再）計算してパネルを更新する（デバウンス用） */
async function _recalcAll() {
  // 前回の計算を中断
  if (_calcAbort) _calcAbort.aborted = true;
  const abortFlag = { aborted: false };
  _calcAbort = abortFlag;

  const ctrls = _plan.controls;
  if (ctrls.length < 2) {
    _legStats = [];
    _renderPanel();
    return;
  }

  // 計算中表示
  const climbEl = document.getElementById('course-stat-climb');
  if (climbEl) climbEl.textContent = '計算中…';

  const promises = [];
  for (let i = 1; i < ctrls.length; i++) {
    promises.push(_calcLegStats(ctrls[i - 1], ctrls[i], abortFlag));
  }
  const results = await Promise.all(promises);
  if (abortFlag.aborted) return;

  _legStats = results;
  _renderPanel();
}

/** 登高計算をデバウンス（500ms）してからトリガーする */
function _scheduleCalc() {
  if (_calcTimer) clearTimeout(_calcTimer);
  _calcTimer = setTimeout(_recalcAll, 500);
}

// ================================================================
// MapLibre GeoJSON レグ線の更新
// ================================================================

function _buildLegsGeoJSON() {
  const ctrls = _plan.controls;
  if (ctrls.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{
      type:     'Feature',
      geometry: { type: 'LineString', coordinates: ctrls.map(c => [c.lng, c.lat]) },
      properties: {},
    }],
  };
}

function _refreshLegs() {
  const src = _map?.getSource('course-legs-source');
  if (src) src.setData(_buildLegsGeoJSON());
}

// ================================================================
// SVG シンボル生成（IOF 規格スタイル）
// ================================================================

function _svgStart(size = 28) {
  const m = size / 2;
  const r = size * 0.40;  // 内接円半径
  // 正三角形（上頂点、左下、右下）
  const top = [m,         m - r * 1.15].map(v => v.toFixed(1)).join(',');
  const bl  = [m - r,     m + r * 0.58].map(v => v.toFixed(1)).join(',');
  const br  = [m + r,     m + r * 0.58].map(v => v.toFixed(1)).join(',');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <polygon points="${top} ${bl} ${br}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2.2" stroke-linejoin="round"/>
  </svg>`;
}

function _svgControl(code, size = 26) {
  const m  = size / 2;
  const r  = m - 2;
  const fs = Math.round(size * 0.38);
  // 3桁コードの下2桁のみ表示（OCADスタイル）
  const label = code ? String(code).slice(-2) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2.2"/>
    <text x="${m}" y="${m + fs * 0.38}" text-anchor="middle" fill="${COURSE_COLOR}"
          font-size="${fs}" font-weight="bold" font-family="'M PLUS Rounded 1c', sans-serif">${label}</text>
  </svg>`;
}

function _svgFinish(size = 30) {
  const m  = size / 2;
  const r1 = m - 2;
  const r2 = m - 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${r1}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
    <circle cx="${m}" cy="${m}" r="${r2}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
  </svg>`;
}

function _ctrlSvg(ctrl) {
  if (ctrl.type === 'start')  return _svgStart();
  if (ctrl.type === 'finish') return _svgFinish();
  return _svgControl(ctrl.code);
}

// ================================================================
// MapLibre マーカー管理
// ================================================================

function _createMarker(ctrl) {
  const el = document.createElement('div');
  el.className  = 'course-marker';
  el.innerHTML  = _ctrlSvg(ctrl);
  el.title = ctrl.type === 'start'  ? 'スタート（ドラッグで移動）'
           : ctrl.type === 'finish' ? 'フィニッシュ（ドラッグで移動）'
           : `コントロール ${ctrl.code}（ドラッグで移動）`;

  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
    draggable: true,
  })
    .setLngLat([ctrl.lng, ctrl.lat])
    .addTo(_map);

  // ドラッグ中: リアルタイムでレグ線を更新
  marker.on('drag', () => {
    const ll  = marker.getLngLat();
    ctrl.lng  = ll.lng;
    ctrl.lat  = ll.lat;
    _refreshLegs();
  });
  // ドラッグ終了: 統計再計算
  marker.on('dragend', () => {
    _scheduleCalc();
    _renderPanel();
  });

  return marker;
}

/** 全マーカーを削除して再構築する（コード変更など表示更新が必要な場合） */
function _rebuildMarkers() {
  _markers.forEach(({ marker }) => marker.remove());
  _markers = [];
  _plan.controls.forEach(ctrl => {
    const marker = _createMarker(ctrl);
    _markers.push({ id: ctrl.id, marker });
  });
}

function _removeMarker(id) {
  const idx = _markers.findIndex(m => m.id === id);
  if (idx === -1) return;
  _markers[idx].marker.remove();
  _markers.splice(idx, 1);
}

/** 指定コントロールのマーカー SVG を更新する（コード編集時などに使用） */
function _refreshMarkerSvg(ctrl) {
  const entry = _markers.find(m => m.id === ctrl.id);
  if (!entry) return;
  entry.marker.getElement().innerHTML = _ctrlSvg(ctrl);
}

// ================================================================
// コントロール追加・削除
// ================================================================

function _addControl(lng, lat) {
  const ctrls = _plan.controls;
  const n     = ctrls.length;

  let type, code;

  if (n === 0) {
    // 最初のクリックはスタート
    type = 'start';
    code = 'S';
  } else if (_drawFinish) {
    // フィニッシュ配置モード
    type       = 'finish';
    code       = 'F';
    _drawFinish = false;
  } else {
    // 通常コントロール
    type = 'control';
    // 既存コントロール番号の最大値 + 1
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
      _rebuildMarkers();
      _refreshLegs();
      _scheduleCalc();
      _renderPanel();
      return;
    }
  }

  ctrls.push(ctrl);
  const marker = _createMarker(ctrl);
  _markers.push({ id: ctrl.id, marker });

  // フィニッシュ追加後は描画モードを自動終了
  if (type === 'finish') {
    _setDrawMode(false);
  }

  _refreshLegs();
  _scheduleCalc();
  _renderPanel();
}

function _deleteControl(id) {
  const idx = _plan.controls.findIndex(c => c.id === id);
  if (idx === -1) return;
  _plan.controls.splice(idx, 1);
  _removeMarker(id);
  _renumberControls();
  _rebuildMarkers(); // 番号変更を反映
  _refreshLegs();
  _scheduleCalc();
  _renderPanel();
}

/** コントロール番号（101, 102...）を通し番号で振り直す */
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

  if (!_drawMode) {
    el.style.display = 'none';
    el.textContent   = '';
    return;
  }

  el.style.display = '';
  const hasStart  = _plan.controls.some(c => c.type === 'start');
  const hasFinish = _plan.controls.some(c => c.type === 'finish');

  if (!hasStart) {
    el.textContent = '地図をクリックしてスタート（△）を配置';
  } else if (_drawFinish) {
    el.textContent = '地図をクリックしてフィニッシュ（◎）を配置';
  } else if (hasFinish) {
    el.textContent = '地図をクリックでコントロールを追加（フィニッシュの前に挿入）';
  } else {
    el.textContent = '地図をクリックしてコントロール（○）を追加';
  }
}

// ================================================================
// パネル描画
// ================================================================

function _renderPanel() {
  const listEl      = document.getElementById('course-controls-list');
  const emptyEl     = document.getElementById('course-empty-msg');
  const statsSec    = document.getElementById('course-stats-section');
  const distEl      = document.getElementById('course-stat-dist');
  const climbEl     = document.getElementById('course-stat-climb');
  const countEl     = document.getElementById('course-stat-count');
  const clearBtn    = document.getElementById('course-clear-btn');
  const exportBtn   = document.getElementById('course-export-btn');
  if (!listEl) return;

  const ctrls = _plan.controls;
  const n     = ctrls.length;

  // 空メッセージ / ボタン活性
  if (emptyEl)   emptyEl.style.display   = n ? 'none' : '';
  if (statsSec)  statsSec.style.display  = n >= 2 ? '' : 'none';
  if (clearBtn)  clearBtn.disabled       = n === 0;
  if (exportBtn) exportBtn.disabled      = n === 0;

  // 合計距離（即時計算: Turf.distance の直線距離合計）
  let totalDist = 0;
  for (let i = 1; i < n; i++) {
    totalDist += turf.distance(
      turf.point([ctrls[i - 1].lng, ctrls[i - 1].lat]),
      turf.point([ctrls[i].lng,     ctrls[i].lat]),
      { units: 'kilometers' }
    );
  }
  if (distEl)  distEl.textContent  = n >= 2 ? totalDist.toFixed(2) + ' km' : '—';

  // 累積登高（非同期計算後のキャッシュから）
  if (climbEl) {
    if (_legStats.length > 0 && _legStats.every(s => s != null)) {
      const totalClimb = _legStats.reduce((s, l) => s + (l?.climb ?? 0), 0);
      climbEl.textContent = totalClimb + ' m';
    } else if (n < 2) {
      climbEl.textContent = '—';
    }
    // 計算中の場合は「計算中…」をそのまま維持（_recalcAll が変更）
  }

  // コントロール数
  const numCtrls = ctrls.filter(c => c.type === 'control').length;
  if (countEl) countEl.textContent = numCtrls + ' 個';

  // ---- コントロールリスト ----
  listEl.innerHTML = '';
  ctrls.forEach((ctrl, idx) => {
    // 当該コントロールへのレグ距離
    let legDist = null;
    if (idx > 0) {
      legDist = turf.distance(
        turf.point([ctrls[idx - 1].lng, ctrls[idx - 1].lat]),
        turf.point([ctrl.lng, ctrl.lat]),
        { units: 'kilometers' }
      );
    }
    const legStat = _legStats[idx - 1] ?? null; // 登高キャッシュ

    const row = document.createElement('div');
    row.className  = 'course-ctrl-item';
    row.dataset.id = ctrl.id;

    // ---- シンボル列 ----
    const symDiv      = document.createElement('div');
    symDiv.className  = 'course-ctrl-sym';
    symDiv.innerHTML  = _ctrlSvg(ctrl);

    // ---- 情報列 ----
    const infoDiv = document.createElement('div');
    infoDiv.className = 'course-ctrl-info';

    // タイプラベル or コード入力
    if (ctrl.type === 'start' || ctrl.type === 'finish') {
      const lbl = document.createElement('span');
      lbl.className   = 'course-ctrl-type-label';
      lbl.textContent = ctrl.type === 'start' ? 'スタート' : 'フィニッシュ';
      infoDiv.appendChild(lbl);
    } else {
      const inp = document.createElement('input');
      inp.type      = 'text';
      inp.className = 'course-ctrl-code-input';
      inp.value     = ctrl.code;
      inp.maxLength = 5;
      inp.title     = 'コントロールコードを編集';
      inp.addEventListener('change', () => {
        ctrl.code = inp.value.trim() || ctrl.code;
        inp.value = ctrl.code;
        _refreshMarkerSvg(ctrl);
      });
      infoDiv.appendChild(inp);
    }

    // レグ距離・登高
    if (legDist != null) {
      const statsDiv      = document.createElement('div');
      statsDiv.className  = 'course-ctrl-leg-stats';
      const climbStr      = legStat ? ` ↑${legStat.climb} m` : '';
      statsDiv.textContent = `↔ ${legDist.toFixed(2)} km${climbStr}`;
      infoDiv.appendChild(statsDiv);
    }

    // ---- 削除ボタン ----
    const delBtn       = document.createElement('button');
    delBtn.className   = 'course-ctrl-del';
    delBtn.title       = '削除';
    delBtn.innerHTML   = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener('click', () => _deleteControl(ctrl.id));

    row.appendChild(symDiv);
    row.appendChild(infoDiv);
    row.appendChild(delBtn);
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
    version:  1,
    name:     _plan.name,
    controls: _plan.controls.map(c => ({
      type: c.type,
      code: c.code,
      lng:  +c.lng.toFixed(7),
      lat:  +c.lat.toFixed(7),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${_plan.name || 'course'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _importJSON(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.controls)) throw new Error('controls フィールドがありません');
    _clearCourse(/* noConfirm */ true);
    if (data.name) {
      _plan.name = data.name;
      const nameInput = document.getElementById('course-name-input');
      if (nameInput) nameInput.value = _plan.name;
    }
    data.controls.forEach(c => {
      const ctrl = { id: 'c' + (_nextId++), type: c.type, lng: c.lng, lat: c.lat, code: c.code };
      _plan.controls.push(ctrl);
      const marker = _createMarker(ctrl);
      _markers.push({ id: ctrl.id, marker });
    });
    _refreshLegs();
    _scheduleCalc();
    _renderPanel();
    // コース全体が見える範囲にフィット
    if (_plan.controls.length > 0) {
      const coords = _plan.controls.map(c => [c.lng, c.lat]);
      const bbox = [
        Math.min(...coords.map(c => c[0])),
        Math.min(...coords.map(c => c[1])),
        Math.max(...coords.map(c => c[0])),
        Math.max(...coords.map(c => c[1])),
      ];
      // 同一点の場合は単点フライト
      if (bbox[0] === bbox[2] && bbox[1] === bbox[3]) {
        _map.flyTo({ center: [bbox[0], bbox[1]], zoom: 15, duration: 600 });
      } else {
        _map.fitBounds(bbox, { padding: 100, duration: 600 });
      }
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
  _markers.forEach(({ marker }) => marker.remove());
  _markers      = [];
  _legStats     = [];
  _plan.controls = [];
  if (_calcAbort) _calcAbort.aborted = true;
  _refreshLegs();
  _renderPanel();
}

// ================================================================
// UI イベント設定
// ================================================================

function _setupUI() {
  // コース名入力
  const nameInput = document.getElementById('course-name-input');
  if (nameInput) {
    nameInput.value = _plan.name;
    nameInput.addEventListener('input', () => { _plan.name = nameInput.value || 'コース'; });
  }

  // 描画モードトグル
  document.getElementById('course-draw-toggle')?.addEventListener('click', () => {
    _setDrawMode(!_drawMode);
  });

  // フィニッシュ追加ボタン
  document.getElementById('course-add-finish-btn')?.addEventListener('click', () => {
    _drawFinish = true;
    if (!_drawMode) _setDrawMode(true);
    _updateDrawHint();
    _updateDrawModeUI();
  });

  // JSON 書き出し
  document.getElementById('course-export-btn')?.addEventListener('click', _exportJSON);

  // JSON 読み込み
  const importFileEl = document.getElementById('course-import-file');
  document.getElementById('course-import-btn')?.addEventListener('click', () => {
    importFileEl?.click();
  });
  importFileEl?.addEventListener('change', () => {
    const f = importFileEl.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload  = e => _importJSON(e.target.result);
    reader.readAsText(f);
    importFileEl.value = '';
  });

  // コースクリア
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

  // レグ線の GeoJSON ソース・レイヤーを追加
  map.addSource('course-legs-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id:     'course-legs',
    type:   'line',
    source: 'course-legs-source',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color':     COURSE_COLOR,
      'line-width':     1.5,
      'line-dasharray': [5, 2.5],
      'line-opacity':   0.9,
    },
  });

  _setupUI();
}

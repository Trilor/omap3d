/* ================================================================
   course.js — コースプランナーモジュール（v3）
   Purple Pen 互換リレーショナル構造

   データモデル:
   · _controlDefs (Map) — コントロール定義マスターリスト（物理ポイントの実体）
   · _courses[]         — コース一覧（各コースは defId の順番リストを保持）
   · マスター座標変更 → _refreshSource() 1回で全コース即時同期（同一 WebGL フレーム）

   エクスポート:
   · JSON v2 形式（マスター + コース参照リスト）
   · IOF XML 3.0 形式（Purple Pen 互換）
   ================================================================ */

import { QCHIZU_DEM_BASE, DEM5A_BASE } from './config.js';

// ================================================================
// 定数
// ================================================================
const COURSE_COLOR   = '#c020c0';  // IOF コースオーバープリント（パープルマゼンタ）
const CLIMB_ZOOM     = 14;         // 登高計算用 DEM ズームレベル
const CLIMB_SAMPLE_M = 10;         // 登高サンプリング間隔（m）

// ================================================================
// マップ参照
// ================================================================
let _map = null;

// ================================================================
// データモデル（Purple Pen 互換リレーショナル構造）
// ================================================================

/**
 * コントロール定義マスターリスト（物理コントロールポイントの実体）
 * key: defId (string)
 * value: { defId, type:'start'|'control', code:string, lng:number, lat:number }
 *
 * ※ type はすべて小文字（IOF XML エクスポート時に Pascal ケースに変換）
 * ※ コース末尾の 'control' は auto-finish として描画・エクスポート（二重円）
 */
const _controlDefs = new Map();

/**
 * コース一覧
 * { id:string, name:string, sequence:string[] }
 * sequence = defId の配列。同一 defId が複数回登場可能（同一ポイント再訪）
 */
const _courses = [{ id: 'course0', name: 'コース1', sequence: [] }];

let _activeCourseIdx = 0;   // アクティブコースの index
let _nextDefId       = 0;   // defId 生成カウンタ
let _drawMode        = false;
let _calcTimer       = null;
let _legStats        = [];  // [{distKm, climb, descent}] レグ統計キャッシュ
let _calcAbort       = null;
let _dragDef         = null;  // ドラッグ中のマスター定義（_controlDefs の value への参照）
let _activeTab       = 'course'; // 'course' | 'controls'

// ================================================================
// シーケンス解決ヘルパー
// ================================================================

function _activeCourse() { return _courses[_activeCourseIdx]; }

/**
 * アクティブコースのシーケンスを解決し、描画・計算に必要な情報配列を返す。
 *
 * 各要素: { def, seqIdx, seq, isFinish }
 *   def      — _controlDefs のエントリ（マスターへの参照）
 *   seqIdx   — course.sequence 内のインデックス（削除処理に使用）
 *   seq      — 地図ラベル用連番（'control' かつ非 finish の場合のみ 1 始まり）
 *   isFinish — コース末尾の 'control' かつ 2 点以上の場合 true（auto-finish）
 */
function _buildSequenceInfo() {
  const course  = _activeCourse();
  const seqArr  = course.sequence;
  const lastIdx = seqArr.length - 1;
  let ctrlSeq = 0;
  const result = [];

  seqArr.forEach((defId, seqIdx) => {
    const def = _controlDefs.get(defId);
    if (!def) return;
    const isFinish = def.type === 'control' && seqIdx === lastIdx && seqArr.length >= 2;
    const seq = (def.type === 'control' && !isFinish) ? ++ctrlSeq : 0;
    result.push({ def, seqIdx, seq, isFinish });
  });

  return result;
}

// ================================================================
// DEM タイル直接サンプリング（登高計算用）
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
  const line   = turf.lineString([[from.lng, from.lat], [to.lng, to.lat]]);
  const distKm = turf.length(line, { units: 'kilometers' });
  const distM  = distKm * 1000;
  const steps  = Math.max(2, Math.ceil(distM / CLIMB_SAMPLE_M));

  const promises = [];
  for (let i = 0; i <= steps; i++) {
    const pt = turf.along(line, (i / steps) * distKm, { units: 'kilometers' });
    const [lng, lat] = pt.geometry.coordinates;
    promises.push(_elevAt(lng, lat));
  }
  const elevs = await Promise.all(promises);
  if (abortFlag.aborted) return null;

  let climb = 0, descent = 0;
  for (let i = 1; i < elevs.length; i++) {
    if (elevs[i] != null && elevs[i - 1] != null) {
      const d = elevs[i] - elevs[i - 1];
      if (d > 0) climb   += d;
      else        descent -= d; // descent は正値で保持
    }
  }
  return { distKm, climb: Math.round(climb), descent: Math.round(descent) };
}

async function _recalcAll() {
  if (_calcAbort) _calcAbort.aborted = true;
  const abortFlag = { aborted: false };
  _calcAbort = abortFlag;

  const seqInfo = _buildSequenceInfo();
  if (seqInfo.length < 2) { _legStats = []; _renderPanel(); return; }

  const climbEl = document.getElementById('course-stat-climb');
  if (climbEl) climbEl.textContent = '計算中…';

  const results = await Promise.all(
    seqInfo.slice(1).map((item, i) =>
      _calcLegStats(seqInfo[i].def, item.def, abortFlag)
    )
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
 * アクティブコースの全フィーチャーを 1 つの FeatureCollection にまとめる。
 * マスター定義の座標を直接参照するため、座標変更が全コースに即時反映される。
 */
function _buildSourceData() {
  const features = [];
  const seqInfo  = _buildSequenceInfo();

  seqInfo.forEach(({ def, seq, isFinish }) => {
    const label = (def.type === 'control' && !isFinish) ? String(seq) : '';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [def.lng, def.lat] },
      properties: { id: def.defId, type: def.type, seq, label, isFinish },
    });
  });

  if (seqInfo.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: seqInfo.map(({ def }) => [def.lng, def.lat]),
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
// カーソルプレビュー（描画モード中）
// ================================================================

function _buildPreviewData(lngLat) {
  const features = [];
  const course   = _activeCourse();
  const previewType = course.sequence.length === 0 ? 'start' : 'control';

  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] },
    properties: { previewType },
  });

  if (course.sequence.length > 0) {
    const lastDef = _controlDefs.get(course.sequence[course.sequence.length - 1]);
    if (lastDef) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[lastDef.lng, lastDef.lat], [lngLat.lng, lngLat.lat]],
        },
        properties: { previewType: 'leg' },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

function _updateCursorPreview(e) {
  const src = _map?.getSource('course-preview-source');
  if (!src) return;

  // 既存コントロールへのスナップ判定
  const hits = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
  let lngLat;
  let snapping = false;
  if (hits.length > 0) {
    const [lng, lat] = hits[0].geometry.coordinates;
    lngLat  = { lng, lat };
    snapping = true;
  } else {
    lngLat = e.lngLat;
  }

  // スナップ時はシンボルを不透明に（吸い付き感を強調）
  const opacity = snapping ? 0.9 : 0.45;
  _map.setPaintProperty('course-preview-circle', 'circle-stroke-opacity', opacity);
  _map.setPaintProperty('course-preview-start',  'icon-opacity',           opacity);

  src.setData(_buildPreviewData(lngLat));
}

function _clearPreview() {
  const src = _map?.getSource('course-preview-source');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

function _initPreviewLayers() {
  _map.addSource('course-preview-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // プレビュー用レグ線
  _map.addLayer({
    id: 'course-preview-leg', type: 'line', source: 'course-preview-source',
    filter: ['==', ['get', 'previewType'], 'leg'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': COURSE_COLOR, 'line-width': 1.5,
      'line-dasharray': [5, 2.5], 'line-opacity': 0.45,
    },
  }, 'course-hit');

  // プレビュー用コントロール円
  _map.addLayer({
    id: 'course-preview-circle', type: 'circle', source: 'course-preview-source',
    filter: ['==', ['get', 'previewType'], 'control'],
    paint: {
      'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': COURSE_COLOR, 'circle-stroke-width': 2.2,
      'circle-stroke-opacity': 0.45,
    },
  }, 'course-hit');

  // プレビュー用スタート三角
  _map.addLayer({
    id: 'course-preview-start', type: 'symbol', source: 'course-preview-source',
    filter: ['==', ['get', 'previewType'], 'start'],
    layout: {
      'icon-image': 'course-start-tri', 'icon-size': 1,
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 0.45 },
  }, 'course-hit');
}

// ================================================================
// スタートシンボル（△）画像のロード
// ================================================================

function _loadStartImage() {
  if (_map.hasImage('course-start-tri')) return;
  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const m = SIZE / 2, r = SIZE * 0.36;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.beginPath();
  ctx.moveTo(m, m - r * 1.15);
  ctx.lineTo(m + r, m + r * 0.58);
  ctx.lineTo(m - r, m + r * 0.58);
  ctx.closePath();
  ctx.strokeStyle = COURSE_COLOR;
  ctx.lineWidth   = 4.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();
  // ImageData として取り出して登録（HTMLCanvasElement は addImage 非対応）
  const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
  _map.addImage('course-start-tri', imgData, { pixelRatio: 2, sdf: false });
}

// ================================================================
// MapLibre レイヤー初期化
// ================================================================

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
      'line-color': COURSE_COLOR, 'line-width': 1.5,
      'line-dasharray': [5, 2.5], 'line-opacity': 0.9,
    },
  });

  // ② コントロール外円（type='control' 全て：フィニッシュも含む）
  _map.addLayer({
    id: 'course-ctrl-outer', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'type'], 'control'],
    paint: {
      'circle-radius': 12, 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': COURSE_COLOR, 'circle-stroke-width': 2.2,
    },
  });

  // ③ フィニッシュ内円（isFinish=true の最後のコントロールのみ）
  _map.addLayer({
    id: 'course-finish-inner', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'isFinish'], true],
    paint: {
      'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': COURSE_COLOR, 'circle-stroke-width': 2,
    },
  });

  // ④ スタート三角
  _map.addLayer({
    id: 'course-start-icon', type: 'symbol', source: 'course-source',
    filter: ['==', ['get', 'type'], 'start'],
    layout: {
      'icon-image': 'course-start-tri', 'icon-size': 1,
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });

  // ⑤ コントロール番号ラベル（円の上に表示）
  _map.addLayer({
    id: 'course-labels', type: 'symbol', source: 'course-source',
    filter: ['==', ['get', 'type'], 'control'],
    layout: {
      'text-field':            ['get', 'label'],
      'text-size':             11,
      'text-font':             ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-anchor':           'bottom',
      'text-offset':           [0, -1.1],
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': COURSE_COLOR },
  });

  // ⑥ インタラクション用透明ヒット領域（最前面）
  _map.addLayer({
    id: 'course-hit', type: 'circle', source: 'course-source',
    filter: ['!=', ['get', 'type'], 'leg'],
    paint: { 'circle-radius': 18, 'circle-color': 'rgba(0,0,0,0)', 'circle-opacity': 0 },
  });
}

// ================================================================
// ドラッグ実装（mousedown → mousemove → mouseup）
// マスター定義を直接更新 → 全コースが同一 WebGL フレームで反映
// ================================================================

function _startDrag(e) {
  if (_drawMode) return; // 描画モード中はドラッグ無効（クリックでスナップ追加）
  if (!e.features?.length) return;
  const defId = e.features[0].properties.id;
  _dragDef = _controlDefs.get(defId);
  if (!_dragDef) return;

  e.preventDefault();
  _map.dragPan.disable();
  _map.getCanvas().style.cursor = 'grabbing';

  _map.on('mousemove', _onDrag);
  _map.once('mouseup', _endDrag);
}

function _onDrag(e) {
  if (!_dragDef) return;
  // マスター定義の座標を更新 → 全コースに自動反映（同一 WebGL フレーム）
  _dragDef.lng = e.lngLat.lng;
  _dragDef.lat = e.lngLat.lat;
  _refreshSource();
}

function _endDrag() {
  _map.dragPan.enable();
  _map.getCanvas().style.cursor = _drawMode ? 'crosshair' : '';
  _map.off('mousemove', _onDrag);
  if (_dragDef) {
    _dragDef = null;
    _scheduleCalc();
    _renderPanel();
  }
}

// ================================================================
// コントロール追加・削除
// ================================================================

/**
 * 新しいコントロール定義をマスターに登録し、アクティブコースのシーケンスに追加する。
 */
function _addControl(lng, lat) {
  const course  = _activeCourse();
  const isFirst = course.sequence.length === 0;
  const type    = isFirst ? 'start' : 'control';

  // code の自動採番（'control' のみ 101, 102...）
  const ctrlCount = [..._controlDefs.values()].filter(d => d.type === 'control').length;
  const code = type === 'control' ? String(101 + ctrlCount) : '';

  const def = { defId: 'd' + (_nextDefId++), type, code, lng, lat };
  _controlDefs.set(def.defId, def);
  course.sequence.push(def.defId);

  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

/**
 * アクティブコースのシーケンスの seqIdx 番目を削除する。
 * 全コースで未使用ならマスターからも削除。
 */
function _deleteFromSequence(seqIdx) {
  const course = _activeCourse();
  const [defId] = course.sequence.splice(seqIdx, 1);

  // 全コースで未使用ならマスターからも削除
  const usedElsewhere = _courses.some(c => c.sequence.includes(defId));
  if (!usedElsewhere) _controlDefs.delete(defId);

  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

/**
 * マスターから def を削除し、全コースのシーケンスからも除去する。
 * 全コントロールタブの「削除」ボタン用。
 */
function _deleteDefFromAll(defId) {
  _controlDefs.delete(defId);
  _courses.forEach(c => {
    c.sequence = c.sequence.filter(id => id !== defId);
  });
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

// ================================================================
// 描画モード制御
// ================================================================

function _onMapClick(e) {
  const hits = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
  if (hits.length > 0) {
    // 既存コントロールにスナップして同一座標で追加
    const [lng, lat] = hits[0].geometry.coordinates;
    _addControl(lng, lat);
    _updateDrawHint();
    return;
  }
  _addControl(e.lngLat.lng, e.lngLat.lat);
  _updateDrawHint();
}

function _setDrawMode(active) {
  _drawMode = active;
  if (active) {
    _map.getCanvas().style.cursor = 'crosshair';
    _map.on('click', _onMapClick);
    _map.on('mousemove', _updateCursorPreview);
    _map.getCanvas().addEventListener('mouseleave', _clearPreview);
  } else {
    _map.getCanvas().style.cursor = '';
    _map.off('click', _onMapClick);
    _map.off('mousemove', _updateCursorPreview);
    _map.getCanvas().removeEventListener('mouseleave', _clearPreview);
    _clearPreview();
  }
  _updateDrawModeUI();
  _updateDrawHint();
}

function _updateDrawModeUI() {
  const btn = document.getElementById('course-draw-toggle');
  if (!btn) return;
  if (_drawMode) {
    btn.classList.add('course-draw-active');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> 描画終了`;
  } else {
    btn.classList.remove('course-draw-active');
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 描画開始`;
  }
}

function _updateDrawHint() {
  const el = document.getElementById('course-draw-hint');
  if (!el) return;
  if (!_drawMode) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  const course = _activeCourse();
  if (course.sequence.length === 0)
    el.textContent = '地図をクリックしてスタート（△）を配置';
  else
    el.textContent = '地図をクリックしてコントロール（○）を追加。最後が自動でフィニッシュ（◎）になります';
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

function _svgControl(size = 24) {
  const m = size / 2, r = m - 1.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${r}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
  </svg>`;
}

function _svgFinish(size = 24) {
  const m = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${m}" cy="${m}" r="${m - 1.5}" fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
    <circle cx="${m}" cy="${m}" r="${m - 5}"   fill="none" stroke="${COURSE_COLOR}" stroke-width="2"/>
  </svg>`;
}

function _ctrlSvg(def, isFinish) {
  if (def.type === 'start') return _svgStart();
  if (isFinish)             return _svgFinish();
  return _svgControl();
}

// ================================================================
// パネル描画（2タブ）
// ================================================================

function _renderPanel() {
  _updateDrawModeUI();
  _updateDrawHint();
  _updateTabUI();
  if (_activeTab === 'course')   _renderCourseTab();
  else                           _renderDefsTab();
}

/** タブボタンのアクティブ状態を更新 */
function _updateTabUI() {
  document.querySelectorAll('.course-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === _activeTab);
  });
  document.querySelectorAll('.course-tab-pane').forEach(pane => {
    pane.style.display = pane.dataset.tab === _activeTab ? '' : 'none';
  });
}

/** コースタブ：アクティブコースのシーケンス一覧 + 統計 */
function _renderCourseTab() {
  const listEl   = document.getElementById('course-controls-list');
  const emptyEl  = document.getElementById('course-empty-msg');
  const statsSec = document.getElementById('course-stats-section');
  const distEl   = document.getElementById('course-stat-dist');
  const climbEl  = document.getElementById('course-stat-climb');
  const countEl  = document.getElementById('course-stat-count');
  const clearBtn = document.getElementById('course-clear-btn');
  const exportBtn= document.getElementById('course-export-btn');
  const xmlBtn   = document.getElementById('course-xml-btn');
  if (!listEl) return;

  const seqInfo = _buildSequenceInfo();
  const n = seqInfo.length;

  if (emptyEl)   emptyEl.style.display  = n ? 'none' : '';
  if (statsSec)  statsSec.style.display = n >= 2 ? '' : 'none';
  if (clearBtn)  clearBtn.disabled      = n === 0;
  if (exportBtn) exportBtn.disabled     = n === 0;
  if (xmlBtn)    xmlBtn.disabled        = n === 0;

  // 合計距離（即時）
  let totalDist = 0;
  for (let i = 1; i < n; i++) {
    totalDist += turf.distance(
      turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
      turf.point([seqInfo[i].def.lng,     seqInfo[i].def.lat]),
      { units: 'kilometers' }
    );
  }
  if (distEl) distEl.textContent = n >= 2 ? Math.round(totalDist * 1000) + ' m' : '—';

  // 累積登高
  if (climbEl) {
    if (_legStats.length > 0 && _legStats.every(s => s != null)) {
      const totalClimb   = _legStats.reduce((s, l) => s + (l?.climb   ?? 0), 0);
      const totalDescent = _legStats.reduce((s, l) => s + (l?.descent ?? 0), 0);
      climbEl.innerHTML =
        `<span class="course-elev-up">↑${totalClimb} m</span>` +
        `<span class="course-elev-dn">↓${totalDescent} m</span>`;
    } else if (n < 2) {
      climbEl.textContent = '—';
    }
  }

  // コントロール数（スタートを除く）
  const numCtrls = seqInfo.filter(item => item.def.type === 'control').length;
  if (countEl) countEl.textContent = numCtrls + ' 個';

  // コントロールリスト
  listEl.innerHTML = '';
  seqInfo.forEach(({ def, seqIdx, seq, isFinish }, i) => {
    const legDist = i > 0
      ? turf.distance(
          turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
          turf.point([def.lng, def.lat]),
          { units: 'kilometers' }
        )
      : null;
    const legStat = _legStats[i - 1] ?? null;

    const row = document.createElement('div');
    row.className = 'course-ctrl-item'; row.dataset.seqIdx = seqIdx;

    const symDiv = document.createElement('div');
    symDiv.className = 'course-ctrl-sym';
    symDiv.innerHTML = _ctrlSvg(def, isFinish);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'course-ctrl-info';

    if (def.type === 'start') {
      const lbl = document.createElement('span');
      lbl.className = 'course-ctrl-type-label';
      lbl.textContent = 'スタート';
      infoDiv.appendChild(lbl);
    } else {
      const labelRow = document.createElement('div');
      labelRow.className = 'course-ctrl-label-row';

      if (isFinish) {
        const badge = document.createElement('span');
        badge.className = 'course-ctrl-finish-badge';
        badge.textContent = 'F';
        badge.title = 'フィニッシュ（最後のコントロール）';
        labelRow.appendChild(badge);
      } else {
        const seqBadge = document.createElement('span');
        seqBadge.className = 'course-ctrl-seq-badge';
        seqBadge.textContent = seq;
        labelRow.appendChild(seqBadge);
      }

      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'course-ctrl-code-input';
      inp.value = def.code; inp.maxLength = 6;
      inp.title = 'コントロールコード（マスターに反映）';
      inp.addEventListener('change', () => {
        def.code = inp.value.trim() || def.code; // マスター定義を直接更新
        inp.value = def.code;
      });
      labelRow.appendChild(inp);
      infoDiv.appendChild(labelRow);
    }

    if (legDist != null) {
      const statsDiv = document.createElement('div');
      statsDiv.className = 'course-ctrl-leg-stats';
      if (legStat) {
        const upPart   = legStat.climb   > 0 ? `<span class="course-elev-up">↑${legStat.climb} m</span>`   : '';
        const downPart = legStat.descent > 0 ? `<span class="course-elev-dn">↓${legStat.descent} m</span>` : '';
        statsDiv.innerHTML =
          `<span class="course-leg-dist">↔ ${Math.round(legDist * 1000)} m</span>` +
          (upPart || downPart ? `<span class="course-leg-elev">${upPart}${downPart}</span>` : '');
      } else {
        statsDiv.textContent = `↔ ${Math.round(legDist * 1000)} m`;
      }
      infoDiv.appendChild(statsDiv);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'course-ctrl-del'; delBtn.title = 'このシーケンスから削除';
    delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener('click', () => _deleteFromSequence(seqIdx));

    row.appendChild(symDiv); row.appendChild(infoDiv); row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

/** 全コントロールタブ：マスターリスト（_controlDefs）を一覧表示 */
function _renderDefsTab() {
  const listEl = document.getElementById('course-defs-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (_controlDefs.size === 0) {
    listEl.innerHTML = '<div class="course-empty-msg" style="display:flex"><span>コントロールがありません</span></div>';
    return;
  }

  // 各コースで何番目に使われているかを逆引きマップ（defId → [コース名: seq...] の説明文）
  const usageMap = new Map(); // defId → usage string
  _courses.forEach(course => {
    let ctrlSeq = 0;
    course.sequence.forEach((defId, idx) => {
      const def = _controlDefs.get(defId);
      if (!def) return;
      const isFinish = def.type === 'control' && idx === course.sequence.length - 1 && course.sequence.length >= 2;
      const seq = (def.type === 'control' && !isFinish) ? ++ctrlSeq : 0;
      const label = def.type === 'start' ? 'S' : isFinish ? 'F' : String(seq);
      const existing = usageMap.get(defId) ?? [];
      existing.push(label);
      usageMap.set(defId, existing);
    });
  });

  _controlDefs.forEach((def) => {
    const usageLabels = usageMap.get(def.defId) ?? [];
    const isStart = def.type === 'start';

    const row = document.createElement('div');
    row.className = 'course-ctrl-item course-def-item';

    const symDiv = document.createElement('div');
    symDiv.className = 'course-ctrl-sym';
    // マスタービューでは finish 判定なし（シンボルは type で決定）
    symDiv.innerHTML = isStart ? _svgStart() : _svgControl();

    const infoDiv = document.createElement('div');
    infoDiv.className = 'course-ctrl-info';

    const codeRow = document.createElement('div');
    codeRow.className = 'course-ctrl-label-row';

    if (isStart) {
      const lbl = document.createElement('span');
      lbl.className = 'course-ctrl-type-label';
      lbl.textContent = 'スタート';
      codeRow.appendChild(lbl);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'course-ctrl-code-input';
      inp.value = def.code; inp.maxLength = 6;
      inp.title = 'コントロールコード（編集可）';
      inp.addEventListener('change', () => {
        def.code = inp.value.trim() || def.code;
        inp.value = def.code;
        // コースタブ側も更新
        if (_activeTab === 'course') _renderCourseTab();
      });
      codeRow.appendChild(inp);
    }
    infoDiv.appendChild(codeRow);

    // 使用状況（どのコースの何番目か）
    if (usageLabels.length > 0) {
      const usage = document.createElement('div');
      usage.className = 'course-ctrl-leg-stats';
      usage.textContent = '使用: ' + usageLabels.join(', ');
      infoDiv.appendChild(usage);
    } else {
      const unused = document.createElement('div');
      unused.className = 'course-ctrl-leg-stats course-def-unused';
      unused.textContent = '未使用';
      infoDiv.appendChild(unused);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'course-ctrl-del'; delBtn.title = 'マスターから削除（全コースから除去）';
    delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener('click', () => {
      if (!confirm(`コントロール「${def.code || def.defId}」を全コースから削除しますか？`)) return;
      _deleteDefFromAll(def.defId);
    });

    row.appendChild(symDiv); row.appendChild(infoDiv); row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

// ================================================================
// IOF XML 3.0 エクスポート
// ================================================================

function _escXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * IOF XML 3.0 形式でエクスポートする。
 * · Control 定義 — マスターリストから生成（重複なし）
 * · CourseControl — コースシーケンスから生成（同一 ID が複数回登場可能）
 * · auto-finish   — コース末尾の 'control' は type="Finish" でエクスポート
 */
function _exportIOFXML() {
  const seqInfo = _buildSequenceInfo();
  if (seqInfo.length === 0) return;

  const course = _activeCourse();
  const now    = new Date().toISOString();

  // Control ID: code が設定済みなら code、未設定なら defId を使用
  const defXmlId = (def) => (def.code && def.code.trim()) ? def.code.trim() : def.defId;

  // IOF XML の type 文字列（Pascal ケース）
  const xmlType = (def, isFinish) =>
    def.type === 'start' ? 'Start' : isFinish ? 'Finish' : 'Control';

  // ユニークな Control 定義を収集（コース使用分のみ）
  // 同一 defId がシーケンスに複数回登場しても 1 つの Control 要素として出力
  const seenDefs = new Map(); // defId → { def, isFinish }
  seqInfo.forEach(({ def, isFinish }) => {
    if (!seenDefs.has(def.defId)) {
      seenDefs.set(def.defId, { def, isFinish });
    } else if (isFinish) {
      seenDefs.get(def.defId).isFinish = true;
    }
  });

  // Control 要素 XML
  const controlsXml = [...seenDefs.values()].map(({ def, isFinish }) =>
    `    <Control type="${xmlType(def, isFinish)}">\n` +
    `      <Id>${_escXml(defXmlId(def))}</Id>\n` +
    `      <Position lng="${def.lng.toFixed(9)}" lat="${def.lat.toFixed(9)}" />\n` +
    `    </Control>`
  ).join('\n');

  // 合計距離（m）
  let totalM = 0;
  for (let i = 1; i < seqInfo.length; i++) {
    totalM += turf.distance(
      turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
      turf.point([seqInfo[i].def.lng,     seqInfo[i].def.lat]),
      { units: 'kilometers' }
    ) * 1000;
  }

  // CourseControl 要素 XML
  const courseControlsXml = seqInfo.map(({ def, seq, isFinish }, i) => {
    const type = xmlType(def, isFinish);
    const legM = i > 0
      ? Math.round(turf.distance(
          turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
          turf.point([def.lng, def.lat]),
          { units: 'kilometers' }
        ) * 1000)
      : null;

    let inner = `        <Control>${_escXml(defXmlId(def))}</Control>`;
    if (type === 'Control') inner += `\n        <MapText>${seq}</MapText>`;
    if (legM != null)       inner += `\n        <LegLength>${legM}</LegLength>`;

    return `      <CourseControl type="${type}">\n${inner}\n      </CourseControl>`;
  }).join('\n');

  const xml =
`<?xml version="1.0" encoding="utf-8"?>
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0" iofVersion="3.0" createTime="${now}" creator="TeleDrop">
  <Event>
    <Name>${_escXml(course.name)}</Name>
  </Event>
  <RaceCourseData>
${controlsXml}
    <Course>
      <Name>${_escXml(course.name)}</Name>
      <Length>${Math.round(totalM)}</Length>
${courseControlsXml}
    </Course>
  </RaceCourseData>
</CourseData>`;

  const blob = new Blob([xml], { type: 'application/xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${course.name || 'course'}.xml`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ================================================================
// JSON エクスポート / インポート（v2 形式）
// ================================================================

function _exportJSON() {
  const course = _activeCourse();

  // 使用中の def のみ出力（未使用の def は除外）
  const usedDefIds = new Set(_courses.flatMap(c => c.sequence));
  const controlDefs = {};
  usedDefIds.forEach(id => {
    const def = _controlDefs.get(id);
    if (def) controlDefs[id] = {
      type: def.type, code: def.code,
      lng: +def.lng.toFixed(7), lat: +def.lat.toFixed(7),
    };
  });

  const data = {
    version: 2,
    controlDefs,
    courses: _courses.map(c => ({ id: c.id, name: c.name, sequence: [...c.sequence] })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${course.name || 'course'}.json`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function _importJSON(text) {
  try {
    const data = JSON.parse(text);
    _clearCourse(true);

    if (data.version === 2) {
      // v2: リレーショナル形式
      Object.entries(data.controlDefs ?? {}).forEach(([id, def]) => {
        _controlDefs.set(id, { defId: id, type: def.type, code: def.code ?? '', lng: def.lng, lat: def.lat });
        const num = parseInt(id.replace(/^\D+/, ''), 10);
        if (!isNaN(num) && num >= _nextDefId) _nextDefId = num + 1;
      });
      if (Array.isArray(data.courses) && data.courses.length > 0) {
        data.courses.forEach((c, i) => {
          if (i < _courses.length) {
            _courses[i].id       = c.id ?? _courses[i].id;
            _courses[i].name     = c.name ?? _courses[i].name;
            _courses[i].sequence = [...(c.sequence ?? [])];
          }
        });
        const nameEl = document.getElementById('course-name-input');
        if (nameEl) nameEl.value = _activeCourse().name;
      }
    } else {
      // v1 互換: 旧フラット形式 { controls: [{type, seq, code, lng, lat}] }
      if (!Array.isArray(data.controls)) throw new Error('controls フィールドがありません');
      if (data.name) {
        _activeCourse().name = data.name;
        const nameEl = document.getElementById('course-name-input');
        if (nameEl) nameEl.value = data.name;
      }
      data.controls.forEach(c => {
        const defId = 'd' + (_nextDefId++);
        const def   = { defId, type: c.type, code: c.code ?? '', lng: c.lng, lat: c.lat };
        _controlDefs.set(defId, def);
        _activeCourse().sequence.push(defId);
      });
    }

    _refreshSource();
    _scheduleCalc();
    _renderPanel();

    // コントロールが存在すれば地図を移動
    const seqInfo = _buildSequenceInfo();
    if (seqInfo.length > 0) {
      const lngs = seqInfo.map(i => i.def.lng);
      const lats  = seqInfo.map(i => i.def.lat);
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

  const course = _activeCourse();
  // 他のコースで使われていない def をマスターから削除
  const keepSet = new Set(
    _courses.flatMap((c, ci) => ci === _activeCourseIdx ? [] : c.sequence)
  );
  course.sequence.forEach(id => { if (!keepSet.has(id)) _controlDefs.delete(id); });
  course.sequence = [];
  _legStats = [];

  _refreshSource();
  _renderPanel();
}

// ================================================================
// UI イベント設定
// ================================================================

function _setupUI() {
  const nameInput = document.getElementById('course-name-input');
  if (nameInput) {
    nameInput.value = _activeCourse().name;
    nameInput.addEventListener('input', () => { _activeCourse().name = nameInput.value || 'コース'; });
  }

  document.getElementById('course-draw-toggle')?.addEventListener('click', () => {
    _setDrawMode(!_drawMode);
  });

  // タブ切り替え
  document.querySelectorAll('.course-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _renderPanel();
    });
  });

  document.getElementById('course-export-btn')?.addEventListener('click', _exportJSON);
  document.getElementById('course-xml-btn')?.addEventListener('click', _exportIOFXML);

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
    if (_activeCourse().sequence.length === 0) return;
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

  _initLayers();
  _initPreviewLayers();

  // ドラッグ: course-hit レイヤー上の mousedown でカスタムドラッグ開始
  map.on('mousedown', 'course-hit', _startDrag);

  // ホバーカーソル（描画モード中は crosshair のまま）
  map.on('mouseenter', 'course-hit', () => {
    if (!_dragDef && !_drawMode) map.getCanvas().style.cursor = 'grab';
  });
  map.on('mouseleave', 'course-hit', () => {
    if (!_dragDef) map.getCanvas().style.cursor = _drawMode ? 'crosshair' : '';
  });

  _setupUI();
}

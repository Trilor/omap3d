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

import { QCHIZU_DEM_BASE, DEM5A_BASE, ROUTE_COLORS, routeColor } from './config.js';

// ================================================================
// 定数
// ================================================================
const COURSE_COLOR   = '#c020c0';  // IOF コースオーバープリント（パープルマゼンタ）
const CLIMB_ZOOM     = 14;         // 登高計算用 DEM ズームレベル
const CLIMB_SAMPLE_M = 10;         // 登高サンプリング間隔（m）
const SELECT_COLOR   = '#ff8800';  // 選択中コントロールのハイライト色

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
 * { id:string, name:string, sequence:string[], legRoutes:{[legKey]:Route[]} }
 * sequence   = defId の配列。同一 defId が複数回登場可能（同一ポイント再訪）
 * legRoutes  = レッグごとのルートチョイス配列
 *              key: legKey(fromId, toId)
 *              value: [{ id, colorIdx, coords:[[lng,lat],...] }]
 */
const _courses = [{ id: 'course0', name: 'コース1', sequence: [], legRoutes: {} }];

let _activeCourseIdx = 0;   // アクティブコースの index
let _nextDefId       = 0;   // defId 生成カウンタ
let _nextRouteId     = 0;   // ルート ID 生成カウンタ
let _drawMode        = false;
let _calcTimer       = null;
let _legStats        = [];  // [{distKm, climb, descent}] レグ統計キャッシュ
let _calcAbort       = null;
const _selectedRoutes   = new Map(); // legKey → routeId | null（null = 直結）
const _routeStatsCache  = new Map(); // routeId → { distKm, climb, descent } | null
let _openDdMenu      = null;  // 現在開いているドロップダウンメニュー（body 配下）
let _dragCtrl        = null;  // ドラッグ中のコントロール定義（_controlDefs の value）
let _activeCtrlId    = null;  // 選択中コントロールの defId（選択モード）
let _activeTab       = 'course'; // 'course' | 'controls'
let _previewSnapping = false;    // 前フレームのスナップ状態（setPaintProperty 呼び出し抑制用）

/**
 * ルートチョイス描画状態
 * null = 非アクティブ
 * { legKey, fromId, toId, pts:[[lng,lat],...] }  = 描画中（pts はクリック済み中間点）
 */
let _routeDraw = null;

/**
 * ルートチョイス頂点編集状態
 * null = 非アクティブ
 * { legKey, routeId, dragPtIdx:number|null }
 */
let _editRoute = null;

/** レッグキー生成（from→to のルート辞書のキー） */
const legKey = (fromId, toId) => `${fromId}>${toId}`;

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

/** ルートチョイスの登高計算（任意ポリライン） */
async function _calcRouteStats(coords, abortFlag) {
  if (coords.length < 2) return null;
  const line   = turf.lineString(coords);
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
      else        descent -= d;
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

  // レグ統計（直結線）
  const results = await Promise.all(
    seqInfo.slice(1).map((item, i) =>
      _calcLegStats(seqInfo[i].def, item.def, abortFlag)
    )
  );
  if (abortFlag.aborted) return;

  _legStats = results;

  // ルートチョイス統計
  _routeStatsCache.clear();
  const course = _activeCourse();
  if (course.legRoutes) {
    await Promise.all(
      Object.values(course.legRoutes).flatMap(routes =>
        routes.map(async route => {
          const stats = await _calcRouteStats(route.coords, abortFlag);
          if (!abortFlag.aborted) _routeStatsCache.set(route.id, stats);
        })
      )
    );
  }
  if (abortFlag.aborted) return;

  _renderPanel();
}

function _scheduleCalc() {
  if (_calcTimer) clearTimeout(_calcTimer);
  _calcTimer = setTimeout(_recalcAll, 500);
}

// ================================================================
// カスタムドロップダウン（ルート選択）
// ================================================================

/** 現在開いているメニューを閉じる */
function _closeDdMenu() {
  if (_openDdMenu) {
    _openDdMenu.remove();
    _openDdMenu = null;
  }
}

/** ドロップダウンメニューを body に固定表示し、選択時にコールバックを呼ぶ
 *  options: [{ value, html, color }]  color=null → 紫(直結)
 *  anchorEl: トリガーボタン要素（位置計算用）
 *  onSelect: (value) => void
 */
function _openDropdown(anchorEl, options, onSelect) {
  _closeDdMenu();

  const menu = document.createElement('div');
  menu.className = 'course-dd-menu';

  options.forEach(({ value, html, color, node }) => {
    const opt = document.createElement('div');
    opt.className = 'course-dd-opt';
    // コンテンツ
    const inner = document.createElement('span');
    inner.className = 'cdd-opt-inner';
    inner.innerHTML = html;
    opt.appendChild(inner);
    // オプション固有のアクションボタン（編集・削除など）
    if (node) opt.appendChild(node);
    opt.addEventListener('mousedown', e => {
      // ボタン自身の mousedown が stopPropagation 済みのため、
      // ここに到達するのは項目本体クリック時のみ
      e.stopPropagation();
      _closeDdMenu();
      onSelect(value);
    });
    menu.appendChild(opt);
  });

  document.body.appendChild(menu);
  _openDdMenu = menu;

  // 位置を anchorEl 直下に固定
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left  = rect.left  + 'px';
  menu.style.top   = (rect.bottom + 2) + 'px';
  menu.style.minWidth = rect.width + 'px';

  // 画面下端からはみ出す場合は上に表示
  requestAnimationFrame(() => {
    const mh = menu.offsetHeight;
    if (rect.bottom + 2 + mh > window.innerHeight) {
      menu.style.top = (rect.top - mh - 2) + 'px';
    }
  });
}

// ================================================================
// GeoJSON ソース更新
// ================================================================

/**
 * アクティブコースの全フィーチャーを 1 つの FeatureCollection にまとめる。
 * マスター定義の座標を直接参照するため、座標変更が全コースに即時反映される。
 * 含まれるフィーチャー種別:
 *   'leg'      — コース結線（LineString）
 *   'start'    — スタート三角（Point, bearing プロパティ付き）
 *   'control'  — コントロール円（Point）
 *   'route'    — ルートチョイス線（LineString, colorIdx プロパティ付き）
 */
function _buildSourceData() {
  const features = [];
  const seqInfo  = _buildSequenceInfo();
  const course   = _activeCourse();

  // コントロール点（スタートに bearing を付与）
  seqInfo.forEach(({ def, seq, isFinish }) => {
    const label   = (def.type === 'control' && !isFinish) ? String(seq) : '';
    const selected = def.defId === _activeCtrlId;

    // スタートは 1→2 ポイントへの方位角で三角を向ける
    let bearing = 0;
    if (def.type === 'start' && seqInfo.length >= 2) {
      bearing = turf.bearing(
        turf.point([def.lng, def.lat]),
        turf.point([seqInfo[1].def.lng, seqInfo[1].def.lat])
      );
    }

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [def.lng, def.lat] },
      properties: { id: def.defId, type: def.type, seq, label, isFinish, selected, bearing },
    });
  });

  // レッグ線
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

  // ルートチョイス線
  if (course.legRoutes) {
    Object.entries(course.legRoutes).forEach(([key, routes]) => {
      // legKey = "fromId>toId" からコントロール定義を取得
      const [fromId, toId] = key.split('>');
      const fromDef = _controlDefs.get(fromId);
      const toDef   = _controlDefs.get(toId);

      routes.forEach(route => {
        if (route.coords.length < 2) return;
        const isEditing = _editRoute?.legKey === key && _editRoute?.routeId === route.id;

        // 最初と最後の座標をコントロール定義から動的に取得（ドラッグ追従のため）
        const coords = [...route.coords];
        if (fromDef) coords[0]               = [fromDef.lng, fromDef.lat];
        if (toDef)   coords[coords.length - 1] = [toDef.lng, toDef.lat];

        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {
            type:     'route',
            routeId:  route.id,
            legKey:   key,
            colorIdx: route.colorIdx,
            color:    routeColor(route.colorIdx),
            isEditing,
          },
        });
      });
    });
  }

  // 頂点編集中: 頂点（Vertex）と中間点（Midpoint）を追加
  if (_editRoute) {
    const routes = course.legRoutes?.[_editRoute.legKey] ?? [];
    const route  = routes.find(r => r.id === _editRoute.routeId);
    if (route) {
      // 最初・最後の座標をコントロール定義から動的に取得
      const [erFromId, erToId] = _editRoute.legKey.split('>');
      const erFromDef = _controlDefs.get(erFromId);
      const erToDef   = _controlDefs.get(erToId);
      const editCoords = [...route.coords];
      if (erFromDef) editCoords[0]                   = [erFromDef.lng, erFromDef.lat];
      if (erToDef)   editCoords[editCoords.length - 1] = [erToDef.lng, erToDef.lat];

      editCoords.forEach((coord, idx) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coord },
          properties: {
            type:     'vertex',
            routeId:  route.id,
            ptIdx:    idx,
            color:    routeColor(route.colorIdx),
          },
        });
      });
      // 隣接頂点の中点に「中間点」を置く（ドラッグで新頂点を挿入）
      for (let idx = 0; idx < editCoords.length - 1; idx++) {
        const [ax, ay] = editCoords[idx];
        const [bx, by] = editCoords[idx + 1];
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [(ax + bx) / 2, (ay + by) / 2] },
          properties: {
            type:      'midpoint',
            routeId:   route.id,
            afterIdx:  idx,   // この中間点をドラッグすると idx と idx+1 の間に挿入
            color:     routeColor(route.colorIdx),
          },
        });
      }
    }
  }

  return { type: 'FeatureCollection', features };
}

/** ルートチョイス描画中のプレビューソース用データ */
function _buildRoutePreviewData(cursorLngLat) {
  if (!_routeDraw) return { type: 'FeatureCollection', features: [] };
  const pts = [..._routeDraw.pts, [cursorLngLat.lng, cursorLngLat.lat]];
  if (pts.length < 2) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: pts },
      properties: { type: 'routePreview' },
    }],
  };
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

  // スナップ状態が変化した時だけ setPaintProperty を呼ぶ（毎フレームの再描画を抑制）
  if (snapping !== _previewSnapping) {
    const opacity = snapping ? 0.9 : 0.45;
    _map.setPaintProperty('course-preview-circle', 'circle-stroke-opacity', opacity);
    _map.setPaintProperty('course-preview-start',  'icon-opacity',           opacity);
    _previewSnapping = snapping;
  }

  src.setData(_buildPreviewData(lngLat));
}

function _clearPreview() {
  const src = _map?.getSource('course-preview-source');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
  _previewSnapping = false; // 次回 enter 時に必ず opacity を再設定させる
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

  // ルートチョイス描画中プレビュー線
  _map.addLayer({
    id: 'course-preview-route', type: 'line', source: 'course-preview-source',
    filter: ['==', ['get', 'type'], 'routePreview'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ff8800', 'line-width': 2,
      'line-dasharray': [4, 3], 'line-opacity': 0.7,
    },
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

  // ① レグ線（実線）
  _map.addLayer({
    id: 'course-legs', type: 'line', source: 'course-source',
    filter: ['==', ['get', 'type'], 'leg'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': COURSE_COLOR, 'line-width': 1.5,
      'line-opacity': 0.9,
    },
  });

  // ② ルートチョイス線（各色で点線）
  _map.addLayer({
    id: 'course-routes', type: 'line', source: 'course-source',
    filter: ['==', ['get', 'type'], 'route'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['case', ['get', 'isEditing'], 2.5, 2.0],
      'line-dasharray': [4, 3],
      'line-opacity': 0.9,
    },
  });

  // ③ コントロール外円（通常色 / 選択時は SELECT_COLOR）
  _map.addLayer({
    id: 'course-ctrl-outer', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'type'], 'control'],
    paint: {
      'circle-radius': 12,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': [
        'case', ['get', 'selected'], SELECT_COLOR, COURSE_COLOR,
      ],
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 2.2],
    },
  });

  // ④ フィニッシュ内円
  _map.addLayer({
    id: 'course-finish-inner', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'isFinish'], true],
    paint: {
      'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': [
        'case', ['get', 'selected'], SELECT_COLOR, COURSE_COLOR,
      ],
      'circle-stroke-width': 2,
    },
  });

  // ⑤ スタート三角（bearing で回転）
  _map.addLayer({
    id: 'course-start-icon', type: 'symbol', source: 'course-source',
    filter: ['==', ['get', 'type'], 'start'],
    layout: {
      'icon-image':              'course-start-tri',
      'icon-size':               1,
      'icon-rotate':             ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap':      true,
      'icon-ignore-placement':   true,
    },
  });

  // ⑥ コントロール番号ラベル
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

  // ⑦ 頂点（ルート編集モード）
  _map.addLayer({
    id: 'course-vertex', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'type'], 'vertex'],
    paint: {
      'circle-radius': 6,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  // ⑧ 中間点（ルート編集モード — 薄く表示）
  _map.addLayer({
    id: 'course-midpoint', type: 'circle', source: 'course-source',
    filter: ['==', ['get', 'type'], 'midpoint'],
    paint: {
      'circle-radius': 4,
      'circle-color': ['get', 'color'],
      'circle-opacity': 0.5,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1,
      'circle-stroke-opacity': 0.5,
    },
  });

  // ⑨ コントロール用インタラクションヒット領域（最前面）
  _map.addLayer({
    id: 'course-hit', type: 'circle', source: 'course-source',
    filter: ['in', ['get', 'type'], ['literal', ['start', 'control']]],
    paint: { 'circle-radius': 18, 'circle-color': 'rgba(0,0,0,0)', 'circle-opacity': 0 },
  });

  // ⑩ ルートチョイス線用ヒット領域
  _map.addLayer({
    id: 'course-route-hit', type: 'line', source: 'course-source',
    filter: ['==', ['get', 'type'], 'route'],
    paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 12 },
  });
}

// ================================================================
// ドラッグ実装（mousedown → mousemove → mouseup）
// マスター定義を直接更新 → 全コースが同一 WebGL フレームで反映
// ================================================================

/**
 * course-hit レイヤーの mousedown:
 *   描画モード中  → 何もしない（クリックイベント側でスナップ追加）
 *   未選択        → そのコントロールを選択（_activeCtrlId をセット）
 *   選択済み同一  → ドラッグ開始
 *   選択済み他    → 選択変更
 */
function _onCtrlMousedown(e) {
  if (_drawMode || _routeDraw || _editRoute) return;
  if (!e.features?.length) return;
  const defId = e.features[0].properties.id;

  if (_activeCtrlId === defId) {
    // 既に選択中 → ドラッグ開始
    _dragCtrl = _controlDefs.get(defId);
    if (!_dragCtrl) return;
    e.preventDefault();
    _map.dragPan.disable();
    _map.getCanvas().style.cursor = 'grabbing';
    _map.on('mousemove', _onCtrlDrag);
    _map.once('mouseup', _onCtrlDragEnd);
  } else {
    // 新規選択
    _activeCtrlId = defId;
    _refreshSource();
    _renderPanel();
  }
}

function _onCtrlDrag(e) {
  if (!_dragCtrl) return;
  _dragCtrl.lng = e.lngLat.lng;
  _dragCtrl.lat = e.lngLat.lat;
  _refreshSource();
}

function _onCtrlDragEnd() {
  _map.dragPan.enable();
  _map.getCanvas().style.cursor = _drawMode ? 'crosshair' : '';
  _map.off('mousemove', _onCtrlDrag);
  if (_dragCtrl) {
    // ドラッグ終了時に、このコントロールを端点とするルートの座標を同期
    const movedId = _dragCtrl.defId;
    _courses.forEach(course => {
      if (!course.legRoutes) return;
      Object.entries(course.legRoutes).forEach(([key, routes]) => {
        const [fromId, toId] = key.split('>');
        routes.forEach(route => {
          if (fromId === movedId) route.coords[0] = [_dragCtrl.lng, _dragCtrl.lat];
          if (toId   === movedId) route.coords[route.coords.length - 1] = [_dragCtrl.lng, _dragCtrl.lat];
        });
      });
    });
    _dragCtrl = null;
    _scheduleCalc();
    _renderPanel();
  }
}

/** 地図上の何もない場所クリック → 選択解除 / ルート描画への処理分岐 */
function _onMapClick(e) {
  // ルートチョイス描画中
  if (_routeDraw) {
    _onRouteDrawClick(e);
    return;
  }

  const ctrlHits  = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
  const routeHits = _map.queryRenderedFeatures(e.point, { layers: ['course-route-hit'] });

  if (_drawMode) {
    // コントロール配置モード
    if (ctrlHits.length > 0) {
      // 既存コントロールをクリック → 同一 defId を再利用（コードは共有）
      _addExistingControl(ctrlHits[0].properties.id);
    } else {
      _addControl(e.lngLat.lng, e.lngLat.lat);
    }
    _updateDrawHint();
    return;
  }

  if (routeHits.length > 0) {
    // ルート線クリック → 頂点編集モード切り替え
    const props = routeHits[0].properties;
    _startEditRoute(props.legKey, props.routeId);
    return;
  }

  if (ctrlHits.length === 0) {
    // 何もない場所 → 選択解除 & 頂点編集解除
    if (_activeCtrlId !== null) { _activeCtrlId = null; _refreshSource(); _renderPanel(); }
    if (_editRoute    !== null) { _editRoute    = null; _refreshSource(); _renderPanel(); }
  }
}

// ================================================================
// ルートチョイス — 描画モード
// ================================================================

/**
 * 指定レッグにルート追加描画を開始する。
 * fromId / toId は course.sequence 上の隣接 defId ペア。
 */
function _startRouteDraw(fromId, toId) {
  if (_drawMode) return;
  _activeCtrlId = null;
  _editRoute    = null;

  const fromDef = _controlDefs.get(fromId);
  if (!fromDef) return;

  _routeDraw = {
    legKey: legKey(fromId, toId),
    fromId,
    toId,
    pts: [[fromDef.lng, fromDef.lat]], // スタート地点を初期点として追加
  };
  _map.getCanvas().style.cursor = 'crosshair';
  _map.on('mousemove', _onRouteDrawMove);
  _renderPanel();
}

function _onRouteDrawMove(e) {
  if (!_routeDraw) return;
  const previewSrc = _map.getSource('course-preview-source');
  if (previewSrc) previewSrc.setData(_buildRoutePreviewData(e.lngLat));
}

/** ルート描画中のクリック処理 */
function _onRouteDrawClick(e) {
  if (!_routeDraw) return;

  // 終点コントロールへのスナップ判定
  const toDef  = _controlDefs.get(_routeDraw.toId);
  const hits   = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
  const snapTo = hits.find(h => h.properties.id === _routeDraw.toId);

  if (snapTo && toDef) {
    // 終点コントロールに到達 → ルート確定
    _routeDraw.pts.push([toDef.lng, toDef.lat]);
    _commitRouteDraw();
    return;
  }

  // 通常の中間点追加
  _routeDraw.pts.push([e.lngLat.lng, e.lngLat.lat]);
  _refreshSource();
}

/** 現在の描画を確定してルートとして保存 */
function _commitRouteDraw() {
  if (!_routeDraw || _routeDraw.pts.length < 2) { _cancelRouteDraw(); return; }

  const course   = _activeCourse();
  if (!course.legRoutes) course.legRoutes = {};
  const key      = _routeDraw.legKey;
  const existing = course.legRoutes[key] ?? [];
  const colorIdx = existing.length % ROUTE_COLORS.length;

  existing.push({
    id:       'r' + (_nextRouteId++),
    colorIdx,
    coords:   [..._routeDraw.pts],
  });
  course.legRoutes[key] = existing;

  _cancelRouteDraw();
  _scheduleCalc(); // 新ルートの登高統計を計算
}

function _cancelRouteDraw() {
  _map.off('mousemove', _onRouteDrawMove);
  _map.getCanvas().style.cursor = '';
  _routeDraw = null;
  _clearPreview();
  _refreshSource();
  _renderPanel();
}

/** ルートを削除 */
function _deleteRoute(key, routeId) {
  const course = _activeCourse();
  if (!course.legRoutes?.[key]) return;
  course.legRoutes[key] = course.legRoutes[key].filter(r => r.id !== routeId);
  if (course.legRoutes[key].length === 0) delete course.legRoutes[key];
  if (_editRoute?.routeId === routeId) _editRoute = null;
  // 削除したルートが選択中なら直結に戻す
  if (_selectedRoutes.get(key) === routeId) _selectedRoutes.delete(key);
  _routeStatsCache.delete(routeId);
  _refreshSource();
  _renderPanel();
}

// ================================================================
// ルートチョイス — 頂点編集モード
// ================================================================

function _startEditRoute(key, routeId) {
  _activeCtrlId = null;
  _editRoute    = { legKey: key, routeId, dragPtIdx: null };
  _refreshSource();
  _renderPanel();
}

/** 頂点レイヤーの mousedown → ドラッグで頂点移動 */
function _onVertexMousedown(e) {
  if (!_editRoute || !e.features?.length) return;
  const props = e.features[0].properties;
  if (props.routeId !== _editRoute.routeId) return;
  _editRoute.dragPtIdx = props.ptIdx;
  e.preventDefault();
  _map.dragPan.disable();
  _map.getCanvas().style.cursor = 'grabbing';
  _map.on('mousemove', _onVertexDrag);
  _map.once('mouseup', _onVertexDragEnd);
}

function _onVertexDrag(e) {
  if (!_editRoute || _editRoute.dragPtIdx == null) return;
  const course = _activeCourse();
  const routes = course.legRoutes?.[_editRoute.legKey] ?? [];
  const route  = routes.find(r => r.id === _editRoute.routeId);
  if (!route) return;
  route.coords[_editRoute.dragPtIdx] = [e.lngLat.lng, e.lngLat.lat];
  _refreshSource();
}

function _onVertexDragEnd() {
  _map.dragPan.enable();
  _map.getCanvas().style.cursor = '';
  _map.off('mousemove', _onVertexDrag);
  if (_editRoute) _editRoute.dragPtIdx = null;
  _renderPanel();
}

/** 中間点レイヤーの mousedown → ドラッグで新頂点を挿入 */
function _onMidpointMousedown(e) {
  if (!_editRoute || !e.features?.length) return;
  const props = e.features[0].properties;
  if (props.routeId !== _editRoute.routeId) return;

  // afterIdx の次に新しい頂点を挿入してドラッグ開始
  const course = _activeCourse();
  const routes = course.legRoutes?.[_editRoute.legKey] ?? [];
  const route  = routes.find(r => r.id === _editRoute.routeId);
  if (!route) return;

  const insertIdx = props.afterIdx + 1;
  route.coords.splice(insertIdx, 0, [e.lngLat.lng, e.lngLat.lat]);
  _editRoute.dragPtIdx = insertIdx;

  e.preventDefault();
  _map.dragPan.disable();
  _map.getCanvas().style.cursor = 'grabbing';
  _refreshSource();
  _map.on('mousemove', _onVertexDrag);
  _map.once('mouseup', _onVertexDragEnd);
}

/** 頂点を右クリック（contextmenu）で削除（端点は削除不可） */
function _onVertexContextmenu(e) {
  if (!_editRoute || !e.features?.length) return;
  const props = e.features[0].properties;
  if (props.routeId !== _editRoute.routeId) return;

  const course = _activeCourse();
  const routes = course.legRoutes?.[_editRoute.legKey] ?? [];
  const route  = routes.find(r => r.id === _editRoute.routeId);
  if (!route) return;

  // 端点（index 0 と末尾）は削除不可
  if (props.ptIdx === 0 || props.ptIdx === route.coords.length - 1) return;

  route.coords.splice(props.ptIdx, 1);
  _refreshSource();
  _renderPanel();
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

  // code の自動採番（'control' のみ）
  // 既存コードの最大値 + 1 とし、削除後の重複を防ぐ
  let code = '';
  if (type === 'control') {
    const usedCodes = [..._controlDefs.values()]
      .filter(d => d.type === 'control' && /^\d+$/.test(d.code))
      .map(d => parseInt(d.code, 10));
    const maxCode = usedCodes.length > 0 ? Math.max(...usedCodes) : 100;
    code = String(maxCode + 1);
  }

  const def = { defId: 'd' + (_nextDefId++), type, code, lng, lat };
  _controlDefs.set(def.defId, def);
  course.sequence.push(def.defId);

  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

/**
 * 既存コントロール定義をシーケンスに追加する（再訪・共有ポイント用）。
 * コード・座標はマスターのものをそのまま使用し、新規採番しない。
 */
function _addExistingControl(defId) {
  const def = _controlDefs.get(defId);
  if (!def) return;
  _activeCourse().sequence.push(defId);
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

function _setDrawMode(active) {
  // ルート描画中であればキャンセル
  if (active && _routeDraw) _cancelRouteDraw();
  if (active && _editRoute) { _editRoute = null; _refreshSource(); }

  _drawMode = active;
  if (active) {
    _activeCtrlId = null;
    _map.getCanvas().style.cursor = 'crosshair';
    _map.on('mousemove', _updateCursorPreview);
    _map.getCanvas().addEventListener('mouseleave', _clearPreview);
  } else {
    _map.getCanvas().style.cursor = '';
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

/**
 * コースタブ：コントロール行 + レッグ行（縦棒分離）+ ルートチョイスUI
 *
 * DOM 構造:
 *   [コントロール行]  .course-ctrl-item
 *   [レッグ行]        .course-leg-item  ← コントロール間に挿入
 *   [コントロール行]  .course-ctrl-item
 *   ...
 */
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
  const course  = _activeCourse();
  const n       = seqInfo.length;

  if (emptyEl)   emptyEl.style.display  = n ? 'none' : '';
  if (statsSec)  statsSec.style.display = n >= 2 ? '' : 'none';
  if (clearBtn)  clearBtn.disabled      = n === 0;
  if (exportBtn) exportBtn.disabled     = n === 0;
  if (xmlBtn)    xmlBtn.disabled        = n === 0;

  // 選択ルートを考慮したレグ統計（距離・登高）を収集
  // _legStats[i] は直結線、_routeStatsCache はルートチョイス
  const effectiveStats = seqInfo.slice(1).map((item, i) => {
    const k          = legKey(seqInfo[i].def.defId, item.def.defId);
    const selRouteId = _selectedRoutes.get(k);
    if (selRouteId) return _routeStatsCache.get(selRouteId) ?? null;
    return _legStats[i] ?? null;
  });

  // 合計距離（選択ルート考慮）
  let totalDist = 0;
  for (let i = 1; i < n; i++) {
    const k          = legKey(seqInfo[i - 1].def.defId, seqInfo[i].def.defId);
    const selRouteId = _selectedRoutes.get(k);
    if (selRouteId) {
      // ルートチョイスが選択されている場合はそのポリライン距離を使用
      const route = (course.legRoutes?.[k] ?? []).find(r => r.id === selRouteId);
      if (route?.coords.length >= 2) {
        totalDist += turf.length(turf.lineString(route.coords), { units: 'kilometers' });
      } else {
        totalDist += turf.distance(
          turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
          turf.point([seqInfo[i].def.lng,     seqInfo[i].def.lat]),
          { units: 'kilometers' }
        );
      }
    } else {
      // 直結線
      totalDist += turf.distance(
        turf.point([seqInfo[i - 1].def.lng, seqInfo[i - 1].def.lat]),
        turf.point([seqInfo[i].def.lng,     seqInfo[i].def.lat]),
        { units: 'kilometers' }
      );
    }
  }
  if (distEl) distEl.textContent = n >= 2 ? Math.round(totalDist * 1000) + ' m' : '—';

  // 累積登高（選択ルート考慮）
  if (climbEl) {
    if (effectiveStats.length > 0 && effectiveStats.every(s => s != null)) {
      const totalClimb   = effectiveStats.reduce((s, l) => s + (l.climb   ?? 0), 0);
      const totalDescent = effectiveStats.reduce((s, l) => s + (l.descent ?? 0), 0);
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

  // ── リスト構築 ──────────────────────────────────────────────
  listEl.innerHTML = '';

  seqInfo.forEach(({ def, seqIdx, seq, isFinish }, i) => {
    // ① コントロール行
    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'course-ctrl-item';
    ctrlRow.dataset.defId = def.defId;
    if (def.defId === _activeCtrlId) ctrlRow.classList.add('is-selected');

    // クリックで選択
    ctrlRow.addEventListener('click', () => {
      _activeCtrlId = (_activeCtrlId === def.defId) ? null : def.defId;
      _refreshSource();
      _renderPanel();
    });

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
      inp.title = 'コントロールコード';
      inp.addEventListener('click', e => e.stopPropagation()); // 行クリックと競合させない
      inp.addEventListener('change', () => {
        def.code = inp.value.trim() || def.code;
        inp.value = def.code;
      });
      labelRow.appendChild(inp);
      infoDiv.appendChild(labelRow);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'course-ctrl-del'; delBtn.title = 'このシーケンスから削除';
    delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener('click', e => { e.stopPropagation(); _deleteFromSequence(seqIdx); });

    ctrlRow.appendChild(symDiv);
    ctrlRow.appendChild(infoDiv);
    ctrlRow.appendChild(delBtn);
    listEl.appendChild(ctrlRow);

    // ② レッグ行（コントロール間のみ: i < n-1）
    if (i < n - 1) {
      const nextDef  = seqInfo[i + 1].def;
      const key      = legKey(def.defId, nextDef.defId);
      const legDist  = turf.distance(
        turf.point([def.lng, def.lat]),
        turf.point([nextDef.lng, nextDef.lat]),
        { units: 'kilometers' }
      );
      const legStat  = _legStats[i] ?? null;
      const routes   = course.legRoutes?.[key] ?? [];
      const isActive = _routeDraw?.legKey === key;
      const hasEdit  = _editRoute?.legKey  === key;

      // 選択中ルートの色（null = 直結）
      const selRouteId = _selectedRoutes.get(key) ?? null;
      // 削除済みルートが選択中になっていた場合は解除
      const selRoute   = selRouteId ? routes.find(r => r.id === selRouteId) ?? null : null;
      if (selRouteId && !selRoute) _selectedRoutes.delete(key);

      const legRow = document.createElement('div');
      legRow.className = 'course-leg-item';
      if (isActive) legRow.classList.add('is-drawing');

      // 縦棒: 直結=実線紫、ルート選択時=点線(ルート色)
      const lineDiv = document.createElement('div');
      lineDiv.className = 'course-leg-line';
      if (selRoute) {
        const c = routeColor(selRoute.colorIdx);
        lineDiv.style.setProperty('--leg-line-color',
          `repeating-linear-gradient(to bottom, ${c} 0px, ${c} 5px, transparent 5px, transparent 9px)`);
      } else {
        lineDiv.style.setProperty('--leg-line-color', '#c020c0');
      }

      // 右側コンテンツ
      const legContent = document.createElement('div');
      legContent.className = 'course-leg-content';

      // ─── ルート選択行（カスタムドロップダウン ＋ ＋ボタン）─────
      const selRow = document.createElement('div');
      selRow.className = 'course-leg-select-row';

      // stats を色付き HTML に変換するヘルパー
      // color: 距離バッジの背景色（薄め）に使用。null = 直結（紫）
      const fmtStatHtml = (distM, stat, color) => {
        const bg = color ?? '#c020c0';
        let html = `<span class="cdd-dist" style="background:${bg}28;">${distM} m</span>`;
        if (stat === null) {
          html += ` <span class="cdd-computing">…</span>`;
        } else {
          if (stat.climb   > 0) html += ` <span class="cdd-up">↑${stat.climb} m</span>`;
          if (stat.descent > 0) html += ` <span class="cdd-dn">↓${stat.descent} m</span>`;
        }
        return html;
      };

      // ドロップダウンのオプション定義
      const ddOptions = [];

      // 直結オプション
      ddOptions.push({
        value: 'direct',
        color: null,
        html: fmtStatHtml(Math.round(legDist * 1000), legStat, null),
      });

      // ルートチョイスオプション
      routes.forEach(route => {
        const rDistM = route.coords.length >= 2
          ? Math.round(turf.length(turf.lineString(route.coords), { units: 'kilometers' }) * 1000)
          : 0;
        const rStat  = _routeStatsCache.get(route.id) ?? null;
        const rColor = routeColor(route.colorIdx);
        ddOptions.push({
          value: route.id,
          color: rColor,
          html:  fmtStatHtml(rDistM, rStat, rColor),
        });
      });

      // 現在の選択オプション
      const curOpt = selRoute
        ? ddOptions.find(o => o.value === selRoute.id) ?? ddOptions[0]
        : ddOptions[0];

      // トリガーボタン
      const ddBtn = document.createElement('button');
      ddBtn.className = 'course-leg-dd-btn';
      ddBtn.addEventListener('click', e => { e.stopPropagation(); });

      const renderDdBtn = (opt) => {
        ddBtn.innerHTML = '';
        const txt = document.createElement('span');
        txt.className = 'cdd-text';
        txt.innerHTML = opt.html;
        ddBtn.appendChild(txt);
      };
      renderDdBtn(curOpt);

      ddBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (_openDdMenu) { _closeDdMenu(); return; }
        _openDropdown(ddBtn, ddOptions.map(o => {
          // ルートチョイス項目には編集・削除ボタンを付与
          let node = null;
          if (o.value !== 'direct') {
            const route = routes.find(r => r.id === o.value);
            if (route) {
              const actions = document.createElement('span');
              actions.className = 'cdd-opt-actions';

              const editBtn = document.createElement('button');
              editBtn.className = 'cdd-opt-edit-btn';
              editBtn.textContent = (hasEdit && _editRoute?.routeId === route.id) ? '完了' : '編集';
              editBtn.addEventListener('mousedown', e2 => {
                e2.stopPropagation();
                _closeDdMenu();
                if (_editRoute?.routeId === route.id) {
                  _editRoute = null; _refreshSource(); _renderPanel();
                } else {
                  _startEditRoute(key, route.id);
                }
              });

              const delBtn = document.createElement('button');
              delBtn.className = 'cdd-opt-del-btn';
              delBtn.title = 'ルートを削除';
              delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
              delBtn.addEventListener('mousedown', e2 => {
                e2.stopPropagation();
                _closeDdMenu();
                _deleteRoute(key, route.id);
              });

              actions.appendChild(editBtn);
              actions.appendChild(delBtn);
              node = actions;
            }
          }
          return {
            value: o.value,
            color: o.color,
            node,
            html: `<span class="cdd-text">${o.html}</span>`,
          };
        }), val => {
          if (val === 'direct') {
            _selectedRoutes.delete(key);
          } else {
            _selectedRoutes.set(key, val);
          }
          _refreshSource();
          _renderPanel();
        });
      });

      selRow.appendChild(ddBtn);

      // ＋ / キャンセルボタン（アイコンのみ、右端）
      const addBtn = document.createElement('button');
      addBtn.className = 'course-leg-add-btn';
      if (isActive) {
        addBtn.title = 'キャンセル';
        addBtn.classList.add('is-active');
        addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
        addBtn.addEventListener('click', e => { e.stopPropagation(); _cancelRouteDraw(); });
      } else {
        addBtn.title = 'ルートを追加';
        addBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>`;
        addBtn.addEventListener('click', e => {
          e.stopPropagation();
          _startRouteDraw(def.defId, nextDef.defId);
        });
      }
      selRow.appendChild(addBtn);
      legContent.appendChild(selRow);


      legRow.appendChild(lineDiv);
      legRow.appendChild(legContent);
      listEl.appendChild(legRow);
    }
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
    courses: _courses.map(c => ({
      id:         c.id,
      name:       c.name,
      sequence:   [...c.sequence],
      // ルートチョイスを座標7桁精度で保存
      legRoutes:  Object.fromEntries(
        Object.entries(c.legRoutes ?? {}).map(([key, routes]) => [
          key,
          routes.map(r => ({
            id:       r.id,
            colorIdx: r.colorIdx,
            coords:   r.coords.map(([lng, lat]) => [+lng.toFixed(7), +lat.toFixed(7)]),
          })),
        ])
      ),
    })),
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
    _clearCourse();

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
            _courses[i].id         = c.id       ?? _courses[i].id;
            _courses[i].name       = c.name     ?? _courses[i].name;
            _courses[i].sequence   = [...(c.sequence ?? [])];
            _courses[i].legRoutes  = {};
            // legRoutes の復元（v2.1 以降で保存されている場合）
            Object.entries(c.legRoutes ?? {}).forEach(([key, routes]) => {
              if (!Array.isArray(routes)) return;
              _courses[i].legRoutes[key] = routes.map(r => ({
                id:       r.id ?? ('r' + (_nextRouteId++)),
                colorIdx: r.colorIdx ?? 0,
                coords:   r.coords ?? [],
              }));
              // _nextRouteId の更新
              routes.forEach(r => {
                const num = parseInt(String(r.id ?? '').replace(/^\D+/, ''), 10);
                if (!isNaN(num) && num >= _nextRouteId) _nextRouteId = num + 1;
              });
            });
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

function _clearCourse() {
  if (_drawMode)   _setDrawMode(false);
  if (_routeDraw)  _cancelRouteDraw();
  if (_calcAbort)  _calcAbort.aborted = true;

  _activeCtrlId = null;
  _editRoute    = null;

  const course = _activeCourse();
  // 他のコースで使われていない def をマスターから削除
  const keepSet = new Set(
    _courses.flatMap((c, ci) => ci === _activeCourseIdx ? [] : c.sequence)
  );
  course.sequence.forEach(id => { if (!keepSet.has(id)) _controlDefs.delete(id); });
  course.sequence   = [];
  course.legRoutes  = {};
  _legStats         = [];
  _selectedRoutes.clear();
  _routeStatsCache.clear();

  _refreshSource();
  _renderPanel();
}

// ================================================================
// UI イベント設定
// ================================================================

function _setupUI() {
  // ドロップダウンメニューのクリックアウト処理
  document.addEventListener('mousedown', e => {
    if (_openDdMenu && !_openDdMenu.contains(e.target)) {
      _closeDdMenu();
    }
  }, true);

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

  // ── コントロール操作 ──────────────────────────────────────
  // mousedown: 選択 or ドラッグ開始
  map.on('mousedown', 'course-hit', _onCtrlMousedown);

  // ホバーカーソル
  map.on('mouseenter', 'course-hit', () => {
    if (_drawMode || _routeDraw) return;
    map.getCanvas().style.cursor = _activeCtrlId ? 'grab' : 'pointer';
  });
  map.on('mouseleave', 'course-hit', () => {
    if (!_dragCtrl) map.getCanvas().style.cursor = _drawMode || _routeDraw ? 'crosshair' : '';
  });

  // ── ルート線操作 ─────────────────────────────────────────
  map.on('mouseenter', 'course-route-hit', () => {
    if (!_routeDraw && !_drawMode) map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'course-route-hit', () => {
    if (!_dragCtrl && !_routeDraw && !_drawMode) map.getCanvas().style.cursor = '';
  });

  // ── 頂点・中間点操作 ──────────────────────────────────────
  map.on('mousedown',    'course-vertex',   _onVertexMousedown);
  map.on('mousedown',    'course-midpoint', _onMidpointMousedown);
  map.on('contextmenu',  'course-vertex',   _onVertexContextmenu);

  map.on('mouseenter', 'course-vertex',   () => { if (_editRoute) map.getCanvas().style.cursor = 'grab'; });
  map.on('mouseleave', 'course-vertex',   () => { if (!_editRoute?.dragPtIdx) map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'course-midpoint', () => { if (_editRoute) map.getCanvas().style.cursor = 'crosshair'; });
  map.on('mouseleave', 'course-midpoint', () => { if (!_editRoute?.dragPtIdx) map.getCanvas().style.cursor = ''; });

  // ── 地図クリック（全モード共通入口） ──────────────────────
  map.on('click', _onMapClick);

  _setupUI();
}

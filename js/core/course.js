/* ================================================================
   course.js — コースプランナーモジュール（v5）
   Purple Pen 互換リレーショナル構造 + IndexedDB 永続化

   データモデル:
   · _controlDefs (Map)  — アクティブコースセットのコントロールマスター
   · _courses[]          — アクティブコースセットのコース一覧
   · _activeEventId      — 現在ロード中のイベント ID（mapSheet作成等で使用）
   · _activeCourseSetId  — 現在ロード中のコースセット ID

   永続化: IndexedDB workspace-db.js（v5）
   · events ストア      : イベントメタデータのみ（controlDefs は course_sets へ移動）
   · course_sets ストア : コースセット + controlDefs + nextDefId 等
   · courses ストア     : 各コース（course_set_id 参照）

   ================================================================ */

import { QCHIZU_DEM_BASE, DEM5A_BASE, ROUTE_COLORS, routeColor, ROUTE_COLOR_CMYK } from './config.js';
import {
  getAllWsEvents,
  getWsEvent,
  saveWsEvent,
  deleteWsEvent,
  getCoursesByEvent,
  getCoursesBySet,
  getWsCourse,
  saveWsCourse,
  deleteWsCourse,
  deleteCoursesBySet,
  saveWsCourseSet,
  getWsCourseSet,
  getCourseSetsForEvent,
  getAllWsCourseSets,
  deleteWsCourseSet,
} from '../api/workspace-db.js';

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
 * value: { defId, code:string, lng:number, lat:number }
 *
 * ※ type フィールドは廃止。シンボルはコース内の位置で決定:
 *     先頭 → △ スタート / 末尾（2点以上）→ ◎ フィニッシュ / それ以外 → ○ コントロール
 * ※ IOF XML / Purple Pen エクスポート時も position から種別を導出する
 */
const _controlDefs = new Map();

/**
 * コース一覧
 * { id:string, name:string, sequence:string[], legRoutes:{[legKey]:Route[]}, terrainId:string|null }
 * sequence   = defId の配列。同一 defId が複数回登場可能（同一ポイント再訪）
 * legRoutes  = レッグごとのルートチョイス配列
 *              key: legKey(fromId, toId)
 *              value: [{ id, colorIdx, coords:[[lng,lat],...] }]
 * terrainId  = 所属ワークスペーステレイン ID（null = 未分類）
 */
const _courses = [{ id: 'course0', name: 'コース1', sequence: [], legRoutes: {}, terrainId: null }];

let _activeCourseIdx = 0;   // アクティブコースの index
let _nextDefId       = 0;   // defId 生成カウンタ
let _nextRouteId     = 0;   // ルート ID 生成カウンタ
let _activeEventId        = null; // 現在ロード中のイベント ID（mapSheet作成等で使用）
let _activeEventName      = '';   // 現在ロード中のイベント名（パンくず用）
let _activeEventTerrainId = null; // 現在ロード中のイベントの terrain_id
let _activeCourseSetId    = null; // 現在ロード中のコースセット ID
let _activeCourseSetName  = '';   // 現在ロード中のコースセット名（パンくず用）
let _drawMode        = false;
let _calcTimer       = null;
let _legStats        = [];  // [{distKm, climb, descent}] レグ統計キャッシュ
let _calcAbort       = null;
const _selectedRoutes   = new Map(); // legKey → routeId | null（null = 直結）
const _routeStatsCache  = new Map(); // routeId → { distKm, climb, descent } | null
let _openDdMenu      = null;  // 現在開いているドロップダウンメニュー（body 配下）
let _dragCtrl        = null;  // ドラッグ中のコントロール定義（_controlDefs の value）
let _activeCtrlId    = null;  // 選択中コントロールの defId（選択モード）
let _activeTab       = 'course'; // 'course' | 'controls'（コースタブは activeCourseIdx と連動）
let _previewSnapping = false;    // 前フレームのスナップ状態（setPaintProperty 呼び出し抑制用）

// ================================================================
// 外部 getter（app.js が initCoursePlanner の後に登録する）
// ================================================================
/** app.js から localMapLayers 参照を受け取る。エクスポート・インポート時に使用 */
let _getMapLayers = () => [];
export function setMapLayersGetter(fn) { _getMapLayers = fn; }

/** .ppen / IOF XML インポート完了後に app.js が renderExplorer 等を実行するためのコールバック */
let _onImportDone = null;
export function setImportDoneCallback(fn) { _onImportDone = fn; }

// ================================================================
// 履歴（Undo / Redo）
// ================================================================
const HISTORY_MAX  = 50;
const _undoStack   = [];  // スナップショット配列（古い順）
const _redoStack   = [];  // redo 用スナップショット配列

/** 現在の編集状態をスナップショットとして返す */
function _snapshot() {
  return {
    controlDefs:    [..._controlDefs.entries()].map(([k, v]) => [k, { ...v }]),
    courses:        JSON.parse(JSON.stringify(_courses)),
    selectedRoutes: [..._selectedRoutes.entries()],
    activeCourseIdx: _activeCourseIdx,
    nextDefId:      _nextDefId,
    nextRouteId:    _nextRouteId,
  };
}

/** ミューテーション前に呼ぶ。redo スタックはクリアされる */
function _pushHistory() {
  _undoStack.push(_snapshot());
  if (_undoStack.length > HISTORY_MAX) _undoStack.shift();
  _redoStack.length = 0;
  _updateHistoryButtons();
  // ミューテーション前の状態を保存するのではなく、呼び出し後に保存するため
  // 実際の保存は _saveAfterMutation() で行う
}

// _saveTimer / _scheduleSave は IndexedDB 永続化セクションで定義（後述）

/** スナップショットを状態に復元する */
function _restoreSnapshot(snap) {
  _controlDefs.clear();
  snap.controlDefs.forEach(([k, v]) => _controlDefs.set(k, v));
  _courses.length = 0;
  snap.courses.forEach(c => _courses.push(c));
  _selectedRoutes.clear();
  snap.selectedRoutes.forEach(([k, v]) => _selectedRoutes.set(k, v));
  _activeCourseIdx = snap.activeCourseIdx;
  _nextDefId       = snap.nextDefId;
  _nextRouteId     = snap.nextRouteId;
  // ドラッグ・描画中状態をリセット
  _routeDraw    = null;
  _editRoute    = null;
  _activeCtrlId = null;
  _routeStatsCache.clear();
  _legStats = [];
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

function _undo() {
  if (_undoStack.length === 0) return;
  _redoStack.push(_snapshot());
  _restoreSnapshot(_undoStack.pop());
  _updateHistoryButtons();
  _saveToStorage();
}

function _redo() {
  if (_redoStack.length === 0) return;
  _undoStack.push(_snapshot());
  _restoreSnapshot(_redoStack.pop());
  _updateHistoryButtons();
  _saveToStorage();
}

function _updateHistoryButtons() {
  const undoBtn = document.getElementById('course-undo-btn');
  const redoBtn = document.getElementById('course-redo-btn');
  if (undoBtn) undoBtn.disabled = _undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = _redoStack.length === 0;
}

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
 * 各要素: { def, seqIdx, seq, isStart, isFinish }
 *   def      — _controlDefs のエントリ（マスターへの参照）
 *   seqIdx   — course.sequence 内のインデックス（削除処理に使用）
 *   seq      — 地図ラベル用連番（コントロール＝isStart でも isFinish でもない場合のみ 1 始まり）
 *   isStart  — コース先頭の場合 true（△ スタート）
 *   isFinish — コース末尾かつ 2 点以上の場合 true（◎ フィニッシュ）
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
    const isStart  = seqIdx === 0;
    const isFinish = !isStart && seqIdx === lastIdx && seqArr.length >= 2;
    const seq = (!isStart && !isFinish) ? ++ctrlSeq : 0;
    result.push({ def, seqIdx, seq, isStart, isFinish });
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
 * 全コントロールタブ表示時は全 def をコード番号で表示し、レッグ線・ルートを非表示。
 */
function _buildSourceData() {
  const features = [];

  // ── 全コントロールタブ表示時 ──────────────────────────────
  if (_activeTab === 'controls') {
    _controlDefs.forEach(def => {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [def.lng, def.lat] },
        properties: {
          id: def.defId, type: 'control', seq: 0,
          label: def.code || '', isFinish: false,
          selected: def.defId === _activeCtrlId, bearing: 0,
        },
      });
    });
    return { type: 'FeatureCollection', features };
  }

  // ── コースタブ表示時（従来処理）──────────────────────────
  const seqInfo  = _buildSequenceInfo();
  const course   = _activeCourse();

  // コントロール点（スタートに bearing を付与）
  seqInfo.forEach(({ def, seq, isStart, isFinish }) => {
    const label   = (!isStart && !isFinish) ? String(seq) : '';
    const selected = def.defId === _activeCtrlId;

    // スタートは 1→2 ポイントへの方位角で三角を向ける
    let bearing = 0;
    if (isStart && seqInfo.length >= 2) {
      bearing = turf.bearing(
        turf.point([def.lng, def.lat]),
        turf.point([seqInfo[1].def.lng, seqInfo[1].def.lat])
      );
    }

    const geoType = isStart ? 'start' : 'control';
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [def.lng, def.lat] },
      properties: { id: def.defId, type: geoType, seq, label, isFinish, selected, bearing },
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

function _refreshSource(save = true) {
  const src = _map?.getSource('course-source');
  if (src) src.setData(_buildSourceData());
  if (save) _scheduleSave();
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

  // コースエディターが開くまで非表示
  setCourseMapVisible(false);
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
    _pushHistory();
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

// ================================================================
// 右クリック カスタムコンテキストメニュー
// ================================================================

/** 既存のコンテキストメニューを閉じる */
function _closeCtxMenu() {
  document.getElementById('course-ctx-menu')?.remove();
}

/**
 * カスタムコンテキストメニューを表示する。
 * items: [{ label, action, danger? } | { separator: true }]
 */
function _showCtxMenu(clientX, clientY, items) {
  _closeCtxMenu();

  const menu = document.createElement('div');
  menu.id = 'course-ctx-menu';
  menu.className = 'course-ctx-menu';
  menu.style.visibility = 'hidden'; // 寸法取得後に表示

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ctx-menu-item' + (item.danger ? ' ctx-menu-danger' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _closeCtxMenu();
        item.action();
      });
      menu.appendChild(btn);
    }
  }

  document.body.appendChild(menu);

  // 画面外はみ出し補正
  const rect = menu.getBoundingClientRect();
  const mw   = rect.width  || 160;
  const mh   = rect.height || items.length * 34;
  const vw   = window.innerWidth, vh = window.innerHeight;
  menu.style.left       = Math.min(clientX, vw - mw - 8) + 'px';
  menu.style.top        = Math.min(clientY, vh - mh - 8) + 'px';
  menu.style.visibility = 'visible';

  // 外側クリック・Escape で閉じる
  const onOutside = () => _closeCtxMenu();
  const onKey     = e  => { if (e.key === 'Escape') { _closeCtxMenu(); document.removeEventListener('keydown', onKey); } };
  setTimeout(() => {
    document.addEventListener('click',       onOutside, { once: true });
    document.addEventListener('contextmenu', onOutside, { once: true });
    document.addEventListener('keydown',     onKey);
  }, 0);
}

/**
 * 地図右クリック: _drawMode / _routeDraw 中はカスタムメニューを表示し
 * ブラウザのデフォルトコンテキストメニューをキャンセルする。
 */
function _onMapContextmenu(e) {
  if (!_drawMode && !_routeDraw) return; // 通常モードはブラウザデフォルトに任せる

  e.originalEvent.preventDefault(); // ブラウザデフォルト防止

  const { clientX, clientY } = e.originalEvent;
  const items = [];

  if (_drawMode) {
    const course    = _activeCourse();
    const seq       = course.sequence;
    const ctrlHits  = _map.queryRenderedFeatures(e.point, { layers: ['course-hit'] });
    const hitDefId  = ctrlHits.length > 0 ? ctrlHits[0].properties.id : null;

    // コントロール上の右クリック → そのコントロールを削除（最後の出現を対象）
    if (hitDefId) {
      const def     = _controlDefs.get(hitDefId);
      const lastIdx = seq.reduce((best, id, i) => id === hitDefId ? i : best, -1);
      if (lastIdx >= 0) {
        const isStartDef = lastIdx === 0;
        const label = def
          ? (isStartDef ? 'スタートを削除' : `コントロール ${def.code} を削除`)
          : 'このコントロールを削除';
        items.push({ label, danger: true, action: () => _deleteFromSequence(lastIdx) });
      }
    }

    // 最後のコントロールを戻す（置き間違いの即時修正用）
    if (seq.length > 0) {
      items.push({
        label: '最後のコントロールを戻す',
        action: () => _deleteFromSequence(seq.length - 1),
      });
    }

    items.push({ separator: true });
    items.push({ label: '描画終了', action: () => _setDrawMode(false) });

  } else if (_routeDraw) {
    // ルートチョイス描画中: 現在の点列で確定 or キャンセル
    items.push({
      label: 'ここで確定する',
      action: () => _commitRouteDraw(),
    });
    items.push({ label: '描画をキャンセル', danger: true, action: () => _cancelRouteDraw() });
  }

  if (items.length === 0) return;
  _showCtxMenu(clientX, clientY, items);
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

  _pushHistory();
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
  _pushHistory();
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
  if (_editRoute) {
    _pushHistory();
    _editRoute.dragPtIdx = null;
  }
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
  _pushHistory();
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

  _pushHistory();
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
  _pushHistory();
  const course  = _activeCourse();
  const isFirst = course.sequence.length === 0;

  // code の自動採番（スタート以外のみ）
  // 既存コードの最大値 + 1 とし、削除後の重複を防ぐ
  let code = '';
  if (!isFirst) {
    const usedCodes = [..._controlDefs.values()]
      .filter(d => /^\d+$/.test(d.code))
      .map(d => parseInt(d.code, 10));
    const maxCode = usedCodes.length > 0 ? Math.max(...usedCodes) : 100;
    code = String(maxCode + 1);
  }

  const def = { defId: 'd' + (_nextDefId++), code, lng, lat };
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
  _pushHistory();
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
  _pushHistory();
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
  _pushHistory();
  _controlDefs.delete(defId);
  _courses.forEach(c => {
    c.sequence = c.sequence.filter(id => id !== defId);
  });
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

// ================================================================
// コース追加・削除
// ================================================================

function _addCourse() {
  _pushHistory();
  const idx   = _courses.length;
  const newId = 'course-' + Date.now();
  _courses.push({
    id:            newId,
    event_id:      _activeEventId      ?? null,
    course_set_id: _activeCourseSetId  ?? null,
    name:          `コース${idx + 1}`,
    sequence:      [],
    legRoutes:     {},
    terrainId:     null,
  });
  _activeCourseIdx = _courses.length - 1;
  _activeTab = 'course';
  _activeCtrlId = null;
  _editRoute    = null;
  _legStats     = [];
  _refreshSource();
  _renderPanel();
  _scheduleSave();
  return newId;
}

function _deleteCourse(idx) {
  if (_courses.length <= 1) return;
  if (!confirm(`「${_courses[idx].name}」を削除しますか？`)) return;
  _pushHistory();

  // このコースのみで使われている def をマスターから削除
  const otherUsed = new Set(
    _courses.flatMap((c, ci) => ci === idx ? [] : c.sequence)
  );
  _courses[idx].sequence.forEach(id => { if (!otherUsed.has(id)) _controlDefs.delete(id); });

  _courses.splice(idx, 1);
  if (_activeCourseIdx >= _courses.length) _activeCourseIdx = _courses.length - 1;
  _activeTab    = 'course';
  _activeCtrlId = null;
  _editRoute    = null;
  _legStats     = [];
  _selectedRoutes.clear();
  _routeStatsCache.clear();
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
  _scheduleSave();
}

/**
 * コース ID を指定して削除する（app.js のツリー UI から呼び出す）
 * @param {string} courseId
 */
export function deleteCourseById(courseId) {
  const idx = _courses.findIndex(c => c.id === courseId);
  if (idx === -1) return;
  _deleteCourse(idx);
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
    btn.title = '配置モード終了';
  } else {
    btn.classList.remove('course-draw-active');
    btn.title = 'コントロール配置モード';
  }
}

function _updateDrawHint() {
  // 地図上フローティングトーストにヒントを表示
  const el = document.getElementById('course-map-toast');
  if (!el) return;
  if (!_drawMode) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  const course = _activeCourse();
  if (course.sequence.length === 0)
    el.textContent = '地図をクリックしてスタート（△）を配置';
  else
    el.textContent = 'クリックでコントロール（○）を追加 · 右クリックで描画終了';
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

function _ctrlSvg(isStart, isFinish) {
  if (isStart)  return _svgStart();
  if (isFinish) return _svgFinish();
  return _svgControl();
}

// ================================================================
// パネル描画（2タブ）
// ================================================================

function _renderPanel() {
  _updateDrawModeUI();
  _updateDrawHint();
  _updateTabUI();
  _updateBreadcrumb();
  _refreshSource(false); // タブ切り替えで地図表示を同期（保存は不要）
  // コース名入力が編集中でなければ非表示のまま維持
  const nameInput = document.getElementById('course-name-input');
  if (nameInput && nameInput.style.display !== 'none') nameInput.value = _activeCourse().name;
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

/** パンくずリストを更新（右パネル上部） */
function _updateBreadcrumb() {
  const bc       = document.getElementById('course-breadcrumb');
  const delBtn   = document.getElementById('course-del-btn');
  if (!bc) return;

  const eventEl  = bc.querySelector('.course-bc-event');
  const itemEl   = bc.querySelector('.course-bc-item');
  if (eventEl) eventEl.textContent = _activeEventName || 'イベント';
  if (itemEl) {
    if (_activeTab === 'controls') {
      itemEl.textContent = '全コントロール';
      itemEl.className   = 'course-bc-item course-bc-controls';
    } else {
      itemEl.textContent = _activeCourse()?.name ?? '';
      itemEl.className   = 'course-bc-item course-bc-course';
    }
  }
  if (delBtn) delBtn.disabled = _courses.length <= 1;
}

/** 後方互換: プルダウンが残っている場合も更新 */
function _updateCourseSelect() {
  _updateBreadcrumb();
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
  const exportBtn    = document.getElementById('course-export-btn');
  const xmlBtn       = document.getElementById('course-xml-btn');
  const exportTrigEl = document.getElementById('course-export-trigger');
  if (!listEl) return;

  const seqInfo = _buildSequenceInfo();
  const course  = _activeCourse();
  const n       = seqInfo.length;

  if (emptyEl)       emptyEl.style.display    = n ? 'none' : '';
  if (statsSec)      statsSec.style.display   = n >= 2 ? '' : 'none';
  if (exportBtn)     exportBtn.disabled       = n === 0;
  if (xmlBtn)        xmlBtn.disabled          = n === 0;
  if (exportTrigEl)  exportTrigEl.disabled    = n === 0;

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
  const numCtrls = seqInfo.filter(item => !item.isStart).length;
  if (countEl) countEl.textContent = numCtrls + ' 個';

  // ── リスト構築 ──────────────────────────────────────────────
  listEl.innerHTML = '';

  seqInfo.forEach(({ def, seqIdx, seq, isStart, isFinish }, i) => {
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
    symDiv.innerHTML = _ctrlSvg(isStart, isFinish);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'course-ctrl-info';

    if (isStart) {
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
        _pushHistory();
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
          _pushHistory();
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
      const isStartPos  = idx === 0;
      const isFinishPos = !isStartPos && idx === course.sequence.length - 1 && course.sequence.length >= 2;
      const seq = (!isStartPos && !isFinishPos) ? ++ctrlSeq : 0;
      const label = isStartPos ? 'S' : isFinishPos ? 'F' : String(seq);
      const existing = usageMap.get(defId) ?? [];
      existing.push(label);
      usageMap.set(defId, existing);
    });
  });

  _controlDefs.forEach((def) => {
    const usageLabels = usageMap.get(def.defId) ?? [];
    // どのコースでも先頭に置かれていたらスタートとして表示
    const isStart = _courses.some(c => c.sequence[0] === def.defId);

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
        _pushHistory();
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
  const xmlType = (isStart, isFinish) =>
    isStart ? 'Start' : isFinish ? 'Finish' : 'Control';

  // ユニークな Control 定義を収集（コース使用分のみ）
  // 同一 defId がシーケンスに複数回登場しても 1 つの Control 要素として出力
  const seenDefs = new Map(); // defId → { def, isStart, isFinish }
  seqInfo.forEach(({ def, isStart, isFinish }) => {
    if (!seenDefs.has(def.defId)) {
      seenDefs.set(def.defId, { def, isStart, isFinish });
    } else {
      if (isFinish) seenDefs.get(def.defId).isFinish = true;
      if (isStart)  seenDefs.get(def.defId).isStart  = true;
    }
  });

  // Control 要素 XML
  const controlsXml = [...seenDefs.values()].map(({ def, isStart, isFinish }) =>
    `    <Control type="${xmlType(isStart, isFinish)}">\n` +
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
  const courseControlsXml = seqInfo.map(({ def, seq, isStart, isFinish }, i) => {
    const type = xmlType(isStart, isFinish);
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
      code: def.code,
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
        _controlDefs.set(id, { defId: id, code: def.code ?? '', lng: def.lng, lat: def.lat });
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
        const def   = { defId, code: c.code ?? '', lng: c.lng, lat: c.lat };
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
// Purple Pen (.ppen) エクスポート / インポート
// ================================================================

// ---- 座標ユーティリティ ----

/** Haversine距離（m）*/
function _haversineM(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** 画像 URL から自然サイズ（px）を取得（非同期） */
function _imgDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}

/** ダウンロードヘルパー */
function _downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ---- CMYK ↔ colorIdx 変換 ----

/** CMYK小数文字列 "C,M,Y,K"（0〜1）→ 最近傍 colorIdx */
function _parsePPenCmyk(str) {
  const parts = (str || '').split(',').map(parseFloat);
  if (parts.length < 4) return 0;
  const [c, m, y, k] = parts.map(v => Math.round(v * 100));
  let bestIdx = 0, bestDist = Infinity;
  ROUTE_COLOR_CMYK.forEach(({ cmyk }, idx) => {
    const d = (cmyk[0] - c) ** 2 + (cmyk[1] - m) ** 2
            + (cmyk[2] - y) ** 2 + (cmyk[3] - k) ** 2;
    if (d < bestDist) { bestDist = d; bestIdx = idx; }
  });
  return bestIdx;
}

/** colorIdx → CMYK小数文字列（"0.00,1.00,1.00,0.00" 形式） */
function _cmykStr(colorIdx) {
  const entry = ROUTE_COLOR_CMYK[((colorIdx % ROUTE_COLOR_CMYK.length) + ROUTE_COLOR_CMYK.length) % ROUTE_COLOR_CMYK.length];
  return entry.cmyk.map(v => (v / 100).toFixed(2)).join(',');
}

// ---- .ppen XML 生成 ----

/**
 * 現在のコースデータを .ppen XML 文字列に変換する。
 * 座標系: 原点 = 地図南西角、x 東向き・y 北向き（OCAD 準拠）
 * @param {string} title  イベント名
 * @param {string} imgFilename  画像ファイル名（相対パス）
 * @param {number} scale  縮尺分母（例: 10000）
 * @param {number} dpi    画像 DPI
 * @param {number} widthMM  地図上の画像幅（mm）
 * @param {number} heightMM 地図上の画像高さ（mm）
 * @param {object} bbox   { west, south, east, north }
 */
function _buildPPenXML(title, imgFilename, scale, dpi, widthMM, heightMM, bbox) {
  const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const toMM = (lng, lat) => ({
    x: ((lng - bbox.west)  / (bbox.east  - bbox.west))  * widthMM,
    y: ((lat - bbox.south) / (bbox.north - bbox.south)) * heightMM,
  });
  const fmt = v => v.toFixed(6);

  const usedDefIds = new Set(_courses.flatMap(c => c.sequence));
  if (usedDefIds.size === 0) return null;

  // スタート: いずれかのコースの先頭要素
  const startDefIds = new Set(
    _courses.map(c => c.sequence.length > 0 ? c.sequence[0] : null).filter(Boolean)
  );
  // フィニッシュ: いずれかのコースの最後要素
  const finishDefIds = new Set(
    _courses.map(c => c.sequence.length > 0 ? c.sequence[c.sequence.length - 1] : null).filter(Boolean)
  );

  // defId → integer control ID（1始まり）
  const defIdToCtrlId = new Map();
  let ctrlId = 1;
  for (const id of usedDefIds) defIdToCtrlId.set(id, ctrlId++);

  // コントロールコードの最小値（numbering start）
  const codes = [...usedDefIds]
    .map(id => parseInt(_controlDefs.get(id)?.code || '0', 10))
    .filter(n => n > 0);
  const startNum = codes.length ? Math.min(...codes) : 31;

  // コースコントロール割り当て（全コース通し番号）
  const ccList = []; // { ccId, defId, courseIdx }
  let ccId = 1;
  for (let ci = 0; ci < _courses.length; ci++) {
    if (_courses[ci].sequence.length === 0) continue;
    for (const defId of _courses[ci].sequence) {
      ccList.push({ ccId: ccId++, defId, courseIdx: ci });
    }
  }
  // コース → 最初の ccId
  const courseFirstCC = new Map();
  for (const cc of ccList) {
    if (!courseFirstCC.has(cc.courseIdx)) courseFirstCC.set(cc.courseIdx, cc.ccId);
  }

  const out = [];
  const l   = s => out.push(s);

  l('<course-scribe-event>');
  l('  <event id="1">');
  l(`    <title>${esc(title)}</title>`);
  l(`    <map kind="bitmap" scale="${scale}" dpi="${Math.round(dpi)}" absolute-path="${esc(imgFilename)}">${esc(imgFilename)}</map>`);
  l('    <standards map="2017" description="2018" />');
  l(`    <all-controls print-scale="${scale}" description-kind="symbols" />`);
  l('    <print-area automatic="true" restrict-to-page-size="true" left="0" top="0" right="0" bottom="0" page-width="827" page-height="1169" page-margins="0" page-landscape="false" />');
  l(`    <numbering start="${startNum}" disallow-invertible="false" />`);
  l('    <punch-card rows="3" columns="8" left-to-right="true" top-to-bottom="false" />');
  l(`    <course-appearance scale-sizes="RelativeTo${scale}" scale-sizes-circle-gaps="true" number-font="Roboto" auto-leg-gap-size="3.5" blend-purple="true" blend-style="blend" />`);
  l('    <descriptions lang="ja" color="black" />');
  l('    <ocad overprint-colors="false" />');
  l('  </event>');
  l('');

  // コントロール定義
  for (const defId of usedDefIds) {
    const def = _controlDefs.get(defId);
    if (!def) continue;
    const cid = defIdToCtrlId.get(defId);
    const mm  = toMM(def.lng, def.lat);
    const kind = startDefIds.has(defId)  ? 'start'
               : finishDefIds.has(defId) ? 'finish'
               : 'normal';
    l(`  <control id="${cid}" kind="${kind}">`);
    if (kind === 'normal') l(`    <code>${esc(def.code)}</code>`);
    l(`    <location x="${fmt(mm.x)}" y="${fmt(mm.y)}" />`);
    if (kind === 'finish') l('    <description box="all" iof-2004-ref="14.3" />');
    l('  </control>');
  }
  l('');

  // コース定義
  let courseOrder = 0;
  for (let ci = 0; ci < _courses.length; ci++) {
    if (_courses[ci].sequence.length === 0) continue;
    courseOrder++;
    const firstCC = courseFirstCC.get(ci) ?? 1;
    l(`  <course id="${courseOrder}" kind="normal" order="${courseOrder}">`);
    l(`    <name>${esc(_courses[ci].name)}</name>`);
    l('    <labels label-kind="sequence" />');
    l(`    <first course-control="${firstCC}" />`);
    l('    <print-area automatic="true" restrict-to-page-size="true" left="0" top="0" right="0" bottom="0" page-width="583" page-height="827" page-margins="0" page-landscape="false" />');
    l(`    <options print-scale="${scale}" hide-from-reports="false" description-kind="symbols" />`);
    l('  </course>');
  }
  l('');

  // コースコントロール（リンクリスト）
  for (let i = 0; i < ccList.length; i++) {
    const cc   = ccList[i];
    const cid  = defIdToCtrlId.get(cc.defId);
    const next = (i + 1 < ccList.length && ccList[i + 1].courseIdx === cc.courseIdx)
                 ? ccList[i + 1].ccId : null;
    l(`  <course-control id="${cc.ccId}" control="${cid}">`);
    if (next !== null) l(`    <next course-control="${next}" />`);
    l('  </course-control>');
  }
  l('');

  // ルートチョイス（special-object kind="line"）
  // コースIDは courseOrder と対応させる
  let soId = 1;
  courseOrder = 0;
  for (let ci = 0; ci < _courses.length; ci++) {
    if (_courses[ci].sequence.length === 0) continue;
    courseOrder++;
    const course = _courses[ci];
    for (const routes of Object.values(course.legRoutes ?? {})) {
      for (const route of routes) {
        l(`  <special-object id="${soId++}" kind="line">`);
        l(`    <appearance line-kind="dashed" color="${_cmykStr(route.colorIdx)}" line-width="0.5" gap-size="0.5" dash-size="2" />`);
        for (const [lng, lat] of route.coords) {
          const mm = toMM(lng, lat);
          l(`    <location x="${fmt(mm.x)}" y="${fmt(mm.y)}" />`);
        }
        l('    <courses>');
        l(`      <course course="${courseOrder}" />`);
        l('    </courses>');
        l('  </special-object>');
      }
    }
  }

  l('</course-scribe-event>');
  return out.join('\n');
}

// ---- エクスポートダイアログ ----

/** Purple Pen エクスポートダイアログを開く */
function _exportPPen() {
  const overlay = document.getElementById('ppen-export-overlay');
  if (!overlay) return;

  const imageLayers = _getMapLayers();
  const sel       = document.getElementById('ppen-export-image');
  const noImgMsg  = document.getElementById('ppen-no-image-msg');
  const goBtn     = document.getElementById('ppen-export-go');

  // 画像セレクタ更新
  if (sel) {
    sel.innerHTML = '';
    imageLayers.forEach(layer => {
      const opt = document.createElement('option');
      opt.value       = String(layer.id);
      opt.textContent = layer.name;
      sel.appendChild(opt);
    });
  }
  if (noImgMsg) noImgMsg.style.display = imageLayers.length ? 'none' : '';
  if (goBtn)   goBtn.disabled           = imageLayers.length === 0;

  // タイトルの初期値
  const titleEl = document.getElementById('ppen-export-title');
  if (titleEl && !titleEl.value) titleEl.value = _activeCourse().name || 'コース';

  overlay.style.display = 'flex';
}

/** Purple Pen エクスポート実行（ダイアログ確定後）*/
async function _doExportPPen() {
  const title    = document.getElementById('ppen-export-title')?.value?.trim() || _activeCourse().name || 'コース';
  const scale    = parseInt(document.getElementById('ppen-export-scale')?.value || '10000', 10);
  const layerIdS = document.getElementById('ppen-export-image')?.value;
  const layerId  = parseInt(layerIdS ?? '-1', 10);
  const layer    = _getMapLayers().find(l => l.id === layerId);

  if (!layer) { alert('地図画像を選択してください'); return; }

  // 画像ピクセル寸法
  let dims;
  try { dims = await _imgDimensions(layer.objectUrl); }
  catch { alert('画像の読み込みに失敗しました'); return; }

  const { w: imgW, h: imgH } = dims;
  const bbox = layer.bbox;

  // 地理的寸法（m）→ mm 換算
  const centerLat = (bbox.south + bbox.north) / 2;
  const widthM    = _haversineM(bbox.west, centerLat, bbox.east, centerLat);
  const heightM   = _haversineM(bbox.west, bbox.south, bbox.west, bbox.north);
  const widthMM   = widthM  / (scale / 1000);
  const heightMM  = heightM / (scale / 1000);
  const dpi       = imgW * 25.4 / widthMM;

  const xml = _buildPPenXML(title, layer.name, scale, dpi, widthMM, heightMM, bbox);
  if (!xml) { alert('エクスポートするコントロールがありません'); return; }

  const ppenName = title.replace(/[\\/:*?"<>|]/g, '_') + '.ppen';

  // 画像 blob 取得
  let imgBlob;
  try {
    const resp = await fetch(layer.objectUrl);
    imgBlob = await resp.blob();
  } catch { alert('画像データの取得に失敗しました'); return; }

  document.getElementById('ppen-export-overlay').style.display = 'none';

  // フォルダ選択（showDirectoryPicker 対応ブラウザ）
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });

      const writeFile = async (filename, blob) => {
        const fh = await dir.getFileHandle(filename, { create: true });
        const w  = await fh.createWritable();
        await w.write(blob); await w.close();
      };
      await writeFile(ppenName, new Blob([xml], { type: 'text/xml;charset=utf-8' }));
      await writeFile(layer.name, imgBlob);
      alert(`${ppenName} と ${layer.name} をエクスポートしました`);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('.ppen export error:', err);
        alert('エクスポートに失敗しました: ' + err.message);
      }
    }
  } else {
    // ZIP 非対応時: 個別ダウンロード（2ファイル）
    _downloadFile(new Blob([xml], { type: 'text/xml;charset=utf-8' }), ppenName);
    setTimeout(() => _downloadFile(imgBlob, layer.name), 600);
  }
}

// ---- インポート ----

/**
 * .ppen XML テキストをパースしてコースを読み込む。
 * 座標変換のため、対応画像が localMapLayers に読み込まれている必要がある。
 */
async function _importPPen(xmlText) {
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xmlText, 'text/xml');

    // イベント名（コースセット名）取得
    const title = doc.querySelector('event > title')?.textContent?.trim()
               || doc.querySelector('title')?.textContent?.trim()
               || 'インポート';

    // マップ情報取得
    const mapEl      = doc.querySelector('map');
    const mapKind    = mapEl?.getAttribute('kind') ?? 'bitmap';
    const dpi        = parseFloat(mapEl?.getAttribute('dpi')    || '96');
    const mapFilename = (mapEl?.textContent ?? '').trim();

    // 座標変換セットアップ（ビットマップ地図の場合）
    let bbox = null, widthMM = 0, heightMM = 0;

    if (mapKind === 'bitmap' && mapFilename) {
      // localMapLayers からファイル名でマッチング
      const layers    = _getMapLayers();
      const baseName  = mapFilename.replace(/.*[\\/]/, ''); // パス区切り除去
      const matchLayer = layers.find(l =>
        l.name === mapFilename ||
        l.name === baseName ||
        l.name.endsWith('/' + baseName) ||
        l.name.endsWith('\\' + baseName)
      );
      if (matchLayer) {
        try {
          const dims = await _imgDimensions(matchLayer.objectUrl);
          bbox      = matchLayer.bbox;
          widthMM   = dims.w * 25.4 / dpi;
          heightMM  = dims.h * 25.4 / dpi;
        } catch { /* 取得失敗時は変換なし */ }
      }
      if (!bbox) {
        const ok = confirm(
          `この .ppen は画像マップ「${baseName}」を使用しています。\n` +
          `TeleDrop にこの画像が読み込まれていないため座標変換ができません。\n\n` +
          `先に「${baseName}」を地図に読み込んでから再インポートしてください。\n` +
          `このまま（座標変換なし）でインポートしますか？`
        );
        if (!ok) return;
      }
    }

    // mm → lat/lng（bbox がない場合は 1/1000 スケールの緯度経度に変換）
    const mmToLngLat = (xMM, yMM) => {
      if (!bbox) return [xMM / 1000, yMM / 1000];
      return [
        bbox.west  + (xMM / widthMM)  * (bbox.east  - bbox.west),
        bbox.south + (yMM / heightMM) * (bbox.north  - bbox.south),
      ];
    };

    // 新コースセットを作成してロード（既存コースセットとは別に）
    await createCourseSet(_activeEventId, _activeEventTerrainId, title);

    // createCourseSet が作ったデフォルトコースを破棄してインポートデータで上書き
    _controlDefs.clear();
    _courses.length = 0;
    _nextDefId   = 0;
    _nextRouteId = 0;

    // コントロール定義の読み込み
    // Purple Pen control id → TeleDrop defId
    const ctrlIdMap = new Map();

    for (const ctrlEl of doc.querySelectorAll('control')) {
      const pid  = ctrlEl.getAttribute('id');
      const kind = ctrlEl.getAttribute('kind') ?? 'normal';
      if (kind === 'map-issue') continue; // map-issue は無視

      const code  = ctrlEl.querySelector('code')?.textContent?.trim() ?? '';
      const locEl = ctrlEl.querySelector('location');
      if (!locEl) continue;

      const xMM = parseFloat(locEl.getAttribute('x') || '0');
      const yMM = parseFloat(locEl.getAttribute('y') || '0');
      const [lng, lat] = mmToLngLat(xMM, yMM);

      const defId = 'd' + (_nextDefId++);
      _controlDefs.set(defId, { defId, code, lng, lat });
      ctrlIdMap.set(pid, defId);
    }

    // course-control リンクリストの解析
    const ccMap = new Map(); // ccId → { ctrlPid, nextCcId }
    for (const ccEl of doc.querySelectorAll('course-control')) {
      ccMap.set(ccEl.getAttribute('id'), {
        ctrlPid:  ccEl.getAttribute('control'),
        nextCcId: ccEl.querySelector('next')?.getAttribute('course-control') ?? null,
      });
    }
    const buildSeq = firstCcId => {
      const seq = []; let cur = firstCcId; const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const cc = ccMap.get(cur); if (!cc) break;
        const defId = ctrlIdMap.get(cc.ctrlPid); if (defId) seq.push(defId);
        cur = cc.nextCcId;
      }
      return seq;
    };

    // コース読み込み（order 順にソート）
    const courseEls = [...doc.querySelectorAll('course')]
      .filter(e => e.getAttribute('kind') !== 'relay')
      .sort((a, b) => parseInt(a.getAttribute('order') || '0', 10) - parseInt(b.getAttribute('order') || '0', 10));

    if (courseEls.length === 0) { alert('.ppen にコースが見つかりませんでした'); return; }

    const courseIdToIdx = new Map();
    for (let i = 0; i < courseEls.length; i++) {
      const el = courseEls[i];
      courseIdToIdx.set(el.getAttribute('id'), i);
      _courses.push({
        id:        'course-' + (Date.now() + i),
        name:      el.querySelector('name')?.textContent?.trim() || `コース${i + 1}`,
        sequence:  buildSeq(el.querySelector('first')?.getAttribute('course-control')),
        legRoutes: {},
      });
    }

    // ルートチョイス（special-object kind="line"）
    for (const soEl of doc.querySelectorAll('special-object[kind="line"]')) {
      const colorStr = soEl.querySelector('appearance')?.getAttribute('color') ?? '0.00,1.00,1.00,0.00';
      const colorIdx = _parsePPenCmyk(colorStr);

      const locEls = soEl.querySelectorAll('location');
      if (locEls.length < 2) continue;
      const coords = [...locEls].map(loc =>
        mmToLngLat(parseFloat(loc.getAttribute('x') || '0'), parseFloat(loc.getAttribute('y') || '0'))
      );

      // 属するコース
      const coursesEl = soEl.querySelector('courses');
      const courseRefs = coursesEl
        ? [...coursesEl.querySelectorAll('course')].map(c => c.getAttribute('course'))
        : courseEls.map(e => e.getAttribute('id'));

      for (const ref of courseRefs) {
        const ci = courseIdToIdx.get(ref);
        if (ci == null || ci >= _courses.length) continue;
        const course = _courses[ci];
        const seq    = course.sequence;

        // 最近傍のレッグに割り当て（先頭・末尾座標で距離最小判定）
        const [sLng, sLat] = coords[0];
        const [eLng, eLat] = coords[coords.length - 1];
        let bestKey = null, bestDist = Infinity;
        for (let si = 0; si < seq.length - 1; si++) {
          const fd = _controlDefs.get(seq[si]);
          const td = _controlDefs.get(seq[si + 1]);
          if (!fd || !td) continue;
          const d = (sLng - fd.lng) ** 2 + (sLat - fd.lat) ** 2
                  + (eLng - td.lng) ** 2 + (eLat - td.lat) ** 2;
          if (d < bestDist) { bestDist = d; bestKey = legKey(seq[si], seq[si + 1]); }
        }
        if (!bestKey) continue;
        if (!course.legRoutes[bestKey]) course.legRoutes[bestKey] = [];
        course.legRoutes[bestKey].push({ id: 'r' + (_nextRouteId++), colorIdx, coords });
      }
    }

    _activeCourseIdx = 0;
    await _saveToDb();
    _refreshSource();
    _scheduleCalc();
    _renderPanel();

    // 地図をコントロール範囲にフィット
    const allDefs = [..._controlDefs.values()];
    if (allDefs.length > 0) {
      _map.fitBounds([
        [Math.min(...allDefs.map(d => d.lng)), Math.min(...allDefs.map(d => d.lat))],
        [Math.max(...allDefs.map(d => d.lng)), Math.max(...allDefs.map(d => d.lat))],
      ], { padding: 100, duration: 600 });
    }
    _onImportDone?.();
  } catch (e) {
    console.error('.ppen import error:', e);
    alert('.ppen の読み込みに失敗しました: ' + e.message);
  }
}

/**
 * IOF XML 3.0 テキストをパースして新しいコースセットを作成する。
 * 緯度経度は <Position lng lat> から直接取得するため地図画像不要。
 */
async function _importIOFXML(xmlText) {
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xmlText, 'text/xml');

    if (doc.getElementsByTagName('parsererror').length > 0) {
      alert('XML のパースに失敗しました。');
      return;
    }

    // localName ベースの要素取得ヘルパー（namespace 非依存）
    const childrenByLocal = (el, localName) =>
      [...(el?.children ?? [])].filter(e => e.localName === localName);
    const firstChildByLocal = (el, localName) => childrenByLocal(el, localName)[0];

    // <Event><Name>
    const eventEl  = [...doc.getElementsByTagName('*')].find(e => e.localName === 'Event');
    const eventName = firstChildByLocal(eventEl, 'Name')?.textContent?.trim() || 'インポート';

    // 新コースセットを作成してロード（既存コースセットとは別に）
    await createCourseSet(_activeEventId, _activeEventTerrainId, eventName);

    // createCourseSet が作ったデフォルトコースを破棄してインポートデータで上書き
    _controlDefs.clear();
    _courses.length = 0;
    _nextDefId   = 0;
    _nextRouteId = 0;

    // <RaceCourseData> 直下の <Control> 要素からコントロール定義を構築
    const raceCourseDataEl = [...doc.getElementsByTagName('*')].find(e => e.localName === 'RaceCourseData');
    const ctrlIdMap = new Map(); // IOF Id → defId

    for (const ctrlEl of childrenByLocal(raceCourseDataEl, 'Control')) {
      const iofId = firstChildByLocal(ctrlEl, 'Id')?.textContent?.trim();
      if (!iofId) continue;

      const posEl = firstChildByLocal(ctrlEl, 'Position');
      if (!posEl) continue;

      const lng  = parseFloat(posEl.getAttribute('lng') || '0');
      const lat  = parseFloat(posEl.getAttribute('lat') || '0');
      const type = ctrlEl.getAttribute('type') || 'Control';
      // スタート・フィニッシュはコード非表示（TeleDrop は位置で種別を判定）
      const code = (type === 'Control') ? iofId : '';

      const defId = 'd' + (_nextDefId++);
      _controlDefs.set(defId, { defId, code, lng, lat });
      ctrlIdMap.set(iofId, defId);
    }

    // <Course> 要素からコースを構築
    const courseEls = childrenByLocal(raceCourseDataEl, 'Course');
    if (courseEls.length === 0) { alert('IOF XML にコースが見つかりませんでした'); return; }

    for (let i = 0; i < courseEls.length; i++) {
      const courseEl = courseEls[i];
      const name     = firstChildByLocal(courseEl, 'Name')?.textContent?.trim() || `コース${i + 1}`;

      const sequence = [];
      for (const ccEl of childrenByLocal(courseEl, 'CourseControl')) {
        // <Control> はテキスト参照（コントロール ID）
        const ctrlId = firstChildByLocal(ccEl, 'Control')?.textContent?.trim();
        if (!ctrlId) continue;
        const defId = ctrlIdMap.get(ctrlId);
        if (defId) sequence.push(defId);
      }

      _courses.push({
        id:        'course-' + (Date.now() + i),
        name,
        sequence,
        legRoutes: {},
      });
    }

    _activeCourseIdx = 0;
    await _saveToDb();
    _refreshSource();
    _scheduleCalc();
    _renderPanel();

    // 地図をコントロール範囲にフィット
    const allDefs = [..._controlDefs.values()];
    if (allDefs.length > 0) {
      _map.fitBounds([
        [Math.min(...allDefs.map(d => d.lng)), Math.min(...allDefs.map(d => d.lat))],
        [Math.max(...allDefs.map(d => d.lng)), Math.max(...allDefs.map(d => d.lat))],
      ], { padding: 100, duration: 600 });
    }
    _onImportDone?.();
  } catch (e) {
    console.error('IOF XML import error:', e);
    alert('IOF XML の読み込みに失敗しました: ' + e.message);
  }
}

// ================================================================
// IndexedDB 永続化（v4: localStorage から完全移行）
// ================================================================

const LS_KEY = 'teledrop_course_v2'; // 移行元キー（移行後は削除）

/**
 * 現在のアクティブイベント状態を IndexedDB に保存する（非同期・fire-and-forget）
 * コースセットレコードに controlDefs を含め、コースレコードを courses ストアに upsert する。
 */
async function _saveToDb() {
  if (!_activeCourseSetId) return;
  try {
    // ── コースセットレコードを更新 ──
    const controlDefsObj = {};
    _controlDefs.forEach((def, id) => {
      controlDefsObj[id] = { code: def.code, lng: def.lng, lat: def.lat };
    });
    // 既存レコードを取得してフィールドを保持（event_id / terrain_id 等）
    const existing = await getWsCourseSet(_activeCourseSetId);
    await saveWsCourseSet({
      ...(existing ?? {}),
      id:            _activeCourseSetId,
      name:          _activeCourseSetName,
      event_id:      existing?.event_id   ?? _activeEventId ?? null,
      terrain_id:    existing?.terrain_id ?? _activeEventTerrainId ?? null,
      controlDefs:   controlDefsObj,
      nextDefId:     _nextDefId,
      nextRouteId:   _nextRouteId,
      activeCourseId: _courses[_activeCourseIdx]?.id ?? null,
    });

    // ── 既存コースを全削除して upsert ──（シンプルな全置換）
    await deleteCoursesBySet(_activeCourseSetId);
    for (const c of _courses) {
      await saveWsCourse({
        id:             c.id,
        event_id:       _activeEventId ?? null,
        course_set_id:  _activeCourseSetId,
        name:           c.name,
        sequence:       [...c.sequence],
        selectedRoutes: [..._selectedRoutes.entries()].filter(([k]) => {
          // このコースのレッグキーのみ保存
          const [from] = k.split('>');
          return c.sequence.includes(from);
        }),
        legRoutes: Object.fromEntries(
          Object.entries(c.legRoutes ?? {}).map(([key, routes]) => [
            key,
            routes.map(r => ({ id: r.id, colorIdx: r.colorIdx, coords: r.coords })),
          ])
        ),
      });
    }
  } catch (e) {
    console.warn('course save failed:', e);
  }
}

/** デバウンスして IndexedDB に保存（300ms）*/
let _saveTimer = null;
function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveToDb, 300);
}

/** 保存タイマーをキャンセルして即時 IndexedDB に保存する（エクスプローラー更新前に呼ぶ） */
export async function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await _saveToDb();
}

/**
 * IndexedDB からコースセットとコースを読み込んでメモリに展開する
 * @param {string} courseSetId
 * @returns {Promise<boolean>} 成功 true
 */
async function _loadCourseSetFromDb(courseSetId) {
  try {
    const courseSet = await getWsCourseSet(courseSetId);
    if (!courseSet) return false;

    _activeCourseSetId   = courseSet.id;
    _activeCourseSetName = courseSet.name ?? '';
    _nextDefId           = courseSet.nextDefId  ?? 0;
    _nextRouteId         = courseSet.nextRouteId ?? 0;

    // コースセットが属するイベント情報を復元（mapSheet作成等で使用）
    if (courseSet.event_id) {
      const event = await getWsEvent(courseSet.event_id);
      _activeEventId        = event?.id        ?? null;
      _activeEventName      = event?.name      ?? '';
      _activeEventTerrainId = event?.terrain_id ?? null;
    } else {
      _activeEventId        = null;
      _activeEventName      = '';
      _activeEventTerrainId = courseSet.terrain_id ?? null;
    }

    // controlDefs 復元
    _controlDefs.clear();
    Object.entries(courseSet.controlDefs ?? {}).forEach(([id, def]) => {
      _controlDefs.set(id, { defId: id, code: def.code ?? '', lng: def.lng, lat: def.lat });
    });

    // courses 復元（course_set_id でフィルタ）
    const dbCourses = await getCoursesBySet(courseSetId);
    _courses.length = 0;
    _selectedRoutes.clear();
    dbCourses.forEach(c => {
      const legRoutes = {};
      Object.entries(c.legRoutes ?? {}).forEach(([key, routes]) => {
        legRoutes[key] = routes.map(r => ({
          id: r.id, colorIdx: r.colorIdx ?? 0, coords: r.coords ?? [],
        }));
      });
      _courses.push({
        id: c.id,
        name: c.name,
        sequence: [...(c.sequence ?? [])],
        legRoutes,
        terrainId: null,
      });
      (c.selectedRoutes ?? []).forEach(([k, v]) => _selectedRoutes.set(k, v));
    });

    if (_courses.length === 0) {
      _courses.push({ id: 'course0', name: 'コース1', sequence: [], legRoutes: {}, terrainId: null });
    }

    // activeCourseIdx を復元
    const savedActiveId = courseSet.activeCourseId;
    const idx = savedActiveId ? _courses.findIndex(c => c.id === savedActiveId) : -1;
    _activeCourseIdx = idx >= 0 ? idx : 0;

    return true;
  } catch (e) {
    console.warn('courseSet load failed:', e);
    return false;
  }
}

/**
 * localStorage の旧データ（v2）を IndexedDB へ移行する。
 * 移行成功後は localStorage のキーを削除する。
 * @returns {Promise<string|null>} 作成したイベントの id（移行データなしなら null）
 */
async function _migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.controlDefs && !data.courses?.length) {
      localStorage.removeItem(LS_KEY);
      return null;
    }

    const eventId     = 'event-migrated-' + Date.now();
    const courseSetId = 'cs-auto-' + eventId;
    const eventName   = '移行済みコース';

    await saveWsEvent({
      id:         eventId,
      name:       eventName,
      terrain_id: null,
      source:     'local',
    });
    await saveWsCourseSet({
      id:            courseSetId,
      event_id:      eventId,
      terrain_id:    null,
      name:          eventName,
      controlDefs:   data.controlDefs ?? {},
      nextDefId:     data.nextDefId   ?? 0,
      nextRouteId:   data.nextRouteId ?? 0,
      activeCourseId: null,
    });

    const courses = data.courses ?? [];
    for (const c of courses) {
      const legRoutes = {};
      Object.entries(c.legRoutes ?? {}).forEach(([key, routes]) => {
        legRoutes[key] = routes.map(r => ({ id: r.id, colorIdx: r.colorIdx ?? 0, coords: r.coords ?? [] }));
      });
      await saveWsCourse({
        id:            c.id,
        event_id:      eventId,
        course_set_id: courseSetId,
        name:          c.name,
        sequence:      [...(c.sequence ?? [])],
        legRoutes,
        selectedRoutes: data.selectedRoutes ?? [],
      });
    }

    localStorage.removeItem(LS_KEY);
    console.info('[course] localStorage → IndexedDB 移行完了:', eventId);
    return eventId;
  } catch (e) {
    console.warn('migration failed:', e);
    return null;
  }
}

// ================================================================
// コースクリア
// ================================================================

function _clearCourse() {
  _pushHistory();
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

  // コース名インライン編集（鉛筆ボタン → パンくずの課題名をクリック可能にする）
  const nameInput = document.getElementById('course-name-input');
  const renameBtn = document.getElementById('course-rename-btn');
  if (nameInput && renameBtn) {
    const _enterNameEdit = () => {
      if (!_activeCourse()) return;
      nameInput.value        = _activeCourse().name;
      nameInput.style.display = '';
      renameBtn.style.display = 'none';
      nameInput.focus();
      nameInput.select();
    };
    const _commitNameEdit = () => {
      if (!_activeCourse()) return;
      const name = nameInput.value.trim() || _activeCourse().name;
      _activeCourse().name    = name;
      nameInput.style.display = 'none';
      renameBtn.style.display = '';
      _updateBreadcrumb();
      _scheduleSave();
    };
    renameBtn.addEventListener('click', _enterNameEdit);
    nameInput.addEventListener('blur',    _commitNameEdit);
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); _commitNameEdit(); }
      if (e.key === 'Escape') { nameInput.style.display = 'none'; renameBtn.style.display = ''; }
    });
  }

  // タブ切り替え
  document.querySelectorAll('.course-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _renderPanel();
    });
  });

  // コース追加ボタン
  document.getElementById('course-add-btn')?.addEventListener('click', _addCourse);

  // コース削除ボタン
  document.getElementById('course-del-btn')?.addEventListener('click', () => {
    _deleteCourse(_activeCourseIdx);
  });

  document.getElementById('course-draw-toggle')?.addEventListener('click', () => {
    _setDrawMode(!_drawMode);
  });

  // コース空状態CTA ボタン
  document.getElementById('course-start-draw-btn')?.addEventListener('click', () => {
    _setDrawMode(true);
  });

  // 書き出しトリガー（改善4: ポップアップメニュー）
  const exportTrigger = document.getElementById('course-export-trigger');
  const exportMenu    = document.getElementById('course-export-menu');
  if (exportTrigger && exportMenu) {
    exportTrigger.addEventListener('click', e => {
      e.stopPropagation();
      const open = exportMenu.style.display !== 'none';
      exportMenu.style.display = open ? 'none' : 'block';
    });
    // 外側クリックで閉じる
    document.addEventListener('click', () => {
      if (exportMenu) exportMenu.style.display = 'none';
    });
    exportMenu.addEventListener('click', e => e.stopPropagation());
  }
  document.getElementById('course-export-btn')?.addEventListener('click', () => {
    if (exportMenu) exportMenu.style.display = 'none';
    _exportJSON();
  });
  document.getElementById('course-xml-btn')?.addEventListener('click', () => {
    if (exportMenu) exportMenu.style.display = 'none';
    _exportIOFXML();
  });
  // Purple Pen エクスポート
  document.getElementById('course-ppen-btn')?.addEventListener('click', () => {
    if (exportMenu) exportMenu.style.display = 'none';
    _exportPPen();
  });
  // .ppen エクスポートダイアログのボタン
  document.getElementById('ppen-export-go')?.addEventListener('click', _doExportPPen);
  document.getElementById('ppen-export-cancel')?.addEventListener('click', () => {
    document.getElementById('ppen-export-overlay').style.display = 'none';
  });
  document.getElementById('ppen-close-btn')?.addEventListener('click', () => {
    document.getElementById('ppen-export-overlay').style.display = 'none';
  });
  // オーバーレイ背景クリックで閉じる
  document.getElementById('ppen-export-overlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });

  const importFileEl = document.getElementById('course-import-file');
  document.getElementById('course-import-btn')?.addEventListener('click', () => importFileEl?.click());
  importFileEl?.addEventListener('change', () => {
    const f = importFileEl.files[0]; if (!f) return;
    const lname = f.name.toLowerCase();
    const isPPen = lname.endsWith('.ppen');
    const isXml  = lname.endsWith('.xml');
    const reader = new FileReader();
    reader.onload = e => {
      if (isPPen)      _importPPen(e.target.result);
      else if (isXml)  _importIOFXML(e.target.result);
      else             _importJSON(e.target.result);
    };
    reader.readAsText(f, 'utf-8');
    importFileEl.value = '';
  });



  // Undo / Redo ボタン
  document.getElementById('course-undo-btn')?.addEventListener('click', _undo);
  document.getElementById('course-redo-btn')?.addEventListener('click', _redo);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z — コースパネルが表示中のみ動作
  document.addEventListener('keydown', e => {
    // テキスト入力中は除外
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // コースエディタービューが表示中かどうかを確認
    const panel = document.getElementById('panel-layers');
    if (!panel?.classList.contains('ce-active')) return;

    const isZ = e.key === 'z' || e.key === 'Z';
    const isY = e.key === 'y' || e.key === 'Y';
    if (!e.ctrlKey && !e.metaKey) return;

    if (isZ && e.shiftKey) { e.preventDefault(); _redo(); return; }
    if (isZ)               { e.preventDefault(); _undo(); return; }
    if (isY)               { e.preventDefault(); _redo(); return; }
  });

  _updateHistoryButtons();
  _renderPanel();
}

// ================================================================
// 公開 API — app.js の map.on('load') から呼び出す
// ================================================================

// コースマップレイヤーの ID 一覧
const _COURSE_LAYERS = [
  'course-legs', 'course-routes', 'course-ctrl-outer', 'course-finish-inner',
  'course-start-icon', 'course-labels', 'course-vertex', 'course-midpoint',
  'course-hit', 'course-route-hit',
];

/**
 * コース関連の MapLibre レイヤーの表示/非表示を切り替える。
 * エクスプローラーのコースアイテム選択時に true、閉じたときに false を渡す。
 */
export function setCourseMapVisible(visible) {
  if (!_map) return;
  const v = visible ? 'visible' : 'none';
  for (const id of _COURSE_LAYERS) {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', v);
  }
}

// ================================================================
// 公開 API — イベント・コース管理
// ================================================================

/** アクティブイベントの ID を返す（mapSheet作成等で使用） */
export function getActiveEventId() { return _activeEventId; }
/** アクティブイベントの名前を返す */
export function getActiveEventName() { return _activeEventName; }
/** アクティブコースセットの ID を返す */
export function getActiveCourseSetId() { return _activeCourseSetId; }
/** アクティブコースセットの名前を返す */
export function getActiveCourseSetName() { return _activeCourseSetName; }

/**
 * パンくずデータを返す（右パネル表示用）
 */
export function getActiveBreadcrumb() {
  return {
    eventName:     _activeEventName,
    courseSetName: _activeCourseSetName,
    itemName:      _activeTab === 'controls' ? _activeCourseSetName : (_activeCourse()?.name ?? ''),
    itemType:      _activeTab, // 'course' | 'controls'
  };
}

/**
 * 新しいイベントを作成して IndexedDB に保存する（コースセットは別途作成）
 * @param {string|null} terrainId
 * @param {string}      name
 * @returns {Promise<string>} イベント ID
 */
export async function createEvent(terrainId, name) {
  const id = 'event-' + Date.now();
  await saveWsEvent({
    id,
    name:       name || '大会',
    terrain_id: terrainId ?? null,
    source:     'local',
  });
  // デフォルトのコースセットを作成してロード
  await createCourseSet(id, null, name || '大会');
  return id;
}

/**
 * 新しいコースセットを作成して IndexedDB に保存し、ロードする
 * @param {string|null} eventId    — 大会 ID（null の場合は terrain_id を使用）
 * @param {string|null} terrainId  — テレイン ID（eventId=null 時に使用）
 * @param {string}      name       — コースセット名
 * @returns {Promise<string>} コースセット ID
 */
export async function createCourseSet(eventId, terrainId, name) {
  const courseSetId     = 'cs-' + Date.now();
  const defaultCourseId = 'course-' + Date.now();
  await saveWsCourseSet({
    id:            courseSetId,
    event_id:      eventId   ?? null,
    terrain_id:    terrainId ?? null,
    name:          name || 'コースセット',
    controlDefs:   {},
    nextDefId:     0,
    nextRouteId:   0,
    activeCourseId: defaultCourseId,
  });
  await saveWsCourse({
    id:            defaultCourseId,
    event_id:      eventId ?? null,
    course_set_id: courseSetId,
    name:          'コース1',
    sequence:      [],
    legRoutes:     {},
    selectedRoutes: [],
  });
  await loadCourseSet(courseSetId);
  return courseSetId;
}

/**
 * 指定コースセットをメモリにロードする（アクティブ切替）
 * @param {string} courseSetId
 * @returns {Promise<boolean>}
 */
export async function loadCourseSet(courseSetId) {
  // 現在のコースセットを保存してから切り替え
  if (_activeCourseSetId && _activeCourseSetId !== courseSetId) {
    await _saveToDb();
  }
  const ok = await _loadCourseSetFromDb(courseSetId);
  if (ok) {
    _undoStack.length = 0;
    _redoStack.length = 0;
    _activeCtrlId = null;
    _editRoute    = null;
    _legStats     = [];
    _routeStatsCache.clear();
    _refreshSource();
    _scheduleCalc();
    _renderPanel();
  }
  return ok;
}

/**
 * 後方互換: イベントの最初のコースセットをロードする
 * app.js 内で loadEvent(eventId) を呼ぶ箇所を段階的に移行するための橋渡し
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
export async function loadEvent(eventId) {
  const courseSets = await getCourseSetsForEvent(eventId);
  if (courseSets.length > 0) {
    return loadCourseSet(courseSets[0].id);
  }
  // コースセットが存在しない（未移行データ等）→ イベントIDで暫定ロードを試みる
  // _activeEventId だけセットしてパネルをリフレッシュ
  const event = await getWsEvent(eventId);
  if (!event) return false;
  _activeEventId        = event.id;
  _activeEventName      = event.name;
  _activeEventTerrainId = event.terrain_id ?? null;
  _activeCourseSetId    = null;
  _activeCourseSetName  = '';
  _controlDefs.clear();
  _courses.length = 0;
  _courses.push({ id: 'course0', name: 'コース1', sequence: [], legRoutes: {}, terrainId: null });
  _activeCourseIdx = 0;
  _undoStack.length = 0;
  _redoStack.length = 0;
  _refreshSource();
  _renderPanel();
  return true;
}

/**
 * アクティブイベントを削除する
 * @param {string} eventId
 */
export async function deleteEvent(eventId) {
  await deleteWsEvent(eventId);
  if (_activeEventId === eventId) {
    _activeEventId        = null;
    _activeEventName      = '';
    _activeEventTerrainId = null;
    _activeCourseSetId    = null;
    _activeCourseSetName  = '';
    _controlDefs.clear();
    _courses.length = 0;
    _courses.push({ id: 'course0', name: 'コース1', sequence: [], legRoutes: {}, terrainId: null });
    _activeCourseIdx = 0;
    _undoStack.length = 0;
    _redoStack.length = 0;
    _refreshSource();
    _renderPanel();
  }
}

/**
 * コースセットを削除する（配下コースも削除）
 * @param {string} courseSetId
 */
export async function deleteCourseSet(courseSetId) {
  await deleteCoursesBySet(courseSetId);
  await deleteWsCourseSet(courseSetId);
  if (_activeCourseSetId === courseSetId) {
    _activeCourseSetId   = null;
    _activeCourseSetName = '';
    _activeEventId       = null;
    _activeEventName     = '';
    _controlDefs.clear();
    _courses.length = 0;
    _courses.push({ id: 'course0', name: 'コース1', sequence: [], legRoutes: {}, terrainId: null });
    _activeCourseIdx = 0;
    _undoStack.length = 0;
    _redoStack.length = 0;
    _refreshSource();
    _renderPanel();
  }
}

/**
 * コースセットを別のイベント/テレインへ移動する（DnD用）
 * @param {string} courseSetId
 * @param {{ eventId: string|null, terrainId: string|null }} target
 */
export async function moveCourseSet(courseSetId, { eventId, terrainId }) {
  const cs = await getWsCourseSet(courseSetId);
  if (!cs) return;
  // 配下コースの event_id も更新
  const courses = await getCoursesBySet(courseSetId);
  for (const c of courses) {
    await saveWsCourse({ ...c, event_id: eventId ?? null });
  }
  await saveWsCourseSet({ ...cs, event_id: eventId ?? null, terrain_id: terrainId ?? null });
  // アクティブなら内部状態も更新
  if (_activeCourseSetId === courseSetId) {
    _activeEventId        = eventId ?? null;
    _activeEventTerrainId = terrainId ?? null;
  }
}

/**
 * 全コースのサマリー一覧を返す（renderExplorer 用）
 * アクティブコースセットのコースのみ返す。
 */
export function getCoursesSummary() {
  return _courses.map(c => ({
    id:       c.id,
    name:     c.name,
    isEmpty:  c.sequence.length === 0,
    isActive: _courses[_activeCourseIdx]?.id === c.id,
  }));
}

/**
 * 指定コースをアクティブにする
 * @param {string} courseId
 */
export function setActiveCourse(courseId) {
  const idx = _courses.findIndex(c => c.id === courseId);
  if (idx === -1) return;
  _activeCourseIdx = idx;
  _activeTab       = 'course';
  _refreshSource();
  _scheduleCalc();
  _renderPanel();
}

/** 全コントロールタブを表示する（コースセットフォルダクリック時に呼び出す） */
export function showAllControlsTab() {
  _activeTab = 'controls';
  _renderPanel();
}

/**
 * アクティブコースセットにコースを追加する（app.js のツリー UI から呼び出す）
 * @returns {string|null} 追加したコースの ID（コースセット未ロード時は null）
 */
export function addCourseToActiveEvent() {
  if (!_activeCourseSetId) return null;
  return _addCourse();
}

/** addCourseToActiveEvent の別名（新命名） */
export function addCourseToActiveCourseSet() {
  return addCourseToActiveEvent();
}

/**
 * イベント名を変更して IndexedDB に保存する
 * @param {string} eventId
 * @param {string} name
 */
export async function renameEvent(eventId, name) {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const ev = await getWsEvent(eventId);
  if (!ev) return;
  await saveWsEvent({ ...ev, name: trimmed });
  if (_activeEventId === eventId) {
    _activeEventName = trimmed;
    _updateBreadcrumb();
  }
}

/**
 * コースセット名を変更して IndexedDB に保存する
 * @param {string} courseSetId
 * @param {string} name
 */
export async function renameCourseSet(courseSetId, name) {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const cs = await getWsCourseSet(courseSetId);
  if (!cs) return;
  await saveWsCourseSet({ ...cs, name: trimmed });
  if (_activeCourseSetId === courseSetId) {
    _activeCourseSetName = trimmed;
    _updateBreadcrumb();
  }
}

/**
 * コース名を変更する
 * @param {string} courseId
 * @param {string} newName
 */
export async function renameCourse(courseId, newName) {
  const trimmed = newName?.trim();
  if (!trimmed) return;
  // アクティブコースセット内のコースはメモリを直接更新して保存
  const course = _courses.find(c => c.id === courseId);
  if (course) {
    course.name = trimmed;
    _updateBreadcrumb();
    _scheduleSave();
  } else {
    // 非アクティブのコースは DB を直接更新
    const c = await getWsCourse(courseId);
    if (c) await saveWsCourse({ ...c, name: trimmed });
  }
}

/** 後方互換 — no-op */
export function setCourseTerrainId(_courseId, _terrainId) {}

/** 後方互換: 旧 createCourseForTerrain は createEvent に統合 */
export async function createCourseForTerrain(terrainId) {
  return createEvent(terrainId, '大会');
}

/**
 * 既存 DB の events レコードに残った controlDefs を course_sets へ移行する。
 * v5 アップグレード後の初回起動時に一度だけ実行する。
 * 移行済みイベント（controlDefs が空）はスキップする。
 */
export async function migrateCourseSets() {
  try {
    const events      = await getAllWsEvents();
    const existingSets = await getAllWsCourseSets();
    const existingSetIds = new Set(existingSets.map(cs => cs.id));

    for (const event of events) {
      // controlDefs がなければスキップ
      if (!event.controlDefs || Object.keys(event.controlDefs).length === 0) {
        // コースセットが存在しない大会にはデフォルトのコースセットを作成
        const sets = existingSets.filter(cs => cs.event_id === event.id);
        if (sets.length === 0) {
          const courseSetId = 'cs-auto-' + event.id;
          if (!existingSetIds.has(courseSetId)) {
            await saveWsCourseSet({
              id:             courseSetId,
              event_id:       event.id,
              terrain_id:     null,
              name:           event.name,
              controlDefs:    {},
              nextDefId:      0,
              nextRouteId:    0,
              activeCourseId: null,
            });
            existingSetIds.add(courseSetId);
            // 既存コースに course_set_id を付与
            const courses = await getCoursesByEvent(event.id);
            for (const c of courses) {
              if (!c.course_set_id) {
                await saveWsCourse({ ...c, course_set_id: courseSetId });
              }
            }
          }
        }
        continue;
      }

      const courseSetId = 'cs-auto-' + event.id;
      if (existingSetIds.has(courseSetId)) continue; // 移行済み

      // controlDefs を course_set に移動
      await saveWsCourseSet({
        id:             courseSetId,
        event_id:       event.id,
        terrain_id:     event.terrain_id ?? null,
        name:           event.name,
        controlDefs:    event.controlDefs,
        nextDefId:      event.nextDefId   ?? 0,
        nextRouteId:    event.nextRouteId ?? 0,
        activeCourseId: event.activeCourseId ?? null,
      });
      existingSetIds.add(courseSetId);

      // event から controlDefs 等を削除（軽量化）
      const cleanEvent = { ...event };
      delete cleanEvent.controlDefs;
      delete cleanEvent.nextDefId;
      delete cleanEvent.nextRouteId;
      delete cleanEvent.activeCourseId;
      await saveWsEvent(cleanEvent);

      // 既存コースに course_set_id を付与
      const courses = await getCoursesByEvent(event.id);
      for (const c of courses) {
        if (!c.course_set_id) {
          await saveWsCourse({ ...c, course_set_id: courseSetId });
        }
      }
      console.info('[course] migrateCourseSets: event', event.id, '→ courseSet', courseSetId);
    }
  } catch (e) {
    console.warn('[course] migrateCourseSets failed:', e);
  }
}

export async function initCoursePlanner(map) {
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
  map.on('click',        _onMapClick);
  // 右クリック: 描画モード中はカスタムメニュー、それ以外はブラウザデフォルト
  map.on('contextmenu',  _onMapContextmenu);

  _setupUI();

  // ── IndexedDB からコース状態を復元（または localStorage から移行） ──
  // まず localStorage の旧データを移行（初回のみ）
  const migratedEventId = await _migrateFromLocalStorage();

  // 次に既存イベントをロード（最後に使ったもの or 最初のもの or 移行済み）
  const allEvents = await getAllWsEvents();
  const targetEventId =
    migratedEventId ??
    (allEvents.length > 0 ? allEvents[0].id : null);

  if (targetEventId) {
    const ok = await loadEvent(targetEventId);
    if (ok) {
      _refreshSource();
      _scheduleCalc();
      _renderPanel();
    }
  }
}

/* ================================================================
   importModal.js — 地図画像 位置合わせモーダル（基本モード）
   init(map) で MapLibre インスタンスを注入する
   ================================================================ */

import { getDeclination }    from '../../core/magneticDeclination.js';
import { updateSliderGradient } from '../../utils/slider.js';
import { localMapLayers, addLocalMapLayer } from '../../store/localMapStore.js';
import { saveMapLayer }      from '../../api/mapImageDb.js';
import { getMapSheetsByEvent } from '../../api/workspace-db.js';
import { getActiveEventId }  from '../../core/course.js';
import { emit }              from '../../store/eventBus.js';
import {
  EASE_DURATION, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR, SIDEBAR_DEFAULT_WIDTH,
  INITIAL_PITCH, BASEMAPS,
} from '../../core/config.js';

let _map = null;

export function init(map) {
  _map = map;
}


/* =======================================================================
   地図画像 位置合わせモーダル（基本モード）
   ======================================================================= */

// 用紙サイズ定数（mm）: [幅, 高さ] 縦置き基準
const PAPER_SIZES_MM = { A4: [210, 297], A3: [297, 420], B4: [257, 364], B3: [364, 515] };

// ---- KMZ から画像と座標を抽出して位置合わせモーダルを開く ----
// loadKmz() の①〜⑦相当の処理を行い、直接マップ追加する代わりにモーダルへ渡す
export async function openImportModalFromKmz(file) {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const fileNames = Object.keys(zip.files);
    const kmlFileName = fileNames.find(n => n.toLowerCase().endsWith('.kml'));
    if (!kmlFileName) { alert('KMZ内にKMLファイルが見つかりません。'); return; }

    const kmlDom = new DOMParser().parseFromString(await zip.files[kmlFileName].async('text'), 'text/xml');
    if (kmlDom.getElementsByTagName('parseerror').length > 0) { alert('KML解析エラー。'); return; }

    const kmlGet = (root, tag) => root.getElementsByTagNameNS('*', tag)[0] ?? root.getElementsByTagName(tag)[0];
    const groundOverlay = kmlGet(kmlDom, 'GroundOverlay');
    if (!groundOverlay) { alert('GroundOverlay要素が見つかりません。'); return; }

    const latLonBox = kmlGet(groundOverlay, 'LatLonBox');
    if (!latLonBox) { alert('LatLonBox要素が見つかりません。'); return; }

    const north    = parseFloat(kmlGet(latLonBox, 'north')?.textContent);
    const south    = parseFloat(kmlGet(latLonBox, 'south')?.textContent);
    const east     = parseFloat(kmlGet(latLonBox, 'east')?.textContent);
    const west     = parseFloat(kmlGet(latLonBox, 'west')?.textContent);
    const rotation = parseFloat(kmlGet(latLonBox, 'rotation')?.textContent ?? '0');
    if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) { alert('LatLonBoxの座標値が読み取れません。'); return; }

    // KMZ と同じ回転計算（loadKmz と同ロジック）
    const cx = (east + west) / 2, cy = (north + south) / 2;
    const hw = (east - west) / 2, hh = (north - south) / 2;
    const rad = rotation * Math.PI / 180, cosR = Math.cos(rad), sinR = Math.sin(rad);
    const latCos = Math.cos(cy * Math.PI / 180);
    const rotateCorner = (dx, dy) => {
      const dxs = dx * latCos;
      return [cx + (dxs * cosR - dy * sinR) / latCos, cy + (dxs * sinR + dy * cosR)];
    };
    const kmzCoords = [
      rotateCorner(-hw, +hh), rotateCorner(+hw, +hh),
      rotateCorner(+hw, -hh), rotateCorner(-hw, -hh),
    ];

    // 画像を抽出してObjectURLを生成
    const iconHref = kmlGet(kmlGet(groundOverlay, 'Icon'), 'href')?.textContent?.trim();
    if (!iconHref) { alert('Icon/hrefが見つかりません。'); return; }
    const imgEntry = zip.files[iconHref] ?? zip.files[fileNames.find(n => n.endsWith('/' + iconHref) || n === iconHref)];
    if (!imgEntry) { alert(`KMZ内に画像 "${iconHref}" が見つかりません。`); return; }

    // Blob を importState.imgBlob に保存しておく（IndexedDB 保存に使用）
    const imgBlob = await imgEntry.async('blob');
    importState.imgBlob = imgBlob;
    importState.imgFile = null;

    const imgUrl = URL.createObjectURL(imgBlob);

    // モーダルをKMZ座標で開く（用紙サイズ設定UIは不要なので非表示）
    openImportModalWithCoords(imgUrl, kmzCoords, file.name);
  } catch (err) {
    console.error('KMZモーダル展開エラー:', err);
    alert(`KMZの読み込みに失敗しました: ${err.message}`);
  }
}

const importState = {
  // 画像情報
  imgFile:          null,   // インポート中の画像 File（画像直接読み込み時のみ）
  imgBlob:          null,   // 画像 Blob（IndexedDB 保存用。KMZ由来でも保持）
  imgUrl:           null,   // 対応する ObjectURL
  imgAspect:        null,   // 元画像の縦横比（width / height）
  coords:           null,   // 現在の4隅座標 [[lng,lat]*4] TL→TR→BR→BL
  center:           null,   // 中心マーカー位置 {lng, lat}
  baseCoords:       null,   // KMZモード：ドラッグ前の基準4隅座標（回転前）
  scaleCornerMarkers: [],   // 拡大縮小モードの4隅マーカー
  _handlers:        null,   // イベントハンドラ参照（closeAlignEditor でのクリーンアップ用）
  // Undo/Redo
  history:          [],     // undo スタック
  future:           [],     // redo スタック
  // スケール補正
  scaleVal:         100,    // 現在のスケール倍率（パーセント）
  baseScaleCoords:  null,   // スケール100%時の4隅座標（平行移動・回転と連動して更新）
  // ドラッグ（平行移動）
  isDragging:           false,
  dragStartLngLat:      null,
  dragStartCoords:      null,
  dragStartCenter:      null,
  dragStartBaseScaleCoords: null,   // 平行移動開始時の baseScaleCoords
  dragStartFixedPoints:     null,   // 平行移動開始時の固定点配列
  dragStartPendingFixedPoint: null, // 平行移動開始時の仮固定点
  dragRafId:        null,   // RAF スロットル用 ID
  // 固定点
  fixedPoints:              [],     // 固定点配列 [{lng, lat}]（最大2）
  fixedPointMarkers:        [],     // 固定点DOM要素配列
  fixedPointOverlay:        null,   // 固定点描画オーバーレイ
  pendingFixedPoint:        null,   // 追加中の仮固定点 {lng, lat}
  isSettingFixedPoint:      false,  // 固定点選択待ち（クリックで仮固定点を作る）
  isPlacingFixedPoint:      false,  // 仮固定点を画像と一緒にドラッグして位置合わせ中
  fixedPointOverlayEventsAdded: false,
  // 初期化フラグ
  interactionInited: false,
  eventsAdded:       false,
  // 磁気偏角キャッシュ（ドラッグ中に毎回計算しないよう dragend で更新）
  cachedDecl:       0,
  // コース枠スナップ / 確定時のコース枠 ID
  // null → 確定時に新規コース枠を作成（アクティブイベントがあれば）
  // 文字列 → 既存コース枠に画像を追加
  activeMapSheetId: null,
};

function _ensureFixedPointOverlay() {
  const container = _map.getContainer();
  if (!importState.fixedPointOverlay || !importState.fixedPointOverlay.isConnected) {
    const el = document.createElement('div');
    el.id = '_import-fixed-point-overlay';
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:6;';
    container.appendChild(el);
    importState.fixedPointOverlay = el;
  }
  if (!importState.fixedPointOverlayEventsAdded) {
    importState.fixedPointOverlayEventsAdded = true;
    const onReproject = () => _positionFixedPointDom();
    _map.on('move', onReproject);
    _map.on('resize', onReproject);
  }
}

function _positionFixedPointDom() {
  if (!importState.fixedPointOverlay) return;
  importState.fixedPointMarkers.forEach((el) => {
    const lng = parseFloat(el.dataset.lng || 'NaN');
    const lat = parseFloat(el.dataset.lat || 'NaN');
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const p = _map.project([lng, lat]);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  });
}

function _renderFixedPointMarkers() {
  _ensureFixedPointOverlay();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (!importState.fixedPointOverlay) return;
  importState.fixedPoints.forEach((pt, i) => {
    const el = document.createElement('div');
    // pointer-events:auto でホバー・ドラッグを有効化
    el.style.cssText =
      'width:14px;height:14px;background:#e54848;border:2px solid #fff;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);position:absolute;transform:translate(-50%,-50%);' +
      'pointer-events:auto;cursor:grab;';
    const num = document.createElement('span');
    num.textContent = String(i + 1);
    num.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'font-size:9px;font-weight:bold;color:#fff;line-height:1;pointer-events:none;';
    el.appendChild(num);
    el.dataset.lng = String(pt.lng);
    el.dataset.lat = String(pt.lat);

    // ---- ドラッグで固定点を再配置 ----
    el.addEventListener('mousedown', (startEvt) => {
      startEvt.stopPropagation(); // マップの pan 開始を抑制
      startEvt.preventDefault();
      _importSaveState();
      el.style.cursor = 'grabbing';
      const idx = i; // クロージャで添字を保持
      const onMove = (e) => {
        const rect   = _map.getContainer().getBoundingClientRect();
        const lngLat = _map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
        importState.fixedPoints[idx] = { lng: lngLat.lng, lat: lngLat.lat };
        el.dataset.lng = String(lngLat.lng);
        el.dataset.lat = String(lngLat.lat);
        _positionFixedPointDom();
      };
      const onUp = () => {
        el.style.cursor = 'grab';
        // 固定点移動後：逆スケール変換でベース座標を再構築（画像は動かさない）
        _updateBaseScaleCoords();
        _updateFixedPointStatus();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    importState.fixedPointOverlay.appendChild(el);
    importState.fixedPointMarkers.push(el);
  });
  if (importState.pendingFixedPoint) {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#e54848;border:2px dashed #fff;' +
      'border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);opacity:0.9;position:absolute;transform:translate(-50%,-50%);';
    el.dataset.lng = String(importState.pendingFixedPoint.lng);
    el.dataset.lat = String(importState.pendingFixedPoint.lat);
    importState.fixedPointOverlay.appendChild(el);
    importState.fixedPointMarkers.push(el);
  }
  _positionFixedPointDom();
}

function _updateFixedPointStatus() {
  const st = document.getElementById('import-fixed-point-status');
  const ct = document.getElementById('import-fixed-point-count');
  if (ct) ct.textContent = `${importState.fixedPoints.length} / 2`;
  if (!st) return;
  if (importState.isPlacingFixedPoint) {
    st.textContent = '位置合わせ中: 画像をドラッグして離すと固定点を確定';
  } else if (importState.isSettingFixedPoint) {
    st.textContent = `点選択中: ${importState.fixedPoints.length + 1}点目を地図上でクリック`;
  } else if (importState.fixedPoints.length > 0) {
    st.textContent = `固定点設定済み: ${importState.fixedPoints.length}点（通常平行移動は無効）`;
  } else {
    st.textContent = '待機中';
  }
  const setBtn = document.getElementById('import-fixed-point-set');
  const commitBtn = document.getElementById('import-fixed-point-commit');
  if (setBtn) {
    setBtn.classList.toggle('active', importState.isSettingFixedPoint || importState.isPlacingFixedPoint);
    setBtn.disabled = importState.fixedPoints.length >= 2;
  }
  if (commitBtn) {
    commitBtn.disabled = !importState.pendingFixedPoint;
  }
}

function _setFixedPointSettingMode(on) {
  importState.isSettingFixedPoint = !!on && importState.fixedPoints.length < 2;
  if (!importState.isSettingFixedPoint) importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _map.getCanvas().style.cursor = importState.isSettingFixedPoint ? 'crosshair' : '';
  _updateFixedPointStatus();
}

function _setPendingFixedPoint(lng, lat) {
  importState.pendingFixedPoint = { lng, lat };
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = true;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _commitPendingFixedPoint() {
  if (!importState.pendingFixedPoint || importState.fixedPoints.length >= 2) return;
  importState.fixedPoints.push({ ...importState.pendingFixedPoint });
  importState.pendingFixedPoint = null;
  importState.isPlacingFixedPoint = false;
  importState.isSettingFixedPoint = false;
  _updateBaseScaleCoords();
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _clearImportFixedPoints() {
  importState.fixedPoints = [];
  importState.pendingFixedPoint = null;
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
}

function _getImportTransformOrigin() {
  if (importState.fixedPoints.length > 0) {
    const sum = importState.fixedPoints.reduce((acc, pt) => ({ lng: acc.lng + pt.lng, lat: acc.lat + pt.lat }), { lng: 0, lat: 0 });
    return [sum.lng / importState.fixedPoints.length, sum.lat / importState.fixedPoints.length];
  }
  if (importState.center) return [importState.center.lng, importState.center.lat];
  return null;
}

function _rotateCoordsAroundPivot(coords, angleDeg, pivot) {
  const poly = turf.polygon([[...coords, coords[0]]]);
  const rot  = turf.transformRotate(poly, angleDeg, { pivot });
  return rot.geometry.coordinates[0].slice(0, 4);
}

function _recalcImportCenterFromCoords() {
  if (!importState.coords) return;
  importState.center = {
    lng: importState.coords.reduce((s, c) => s + c[0], 0) / 4,
    lat: importState.coords.reduce((s, c) => s + c[1], 0) / 4,
  };
}

function _transformCoordsByPivotMove(startCoords, pivot, startMovePoint, currentMovePoint) {
  // MapLibre の描画座標系（WebMercator）上で相似変換することで、
  // 固定点と画像の見た目位置をズーム変更時も一致させる。
  const toMc = (lngLat) => {
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lngLat[0], lat: lngLat[1] });
    return [mc.x, mc.y];
  };
  const toLngLat = (xy) => {
    const ll = new maplibregl.MercatorCoordinate(xy[0], xy[1], 0).toLngLat();
    return [ll.lng, ll.lat];
  };

  const p  = toMc(pivot);
  const s0 = toMc(startMovePoint);
  const s1 = toMc(currentMovePoint);
  const v0 = [s0[0] - p[0], s0[1] - p[1]];
  const v1 = [s1[0] - p[0], s1[1] - p[1]];
  const len0 = Math.hypot(v0[0], v0[1]);
  const len1 = Math.hypot(v1[0], v1[1]);
  const scale = len0 > 1e-12 ? (len1 / len0) : 1;
  const a0 = Math.atan2(v0[1], v0[0]);
  const a1 = Math.atan2(v1[1], v1[0]);
  const da = a1 - a0;
  const cos = Math.cos(da);
  const sin = Math.sin(da);

  return startCoords.map((c) => {
    const q = toMc(c);
    const vx = q[0] - p[0];
    const vy = q[1] - p[1];
    const rx = (vx * cos - vy * sin) * scale;
    const ry = (vx * sin + vy * cos) * scale;
    return toLngLat([p[0] + rx, p[1] + ry]);
  });
}

function _applyPendingFixedPointPlacement(currentLngLat) {
  if (!importState.isPlacingFixedPoint || !importState.dragStartCoords || !importState.dragStartLngLat || !currentLngLat) return;
  const dx = currentLngLat.lng - importState.dragStartLngLat.lng;
  const dy = currentLngLat.lat - importState.dragStartLngLat.lat;
  const hasPivot = (importState.dragStartFixedPoints || []).length >= 1;
  if (hasPivot && importState.dragStartPendingFixedPoint) {
    const pivot = [importState.dragStartFixedPoints[0].lng, importState.dragStartFixedPoints[0].lat];
    const startMove = [importState.dragStartPendingFixedPoint.lng, importState.dragStartPendingFixedPoint.lat];
    const currentMove = [currentLngLat.lng, currentLngLat.lat];
    importState.coords = _transformCoordsByPivotMove(importState.dragStartCoords, pivot, startMove, currentMove);
    _recalcImportCenterFromCoords();
    importState.fixedPoints = importState.dragStartFixedPoints.map(pt => ({ ...pt }));
    importState.pendingFixedPoint = { lng: currentLngLat.lng, lat: currentLngLat.lat };
  } else if (importState.dragStartPendingFixedPoint) {
    importState.coords = importState.dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
    if (importState.dragStartBaseScaleCoords)
      importState.baseScaleCoords = importState.dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
    importState.pendingFixedPoint = { lng: importState.dragStartPendingFixedPoint.lng + dx, lat: importState.dragStartPendingFixedPoint.lat + dy };
  }
  _updateBaseScaleCoords();
  _renderFixedPointMarkers();
}

// ---- 用紙サイズ＋縮尺 → 実世界サイズ（メートル）を計算 ----
function _calcImportSizeMm() {
  const paperKey    = document.getElementById('import-paper-size').value;
  const orientation = document.getElementById('import-orientation').value;
  let [paperWmm, paperHmm] = PAPER_SIZES_MM[paperKey] || [210, 297];
  if (orientation === 'landscape') [paperWmm, paperHmm] = [paperHmm, paperWmm];

  let effWmm = paperWmm;
  let effHmm = paperHmm;
  if (importState.imgAspect && importState.imgAspect > 0) {
    const paperAspect = paperWmm / paperHmm;
    if (importState.imgAspect > paperAspect) {
      effWmm = paperWmm;
      effHmm = effWmm / importState.imgAspect;
    } else {
      effHmm = paperHmm;
      effWmm = effHmm * importState.imgAspect;
    }
  }
  return {
    paperWmm,
    paperHmm,
    effWmm,
    effHmm,
    marginXmm: Math.max(0, (paperWmm - effWmm) / 2),
    marginYmm: Math.max(0, (paperHmm - effHmm) / 2),
  };
}

function _importCalcSizeM() {
  const scaleEl    = document.getElementById('import-scale');
  const scale      = scaleEl.value === 'custom'
    ? (parseFloat(document.getElementById('import-scale-custom').value) || 10000)
    : parseInt(scaleEl.value, 10);
  const { effWmm, effHmm } = _calcImportSizeMm();
  // mm × 縮尺 ÷ 1000 = 実世界メートル
  return [effWmm / 1000 * scale, effHmm / 1000 * scale];
}

// ---- 中心座標＋サイズ(m)＋磁北補正角(deg) → 4隅 [TL,TR,BR,BL] ----
// オリエンテーリング地図は磁北が真上のため、declination 分だけ回転させる
function _importCalcCorners(lng, lat, widthM, heightM, decl) {
  const center = [lng, lat];
  const hw = widthM  / 2 / 1000; // km
  const hh = heightM / 2 / 1000; // km
  // Turf.destination: bearing は真北(0)から時計回り
  const up   = decl;       // 地図の「上」= 磁北方向
  const down = decl + 180;
  const L    = decl - 90;  // 左
  const R    = decl + 90;  // 右
  const dest = (pt, dist, bear) =>
    turf.getCoord(turf.destination(pt, dist, bear, { units: 'kilometers' }));

  const top    = dest(center, hh, up);
  const bottom = dest(center, hh, down);
  return [
    dest(top,    hw, L),  // TL
    dest(top,    hw, R),  // TR
    dest(bottom, hw, R),  // BR
    dest(bottom, hw, L),  // BL
  ];
}

// ---- 画像ソース/レイヤーを更新して再描画 ----
// 既存ソースがある場合は updateImage + triggerRepaint でドラッグ中のリアルタイム表示を実現。
// 初回のみ addSource + addLayer で生成する。
function _replaceImageSource() {
  if (!importState.imgUrl || !importState.coords) return;
  const src = _map.getSource('_import-img');
  if (src) {
    // ドラッグ中の高速パス:
    // 画像URL再設定を伴う updateImage は高コストになりやすいため、
    // 利用可能なら setCoordinates で座標のみ更新する。
    if (typeof src.setCoordinates === 'function') {
      src.setCoordinates(importState.coords);
    } else {
      src.updateImage({ url: importState.imgUrl, coordinates: importState.coords });
    }
    _map.triggerRepaint();
  } else {
    // 初回: ソース・レイヤーを追加（透明度スライダーの現在値を反映）
    const initOpacity = (parseInt(document.getElementById('import-opacity')?.value ?? '70', 10)) / 100;
    _map.addSource('_import-img', { type: 'image', url: importState.imgUrl, coordinates: importState.coords });
    _map.addLayer({ id: '_import-layer', type: 'raster', source: '_import-img', paint: { 'raster-opacity': initOpacity } });
  }
  // ヒットボックスの初期化 & 更新（ドラッグ中はスキップして軽量化）
  _initImgInteraction();
  if (!importState.isDragging) {
    _updateHitbox();
    enterScaleMode();
  }
  // 常時有効の4隅マーカーを同期
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
  }
}

// ---- RAFスロットル付き _replaceImageSource（ドラッグ中の高速リアルタイム更新） ----
// leading-edge: 既に RAF がキューに入っていれば追加しない。
// これにより「マウス移動の最初のイベントで即時更新」が保証され、trailing-edge より遅延が少ない。
function _replaceImageSourceRaf() {
  if (importState.dragRafId) return; // 既にキュー済み
  importState.dragRafId = requestAnimationFrame(() => {
    importState.dragRafId = null;
    _replaceImageSource();
  });
}

/* =======================================================================
   ヒットボックス（透明ポリゴン）＆ アンテナ型回転ハンドル ヘルパー群
   ======================================================================= */

// ---- importState.coords から GeoJSON ポリゴンを生成 ----
function _importCoordsToPolygon() {
  if (!importState.coords) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[...importState.coords, importState.coords[0]]] }
  };
}

// ---- スケール UI を現在の importState.scaleVal に同期 ----
function _syncScaleUI() {
  const el    = document.getElementById('import-scale-adj');
  const valEl = document.getElementById('import-scale-adj-val');
  if (el)    el.value = Math.min(110, Math.max(90, importState.scaleVal));
  if (valEl) valEl.textContent = importState.scaleVal.toFixed(1) + '%';
  if (el) updateSliderGradient(el);
}

// ---- importState.baseScaleCoords × importState.scaleVal → importState.coords を再計算（Turf.js） ----
function _applyImportScale() {
  if (!importState.baseScaleCoords) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[...importState.baseScaleCoords, importState.baseScaleCoords[0]]]);
  const scaled = turf.transformScale(poly, importState.scaleVal / 100, { origin });
  importState.coords = scaled.geometry.coordinates[0].slice(0, 4);
}

// ---- importState.coords の逆スケールで importState.baseScaleCoords を再構築 ----
// （4隅ドラッグ後など、coords 側が先に確定したときに呼ぶ）
function _updateBaseScaleCoords() {
  if (!importState.coords || importState.scaleVal <= 0) return;
  const origin = _getImportTransformOrigin();
  if (!origin) return;
  const poly   = turf.polygon([[...importState.coords, importState.coords[0]]]);
  const base   = turf.transformScale(poly, 100 / importState.scaleVal, { origin });
  importState.baseScaleCoords = base.geometry.coordinates[0].slice(0, 4);
}

// ---- 現在の importState.scaleVal を座標へ反映（画像/KMZ 両モード） ----
function _updateImportScale() {
  if (importState.baseCoords) {
    _applyKmzTransform();
  } else {
    _applyImportScale();
    _replaceImageSource();
  }
}

// ---- ヒットボックスポリゴンソースを最新座標で更新 ----
function _updateHitbox() {
  if (!importState.coords) return;
  const src = _map.getSource('_import-hitbox');
  if (src) src.setData(_importCoordsToPolygon());
}


// ---- 画像モード専用：キャッシュした偏角で回転のみ再計算し現在スケールを適用 ----
function _updateImportRotation() {
  if (!importState.center || !importState.imgUrl) return;
  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  // 回転0°（磁北補正のみ）のベースから、指定の回転補正を適用
  const origin = _getImportTransformOrigin() ?? [importState.center.lng, importState.center.lat];
  const baseNoRot = _importCalcCorners(importState.center.lng, importState.center.lat, wM, hM, importState.cachedDecl);
  importState.baseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  // 現在のスケール倍率を適用して importState.coords を確定
  _applyImportScale();
  _replaceImageSource();
}


// ---- ヒットボックス + ドラッグ平行移動 を初期化（冪等） ----
function _initImgInteraction() {
  if (!importState.coords) return;

  // --- ヒットボックスのソース・レイヤー（なければ追加） ---
  if (!_map.getSource('_import-hitbox')) {
    _map.addSource('_import-hitbox', { type: 'geojson', data: _importCoordsToPolygon() });
    _map.addLayer({
      id: '_import-hitbox-layer', type: 'fill', source: '_import-hitbox',
      // fill-opacity: 0 だとクリックを拾えない場合があるため極小値を使用
      paint: { 'fill-color': '#000000', 'fill-opacity': 0.001 }
    });
    importState.interactionInited = true;
  }

  // --- イベントリスナーは一度だけ追加（_handlers に保存してクリーンアップ可能にする） ---
  if (!importState.eventsAdded) {
    importState.eventsAdded = true;

    // カーソル制御（レイヤーイベントはレイヤー削除時に自動無効化される）
    _map.on('mouseenter', '_import-hitbox-layer', () => {
      if (!importState.isDragging) {
        _map.getCanvas().style.cursor = (importState.isSettingFixedPoint || importState.isPlacingFixedPoint) ? 'crosshair' : 'move';
      }
    });
    _map.on('mouseleave', '_import-hitbox-layer', () => {
      if (!importState.isDragging) _map.getCanvas().style.cursor = '';
    });

    // mousedown → ドラッグ開始（hitboxレイヤー上）
    _map.on('mousedown', '_import-hitbox-layer', (e) => {
      if (!importState.coords) return;
      // 固定点追加モード中は、クリック保持ですぐドラッグ位置合わせに入る
      if (importState.isSettingFixedPoint && importState.fixedPoints.length < 2) {
        e.preventDefault();
        _importSaveState();
        _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
        importState.isDragging = true;
        importState.dragStartLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        importState.dragStartCoords = importState.coords.map(c => [...c]);
        importState.dragStartCenter = importState.center ? { ...importState.center } : null;
        importState.dragStartBaseScaleCoords = importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null;
        importState.dragStartFixedPoints = importState.fixedPoints.map(pt => ({ ...pt }));
        importState.dragStartPendingFixedPoint = importState.pendingFixedPoint ? { ...importState.pendingFixedPoint } : null;
        _map.dragPan.disable();
        _map.getCanvas().style.cursor = 'crosshair';
        return;
      }
      if (((importState.fixedPoints.length > 0) || importState.isSettingFixedPoint) && !importState.isPlacingFixedPoint) return;
      e.preventDefault();
      _importSaveState();
      importState.isDragging = true;
      importState.dragStartLngLat          = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      importState.dragStartCoords          = importState.coords.map(c => [...c]);
      importState.dragStartCenter          = importState.center          ? { ...importState.center }          : null;
      importState.dragStartBaseScaleCoords = importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null;
      importState.dragStartFixedPoints = importState.fixedPoints.map(pt => ({ ...pt }));
      importState.dragStartPendingFixedPoint = importState.pendingFixedPoint ? { ...importState.pendingFixedPoint } : null;
      _map.dragPan.disable();
      _map.getCanvas().style.cursor = importState.isPlacingFixedPoint ? 'crosshair' : 'grabbing';
    });

    // mousemove → ドラッグ中に座標をリアルタイム更新
    const onMouseMove = (e) => {
      if (!importState.isDragging) return;
      const dx = e.lngLat.lng - importState.dragStartLngLat.lng;
      const dy = e.lngLat.lat - importState.dragStartLngLat.lat;
      importState.center = importState.dragStartCenter
        ? { lng: importState.dragStartCenter.lng + dx, lat: importState.dragStartCenter.lat + dy }
        : null;
      if (importState.baseCoords) {
        if (importState.isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
          _replaceImageSourceRaf();
        } else {
          if (importState.dragRafId) cancelAnimationFrame(importState.dragRafId);
          importState.dragRafId = requestAnimationFrame(() => {
            importState.dragRafId = null;
            _applyKmzTransform();
          });
        }
      } else {
        if (importState.isPlacingFixedPoint) {
          _applyPendingFixedPointPlacement(e.lngLat);
        } else {
          importState.coords = importState.dragStartCoords.map(c => [c[0] + dx, c[1] + dy]);
          if (importState.dragStartBaseScaleCoords)
            importState.baseScaleCoords = importState.dragStartBaseScaleCoords.map(c => [c[0] + dx, c[1] + dy]);
        }
        _replaceImageSourceRaf();
      }
    };

    // mouseup → ドラッグ終了
    const onMouseUp = () => {
      if (!importState.isDragging) return;
      importState.isDragging = false;
      _map.dragPan.enable();
      _map.getCanvas().style.cursor = '';
      _updateHitbox();
      if (importState.center) {
        try { importState.cachedDecl = getDeclination(importState.center.lat, importState.center.lng) ?? 0; } catch (e) {}
      }
      if (importState.isPlacingFixedPoint && importState.pendingFixedPoint) {
        _commitPendingFixedPoint();
      }
    };

    // 固定点設定モード: 次のクリック位置を仮固定点にする
    const onMapClick = (e) => {
      if (!importState.isSettingFixedPoint) return;
      if (importState.fixedPoints.length >= 2) return;
      _importSaveState();
      _setPendingFixedPoint(e.lngLat.lng, e.lngLat.lat);
      _updateFixedPointStatus();
      _replaceImageSource();
    };

    _map.on('mousemove', onMouseMove);
    _map.on('mouseup', onMouseUp);
    _map.on('click', onMapClick);

    // クリーンアップ用に保存
    importState._handlers = { mousemove: onMouseMove, mouseup: onMouseUp, click: onMapClick };
  }
}

// ---- Undo/Redo：現在の座標・中心・回転値を履歴に保存 ----
function _importSaveState() {
  if (!importState.coords) return;
  importState.history.push({
    coords : importState.coords.map(c => [...c]),
    center : importState.center ? { ...importState.center } : null,
    rotation: document.getElementById('import-rotation')?.value ?? '0',
    scaleVal: importState.scaleVal,
    baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
    fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
  });
  importState.future = []; // 新操作でredo履歴をクリア
}

// ---- Undo：一つ前の状態を復元 ----
function _importUndo() {
  if (importState.history.length === 0) return;
  // 現在の状態をredo用に保存
  if (importState.coords) {
    importState.future.push({
      coords : importState.coords.map(c => [...c]),
      center : importState.center ? { ...importState.center } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: importState.scaleVal,
      baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
      fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = importState.history.pop();
  _importRestoreState(state);
}

// ---- Redo：一つ先の状態に進む ----
function _importRedo() {
  if (importState.future.length === 0) return;
  if (importState.coords) {
    importState.history.push({
      coords : importState.coords.map(c => [...c]),
      center : importState.center ? { ...importState.center } : null,
      rotation: document.getElementById('import-rotation')?.value ?? '0',
      scaleVal: importState.scaleVal,
      baseScaleCoords: importState.baseScaleCoords ? importState.baseScaleCoords.map(c => [...c]) : null,
      fixedPoints: importState.fixedPoints.map(pt => ({ ...pt })),
    });
  }
  const state = importState.future.pop();
  _importRestoreState(state);
}

// ---- 状態を復元して再描画 ----
function _importRestoreState(state) {
  importState.coords = state.coords.map(c => [...c]);
  importState.center = state.center ? { ...state.center } : null;
  importState.scaleVal = Number.isFinite(state.scaleVal) ? state.scaleVal : 100;
  importState.baseScaleCoords = state.baseScaleCoords
    ? state.baseScaleCoords.map(c => [...c])
    : null;
  if (Array.isArray(state.fixedPoints)) {
    importState.fixedPoints = state.fixedPoints.map(pt => ({ ...pt })).slice(0, 2);
  } else if (state.fixedPoint) {
    importState.fixedPoints = [{ ...state.fixedPoint }];
  } else {
    importState.fixedPoints = [];
  }
  importState.pendingFixedPoint = null;
  importState.isSettingFixedPoint = false;
  importState.isPlacingFixedPoint = false;
  _renderFixedPointMarkers();
  _updateFixedPointStatus();
  if (!importState.baseScaleCoords) _updateBaseScaleCoords();
  _syncScaleUI();
  const rotEl = document.getElementById('import-rotation');
  if (rotEl) {
    rotEl.value = state.rotation;
    document.getElementById('import-rotation-val').textContent =
      parseFloat(state.rotation).toFixed(2);
  }
  // 常時有効の4隅マーカーも更新
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
  }
  // 旧・微調整モード（廃止）: if (_fineTuneActive && _importCornerMarkers.length === 4) { _importCornerMarkers.forEach(...) }
  _replaceImageSource();
}

// ---- プレビューマップ上のソース/マーカーを最新設定に更新（画像モード用） ----
function _updateImportPreview() {
  if (!importState.imgUrl) return;

  // 中心位置：マーカーがなければメインマップ中心で初期化
  if (!importState.center) {
    const mc = _map.getCenter();
    importState.center = { lng: mc.lng, lat: mc.lat };
  }
  const c = importState.center;

  const [wM, hM] = _importCalcSizeM();
  const rotOffset = parseFloat(document.getElementById('import-rotation')?.value ?? '0');
  let decl = 0;
  try { decl = getDeclination(c.lat, c.lng) ?? 0; } catch (e) {}
  importState.cachedDecl = decl;
  importState.scaleVal        = 100;
  const origin = _getImportTransformOrigin() ?? [c.lng, c.lat];
  const baseNoRot = _importCalcCorners(c.lng, c.lat, wM, hM, decl);
  importState.baseScaleCoords = Math.abs(rotOffset) < 1e-9
    ? baseNoRot
    : _rotateCoordsAroundPivot(baseNoRot, rotOffset, origin);
  importState.coords = importState.baseScaleCoords.map(p => [...p]);
  _syncScaleUI();

  // 初回のみ: メインマップを画像位置にフィット
  if (!_map.getSource('_import-img')) {
    const lngs = importState.coords.map(p => p[0]), lats = importState.coords.map(p => p[1]);
    _map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: FIT_BOUNDS_PAD, duration: 400 }
    );
  }

  // 画像ソース更新 → _initImgInteraction も内部で呼ばれる
  _replaceImageSource();
}

/* =========================================================================
   地図画像 位置合わせ — 右パネル UI
   ========================================================================= */

/**
 * 位置合わせエディター用の右パネルを構築してイベントリスナーを接続する。
 * @param {boolean} showStep1 - true=画像モード（用紙サイズUI表示）, false=KMZモード
 * @returns {HTMLElement} 右パネルに渡すコンテナ要素
 */
function _buildAlignEditorPanel(showStep1 = true) {
  const wrap = document.createElement('div');
  wrap.id = 'align-editor-panel';
  wrap.className = 'import-controls-wrap';

  wrap.innerHTML = `
    <!-- Undo/Redo -->
    <div id="import-undo-redo-group" class="align-undo-redo">
      <button class="import-undo-redo-btn" id="import-undo-btn" title="元に戻す (Ctrl+Z)">↩</button>
      <button class="import-undo-redo-btn" id="import-redo-btn" title="やり直し (Ctrl+Y)">↪</button>
    </div>

    <!-- 既存の枠に合わせる（ショートカット）-->
    <div class="import-ctrl-section" id="import-snap-section" style="display:none">
      <div class="import-ctrl-section-title">既存の枠に合わせる（ショートカット）</div>
      <div class="import-ctrl-hint">すでに配置済みの地図枠を選ぶと、手動位置合わせをスキップできます。</div>
      <div id="import-snap-list" class="import-snap-list"></div>
    </div>

    <!-- ステップ1：サイズを指定（画像モードのみ） -->
    <div class="import-ctrl-section" id="import-step1-section" style="${showStep1 ? '' : 'display:none'}">
      <div class="import-ctrl-section-title">Step 1 ― サイズを指定</div>
      <div id="import-image-only-ctrl">
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">用紙サイズ</div>
          <select id="import-paper-size" class="import-ctrl-select">
            <option value="A4">A4（210×297 mm）</option>
            <option value="A3">A3（297×420 mm）</option>
            <option value="B4">B4-JIS（257×364 mm）</option>
            <option value="B3">B3-JIS（364×515 mm）</option>
          </select>
        </div>
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">向き</div>
          <select id="import-orientation" class="import-ctrl-select">
            <option value="portrait">縦（Portrait）</option>
            <option value="landscape">横（Landscape）</option>
          </select>
        </div>
        <div class="import-ctrl-group">
          <div class="import-ctrl-label">縮尺</div>
          <select id="import-scale" class="import-ctrl-select">
            <option value="3000">1:3,000</option>
            <option value="4000">1:4,000</option>
            <option value="5000" selected>1:5,000</option>
            <option value="7500">1:7,500</option>
            <option value="10000">1:10,000</option>
            <option value="15000">1:15,000</option>
            <option value="custom">手入力...</option>
          </select>
          <input type="number" id="import-scale-custom" class="import-ctrl-input"
            placeholder="例: 10000" min="500" max="200000" style="display:none;margin-top:4px;" />
        </div>
      </div>
    </div>

    <!-- ステップ2：位置と角度を合わせる -->
    <div class="import-ctrl-section">
      <div class="import-ctrl-section-title">Step ${showStep1 ? '2' : '1'} ― 位置と角度を合わせる</div>
      <div class="import-ctrl-hint">※画像を直接ドラッグして移動できます。</div>
      <div class="import-ctrl-hint">※4隅の青マーカーをドラッグして拡大縮小できます。</div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label import-label-with-reset">
          <span>回転補正&emsp;<span id="import-rotation-val">0.00</span>°</span>
          <button id="import-rotation-reset" class="import-reset-btn" type="button" title="回転補正を初期値に戻す">↺</button>
        </div>
        <div class="import-slider-line">
          <span class="import-slider-side left">-2.0</span>
          <div class="import-slider-wrap" style="--init-pct:50%">
            <input type="range" id="import-rotation" class="ui-slider import-ctrl-slider"
              min="-2" max="2" value="0" step="0.05" />
          </div>
          <span class="import-slider-side right">2.0</span>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-rotation-minus">−0.05°</button>
          <button class="import-rotation-adj-btn" id="import-rotation-plus">+0.05°</button>
        </div>
      </div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label import-label-with-reset">
          <span>スケール補正&emsp;<span id="import-scale-adj-val">100.0%</span></span>
          <button id="import-scale-adj-reset" class="import-reset-btn" type="button" title="スケール補正を初期値に戻す">↺</button>
        </div>
        <div class="import-slider-line">
          <span class="import-slider-side left">90</span>
          <div class="import-slider-wrap" style="--init-pct:50%">
            <input type="range" id="import-scale-adj" class="ui-slider import-ctrl-slider"
              min="90" max="110" value="100" step="0.1" />
          </div>
          <span class="import-slider-side right">110</span>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-scale-adj-minus">−0.1%</button>
          <button class="import-rotation-adj-btn" id="import-scale-adj-plus">+0.1%</button>
        </div>
      </div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label">固定点（最大2点）&emsp;<span id="import-fixed-point-count">0 / 2</span></div>
        <div class="import-ctrl-hint">手順: 1) 点を選ぶ → 2) 画像をドラッグで合わせる → 3) 固定点を確定</div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-fixed-point-set" type="button">① 点を選ぶ</button>
          <button class="import-rotation-adj-btn" id="import-fixed-point-commit" type="button">固定点を確定</button>
        </div>
        <div class="import-rotation-adj-row">
          <button class="import-rotation-adj-btn" id="import-fixed-point-clear" type="button">全解除</button>
        </div>
        <div class="import-ctrl-hint" id="import-fixed-point-status">待機中</div>
      </div>
    </div>

    <!-- 表示設定 -->
    <div class="import-ctrl-section">
      <div class="import-ctrl-section-title">表示設定</div>
      <div class="import-ctrl-group">
        <div class="import-ctrl-label">画像の透明度&emsp;<span id="import-opacity-val">70</span>%</div>
        <input type="range" id="import-opacity" class="ui-slider import-ctrl-slider"
          min="0" max="100" value="70" step="1" />
      </div>
    </div>

    <!-- フッターボタン -->
    <div class="align-editor-footer">
      <button id="import-cancel-btn" class="align-cancel-btn">キャンセル</button>
      <button id="import-decide-btn" class="align-decide-btn">この位置で決定</button>
    </div>
  `;

  // --- スライダーグラデーション初期化 ---
  const rotEl   = wrap.querySelector('#import-rotation');
  const scaleEl = wrap.querySelector('#import-scale-adj');
  const opEl    = wrap.querySelector('#import-opacity');
  if (rotEl)   updateSliderGradient(rotEl,   '#2563eb');
  if (scaleEl) updateSliderGradient(scaleEl, '#2563eb');
  if (opEl)    updateSliderGradient(opEl,    '#2563eb');

  // --- イベントリスナー ---

  // キャンセル
  wrap.querySelector('#import-cancel-btn').addEventListener('click', () => closeAlignEditor());

  // 縮尺「手入力」切り替え
  wrap.querySelector('#import-scale')?.addEventListener('change', (e) => {
    wrap.querySelector('#import-scale-custom').style.display = e.target.value === 'custom' ? 'block' : 'none';
    _importSaveState();
    _updateImportPreview();
  });

  // 設定変更 → プレビュー再計算（画像モード）
  ['import-paper-size', 'import-orientation'].forEach(id => {
    wrap.querySelector(`#${id}`)?.addEventListener('change', () => { _importSaveState(); _updateImportPreview(); });
  });
  wrap.querySelector('#import-scale-custom')?.addEventListener('input', _updateImportPreview);

  // 回転スライダー
  rotEl?.addEventListener('input', (e) => {
    wrap.querySelector('#import-rotation-val').textContent = parseFloat(e.target.value).toFixed(2);
    updateSliderGradient(e.target, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  });

  // 回転微調整ボタン
  const _applyRotationAdj = (delta) => {
    if (!rotEl) return;
    _importSaveState();
    const newVal = Math.min(2, Math.max(-2, parseFloat(rotEl.value) + delta));
    rotEl.value = newVal;
    wrap.querySelector('#import-rotation-val').textContent = newVal.toFixed(2);
    updateSliderGradient(rotEl, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  };
  wrap.querySelector('#import-rotation-minus').addEventListener('click', () => _applyRotationAdj(-0.05));
  wrap.querySelector('#import-rotation-plus') .addEventListener('click', () => _applyRotationAdj( 0.05));
  wrap.querySelector('#import-rotation-reset').addEventListener('click', () => {
    if (!rotEl) return;
    _importSaveState();
    rotEl.value = '0';
    wrap.querySelector('#import-rotation-val').textContent = '0.00';
    updateSliderGradient(rotEl, '#2563eb');
    if (importState.baseCoords) { _applyKmzTransform(); } else { _updateImportRotation(); }
  });

  // スケール補正スライダー
  scaleEl?.addEventListener('input', (e) => {
    importState.scaleVal = parseFloat(e.target.value);
    _syncScaleUI();
    _updateImportScale();
  });
  const _applyScaleAdj = (delta) => {
    if (!scaleEl) return;
    _importSaveState();
    const newVal = Math.min(110, Math.max(90, parseFloat(scaleEl.value) + delta));
    importState.scaleVal = newVal;
    _syncScaleUI();
    _updateImportScale();
  };
  wrap.querySelector('#import-scale-adj-minus').addEventListener('click', () => _applyScaleAdj(-0.1));
  wrap.querySelector('#import-scale-adj-plus') .addEventListener('click', () => _applyScaleAdj( 0.1));
  wrap.querySelector('#import-scale-adj-reset').addEventListener('click', () => {
    _importSaveState();
    importState.scaleVal = 100;
    _syncScaleUI();
    _updateImportScale();
  });

  // 固定点
  wrap.querySelector('#import-fixed-point-set').addEventListener('click', () => {
    if (!importState.coords) return;
    if (importState.fixedPoints.length >= 2) return;
    _setFixedPointSettingMode(true);
    importState.pendingFixedPoint = null;
    _renderFixedPointMarkers();
  });
  wrap.querySelector('#import-fixed-point-commit').addEventListener('click', () => {
    if (!importState.pendingFixedPoint) return;
    _importSaveState();
    _commitPendingFixedPoint();
    _updateBaseScaleCoords();
    _replaceImageSource();
  });
  wrap.querySelector('#import-fixed-point-clear').addEventListener('click', () => {
    if (importState.fixedPoints.length === 0 && !importState.pendingFixedPoint) return;
    _importSaveState();
    _clearImportFixedPoints();
    _updateBaseScaleCoords();
    _replaceImageSource();
  });

  // 透明度スライダー
  opEl?.addEventListener('input', (e) => {
    const opacity = parseInt(e.target.value, 10) / 100;
    wrap.querySelector('#import-opacity-val').textContent = e.target.value;
    updateSliderGradient(e.target, '#2563eb');
    if (_map.getLayer('_import-layer')) {
      _map.setPaintProperty('_import-layer', 'raster-opacity', opacity);
    }
  });

  // Undo/Redo ボタン
  wrap.querySelector('#import-undo-btn').addEventListener('click', _importUndo);
  wrap.querySelector('#import-redo-btn').addEventListener('click', _importRedo);

  // range 操作の開始時に一度だけ状態保存（_bindRangePreSave の動的版）
  [rotEl, scaleEl].forEach(el => {
    if (!el) return;
    let armed = false;
    const arm = () => { if (armed) return; _importSaveState(); armed = true; };
    el.addEventListener('pointerdown', arm);
    el.addEventListener('keydown', (e) => {
      if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') arm();
    });
    el.addEventListener('change', () => { armed = false; });
  });

  // 決定ボタン
  wrap.querySelector('#import-decide-btn').addEventListener('click', async () => {
    if (!importState.coords || !importState.imgUrl) return;

    const name       = importState.imgFile?.name ?? importState.imgLabel ?? '手動配置地図';
    const coords     = importState.coords.map(c => [...c]);
    const blob       = importState.imgBlob ?? null;
    const keepUrl    = importState.imgUrl;
    const terrainId  = importState.snapTerrainId ?? null;
    let   mapSheetId = importState.activeMapSheetId ?? null;

    // closeAlignEditor での revoke を防ぐため先に null にする
    importState.imgUrl           = null;
    importState.imgBlob          = null;
    importState.activeMapSheetId = null;

    // コース枠の決定
    if (!mapSheetId) {
      const activeEventId = getActiveEventId();
      if (activeEventId) {
        const isKmzMode  = (importState.imgFile === null);
        const paperSize  = isKmzMode ? null : (document.getElementById('import-paper-size')?.value || 'A4');
        const scaleSelEl = document.getElementById('import-scale');
        const scaleCustomEl = document.getElementById('import-scale-custom');
        let scale = null;
        if (!isKmzMode && scaleSelEl) {
          const sv = scaleSelEl.value;
          scale = sv === 'custom' ? (parseInt(scaleCustomEl?.value) || null) : parseInt(sv);
        }
        const sheetName = name.replace(/\.(jpe?g|png|kmz)$/i, '') || '地図枠';
        try {
          const newSheet = {
            id:          'ms-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
            event_id:    activeEventId,
            name:        sheetName,
            coordinates: coords,
            paper_size:  paperSize,
            scale,
          };
          await saveWsMapSheet(newSheet);
          mapSheetId = newSheet.id;
        } catch (e) {
          console.warn('import-decide: コース枠の作成に失敗:', e);
        }
      }
    }

    // メインマップにレイヤー追加・localMapLayers 登録
    const entry = addLocalMapLayer(
      blob ? blob : await (await fetch(keepUrl)).blob(),
      coords, name,
      {
        terrainId,
        terrainName: terrainId ? (localMapLayers.find(e => e.terrainId === terrainId)?.terrainName ?? null) : null,
        mapSheetId,
      }
    );

    // IndexedDB 永続化
    if (blob || keepUrl) {
      const saveBlob = blob ?? await (async () => {
        try { return await (await fetch(keepUrl)).blob(); } catch { return null; }
      })();
      if (saveBlob) {
        saveMapLayer({
          type:        'image-import',
          name,
          imageBlob:   saveBlob,
          coordinates: coords,
          opacity:     entry.opacity,
          visible:     true,
          terrainId,
          terrainName: entry.terrainName,
          mapSheetId,
        })
          .then(dbId => { entry.dbId = dbId; emit('localmap:changed'); })
          .catch(e => console.warn('import-decide: DB 保存に失敗:', e));
      }
    }

    // 地図範囲をフィット
    const b = entry.bbox;
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
    _map.fitBounds(
      [[b.west, b.south], [b.east, b.north]],
      { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                   left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
        pitch: INITIAL_PITCH, duration: EASE_DURATION, maxZoom: 19 }
    );

    emit('localmap:changed');
    closeAlignEditor(false);
  });

  return wrap;
}

/** メインマップの位置合わせ用ソース/レイヤーを削除する */
function _cleanupAlignMapLayers() {
  if (_map.getLayer('_import-hitbox-layer')) _map.removeLayer('_import-hitbox-layer');
  if (_map.getSource('_import-hitbox'))      _map.removeSource('_import-hitbox');
  if (_map.getLayer('_import-layer'))        _map.removeLayer('_import-layer');
  if (_map.getSource('_import-img'))         _map.removeSource('_import-img');
}

/**
 * 位置合わせエディターを開く（右パネルを使用、プレビューマップなし）
 * @param {string} imgUrl ObjectURL
 * @param {Function} onReady マップ準備完了後のコールバック
 * @param {boolean} showStep1 true=画像モード, false=KMZモード
 */
export function openAlignEditor(imgUrl, onReady, showStep1 = true) {
  // 既存の位置合わせ用レイヤーをクリーンアップ
  _cleanupAlignMapLayers();

  // 既存マーカーをクリーンアップ
  exitScaleMode();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (importState.fixedPointOverlay?.isConnected) importState.fixedPointOverlay.remove();
  importState.fixedPointOverlay = null;
  importState.fixedPointOverlayEventsAdded = false;

  // 既存ハンドラをクリーンアップ（前回のエディターセッションの残留防止）
  if (importState._handlers) {
    const h = importState._handlers;
    _map.off('mousemove', h.mousemove);
    _map.off('mouseup',   h.mouseup);
    _map.off('click',     h.click);
    importState._handlers = null;
  }

  // 状態リセット
  importState.imgUrl           = imgUrl;
  importState.coords           = null;
  importState.center           = null;
  importState.baseCoords       = null;
  importState.history          = [];
  importState.future           = [];
  importState.cachedDecl       = 0;
  importState.scaleVal         = 100;
  importState.baseScaleCoords  = null;
  _clearImportFixedPoints();
  importState.isDragging       = false;
  importState.interactionInited = false;
  importState.eventsAdded      = false;

  // 右パネルにコントロールを構築
  const panel = _buildAlignEditorPanel(showStep1);
  openRightPanel('地図画像の位置合わせ', panel);

  // スライダー UI を初期値に同期
  _syncScaleUI();
  _updateFixedPointStatus();

  // マップがロード済みであればすぐにコールバックを実行
  if (_map.loaded()) {
    onReady();
  } else {
    _map.once('load', onReady);
  }
}

// ---- 画像縦横比から最適な用紙サイズ・向きを自動推定してUIに反映 ----
// ---- 画像ファイルから開く（用紙サイズ設定UI表示・A4デフォルト） ----
/**
 * 位置合わせモーダルの「既存の枠に合わせる」リストを更新する。
 * コース枠（MapSheet）と配置済み地図を一覧し、選択すると座標をスナップする。
 * - アクティブイベントがある場合はそのコース枠を優先表示
 * - フォールバック: mapSheetId 未割り当ての localMapLayers も表示
 * @param {string|null} filterTerrainId — null のときは全件表示
 */
async function _populateImportSnapList(filterTerrainId = null) {
  const section = document.getElementById('import-snap-section');
  const listEl  = document.getElementById('import-snap-list');
  if (!section || !listEl) return;

  // アクティブイベントのコース枠を取得
  let mapSheets = [];
  const activeEventId = getActiveEventId();
  if (activeEventId) {
    try { mapSheets = await getMapSheetsByEvent(activeEventId); } catch { /* ignore */ }
  }

  // コース枠未割り当ての既存配置済み地図（後方互換スナップ候補）
  const legacyCandidates = localMapLayers.filter(e =>
    e.coordinates && e.coordinates.length === 4 &&
    !e.mapSheetId &&
    (filterTerrainId == null || e.terrainId === filterTerrainId)
  );

  if (mapSheets.length === 0 && legacyCandidates.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  listEl.innerHTML = '';

  /** 座標スナップ共通処理 */
  function _applySnapCoords(coords) {
    if (!coords) return;
    importState.coords          = coords.map(c => [...c]);
    importState.baseCoords      = coords.map(c => [...c]);
    importState.baseScaleCoords = coords.map(c => [...c]);
    importState.scaleVal        = 100;
    importState.history         = [];
    importState.future          = [];
    const rotEl = document.getElementById('import-rotation');
    if (rotEl) { rotEl.value = '0'; document.getElementById('import-rotation-val').textContent = '0.00'; }
    _syncScaleUI();
    if (importState.scaleCornerMarkers.length === 4) {
      importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(coords[i]));
    }
    const lngs = coords.map(c => c[0]);
    const lats  = coords.map(c => c[1]);
    _map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 40, duration: 400 }
    );
    _replaceImageSource();
    listEl.querySelectorAll('.import-snap-btn').forEach(b => b.classList.remove('active'));
  }

  // ① コース枠（MapSheet）ボタン
  mapSheets.forEach(sheet => {
    const btn = document.createElement('button');
    btn.className = 'import-snap-btn';
    const scaleStr = sheet.scale ? ` 1:${sheet.scale.toLocaleString()}` : '';
    const sizeStr  = sheet.paper_size ? ` ${sheet.paper_size}` : '';
    btn.textContent = `${sheet.name}${sizeStr}${scaleStr}`;
    btn.title = `コース枠「${sheet.name}」に合わせる（確定時はこの枠に画像を追加）`;
    btn.addEventListener('click', () => {
      if (!sheet.coordinates) return;
      _applySnapCoords(sheet.coordinates);
      importState.snapTerrainId    = null;
      importState.activeMapSheetId = sheet.id;   // ← 既存コース枠に追加
      btn.classList.add('active');
    });
    listEl.appendChild(btn);
  });

  // ② 後方互換: コース枠未割り当ての配置済み地図
  legacyCandidates.forEach(e => {
    const btn = document.createElement('button');
    btn.className = 'import-snap-btn import-snap-btn-legacy';
    const shortName = e.name.replace(/\.(jpg|jpeg|png|kmz)$/i, '');
    btn.textContent = shortName;
    btn.title = `配置済み地図「${shortName}」の枠に合わせる（新規コース枠を作成）`;
    btn.addEventListener('click', () => {
      if (!e.coordinates) return;
      _applySnapCoords(e.coordinates);
      importState.snapTerrainId    = e.terrainId ?? null;
      importState.activeMapSheetId = null;   // ← 新規コース枠を作成
      btn.classList.add('active');
    });
    listEl.appendChild(btn);
  });
}

export function openImportModal(imageFile) {
  importState.imgFile          = imageFile;
  importState.imgBlob          = imageFile;  // File は Blob のサブクラス。IndexedDB 保存用に保持
  importState.imgAspect        = null;
  importState.imgLabel         = imageFile.name;
  importState.snapTerrainId    = null;
  importState.activeMapSheetId = null;

  const imgUrl = URL.createObjectURL(imageFile);
  const tmp    = new Image();
  tmp.onload = () => {
    importState.imgAspect = (tmp.width > 0 && tmp.height > 0) ? (tmp.width / tmp.height) : null;
    const isLandscape = tmp.width >= tmp.height;
    openAlignEditor(imgUrl, async () => {
      // 用紙サイズ・向きをパネル構築後に設定
      const pSize = document.getElementById('import-paper-size');
      const pOri  = document.getElementById('import-orientation');
      if (pSize) pSize.value = 'A4';
      if (pOri)  pOri.value  = isLandscape ? 'landscape' : 'portrait';
      _updateImportPreview();
      await _populateImportSnapList();
    }, true);
  };
  tmp.onerror = () => {
    importState.imgAspect = null;
    openAlignEditor(imgUrl, async () => {
      const pOri = document.getElementById('import-orientation');
      if (pOri) pOri.value = 'portrait';
      _updateImportPreview();
      await _populateImportSnapList();
    }, true);
  };
  tmp.src = imgUrl;
}

// ---- KMZ: 現在の importState.center + 回転スライダーで座標を再計算 ----
function _applyKmzTransform() {
  if (!importState.baseCoords || !importState.center) return;
  const { lng: cLng, lat: cLat } = importState.center;
  const rotDeg = parseFloat(document.getElementById('import-rotation')?.value ?? '0');

  // importState.baseCoords の重心（基準中心）を算出
  const baseLngs = importState.baseCoords.map(c => c[0]);
  const baseLats = importState.baseCoords.map(c => c[1]);
  const baseCLng = (Math.min(...baseLngs) + Math.max(...baseLngs)) / 2;
  const baseCLat = (Math.min(...baseLats) + Math.max(...baseLats)) / 2;
  const baseCtr  = turf.point([baseCLng, baseCLat]);
  const newCtr   = turf.point([cLng, cLat]);

  // 各隅を基準中心からの距離・方位で算出し、まず平行移動して新中心に配置
  const rawCoords = importState.baseCoords.map(([lng, lat]) => {
    const pt   = turf.point([lng, lat]);
    const dist = turf.distance(baseCtr, pt, { units: 'kilometers' });
    const bear = turf.bearing(baseCtr, pt);
    return turf.getCoord(turf.destination(newCtr, dist, bear, { units: 'kilometers' }));
  });
  // 回転補正は中心または固定点を軸に適用
  const origin = _getImportTransformOrigin() ?? [cLng, cLat];
  const rotatedRaw = Math.abs(rotDeg) < 1e-9
    ? rawCoords
    : _rotateCoordsAroundPivot(rawCoords, rotDeg, origin);
  // KMZ変換後のコードをスケール100%ベースとして保存し、現在スケールを適用
  importState.baseScaleCoords = rotatedRaw;
  _applyImportScale();
  _syncScaleUI();
  _replaceImageSource();
}

// ---- KMZ座標付きで開く（回転のみ表示、用紙サイズUI非表示） ----
export function openImportModalWithCoords(imgUrl, coords, label) {
  importState.imgFile          = null;
  importState.imgAspect        = null;
  importState.imgLabel         = label ?? '手動配置地図';
  importState.snapTerrainId    = null;
  importState.activeMapSheetId = null;

  const lats = coords.map(c => c[1]), lngs = coords.map(c => c[0]);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

  // showStep1=false でKMZモード（用紙サイズUI非表示）
  openAlignEditor(imgUrl, () => {
    // openAlignEditor によるリセット後に KMZ 座標を設定
    importState.baseCoords      = coords.map(c => [...c]);
    importState.coords          = coords.map(c => [...c]);
    importState.scaleVal        = 100;
    importState.baseScaleCoords = coords.map(c => [...c]);
    _syncScaleUI();
    importState.center = { lng: centerLng, lat: centerLat };

    // KMZ画像全体が収まるようフィット（短いアニメーション）
    _map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: FIT_BOUNDS_PAD, duration: 400 }
    );

    // 画像ソース + hitbox を一括初期化
    _replaceImageSource();

    // 既存のコース枠スナップリストを表示
    _populateImportSnapList();
  }, false);
}

/* ---- 微調整モード（廃止：拡大縮小モードに統合）----
export function enterFineTuneMode() {
  if (!importState.previewMap || !importState.coords) return;
  _fineTuneActive = true;
  if (importState.previewMap.getLayer('_import-hitbox-layer'))
    importState.previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'none');
  importState.previewMap.getCanvas().style.cursor = '';
  _importCornerMarkers = importState.coords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#ff9900;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i];
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord).addTo(importState.previewMap);
    marker.on('dragstart', () => { _importSaveState(); });
    marker.on('drag', () => { const ll = marker.getLngLat(); importState.coords[i] = [ll.lng, ll.lat]; _replaceImageSourceRaf(); });
    return marker;
  });
}
export function exitFineTuneMode() {
  _fineTuneActive = false;
  _importCornerMarkers.forEach(m => m.remove()); _importCornerMarkers = [];
  if (importState.previewMap && importState.previewMap.getLayer('_import-hitbox-layer'))
    importState.previewMap.setLayoutProperty('_import-hitbox-layer', 'visibility', 'visible');
}
*/

// ---- 4隅マーカーを常時表示（固定点があれば固定点中心、なければ対角固定で相似拡大縮小） ----
export function enterScaleMode() {
  if (!importState.coords) return;
  if (importState.scaleCornerMarkers.length === 4) {
    importState.scaleCornerMarkers.forEach((m, i) => m.setLngLat(importState.coords[i]));
    return;
  }

  // 4隅にドラッグ可能なマーカーを配置
  importState.scaleCornerMarkers = importState.coords.map((coord, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'width:14px;height:14px;background:#2288ff;border:2px solid #fff;' +
      'border-radius:50%;cursor:grab;box-shadow:0 1px 4px rgba(0,0,0,0.6);';
    el.title = ['左上', '右上', '右下', '左下'][i] + '（ドラッグで拡大縮小）';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(coord)
      .addTo(map);

    // dragstart/drag 用クロージャ変数
    let fixedCoord    = null; // 固定する座標（固定点 or 対角コーナー）
    let startCoords   = null; // ドラッグ開始時の全隅座標
    let startDist     = 0;    // ドラッグ開始時のドラッグ隅→固定隅の距離
    let savedScaleVal = 100;  // ドラッグ開始時のスケール倍率

    marker.on('dragstart', () => {
      _importSaveState();
      if (importState.fixedPoints.length > 0) {
        fixedCoord = _getImportTransformOrigin();
      } else {
        const oppIdx = (i + 2) % 4;                 // 対角コーナーのインデックス
        fixedCoord   = [...importState.coords[oppIdx]];  // 固定点（対角）
      }
      startCoords    = importState.coords.map(c => [...c]);
      savedScaleVal  = importState.scaleVal;
      const cosLat   = Math.cos(fixedCoord[1] * Math.PI / 180);
      const dx0      = (startCoords[i][0] - fixedCoord[0]) * cosLat;
      const dy0      =  startCoords[i][1] - fixedCoord[1];
      startDist      = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    });

    marker.on('drag', () => {
      if (!fixedCoord || startDist < 1e-9) return;
      const ll     = marker.getLngLat();
      const cosLat = Math.cos(fixedCoord[1] * Math.PI / 180);
      const dx1    = (ll.lng - fixedCoord[0]) * cosLat;
      const dy1    =  ll.lat - fixedCoord[1];
      const scale  = Math.sqrt(dx1 * dx1 + dy1 * dy1) / startDist;
      // 全隅を固定点からの相似拡大縮小で再計算
      importState.coords = startCoords.map(([lng, lat]) => {
        const dx = (lng - fixedCoord[0]) * cosLat;
        const dy =  lat - fixedCoord[1];
        return [fixedCoord[0] + dx * scale / cosLat, fixedCoord[1] + dy * scale];
      });
      // 中心を4隅重心で再計算
      importState.center = {
        lng: importState.coords.reduce((s, c) => s + c[0], 0) / 4,
        lat: importState.coords.reduce((s, c) => s + c[1], 0) / 4,
      };
      // スケール倍率を更新しUIと逆変換ベース座標を同期
      importState.scaleVal = savedScaleVal * scale;
      _syncScaleUI();
      _updateBaseScaleCoords();
      // 全マーカーを最新座標に移動
      importState.scaleCornerMarkers.forEach((m, j) => m.setLngLat(importState.coords[j]));
      _replaceImageSourceRaf();
    });

    return marker;
  });
}

// ---- 4隅マーカー解除 ----
export function exitScaleMode() {
  importState.scaleCornerMarkers.forEach(m => m.remove());
  importState.scaleCornerMarkers = [];
}

// ---- 位置合わせエディターを閉じる（revokeUrl=false のとき ObjectURL を解放しない） ----
export function closeAlignEditor(revokeUrl = true) {
  // マーカークリーンアップ
  exitScaleMode();
  importState.fixedPointMarkers.forEach(m => m.remove());
  importState.fixedPointMarkers = [];
  if (importState.fixedPointOverlay?.isConnected) importState.fixedPointOverlay.remove();
  importState.fixedPointOverlay = null;
  importState.fixedPointOverlayEventsAdded = false;
  _clearImportFixedPoints();

  // 状態フラグリセット
  importState.isDragging         = false;
  importState.interactionInited  = false;
  importState.eventsAdded        = false;
  if (importState.isDragging) _map.dragPan.enable();

  // メインマップからレイヤー/ソースを削除
  _cleanupAlignMapLayers();

  // イベントハンドラのクリーンアップ
  if (importState._handlers) {
    const h = importState._handlers;
    _map.off('mousemove', h.mousemove);
    _map.off('mouseup',   h.mouseup);
    _map.off('click',     h.click);
    importState._handlers = null;
  }

  if (revokeUrl && importState.imgUrl) { URL.revokeObjectURL(importState.imgUrl); }
  importState.imgUrl  = null;
  importState.imgFile = null;
  importState.coords  = null;

  // 右パネルを閉じる
  closeRightPanel();
}

// 後方互換エイリアス（旧コードが参照している場合に備えて）
const closeImportModal = closeAlignEditor;

// Undo/Redo キーボードショートカット（エディターが開いているときのみ有効）
document.addEventListener('keydown', (e) => {
  if (!importState.coords) return; // エディター未開
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) { _importRedo(); } else { _importUndo(); }
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    _importRedo();
  }
});

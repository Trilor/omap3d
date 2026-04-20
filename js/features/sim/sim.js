/* ================================================================
   sim.js — O-シミュレーターモード（モバイル + PC）
   ================================================================ */

import { localMapLayers } from '../../store/localMapStore.js';
import { updateSliderGradient } from '../../utils/slider.js';
import { escHtml } from '../../utils/dom.js';
import {
  INITIAL_PITCH, EASE_DURATION,
  SIDEBAR_DEFAULT_WIDTH, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR,
  BASEMAPS,
} from '../../core/config.js';
import {
  getMagneticLineColor, applyMagneticLineColor, getLastMagneticNorthData,
} from '../../core/magneticLines.js';
import { buildContourTileUrl, contourLayerIds } from '../../core/contours.js';
import {
  getCurrentDevicePPI, updatePpiRuler, updatePpiSliderBubble,
} from '../../ui/components/scaleDisplay.js';
import { gpxState, GPX_CAM_DIST_MIN, GPX_CAM_DIST_MAX } from '../gpx/gpxState.js';
import {
  interpolateGpxPosition, updateSeekBarGradient, updateTimeDisplay,
} from '../gpx/gpxPlayer.js';
import { updateGpxMarker, updateCamera } from '../gpx/gpxCamera.js';

// ---- モジュール変数 ----
let _map = null;
let _getUpdateGlobeBg         = () => null;
let _getLastAppliedContour    = () => null;
let _getOriLibreCachedStyle   = () => null;

export function initSim(map, { getUpdateGlobeBg, getLastAppliedContourInterval, getOriLibreCachedStyle }) {
  _map = map;
  _getUpdateGlobeBg       = getUpdateGlobeBg;
  _getLastAppliedContour  = getLastAppliedContourInterval;
  _getOriLibreCachedStyle = getOriLibreCachedStyle;
}

/* ================================================================
   O-シミュレーターモード（モバイル）
   FPS風の操作インターフェース:
     ・左手ジョイスティック（nipplejs）で走行移動
     ・右半分スワイプでカメラ首振り（bearing / pitch）
     ・ミニマップ（右上）がヘディングアップで連動回転
   ================================================================ */

// ---- 定数 ----
const SIM_ZOOM  = 22;
const SIM_PITCH    = 80; // モバイルシム用ピッチ（低空ドローン視点）
const PC_SIM_PITCH = 80; // PCシム用ピッチ（水平に近い視点：鉛直から80°= 地平線より10°上）
// キロ5分 = 時速12km = 秒速3.333m
const SIM_MAX_SPEED_MPS = 12000 / 3600;
const SIM_MINIMAP_ZOOM  = 16;
const SIM_FLOOR_CLEARANCE_M = 4; // 地形上の最低クリアランス（メートル）

// ---- 状態変数 ----
const mobileSimState = {
  active:     false,                  // シム実行中か
  miniMap:    null,                   // 第2 MapLibre インスタンス（ミニマップ）
  joystick:   null,                   // nipplejs インスタンス
  joyData:    { force: 0, angle: 0 }, // ジョイスティック入力（force: 0〜1, angle: radians）
  animFrame:  null,                   // requestAnimationFrame ID
  targetZoom: SIM_ZOOM,               // ユーザーが希望するズームレベル（スライダー/キーで更新）
  posMarker:  null,                   // maplibregl.Marker インスタンス（現在地表示）
};

/* ----------------------------------------------------------------
   toggleSimMode: トグルボタンの onClick
   ---------------------------------------------------------------- */
function toggleSimMode() {
  if (mobileSimState.active) stopSimMode();
  else           startSimMode();
}

/* ----------------------------------------------------------------
   startSimMode: シミュレーターを起動する
   ---------------------------------------------------------------- */
function startSimMode() {
  mobileSimState.active = true;
  mobileSimState.targetZoom = SIM_ZOOM;
  const _ugbg = _getUpdateGlobeBg(); if (_ugbg) _ugbg();

  // ① 通常の地図操作を全て無効化
  _map.dragPan.disable();
  _map.dragRotate.disable();
  _map.scrollZoom.disable();
  _map.doubleClickZoom.disable();
  _map.touchZoomRotate.disable();
  _map.keyboard.disable();

  // ② カメラをシム視点へ（完了後にミニマップを初期化）
  _map.easeTo({ zoom: SIM_ZOOM, pitch: SIM_PITCH, duration: 800 });

  // ④ UIを切り替え
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('unified-search').style.display = 'none';
  document.getElementById('scale-ctrl-container').style.display = 'none';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = 'none';
  document.getElementById('sim-overlay').style.display = 'flex';
  const btn = document.getElementById('sim-toggle-btn');
  btn.textContent = 'モバイルシミュレーター終了';
  btn.classList.add('sim-active');

  // ズームスライダーを SIM_ZOOM にリセット
  const zSlider = document.getElementById('sim-zoom-slider');
  zSlider.value = SIM_ZOOM;
  document.getElementById('sim-zoom-val').textContent = SIM_ZOOM;
  updateSliderGradient(zSlider);

  // ⑤ ミニマップを初期化（easeTo完了後に生成して描画崩れを防ぐ）
  setTimeout(initSimMinimap, 850);

  // ⑥ ジョイスティック初期化
  initSimJoystick();

  // ⑦ 視点操作ゾーン初期化
  initSimLookZone();

  // ⑧ 3D現在位置マーカーを追加（常時ON）
  addSimPosMarker();

  // ⑨ アニメーションループ開始
  simLoop();
}

/* ----------------------------------------------------------------
   stopSimMode: シミュレーターを終了する
   ---------------------------------------------------------------- */
function stopSimMode() {
  mobileSimState.active = false;
  const _ugbg = _getUpdateGlobeBg(); if (_ugbg) _ugbg();

  // ループ停止
  if (mobileSimState.animFrame) { cancelAnimationFrame(mobileSimState.animFrame); mobileSimState.animFrame = null; }

  // ジョイスティック破棄
  if (mobileSimState.joystick) { mobileSimState.joystick.destroy(); mobileSimState.joystick = null; }
  mobileSimState.joyData = { force: 0, angle: 0 };

  // ミニマップ破棄
  if (mobileSimState.miniMap) { mobileSimState.miniMap.remove(); mobileSimState.miniMap = null; }

  // UIを元に戻す
  document.getElementById('sidebar').style.display = '';
  document.getElementById('unified-search').style.display = '';
  document.getElementById('scale-ctrl-container').style.display = '';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = '';
  document.getElementById('sim-overlay').style.display = 'none';
  const btn = document.getElementById('sim-toggle-btn');
  btn.textContent = 'モバイルシミュレーター開始';
  btn.classList.remove('sim-active');

  // 地図操作を復元
  _map.dragPan.enable();
  _map.dragRotate.enable();
  _map.scrollZoom.enable();
  _map.doubleClickZoom.enable();
  _map.touchZoomRotate.enable();
  _map.keyboard.enable();

  // 3D現在位置マーカーを削除
  removeSimPosMarker();

  // ピッチを戻す
  _map.easeTo({ pitch: INITIAL_PITCH, duration: EASE_DURATION });
}

/* ----------------------------------------------------------------
   initSimMinimap: 第2 MapLibre マップ（ミニマップ）を生成する
   背景: 地理院タイル（軽量ラスター）
   KMZ: 現在ロード済みのレイヤーを全て複製して追加
   ---------------------------------------------------------------- */
function initSimMinimap() {
  if (mobileSimState.miniMap) return;

  mobileSimState.miniMap = new maplibregl.Map({
    container: 'sim-minimap-map',
    style: {
      version: 8,
      sources: {
        'mini-base': {
          type: 'raster',
          tiles: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'],
          tileSize: Math.round(256 / (window.devicePixelRatio || 1)),
          attribution: '',
          maxzoom: 18,
        },
      },
      layers: [{ id: 'mini-base', type: 'raster', source: 'mini-base' }],
    },
    center:      _map.getCenter(),
    zoom:        SIM_MINIMAP_ZOOM,
    bearing:     0, // 常に北上（回転はCSS側で担当）
    pitch:       0,
    interactive: false,
    attributionControl: false,
  });

  mobileSimState.miniMap.on('load', () => {
    // KMZ画像レイヤーを全て複製してミニマップに追加
    syncKmzToMinimap();
  });
}

/* ----------------------------------------------------------------
   syncKmzToMinimap: 現在の localMapLayers を全てミニマップに追加
   ミニマップのスタイルロード後か、新規KMZ追加時に呼ぶ
   ---------------------------------------------------------------- */
function syncKmzToMinimap() {
  if (!mobileSimState.miniMap || !mobileSimState.miniMap.isStyleLoaded()) return;
  localMapLayers.forEach(entry => {
    // 既に追加済みならスキップ
    if (mobileSimState.miniMap.getSource(entry.sourceId)) return;
    // メインマップのソーススペックを取得（url + coordinates を含む）
    const spec = _map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    mobileSimState.miniMap.addSource(entry.sourceId, spec);
    mobileSimState.miniMap.addLayer({
      id:      entry.layerId + '-mini',
      type:    'raster',
      source:  entry.sourceId,
      paint:   { 'raster-opacity': 0.88, 'raster-fade-duration': 0 },
    });
  });
}

/* ----------------------------------------------------------------
   initSimJoystick: nipplejs 仮想ジョイスティックを生成する
   ---------------------------------------------------------------- */
function initSimJoystick() {
  if (mobileSimState.joystick) { mobileSimState.joystick.destroy(); mobileSimState.joystick = null; }
  mobileSimState.joyData = { force: 0, angle: 0 };

  mobileSimState.joystick = nipplejs.create({
    zone:     document.getElementById('sim-joystick-zone'),
    mode:     'static',
    position: { left: '70px', top: '70px' },
    color:    'white',
    size:     120,
  });

  mobileSimState.joystick.on('move', (evt, data) => {
    mobileSimState.joyData.force = Math.min(data.force, 1.0);
    // angle.radian: 0=右, π/2=上, π=左, 3π/2=下
    mobileSimState.joyData.angle = data.angle.radian;
  });

  mobileSimState.joystick.on('end', () => { mobileSimState.joyData.force = 0; });
}

/* ----------------------------------------------------------------
   initSimLookZone: 右半分のスワイプで bearing / pitch を操作する
   ---------------------------------------------------------------- */
function initSimLookZone() {
  const zone = document.getElementById('sim-look-zone');
  let lastX = 0, lastY = 0;

  function onTouchStart(e) {
    const t = e.touches[0];
    lastX = t.clientX;
    lastY = t.clientY;
    e.preventDefault();
  }

  function onTouchMove(e) {
    const t = e.touches[0];
    const dx = t.clientX - lastX;
    const dy = t.clientY - lastY;
    lastX = t.clientX;
    lastY = t.clientY;

    // 水平スワイプ → bearing（左右首振り）
    _map.setBearing(_map.getBearing() + dx * 0.35);

    // 垂直スワイプ → pitch（上下首振り, 50〜85°）
    // dy < 0（上スワイプ）= より水平に見る = pitch増加
    const newPitch = Math.max(50, Math.min(85, _map.getPitch() - dy * 0.25));
    _map.setPitch(newPitch);

    e.preventDefault();
  }

  // 毎回 startSim で呼ばれるのでリスナーはゾーン再生成時のみ追加
  // （stopSimMode でゾーンは非表示になるため多重登録は問題なし）
  zone.addEventListener('touchstart', onTouchStart, { passive: false });
  zone.addEventListener('touchmove',  onTouchMove,  { passive: false });
}

/* ----------------------------------------------------------------
   simLoop: アニメーションループ（毎フレーム呼ばれる）
   ① ジョイスティック入力を移動量に変換して _map.setCenter()
   ② ミニマップの center 同期 + CSS rotate でヘディングアップ回転
   ---------------------------------------------------------------- */
function simLoop() {
  if (!mobileSimState.active) return;

  // ── 移動 ──────────────────────────────────────────────────────
  if (mobileSimState.joyData.force > 0.05) {
    const bearing    = _map.getBearing();
    // nipplejs angle: 0=右/East, 90=上/North, 180=左/West, 270=下/South
    // MapLibre bearing: 0=North, 90=East → 変換: moveAngle = bearing + (90 - joystickDeg)
    const joystickDeg = mobileSimState.joyData.angle * (180 / Math.PI);
    const moveAngleDeg = bearing + (90 - joystickDeg);

    // 速度: 最大 SIM_MAX_SPEED_MPS、力の割合で比例スケール
    // 距離 = 速度[m/s] × (1/60)[s] ÷ 1000 → [km]（60fps仮定）
    const distKm = (SIM_MAX_SPEED_MPS * mobileSimState.joyData.force) / 60 / 1000;

    const c    = _map.getCenter();
    const dest = turf.destination([c.lng, c.lat], distKm, moveAngleDeg);
    _map.setCenter(dest.geometry.coordinates);
  }

  // ── ミニマップ同期 ──────────────────────────────────────────────
  if (mobileSimState.miniMap) {
    mobileSimState.miniMap.setCenter(_map.getCenter());
    // bearing の逆回転で常に進行方向が上（ヘディングアップ）
    const b = _map.getBearing();
    document.getElementById('sim-minimap-inner').style.transform =
      `rotate(${-b}deg)`;
  }

  // ── 地形フロア（setZoom のみ。setFreeCameraOptions は使用しない） ──
  enforceTerrainFloor();

  // ── 3D現在位置マーカー更新 ──
  updateSimPosMarker();

  mobileSimState.animFrame = requestAnimationFrame(simLoop);
}

/* ----------------------------------------------------------------
   focusMinimapOnSegment（将来拡張用プレースホルダー）
   コースの2点間区間がミニマップに収まるよう表示範囲を自動調整する。
   @param {[number,number]} pointA - [lng, lat] 区間始点
   @param {[number,number]} pointB - [lng, lat] 区間終点
   ---------------------------------------------------------------- */
function focusMinimapOnSegment(pointA, pointB) {
  if (!mobileSimState.miniMap) return;
  const bounds = [
    [Math.min(pointA[0], pointB[0]), Math.min(pointA[1], pointB[1])],
    [Math.max(pointA[0], pointB[0]), Math.max(pointA[1], pointB[1])],
  ];
  mobileSimState.miniMap.fitBounds(bounds, { padding: 30, duration: 400 });
}

// ---- トグルボタンのイベント ----
document.getElementById('sim-toggle-btn')?.addEventListener('click', toggleSimMode);


/* ================================================================
   3D 現在位置マーカー（シム中に _map.getCenter() を赤点で表示）
   ================================================================ */
function addSimPosMarker() {
  if (mobileSimState.posMarker) return;
  const el = document.createElement('div');
  el.id = 'sim-pos-marker-el';
  el.style.cssText = `
    width: 22px; height: 22px; border-radius: 50%;
    background: #e63030;
    border: 4px solid rgba(255,255,255,0.85);
    box-shadow: 0 0 8px rgba(0,0,0,0.55);
    pointer-events: none;
  `;
  mobileSimState.posMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat(_map.getCenter())
    .addTo(_map);
}

function removeSimPosMarker() {
  if (mobileSimState.posMarker) { mobileSimState.posMarker.remove(); mobileSimState.posMarker = null; }
}

function updateSimPosMarker(lng, lat) {
  if (!mobileSimState.posMarker) return;
  if (lng !== undefined) mobileSimState.posMarker.setLngLat({ lng, lat });
  else mobileSimState.posMarker.setLngLat(_map.getCenter()); // モバイルシム用
}

// 読図マップ 現在位置ドット のオン/オフ
document.getElementById('chk-readmap-dot').addEventListener('change', e => {
  const d = e.target.checked ? '' : 'none';
  document.getElementById('pc-sim-readmap-dot').style.display = d;
  document.getElementById('pc-sim-readmap-arrow').style.display = d;
});


/* ================================================================
   PC O-シミュレーターモード
   Pointer Lock API + WASD + マウス視点 + Space/右クリック読図
   ================================================================ */

// ---- 状態変数 ----
export const pcSimState = {
  active:          false,      // PCシム実行中か
  paused:          false,      // Esc で一時停止中か（ポーズHUD表示中）
  animFrame:       null,       // requestAnimationFrame ID
  lastTime:        null,       // 前フレームのタイムスタンプ
  readMap:         null,       // 読図用 MapLibre インスタンス
  readOpen:        false,      // 読図マップ表示中か
  playerLng:       null,       // プレイヤーの経度
  playerLat:       null,       // プレイヤーの緯度
  bearing:         0,          // カメラの向き（deg, 北=0）
  pitch:           SIM_PITCH,  // カメラのピッチ（deg, 0=真下 〜 85=水平）
  camDistM:        50,         // カメラ ↔ プレイヤー間の距離（m）
  smoothedSlopeAdj: 0,         // 地形傾斜による自動ピッチ補正（deg、ローパスフィルタ済み）
  cachedTerrainH:  0,          // queryTerrainElevation が null のときに使うキャッシュ値
  viewMode:        'terrain',  // 'terrain'（地形追従）| 'bird'（鳥瞰）
  startLng:        null,       // クリック待ちで記録した開始座標（経度）
  startLat:        null,       // クリック待ちで記録した開始座標（緯度）
  pickingActive:   false,      // クリック待ちモード中か
  keys: {                      // キー押下状態（Pointer Lock 有無に関わらず追跡）
    KeyW: false, KeyA: false, KeyS: false, KeyD: false,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false,
  },
};
const PC_CAM_DIST_MIN = 1;
const PC_CAM_DIST_MAX = 500;

// ---- 速度スライダー ----
const pcSimSpeedSlider = document.getElementById('pc-sim-speed');

// 離散速度リスト（スライダーのインデックス 0〜13 に対応）
// ランニング帯を細かく、高速帯は粗くなるよう手動設計
const _SIM_SPEEDS = [10, 12, 15, 20, 30, 60, 100, 300, 600, 900];
function simSpeedFromSlider(idx) {
  const i = Math.max(0, Math.min(_SIM_SPEEDS.length - 1, Math.round(idx)));
  return _SIM_SPEEDS[i];
}

// ---- 乗り物モード SVG アイコン ----
const _SVG_RUNNING = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="3.5" r="1.5"/><path d="M13 5 L11 9 L7 12"/><path d="M11 9 L15 10.5"/><path d="M7 12 L5 17 M7 12 L10 16"/></svg>`;
const _SVG_BICYCLE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="14" r="3.5"/><circle cx="15" cy="14" r="3.5"/><path d="M5 14 L10 7 L15 14 M10 7 L13 7 M13 7 L15 10"/></svg>`;
const _SVG_CAR = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 13 L3 8 Q5 7 7 7 L13 7 Q15 7 17 8 L19 13 Z"/><circle cx="5.5" cy="14.5" r="1.8"/><circle cx="14.5" cy="14.5" r="1.8"/><path d="M7 10 L13 10"/></svg>`;
const _SVG_HIGHWAY = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 L7 3 M17 17 L13 3"/><path d="M9.5 14 L10.5 14 M9 10 L11 10 M8.5 6 L11.5 6"/></svg>`;
const _SVG_SHINKANSEN = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10 Q5 6 8 6 L17 6 L17 14 L8 14 Q5 14 2 10 Z"/><line x1="3" y1="16" x2="17" y2="16"/><line x1="5" y1="14" x2="5" y2="16"/><line x1="14" y1="14" x2="14" y2="16"/></svg>`;
const _SVG_MAGLEV = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 10 Q4 7 8 7.5 L18 7.5 L19 10 L18 12.5 L8 12.5 Q4 13 1 10 Z"/><line x1="3" y1="15" x2="17" y2="15"/><line x1="7" y1="12.5" x2="7" y2="15"/><line x1="15" y1="12.5" x2="15" y2="15"/></svg>`;
const _SVG_AIRPLANE = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 11 L7 9 L13 3 Q16 1.5 17.5 4 Q19 6.5 17 9 L19 14.5 L16 15 L12 10.5 L8 12 L9 15.5 L6.5 16 L4 12.5 Z"/></svg>`;

// 速度区分定義（min以上max未満）
const _SIM_MODES = [
  { min: 10,  max: 20,   label: 'ランニング', svg: _SVG_RUNNING },
  { min: 20,  max: 40,   label: '自転車',     svg: _SVG_BICYCLE },
  { min: 40,  max: 100,  label: '自動車',     svg: _SVG_CAR },
  { min: 100, max: 160,  label: '高速道路',   svg: _SVG_HIGHWAY },
  { min: 160, max: 350,  label: '新幹線',     svg: _SVG_SHINKANSEN },
  { min: 350, max: 600,  label: 'リニア',     svg: _SVG_MAGLEV },
  { min: 600, max: 1001, label: '飛行機',     svg: _SVG_AIRPLANE },
];
function getSimSpeedMode(kmh) {
  return _SIM_MODES.find(m => kmh >= m.min && kmh < m.max) || _SIM_MODES[_SIM_MODES.length - 1];
}

// km/h → min:sec/km ペース変換
function kmhToPace(kmh) {
  if (!kmh || kmh <= 0) return '--:--';
  const totalSec = Math.round(3600 / kmh);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// バッジ（thumb追随）・速度数値・ペース・アイコンを更新
function updateSimSpeedBubble(slider) {
  if (!slider) return;
  const pct = (parseFloat(slider.value) - parseFloat(slider.min))
            / (parseFloat(slider.max)  - parseFloat(slider.min));
  const kmh = simSpeedFromSlider(parseFloat(slider.value));
  // バッジ位置（CSS --pct 変数で制御）
  const badge = document.getElementById('pc-sim-speed-badge');
  if (badge) badge.style.setProperty('--pct', pct);
  // 速度・ペース数値（ヘッダー大きい数値 + バッジ）
  const pace = kmhToPace(kmh);
  const numEl  = document.getElementById('pc-sim-speed-num');
  if (numEl) numEl.textContent = kmh;
  const paceEl = document.getElementById('pc-sim-pace-display');
  if (paceEl) paceEl.textContent = pace;
  const badgeNum = document.getElementById('pc-sim-badge-speed');
  if (badgeNum) badgeNum.textContent = kmh;
  updateSimSpeedTicks(slider);
}

// 円ドット着色: 現在値以下のインデックス → 青（tick-active）、それ以上 → グレー
function updateSimSpeedTicks(slider) {
  if (!slider) return;
  const currentIdx = Math.round(parseFloat(slider.value));
  const dots = document.querySelectorAll('#pc-sim-speed-dots .sim-speed-tick');
  dots.forEach(dot => {
    const idx = parseInt(dot.dataset.idx, 10);
    dot.classList.toggle('tick-active',   idx <= currentIdx);
    dot.classList.toggle('tick-current',  idx === currentIdx);
  });
}

pcSimSpeedSlider.addEventListener('input', () => {
  updateSliderGradient(pcSimSpeedSlider);
  updateSimSpeedBubble(pcSimSpeedSlider);
});

// ラベルクリック時にスライダー値を更新（上部tick-lbl / 下部mode-lbl の当たり判定拡大）
pcSimSpeedSlider.closest('.slider-bubble-wrap').addEventListener('click', e => {
  if (e.target === pcSimSpeedSlider) return; // スライダー本体はブラウザが処理
  const rect = pcSimSpeedSlider.getBoundingClientRect();
  const thumbR = 6; // thumb半径（px）
  const pct = Math.max(0, Math.min(1,
    (e.clientX - rect.left - thumbR) / (rect.width - thumbR * 2)
  ));
  const max = parseFloat(pcSimSpeedSlider.max);
  const min = parseFloat(pcSimSpeedSlider.min);
  pcSimSpeedSlider.value = Math.round(pct * (max - min) + min);
  updateSliderGradient(pcSimSpeedSlider);
  updateSimSpeedBubble(pcSimSpeedSlider);
});

// 初期状態を反映
updateSliderGradient(pcSimSpeedSlider);
updateSimSpeedBubble(pcSimSpeedSlider);

function getPcSimSpeedKmh() {
  return simSpeedFromSlider(parseFloat(pcSimSpeedSlider.value)) || 50;
}

/* ---- 飛行高度スライダー（鳥瞰モード） ----（非表示中）
const _BIRD_ALT_MIN = 10, _BIRD_ALT_MAX = 5000;
function birdAltFromSlider(t) { ... }
function updateBirdAltBubble(slider) { ... }
*/

// シミュレーターモード ボタンセレクト
let _simViewMode = 'terrain'; // 現在選択中のモードを変数で保持（DOM クエリより確実）

function getSimViewMode() {
  return _simViewMode;
}
function syncSimStartButtons() {
  const terrainBtn = document.getElementById('pc-sim-toggle-btn');
  const birdBtn = document.getElementById('pc-sim-bird-btn');
  if (!terrainBtn || !birdBtn) return;

  terrainBtn.textContent = (pcSimState.active && pcSimState.viewMode !== 'bird')
    ? '[Esc]でシミュレーター終了'
    : '地面を走る';
  birdBtn.textContent = (pcSimState.active && pcSimState.viewMode === 'bird')
    ? '[Esc]で飛行終了'
    : '空を飛ぶ';
  terrainBtn.classList.toggle('pc-sim-active', pcSimState.active && pcSimState.viewMode !== 'bird');
  birdBtn.classList.toggle('pc-sim-active', pcSimState.active && pcSimState.viewMode === 'bird');
}
syncSimStartButtons();

/* ----------------------------------------------------------------
   PCシム開始: Pointer Lock をリクエストし、ロック成功後にループ起動
   ---------------------------------------------------------------- */
async function startPcSim() {
  const mapEl = document.getElementById('map');
  try {
    await mapEl.requestPointerLock({ unadjustedMovement: true });
  } catch (e) {
    // unadjustedMovement 非対応ブラウザはフォールバック
    try {
      await mapEl.requestPointerLock();
    } catch (e2) {
      console.warn('Pointer Lock 失敗:', e2);
    }
  }
}

/* ----------------------------------------------------------------
   Pointer Lock の変化を監視 → ロック成功時に onPcSimLocked を呼ぶ
   Esc でロック解除 → pausePcSim でポーズHUDを表示
   ポーズから再開 → resumePcSimLocked でループ再開
   ---------------------------------------------------------------- */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === document.getElementById('map')) {
    // ポインターロック取得
    if (!pcSimState.active) {
      onPcSimLocked();           // 新規開始
    } else if (pcSimState.paused) {
      resumePcSimLocked();       // ポーズから再開
    }
  } else {
    // ポインターロック解放
    if (pcSimState.active && !pcSimState.paused) {
      pausePcSim();              // Esc 押下 → ポーズHUD表示
    }
    // paused 中の解放は無視（pausePcSim 内で既に処理済み）
  }
});
document.addEventListener('pointerlockerror', (e) => {
  console.error('Pointer Lock エラー:', e);
});

/* ----------------------------------------------------------------
   onPcSimLocked: Pointer Lock 成功後の初期化処理
   ---------------------------------------------------------------- */
function onPcSimLocked() {
  pcSimState.active = true;

  // ① 地図操作を全て無効化
  _map.dragPan.disable();
  _map.dragRotate.disable();
  _map.scrollZoom.disable();
  _map.doubleClickZoom.disable();
  _map.touchZoomRotate.disable();
  _map.keyboard.disable();

  // ② プレイヤー位置・カメラパラメータを初期化（クリック位置優先、なければ地図中心）
  const c    = (pcSimState.startLng != null) ? { lng: pcSimState.startLng, lat: pcSimState.startLat } : _map.getCenter();
  pcSimState.startLng = null; pcSimState.startLat = null;
  pcSimState.playerLng = c.lng;
  pcSimState.playerLat = c.lat;
  pcSimState.bearing   = _map.getBearing();
  pcSimState.camDistM  = 100;

  // 初期ピッチは地形追従固定
  pcSimState.pitch     = PC_SIM_PITCH;
  pcSimState.smoothedSlopeAdj = 0;

  // キャッシュを現在地の地形高度で初期化
  pcSimState.cachedTerrainH  = _map.queryTerrainElevation({ lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }) ?? 0;

  // ③ カメラをプレイヤー視点へ即配置
  setCameraFromPlayer();

  // ③-b KMZ・フレーム画像を3D地面から一時非表示（Spaceキーの読図マップのみで使用）
  localMapLayers.forEach(entry => {
    if (_map.getLayer(entry.layerId)) {
      _map.setLayoutProperty(entry.layerId, 'visibility', 'none');
    }
  });

  // ④ UIを更新
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('unified-search').style.display = 'none';
  document.getElementById('scale-ctrl-container').style.display = 'none';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = 'none';
  syncSimStartButtons();
  const hintOn = document.getElementById('chk-sim-hint')?.checked ?? true;
  document.getElementById('pc-sim-hint').style.display = hintOn ? 'block' : 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'block';

  addSimPosMarker();
  // 読図マップは初回 openPcReadMap() 時に遅延初期化（非表示コンテナでのWebGL失敗を防ぐ）

  // ⑤ イベントリスナー登録
  document.addEventListener('mousemove',    onPcSimMouseMove);
  document.addEventListener('mousedown',    onPcSimMouseDown);
  document.addEventListener('mouseup',      onPcSimMouseUp);
  document.addEventListener('contextmenu',  onPcSimContextMenu);

  // ⑥ ループ開始
  pcSimState.lastTime  = null;
  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   pausePcSim: Esc によるポインターロック解放 → ポーズHUD表示
   アニメーションループを停止し、UI はシミュレーターモードのまま保持する。
   ---------------------------------------------------------------- */
function pausePcSim() {
  pcSimState.paused = true;

  // アニメーションループを停止（再開時に再起動する）
  if (pcSimState.animFrame) { cancelAnimationFrame(pcSimState.animFrame); pcSimState.animFrame = null; }

  // クロスヘアとヒントを隠す（HUD と重ならないように）
  document.getElementById('pc-sim-hint').style.display       = 'none';
  document.getElementById('pc-sim-crosshair').style.display  = 'none';

  // ポーズHUDを表示
  document.getElementById('pc-sim-pause-hud').style.display = 'flex';
}

/* ----------------------------------------------------------------
   resumePcSimLocked: ポーズHUDから「再開」→ ポインターロック再取得後の復帰処理
   ---------------------------------------------------------------- */
function resumePcSimLocked() {
  pcSimState.paused = false;

  // ポーズHUDを隠す
  document.getElementById('pc-sim-pause-hud').style.display = 'none';

  // クロスヘアとヒントを復元
  const hintOn = document.getElementById('chk-sim-hint')?.checked ?? true;
  document.getElementById('pc-sim-hint').style.display      = hintOn ? 'block' : 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'block';

  // アニメーションループを再開
  pcSimState.lastTime  = null;
  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   stopPcSim: モード終了 & 全リソースを解放
   ---------------------------------------------------------------- */
export function stopPcSim() {
  pcSimState.active = false;
  pcSimState.paused = false;

  // ポーズHUDを非表示
  document.getElementById('pc-sim-pause-hud').style.display = 'none';

  if (pcSimState.animFrame) { cancelAnimationFrame(pcSimState.animFrame); pcSimState.animFrame = null; }

  // 読図マップを閉じて破棄
  closePcReadMap();
  if (pcSimState.readMap) { pcSimState.readMap.remove(); pcSimState.readMap = null; }

  removeSimPosMarker();

  // キー状態・補正値リセット
  Object.keys(pcSimState.keys).forEach(k => { pcSimState.keys[k] = false; });
  pcSimState.smoothedSlopeAdj = 0;

  // UI 復元
  document.getElementById('sidebar').style.display = '';
  document.getElementById('unified-search').style.display = '';
  document.getElementById('scale-ctrl-container').style.display = '';
  document.querySelector('.maplibregl-ctrl-top-right').style.display = '';
  syncSimStartButtons();
  document.getElementById('pc-sim-hint').style.display = 'none';
  document.getElementById('pc-sim-crosshair').style.display = 'none';

  // KMZ・フレーム画像の表示を復元
  localMapLayers.forEach(entry => {
    if (_map.getLayer(entry.layerId)) {
      _map.setLayoutProperty(entry.layerId, 'visibility', entry.visible ? 'visible' : 'none');
    }
  });

  // 地図操作を復元
  _map.dragPan.enable();
  _map.dragRotate.enable();
  _map.scrollZoom.enable();
  _map.doubleClickZoom.enable();
  _map.touchZoomRotate.enable();
  _map.keyboard.enable();
  _map.easeTo({ pitch: INITIAL_PITCH, duration: EASE_DURATION });

  // イベントリスナー解除
  document.removeEventListener('mousemove',   onPcSimMouseMove);
  document.removeEventListener('mousedown',   onPcSimMouseDown);
  document.removeEventListener('mouseup',     onPcSimMouseUp);
  document.removeEventListener('contextmenu', onPcSimContextMenu);
}

/* ----------------------------------------------------------------
   enforceTerrainFloor: カメラ altitude を地形の上に保つ
   設計方針:
   - simBaseZ に頼らず fc.position.z（実際のカメラ altitude）で毎フレーム直接判定
   - サンプル範囲: カメラ eye → center → 前方 SIM_LOOKAHEAD_KM
     ※ ピッチが高いほど eye が center から遠く、後方から前方まで広くカバー
   - zoom変換: alt(z) = cameraZ * 2^(currentZoom − z) より
       floorZoom = currentZoom − log2(floorAltMerc / cameraZ)
   - zoom-out（地面回避）は即座（factor 1.0）、zoom-in（復帰）はゆっくり（0.05）
   ---------------------------------------------------------------- */
const SIM_FLOOR_SAMPLE_N = 12;   // サンプル点数（N+1 点）
const SIM_LOOKAHEAD_KM   = 0.03; // center 前方ルックアヘッド距離（30m）

function enforceTerrainFloor() {
  if (pcSimState.active) return; // PCシムは setCameraFromPlayer で制御
  if (!_map.getTerrain()) return;

  const center  = _map.getCenter();
  const bearing = _map.getBearing();
  const exag    = _map.getTerrain()?.exaggeration ?? 1.0;

  const fc = _map.getFreeCameraOptions();
  if (!fc?.position) return;
  const eyeLL  = fc.position.toLngLat?.() ?? center;
  const cameraZ = fc.position.z; // カメラの実際の altitude（mercator単位）

  // center 前方 SIM_LOOKAHEAD_KM の点（進行方向の地形を先読み）
  const fwdPt = turf.destination([center.lng, center.lat], SIM_LOOKAHEAD_KM, bearing);
  const fwdLL = { lng: fwdPt.geometry.coordinates[0], lat: fwdPt.geometry.coordinates[1] };

  // eye → center → fwdLL を SIM_FLOOR_SAMPLE_N+1 点でサンプリング
  // t=0: eye, t=0.75: center, t=1.0: fwdLL
  let maxElevM = 0;
  for (let i = 0; i <= SIM_FLOOR_SAMPLE_N; i++) {
    const t = i / SIM_FLOOR_SAMPLE_N;
    let lng, lat;
    if (t <= 0.75) {
      // eye → center（全サンプルの 75%）
      const s = t / 0.75;
      lng = eyeLL.lng + (center.lng - eyeLL.lng) * s;
      lat = eyeLL.lat + (center.lat - eyeLL.lat) * s;
    } else {
      // center → fwdLL（残り 25%）
      const s = (t - 0.75) / 0.25;
      lng = center.lng + (fwdLL.lng - center.lng) * s;
      lat = center.lat + (fwdLL.lat - center.lat) * s;
    }
    const e = _map.queryTerrainElevation({ lng, lat }, { exaggerated: false });
    if (e !== null) maxElevM = Math.max(maxElevM, e);
  }

  // 必要なフロア altitude → mercator 単位
  const zpm          = maplibregl.MercatorCoordinate.fromLngLat([center.lng, center.lat], 1).z;
  const floorAltM    = Math.max(SIM_FLOOR_CLEARANCE_M, maxElevM * exag + SIM_FLOOR_CLEARANCE_M);
  const floorAltMerc = floorAltM * zpm;

  // 現在カメラ altitude から必要なズームを計算
  // alt(z) = cameraZ * 2^(currentZoom − z)  →  floorZoom = currentZoom − log2(floorAltMerc / cameraZ)
  const currentZoom   = _map.getZoom();
  const floorZoom     = currentZoom - Math.log2(floorAltMerc / cameraZ);
  const effectiveZoom = Math.min(mobileSimState.targetZoom, floorZoom);

  const diff = effectiveZoom - currentZoom;
  if (Math.abs(diff) < 0.005) return;

  // zoom-out（地面に近い）は即座に修正、zoom-in（地形を離れた後）はゆっくり戻す
  const factor = diff < 0 ? 1.0 : 0.05;
  _map.setZoom(currentZoom + diff * factor);
}

/* ----------------------------------------------------------------
   setCameraFromPlayer: PCシム用フォローカメラ
   center = プレイヤー位置（MapLibre は terrain 有効時に center 座標の地形面を
   自動的に画面中央へ投影するため、前方シフトは不要）。
   cameraAlt = h + pcSimState.camDistM * cos(pitch) で zoom を計算。
   ---------------------------------------------------------------- */
function setCameraFromPlayer() {
  if (pcSimState.playerLng === null) return;

  // 地形標高取得 — null（タイル未読み込み）の場合はキャッシュ維持。
  // 急降下時にカメラが後方地形にめり込まないよう、高さをスムージング更新する。
  const rawH = _map.queryTerrainElevation(
    { lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }
  );
  if (rawH !== null) pcSimState.cachedTerrainH += (rawH - pcSimState.cachedTerrainH) * 0.25;
  const h = pcSimState.cachedTerrainH;

  const H       = _map.getCanvas().height || 600;
  const fov_rad = 0.6435;
  const R       = 6371008.8;
  const lat_rad = pcSimState.playerLat * Math.PI / 180;

  // ── 地形追従モード ───────────────────────────────────────────────────
  let effectivePitch = Math.max(0, Math.min(_map.getMaxPitch(), pcSimState.pitch + pcSimState.smoothedSlopeAdj));
  const pitchRad = effectivePitch * Math.PI / 180;

  // カメラの後方地上点の地形高度を取得し、カメラが後方地形にめり込まないよう保証する。
  // （pitch=80°では水平98m後方・垂直17mにカメラが位置するため、後方が上り坂だと地形貫通しやすい）
  const backDistKm = pcSimState.camDistM * Math.sin(pitchRad) / 1000;
  const backPt = turf.destination([pcSimState.playerLng, pcSimState.playerLat], backDistKm, (pcSimState.bearing + 180) % 360);
  const backH = _map.queryTerrainElevation(
    { lng: backPt.geometry.coordinates[0], lat: backPt.geometry.coordinates[1] },
    { exaggerated: false }
  ) ?? h;

  const cameraAlt = Math.max(
    h + Math.max(0.3, pcSimState.camDistM * Math.cos(pitchRad)),
    backH + Math.max(1, Math.min(8, pcSimState.camDistM * 0.3)) // 後方地形マージンをカメラ距離に比例させる
  );

  // zoom 計算は地形面からのカメラ相対高度（pcSimState.camDistM * cos(pitch)）を基準にする。
  // cameraAlt（絶対標高）を使うと山岳地では数十mになり高ズームに届かなくなるため。
  const relativeAlt = Math.max(0.3, pcSimState.camDistM * Math.cos(pitchRad));
  const targetZoom = Math.max(12, Math.min(_map.getMaxZoom(), Math.log2(
    H * 2 * Math.PI * R * Math.cos(lat_rad) /
    (1024 * Math.tan(fov_rad / 2) * relativeAlt)
  )));

  _map.jumpTo({
    center:  [pcSimState.playerLng, pcSimState.playerLat],
    bearing: pcSimState.bearing,
    pitch:   effectivePitch,
    zoom:    targetZoom
  });
}

/* ----------------------------------------------------------------
   pcSimLoop: rAF アニメーションループ
   ① deltaTime を使った正確な WASD 移動
   ② 矢印キーによる滑らかな bearing / pitch 変更
   ③ 読図マップ open 中はセンターと回転を更新
   ---------------------------------------------------------------- */
function pcSimLoop(timestamp) {
  if (!pcSimState.active) return;

  // --- deltaTime（秒）を計算 ---
  const dt = pcSimState.lastTime ? Math.min((timestamp - pcSimState.lastTime) / 1000, 0.1) : 0.016;
  pcSimState.lastTime = timestamp;

  // ── WASD 移動（pcSimState.playerLng/Lat を直接更新） ──────────────────────
  const fwd   = (pcSimState.keys.KeyW ? 1 : 0) - (pcSimState.keys.KeyS ? 1 : 0);
  const right = (pcSimState.keys.KeyD ? 1 : 0) - (pcSimState.keys.KeyA ? 1 : 0);

  if (fwd !== 0 || right !== 0) {
    const len        = Math.sqrt(fwd * fwd + right * right);
    const distKm     = (getPcSimSpeedKmh() / 3600) * dt;
    const moveBearing = pcSimState.bearing + Math.atan2(right / len, fwd / len) * (180 / Math.PI);
    const dest = turf.destination([pcSimState.playerLng, pcSimState.playerLat], distKm, moveBearing);

    if (true) {
      pcSimState.playerLng = dest.geometry.coordinates[0];
      pcSimState.playerLat = dest.geometry.coordinates[1];
    }
  }

  // ── 矢印キー視点（pcSimState.bearing / pcSimState.pitch を更新） ───────────────────
  const ARROW_BEARING_RATE = 90;  // deg/s
  const ARROW_PITCH_RATE   = 60;  // deg/s

  if (pcSimState.keys.ArrowLeft)  pcSimState.bearing = (pcSimState.bearing - ARROW_BEARING_RATE * dt + 360) % 360;
  if (pcSimState.keys.ArrowRight) pcSimState.bearing = (pcSimState.bearing + ARROW_BEARING_RATE * dt) % 360;
  if (pcSimState.keys.ArrowUp)    pcSimState.pitch   = Math.min(84, pcSimState.pitch + ARROW_PITCH_RATE * dt);
  if (pcSimState.keys.ArrowDown)  pcSimState.pitch   = Math.max(0,  pcSimState.pitch - ARROW_PITCH_RATE * dt);

  // ── 地形傾斜による自動ピッチ補正（地形追従モードのみ） ──────────────
  // 進行方向 25m 先との高度差からスロープ角を推定し、
  // ローパスフィルタ（時定数 1.4s）で平滑化して酔い防止
  if (pcSimState.viewMode === 'terrain' && _map.getTerrain()) {
    const SLOPE_SAMPLE_KM = 0.025; // 25m 先をサンプリング
    const SLOPE_INFLUENCE  = 0.40; // 傾斜角の何割を補正に使うか
    const MAX_SLOPE_ADJ    = 20;   // 最大補正量（deg）
    const SMOOTH_TC        = 1.4;  // 平滑化時定数（秒）

    const elevNow = _map.queryTerrainElevation(
      { lng: pcSimState.playerLng, lat: pcSimState.playerLat }, { exaggerated: false }
    ) ?? 0;
    const fwdPt = turf.destination([pcSimState.playerLng, pcSimState.playerLat], SLOPE_SAMPLE_KM, pcSimState.bearing);
    const elevFwd = _map.queryTerrainElevation(
      { lng: fwdPt.geometry.coordinates[0], lat: fwdPt.geometry.coordinates[1] },
      { exaggerated: false }
    ) ?? elevNow;

    // slopeDeg: 正=上り、負=下り
    const slopeDeg = Math.atan2(elevFwd - elevNow, SLOPE_SAMPLE_KM * 1000) * (180 / Math.PI);
    const targetAdj = Math.max(-MAX_SLOPE_ADJ, Math.min(MAX_SLOPE_ADJ, slopeDeg * SLOPE_INFLUENCE));

    // ローパスフィルタ（急激な補正を抑制）
    pcSimState.smoothedSlopeAdj += (targetAdj - pcSimState.smoothedSlopeAdj) * Math.min(dt / SMOOTH_TC, 1);
  } else {
    // 鳥瞰モード or 地形なし: 傾斜補正をゼロに維持
    pcSimState.smoothedSlopeAdj = 0;
  }

  // ── カメラを配置（プレイヤーを常に画面中央に） ───────────────────
  setCameraFromPlayer();

  // ── 読図マップ同期 ──────────────────────────────────────────────
  if (pcSimState.readOpen && pcSimState.readMap) {
    pcSimState.readMap.setCenter([pcSimState.playerLng, pcSimState.playerLat]);
    document.getElementById('pc-sim-readmap-inner').style.transform =
      `rotate(${-pcSimState.bearing}deg)`;
  }

  const dot = document.getElementById('pc-sim-pos-dot');
  if (dot) { dot.style.display = 'none'; dot.style.background = ''; }
  updateSimPosMarker(pcSimState.playerLng, pcSimState.playerLat);

  pcSimState.animFrame = requestAnimationFrame(pcSimLoop);
}

/* ----------------------------------------------------------------
   マウスイベントハンドラ
   ---------------------------------------------------------------- */
function onPcSimMouseMove(e) {
  if (!pcSimState.active || !document.pointerLockElement) return;

  const MOUSE_BEARING_SENS = 0.15; // deg/px
  const MOUSE_PITCH_SENS   = 0.10; // deg/px

  pcSimState.bearing = (pcSimState.bearing + e.movementX * MOUSE_BEARING_SENS + 360) % 360;
  // movementY < 0（マウス上移動）→ pitch 増加（より水平視点）
  pcSimState.pitch = Math.max(0, Math.min(85, pcSimState.pitch - e.movementY * MOUSE_PITCH_SENS));
}

function onPcSimMouseDown(e) {
  if (!pcSimState.active) return;
  if (e.button === 2) openPcReadMap(); // 右クリック → 読図
}

function onPcSimMouseUp(e) {
  if (!pcSimState.active) return;
  if (e.button === 2) closePcReadMap();
}

function onPcSimContextMenu(e) {
  if (pcSimState.active) e.preventDefault(); // 右クリックメニューを抑止
}

/* ----------------------------------------------------------------
   キーボードイベントハンドラ（グローバル）
   WASD / 矢印 の押下状態を管理し、Space で読図を開閉する
   ---------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  // PC シムのキー操作
  if (e.code in pcSimState.keys) {
    pcSimState.keys[e.code] = true;
    if (pcSimState.active) e.preventDefault();
  }
  if (pcSimState.active && e.code === 'Space') {
    e.preventDefault();
    openPcReadMap();
  }
  // I/O キー：カメラ距離（PCシム中 or GPX 3D中）
  if ((pcSimState.active || gpxState.viewMode === '3d') && (e.code === 'KeyI' || e.code === 'KeyO')) {
    e.preventDefault();
    if (pcSimState.active) {
      if (e.code === 'KeyI') pcSimState.camDistM = Math.max(PC_CAM_DIST_MIN, pcSimState.camDistM * 0.7);
      else                   pcSimState.camDistM = Math.min(PC_CAM_DIST_MAX, pcSimState.camDistM * 1.4);
    } else {
      if (e.code === 'KeyI') gpxState.camDistM = Math.max(GPX_CAM_DIST_MIN, gpxState.camDistM * 0.7);
      else                   gpxState.camDistM = Math.min(GPX_CAM_DIST_MAX, gpxState.camDistM * 1.4);
    }
  }
  // GPX 3D モードの矢印キー（PC シム非アクティブ時のみ）
  if (gpxState.viewMode === '3d' && !pcSimState.active && e.code in gpxState.chaseKeys) {
    gpxState.chaseKeys[e.code] = true;
    e.preventDefault();
  }
  // W/S キー：GPX 再生中に時間を進める/戻す（2D/3D 両モード対応、PCシム非アクティブ時）
  if (!pcSimState.active && gpxState.trackPoints.length > 0 && (e.code === 'KeyW' || e.code === 'KeyS')) {
    e.preventDefault();
    const SEEK_STEP = 5000; // 5秒
    if (e.code === 'KeyW') gpxState.currentTime = Math.min(gpxState.totalDuration, gpxState.currentTime + SEEK_STEP);
    else                   gpxState.currentTime = Math.max(0, gpxState.currentTime - SEEK_STEP);
    const seekBar = document.getElementById('seek-bar');
    seekBar.value = gpxState.currentTime;
    updateSeekBarGradient();
    updateTimeDisplay();
    const pos = interpolateGpxPosition(gpxState.currentTime);
    if (pos) {
      gpxState.smoothedBearing = pos.bearing; // W/S シーク時もスナップ
      updateGpxMarker(pos);
      updateCamera(pos, 16);
    }
  }
});

// モバイルシム：ズームスライダー操作
document.getElementById('sim-zoom-slider').addEventListener('input', function () {
  const z = parseFloat(this.value);
  mobileSimState.targetZoom = z;
  _map.setZoom(z);
  document.getElementById('sim-zoom-val').textContent = z.toFixed(1);
  updateSliderGradient(this);
});

document.addEventListener('keyup', (e) => {
  if (e.code in pcSimState.keys) pcSimState.keys[e.code] = false;
  if (e.code in gpxState.chaseKeys) gpxState.chaseKeys[e.code] = false;
  if (pcSimState.active && e.code === 'Space') closePcReadMap();
});

/* ----------------------------------------------------------------
   getReadmapBaseStyle: 選択された背景キーに対応する MapLibre style を返す
   ---------------------------------------------------------------- */
function getReadmapBaseStyle(bgKey) {
  // OriLibre はisomizer構築完了時のキャッシュを使用
  // （_map.getStyle()はベースマップ切替後に別スタイルを返すため、キャッシュが必要）
  if (bgKey === 'orilibre') {
    return _getOriLibreCachedStyle() ?? _map.getStyle();
  }
  // KMZ選択時 → 地理院淡色を薄い下地として使用
  const tileKey = bgKey.startsWith('kmz-')
    ? 'gsi-pale'
    : (!BASEMAPS[bgKey] ? 'gsi-std' : bgKey);

  const bm = BASEMAPS[tileKey];
  return {
    version: 8,
    sources: {
      'pc-read-base': {
        type: 'raster',
        tiles: [bm.url],
        tileSize: Math.round(256 / (window.devicePixelRatio || 1)),
        attribution: '',
        maxzoom: bm.maxzoom,
      },
    },
    layers: [{ id: 'pc-read-base', type: 'raster', source: 'pc-read-base' }],
  };
}

/* ----------------------------------------------------------------
   syncReadmapOriLibre: OriLibre読図マップに磁北線・等高線設定を同期
   initPcReadMap の load コールバック、applyContourInterval などから呼ばれる。
   ---------------------------------------------------------------- */
export function syncReadmapOriLibre() {
  if (!pcSimState.readMap || !pcSimState.readMap.isStyleLoaded()) return;
  if (document.getElementById('sel-readmap-bg').value !== 'orilibre') return;

  // ── 等高線: tile URL と visibility を同期 ──────────────────────
  const lastContour = _getLastAppliedContour();
  if (pcSimState.readMap.getSource('contour-source') && lastContour) {
    const newUrl = buildContourTileUrl(lastContour);
    if (newUrl) pcSimState.readMap.getSource('contour-source').setTiles([newUrl]);
  }
  const contourCard = document.getElementById('contour-card');
  const contourVis = contourCard?.classList.contains('active') ? 'visible' : 'none';
  for (const id of contourLayerIds) {
    if (!pcSimState.readMap.getLayer(id)) continue;
    // symbol レイヤー（数値ラベル）は常に非表示
    const vis = pcSimState.readMap.getLayer(id).type === 'symbol' ? 'none' : contourVis;
    pcSimState.readMap.setLayoutProperty(id, 'visibility', vis);
  }

  // ── 磁北線: ソース・レイヤーを初回追加してから GeoJSON を同期 ──
  const magneticCard = document.getElementById('magnetic-card');
  const magnVis = magneticCard?.classList.contains('active') ? 'visible' : 'none';
  if (!pcSimState.readMap.getSource('magnetic-north')) {
    pcSimState.readMap.addSource('magnetic-north', {
      type: 'geojson',
      data: getLastMagneticNorthData(),
    });
    pcSimState.readMap.addLayer({
      id: 'magnetic-north-layer',
      type: 'line',
      source: 'magnetic-north',
      layout: { visibility: magnVis },
      paint: {
        'line-color': getMagneticLineColor(),
        'line-width': 0.8,
        'line-opacity': 1.0,
      },
    });
  } else {
    pcSimState.readMap.getSource('magnetic-north').setData(getLastMagneticNorthData());
    if (pcSimState.readMap.getLayer('magnetic-north-layer')) {
      pcSimState.readMap.setLayoutProperty('magnetic-north-layer', 'visibility', magnVis);
      applyMagneticLineColor(pcSimState.readMap);
    }
  }
}

/* ----------------------------------------------------------------
   initPcReadMap: 読図用 MapLibre インスタンスを生成
   選択中の読図地図設定を反映したベースで初期化する。
   ---------------------------------------------------------------- */
function initPcReadMap() {
  if (pcSimState.readMap) return;

  // 選択中の読図地図背景を取得
  const bgKey = document.getElementById('sel-readmap-bg').value;

  pcSimState.readMap = new maplibregl.Map({
    container: 'pc-sim-readmap-map',
    style:       getReadmapBaseStyle(bgKey),
    center:      [pcSimState.playerLng ?? _map.getCenter().lng, pcSimState.playerLat ?? _map.getCenter().lat],
    zoom:        16,
    bearing:     0,
    pitch:       0,
    interactive: false,
    attributionControl: false,
  });

  pcSimState.readMap.on('load', () => {
    syncKmzToPcReadMap(bgKey);
    syncReadmapOriLibre();
    // ロード完了後に rotation・resize を適用（遅延初期化の場合に必要）
    document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcSimState.bearing}deg)`;
    pcSimState.readMap.resize();
  });
}

/* ----------------------------------------------------------------
   syncKmzToPcReadMap: localMapLayers を読図マップに複製
   bgKey が 'kmz-{id}' の場合は対象 KMZ のみ表示、それ以外は全 KMZ を重ねる。
   ---------------------------------------------------------------- */
function syncKmzToPcReadMap(bgKey) {
  if (!pcSimState.readMap || !pcSimState.readMap.isStyleLoaded()) return;
  // bgKey が省略された場合は現在の選択値を参照
  bgKey = bgKey ?? document.getElementById('sel-readmap-bg').value;

  // KMZ モードかどうかと、選択された KMZ の id を判定
  const isKmzMode   = bgKey.startsWith('kmz-');
  const selectedKmzId = isKmzMode ? parseInt(bgKey.slice(4)) : -1;

  localMapLayers.forEach(entry => {
    if (pcSimState.readMap.getSource(entry.sourceId)) return;
    const spec = _map.getStyle()?.sources?.[entry.sourceId];
    if (!spec) return;
    pcSimState.readMap.addSource(entry.sourceId, spec);
    pcSimState.readMap.addLayer({
      id:     entry.layerId + '-pcread',
      type:   'raster',
      source: entry.sourceId,
      paint: {
        // KMZ モードは選択 KMZ のみ全表示、他は非表示。ベースマップモードは全表示。
        'raster-opacity':       isKmzMode ? (entry.id === selectedKmzId ? 1.0 : 0.0) : 0.92,
        'raster-fade-duration': 0,
      },
    });
  });
}

/* ----------------------------------------------------------------
   updateReadmapBgKmzOptions: 読図地図セレクトの KMZ オプションを同期
   KMZ 追加・削除時（renderLocalMapList）から呼ばれる。
   ---------------------------------------------------------------- */
export function updateReadmapBgKmzOptions() {
  const sel = document.getElementById('sel-readmap-bg');
  if (!sel) return;

  const currentVal = sel.value;

  // data-kmz 属性付き option（KMZ 区切り線＋KMZ 項目）を全て削除してから再構築
  [...sel.options].filter(o => o.dataset.kmz).forEach(o => o.remove());

  if (localMapLayers.length > 0) {
    // KMZ ファイルを先頭（index=0）から順に挿入（読み込んだ地図が最上部に来るよう）
    // 区切り線（KMZ の後に配置）
    const sep = new Option('──────');
    sep.disabled = true;
    sep.dataset.kmz = '1';
    sel.insertBefore(sep, sel.options[0]);

    // KMZ ファイルを逆順で index=0 に挿入することで先頭に降順追加
    [...localMapLayers].reverse().forEach(entry => {
      const shortName = entry.name.replace(/\.kmz$/i, '');
      const opt = new Option(`🗺 ${shortName}`, `kmz-${entry.id}`);
      opt.dataset.kmz = '1';
      sel.insertBefore(opt, sel.options[0]);
    });
  }

  // 選択値を維持。削除されたKMZが選択されていた場合は 'orilibre' に戻す。
  const validVals = new Set([
    'orilibre', 'gsi-std', 'gsi-pale', 'gsi-photo', 'osm',
    ...localMapLayers.map(e => `kmz-${e.id}`),
  ]);
  sel.value = validVals.has(currentVal) ? currentVal : 'orilibre';

  // カスタムセレクトUIにオプション変更を反映
  if (sel._csRefresh) sel._csRefresh();
}

/* ----------------------------------------------------------------
   openPcReadMap / closePcReadMap: 読図マップの表示・非表示
   ---------------------------------------------------------------- */
export function openPcReadMap() {
  if (pcSimState.readOpen) return;
  pcSimState.readOpen = true;

  const overlay = document.getElementById('pc-sim-readmap-overlay');
  overlay.classList.add('visible');

  if (!pcSimState.readMap) {
    // 初回: オーバーレイが visible になってから初期化（WebGL コンテキストを正常サイズで生成）
    initPcReadMap();
    return;
  }

  pcSimState.readMap.setCenter([pcSimState.playerLng ?? _map.getCenter().lng, pcSimState.playerLat ?? _map.getCenter().lat]);
  document.getElementById('pc-sim-readmap-inner').style.transform = `rotate(${-pcSimState.bearing}deg)`;
  pcSimState.readMap.resize();
}

export function closePcReadMap() {
  if (!pcSimState.readOpen) return;
  pcSimState.readOpen = false;
  document.getElementById('pc-sim-readmap-overlay').classList.remove('visible');
}

// ---- 開始位置クリック待ちモード ----
function enterSimStartPicking() {
  if (pcSimState.pickingActive || pcSimState.active) return;
  pcSimState.pickingActive = true;
  document.getElementById('sim-start-cursor').style.display = 'block';
  document.getElementById('sim-start-hint-overlay').style.display = 'block';
  document.addEventListener('mousemove', _onSimPickMouseMove);
  document.getElementById('map').addEventListener('click', _onSimPickClick);
  document.addEventListener('keydown', _onSimPickKeydown);
}

function exitSimStartPicking() {
  if (!pcSimState.pickingActive) return;
  pcSimState.pickingActive = false;
  document.getElementById('sim-start-cursor').style.display = 'none';
  document.getElementById('sim-start-hint-overlay').style.display = 'none';
  document.removeEventListener('mousemove', _onSimPickMouseMove);
  document.getElementById('map').removeEventListener('click', _onSimPickClick);
  document.removeEventListener('keydown', _onSimPickKeydown);
}

function _onSimPickMouseMove(e) {
  const cursor = document.getElementById('sim-start-cursor');
  cursor.style.left = e.clientX + 'px';
  cursor.style.top  = e.clientY + 'px';
}

function _onSimPickClick(e) {
  const rect  = document.getElementById('map').getBoundingClientRect();
  const lngLat = _map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
  pcSimState.startLng = lngLat.lng;
  pcSimState.startLat = lngLat.lat;
  exitSimStartPicking();
  startPcSim();
}

function _onSimPickKeydown(e) {
  if (e.key === 'Escape') exitSimStartPicking();
}

// ---- PCシムボタンのイベント ----
document.getElementById('pc-sim-toggle-btn').addEventListener('click', () => {
  if (pcSimState.active) stopPcSim();
  else {
    pcSimState.viewMode = 'terrain'; // ボタンクリック時に直接セット
    enterSimStartPicking();
  }
});

/* 「空を飛ぶ」ボタンのイベントリスナー（非表示中）
document.getElementById('pc-sim-bird-btn').addEventListener('click', () => {
  if (pcSimState.active) stopPcSim();
  else {
    pcSimState.viewMode = 'bird';
    enterSimStartPicking();
  }
});
*/

/* ----------------------------------------------------------------
   システム設定モーダル: 開閉
   ---------------------------------------------------------------- */
function openSysSettingsModal() {
  document.getElementById('sys-settings-modal').style.display = 'flex';
  // バブル位置は CSS calc(--pct) で決まるため即時更新可
  const _ms = document.getElementById('ppi-manual-slider');
  if (_ms) { _ms.value = getCurrentDevicePPI(); updateSliderGradient(_ms); updatePpiSliderBubble(_ms); }
  // 定規は clientWidth が必要。二重 rAF でレイアウト確定後に取得する
  requestAnimationFrame(() => requestAnimationFrame(() => { updatePpiRuler(); }));
}
function closeSysSettingsModal() {
  document.getElementById('sys-settings-modal').style.display = 'none';
}

document.getElementById('sys-settings-open-btn').addEventListener('click', openSysSettingsModal);
document.getElementById('sys-settings-close-btn').addEventListener('click', closeSysSettingsModal);

// 左ナビのセクション切り替え
document.getElementById('settings-nav').addEventListener('click', e => {
  const btn = e.target.closest('.settings-nav-item');
  if (!btn) return;
  const sec = btn.dataset.section;
  document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.settings-section').forEach(s => s.classList.toggle('active', s.id === `settings-sec-${sec}`));
  // 画面・校正セクション表示時に定規を再描画（非表示中は clientWidth=0 のため）
  if (sec === 'display') requestAnimationFrame(() => { updatePpiRuler(); });
});
// モーダル背景クリックで閉じる
document.getElementById('sys-settings-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sys-settings-modal')) closeSysSettingsModal();
});

/* ----------------------------------------------------------------
   ポーズHUD: 再開 / システム設定 / 終了 ボタン
   ---------------------------------------------------------------- */
document.getElementById('pause-hud-resume-btn').addEventListener('click', () => {
  // ポーズHUD を隠してポインターロックを再取得 → resumePcSimLocked が呼ばれる
  document.getElementById('pc-sim-pause-hud').style.display = 'none';
  startPcSim();
});

document.getElementById('pause-hud-settings-btn').addEventListener('click', openSysSettingsModal);

document.getElementById('pause-hud-stop-btn').addEventListener('click', () => {
  stopPcSim();
});


// ---- 読図地図セレクト変更 ----
// PC シム起動中に変更した場合は読図マップを即座に再構築する。
document.getElementById('sel-readmap-bg').addEventListener('change', () => {
  if (pcSimState.readMap && pcSimState.active) {
    closePcReadMap();
    pcSimState.readMap.remove();
    pcSimState.readMap = null;
    // 次回 openPcReadMap() 時に新設定で再初期化
  }
});

// シミュレーターボタンは CSS で display:block 設定済み。JSによる上書き不要。


/* ================================================================
   シミュレータータブ: 読図地図リスト
   ================================================================ */

// 選択中の読図地図 ID（カードリスト・セレクト双方と同期）
let activeReadmapId = null;

export function renderSimReadmapList() {
  const listEl = document.getElementById('sim-readmap-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (localMapLayers.length === 0) {
    listEl.innerHTML = '<div class="sim-readmap-empty">地図が読み込まれていません</div>';
    // activeReadmapId をリセット
    activeReadmapId = null;
    return;
  }

  // activeReadmapId が未設定 or 既存エントリにない場合は先頭に設定
  if (!activeReadmapId || !localMapLayers.find(e => e.id === activeReadmapId)) {
    activeReadmapId = localMapLayers[0].id;
    // sel-readmap-bg も同期
    const selReadmap = document.getElementById('sel-readmap-bg');
    if (selReadmap) {
      const opt = selReadmap.querySelector(`option[value="kmz-${activeReadmapId}"]`);
      if (opt) selReadmap.value = opt.value;
    }
  }

  localMapLayers.forEach(entry => {
    const shortName = entry.name.replace(/\.kmz$/i, '').replace(/\.(jpg|jpeg|png)$/i, '');
    const isActive = (entry.id === activeReadmapId);

    const item = document.createElement('div');
    item.className = 'sim-map-item' + (isActive ? ' active' : '');

    item.innerHTML = `
      <span class="sim-map-dot"></span>
      <span class="sim-map-name" title="${escHtml(entry.name)}">${escHtml(shortName)}</span>
      <button class="sim-map-fly-btn" title="この地図へ移動">→</button>
    `;

    // クリックで読図地図を選択
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('sim-map-fly-btn')) return;
      activeReadmapId = entry.id;
      // sel-readmap-bg を同期（KMZオプションは updateReadmapBgKmzOptions が追加）
      const selReadmap = document.getElementById('sel-readmap-bg');
      if (selReadmap) {
        const opt = selReadmap.querySelector(`option[value="kmz-${entry.id}"]`);
        if (opt) selReadmap.value = opt.value;
      }
      renderSimReadmapList();
    });

    // 移動ボタン：地図の範囲へフライ
    item.querySelector('.sim-map-fly-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (entry.bbox) {
        const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
        _map.fitBounds(
          [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
          { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD, left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
            pitch: INITIAL_PITCH, duration: EASE_DURATION }
        );
      }
    });

    listEl.appendChild(item);
  });
}

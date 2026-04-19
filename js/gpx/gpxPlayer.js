/* ================================================================
   gpxPlayer.js — GPX 再生制御（アニメーションループ・再生/停止・モード切替）
   ================================================================ */

import { gpxState } from './gpxState.js';
import { updateGpxMarker, updateCamera } from './gpxCamera.js';

let _map = null;
export function init(map) { _map = map; }

/* ミリ秒 → MM:SS 文字列（app.js でも使用するためエクスポート） */
export function formatMMSS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const ss = (totalSec % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/* シークバーのグラデーションを現在値に合わせて更新 */
export function updateSeekBarGradient() {
  const bar = document.getElementById('seek-bar');
  const max = parseFloat(bar.max) || 1;
  const pct = (parseFloat(bar.value) / max) * 100;
  bar.style.setProperty('--pct', pct + '%');
}

/* 時間表示パネルを更新 */
export function updateTimeDisplay() {
  document.getElementById('time-current').textContent = formatMMSS(gpxState.currentTime);
  document.getElementById('time-total').textContent   = formatMMSS(gpxState.totalDuration);
}

/* currentTime の位置をトラックポイント間で線形補間して返す */
export function interpolateGpxPosition(t) {
  if (gpxState.trackPoints.length < 2) return null;

  if (t >= gpxState.totalDuration) {
    const last = gpxState.trackPoints[gpxState.trackPoints.length - 1];
    return { lng: last.lng, lat: last.lat, bearing: 0 };
  }

  for (let i = 0; i < gpxState.trackPoints.length - 1; i++) {
    const p0 = gpxState.trackPoints[i];
    const p1 = gpxState.trackPoints[i + 1];
    if (t >= p0.relTime && t <= p1.relTime) {
      const segDuration = p1.relTime - p0.relTime;
      const ratio = segDuration > 0 ? (t - p0.relTime) / segDuration : 0;
      const lng = p0.lng + (p1.lng - p0.lng) * ratio;
      const lat = p0.lat + (p1.lat - p0.lat) * ratio;
      let bearing = 0;
      try {
        bearing = turf.bearing(
          turf.point([p0.lng, p0.lat]),
          turf.point([p1.lng, p1.lat])
        );
      } catch (e) { /* 前回 bearing を維持 */ }
      return { lng, lat, bearing };
    }
  }

  const first = gpxState.trackPoints[0];
  return { lng: first.lng, lat: first.lat, bearing: 0 };
}

/* アニメーションループ（requestAnimationFrame 毎フレーム） */
export function gpxAnimationLoop(timestamp) {
  const elapsed = gpxState.lastTimestamp !== null ? timestamp - gpxState.lastTimestamp : 0;
  gpxState.lastTimestamp = timestamp;

  // 3D モード: 矢印キーによる視点調整
  if (gpxState.viewMode === '3d') {
    const dt = Math.max(0, elapsed) / 1000;
    const BEARING_RATE = 90;
    const PITCH_RATE   = 60;
    if (gpxState.chaseKeys.ArrowLeft)  gpxState.bearingOffset = (gpxState.bearingOffset - BEARING_RATE * dt + 360) % 360;
    if (gpxState.chaseKeys.ArrowRight) gpxState.bearingOffset = (gpxState.bearingOffset + BEARING_RATE * dt) % 360;
    if (gpxState.chaseKeys.ArrowUp)    gpxState.chasePitch = Math.min(85, gpxState.chasePitch + PITCH_RATE * dt);
    if (gpxState.chaseKeys.ArrowDown)  gpxState.chasePitch = Math.max(0,  gpxState.chasePitch - PITCH_RATE * dt);
  }

  const speed = parseInt(document.getElementById('speed-select').value, 10) || 30;
  gpxState.currentTime += elapsed * speed;

  if (gpxState.currentTime >= gpxState.totalDuration) {
    gpxState.currentTime = gpxState.totalDuration;
    gpxState.isPlaying   = false;
    document.getElementById('play-pause-btn').textContent = '▶';
  }

  const seekBar  = document.getElementById('seek-bar');
  seekBar.value  = gpxState.currentTime;
  updateSeekBarGradient();
  updateTimeDisplay();

  const pos = interpolateGpxPosition(gpxState.currentTime);
  if (pos) {
    if (pos.bearing !== 0) gpxState.lastBearing = pos.bearing;
    else pos.bearing = gpxState.lastBearing;
    updateGpxMarker(pos);
    updateCamera(pos, elapsed);
  }

  if (gpxState.isPlaying) {
    gpxState.animFrameId = requestAnimationFrame(gpxAnimationLoop);
  }
}

/* 再生 / 一時停止トグル */
export function toggleGpxPlayPause() {
  if (gpxState.trackPoints.length === 0) return;

  gpxState.isPlaying = !gpxState.isPlaying;
  document.getElementById('play-pause-btn').textContent = gpxState.isPlaying ? '⏸' : '▶';

  if (gpxState.isPlaying) {
    if (gpxState.currentTime >= gpxState.totalDuration) gpxState.currentTime = 0;
    gpxState.lastTimestamp = null;
    gpxState.animFrameId   = requestAnimationFrame(gpxAnimationLoop);
  } else {
    if (gpxState.animFrameId) {
      cancelAnimationFrame(gpxState.animFrameId);
      gpxState.animFrameId = null;
    }
    gpxState.lastTimestamp = null;
  }
}

/* 視点モードを切り替え（2D ↔ 3D） */
export function toggleGpx3dMode() {
  gpxState.viewMode = gpxState.viewMode === '2d' ? '3d' : '2d';
  const btn   = document.getElementById('gpx-3d-btn');
  const panel = document.getElementById('timeline-panel');
  if (gpxState.viewMode === '3d') {
    btn.textContent = '3D';
    btn.classList.add('active');
    panel.classList.add('gpx-3d');
    gpxState.bearingOffset = 0;
  } else {
    btn.textContent = '2D';
    btn.classList.remove('active');
    panel.classList.remove('gpx-3d');
    Object.keys(gpxState.chaseKeys).forEach(k => { gpxState.chaseKeys[k] = false; });
  }
}

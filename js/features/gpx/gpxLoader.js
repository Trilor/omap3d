/* ================================================================
   gpxLoader.js — GPX ファイル解析・MapLibre レイヤー追加
   ================================================================ */

import { emit }     from '../../store/eventBus.js';
import { gpxState } from './gpxState.js';
import { updateSeekBarGradient, updateTimeDisplay, formatMMSS } from './gpxPlayer.js';

let _map = null;
export function init(map) { _map = map; }

/* GPX レイヤーをすべて削除（再読み込み時クリーンアップ） */
export function removeGpxLayers() {
  ['gpx-marker-inner', 'gpx-marker-outer', 'gpx-track-line', 'gpx-track-outline']
    .forEach(id => { if (_map.getLayer(id)) _map.removeLayer(id); });
  ['gpx-marker', 'gpx-track']
    .forEach(id => { if (_map.getSource(id)) _map.removeSource(id); });
}

/* GPX ファイルを解析してレイヤーを追加するメイン関数 */
export async function loadGpx(file, { terrainId = null } = {}) {
  try {
    const text   = await file.text();
    const parser = new DOMParser();
    const gpxDom = parser.parseFromString(text, 'application/xml');
    const trkptEls = gpxDom.querySelectorAll('trkpt');

    const points = Array.from(trkptEls).map(pt => ({
      lng:  parseFloat(pt.getAttribute('lon')),
      lat:  parseFloat(pt.getAttribute('lat')),
      time: pt.querySelector('time')
        ? new Date(pt.querySelector('time').textContent).getTime()
        : null,
    }));

    if (points.length < 2) {
      alert('GPXファイルにトラックポイントが見つかりませんでした。\ntrkデータを含むファイルをご使用ください。');
      return;
    }

    points.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

    const hasTime = points.some(p => p.time !== null);
    if (!hasTime) {
      console.warn('GPXに時刻データがありません。インデックスベースで代替します。');
      points.forEach((p, i) => { p.time = i * 1000; });
    }

    const t0 = points[0].time;
    points.forEach(p => { p.relTime = (p.time ?? 0) - t0; });

    // gpxState 初期化
    gpxState.trackPoints    = points;
    gpxState.totalDuration  = points[points.length - 1].relTime;
    gpxState.currentTime    = 0;
    gpxState.isPlaying      = false;
    gpxState.lastTimestamp  = null;
    gpxState.cachedTerrainH = _map.queryTerrainElevation(
      { lng: points[0].lng, lat: points[0].lat }, { exaggerated: false }
    ) ?? 0;
    gpxState.lastBearing    = 0;
    gpxState.bearingOffset  = 0;
    gpxState.smoothedBearing = points.length >= 2
      ? turf.bearing(
          turf.point([points[0].lng, points[0].lat]),
          turf.point([points[1].lng, points[1].lat])
        )
      : 0;
    gpxState.smoothedZoom = 15;

    if (gpxState.animFrameId) {
      cancelAnimationFrame(gpxState.animFrameId);
      gpxState.animFrameId = null;
    }

    removeGpxLayers();

    // 軌跡レイヤー
    _map.addSource('gpx-track', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: points.map(p => [p.lng, p.lat]) },
          properties: {},
        }],
      },
    });
    _map.addLayer({ id: 'gpx-track-outline', type: 'line', source: 'gpx-track',
      paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.75 } });
    _map.addLayer({ id: 'gpx-track-line', type: 'line', source: 'gpx-track',
      paint: { 'line-color': '#e63030', 'line-width': 3, 'line-opacity': 0.9 } });

    // 現在地マーカーレイヤー
    _map.addSource('gpx-marker', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [points[0].lng, points[0].lat] },
        }],
      },
    });
    _map.addLayer({ id: 'gpx-marker-outer', type: 'circle', source: 'gpx-marker',
      paint: { 'circle-radius': 12, 'circle-color': '#ffffff', 'circle-opacity': 0.75 } });
    _map.addLayer({ id: 'gpx-marker-inner', type: 'circle', source: 'gpx-marker',
      paint: { 'circle-radius': 7, 'circle-color': '#e63030', 'circle-opacity': 1.0 } });

    // UI 初期化
    const seekBar = document.getElementById('seek-bar');
    seekBar.min   = 0;
    seekBar.max   = gpxState.totalDuration;
    seekBar.value = 0;
    updateSeekBarGradient();
    updateTimeDisplay();
    document.getElementById('play-pause-btn').textContent = '▶';
    document.getElementById('timeline-panel').style.display = 'flex';

    gpxState.terrainId = terrainId;
    gpxState.fileName  = file.name;
    const gpxStatusEl = document.getElementById('gpx-status');
    gpxStatusEl.style.display = 'block';
    gpxStatusEl.textContent = `✓ ${file.name}（${points.length}pts・${formatMMSS(gpxState.totalDuration)}）`;

    // エクスプローラー再描画は eventBus 経由で app.js が実行する
    emit('gpx:loaded', { fileName: file.name, points });

    const lngs = points.map(p => p.lng);
    const lats  = points.map(p => p.lat);
    _map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 80, duration: 600 }
    );

    console.log(`GPX読み込み完了: ${file.name}、${points.length}ポイント、総時間 ${formatMMSS(gpxState.totalDuration)}`);

  } catch (err) {
    console.error('GPX読み込みエラー:', err);
    alert(`GPXファイルの読み込み中にエラーが発生しました。\n詳細: ${err.message}`);
  }
}

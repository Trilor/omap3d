/* ================================================================
   mapFactory.js — MapLibre マップインスタンスの生成とコントロール追加
   ================================================================ */

import { getDeclination } from './magneticDeclination.js';
import {
  TERRAIN_URL,
  INITIAL_CENTER, INITIAL_ZOOM, INITIAL_PITCH, INITIAL_BEARING,
} from './config.js';

const _LS_MAP_KEY = 'teledrop-map-state';

// localStorage から前回の地図位置を読み取る（URLハッシュがある場合は null を返す）
function _restoreMapState() {
  if (location.hash) return null;
  try {
    const s = JSON.parse(localStorage.getItem(_LS_MAP_KEY));
    if (s) return { center: [s.lng, s.lat], zoom: s.zoom, pitch: s.pitch, bearing: s.bearing };
  } catch {}
  return null;
}

// 出典パネル開閉に応じて縮尺コントロールを移動（重なり防止）
// MutationObserver: compact-show クラスの変化（開閉）を検知して .above-attrib を付与
// ResizeObserver  : 出典の高さ変化を常時追従して --attrib-h を更新
function _setupAttributionObserver() {
  requestAnimationFrame(() => {
    const attribEl = document.querySelector('.maplibregl-ctrl-attrib');
    const scaleEl  = document.getElementById('scale-ctrl-container');
    if (!attribEl || !scaleEl) return;

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--attrib-h', attribEl.getBoundingClientRect().height + 'px'
      );
    };

    new MutationObserver(() => {
      const open = attribEl.classList.contains('maplibregl-compact-show');
      scaleEl.classList.toggle('above-attrib', open);
    }).observe(attribEl, { attributes: true, attributeFilter: ['class'] });

    new ResizeObserver(updateHeight).observe(attribEl);
    updateHeight();
  });
}

// 磁北を上にするカスタムコントロール
// U字磁石SVGアイコン（N極=濃色#333, S極=淡色#ccc）
const _magneticNorthControl = {
  onAdd(m) {
    this._map = m;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const btn = document.createElement('button');
    btn.type  = 'button';
    btn.title = '磁北を上にする';
    const icon = document.createElement('span');
    icon.className = 'maplibregl-ctrl-icon';
    icon.setAttribute('aria-hidden', 'true');
    // 左J(N極#333): 内弧=CCW / 右J(S極#ccc): 内弧=CW
    icon.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 29 29">' +
      '<path d="M5.5,4 L11.5,4 L11.5,16 A3,3,0,0,0,14.5,19 L14.5,25 A9,9,0,0,1,5.5,16 Z" fill="#333"/>' +
      '<path d="M23.5,4 L17.5,4 L17.5,16 A3,3,0,0,1,14.5,19 L14.5,25 A9,9,0,0,0,23.5,16 Z" fill="#ccc"/>' +
      '</svg>'
    )}")`;
    btn.appendChild(icon);
    // MapLibre bearing = 地図上方が真北から時計回りに何度か
    // 磁北を上にする = bearing を磁気偏角 decl に設定
    btn.addEventListener('click', () => {
      const center = m.getCenter();
      const decl   = getDeclination(center.lat, center.lng);
      m.easeTo({ bearing: decl, pitch: 0, duration: 300 });
    });
    this._container.appendChild(btn);
    return this._container;
  },
  onRemove() {
    this._container.parentNode?.removeChild(this._container);
    this._map = undefined;
  },
};

/**
 * MapLibre マップインスタンスを生成してコントロールを追加する。
 * @returns {{ map: maplibregl.Map, restoredFromStorage: boolean }}
 */
export function createMap() {
  const savedState          = _restoreMapState();
  const restoredFromStorage = savedState !== null;

  const map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    // スクリーンショット・サムネイル生成時に map.getCanvas() をピクセル読み取りするために必要
    preserveDrawingBuffer: true,
    style: {
      version: 8,
      // glyphs/sprite は OpenMapTiles 互換（isomizer のシンボルが動作するよう）
      glyphs:  'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sprite:  'https://openmaptiles.github.io/osm-bright-gl-style/sprite',
      sources: {
        // 3D 地形のために初期 style に含める（setTerrain で参照するため）
        'terrain-dem': {
          type:      'raster-dem',
          tiles:     [TERRAIN_URL],
          tileSize:  256,
          minzoom:   1,
          maxzoom:   15, // DEM5A の上限（z16+ は MapLibre がオーバーズーム）
          encoding:  'terrarium',
          attribution: '',
        },
      },
      // isomizer が load 時にレイヤーを動的注入するため初期は空
      layers: [],
    },
    // デフォルト位置（savedState がある場合はスプレッドで上書き）
    center:  INITIAL_CENTER,
    zoom:    INITIAL_ZOOM,
    pitch:   INITIAL_PITCH,
    bearing: INITIAL_BEARING,
    ...(savedState ?? {}),
    minZoom:  0,
    maxZoom:  24,
    maxPitch: 85,
    locale: {
      'NavigationControl.ZoomIn':              'ズームイン',
      'NavigationControl.ZoomOut':             'ズームアウト',
      'NavigationControl.ResetBearing':        '真北を上にする',
      'FullscreenControl.Enter':               '全画面表示',
      'FullscreenControl.Exit':                '全画面表示を終了',
      'GeolocateControl.FindMyLocation':       '現在地を表示',
      'GeolocateControl.LocationNotAvailable': '現在地を取得できません',
      'AttributionControl.ToggleAttribution':  '出典を表示',
      'AttributionControl.MapFeedback':        'マップのフィードバック',
      'LogoControl.Title':                     'MapLibre',
    },
    // URL ハッシュに地図状態を自動保存・復元（MapLibre / OSM 標準形式）
    hash: true,
  });

  // 出典（固定テキスト）。動的出典は updateRegionalAttribution / updateMagneticAttribution で追記
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '<a href="https://www.geospatial.jp/ckan/dataset/qchizu_94dem_99gsi" target="_blank" rel="noopener">Q地図1mDEM</a>' +
      '/<a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">地理院DEM5A</a>' +
      '/<a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">地理院DEM10B</a>' +
      'を加工して作成',
  }), 'bottom-right');

  _setupAttributionObserver();

  // NavigationControl（ズーム・コンパス）
  map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'top-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  // 磁北コントロール（NavigationControl の直下）
  map.addControl(_magneticNorthControl, 'top-right');
  // 現在位置取得（GPS使用・移動追従・向き表示）
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions:  { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading:   true,
  }), 'top-right');

  return { map, restoredFromStorage };
}

/**
 * plateauController.js — PLATEAU 3D建物・3D地形制御
 *
 * 担当:
 *   - PLATEAU 公式 API からデータセット取得（LOD2/LOD3）
 *   - deck.gl Tile3DLayer による 3D Tiles 描画
 *   - MapLibre fill-extrusion による PLATEAU LOD1 / OFM 建物表示
 *   - 3D地形（terrain-dem）の ON/OFF・誇張率制御
 *   - 地図移動時の PLATEAU 自動更新（位置連動）
 *
 * 使い方: init(map) を map.on('load') 内で呼ぶ。
 */

import { localMapLayers, toRasterOpacity } from '../../store/localMapStore.js';
import { updatePlateauAttribution } from '../../core/attribution.js';
import { showMapLoading, hideMapLoading } from '../../ui/mapLoading.js';
import { saveUiState, updateShareableUrl } from '../../store/uiStateManager.js';

let _map = null;

// ---- PLATEAU 状態 ----
let _plateauCurrentLod = null;
let _plateauCurrentDatasetSignature = '';
let _plateauCurrentGeoidSignature = '';
let _plateauApiCache = null;
const _plateauGeoidCache = new Map();
let _plateauAutoTimer = null;

// ---- deck.gl 状態 ----
let _deckOverlay = null;
let _deckPlateauLayers = [];

// ---- API URL 定数 ----
const PLATEAU_API_URL = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets?type=bldg&format=3dtiles';
const PLATEAU_GEOID_API_URL_2011 = 'https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh2011/cgi/geoidcalc.pl';
const GSI_REVERSE_URL = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

const BUILDING_CFG = {
  ofm: {
    source:      'ofm',
    sourceLayer: 'building',
    height: ['coalesce', ['get', 'render_height'], 3],
    base:   ['coalesce', ['get', 'render_min_height'], 0],
  },
  plateau: {
    source:      'plateau-lod1',
    sourceLayer: 'PLATEAU',
    height: ['coalesce', ['get', 'measuredHeight'], 3],
    base:   0,
  },
};

const TERRAIN_AUTO_HIDE_ZOOM = 5;

export function init(map) {
  _map = map;
  _initListeners();
}

export function syncTerrainRasterOpacity() {
  localMapLayers.forEach(entry => {
    if (_map.getLayer(entry.layerId)) {
      _map.setPaintProperty(entry.layerId, 'raster-opacity', toRasterOpacity(entry.opacity));
    }
  });
}

export async function setBuilding3dEnabled(enabled, { updateCard = true } = {}) {
  const building3dCard = document.getElementById('building3d-card');
  if (updateCard) building3dCard?.classList.toggle('active', !!enabled);
  await updateBuildingLayer();
}

export function setTerrain3dEnabled(enabled, { updateCard = true } = {}) {
  const terrain3dCard = document.getElementById('terrain3d-card');
  const selTerrainExaggeration = document.getElementById('sel-terrain-exaggeration');
  if (updateCard) terrain3dCard?.classList.toggle('active', !!enabled);
  if (enabled) {
    if (_map.getZoom() >= TERRAIN_AUTO_HIDE_ZOOM) {
      _map.setTerrain({ source: 'terrain-dem', exaggeration: parseFloat(selTerrainExaggeration?.value) });
    }
  } else {
    _map.setTerrain(null);
  }
  syncTerrainRasterOpacity();
}

export async function updateBuildingLayer() {
  const mode       = document.getElementById('sel-building')?.value ?? 'plateau';
  const buildingOn = document.getElementById('building3d-card')?.classList.contains('active') ?? true;

  if (_map.getLayer('building-3d')) _map.removeLayer('building-3d');

  if (mode === 'plateau-lod2-api' || mode === 'plateau-lod3-api') {
    const lod = mode === 'plateau-lod2-api' ? 2 : 3;
    if (!buildingOn) {
      _deckPlateauLayers = [];
      _commitDeckLayers();
      _resetPlateauDeckState();
      _hidePlateauAreaLabel();
      updatePlateauAttribution();
    } else {
      await _initPlateauAutoMode(lod);
    }
    return;
  }

  _hidePlateauAreaLabel();
  _resetPlateauDeckState();
  _deckPlateauLayers = [];
  _commitDeckLayers();

  if (!buildingOn) { updatePlateauAttribution(); return; }

  const cfg = BUILDING_CFG[mode];
  if (!cfg || !_map.getSource(cfg.source)) return;

  _map.addLayer({
    id: 'building-3d',
    type: 'fill-extrusion',
    source: cfg.source,
    'source-layer': cfg.sourceLayer,
    minzoom: 15,
    paint: {
      'fill-extrusion-height':  cfg.height,
      'fill-extrusion-base':    cfg.base,
      'fill-extrusion-color':   'rgb(150, 150, 150)',
      'fill-extrusion-opacity': 0.7,
    },
  });
  updatePlateauAttribution();
}

// ---- 内部関数 ----

function _onMapMoveForPlateau() {
  const mode = document.getElementById('sel-building')?.value ?? '';
  if (mode !== 'plateau-lod2-api' && mode !== 'plateau-lod3-api') return;
  if (!document.getElementById('building3d-card')?.classList.contains('active')) return;
  const lod = mode === 'plateau-lod2-api' ? 2 : 3;
  clearTimeout(_plateauAutoTimer);
  _plateauAutoTimer = setTimeout(() => _autoShowPlateauByPosition(lod), 300);
}

function _updatePlateauAreaLabel(text) {
  const el = document.getElementById('plateau-area-label');
  if (el) el.innerHTML = text || '—';
}

function _showPlateauAreaLabel() {
  const el = document.getElementById('plateau-area-label');
  if (el) el.style.display = '';
}

function _hidePlateauAreaLabel() {
  const el = document.getElementById('plateau-area-label');
  if (el) el.style.display = 'none';
}

function _getApproxJapaneseGeoidHeight(latDeg) {
  return latDeg >= 41 ? 31
    : latDeg >= 38 ? 35
    : latDeg >= 34 ? 38
    : 37;
}

function _getPlateauGeoidCacheKey(lng, lat) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function _extractGeoidHeightValue(payload) {
  if (payload == null) return null;
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const found = _extractGeoidHeightValue(value);
      if (Number.isFinite(found)) return found;
    }
    return null;
  }
  if (typeof payload === 'object') {
    const direct = Number(payload.geoidHeight);
    if (Number.isFinite(direct)) return direct;
    for (const value of Object.values(payload)) {
      const found = _extractGeoidHeightValue(value);
      if (Number.isFinite(found)) return found;
    }
  }
  return null;
}

async function _fetchPlateauGeoidHeight(lng, lat) {
  const cacheKey = _getPlateauGeoidCacheKey(lng, lat);
  if (_plateauGeoidCache.has(cacheKey)) return _plateauGeoidCache.get(cacheKey);
  const params = new URLSearchParams({
    outputType: 'json',
    latitude: lat.toFixed(8),
    longitude: lng.toFixed(8),
  });
  const res = await fetch(`${PLATEAU_GEOID_API_URL_2011}?${params.toString()}`);
  if (!res.ok) throw new Error(`ジオイド高 API fetch failed: ${res.status}`);
  const payload = await res.json();
  const geoidHeight = _extractGeoidHeightValue(payload);
  if (!Number.isFinite(geoidHeight)) {
    throw new Error('ジオイド高 API の応答から geoidHeight を取得できませんでした');
  }
  _plateauGeoidCache.set(cacheKey, geoidHeight);
  return geoidHeight;
}

function _resetPlateauDeckState() {
  _plateauCurrentLod = null;
  _plateauCurrentDatasetSignature = '';
  _plateauCurrentGeoidSignature = '';
}

async function _reverseGeocode(lng, lat) {
  const url = `${GSI_REVERSE_URL}?lat=${lat}&lon=${lng}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const result = json.results ?? null;
  console.log('逆ジオコーダー結果:', result);
  return result;
}

function _getPlateauGridSamplePoints() {
  const bounds = _map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const lngs = [west, (west + east) / 2, east];
  const lats = [south, (south + north) / 2, north];
  const points = [];
  for (const lat of lats) {
    for (const lng of lngs) {
      points.push({ lng, lat });
    }
  }
  return points;
}

function _findPlateauDatasetEntry(datasets, muniCd) {
  return datasets.find(d => String(d.city_code) === muniCd)
      ?? datasets.find(d => d.ward_code && String(d.ward_code) === muniCd)
      ?? datasets.find(d => String(d.city_code) === muniCd.slice(0, 4) + '0' && !d.ward);
}

function _buildPlateauAreaSummary(entries) {
  if (!entries.length) return '対象地域外';
  const labels = entries.map(({ entry }) => `${entry.pref} ${entry.ward ? `${entry.city} ${entry.ward}` : entry.city}`);
  return labels.join('<br>');
}

async function _fetchPlateauDatasets() {
  if (_plateauApiCache) return _plateauApiCache;
  const res = await fetch(PLATEAU_API_URL);
  if (!res.ok) throw new Error('PLATEAU API fetch failed: ' + res.status);
  const json = await res.json();
  const datasets = json.datasets ?? json;
  const lod2 = datasets.filter(d => String(d.lod) === '2');
  const lod3 = datasets.filter(d => String(d.lod) === '3');
  console.log(`PLATEAU API: 全${datasets.length}件 LOD2=${lod2.length}件 LOD3=${lod3.length}件`);
  _plateauApiCache = { lod2, lod3 };
  return _plateauApiCache;
}

async function _autoShowPlateauByPosition(lod) {
  if (!document.getElementById('building3d-card')?.classList.contains('active')) return;
  if (_map.getZoom() < 15) {
    _deckPlateauLayers = [];
    _commitDeckLayers();
    _resetPlateauDeckState();
    _updatePlateauAreaLabel('ズーム15以上で表示');
    return;
  }
  try {
    const samplePoints = _getPlateauGridSamplePoints();
    const cache = await _fetchPlateauDatasets();
    const datasets = lod === 2 ? cache.lod2 : cache.lod3;

    const reverseResults = await Promise.all(samplePoints.map(async (point) => {
      const geo = await _reverseGeocode(point.lng, point.lat);
      if (!geo?.muniCd) return null;
      const muniCd = String(geo.muniCd).padStart(5, '0');
      const entry = _findPlateauDatasetEntry(datasets, muniCd);
      if (!entry) return null;
      let geoidHeight;
      try {
        geoidHeight = await _fetchPlateauGeoidHeight(point.lng, point.lat);
      } catch (geoidError) {
        geoidHeight = _getApproxJapaneseGeoidHeight(point.lat);
        console.warn('PLATEAU ジオイド高 API 取得失敗。概算値で補正します:', geoidError);
      }
      return { point, muniCd, entry, geoidHeight };
    }));

    const grouped = new Map();
    for (const result of reverseResults) {
      if (!result) continue;
      const key = result.entry.url;
      if (!grouped.has(key)) {
        grouped.set(key, { entry: result.entry, muniCodes: new Set(), geoidHeights: [] });
      }
      const item = grouped.get(key);
      item.muniCodes.add(result.muniCd);
      item.geoidHeights.push(result.geoidHeight);
    }

    const matchedEntries = Array.from(grouped.values()).map((item) => ({
      entry: item.entry,
      muniCodes: Array.from(item.muniCodes).sort(),
      geoidHeight: item.geoidHeights.reduce((sum, value) => sum + value, 0) / item.geoidHeights.length,
    })).sort((a, b) => a.entry.url.localeCompare(b.entry.url));

    if (!matchedEntries.length) {
      _deckPlateauLayers = [];
      _commitDeckLayers();
      _resetPlateauDeckState();
      _updatePlateauAreaLabel(`データなし（LOD${lod}）`);
      updatePlateauAttribution();
      return;
    }

    const datasetSignature = matchedEntries.map(({ entry, muniCodes }) => `${entry.url}|${muniCodes.join(',')}`).join('||');
    const geoidSignature = matchedEntries.map(({ entry, geoidHeight }) => `${entry.url}|${geoidHeight.toFixed(2)}`).join('||');

    if (lod === _plateauCurrentLod
      && datasetSignature === _plateauCurrentDatasetSignature
      && geoidSignature === _plateauCurrentGeoidSignature) {
      _updatePlateauAreaLabel(_buildPlateauAreaSummary(matchedEntries));
      return;
    }

    _plateauCurrentLod = lod;
    _plateauCurrentDatasetSignature = datasetSignature;
    _plateauCurrentGeoidSignature = geoidSignature;
    _updatePlateauAreaLabel(_buildPlateauAreaSummary(matchedEntries));
    await _applyDeckTile3D(matchedEntries);
    updatePlateauAttribution();

  } catch (e) {
    console.error('PLATEAU 自動取得失敗:', e);
    _updatePlateauAreaLabel('取得エラー: ' + (e?.message ?? e));
  }
}

async function _initPlateauAutoMode(lod) {
  _showPlateauAreaLabel();
  _updatePlateauAreaLabel('取得中…');
  if (lod !== _plateauCurrentLod) _resetPlateauDeckState();
  await _autoShowPlateauByPosition(lod);
}

function _commitDeckLayers() {
  if (!_deckOverlay) return;
  _deckOverlay.setProps({ layers: [..._deckPlateauLayers] });
}

async function _loadDeckGl() {
  if (window.deck) return;
  await new Promise(r => requestAnimationFrame(r));
  if (!window.deck) throw new Error('deck.gl の読み込みに失敗しました');
}

function _initDeckOverlay() {
  if (_deckOverlay || !window.deck) return;
  _deckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
  _map.addControl(_deckOverlay);
  _commitDeckLayers();
}

async function _applyDeckTile3D(tilesetEntries) {
  if (!tilesetEntries?.length) {
    _deckPlateauLayers = [];
    _commitDeckLayers();
    return;
  }
  showMapLoading();
  try {
    await _loadDeckGl();
    _initDeckOverlay();
    let remainingTilesets = tilesetEntries.length;
    _deckPlateauLayers = tilesetEntries.map(({ entry, geoidHeight }, index) => new deck.Tile3DLayer({
      id: `plateau-lod-${index}`,
      data: entry.url,
      loader: window.loaders?.Tiles3DLoader,
      opacity: 0.8,
      pointSize: 1,
      _subLayerProps: {
        scenegraph: { _lighting: 'flat' },
      },
      onTilesetLoad: (tileset) => {
        const waitUntilLoaded = () => {
          if (tileset.isLoaded) {
            remainingTilesets -= 1;
            if (remainingTilesets <= 0) hideMapLoading();
            return;
          }
          requestAnimationFrame(waitUntilLoaded);
        };
        requestAnimationFrame(waitUntilLoaded);
      },
      onTileLoad: (tile) => {
        if (tile.content?.cartographicOrigin) {
          const o = tile.content.cartographicOrigin;
          tile.content.cartographicOrigin = new Float64Array([o[0], o[1], o[2] - geoidHeight]);
        }
      },
    }));
    _commitDeckLayers();
  } catch (e) {
    hideMapLoading();
    console.error('PLATEAU 3D Tiles の表示に失敗:', e);
  }
}

function _initListeners() {
  const building3dCard       = document.getElementById('building3d-card');
  const terrain3dCard        = document.getElementById('terrain3d-card');
  const selTerrainExaggeration = document.getElementById('sel-terrain-exaggeration');

  document.getElementById('sel-building')?.addEventListener('change', () => {
    updateBuildingLayer();
    updateShareableUrl();
    saveUiState();
  });

  building3dCard?.addEventListener('click', (e) => {
    if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
    void setBuilding3dEnabled(!building3dCard.classList.contains('active'), { updateCard: true });
    updateShareableUrl();
    saveUiState();
  });

  terrain3dCard?.addEventListener('click', (e) => {
    if (e.target.closest('.custom-select-wrap') || e.target.closest('select')) return;
    setTerrain3dEnabled(!terrain3dCard.classList.contains('active'), { updateCard: true });
    updateShareableUrl();
    saveUiState();
  });

  selTerrainExaggeration?.addEventListener('change', () => {
    if (terrain3dCard?.classList.contains('active')) {
      setTerrain3dEnabled(true, { updateCard: false });
    }
    updateShareableUrl();
    saveUiState();
  });

  // ズームレベル5未満で3D地形を自動非表示（カードON/OFFは変えず map.setTerrain のみ制御）
  _map.on('zoom', () => {
    if (!terrain3dCard?.classList.contains('active')) return;
    const zoom = _map.getZoom();
    const terrainOn = !!_map.getTerrain();
    if (zoom < TERRAIN_AUTO_HIDE_ZOOM && terrainOn) {
      _map.setTerrain(null);
      syncTerrainRasterOpacity();
    } else if (zoom >= TERRAIN_AUTO_HIDE_ZOOM && !terrainOn) {
      _map.setTerrain({ source: 'terrain-dem', exaggeration: parseFloat(selTerrainExaggeration?.value) });
      syncTerrainRasterOpacity();
    }
  });

  _map.on('moveend', _onMapMoveForPlateau);
  _map.on('zoomend', _onMapMoveForPlateau);
}

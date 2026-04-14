/**
 * terrain-search.js
 * テレイン検索 — ダミーデータ + MapLibre レイヤー管理
 *
 * Phase 1: ダミー GeoJSON データで UI を全動作確認。
 * Phase 2: searchTerrainsApi() を Cloudflare Workers エンドポイントに切り替える。
 */

// ================================================================
// ダミーテレインデータ（Phase 1 専用）
// ================================================================

const DUMMY_TERRAINS = [
  {
    id: 'terrain-yaita-001',
    name: '矢板',
    name_kana: 'やいた',
    region: '関東',
    prefecture: '栃木県',
    type: 'forest',
    tags: ['大会実績あり', 'WC規格'],
    base_scale: 15000,
    contour_interval: 5,
    center: [139.895, 36.812],
    bbox: [139.860, 36.785, 139.930, 36.840],
    boundary: {
      type: 'Polygon',
      coordinates: [[
        [139.860, 36.785],
        [139.930, 36.785],
        [139.930, 36.840],
        [139.860, 36.840],
        [139.860, 36.785],
      ]],
    },
    external_url: null,
    source: 'public',
    visible: true,
    cached_at: null,
  },
  {
    id: 'terrain-takaragaike-001',
    name: '宝が池',
    name_kana: 'たからがいけ',
    region: '近畿',
    prefecture: '京都府',
    type: 'sprint',
    tags: ['市街地', 'スプリント'],
    base_scale: 4000,
    contour_interval: 2,
    center: [135.772, 35.064],
    bbox: [135.754, 35.050, 135.790, 35.078],
    boundary: {
      type: 'Polygon',
      coordinates: [[
        [135.754, 35.050],
        [135.790, 35.050],
        [135.790, 35.078],
        [135.754, 35.078],
        [135.754, 35.050],
      ]],
    },
    external_url: null,
    source: 'public',
    visible: true,
    cached_at: null,
  },
  {
    id: 'terrain-tsukuba-001',
    name: '筑波大学',
    name_kana: 'つくばだいがく',
    region: '関東',
    prefecture: '茨城県',
    type: 'sprint',
    tags: ['大学キャンパス', 'スプリント'],
    base_scale: 4000,
    contour_interval: 2,
    center: [140.104, 36.106],
    bbox: [140.086, 36.092, 140.122, 36.120],
    boundary: {
      type: 'Polygon',
      coordinates: [[
        [140.086, 36.092],
        [140.122, 36.092],
        [140.122, 36.120],
        [140.086, 36.120],
        [140.086, 36.092],
      ]],
    },
    external_url: null,
    source: 'public',
    visible: true,
    cached_at: null,
  },
];

// ================================================================
// 検索 API（Phase 1: ダミー / Phase 2: Cloudflare Workers に差し替え）
// ================================================================

/**
 * テレインを検索して返す
 * @param {string} q — キーワード（空文字で全件）
 * @param {{ types?: string[], region?: string, prefecture?: string }} filters
 * @returns {Promise<Array>}
 */
export async function searchTerrainsApi(q, filters = {}) {
  // Phase 1: ローカルフィルタリング
  let results = DUMMY_TERRAINS.slice();

  if (q && q.trim()) {
    const kw = q.trim().toLowerCase();
    results = results.filter(t =>
      t.name.toLowerCase().includes(kw) ||
      (t.name_kana && t.name_kana.includes(kw)) ||
      t.prefecture.includes(kw) ||
      t.region.includes(kw) ||
      (t.tags && t.tags.some(tag => tag.includes(kw)))
    );
  }

  if (filters.types && filters.types.length > 0) {
    results = results.filter(t => filters.types.includes(t.type));
  }

  if (filters.region) {
    results = results.filter(t => t.region === filters.region);
  }

  if (filters.prefecture) {
    results = results.filter(t => t.prefecture === filters.prefecture);
  }

  // ネットワーク遅延をシミュレート（Phase 1 のみ）
  await new Promise(r => setTimeout(r, 80));

  return results;
}

/**
 * ID でテレインを取得
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getTerrainById(id) {
  return DUMMY_TERRAINS.find(t => t.id === id) ?? null;
}

// ================================================================
// MapLibre レイヤー管理
// ================================================================

const SEARCH_SRC  = 'terrain-search-src';
const WS_SRC      = 'workspace-terrain-src';

const SEARCH_FILL = 'terrain-search-fill';
const SEARCH_LINE = 'terrain-search-line';
const WS_FILL     = 'workspace-terrain-fill';
const WS_LINE     = 'workspace-terrain-line';

/** 空の GeoJSON FeatureCollection */
function emptyFc() {
  return { type: 'FeatureCollection', features: [] };
}

/** テレイン配列を GeoJSON FeatureCollection に変換 */
function terrainsToFc(terrains) {
  return {
    type: 'FeatureCollection',
    features: terrains
      .filter(t => t.boundary)
      .map(t => ({
        type: 'Feature',
        id: t.id,
        geometry: t.boundary,
        properties: {
          id:         t.id,
          name:       t.name,
          type:       t.type,
          source_cls: t.source,
        },
      })),
  };
}

/**
 * MapLibre ソース + レイヤーを初期化する（map.on('load') 後に呼ぶ）
 * @param {maplibregl.Map} map
 */
export function initTerrainLayers(map) {
  // --- 検索結果レイヤー ---
  if (!map.getSource(SEARCH_SRC)) {
    map.addSource(SEARCH_SRC, { type: 'geojson', data: emptyFc(), promoteId: 'id' });
  }
  if (!map.getLayer(SEARCH_FILL)) {
    map.addLayer({
      id: SEARCH_FILL,
      type: 'fill',
      source: SEARCH_SRC,
      paint: {
        'fill-color': '#2563eb',
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], 0.25,
          0.10,
        ],
      },
    });
  }
  if (!map.getLayer(SEARCH_LINE)) {
    map.addLayer({
      id: SEARCH_LINE,
      type: 'line',
      source: SEARCH_SRC,
      paint: {
        'line-color': '#2563eb',
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false], 2.5,
          1.5,
        ],
        'line-opacity': 0.85,
      },
    });
  }

  // --- ワークスペースレイヤー ---
  if (!map.getSource(WS_SRC)) {
    map.addSource(WS_SRC, { type: 'geojson', data: emptyFc(), promoteId: 'id' });
  }
  if (!map.getLayer(WS_FILL)) {
    map.addLayer({
      id: WS_FILL,
      type: 'fill',
      source: WS_SRC,
      paint: {
        'fill-color': '#16a34a',
        'fill-opacity': 0.12,
      },
    });
  }
  if (!map.getLayer(WS_LINE)) {
    map.addLayer({
      id: WS_LINE,
      type: 'line',
      source: WS_SRC,
      paint: {
        'line-color': '#16a34a',
        'line-width': 2,
        'line-opacity': 0.90,
        'line-dasharray': [4, 2],
      },
    });
  }
}

// ================================================================
// ソースデータ更新
// ================================================================

/**
 * 検索結果テレインの表示を更新する
 * @param {maplibregl.Map} map
 * @param {Array} terrains — searchTerrainsApi() の戻り値
 */
export function updateSearchTerrainSource(map, terrains) {
  const src = map.getSource(SEARCH_SRC);
  if (src) src.setData(terrainsToFc(terrains));
}

/**
 * ワークスペーステレインの表示を更新する（visible !== false のみ表示）
 * @param {maplibregl.Map} map
 * @param {Array} terrains — getWsTerrains() の戻り値
 */
export function updateWorkspaceTerrainSource(map, terrains) {
  const src = map.getSource(WS_SRC);
  if (!src) return;
  const visible = terrains.filter(t => t.visible !== false);
  src.setData(terrainsToFc(visible));
}

// ================================================================
// ホバー管理
// ================================================================

let _hoverTerrainId = null;

/**
 * ホバー中のテレインをハイライトする
 * @param {maplibregl.Map} map
 * @param {string|null} id — null でクリア
 */
export function setHoverTerrain(map, id) {
  if (_hoverTerrainId !== null) {
    if (map.getSource(SEARCH_SRC)) {
      map.setFeatureState({ source: SEARCH_SRC, id: _hoverTerrainId }, { hover: false });
    }
  }
  _hoverTerrainId = id;
  if (id !== null) {
    if (map.getSource(SEARCH_SRC)) {
      map.setFeatureState({ source: SEARCH_SRC, id }, { hover: true });
    }
  }
}

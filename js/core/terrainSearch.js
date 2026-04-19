/**
 * terrain-search.js
 * テレイン検索 — フェデレーション検索（公式ダミー + IndexedDB ローカル）+ MapLibre レイヤー管理
 *
 * Phase 1: ダミー GeoJSON データで UI を全動作確認。
 * Phase 2: searchTerrainsApi() の公式側を Cloudflare Workers エンドポイントに切り替える。
 *
 * フェデレーション検索:
 *   公式テレイン（DUMMY_TERRAINS / 将来は Supabase）と
 *   IndexedDB に保存されたローカルテレイン（source:'local'）を並列検索し、
 *   結果をマージして返す。
 */

import { getWsTerrains } from '../api/workspace-db.js';

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

// ================================================================
// 内部ヘルパー: キーワード + フィルタで配列を絞り込む
// ================================================================

function _filterTerrains(list, q, filters) {
  let results = list.slice();

  if (q && q.trim()) {
    const kw = q.trim().toLowerCase();
    results = results.filter(t =>
      t.name.toLowerCase().includes(kw) ||
      (t.name_kana && t.name_kana.includes(kw)) ||
      (t.prefecture && t.prefecture.includes(kw)) ||
      (t.region && t.region.includes(kw)) ||
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

  return results;
}

/**
 * フェデレーション検索: 公式テレイン（Phase1=ダミー）と
 * IndexedDB のローカルテレイン（source:'local'）を並列検索してマージ。
 *
 * 戻り値のテレインオブジェクトには必ず `source` プロパティが含まれる:
 *   'public' — 公式（将来: Supabase）
 *   'local'  — ユーザーが IndexedDB に作成したプライベートテレイン
 *
 * @param {string} q — キーワード（空文字で全件）
 * @param {{ types?: string[], region?: string, prefecture?: string }} filters
 * @returns {Promise<Array>}
 */
export async function searchTerrainsApi(q, filters = {}) {
  // Phase 1: 公式はダミーデータをローカルフィルタリング
  // Phase 2 移行時はここを Fetch API（Cloudflare Workers）に差し替える
  const publicSearchPromise = (async () => {
    await new Promise(r => setTimeout(r, 80)); // ネットワーク遅延シミュレート
    return _filterTerrains(DUMMY_TERRAINS, q, filters);
  })();

  // IndexedDB からローカルテレインを検索
  const localSearchPromise = (async () => {
    let allLocal = [];
    try {
      const ws = await getWsTerrains();
      allLocal = ws.filter(t => t.source === 'local');
    } catch { /* IndexedDB 未初期化時は空 */ }
    return _filterTerrains(allLocal, q, filters);
  })();

  const [publicResults, localResults] = await Promise.all([publicSearchPromise, localSearchPromise]);

  // ローカルを先頭に表示（ユーザー自身のデータが優先）、次いで公式
  return [...localResults, ...publicResults];
}

/**
 * ID でテレインを取得（公式ダミー + IndexedDB ローカルを横断）
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getTerrainById(id) {
  // まず公式ダミーから検索
  const found = DUMMY_TERRAINS.find(t => t.id === id);
  if (found) return found;

  // 次に IndexedDB のローカルから検索
  try {
    const ws = await getWsTerrains();
    return ws.find(t => t.id === id) ?? null;
  } catch {
    return null;
  }
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

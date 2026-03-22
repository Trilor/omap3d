/* ================================================================
   config.js — アプリ全体で使う定数（URL・初期値・レイヤー定義）
   このファイルのみを変更して URL やパラメータをカスタマイズできます
   ================================================================ */

/* ========================================================
    ★ カスタマイズポイント：各種URLと初期パラメータをここで変更します
    ======================================================== */

// ★ DEM タイルのベース URL
// Q地図 DEM / DEM5A / 湖水深タイルは共に国土地理院 NumPNG 形式（x=2^16R+2^8G+B, u=0.01m）
// gsjdem:// プロトコルが Q地図 > DEM5A > 湖水深 の優先順で合成し Terrarium 形式に変換する。
// DEM5A・湖水深タイルは標準の {z}/{x}/{y} 順。
export const QCHIZU_DEM_BASE  = 'https://mapdata.qchizu.xyz/03_dem/52_gsi/all_2026/1_01';
// Cloudflare Worker 経由の CORS プロキシ URL（mlcontour worker: true を可能にするため）
export const QCHIZU_PROXY_BASE = 'https://teledrop-proxy.trilor.workers.dev/qchizu/03_dem/52_gsi/all_2026/1_01';
export const DEM5A_BASE       = 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png'; // 基盤地図情報DEM5A {z}/{x}/{y}.png
export const DEM1A_BASE       = 'https://cyberjapandata.gsi.go.jp/xyz/dem1a_png'; // 基盤地図情報DEM1A {z}/{x}/{y}.png
export const LAKEDEPTH_BASE          = 'https://cyberjapandata.gsi.go.jp/xyz/lakedepth';          // 湖水深タイル {z}/{x}/{y}.png
export const LAKEDEPTH_STANDARD_BASE = 'https://cyberjapandata.gsi.go.jp/xyz/lakedepth_standard'; // 基準水面標高タイル {z}/{x}/{y}.png
export const LAND_DEM_BASE    = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png'; // 基盤地図情報DEM10B（10mメッシュ・全国カバレッジ）{z}/{x}/{y}.png

export const TERRAIN_URL = 'gsjdem://mapdata.qchizu.xyz/03_dem/52_gsi/all_2026/1_01/{z}/{x}/{y}.webp';

// ★ OriLibre（オリエンテーリング風地図）
//   isomizer と設定データはローカルコピーを使用（js/isomizer/ 以下）
//   Japan版: 国土地理院ベクタータイル + OpenFreeMap + 産総研等高線 + 農林水産省筆ポリゴン

// ★ CS立体図（ブラウザ生成・Q地図DEMから動的生成）
//   csdem:// プロトコルでQ地図DEMタイルをリアルタイムにCS立体図へ変換します。
export const CS_RELIEF_URL = 'csdem://mapdata.qchizu.xyz/03_dem/52_gsi/all_2026/1_01/{z}/{x}/{y}.webp';

// ★ 地域別CS立体図（0.5mDEM由来・高精度）の定義リスト
//   在る地域では全国地理院CSタイルよりも高解像度なため、上層に重ねて表示する。
//   source id : Map内部のID、layer id : 同左 + '-layer'
//   tileUrl   : XYZタイルURLテンプレート
//   label     : UI表示名（ユーザー指定形式）
//   maxzoom   : サーバー側のタイル最大ズーム（オーバーズームで引き伸ばす）
//   attribution: 帰属表記
// ★ 地域別CS立体図（0.5m DEM由来・高精度）の定義リスト
//   DEM が公開されている都道府県は csdem:// プロトコルでブラウザ内生成。
//   大阪府はDEMなし → 事前生成CSタイルをそのまま利用。
export const REGIONAL_CS_LAYERS = [
  // ── 東北 ──────────────────────────────────────────────
  {
    sourceId: 'cs-miyagi', layerId: 'cs-miyagi-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/4_miyagi/dem_2023/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 宮城県', maxzoom: 18, minzoom: 18,
    bounds: [140.2, 37.7, 141.7, 39.0],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-miyagi-maptiles" target="_blank">【宮城県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 関東 ──────────────────────────────────────────────
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    sourceId: 'cs-tochigi', layerId: 'cs-tochigi-layer',
    tileUrl: 'https://rinya-tochigi.geospatial.jp/2023/rinya/tile/csmap/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 栃木県', maxzoom: 18, minzoom: 18,
    bounds: [139.3, 36.1, 140.4, 37.2],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/csmap_tochigi" target="_blank">【栃木県CS】栃木県作成</a>',
  }, */
  /* {
    sourceId: 'cs-tokyo', layerId: 'cs-tokyo-layer',
    tileUrl: 'https://forestgeo.info/opendata/13_tokyo/csmap_2022/{z}/{x}/{y}.webp',
    label: 'CS立体図（0.5m）— 東京都', maxzoom: 18, minzoom: 18,
    bounds: [138.9, 35.5, 139.9, 35.9],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-tokyo-maptiles" target="_blank">【東京都CS】林野庁加工</a>',
  }, */
  {
    sourceId: 'cs-kanagawa', layerId: 'cs-kanagawa-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/14_kanagawa/dem_2022/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 神奈川県', maxzoom: 18, minzoom: 18,
    bounds: [138.9, 35.1, 139.8, 35.7],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-kanagawa-maptiles2" target="_blank">【神奈川県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 近畿 ──────────────────────────────────────────────
  {
    sourceId: 'cs-kyoto', layerId: 'cs-kyoto-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/26_kyoto/dem_2024/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 京都府', maxzoom: 18, minzoom: 18,
    bounds: [135.0, 34.7, 135.9, 35.8],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_kyoto" target="_blank">【京都府CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    sourceId: 'cs-shiga', layerId: 'cs-shiga-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/25_shiga/dem_2023/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 滋賀県', maxzoom: 18, minzoom: 18,
    bounds: [135.7, 34.8, 136.5, 35.7],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-shiga-maptiles" target="_blank">【滋賀県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    // 大阪府はDEM未公開のため事前生成CSタイルを継続使用
    sourceId: 'cs-osaka', layerId: 'cs-osaka-layer',
    tileUrl: 'https://forestgeo.info/opendata/27_osaka/csmap_2020/{z}/{x}/{y}.webp',
    label: 'CS立体図（0.5m）— 大阪府', maxzoom: 18, minzoom: 18,
    bounds: [135.1, 34.3, 135.7, 34.9],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-osaka-maptiles" target="_blank">【大阪府CS】林野庁加工</a>',
  }, */
  {
    sourceId: 'cs-hyogo', layerId: 'cs-hyogo-layer',
    tileUrl: 'csdem://tiles.gsj.jp/tiles/elev/hyogodem/{z}/{y}/{x}.png',
    label: 'CS立体図（0.5m）— 兵庫県', maxzoom: 18, minzoom: 18,
    bounds: [134.2, 34.2, 135.4, 35.7],
    attribution: '<a href="https://tiles.gsj.jp/tiles/elev/tiles.html" target="_blank">【兵庫県CS】産総研PNG標高タイルを加工して作成</a>',
  },
  // ── 中部（甲信越・東海） ───────────────────────────────
  {
    sourceId: 'cs-yamanashi', layerId: 'cs-yamanashi-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/19_yamanashi/dem_2024/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 山梨県', maxzoom: 18, minzoom: 18,
    bounds: [138.3, 35.2, 139.1, 35.9],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-nagano-maptiles" target="_blank">【山梨県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    // 長野県はDEM非公開のため事前生成CSタイルを使用（長野県林務部長承認 ７森政第51-10号）
    sourceId: 'cs-nagano', layerId: 'cs-nagano-layer',
    tileUrl: 'https://forestgeo.info/opendata/20_nagano/csmap_2022/{z}/{x}/{y}.webp',
    label: 'CS立体図（0.5m）— 長野県', maxzoom: 18, minzoom: 18,
    bounds: [136.9, 35.1, 138.7, 37.1],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-nagano-maptiles" target="_blank">【長野県CS】林野庁加工（長野県林務部長承認 ７森政第51-10号）</a>',
  }, */
  /* {
    sourceId: 'cs-shizuoka', layerId: 'cs-shizuoka-layer',
    tileUrl: 'https://forestgeo.info/opendata/22_shizuoka/csmap_2023/{z}/{x}/{y}.webp',
    label: 'CS立体図（0.5m）— 静岡県', maxzoom: 18, minzoom: 18,
    bounds: [137.4, 34.5, 139.2, 35.4],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-shizuoka-maptiles" target="_blank">【静岡県CS】林野庁加工</a>',
  }, */
  // ── 中部（岐阜） ─────────────────────────────────────
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    // 岐阜県はDEM未公開のため事前生成CSタイルを使用
    sourceId: 'cs-gifu', layerId: 'cs-gifu-layer',
    tileUrl: 'https://forestgeo.info/opendata/21_gifu/csmap_2023/{z}/{x}/{y}.webp',
    label: 'CS立体図（0.5m）— 岐阜県', maxzoom: 18, minzoom: 18,
    bounds: [136.1, 35.1, 137.8, 36.6],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-gifu-maptiles" target="_blank">【岐阜県森林研CS】林野庁加工</a>',
  }, */
  // ── 中国 ──────────────────────────────────────────────
  {
    sourceId: 'cs-tottori', layerId: 'cs-tottori-layer',
    tileUrl: 'csdem://rinya-tottori.geospatial.jp/tile/rinya/2024/gridPNG_tottori/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 鳥取県', maxzoom: 18, minzoom: 18,
    bounds: [133.2, 35.0, 134.6, 35.6],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_tottori" target="_blank">【鳥取県CS】鳥取県作成</a>',
  },
  {
    sourceId: 'cs-okayama', layerId: 'cs-okayama-layer',
    tileUrl: 'csdem://forestgeo.info/opendata/33_okayama/dem_2024/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 岡山県', maxzoom: 18, minzoom: 18,
    bounds: [133.2, 34.4, 134.7, 35.2],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-okayama-maptiles" target="_blank">【岡山県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    sourceId: 'cs-hiroshima', layerId: 'cs-hiroshima-layer',
    tileUrl: 'https://www2.ffpri.go.jp/soilmap/tile/cs_hiroshima/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 広島県', maxzoom: 18, minzoom: 18,
    bounds: [131.8, 34.0, 133.5, 35.1],
    attribution: '<a href="https://www2.ffpri.go.jp/soilmap/data-src.html" target="_blank">【広島県CS】森林総合研究所(林野庁)作成</a>',
  }, */
  // ── 四国 ──────────────────────────────────────────────
  {
    sourceId: 'cs-tokushima', layerId: 'cs-tokushima-layer',
    tileUrl: 'csdem://rinya-tiles.geospatial.jp/dem_117_2025/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 徳島県', maxzoom: 18, minzoom: 18,
    bounds: [133.7, 33.7, 134.9, 34.4],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/tokushima_aerial_laser" target="_blank">【徳島県CS】林野庁PNG標高タイルを加工して作成</a>',
  },
  // 事前生成CSタイルのため無効化（Q地図1m CS立体図に統一）
  /* {
    sourceId: 'cs-kochi', layerId: 'cs-kochi-layer',
    tileUrl: 'https://rinya-kochi.geospatial.jp/2023/rinya/tile/csmap/{z}/{x}/{y}.png',
    label: 'CS立体図（0.5m）— 高知県', maxzoom: 18, minzoom: 18,
    bounds: [132.4, 32.7, 134.4, 34.1],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/csmap_kochi" target="_blank">【高知県CS】高知県作成</a>',
  }, */
  /* {
    sourceId: 'cs-ehime', layerId: 'cs-ehime-layer',
    tileUrl: 'https://rinya-ehime.geospatial.jp/tile/rinya/2024/csmap_Ehime/{z}/{x}/{-y}.png',
    label: 'CS立体図（0.5m）— 愛媛県', maxzoom: 18, minzoom: 18,
    bounds: [131.9, 32.9, 133.8, 34.4],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/csmap_ehime" target="_blank">【愛媛県CS】愛媛県作成</a>',
  }, */
];

// ★ 初期表示: 京都大学吉田キャンパス
export const INITIAL_CENTER = [135.7814,35.0261];

// ★ 初期ズームレベル（キャンパス全体が見える程度）
export const INITIAL_ZOOM = 15;

// ★ 初期の傾き: 0 = 真上から（2D表示）
export const INITIAL_PITCH = 0;

// ★ 初期の向き: 北上
export const INITIAL_BEARING = 0;

// ★ 地形誇張係数（1.0 = 実寸。2D表示時は視覚的影響なし）
export const TERRAIN_EXAGGERATION = 1.0;

// ★ KMZオーバーレイの初期不透明度
export const OMAP_INITIAL_OPACITY = 1.0;

// ★ CS立体図の初期不透明度（仕様書: 乗算代替として0.6推奨）
export const CS_INITIAL_OPACITY = 0.6;

// ベースマップ定義（url/maxzoom があるものはラスタータイル、ないものはベクター）
// setStyle() を使わず visibility 切替で実現するため、load 時に全ソース/レイヤーを追加しておく。
export const RASTER_BASEMAPS = {
  'orilibre':  { attr: '<a href="https://github.com/tjmsy/orilibre" target="_blank">OriLibre</a>' },
  'gsi-std':   { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',           maxzoom: 18,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-pale':  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',          maxzoom: 18,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-blank': { url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png',         maxzoom: 14,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-photo': { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxzoom: 18,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'osm':       { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',                     maxzoom: 19,
                 attr: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors' },
};

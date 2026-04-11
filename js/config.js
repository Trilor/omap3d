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
export const QCHIZU_DEM_BASE  = 'https://qchizu3.xsrv.jp/mapdata/d52001';
// Cloudflare Pages Functions 経由の CORS プロキシ URL（mlcontour worker: true を可能にするため）
// functions/qchizu/[[path]].js が /qchizu/* を https://qchizu3.xsrv.jp/* にプロキシする
// /qchizu/mapdata/d52001/{z}/{x}/{y}.webp → qchizu3.xsrv.jp/mapdata/d52001/{z}/{x}/{y}.webp
export const QCHIZU_PROXY_BASE = '/qchizu/mapdata/d52001';
export const DEM5A_BASE       = 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png'; // 基盤地図情報DEM5A {z}/{x}/{y}.png
export const DEM1A_BASE       = 'https://cyberjapandata.gsi.go.jp/xyz/dem1a_png'; // 基盤地図情報DEM1A {z}/{x}/{y}.png
// 湖水深タイルは廃止（2026-03-23 コメントアウト）
// export const LAKEDEPTH_BASE          = 'https://cyberjapandata.gsi.go.jp/xyz/lakedepth';
// export const LAKEDEPTH_STANDARD_BASE = 'https://cyberjapandata.gsi.go.jp/xyz/lakedepth_standard';
export const DEM10B_BASE      = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png'; // 基盤地図情報DEM10B（10mメッシュ・全国カバレッジ）{z}/{x}/{y}.png

// gsjdem:// ハンドラは URL から z/x/y を抽出するだけなので任意のパスで可
export const TERRAIN_URL = 'gsjdem://terrain/{z}/{x}/{y}.png';

// ★ OriLibre（オリエンテーリング風地図）
//   isomizer と設定データはローカルコピーを使用（js/isomizer/ 以下）
//   Japan版: 国土地理院ベクタータイル + OpenFreeMap + 産総研等高線 + 農林水産省筆ポリゴン

// ★ CS立体図（ブラウザ生成・Q地図DEMから動的生成）
//   dem2cs:// プロトコルでQ地図DEMタイルをリアルタイムにCS立体図へ変換します。
export const CS_RELIEF_URL = `dem2cs://${QCHIZU_DEM_BASE.replace(/^https?:\/\//, '')}/{z}/{x}/{y}.webp`;

// ★ 地域別高精度DEMソース定義（0.5m DEM が公開されている地域）
//   各エントリは CS立体図・赤色立体図・傾斜量図など複数のオーバーレイの派生元となる。
//   id         : 地域識別子（プレフィックスなし）
//   demUrl     : プロトコル部分（dem2cs:// 等）を除いた生の DEM タイル URL テンプレート
//   region     : UI 表示用の地域名（都道府県名）
//   maxzoom    : サーバー側のタイル最大ズーム（オーバーズームで引き伸ばす）
//   minzoom    : サーバー側のタイル最小ズーム（表示開始ズームは app.js 側で制御）
//   bounds     : [west, south, east, north] 表示範囲
//   attribution: データ帰属表記
//   format     : 省略時は NumPNG（標高 = (R×2^16 + G×2^8 + B) × 0.01 − 0m基準）
//                'terrain-rgb' の場合は Mapbox Terrain-RGB 形式
//                  標高 = −10,000 + (R×256×256 + G×256 + B) × 0.1
//                  ※ dem2cs:// / dem2rrim:// は現時点で NumPNG のみ対応。
//                  ※ terrain-rgb エントリは _makeOverlayLayers() で自動除外される。
export const REGIONAL_DEM_SOURCES = [
  // ── 東北 ──────────────────────────────────────────────
  {
    id: 'miyagi', region: '宮城県',
    demUrl: 'forestgeo.info/opendata/4_miyagi/dem_2023/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [140.2, 37.7, 141.7, 39.0],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-miyagi-maptiles" target="_blank">【宮城県】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'yamagata-shonai', region: '山形県（庄内）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_028_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [139.4, 38.5, 140.5, 39.5],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/028_syounai" target="_blank">【山形県（庄内）】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 関東 ──────────────────────────────────────────────
  {
    id: 'tochigi', region: '栃木県',
    demUrl: 'rinya-tochigi.geospatial.jp/2023/rinya/tile/terrainRGB/{z}/{x}/{y}.png',
    format: 'terrain-rgb',
    maxzoom: 18, minzoom: 8,
    bounds: [139.3, 36.1, 140.4, 37.2],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_tochigi" target="_blank">【栃木県】林野庁Terrain-RGBタイル</a>',
  },
  {
    id: 'kanagawa', region: '神奈川県',
    demUrl: 'forestgeo.info/opendata/14_kanagawa/dem_2022/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [138.9, 35.1, 139.8, 35.7],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-kanagawa-maptiles2" target="_blank">【神奈川県】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 北陸 ──────────────────────────────────────────────
  {
    id: 'toyama', region: '富山県',
    demUrl: 'forestgeo.info/opendata/16_toyama/dem_2021/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [136.5, 36.5, 137.8, 36.9],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-toyama-maptiles" target="_blank">【富山県】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 中部（甲信越・東海） ───────────────────────────────
  {
    id: 'yamanashi', region: '山梨県',
    demUrl: 'forestgeo.info/opendata/19_yamanashi/dem_2024/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [138.3, 35.2, 139.1, 35.9],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-nagano-maptiles" target="_blank">【山梨県】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'nagano-inatani', region: '長野県（伊那谷）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_067_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [137.7, 35.5, 138.3, 36.4],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/inatani_067" target="_blank">【長野県（伊那谷）】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'aichi-owari', region: '愛知県（尾張西三河）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_078_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [136.5, 34.8, 137.5, 35.5],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/owarinishimikawa_078" target="_blank">【愛知県（尾張西三河）】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'aichi-higashimikawa', region: '愛知県（東三河）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_079_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [137.3, 34.6, 138.1, 35.3],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/higashimikawa_079" target="_blank">【愛知県（東三河）】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 近畿 ──────────────────────────────────────────────
  {
    id: 'kyoto', region: '京都府',
    demUrl: 'forestgeo.info/opendata/26_kyoto/dem_2024/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [135.0, 34.7, 135.9, 35.8],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_kyoto" target="_blank">【京都府】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'shiga', region: '滋賀県',
    demUrl: 'forestgeo.info/opendata/25_shiga/dem_2023/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [135.7, 34.8, 136.5, 35.7],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-shiga-maptiles" target="_blank">【滋賀県】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'hyogo', region: '兵庫県',
    demUrl: 'tiles.gsj.jp/tiles/elev/hyogodem/{z}/{y}/{x}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [134.2, 34.2, 135.4, 35.7],
    attribution: '<a href="https://tiles.gsj.jp/tiles/elev/tiles.html" target="_blank">【兵庫県】産総研PNG標高タイルを加工して作成</a>',
  },
  // ── 中国 ──────────────────────────────────────────────
  {
    id: 'tottori', region: '鳥取県',
    demUrl: 'rinya-tottori.geospatial.jp/tile/rinya/2024/gridPNG_tottori/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [133.2, 35.0, 134.6, 35.6],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_tottori" target="_blank">【鳥取県】鳥取県作成</a>',
  },
  {
    id: 'okayama', region: '岡山県',
    demUrl: 'forestgeo.info/opendata/33_okayama/dem_2024/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [133.2, 34.4, 134.7, 35.2],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-okayama-maptiles" target="_blank">【岡山県】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 四国 ──────────────────────────────────────────────
  {
    id: 'tokushima-yoshinogawa', region: '徳島県（吉野川）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_116_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [133.8, 33.8, 134.7, 34.3],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/yoshinokawa_116" target="_blank">【徳島県（吉野川）】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'tokushima', region: '徳島県（那賀・海部川）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_117_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [133.7, 33.7, 134.9, 34.4],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/tokushima_aerial_laser" target="_blank">【徳島県（那賀・海部川）】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'ehime', region: '愛媛県',
    demUrl: 'forestgeo.info/opendata/38_ehime/dem_2019/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [132.0, 33.0, 133.7, 34.3],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-ehime-maptiles" target="_blank">【愛媛県】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'kochi', region: '高知県',
    demUrl: 'rinya-kochi.geospatial.jp/2023/rinya/tile/terrainRGB/{z}/{x}/{y}.png',
    format: 'terrain-rgb',
    maxzoom: 18, minzoom: 8,
    bounds: [132.4, 32.7, 134.4, 34.1],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/dem05_kochi" target="_blank">【高知県】林野庁Terrain-RGBタイル</a>',
  },
  // ── 九州 ──────────────────────────────────────────────
  {
    id: 'nagasaki', region: '長崎県',
    demUrl: 'forestgeo.info/opendata/42_nagasaki/dem_2022/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [129.2, 32.5, 130.3, 34.0],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/rinya-nagasaki-maptiles" target="_blank">【長崎県】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'oita-south', region: '大分県（大分南部）',
    demUrl: 'rinya-tiles.geospatial.jp/dem_143_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [131.0, 32.8, 131.8, 33.5],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/oita_aerial_laser" target="_blank">【大分県（大分南部）】林野庁PNG標高タイルを加工して作成</a>',
  },
  // ── 広域・災害復旧 ─────────────────────────────────────
  {
    id: 'r0207flood', region: '令和2年7月豪雨',
    demUrl: 'rinya-tiles.geospatial.jp/dem_r0207tr_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [130.3, 32.1, 131.3, 32.8],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/r2_7_gouu" target="_blank">【令和2年7月豪雨】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'h3007flood', region: '平成30年7月豪雨',
    demUrl: 'rinya-tiles.geospatial.jp/dem_h3007tr_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [132.0, 34.0, 134.5, 35.0],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/h30_7_gouu" target="_blank">【平成30年7月豪雨】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'h28kumamoto', region: '平成28年熊本地震',
    demUrl: 'rinya-tiles.geospatial.jp/dem_h28eq_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [130.6, 32.6, 131.2, 33.0],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/h28_kumamoto_earthquake_aerial_laser" target="_blank">【平成28年熊本地震】林野庁PNG標高タイルを加工して作成</a>',
  },
  {
    id: 'r06noto', region: '令和6年能登半島地震',
    demUrl: 'rinya-tiles.geospatial.jp/dem_r06eq_2025/{z}/{x}/{y}.png',
    maxzoom: 18, minzoom: 8,
    bounds: [136.7, 37.0, 137.5, 37.8],
    attribution: '<a href="https://www.geospatial.jp/ckan/dataset/r6_noto-peninsula-earthquake" target="_blank">【令和6年能登半島地震】林野庁PNG標高タイルを加工して作成</a>',
  },
];

// REGIONAL_DEM_SOURCES からオーバーレイ種別ごとのレイヤー設定を生成するヘルパー
// protocol  : 'dem2cs://' / 'dem2rrim://' など
// prefix    : sourceId・layerId の先頭に付く文字列（例: 'cs-', 'rrim-'）
// labelType : label に使うオーバーレイ名（例: 'CS立体図', '赤色立体図'）
// queryStr  : タイルURLに付加するクエリ文字列（省略可・'min=0&max=500' など）
// ※ format: 'terrain-rgb' のエントリは dem2cs:// 等が未対応のため自動除外する
function _makeOverlayLayers(sources, protocol, prefix, labelType, queryStr = '') {
  return sources
    .filter(s => !s.format)
    .map(s => ({
      sourceId:    `${prefix}${s.id}`,
      layerId:     `${prefix}${s.id}-layer`,
      tileUrl:     `${protocol}${s.demUrl}${queryStr ? '?' + queryStr : ''}`,
      label:       `${labelType}（0.5m）— ${s.region}`,
      maxzoom:     s.maxzoom,
      minzoom:     s.minzoom,
      bounds:      s.bounds,
      attribution: s.attribution,
    }));
}

// ★ デバイスごとの物理PPI定義（実寸縮尺計算に使用）階層構造
// 標準モニターのCSS仮定値は96だが、高解像度モニターでは実際の物理PPIで補正が必要。
export const DEVICE_PPI_DATA = [
  {
    category: 'Apple Mac / iPad',
    devices: [
      { name: 'MacBook Air (M1/M2/M3)',          ppi: 224 },
      { name: 'MacBook Pro 14 / 16インチ',        ppi: 254 },
      { name: 'iMac 24インチ',                    ppi: 218 },
      { name: 'iPad Pro / iPad Air',              ppi: 264 },
    ],
  },
  {
    category: 'Microsoft Surface',
    devices: [
      { name: 'Surface Laptop（ノート型）',        ppi: 201 },
      { name: 'Surface Pro（キーボード分離型）',   ppi: 267 },
      { name: 'Surface Go（小型）',               ppi: 220 },
    ],
  },
  {
    category: 'Windows ノートPC',
    devices: [
      { name: '13〜14インチ（持ち運び向け）',      ppi: 166 },
      { name: '15〜16インチ（大画面・テンキー付）', ppi: 141 },
      { name: '高解像度モデル（4K画質）',           ppi: 282 },
    ],
  },
  {
    category: '外付けモニター',
    devices: [
      { name: '24インチ フルHD（標準的）',          ppi: 96  },
      { name: '27インチ フルHD',                   ppi: 82  },
      { name: '27インチ 4K（高精細）',              ppi: 163 },
    ],
  },
  {
    category: 'スマートフォン',
    devices: [
      { name: 'iPhone（標準 / Pro）',              ppi: 460 },
      { name: 'Android スマホ（一般的）',           ppi: 420 },
      { name: 'Android スマホ（大型 Ultra 等）',   ppi: 500 },
    ],
  },
];
export const DEFAULT_DEVICE_PPI = 96;

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

// ★ 地図アニメーション・UI レイアウト
export const EASE_DURATION          = 600;  // 標準カメラアニメーション時間（ms）
export const FIT_BOUNDS_PAD         = 60;   // fitBounds の標準パディング（px）
export const FIT_BOUNDS_PAD_SIDEBAR = 30;   // サイドバーがある場合の左側追加パディング（px）
export const SIDEBAR_DEFAULT_WIDTH  = 300;  // サイドバーの offsetWidth フォールバック値（px）

// REGIONAL_DEM_SOURCES から派生したオーバーレイレイヤー定義
// app.js はこれらを参照する（CS立体図・赤色立体図）
export const REGIONAL_CS_LAYERS     = _makeOverlayLayers(REGIONAL_DEM_SOURCES, 'dem2cs://',     'cs-',      'CS立体図');
export const REGIONAL_RRIM_LAYERS   = _makeOverlayLayers(REGIONAL_DEM_SOURCES, 'dem2rrim://',   'rrim-',    '赤色立体図');
export const REGIONAL_RELIEF_LAYERS = _makeOverlayLayers(REGIONAL_DEM_SOURCES, 'dem2relief://', 'relief-',  '色別標高図', 'min=0&max=500');
export const REGIONAL_SLOPE_LAYERS  = _makeOverlayLayers(REGIONAL_DEM_SOURCES, 'dem2slope://',  'slope-r-', '傾斜量図',   'min=0&max=45');
export const REGIONAL_CURVE_LAYERS  = _makeOverlayLayers(REGIONAL_DEM_SOURCES, 'dem2curve://',  'curve-r-', '色別曲率図', 'min=-0.25&max=0.25');

// ★ KMZオーバーレイの初期不透明度
export const OMAP_INITIAL_OPACITY = 1.0;

// ★ CS立体図の初期不透明度（仕様書: 乗算代替として0.6推奨）
export const CS_INITIAL_OPACITY = 0.6;

// ベースマップ定義（url/maxzoom があるものはラスタータイル、ないものはベクター）
// setStyle() を使わず visibility 切替で実現するため、load 時に全ソース/レイヤーを追加しておく。
// ベースマップ定義（ラスター / ベクター共通）
// bgColor: タイル未読込時に表示する背景色（省略時 #ffffff）
export const BASEMAPS = {
  'orilibre':  { attr: '<a href="https://github.com/tjmsy/orilibre" target="_blank">OriLibre</a>' },
  'gsi-std':   { url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',           maxzoom: 18,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-pale':  { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',          maxzoom: 18,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-blank': { url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png',         maxzoom: 14,
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'gsi-photo': { url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxzoom: 18,
                 bgColor: '#ffffff',
                 attr: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>' },
  'osm':       { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',                     maxzoom: 19,
                 bgColor: '#add19e',
                 attr: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors' },
};

/* ================================================================
   localMapLoader.js — KMZ / 画像+JGW の読み込みと地図追加
   ================================================================ */

import { addLocalMapLayer }   from '../store/localMapStore.js';
import { saveMapLayer }       from '../api/mapImageDb.js';
import { emit }               from '../store/eventBus.js';
import {
  SIDEBAR_DEFAULT_WIDTH, FIT_BOUNDS_PAD, FIT_BOUNDS_PAD_SIDEBAR,
  EASE_DURATION, INITIAL_PITCH,
} from './config.js';

let _map = null;

export function init(map) {
  _map = map;
}

// ---- KMZ 読み込み ----
export async function loadKmz(file) {
  try {
    /*
      --- ステップ① JSZip で KMZ（ZIP）を解凍する ---
      file.arrayBuffer() でファイルの中身をバイト列として読み込み、
      JSZip.loadAsync() に渡すことで ZIP の中身を展開します。
      zip.files はファイルパスをキー、ZipObject を値とするオブジェクトです。
    */
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // ZIP 内のすべてのファイルパスを配列にまとめる
    const fileNames = Object.keys(zip.files);

    /*
      --- ステップ② KML ファイルを特定する ---
      KMZ の中には通常 "doc.kml" という名前で KML が入っています。
      ただし名前が異なる場合もあるため、拡張子 .kml で検索します。
    */
    const kmlFileName = fileNames.find(name => name.toLowerCase().endsWith('.kml'));

    if (!kmlFileName) {
      alert('エラー：KMZファイルの中にKMLファイルが見つかりませんでした。\nファイルが正しい形式かどうかを確認してください。');
      return;
    }

    // KML ファイルの内容をテキスト（文字列）として取得する
    const kmlText = await zip.files[kmlFileName].async('text');

    /*
      --- ステップ③ KML を XML として解析（パース）する ---
      DOMParser は HTML や XML をブラウザのDOM構造に変換する標準APIです。
      これにより、XML のタグ名で要素を検索できるようになります。
    */
    const parser = new DOMParser();
    const kmlDom = parser.parseFromString(kmlText, 'text/xml');

    // XML パース失敗時は parseerror 要素が返るため先に確認する
    if (kmlDom.getElementsByTagName('parsererror').length > 0) {
      alert('エラー：KMLファイルのXML解析に失敗しました。\nファイルが壊れているか、文字コードが対応していない可能性があります。');
      return;
    }

    /*
      --- ステップ④ GroundOverlay タグを探す ---
      GroundOverlay は KML の「画像を地図上の指定範囲に貼り付ける」要素です。
      オリエンテーリングマップの KMZ では通常ここにマップ画像の情報が入っています。
    */
    // getElementsByTagNameNS('*', tag) は名前空間を問わずローカル名で検索するため
    // xmlns="http://www.opengis.net/kml/2.2" 付き KML でも確実に動作する。
    const kmlGet = (root, tag) => root.getElementsByTagNameNS('*', tag)[0]
      ?? root.getElementsByTagName(tag)[0];

    const groundOverlay = kmlGet(kmlDom, 'GroundOverlay');

    if (!groundOverlay) {
      alert('エラー：KMLファイルの中にGroundOverlay要素が見つかりませんでした。\nこのKMZはオーバーレイ画像を含んでいない可能性があります。');
      return;
    }

    /*
      --- ステップ⑤ LatLonBox から座標情報を取り出す ---
      LatLonBox は画像を貼り付ける矩形の緯度経度範囲と回転角を定義します。
      各タグの textContent を数値に変換して取得します。
    */
    const latLonBox = kmlGet(groundOverlay, 'LatLonBox');

    if (!latLonBox) {
      alert('エラー：GroundOverlay の中に LatLonBox 要素が見つかりませんでした。');
      return;
    }

    // テキストで書かれた緯度経度を数値に変換する
    const north = parseFloat(kmlGet(latLonBox, 'north')?.textContent);
    const south = parseFloat(kmlGet(latLonBox, 'south')?.textContent);
    const east  = parseFloat(kmlGet(latLonBox, 'east')?.textContent);
    const west  = parseFloat(kmlGet(latLonBox, 'west')?.textContent);
    // rotation は省略されることもあるので、ない場合は 0 とする
    const rotation = parseFloat(kmlGet(latLonBox, 'rotation')?.textContent ?? '0');

    if (isNaN(north) || isNaN(south) || isNaN(east) || isNaN(west)) {
      alert('エラー：LatLonBox の座標値が正しく読み取れませんでした。');
      return;
    }

    /*
      --- ステップ⑥ MapLibre の coordinates 配列を計算する ---

      MapLibre の image source の coordinates は以下の順番で4点を指定します：
        [ 左上(TL), 右上(TR), 右下(BR), 左下(BL) ]
        = [ [西,北], [東,北], [東,南], [西,南] ]
      （※ 経度が先、緯度が後 = [lng, lat] の順）

      KML の LatLonBox には rotation（反時計回り、単位:度）が含まれる場合があります。
      rotation が 0 でない場合、単純に north/south/east/west を組み合わせるだけでは
      画像が傾いた状態で正しく配置されません。

      そのため、矩形の中心を基準に各コーナーを回転させて計算します。
    */

    // 矩形の中心座標（経度・緯度）
    const cx = (east + west) / 2;
    const cy = (north + south) / 2;

    // 中心から各コーナーまでの幅・高さの半分
    const hw = (east - west) / 2; // 水平方向の半幅
    const hh = (north - south) / 2; // 垂直方向の半高さ

    // KML の rotation は反時計回りなので、sin/cos に渡す角度は正の方向が反時計回り
    const rad = rotation * Math.PI / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // ★追加: 地球の丸みによる経度の縮み（アスペクト比）を中心緯度から計算
    const latCos = Math.cos(cy * Math.PI / 180);

    /*
      回転変換の式：
      経緯度の長さの違いを補正して回転させないと、画像が歪んで角度がズレるため
      一旦スケールを合わせて回転させ、その後経度を元に戻します。
    */
    function rotateCorner(dx, dy) {
      // 経度方向の差分を、緯度方向と同じスケール比率に合わせる
      const dxScaled = dx * latCos;
      
      // スケールを合わせた状態で回転計算
      const rxScaled = dxScaled * cosR - dy * sinR;
      const ry = dxScaled * sinR + dy * cosR;
      
      // 経度を元の度単位のスケールに戻して足し合わせる
      return [
        cx + (rxScaled / latCos), // 回転後の経度
        cy + ry                   // 回転後の緯度
      ];
    }

    // MapLibre の coordinates 配列（TL → TR → BR → BL の順）
    const coordinates = [rotateCorner(-hw, +hh),
    // 左上（TL）
    rotateCorner(+hw, +hh),
    // 右上（TR）
    rotateCorner(+hw, -hh),
    // 右下（BR）
    rotateCorner(-hw, -hh),
      // 左下（BL）
    ];

    /*
      --- ステップ⑦ KML 内の画像ファイルを特定して ObjectURL を生成する ---
      GroundOverlay > Icon > href タグに画像ファイルのパスが書かれています。
      そのファイルを ZIP から取り出し、Blob → ObjectURL に変換します。
    */
    const iconEl = kmlGet(groundOverlay, 'Icon');
    const iconHref = iconEl ? kmlGet(iconEl, 'href')?.textContent?.trim() : undefined;

    if (!iconHref) {
      alert('エラー：GroundOverlay に Icon/href が見つかりませんでした。');
      return;
    }

    // ZIP 内でのファイルパスを検索（階層付きパスに対応）
    const imgEntry = zip.files[iconHref] ?? zip.files[fileNames.find(n => n.endsWith('/' + iconHref) || n === iconHref)];

    if (!imgEntry) {
      alert(`エラー：KMZ内に画像ファイル "${iconHref}" が見つかりませんでした。`);
      return;
    }

    // 画像をバイナリとして取り出し、Blob に変換する
    const imgBlob = await imgEntry.async('blob');

    /*
      --- ステップ⑧ MapLibre にソースとレイヤーを追加する（addLocalMapLayer ヘルパー）---
      レイヤー生成・配置・localMapLayers 登録を共通ヘルパーに委譲する。
    */
    const entry = addLocalMapLayer(imgBlob, coordinates, file.name, {
      terrainId:   null,
      terrainName: null,
    });

    // --- ステップ⑨ 地図全体が収まる範囲にフィット ---
    const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
    _map.fitBounds(
      [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
      {
        padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                   left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
        pitch: INITIAL_PITCH,
        duration: EASE_DURATION,
        maxZoom: 19,
      }
    );
    // fitBounds 後も画像が最前面になるよう moveLayer
    _map.moveLayer(entry.layerId);

    // IndexedDB に非同期保存（失敗しても動作継続）
    saveMapLayer({ type: 'kmz', name: file.name, imageBlob: imgBlob,
                   coordinates, opacity: entry.opacity, visible: true,
                   terrainId:   entry.terrainId,
                   terrainName: entry.terrainName })
      .then(dbId => { entry.dbId = dbId; emit('localmap:changed'); })
      .catch(e => console.warn('KMZ の DB 保存に失敗:', e));

    // UIの一覧を更新する
    emit('localmap:changed');

    console.log(`KMZ 読み込み完了: ${file.name}`, { coordinates, rotation });

  }

  catch (err) {
    console.error('KMZ読み込みエラー:', err);

    alert(`KMZファイルの読み込み中にエラーが発生しました。\n詳細: ${err.message}`);
  }
}


/* =====================================================================
   画像（JPG/PNG）＋ JGW ワールドファイル 読み込み
   ===================================================================== */

// ---- JGD2011 平面直角座標系 全19系の原点パラメータ ----
// 各要素: [緯度原点(°), 経度原点(°)]
// インデックス 0 は未使用（系番号は 1 始まり）
const JGD2011_ZONE_PARAMS = [
  null,
  [33,   129.5             ],  // 第1系  長崎・鹿児島南部
  [33,   131               ],  // 第2系  福岡・佐賀・熊本・大分・宮崎・鹿児島北部
  [36,   132.16666666667   ],  // 第3系  山口・島根・広島
  [33,   133.5             ],  // 第4系  香川・愛媛・徳島・高知
  [36,   134.33333333333   ],  // 第5系  兵庫・鳥取・岡山
  [36,   136               ],  // 第6系  京都・大阪・福井・滋賀・三重・奈良・和歌山
  [36,   137.16666666667   ],  // 第7系  石川・富山・岐阜・愛知
  [36,   138.5             ],  // 第8系  新潟・長野・山梨・静岡
  [36,   139.83333333333   ],  // 第9系  東京・福島・栃木・茨城・埼玉・千葉・神奈川
  [40,   140.83333333333   ],  // 第10系 青森・秋田・山形・岩手・宮城
  [44,   140.25            ],  // 第11系 北海道（小樽・旭川・帯広・釧路方面）
  [44,   142.25            ],  // 第12系 北海道（札幌・函館方面）
  [44,   144.25            ],  // 第13系 北海道（網走・北見・紋別方面）
  [26,   142               ],  // 第14系 小笠原諸島
  [26,   127.5             ],  // 第15系 沖縄本島
  [26,   124               ],  // 第16系 石垣島・西表島
  [26,   131               ],  // 第17系 大東島
  [20,   136               ],  // 第18系 沖ノ鳥島
  [26,   154               ],  // 第19系 南鳥島
];

// JGD2011 第n系の proj4 文字列を返す
function getJgd2011Proj4(zone) {
  const [lat0, lon0] = JGD2011_ZONE_PARAMS[zone];
  // GRS80 楕円体、中央経線係数 0.9999、原点 (lat0, lon0)、フォールスイースティング/ノーシング = 0
  return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
}

// ---- JGW（World File）の6行テキストを解析 ----
function parseJgw(text) {
  // 行1: A — x 方向のピクセルサイズ（東向き正、度 or メートル/ピクセル）
  // 行2: D — y 軸周りの回転（通常 0）
  // 行3: B — x 軸周りの回転（通常 0）
  // 行4: E — y 方向のピクセルサイズ（南向き負）
  // 行5: C — 左上ピクセル中心の x 座標（経度 or 東距 [m]）
  // 行6: F — 左上ピクセル中心の y 座標（緯度 or 北距 [m]）
  const vals = text.trim().split(/\r?\n/).map(l => parseFloat(l.trim()));
  if (vals.length < 6 || vals.some(isNaN)) return null;
  return { A: vals[0], D: vals[1], B: vals[2], E: vals[3], C: vals[4], F: vals[5] };
}

// ---- 画像 + JGW を MapLibre に追加 ----
// ---- 画像+JGW 読み込み ----
export async function loadImageWithJgw(imageFile, jgwText, crsValue) {
  // ① 画像サイズ（W×H）を取得するために一時 ObjectURL を使う
  //    後で addLocalMapLayer が改めて ObjectURL を生成するため、ここでは revoke する
  const _tmpUrl = URL.createObjectURL(imageFile);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload  = () => resolve(i);
    i.onerror = () => { URL.revokeObjectURL(_tmpUrl); reject(new Error('画像の読み込みに失敗しました')); };
    i.src = _tmpUrl;
  });
  URL.revokeObjectURL(_tmpUrl);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // ② JGW を解析する
  const jgw = parseJgw(jgwText);
  if (!jgw) {
    URL.revokeObjectURL(objectUrl);
    throw new Error('JGWファイルの解析に失敗しました（数値6行が必要です）');
  }

  // ③ アフィン変換で4コーナーの CRS 座標を計算する
  // x = A*col + B*row + C,  y = D*col + E*row + F
  const corner = (col, row) => [
    jgw.A * col + jgw.B * row + jgw.C,  // x（東距 or 経度）
    jgw.D * col + jgw.E * row + jgw.F,  // y（北距 or 緯度）
  ];
  const cornersXY = [
    corner(0,     0    ),  // TL（左上）
    corner(W - 1, 0    ),  // TR（右上）
    corner(W - 1, H - 1),  // BR（右下）
    corner(0,     H - 1),  // BL（左下）
  ];

  // ④ CRS → WGS84（緯度経度）に変換する
  let coordinates;
  if (crsValue === 'wgs84') {
    // WGS84 の場合はそのまま [lng, lat] として使用する
    coordinates = cornersXY;
  } else {
    // JGD2011 平面直角座標系 → WGS84 変換
    const zone    = parseInt(crsValue.replace('jgd', ''), 10);
    const fromCRS = getJgd2011Proj4(zone);
    const toCRS   = '+proj=longlat +datum=WGS84 +no_defs';
    // proj4(fromCRS, toCRS, [easting, northing]) → [lng, lat]
    coordinates = cornersXY.map(([x, y]) => proj4(fromCRS, toCRS, [x, y]));
  }

  // ⑤ addLocalMapLayer で MapLibre への追加・localMapLayers 登録を行う
  //    imageFile は File オブジェクトなので Blob として直接渡せる
  const entry = addLocalMapLayer(imageFile, coordinates, imageFile.name, {
    terrainId:   null,
    terrainName: null,
  });

  // ⑥ UI を更新する
  emit('localmap:changed');

  // ⑦ 追加した画像の範囲にカメラをフィットさせる
  const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? SIDEBAR_DEFAULT_WIDTH;
  _map.fitBounds(
    [[entry.bbox.west, entry.bbox.south], [entry.bbox.east, entry.bbox.north]],
    { padding: { top: FIT_BOUNDS_PAD, bottom: FIT_BOUNDS_PAD,
                 left: panelWidth + FIT_BOUNDS_PAD_SIDEBAR, right: FIT_BOUNDS_PAD },
      pitch: INITIAL_PITCH, duration: EASE_DURATION, maxZoom: 19 }
  );

  // IndexedDB に非同期保存
  saveMapLayer({ type: 'image-jgw', name: imageFile.name, imageBlob: imageFile,
                 coordinates, opacity: entry.opacity, visible: true,
                 terrainId:   entry.terrainId,
                 terrainName: entry.terrainName })
    .then(dbId => { entry.dbId = dbId; emit('localmap:changed'); })
    .catch(e => console.warn('画像+JGW の DB 保存に失敗:', e));

  console.log(`画像+JGW 読み込み完了: ${imageFile.name}`, { crsValue, coordinates });
}

/* ================================================================
   protocols.js — カスタムプロトコル登録（pmtiles / gsjdem / csdem）
   MapLibre の addProtocol() でブラウザ内 DEM 変換を実現します
   ================================================================ */

import { QCHIZU_DEM_BASE, DEM5A_BASE, LAKEDEPTH_BASE, LAKEDEPTH_STANDARD_BASE, LAND_DEM_BASE } from './config.js';

// ================================================================
// 共通フォールバック: 1×1 透明 PNG の ArrayBuffer
// プロトコルハンドラが undefined・null・例外を返すと MapLibre の WebGL
// テクスチャバインドがクラッシュするため、全プロトコルでこれを使う。
// ================================================================
const _TRANSPARENT_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function _transparentPngBuffer() {
  const bin = atob(_TRANSPARENT_PNG_B64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/*
  ========================================================
  PMTiles プロトコルの登録（将来の自前データ配信に備えて）
  maplibregl.addProtocol() で "pmtiles://" スキームを使えるようにします。
  将来、source の url を "pmtiles://https://..." に変えるだけで
  Cloudflare R2 上の PMTiles ファイルを読み込めるようになります。
  ========================================================
*/
const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile.bind(pmtilesProtocol));


/*
  ========================================================
  DEM 合成ユーティリティ（Q地図 > DEM5A > 湖水深）
  優先度:
    1. Q地図 DEM（1m、最高品質）
    2. 基盤地図情報数値PNGタイル DEM5A（5m、陸域全域）
    3. 湖水深タイル（湖底地形。深さ値を符号反転して湖底標高として使用）
  全タイル共通の国土地理院 NumPNG 形式（R=high, G=mid, B=low, nodata=R128,G0,B0）。
  ========================================================
*/

// regionalDemBase: 地域DEMのベースURL（csdem://地域層の場合のみ指定）
// regionalDemExt : 地域DEMの拡張子（'png' または 'webp'）
// demMode: null/'composite'（全ソース合成）, 'q1m'（Q地図のみ）, 'dem5a'（DEM5Aのみ）
// 地形(gsjdem://)は null で全合成。等高線は DEMソース選択に従い排他使用。
async function fetchCompositeDemBitmap(z, x, y, signal, regionalDemBase = null, regionalDemExt = 'png', demMode = null) {
  const useQ    = demMode !== 'dem5a'; // Q地図 + 地域DEM を使う（null/'q1m'/composite いずれも true）
  // ── 5mDEM（DEM5A）旧コード: 陸域統合DEM に差し替えのためコメントアウト ──────────────────
  // const useS = demMode === 'dem5a' || !demMode; // DEM5A を使う（dem5a または full composite）
  // const sUrl = useS ? `${DEM5A_BASE}/${z}/${x}/${y}.png` : null;
  // ── 陸域統合DEM（産総研）: 5mDEM の代替。URL は {z}/{y}/{x} 順（y・x 逆転） ───────────
  const useS    = demMode === 'dem5a'; // DEM5A は等高線等の明示指定時のみ（現在は dead code）
  const useLand = !demMode;            // 陸域統合DEM は地形合成（demMode=null）時のみ
  const sUrl    = useS ? `${DEM5A_BASE}/${z}/${x}/${y}.png` : null;
  const landUrl = useLand ? `${LAND_DEM_BASE}/${z}/${y}/${x}.png` : null; // y・x 逆順

  const qUrl  = useQ ? `${QCHIZU_DEM_BASE}/${z}/${x}/${y}.webp` : null;
  const lUrl  = `${LAKEDEPTH_BASE}/${z}/${x}/${y}.png`;
  const lsUrl = `${LAKEDEPTH_STANDARD_BASE}/${z}/${x}/${y}.png`;
  const rUrl  = (useQ && regionalDemBase) ? `${regionalDemBase}/${z}/${x}/${y}.${regionalDemExt}` : null;

  async function toImageData(url) {
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) return null;
      const bm = await createImageBitmap(await r.blob());
      const cv = new OffscreenCanvas(bm.width, bm.height);
      cv.getContext('2d').drawImage(bm, 0, 0);
      bm.close();
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    } catch { return null; }
  }

  const [qData, sData, landData, lData, lsData, rData] = await Promise.all([
    qUrl    ? toImageData(qUrl)    : Promise.resolve(null),
    sUrl    ? toImageData(sUrl)    : Promise.resolve(null),
    landUrl ? toImageData(landUrl) : Promise.resolve(null),
    toImageData(lUrl), toImageData(lsUrl),
    rUrl    ? toImageData(rUrl)    : Promise.resolve(null),
  ]);
  if (!qData && !sData && !landData && !lData && !rData) return null;

  function isNodata(d, i) {
    return (d[i] === 128 && d[i + 1] === 0 && d[i + 2] === 0) || d[i + 3] !== 255;
  }

  // 合成先を全 nodata で初期化し、低優先度から順に上書き
  const { width, height: h } = (qData ?? sData ?? landData ?? lData ?? rData);
  const cv  = new OffscreenCanvas(width, h);
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(width, h);
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) { o[i] = 128; o[i + 3] = 255; } // all nodata

  // 優先度 最低: 湖水深（基準水面標高 - 湖水深 → 実際の湖底標高へ変換）
  // 湖底標高(m) = 基準水面標高(m) - 湖水深(m)
  // NumPNG単位(0.01m): actual_int = stdSigned - depth
  if (lData && lsData) {
    const l = lData.data, ls = lsData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(l, i) || isNodata(ls, i)) continue;
      const depth     = (l[i]  << 16) | (l[i + 1]  << 8) | l[i + 2];  // 湖水深 (正値, 0.01m単位)
      const stdRaw    = (ls[i] << 16) | (ls[i + 1] << 8) | ls[i + 2]; // 基準水面標高 (24bit符号なし)
      const stdSigned = stdRaw >= 0x800000 ? stdRaw - 0x1000000 : stdRaw; // 符号付きに変換
      let actual = stdSigned - depth;                                    // 湖底標高 (0.01m単位)
      if (actual < 0) actual += 0x1000000;
      actual &= 0xFFFFFF;
      o[i] = (actual >> 16) & 0xFF; o[i + 1] = (actual >> 8) & 0xFF; o[i + 2] = actual & 0xFF; o[i + 3] = 255;
    }
  }

  // 優先度 中低: DEM5A（demMode='dem5a' 明示時のみ。通常は dead code）
  if (sData) {
    const s = sData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(s, i)) continue;
      o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 中: 陸域統合DEM（5mDEM の代替。産総研提供）
  if (landData) {
    const land = landData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(land, i)) continue;
      o[i] = land[i]; o[i + 1] = land[i + 1]; o[i + 2] = land[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 高: Q地図 DEM
  if (qData) {
    const q = qData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(q, i)) continue;
      o[i] = q[i]; o[i + 1] = q[i + 1]; o[i + 2] = q[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 最高: 地域DEM（0.5m）― csdem://地域層からのみ利用
  if (rData) {
    const r = rData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(r, i)) continue;
      o[i] = r[i]; o[i + 1] = r[i + 1]; o[i + 2] = r[i + 2]; o[i + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return createImageBitmap(cv);
}


/*
  ========================================================
  NumPNG → Terrarium 変換プロトコル (gsjdem://)
  fetchCompositeDemBitmap で Q地図 > DEM5A > 湖水深 の優先順に合成した
  NumPNG ビットマップを MapLibre が理解できる Terrarium 形式に変換して渡す。
  CS立体図・3D地形・gsjdem ベースのレイヤーすべてがこのプロトコルを経由する。
  ========================================================
*/
maplibregl.addProtocol('gsjdem', async (params, abortController) => {
  try {
  // MapLibre が {z}/{x}/{y} を展開済みの URL から z/x/y を取り出す（?t= キャッシュバスト対応のため $ なし）
  const m = params.url.match(/\/(\d+)\/(\d+)\/(\d+)\.\w+/);
  if (!m) return { data: _transparentPngBuffer() };
  const [, z, x, y] = m;

  // 地形は常に全ソース合成（Q地図+DEM5A+湖水深）で滑らかに描画。DEMソース選択には連動しない。
  const bitmap = await fetchCompositeDemBitmap(z, x, y, abortController.signal);
  if (!bitmap) return { data: _transparentPngBuffer() };

  // NumPNG → Terrarium 変換
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if ((r === 128 && g === 0 && b === 0) || a !== 255) {
      // nodata → Terrarium 0m（前の設定に戻す）。透明にすると境界での補間アーティファクトが出るため。
      data[i] = 128; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
      continue;
    }
    const bits24 = (r << 16) | (g << 8) | b;
    const height = ((bits24 << 8) >> 8) * 0.01;
    const t = height + 32768;
    data[i]     = Math.min(255, Math.max(0, Math.floor(t / 256)));
    data[i + 1] = Math.min(255, Math.max(0, Math.floor(t % 256)));
    data[i + 2] = Math.min(255, Math.max(0, Math.floor((t % 1) * 256)));
    data[i + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { data: await blob.arrayBuffer() };
  } catch { return { data: _transparentPngBuffer() }; }
});




/*
  ========================================================
  CS立体図をDEMタイルからブラウザ内で動的生成するプロトコル
  qchizu-project/qchizu-maps-maplibregljs の実装を参考に最適化
  https://github.com/qchizu-project/qchizu-maps-maplibregljs/blob/main/src/protocols/dem2CsProtocol.js

  最適化ポイント（Q地図実装より）:
    1. ガウシアンカーネルを kernelRadius 単位でキャッシュ（タイルごとの再計算を排除）
    2. ガウシアン平滑化フェーズ（手動dispose）と合成フェーズ（tf.tidy）を分離
    3. await tensor.data() で GPU→CPU 転送を非同期化（メインスレッドのブロックを回避）
    4. 9タイル全て並列fetch（中央タイルの先行fetch を廃止して待機ゼロ化）
    5. tf.where(condition, x, y) を正しい API で使用
    6. tf.browser.toPixels(tensor, canvas) でキャンバスに直接書き込み（中間配列不要）
  ========================================================
*/

// ガウシアンカーネルキャッシュ: kernelRadius → tf.Tensor4D (kept, [kH,kW,1,1])
// 同一ズームレベルでは kernelRadius がほぼ一定なので大幅に再計算を削減できる。
const _csKernelCache = new Map();
function _getCsKernel(kernelRadius, sigma) {
  if (_csKernelCache.has(kernelRadius)) return _csKernelCache.get(kernelRadius);
  const kernelDim = kernelRadius * 2 + 1;
  const kExp = tf.keep(tf.tidy(() => {
    const [kx, ky] = tf.meshgrid(
      tf.linspace(-kernelRadius, kernelRadius, kernelDim),
      tf.linspace(-kernelRadius, kernelRadius, kernelDim)
    );
    return tf.exp(tf.neg(kx.square().add(ky.square()).div(2 * sigma * sigma)))
      .expandDims(2).expandDims(3); // [kH,kW,1,1] — conv2d が要求する形状
  }));
  _csKernelCache.set(kernelRadius, kExp);
  return kExp;
}

// カラーランプ関数（tf.tidy 内で呼び出す）
function _csRamp(min, max, c0, c1, t) {
  const n = t.clipByValue(min, max).sub(min).div(max - min);
  return tf.stack([
    n.mul(c1.r - c0.r).add(c0.r).round(),
    n.mul(c1.g - c0.g).add(c0.g).round(),
    n.mul(c1.b - c0.b).add(c0.b).round(),
  ], -1);
}
function _csRampMid(min, max, c0, c1, c2, t) {
  const n = t.clipByValue(min, max).sub(min).div(max - min);
  const half = n.lessEqual(0.5);
  const r = tf.where(half, n.mul(2).mul(c1.r - c0.r).add(c0.r), n.sub(0.5).mul(2).mul(c2.r - c1.r).add(c1.r)).round();
  const g = tf.where(half, n.mul(2).mul(c1.g - c0.g).add(c0.g), n.sub(0.5).mul(2).mul(c2.g - c1.g).add(c1.g)).round();
  const b = tf.where(half, n.mul(2).mul(c1.b - c0.b).add(c0.b), n.sub(0.5).mul(2).mul(c2.b - c1.b).add(c1.b)).round();
  return tf.stack([r, g, b], -1);
}

maplibregl.addProtocol('csdem', async (params, abortController) => {
  try {
  const url = params.url.replace('csdem://', 'https://');
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/);
  if (!m) return { data: null };
  const zoomLevel = +m[1], tileX = +m[2], tileY = +m[3], ext = m[4];

  // 地域DEM ベースURL の抽出（z/x/y より前のパス部分）
  // 全国CS（QCHIZU_DEM_BASE）か地域DEMかを判定し、地域DEMの場合は優先ソースとして渡す
  const baseUrl = url.replace(/\/\d+\/\d+\/\d+\.\w+$/, '');
  const regionalDemBase = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
  const regionalDemExt  = regionalDemBase ? ext : null;

  // z<=14 は DEM5A（5m・全国・軽量）を使用。Q地図1mは高解像度だが低ズームでは精細さが不要。
  // z>14 は Q地図1m + 陸域統合DEM の全ソース合成（demMode=null）で高品質を優先。
  const demMode = zoomLevel <= 14 ? 'dem5a' : null;

  // ── ① 9タイル全て並列fetch（地域DEM優先 → Q地図 → DEM5A の順で補完） ──
  // 各タイルを fetchCompositeDemBitmap で取得（地域DEM/Q地図優先・nodata はシームレスで補完）
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1], // 0:左上 1:上 2:右上
    [-1,  0], [0,  0], [1,  0], // 3:左   4:中央 5:右
    [-1,  1], [0,  1], [1,  1], // 6:左下 7:下   8:右下
  ];

  const bitmaps = await Promise.all(neighborOffsets.map(([dx, dy]) =>
    fetchCompositeDemBitmap(zoomLevel, tileX + dx, tileY + dy, abortController.signal, regionalDemBase, regionalDemExt, demMode)
  ));
  if (!bitmaps[4]) return { data: _transparentPngBuffer() }; // 中央タイルが取得できなければ透明タイルを返す

  // タイルサイズを中央タイルから動的検出（256px または 512px タイルに対応）
  const tileSize = bitmaps[4].width;

  // ピクセル解像度（m/pixel）― qchizu-project/protocolUtils.calculatePixelResolution
  // py は常に 256px タイル基準の座標系で計算し、pixelLength を (256/tileSize) で補正する
  const L = 85.05112878;
  const py = 256 * tileY + 128; // 256px タイル基準で固定（512px タイルでも地理座標は同一）
  const lat = (180 / Math.PI) * Math.asin(
    Math.tanh((-Math.PI / (1 << (zoomLevel + 7))) * py + Math.atanh(Math.sin(L * Math.PI / 180)))
  );
  const pixelLength = 156543.04 * Math.cos(lat * Math.PI / 180) / (1 << zoomLevel) * (256 / tileSize);

  // NumPNG → 標高（GSJ/Q地図形式, u=0.01m）
  const toHeight = (r, g, b, a) => {
    const x = r * 65536 + g * 256 + b;
    if (a === 0 || x === 8388608) return -99999;
    return x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
  };

  // ガウシアンパラメータ
  const sigma = Math.min(Math.max(3 / pixelLength, 1.6), 7);
  const kernelRadius = Math.ceil(sigma * 3);
  const buffer = kernelRadius + 1;
  const mergedSize = tileSize + buffer * 2;

  // ── ② マージキャンバスに描画 ──
  const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
  const mc = mergedCanvas.getContext('2d');
  bitmaps.forEach((bmp, idx) => {
    if (!bmp) return;
    const col = idx % 3, row = Math.floor(idx / 3);
    let sx, sy, sw, sh, dx, dy;
    if (idx === 4) {
      sx = 0; sy = 0; sw = tileSize; sh = tileSize; dx = buffer; dy = buffer;
    } else {
      sx = col === 0 ? tileSize - buffer : 0;
      sw = col === 1 ? tileSize : buffer;
      dx = col === 2 ? tileSize + buffer : col * buffer;
      sy = row === 0 ? tileSize - buffer : 0;
      sh = row === 1 ? tileSize : buffer;
      dy = row === 2 ? tileSize + buffer : row * buffer;
    }
    mc.drawImage(bmp, sx, sy, sw, sh, dx, dy, sw, sh);
    bmp.close();
  });

  // ── ③ 標高配列生成（Float32Array — Array より高速） ──
  const mergedPx = mc.getImageData(0, 0, mergedSize, mergedSize).data;
  const mergedHeights = new Float32Array(mergedSize * mergedSize);
  for (let i = 0; i < mergedHeights.length; i++) {
    const p = i * 4;
    mergedHeights[i] = toHeight(mergedPx[p], mergedPx[p + 1], mergedPx[p + 2], mergedPx[p + 3]);
  }

  // 中央タイルの無効値マスク — 無効ピクセルを透明にするためのアルファ値
  // mergedHeights の中央領域 (buffer,buffer)〜(buffer+tileSize,buffer+tileSize) を参照
  const centerAlpha = new Float32Array(tileSize * tileSize);
  for (let row = 0; row < tileSize; row++) {
    for (let col = 0; col < tileSize; col++) {
      const mi = (row + buffer) * mergedSize + (col + buffer);
      centerAlpha[row * tileSize + col] = mergedHeights[mi] === -99999 ? 0 : 255;
    }
  }

  // ── ④ ガウシアン平滑化（キャッシュ済みカーネル・手動dispose・非同期転送） ──
  // tf.tidy を使わず手動でdisposeすることで平滑化フェーズのテンソルを早期解放。
  // await tensor.data() で GPU→CPU を非同期化（dataSync() のブロックを回避）。
  const kExp = _getCsKernel(kernelRadius, sigma);
  const hT = tf.tensor2d(mergedHeights, [mergedSize, mergedSize]);
  const valid = hT.notEqual(-99999);
  const masked = tf.where(valid, hT, 0);                  // tf.where(condition, x, y) で正しくマスク
  const kSum = tf.conv2d(
    valid.cast('float32').expandDims(2).expandDims(0), kExp, 1, 'valid'
  ).squeeze([0, 3]);
  const sHRaw = tf.conv2d(
    masked.expandDims(2).expandDims(0), kExp, 1, 'valid'
  ).squeeze([0, 3]).div(kSum);
  const validCrop = valid.slice([buffer, buffer], [tileSize + 2, tileSize + 2]);
  const sH = tf.where(validCrop, sHRaw, tf.fill([tileSize + 2, tileSize + 2], -99999));
  const smoothed = await sH.data(); // 非同期 GPU→CPU 転送（メインスレッドをブロックしない）
  [masked, kSum, sHRaw, validCrop, sH].forEach(t => t.dispose());

  // ── ⑤ JS ループ: 傾斜・曲率計算 ──
  const curvatures = new Float32Array(tileSize * tileSize);
  const slopes = new Float32Array(tileSize * tileSize);
  const sw2 = tileSize + 2;
  for (let row = 0; row < tileSize; row++) {
    for (let col = 0; col < tileSize; col++) {
      const oi = row * tileSize + col;
      const mi = (row + buffer) * mergedSize + (col + buffer);
      const H00 = mergedHeights[mi], H01 = mergedHeights[mi + 1], H10 = mergedHeights[mi + mergedSize];
      const ddx = H00 - H01, ddy = H00 - H10;
      slopes[oi] = Math.atan(Math.sqrt(ddx * ddx + ddy * ddy) / pixelLength) * (180 / Math.PI);
      const si = (row + 1) * sw2 + (col + 1);
      const z2 = smoothed[si - sw2], z4 = smoothed[si - 1], z5 = smoothed[si],
            z6 = smoothed[si + 1],   z8 = smoothed[si + sw2];
      const cellArea = pixelLength * pixelLength;
      curvatures[oi] = H00 === -99999 ? -1
        : -2 * (((z4 + z6) / 2 - z5) / cellArea + ((z2 + z8) / 2 - z5) / cellArea);
    }
  }

  // ── ⑥ CS立体図 5レイヤー合成（tf.tidy で中間テンソルを自動解放） ──
  // 曲率は 1/pixelLength² に比例するため、ramp の感度を pixelLength^2 でスケール
  // 基準: pixelLength=0.489m (地域0.5m DEM z18) で cc=1.1 → K = 1.1 * 0.489² ≈ 0.263
  const cc = pixelLength < 68
    ? Math.max(0.263 / (pixelLength * pixelLength), 0.1)
    : 0.188 * Math.pow(pixelLength, 1.232);

  const csRittaizuTensor = tf.tidy(() => {
    const hCrop = hT.slice([buffer, buffer], [tileSize, tileSize]);
    const cT = tf.tensor1d(curvatures).reshape([tileSize, tileSize]);
    const sT = tf.tensor1d(slopes).reshape([tileSize, tileSize]);
    const blend    = (a, b, alpha) => a.mul(1 - alpha).add(b.mul(alpha));
    const mulBlend = (a, b) => a.mul(b.div(255));
    const L1 = _csRamp(0, 3000, { r: 100, g: 100, b: 100 }, { r: 255, g: 255, b: 255 }, hCrop);
    const L2 = _csRamp(-0.25/cc, 0.05/cc, { r: 42, g: 92, b: 170 }, { r: 255, g: 255, b: 255 }, cT);
    const L3 = _csRamp(0, 60, { r: 255, g: 255, b: 255 }, { r: 189, g: 74, b: 29 }, sT);
    const L4 = _csRampMid(-0.2/cc, 0.2/cc, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 240 }, { r: 255, g: 0, b: 0 }, cT);
    const L5 = _csRamp(0, 90, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }, sT);
    const rgb = mulBlend(blend(blend(blend(L1, L2, 0.5), L3, 0.5), L4, 0.5), L5);
    // 無効値（NoData）領域をアルファ0（透明）にするため、centerAlpha を第4チャンネルとして結合
    const alphaT = tf.tensor1d(centerAlpha, 'float32').reshape([tileSize, tileSize, 1]);
    return tf.concat([rgb, alphaT], -1); // [tileSize,tileSize,4] RGBA出力
  });
  [hT, valid].forEach(t => t.dispose()); // 平滑化フェーズで使い終わったテンソルを解放

  // ── ⑦ 出力: tf.browser.toPixels でキャンバスに直接書き込み（中間配列不要） ──
  const outCanvas = new OffscreenCanvas(tileSize, tileSize);
  // csRittaizuTensor は [256,256,4] RGBA。div(255) で 0–1 に正規化してそのまま渡す
  await tf.browser.toPixels(
    csRittaizuTensor.div(tf.scalar(255)), outCanvas
  );
  csRittaizuTensor.dispose();
  return { data: await outCanvas.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()) };
  } catch { return { data: _transparentPngBuffer() }; }
});


/*
  ========================================================
  色別標高図プロトコル (dem2relief://)
  qchizu-project/qchizu-maps-maplibregljs の dem2ReliefProtocol.js を参考に実装。
  https://github.com/qchizu-project/qchizu-maps-maplibregljs/blob/main/src/protocols/dem2ReliefProtocol.js

  URLクエリパラメータ:
    min: 最低標高（m）— この標高をカラーパレットの先頭色に対応させる
    max: 最高標高（m）— この標高をカラーパレットの末尾色に対応させる

  カラーパレット（地形段彩図の標準的な配色）:
    t=0.00  #162a3b  深海・海底（ダークネイビー）
    t=0.08  #2b5e7e  沿岸・浅海（オーシャンブルー）
    t=0.18  #4fb3a9  低地・沿岸平野（ティール）
    t=0.35  #8ec98a  平野・丘陵（ライトグリーン）
    t=0.55  #e0d47e  中高地（イエローグリーン）
    t=0.72  #c8a05a  山地（タン）
    t=0.88  #9e7a3c  高山（ブラウン）
    t=1.00  #ffffff  山頂・積雪域（ホワイト）
  ========================================================
*/

// カラーパレット（正規化位置 t → RGB）
const DEM2RELIEF_PALETTE = [
  { t: 0.00, r:   0, g:   6, b: 251 }, // #0006FB
  { t: 0.17, r:   0, g: 146, b: 251 }, // #0092FB
  { t: 0.33, r:   0, g: 231, b: 251 }, // #00E7FB
  { t: 0.50, r: 138, g: 247, b:   8 }, // #8AF708
  { t: 0.67, r: 242, g: 249, b:  11 }, // #F2F90B
  { t: 0.83, r: 242, g: 138, b:   9 }, // #F28A09
  { t: 1.00, r: 242, g:  72, b:  11 }, // #F2480B
];

// パレット補間: 正規化値 t（0〜1）→ {r, g, b}
function _dem2reliefColor(t) {
  t = Math.max(0, Math.min(1, t));
  let i = 0;
  // 対応区間を線形探索（パレットサイズは固定8点なので十分高速）
  while (i < DEM2RELIEF_PALETTE.length - 2 && DEM2RELIEF_PALETTE[i + 1].t <= t) i++;
  const lo = DEM2RELIEF_PALETTE[i];
  const hi = DEM2RELIEF_PALETTE[i + 1];
  const n  = (t - lo.t) / (hi.t - lo.t); // 区間内の正規化位置（0〜1）
  return {
    r: Math.round(lo.r + n * (hi.r - lo.r)),
    g: Math.round(lo.g + n * (hi.g - lo.g)),
    b: Math.round(lo.b + n * (hi.b - lo.b)),
  };
}

maplibregl.addProtocol('dem2relief', async (params, abortController) => {
  try {
    // URLスキームを https:// に置換して URL オブジェクトを生成
    const rawUrl = params.url.replace(/^dem2relief:\/\//, 'https://');
    const urlObj = new URL(rawUrl);

    // クエリパラメータから min/max を取得（デフォルト 0〜3000m）
    const min = parseFloat(urlObj.searchParams.get('min') ?? '0');
    const max = parseFloat(urlObj.searchParams.get('max') ?? '3000');
    const range = max - min || 1; // ゼロ除算を防ぐ

    // z/x/y の抽出（クエリパラメータを除いたパス部分から取得）
    const m = urlObj.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.\w+/);
    if (!m) return { data: _transparentPngBuffer() };
    const [, z, x, y] = m;

    // z<=14 は DEM5A（軽量）、z>14 は Q地図1m + 陸域統合DEM 全ソース合成
    const demMode = +z <= 14 ? 'dem5a' : null;
    // 合成 DEM ビットマップを取得（Q地図 > 陸域統合 > 湖水深 の優先順）
    // データなし（海域・範囲外・404・CORS）の場合は透明タイルを返す
    const bitmap = await fetchCompositeDemBitmap(z, x, y, abortController.signal, null, 'png', demMode);
    if (!bitmap) return { data: _transparentPngBuffer() };

    // NumPNG → RGB 色別標高図へ変換
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

      // nodata（R=128, G=0, B=0）または透明ピクセルは透明で出力
      if ((r === 128 && g === 0 && b === 0) || a !== 255) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        continue;
      }

      // NumPNG → 標高（メートル）変換: 24bit 符号付き整数 × 0.01m
      const bits24 = (r << 16) | (g << 8) | b;
      const height = ((bits24 << 8) >> 8) * 0.01;

      // 相対正規化: min〜max を 0.0〜1.0 にクランプ（範囲外は端の色で塗る）
      const t = Math.max(0, Math.min(1, (height - min) / range));

      // パレット補間で RGB を決定し書き込み
      const col = _dem2reliefColor(t);
      data[i] = col.r; data[i + 1] = col.g; data[i + 2] = col.b; data[i + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };

  } catch {
    // いかなるエラーでも透明タイルを返してレンダリングループを保護する
    return { data: _transparentPngBuffer() };
  }
});

export { fetchCompositeDemBitmap };

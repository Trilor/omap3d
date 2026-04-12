/* ================================================================
   protocols.js — カスタムプロトコル登録（pmtiles / gsjdem / dem2cs / dem2curve）
   MapLibre の addProtocol() でブラウザ内 DEM 変換を実現します
   ================================================================ */

import { QCHIZU_DEM_BASE, QCHIZU_PROXY_BASE, DEM5A_BASE, DEM10B_BASE, RELIEF_PALETTES } from './config.js';
// DEM1A_BASE: protocols.js では未使用（等高線用のみ app.js で使用）
// 湖水深・湖水面タイルはコメントアウト済み（2026-03-23 廃止）
// import { DEM1A_BASE, LAKEDEPTH_BASE, LAKEDEPTH_STANDARD_BASE } from './config.js';

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

// 地域DEMのURL順序差異を吸収するための既知ルール。
// 追加ソースで {z}/{y}/{x} が増えた場合はここへ足す。
const _REGIONAL_DEM_ORDER_RULES = [
  { pattern: /tiles\.gsj\.jp\/tiles\/elev\/hyogodem/i, order: 'yx' },
];

function _inferTileOrder(baseUrl) {
  const hit = _REGIONAL_DEM_ORDER_RULES.find(rule => rule.pattern.test(baseUrl));
  return hit?.order ?? 'xy';
}

function _parseProtocolTileRequest(paramsUrl, protocol) {
  const rawUrl = paramsUrl.replace(new RegExp(`^${protocol}:\\/\\/`), 'https://');
  const urlObj = new URL(rawUrl);
  const m = urlObj.pathname.match(/^(.*)\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/);
  if (!m) return null;

  const [, basePath, z, a, b, ext] = m;
  const baseUrl = `${urlObj.origin}${basePath}`;
  const tileOrder = urlObj.searchParams.get('tileOrder') === 'yx'
    ? 'yx'
    : _inferTileOrder(baseUrl);
  const tileX = tileOrder === 'yx' ? +b : +a;
  const tileY = tileOrder === 'yx' ? +a : +b;

  return {
    rawUrl,
    urlObj,
    baseUrl,
    tileOrder,
    zoomLevel: +z,
    tileX,
    tileY,
    ext,
  };
}

function _calculateTilePosition(index, tileSize, buffer) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  if (index === 4) {
    return { sx: 0, sy: 0, sWidth: tileSize, sHeight: tileSize, dx: buffer, dy: buffer };
  }

  const sx = col === 0 ? tileSize - buffer : 0;
  const sWidth = col === 1 ? tileSize : buffer;
  const dx = col === 2 ? tileSize + buffer : col * buffer;
  const sy = row === 0 ? tileSize - buffer : 0;
  const sHeight = row === 1 ? tileSize : buffer;
  const dy = row === 2 ? tileSize + buffer : row * buffer;
  return { sx, sy, sWidth, sHeight, dx, dy };
}

function _getNumpngHeight(r, g, b, a) {
  const bits24 = r * 65536 + g * 256 + b;
  if (bits24 === 8388608 || a === 0) return -99999;
  return bits24 < 8388608 ? bits24 * 0.01 : (bits24 - 16777216) * 0.01;
}

function _calculatePixelResolution(tileSize, zoomLevel, tileY) {
  const L = 85.05112878;
  const y = 256 * tileY + 128;
  const lat = (180 / Math.PI) * Math.asin(
    Math.tanh((-Math.PI / (1 << (zoomLevel + 7))) * y + Math.atanh(Math.sin((L * Math.PI) / 180)))
  );
  return 156543.04 * Math.cos((lat * Math.PI) / 180) / (1 << zoomLevel) * (256 / tileSize);
}

function _calculateSlope(h00, h01, h10, pixelLength) {
  if (h00 === -99999 || h01 === -99999 || h10 === -99999) return null;
  const dx = h00 - h01;
  const dy = h00 - h10;
  return Math.atan(Math.sqrt(dx * dx + dy * dy) / pixelLength) * (180 / Math.PI);
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
  3D地形用 DEM 合成（Q地図1m > DEM5A > DEM10B）
  q地図 maplibre 版の demTranscoderProtocol.js を参考に実装。
  優先度:
    1. Q地図1m DEM（CF Workers プロキシ経由・maxzoom 16・最高品質）
    2. DEM5A（地理院 5mDEM・基盤地図情報・maxzoom 15）
    3. DEM10B（地理院 10mDEM・全国カバレッジ保証・maxzoom 14）
  全タイル共通の国土地理院 NumPNG 形式（R=high, G=mid, B=low, nodata=R128,G0,B0）。
  湖水深合成は廃止（コメントアウト済み）。
  ========================================================
*/
async function fetchTerrainDemBitmap(z, x, y, signal) {
  const dem10bUrl = z <= 14 ? `${DEM10B_BASE}/${z}/${x}/${y}.png` : null; // DEM10B: maxzoom 14（z15+は404になるため省略）
  const dem5aUrl  = `${DEM5A_BASE}/${z}/${x}/${y}.png`;             // DEM5A:  5mメッシュ・基盤地図情報（maxzoom 15）
  const qUrl      = `${QCHIZU_PROXY_BASE}/${z}/${x}/${y}.webp`;     // Q地図1m: CF Workers プロキシ経由（maxzoom 16）
  // terrain-dem ソースの maxzoom を 15 に設定しているため、
  // MapLibre は z≤15 のタイルのみ要求し z16+ は自動オーバーズームする。
  // よって DEM5A(max z15) は常にデータあり、DEM10B(max z14) は z15 で404になるが
  // DEM5A がカバーするため問題なし。

  // 全ソースを 256×256 に正規化して返す。
  // Q地図は512×512 WebP のためリサイズが必要。
  // ★ imageSmoothingEnabled = false（最近傍補間）必須:
  //   バイリニア補間だと nodata(R=128,G=0,B=0) と有効データ(R≈0) の境界で
  //   中間値 R≈64 が生成され、NumPNG として約 42000m と解釈されスパイクになる。
  const TARGET = 256;

  // Q地図1m 用タイムアウト付きシグナル（3秒）
  // Q地図1mの提供が不安定な場合でも DEM5A/DEM10B で素早くテレインを返すため。
  // AbortSignal.any は Chrome116+/Firefox115+ で使用可能。
  const qSignal = (typeof AbortSignal.any === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : signal;

  async function toImageData(url, s = signal) {
    try {
      const r = await fetch(url, { signal: s });
      if (!r.ok) return null;
      const bm = await createImageBitmap(await r.blob());
      const cv = new OffscreenCanvas(TARGET, TARGET);
      const ctx2 = cv.getContext('2d');
      ctx2.imageSmoothingEnabled = false; // 最近傍補間でnodata汚染を防止
      ctx2.drawImage(bm, 0, 0, bm.width, bm.height, 0, 0, TARGET, TARGET);
      bm.close();
      return ctx2.getImageData(0, 0, TARGET, TARGET);
    } catch { return null; }
  }

  const [dem10b, dem5a, qData] = await Promise.all([
    dem10bUrl ? toImageData(dem10bUrl) : Promise.resolve(null),
    toImageData(dem5aUrl),
    toImageData(qUrl, qSignal),
  ]);
  if (!dem10b && !dem5a && !qData) return null;

  function isNodata(d, i) {
    return (d[i] === 128 && d[i + 1] === 0 && d[i + 2] === 0) || d[i + 3] !== 255;
  }

  // 合成先を全 nodata で初期化し、低優先度から順に上書き（全ソース 256×256 で統一済み）
  const cv  = new OffscreenCanvas(TARGET, TARGET);
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(TARGET, TARGET);
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) { o[i] = 128; o[i + 3] = 255; } // all nodata

  // 優先度 低: DEM10B（10mメッシュ・全国カバレッジ保証）
  if (dem10b) {
    const d = dem10b.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(d, i)) continue;
      o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 中: DEM5A（5mメッシュ・基盤地図情報）
  if (dem5a) {
    const d = dem5a.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(d, i)) continue;
      o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 高: Q地図1m（CF Workers プロキシ経由）
  if (qData) {
    const q = qData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(q, i)) continue;
      o[i] = q[i]; o[i + 1] = q[i + 1]; o[i + 2] = q[i + 2]; o[i + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return createImageBitmap(cv);
}


/*
  ========================================================
  CS立体図用 DEM 合成（dem2cs:// から呼ばれる）
  Q地図 > DEM5A > DEM10B > 地域DEM の優先順で合成。
  湖水深合成は廃止（コメントアウト済み）。
  ========================================================
*/

// ================================================================
// 汎用セマフォファクトリ（同時実行数を制限するPromiseキュー）
// ================================================================
function _createSemaphore(concurrency) {
  let active = 0;
  const queue = [];
  return {
    acquire: () => active < concurrency
      ? (active++, Promise.resolve())
      : new Promise(resolve => queue.push(resolve)),
    release: () => queue.length > 0 ? queue.shift()() : active--,
  };
}

// GPU計算セマフォ（TF.js GPU処理全体の同時実行数を制限）
// 複数タイルが同時に tf.browser.toPixels を呼ぶとGPUキューが詰まるため制限する。
const _gpuTransferSem = _createSemaphore(4);
function _acquireGpuTransfer() { return _gpuTransferSem.acquire(); }
function _releaseGpuTransfer() { _gpuTransferSem.release(); }

// DEMフェッチセマフォ（地理院サーバーのレート制限対策）
// 同時フェッチ数を抑えることで個々のリクエストを速やかに完了させる
const _demFetchSem = _createSemaphore(8);

// ================================================================
// DEMタイルfetchキャッシュ（URL単位でPromiseを共有）
// 隣接タイル同士が同じ近傍URLを要求する重複fetchを排除する。
// z18のような高ズームでは隣接タイル間の重複が多く、初めて見る場所でも効果がある。
// 例: 4×4タイル表示時、27リクエスト×16タイル=432 → ユニーク108に削減（約4分の1）
// ================================================================
const _demTileFetchCache = new Map();
const _DEM_TILE_CACHE_TTL = 15000; // 15秒保持（近傍タイルの処理完了まで十分な時間）

function _cachedFetchImageData(url, signal) {
  const hit = _demTileFetchCache.get(url);
  if (hit) return hit;
  const promise = (async () => {
    await _demFetchSem.acquire();
    try {
      const r = await fetch(url, signal ? { signal } : undefined);
      if (!r.ok) return null; // 404等は正規の「データなし」→キャッシュ保持で再リクエスト抑制
      const bm = await createImageBitmap(await r.blob());
      const cv = new OffscreenCanvas(bm.width, bm.height);
      cv.getContext('2d').drawImage(bm, 0, 0);
      bm.close();
      return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    } catch {
      // タイムアウト・ネットワークエラーは一時的な失敗→即キャッシュ削除して再試行可能に
      _demTileFetchCache.delete(url);
      return null;
    } finally {
      _demFetchSem.release();
    }
  })();
  _demTileFetchCache.set(url, promise);
  // 成功・404のTTL削除: 新しいプロミスに上書きされていた場合は削除しない（競合防止）
  promise.finally(() => setTimeout(() => {
    if (_demTileFetchCache.get(url) === promise) _demTileFetchCache.delete(url);
  }, _DEM_TILE_CACHE_TTL));
  return promise;
}
// 合成タイルの出力サイズ（tileSize:256 のMapLibreソース定義と整合）
const _COMPOSITE_TARGET_SIZE = 256;

// 最終出力画像（RGB）を _COMPOSITE_TARGET_SIZE にリサイズして返す。
// nearest=true: RGB 24bit エンコードデータなど数値を保持する場合は最近傍補間を使う。
// nearest=false（デフォルト）: 着色済みカラー画像はバイリニアで良い。
function _rescaleComposite(canvas, nearest = false) {
  if (canvas.width === _COMPOSITE_TARGET_SIZE) return canvas;
  const dst = new OffscreenCanvas(_COMPOSITE_TARGET_SIZE, _COMPOSITE_TARGET_SIZE);
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = !nearest;
  if (!nearest) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, _COMPOSITE_TARGET_SIZE, _COMPOSITE_TARGET_SIZE);
  return dst;
}

// ImageData を targetSize の ImageData にスケーリング（最近傍補間で高度値を保持）
// DEM5A/DEM10B は 256px、Q地図は 512px と異なるため合成前に統一する
function _scaleToTarget(imgData, targetSize = _COMPOSITE_TARGET_SIZE) {
  if (!imgData) return null;
  if (imgData.width === targetSize && imgData.height === targetSize) {
    return imgData; // 既にターゲットサイズなのでそのまま返す
  }
  // 元サイズのcanvasにputImageDataしてからtargetSizeに描画
  const src = new OffscreenCanvas(imgData.width, imgData.height);
  src.getContext('2d').putImageData(imgData, 0, 0);
  const dst = new OffscreenCanvas(targetSize, targetSize);
  const dstCtx = dst.getContext('2d');
  dstCtx.imageSmoothingEnabled = false; // 最近傍補間（高度値が変わらないよう保護）
  dstCtx.drawImage(src, 0, 0, targetSize, targetSize);
  return dstCtx.getImageData(0, 0, targetSize, targetSize);
}

// regionalDemBase : 地域DEMのベースURL（dem2cs://地域層の場合のみ指定）
// regionalDemExt  : 地域DEMの拡張子（'png' または 'webp'）
// regionalDemOrder: 地域DEM URL の軸順序（'xy' または 'yx'）
// demMode: null               → DEM10B + DEM5A + Q地図1m + 地域DEM（z≥16用）
//          'dem10b+dem5a+q'  → DEM10B + DEM5A + Q地図1m（地域DEM無し、z15用）
//          'dem10b+dem5a'    → DEM10B + DEM5A（z14用）
//          'dem10b'          → DEM10Bのみ（z≤13用）
//          'dem5a'           → DEM5Aのみ
//          'q'               → Q地図1mのみ（qonlyソース用・z16専用）
async function fetchCompositeDemBitmap(
  z,
  x,
  y,
  signal,
  regionalDemBase = null,
  regionalDemExt = 'png',
  demMode = null,
  regionalDemOrder = 'xy',
  tileOutputSize = null  // null = 自動: Q地図使用時→512px、DEM5A/DEM10Bのみ→256px
) {
  const useQ    = demMode === null || demMode === 'dem10b+dem5a+q' || demMode === 'q'; // Q地図: 全合成・z15・qonlyモード
  const useS    = demMode === null || demMode === 'dem10b+dem5a+q' || demMode === 'dem5a' || demMode === 'dem10b+dem5a'; // DEM5A（qonlyでは使わない）
  const useDem10b = demMode === null || demMode === 'dem10b+dem5a+q' || demMode === 'dem10b' || demMode === 'dem10b+dem5a'; // DEM10B（qonlyでは使わない）
  const rUrl = (useQ && regionalDemBase)
    ? regionalDemOrder === 'yx'
      ? `${regionalDemBase}/${z}/${y}/${x}.${regionalDemExt}`
      : `${regionalDemBase}/${z}/${x}/${y}.${regionalDemExt}`
    : null;

  // Q地図1m 用タイムアウト付きシグナル（3秒）
  // Q地図1mの提供が不安定な場合でも他ソースで素早くCS立体図を返すため。
  // キャッシュヒット時はシグナルは無視されるが、初回fetchの品質維持のために残す。
  const qSignal = useQ && (typeof AbortSignal.any === 'function')
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : signal;

  const sUrl     = (useS      && z <= 15) ? `${DEM5A_BASE}/${z}/${x}/${y}.png`         : null; // DEM5A: maxzoom 15
  const dem10bUrl = (useDem10b && z <= 14) ? `${DEM10B_BASE}/${z}/${x}/${y}.png`        : null; // DEM10B: maxzoom 14
  const qUrl     = useQ ? `${QCHIZU_PROXY_BASE}/${z}/${x}/${y}.webp` : null; // Q地図1m: maxzoom 16（z16+はsource maxzoom側で制御）

  // _cachedFetchImageData でURL単位のPromise共有 → 同一URLの重複fetchを排除
  const [qRaw, sRaw, dem10bRaw, rRaw] = await Promise.all([
    qUrl      ? _cachedFetchImageData(qUrl, qSignal) : Promise.resolve(null),
    sUrl      ? _cachedFetchImageData(sUrl)           : Promise.resolve(null),
    dem10bUrl ? _cachedFetchImageData(dem10bUrl)      : Promise.resolve(null),
    rUrl      ? _cachedFetchImageData(rUrl)           : Promise.resolve(null),
  ]);
  if (!qRaw && !sRaw && !dem10bRaw && !rRaw) return null;

  // Q地図が実際にデータを返した場合のみ512pxに統一。DEM5A/DEM10Bのみなら256pxネイティブサイズを維持。
  // useQ（使う意図）ではなくqRaw（実際のデータ有無）で判定することで、
  // Q地図nodata時にDEM5AをNN拡大して2×2ブロックが生じる問題を回避する。
  // 呼び出し元から明示的に指定された場合はそちらを優先する。
  const T = tileOutputSize ?? (qRaw ? _COMPOSITE_TARGET_SIZE : 256);
  const qData    = _scaleToTarget(qRaw,    T);
  const sData    = _scaleToTarget(sRaw,    T);
  const dem10bData = _scaleToTarget(dem10bRaw, T);
  const rData    = _scaleToTarget(rRaw,    T);

  function isNodata(d, i) {
    return (d[i] === 128 && d[i + 1] === 0 && d[i + 2] === 0) || d[i + 3] !== 255;
  }
  const cv  = new OffscreenCanvas(T, T);
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(T, T);
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) { o[i] = 128; o[i + 3] = 255; } // all nodata

  // 湖水深合成ブロックはコメントアウト（2026-03-23 廃止）
  // if (lData && lsData) { ... }

  // 優先度 中低: DEM5A
  if (sData) {
    const s = sData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(s, i)) continue;
      o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = 255;
    }
  }

  // 優先度 中: DEM10B（GSI 10mDEM・全国カバレッジ保証）
  if (dem10bData) {
    const dem10b = dem10bData.data;
    for (let i = 0; i < o.length; i += 4) {
      if (isNodata(dem10b, i)) continue;
      o[i] = dem10b[i]; o[i + 1] = dem10b[i + 1]; o[i + 2] = dem10b[i + 2]; o[i + 3] = 255;
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

  // 優先度 最高: 地域DEM（0.5m）― dem2cs://地域層からのみ利用
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
  fetchCompositeDemBitmap で Q地図 > DEM5A > DEM10B の優先順に合成した
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

  // 3D地形は Q地図1m > DEM5A > DEM10B の優先順で合成（湖水深なし）
  const bitmap = await fetchTerrainDemBitmap(z, x, y, abortController.signal);

  // 出力は常に256×256固定（MapLibre backfillBorder の dimension mismatch を防止）
  const OUT = 256;
  const canvas = new OffscreenCanvas(OUT, OUT);
  const ctx = canvas.getContext('2d');

  if (!bitmap) {
    // データなし → Terrarium 0m（R=128,G=0,B=0）で埋めた 256×256 タイルを返す
    // 1×1透明PNGではなく256×256を返すことで隣接タイルとのサイズ不一致を防ぐ
    const id = ctx.createImageData(OUT, OUT);
    for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 128; id.data[i + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    const blob0 = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob0.arrayBuffer() };
  }

  // 常に256×256へリサイズ描画（Q地図512×512 WebPタイルも統一）
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, OUT, OUT);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, OUT, OUT);
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

// ガウシアンカーネルキャッシュ: kernelRadius → { kX: [1,k,1,1], kY: [k,1,1,1] }
// ガウシアンは分離可能（G(x,y)=g(x)×g(y)）なので水平・垂直の1Dカーネル2本に分解する。
// 2D conv(k²回/px) → 1D×2パス(2k回/px) で演算量が約20分の1に削減される。
const _csKernelCache = new Map();
function _getCsKernel(kernelRadius, sigma) {
  if (_csKernelCache.has(kernelRadius)) return _csKernelCache.get(kernelRadius);
  const kernelDim = kernelRadius * 2 + 1;
  const kernels = tf.tidy(() => {
    const g = tf.exp(
      tf.neg(tf.linspace(-kernelRadius, kernelRadius, kernelDim).square().div(2 * sigma * sigma))
    );
    return {
      kX: tf.keep(g.reshape([1, kernelDim, 1, 1])), // 水平パス用 [1,k,1,1]
      kY: tf.keep(g.reshape([kernelDim, 1, 1, 1])), // 垂直パス用 [k,1,1,1]
    };
  });
  _csKernelCache.set(kernelRadius, kernels);
  return kernels;
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

maplibregl.addProtocol('dem2cs', async (params, abortController) => {
  try {
  if (_tfContextLost) return { data: _transparentPngBuffer() };
  const request = _parseProtocolTileRequest(params.url, 'dem2cs');
  if (!request) return { data: _transparentPngBuffer() };
  const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;
  const terrainScale = Math.max(parseFloat(urlObj.searchParams.get('terrainScale') ?? '1') || 1, 0.1);
  const redAndBlueIntensity = Math.max(parseFloat(urlObj.searchParams.get('redBlueIntensity') ?? '1') || 1, 0.1);

  const regionalDemBase = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
  const regionalDemExt  = regionalDemBase ? ext : null;
  const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';

  // ズーム別 DEMソース選択（demModeで一元管理）:
  //   qonly=1: Q地図のみ（qonlyソース用）
  //   z≤13: DEM10Bのみ（1px=76m以上・DEM5Aは過剰）
  //   z14 : DEM10B + DEM5A（DEM10B最終有効zoom）
  //   z15 : DEM10B + DEM5A + Q地図1m
  //   z≥16: 全ソース + 地域DEM 0.5m（null = 地域DEM有効）
  const qonly = urlObj.searchParams.get('qonly') === '1';
  const demMode = qonly ? 'q'
                : zoomLevel <= 13 ? 'dem10b'
                : zoomLevel === 14 ? 'dem10b+dem5a'
                : zoomLevel === 15 ? 'dem10b+dem5a+q'
                : null;
  // demMode === null（z≥16）のみ地域DEMを使用
  const effectiveRegionalBase = demMode === null ? regionalDemBase : null;
  const effectiveRegionalExt  = effectiveRegionalBase ? regionalDemExt : null;
  const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

  const _csT0 = performance.now();

  // ── ① 9タイル全て並列fetch（地域DEM優先 → Q地図 → DEM10B の順で補完） ──
  // 各タイルを fetchCompositeDemBitmap で取得（地域DEM/Q地図優先・nodata はシームレスで補完）
  const neighborOffsets = [
    [-1, -1], [0, -1], [1, -1], // 0:左上 1:上 2:右上
    [-1,  0], [0,  0], [1,  0], // 3:左   4:中央 5:右
    [-1,  1], [0,  1], [1,  1], // 6:左下 7:下   8:右下
  ];

  const bitmaps = await Promise.all(neighborOffsets.map(([dx, dy]) =>
    fetchCompositeDemBitmap(
      zoomLevel,
      tileX + dx,
      tileY + dy,
      abortController.signal,
      effectiveRegionalBase,
      effectiveRegionalExt,
      demMode,
      effectiveRegionalOrder
    )
  ));
  if (!bitmaps[4]) return { data: _transparentPngBuffer() }; // 中央タイルが取得できなければ透明タイルを返す

  const _csT1 = performance.now(); // ①fetch完了

  // タイルサイズを中央タイルから動的検出（256px または 512px タイルに対応）
  const tileSize = bitmaps[4].width;

  const pixelLength = _calculatePixelResolution(tileSize, zoomLevel, tileY);

  // ガウシアンパラメータ
  const sigma = Math.min(Math.max(3 / pixelLength, 1.6), 7) * terrainScale;
  const kernelRadius = Math.ceil(sigma * 3);
  const buffer = kernelRadius + 1;
  const mergedSize = tileSize + buffer * 2;

  // ── ② マージキャンバスに描画 ──
  const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
  const mc = mergedCanvas.getContext('2d');
  bitmaps.forEach((bmp, idx) => {
    if (!bmp) return;
    let sx, sy, sw, sh, dx, dy;
    if (idx === 4) {
      sx = 0; sy = 0; sw = tileSize; sh = tileSize; dx = buffer; dy = buffer;
    } else {
      ({ sx, sy, sWidth: sw, sHeight: sh, dx, dy } = _calculateTilePosition(idx, tileSize, buffer));
    }
    mc.drawImage(bmp, sx, sy, sw, sh, dx, dy, sw, sh);
    bmp.close();
  });

  // ── ③ 標高配列生成（Float32Array — Array より高速） ──
  const mergedPx = mc.getImageData(0, 0, mergedSize, mergedSize).data;
  const mergedHeights = new Float32Array(mergedSize * mergedSize);
  for (let i = 0; i < mergedHeights.length; i++) {
    const p = i * 4;
    mergedHeights[i] = _getNumpngHeight(mergedPx[p], mergedPx[p + 1], mergedPx[p + 2], mergedPx[p + 3]);
  }

  const _csT2 = performance.now(); // merge+decode完了

  // ── ④〜⑥ GPU演算〜出力（セマフォで同時実行数制限）──
  // TensorFlow.jsはGPU演算を遅延実行するため、toPixels呼び出し時に全タイルの
  // 積み残し演算が一気に実行される。fetch後に大量タイルが同時にGPU処理に入ると
  // GPU作業キューが飽和し toPixels が数秒待たされる。
  // セマフォをGPUアップロード前から取得することで、GPU演算全体を2タイル同時に制限する。
  // セマフォ待ち前にabort済みならキューに入らず即終了
  if (abortController.signal.aborted) throw new DOMException('Tile request aborted', 'AbortError');
  await _acquireGpuTransfer();
  // 待機中にabortされた場合もセマフォを返して終了
  if (abortController.signal.aborted) { _releaseGpuTransfer(); throw new DOMException('Tile request aborted', 'AbortError'); }
  let arrayBuffer;
  let _csGpuReleased = false;
  try {
    // Phase A: CPU→GPU転送（tensor2d生成）
    const hT = tf.tensor2d(mergedHeights, [mergedSize, mergedSize]);
    const valid = hT.notEqual(-99999);
    const _csT2b = performance.now(); // CPU→GPU転送完了

    // Phase B: Gaussian平滑化（分離畳み込み: 水平→垂直の2パスで演算量~20分の1）
    // G(x,y)=g(x)×g(y) の分離可能性を利用し、2D conv(k²回/px) を 1D×2回(2k回/px) に分解
    const masked = tf.where(valid, hT, 0);
    const validF = valid.cast('float32');
    const { kX, kY } = _getCsKernel(kernelRadius, sigma); // 分離1Dカーネルペアを取得
    // 水平パス: [mergedSize, mergedSize] → [mergedSize, mergedSize-2r]
    const maskedH = tf.conv2d(masked.expandDims(2).expandDims(0), kX, 1, 'valid').squeeze([0, 3]);
    const validH  = tf.conv2d(validF.expandDims(2).expandDims(0), kX, 1, 'valid').squeeze([0, 3]);
    masked.dispose(); validF.dispose();
    // 垂直パス: [mergedSize, mergedSize-2r] → [mergedSize-2r, mergedSize-2r]
    const maskedHV = tf.conv2d(maskedH.expandDims(2).expandDims(0), kY, 1, 'valid').squeeze([0, 3]);
    const kSum     = tf.conv2d(validH.expandDims(2).expandDims(0), kY, 1, 'valid').squeeze([0, 3]);
    maskedH.dispose(); validH.dispose();
    const sHRaw = maskedHV.div(kSum);
    maskedHV.dispose(); kSum.dispose();
    const validCrop = valid.slice([buffer, buffer], [tileSize + 2, tileSize + 2]);
    const sH = tf.where(validCrop, sHRaw, tf.fill([tileSize + 2, tileSize + 2], -99999));
    [sHRaw, validCrop].forEach(t => t.dispose());
    const _csT2c = performance.now(); // Gaussian完了

    // Phase C: Sobel傾斜（3×3 conv2d）
    const slopeT = tf.tidy(() => {
      const rawCrop = tf.where(
        valid.slice([buffer - 1, buffer - 1], [tileSize + 2, tileSize + 2]),
        hT.slice([buffer - 1, buffer - 1], [tileSize + 2, tileSize + 2]),
        tf.zeros([tileSize + 2, tileSize + 2])
      );
      const rawIn = rawCrop.expandDims(0).expandDims(-1);
      const sobelX = tf.tensor4d([-1, 0, 1, -2, 0, 2, -1, 0, 1], [3, 3, 1, 1]);
      const sobelY = tf.tensor4d([-1, -2, -1, 0, 0, 0, 1, 2, 1], [3, 3, 1, 1]);
      const dzdx = tf.conv2d(rawIn, sobelX, 1, 'valid').squeeze([0, 3]).div(8 * pixelLength);
      const dzdy = tf.conv2d(rawIn, sobelY, 1, 'valid').squeeze([0, 3]).div(8 * pixelLength);
      return tf.atan(dzdx.square().add(dzdy.square()).sqrt()).mul(180 / Math.PI);
    });
    const _csT2d = performance.now(); // Sobel完了

    // Phase D: Laplacian曲率（3×3 conv2d）
    const cellArea = pixelLength * pixelLength;
    const curvatureT = tf.tidy(() => {
      const lapKernel = tf.tensor4d([0,-1,0,-1,4,-1,0,-1,0], [3,3,1,1]).div(cellArea);
      return tf.conv2d(sH.expandDims(0).expandDims(-1), lapKernel, 1, 'valid').squeeze([0,3]);
    });
    sH.dispose();
    const _csT3 = performance.now(); // Laplacian完了

    // ── ⑤ 5レイヤー合成（GPU）──
    const cc = pixelLength < 68
      ? Math.max(pixelLength / 2, 1.1) * Math.sqrt(terrainScale) * redAndBlueIntensity
      : 0.188 * Math.pow(pixelLength, 1.232) * Math.sqrt(terrainScale) * redAndBlueIntensity;

    const hCrop = hT.slice([buffer, buffer], [tileSize, tileSize]);
    const csRittaizuTensor = tf.tidy(() => {
      const blend    = (a, b, alpha) => a.mul(1 - alpha).add(b.mul(alpha));
      const mulBlend = (a, b) => a.mul(b.div(255));
      const L1 = _csRamp(0, 3000, { r: 100, g: 100, b: 100 }, { r: 255, g: 255, b: 255 }, hCrop);
      const L2 = _csRamp(-0.25/cc, 0.05/cc, { r: 42, g: 92, b: 170 }, { r: 255, g: 255, b: 255 }, curvatureT);
      const L3 = _csRamp(0, 60, { r: 255, g: 255, b: 255 }, { r: 189, g: 74, b: 29 }, slopeT);
      const L4 = _csRampMid(-0.2/cc, 0.2/cc, { r: 0, g: 0, b: 255 }, { r: 255, g: 255, b: 240 }, { r: 255, g: 0, b: 0 }, curvatureT);
      const L5 = _csRamp(0, 90, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }, slopeT);
      const rgb = mulBlend(blend(blend(blend(L1, L2, 0.5), L3, 0.5), L4, 0.5), L5);
      const alphaT = tf.where(hCrop.notEqual(-99999), tf.scalar(255), tf.scalar(0))
        .reshape([tileSize, tileSize, 1]);
      return tf.concat([rgb, alphaT], -1);
    });
    [hT, valid, hCrop, curvatureT, slopeT].forEach(t => t.dispose());
    const _csT4 = performance.now(); // 5レイヤー合成完了

    // ── ⑥ 出力 ──
    const outCanvas = new OffscreenCanvas(tileSize, tileSize);
    const csNorm = csRittaizuTensor.div(255);
    await tf.browser.toPixels(csNorm, outCanvas);
    csNorm.dispose();
    csRittaizuTensor.dispose();
    const _csT5 = performance.now(); // toPixels完了
    _releaseGpuTransfer(); // blob変換はCPU処理なのでGPUスロットを即返却
    _csGpuReleased = true;

    const blob = await outCanvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    arrayBuffer = await blob.arrayBuffer();
    const _csT6 = performance.now();
    const _csDemSrcs = demMode === null            ? 'R+Q+5A+10B'
      : demMode === 'dem10b+dem5a+q' ? 'Q+5A+10B'
      : demMode === 'dem10b+dem5a'   ? '5A+10B'
      : demMode === 'q'             ? 'Q'
      : '10B';
    console.log(
      `[dem2cs] z${zoomLevel} ${tileX},${tileY} dem:${_csDemSrcs} sigma=${sigma.toFixed(1)} k=${kernelRadius*2+1}px | ` +
      `fetch:${(_csT1-_csT0).toFixed(0)}  ` +
      `wait:${(_csT2b-_csT2).toFixed(0)}  ` +
      `gauss:${(_csT2c-_csT2b).toFixed(0)}  ` +
      `sobel:${(_csT2d-_csT2c).toFixed(0)}  ` +
      `lap:${(_csT3-_csT2d).toFixed(0)}  ` +
      `blend:${(_csT4-_csT3).toFixed(0)}  ` +
      `toPixels:${(_csT5-_csT4).toFixed(0)}  ` +
      `blob:${(_csT6-_csT5).toFixed(0)}  ` +
      `total:${(_csT6-_csT0).toFixed(0)}ms`
    );
  } finally {
    if (!_csGpuReleased) _releaseGpuTransfer(); // エラー時のフォールバック解放
  }

  return { data: arrayBuffer };
  } catch(e) {
    if (e?.name === 'AbortError') throw e; // MapLibreにAbortを正しく伝播→タイル再取得可能に
    return { data: _transparentPngBuffer() };
  }
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

// パレット ID → stops を取得（存在しない場合は rainbow にフォールバック）
function _getReliefPaletteStops(id) {
  return (RELIEF_PALETTES.find(p => p.id === id) ?? RELIEF_PALETTES[0]).stops;
}

// パレット補間: 正規化値 t（0〜1）→ {r, g, b}
// stops: RELIEF_PALETTES の stops 配列
function _dem2reliefColor(t, stops) {
  t = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1].t <= t) i++;
  const lo = stops[i];
  const hi = stops[i + 1];
  const n  = (t - lo.t) / (hi.t - lo.t); // 区間内の正規化位置（0〜1）
  return {
    r: Math.round(lo.r + n * (hi.r - lo.r)),
    g: Math.round(lo.g + n * (hi.g - lo.g)),
    b: Math.round(lo.b + n * (hi.b - lo.b)),
  };
}

/*
  ========================================================
  色別傾斜プロトコル (dem2slope://)
  qchizu-project/qchizu-maps-maplibregljs の dem2SlopeProtocol.js と
  protocolUtils.js の計算式をもとに、既存の DEM 合成系へ組み込む。

  URLクエリパラメータ:
    min: 最低傾斜角（度）
    max: 最高傾斜角（度）
  ========================================================
*/

function _dem2slopeColor(slope, min, max, stops) {
  const range = max - min || 1;
  const t = Math.max(0, Math.min(1, (slope - min) / range));
  return _dem2reliefColor(t, stops);
}

// 汎用 RGB 24bit エンコーダー（数値を dataMin〜dataMax の範囲で 0〜16777215 に正規化して R/G/B に分散）
// A チャンネルは nodata マスク用に呼び出し元で別途管理する。
function _encodeToRgb24(value, dataMin, dataMax) {
  let norm = (value - dataMin) / (dataMax - dataMin);
  norm = Math.max(0, Math.min(1, norm));
  const t = Math.floor(norm * 16777215);
  return { r: (t >> 16) & 255, g: (t >> 8) & 255, b: t & 255 };
}

// 各データタイルのエンコード範囲（GPU シェーダーと共有）
export const SLOPE_DATA_MIN  =    0; // 傾斜角 (度)
export const SLOPE_DATA_MAX  =   90;
export const RELIEF_DATA_MIN = -500; // 標高 (m)
export const RELIEF_DATA_MAX = 4500;
export const CURVE_DATA_MIN  = -2.0; // 正規化曲率 (cTscaled)
export const CURVE_DATA_MAX  =  2.0;

// 傾斜角（0〜90度）を RGB 24bit に可逆エンコード（_encodeToRgb24 のラッパー）
function _encodeSlopeToRgb24(slopeDegree) {
  return _encodeToRgb24(slopeDegree, SLOPE_DATA_MIN, SLOPE_DATA_MAX);
}

/*
  ========================================================
  傾斜タイル共通ビルダー
  DEM タイルを4枚取得し、傾斜角を計算して ImageData に書き込む。
  writePixel(slopeDeg, out, pixelIndex) で出力形式を切り替える。
  nearest=true: RGB 24bit エンコード等の数値タイルはリサイズで補間しない。
  ========================================================
*/
async function _buildSlopeTileCanvas(
  zoomLevel, tileX, tileY,
  demMode, regionalBase, regionalExt, regionalOrder,
  abortSignal, writePixel, nearest = false
) {
  const [center, right, down, downRight] = await Promise.all([
    fetchCompositeDemBitmap(zoomLevel, tileX,     tileY,     abortSignal, regionalBase, regionalExt, demMode, regionalOrder, null),
    fetchCompositeDemBitmap(zoomLevel, tileX + 1, tileY,     abortSignal, regionalBase, regionalExt, demMode, regionalOrder, null),
    fetchCompositeDemBitmap(zoomLevel, tileX,     tileY + 1, abortSignal, regionalBase, regionalExt, demMode, regionalOrder, null),
    fetchCompositeDemBitmap(zoomLevel, tileX + 1, tileY + 1, abortSignal, regionalBase, regionalExt, demMode, regionalOrder, null),
  ]);
  if (!center) return null;

  const tileSize = center.width;
  const buffer = 1;
  const mergedSize = tileSize + buffer * 2;
  const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
  const mergedCtx = mergedCanvas.getContext('2d');

  [
    { bmp: center,      index: 4 },
    { bmp: right,       index: 5 },
    { bmp: down,        index: 7 },
    { bmp: downRight,   index: 8 },
  ].forEach(({ bmp, index }) => {
    if (!bmp) return;
    const { sx, sy, sWidth, sHeight, dx, dy } = _calculateTilePosition(index, tileSize, buffer);
    mergedCtx.drawImage(bmp, sx, sy, sWidth, sHeight, dx, dy, sWidth, sHeight);
    bmp.close();
  });

  const outCanvas = new OffscreenCanvas(tileSize, tileSize);
  const outCtx = outCanvas.getContext('2d');
  const outImageData = outCtx.createImageData(tileSize, tileSize);
  const out = outImageData.data;

  const mergedData = mergedCtx.getImageData(0, 0, mergedSize, mergedSize).data;
  const pixelLength = _calculatePixelResolution(tileSize, zoomLevel, tileY);

  for (let row = 0; row < tileSize; row++) {
    for (let col = 0; col < tileSize; col++) {
      const mi = ((row + buffer) * mergedSize + (col + buffer)) * 4;
      const oi = (row * tileSize + col) * 4;

      const h00 = _getNumpngHeight(mergedData[mi],     mergedData[mi + 1], mergedData[mi + 2],     mergedData[mi + 3]);
      const h01 = _getNumpngHeight(mergedData[mi + 4], mergedData[mi + 5], mergedData[mi + 6],     mergedData[mi + 7]);
      const h10 = _getNumpngHeight(mergedData[mi + mergedSize * 4], mergedData[mi + mergedSize * 4 + 1],
                                   mergedData[mi + mergedSize * 4 + 2], mergedData[mi + mergedSize * 4 + 3]);
      const slope = _calculateSlope(h00, h01, h10, pixelLength);

      if (slope == null) {
        out[oi + 3] = 0; // nodata: a=0
        continue;
      }
      writePixel(slope, out, oi);
    }
  }

  outCtx.putImageData(outImageData, 0, 0);
  return _rescaleComposite(outCanvas, nearest);
}

// ズーム別 DEM ソースモードを決定するヘルパー
function _slopeDemMode(zoomLevel, qonly) {
  if (qonly) return 'q';
  if (zoomLevel <= 13) return 'dem10b';
  if (zoomLevel === 14) return 'dem10b+dem5a';
  if (zoomLevel === 15) return 'dem10b+dem5a+q';
  return null; // z>=16: 地域DEM使用
}

function _demSrcLabel(demMode) {
  if (demMode === null)              return 'R+Q+5A+10B';
  if (demMode === 'dem10b+dem5a+q') return 'Q+5A+10B';
  if (demMode === 'dem10b+dem5a')   return '5A+10B';
  if (demMode === 'q')              return 'Q';
  return '10B';
}

maplibregl.addProtocol('dem2slope', async (params, abortController) => {
  try {
    const request = _parseProtocolTileRequest(params.url, 'dem2slope');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;

    const min = parseFloat(urlObj.searchParams.get('min') ?? '0');
    const max = parseFloat(urlObj.searchParams.get('max') ?? '45');
    const reliefStops = _getReliefPaletteStops(urlObj.searchParams.get('palette') ?? 'rainbow');
    const qonly = urlObj.searchParams.get('qonly') === '1';

    const regionalBase = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const demMode = _slopeDemMode(zoomLevel, qonly);
    const effRegionalBase = demMode === null ? regionalBase : null;
    const effRegionalExt  = effRegionalBase ? ext : null;
    const effRegionalOrder = effRegionalBase ? tileOrder : 'xy';

    const t0 = performance.now();
    const outCanvas = await _buildSlopeTileCanvas(
      zoomLevel, tileX, tileY, demMode,
      effRegionalBase, effRegionalExt, effRegionalOrder,
      abortController.signal,
      (slope, out, oi) => {
        const { r, g, b } = _dem2slopeColor(slope, min, max, reliefStops);
        out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = 255;
      }
    );
    if (!outCanvas) return { data: _transparentPngBuffer() };
    const t1 = performance.now();

    const blob = await outCanvas.convertToBlob({ type: 'image/png' });
    const buf  = await blob.arrayBuffer();
    const t2 = performance.now();
    console.log(`[dem2slope] z${zoomLevel} ${tileX},${tileY} dem:${_demSrcLabel(demMode)} range:${min}~${max}° | fetch+calc:${(t1-t0).toFixed(0)}ms  blob:${(t2-t1).toFixed(0)}ms  total:${(t2-t0).toFixed(0)}ms`);
    return { data: buf };
  } catch {
    return { data: _transparentPngBuffer() };
  }
});

/*
  ========================================================
  傾斜データタイルプロトコル (slope-data://)
  傾斜角（0〜90度）を RGB 24bit にエンコードして返す。
  A=255: 有効値 / A=0: nodata
  描画時の着色は deck.gl 側シェーダーで行う。
  リサイズは nearest=true（数値データ保護）。
  ========================================================
*/
export async function generateSlopeDataTile(paramsUrl, abortSignal) {
  try {
    const request = _parseProtocolTileRequest(paramsUrl, 'slope-data');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;

    const qonly = urlObj.searchParams.get('qonly') === '1';
    const regionalBase = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const demMode = _slopeDemMode(zoomLevel, qonly);
    const effRegionalBase = demMode === null ? regionalBase : null;
    const effRegionalExt  = effRegionalBase ? ext : null;
    const effRegionalOrder = effRegionalBase ? tileOrder : 'xy';

    const t0 = performance.now();
    const outCanvas = await _buildSlopeTileCanvas(
      zoomLevel, tileX, tileY, demMode,
      effRegionalBase, effRegionalExt, effRegionalOrder,
      abortSignal,
      (slope, out, oi) => {
        const { r, g, b } = _encodeSlopeToRgb24(slope);
        out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = 255;
      },
      true // nearest: RGB24エンコードデータはバイリニア補間禁止
    );
    if (!outCanvas) return { data: _transparentPngBuffer() };
    const t1 = performance.now();

    const blob = await outCanvas.convertToBlob({ type: 'image/png' });
    const buf  = await blob.arrayBuffer();
    const t2 = performance.now();
    console.log(`[slope-data] z${zoomLevel} ${tileX},${tileY} dem:${_demSrcLabel(demMode)} | fetch+calc:${(t1-t0).toFixed(0)}ms  blob:${(t2-t1).toFixed(0)}ms  total:${(t2-t0).toFixed(0)}ms`);
    return { data: buf };
  } catch {
    return { data: _transparentPngBuffer() };
  }
}

maplibregl.addProtocol('slope-data', async (params, abortController) => {
  try {
    return await generateSlopeDataTile(params.url, abortController.signal);
  } catch {
    return { data: _transparentPngBuffer() };
  }
});

/*
  ========================================================
  色別標高図データタイルプロトコル (relief-data://)
  標高値（RELIEF_DATA_MIN〜RELIEF_DATA_MAX m）を RGB 24bit にエンコードして返す。
  A=255: 有効値 / A=0: nodata
  描画時の着色は deck.gl 側シェーダーで行う。
  ========================================================
*/
export async function generateReliefDataTile(paramsUrl, abortSignal) {
  try {
    const request = _parseProtocolTileRequest(paramsUrl, 'relief-data');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;
    const z = zoomLevel, x = tileX, y = tileY;

    const qonly = urlObj.searchParams.get('qonly') === '1';
    const regionalDemBase  = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const regionalDemExt   = regionalDemBase ? ext : null;
    const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';

    const demMode = qonly ? 'q'
                  : z <= 13 ? 'dem10b'
                  : z === 14 ? 'dem10b+dem5a'
                  : z === 15 ? 'dem10b+dem5a+q'
                  : null;
    const effectiveRegionalBase  = demMode === null ? regionalDemBase : null;
    const effectiveRegionalExt   = effectiveRegionalBase ? regionalDemExt : null;
    const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

    const t0 = performance.now();
    const bitmap = await fetchCompositeDemBitmap(
      z, x, y, abortSignal,
      effectiveRegionalBase, effectiveRegionalExt ?? 'png',
      demMode, effectiveRegionalOrder, null
    );
    if (!bitmap) return { data: _transparentPngBuffer() };

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if ((r === 128 && g === 0 && b === 0) || a !== 255) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        continue;
      }
      const height = _getNumpngHeight(r, g, b, a);
      const { r: er, g: eg, b: eb } = _encodeToRgb24(height, RELIEF_DATA_MIN, RELIEF_DATA_MAX);
      data[i] = er; data[i + 1] = eg; data[i + 2] = eb; data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    const t1 = performance.now();
    const blob = await _rescaleComposite(canvas, true).convertToBlob({ type: 'image/png' });
    const buf  = await blob.arrayBuffer();
    const t2   = performance.now();
    console.log(`[relief-data] z${z} ${x},${y} dem:${_demSrcLabel(demMode)} | fetch+calc:${(t1-t0).toFixed(0)}ms  blob:${(t2-t1).toFixed(0)}ms  total:${(t2-t0).toFixed(0)}ms`);
    return { data: buf };
  } catch {
    return { data: _transparentPngBuffer() };
  }
}

maplibregl.addProtocol('relief-data', async (params, abortController) => {
  try {
    return await generateReliefDataTile(params.url, abortController.signal);
  } catch {
    return { data: _transparentPngBuffer() };
  }
});

maplibregl.addProtocol('dem2relief', async (params, abortController) => {
  try {
    const request = _parseProtocolTileRequest(params.url, 'dem2relief');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;
    const z = zoomLevel, x = tileX, y = tileY;

    // クエリパラメータから min/max/palette を取得（デフォルト 0〜3000m・rainbow）
    const min = parseFloat(urlObj.searchParams.get('min') ?? '0');
    const max = parseFloat(urlObj.searchParams.get('max') ?? '3000');
    const range = max - min || 1; // ゼロ除算を防ぐ
    const reliefStops = _getReliefPaletteStops(urlObj.searchParams.get('palette') ?? 'rainbow');

    const regionalDemBase  = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const regionalDemExt   = regionalDemBase ? ext : null;
    const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';

    // ズーム別 DEMソース選択（CS/RRIMと同設計）:
    //   qonly=1: Q地図のみ / z≤13: DEM10Bのみ / z14: +DEM5A / z15: +Q地図1m / z≥16(null): +地域DEM
    const qonly = urlObj.searchParams.get('qonly') === '1';
    const demMode = qonly ? 'q'
                  : z <= 13 ? 'dem10b'
                  : z === 14 ? 'dem10b+dem5a'
                  : z === 15 ? 'dem10b+dem5a+q'
                  : null;
    const effectiveRegionalBase  = demMode === null ? regionalDemBase : null;
    const effectiveRegionalExt   = effectiveRegionalBase ? regionalDemExt : null;
    const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

    // データなし（海域・範囲外・404・CORS）の場合は透明タイルを返す
    // tileOutputSize=null: Q地図使用時は512px、DEM5A/10Bのみ時は256px（自動）
    const _reliefT0 = performance.now();
    const bitmap = await fetchCompositeDemBitmap(z, x, y, abortController.signal, effectiveRegionalBase, effectiveRegionalExt ?? 'png', demMode, effectiveRegionalOrder, null);
    if (!bitmap) return { data: _transparentPngBuffer() };
    const _reliefT1 = performance.now(); // fetch完了

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

      // NumPNG → 標高（メートル）変換は共通ヘルパーへ集約
      const height = _getNumpngHeight(r, g, b, a);

      // 相対正規化: min〜max を 0.0〜1.0 にクランプ（範囲外は端の色で塗る）
      const t = Math.max(0, Math.min(1, (height - min) / range));

      // パレット補間で RGB を決定し書き込み
      const col = _dem2reliefColor(t, reliefStops);
      data[i] = col.r; data[i + 1] = col.g; data[i + 2] = col.b; data[i + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    const _reliefT2 = performance.now(); // 色変換完了
    const reliefBlob = await _rescaleComposite(canvas).convertToBlob({ type: 'image/png' });
    const reliefArrayBuffer = await reliefBlob.arrayBuffer();
    const _reliefT3 = performance.now();
    const _reliefDemSrcs = demMode === null            ? 'R+Q+5A+10B'
      : demMode === 'dem10b+dem5a+q' ? 'Q+5A+10B'
      : demMode === 'dem10b+dem5a'   ? '5A+10B'
      : demMode === 'q'             ? 'Q'
      : '10B';
    console.log(
      `[dem2relief] z${z} ${x},${y} dem:${_reliefDemSrcs} range:${min}~${max}m | ` +
      `fetch:${(_reliefT1-_reliefT0).toFixed(0)}ms  ` +
      `colorize:${(_reliefT2-_reliefT1).toFixed(0)}ms  ` +
      `blob:${(_reliefT3-_reliefT2).toFixed(0)}ms  ` +
      `total:${(_reliefT3-_reliefT0).toFixed(0)}ms`
    );
    return { data: reliefArrayBuffer };

  } catch {
    // いかなるエラーでも透明タイルを返してレンダリングループを保護する
    return { data: _transparentPngBuffer() };
  }
});

/*
  ========================================================
  色別曲率プロトコル (dem2curve://)
  CS立体図 (dem2cs://) の曲率計算（Laplacian フィルタ）を再利用し、
  曲率を色別に可視化するオーバーレイを生成します。

  アルゴリズム:
    1. 9タイル結合 + ガウシアン平滑化（CS立体図と同じ手順）
    2. 平滑化済み DEM に Laplacian フィルタ → 曲率テンソル cT
    3. cT を min〜max の範囲で 0〜1 に正規化 → パレット補間で RGB 着色

  URLクエリパラメータ:
    min: 曲率の下限値（1/m スケールを cc 乗数調整後、デフォルト -1.0）
    max: 曲率の上限値（同上、デフォルト +1.0）
    terrainScale: CS立体図と同じスケール係数（デフォルト 1）
  ========================================================
*/

// 色別曲率スライダー用のガウシアンカーネルキャッシュ（CS立体図共用の _csKernelCache を流用）
// — _csKernelCache は同一モジュールスコープに定義済みのため追加不要 —

maplibregl.addProtocol('dem2curve', async (params, abortController) => {
  try {
    if (_tfContextLost) return { data: _transparentPngBuffer() };
    const request = _parseProtocolTileRequest(params.url, 'dem2curve');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;

    const terrainScale = Math.max(parseFloat(urlObj.searchParams.get('terrainScale') ?? '1') || 1, 0.1);
    // min/max は「正規化後の曲率スケール（cc 補正後）」で指定（デフォルト -1〜+1）
    const curveMin = parseFloat(urlObj.searchParams.get('min') ?? '-1.0');
    const curveMax = parseFloat(urlObj.searchParams.get('max') ??  '1.0');
    const curveRange = (curveMax - curveMin) || 1;
    const reliefStops = _getReliefPaletteStops(urlObj.searchParams.get('palette') ?? 'rainbow');

    const regionalDemBase = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const regionalDemExt  = regionalDemBase ? ext : null;
    const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';

    // ズーム別 DEMソース選択（CS/RRIMと同設計）:
    //   qonly=1: Q地図のみ / z≤13: DEM10Bのみ / z14: +DEM5A / z15: +Q地図1m / z≥16(null): +地域DEM
    const qonly = urlObj.searchParams.get('qonly') === '1';
    const demMode = qonly ? 'q'
                  : zoomLevel <= 13 ? 'dem10b'
                  : zoomLevel === 14 ? 'dem10b+dem5a'
                  : zoomLevel === 15 ? 'dem10b+dem5a+q'
                  : null;
    const effectiveRegionalBase  = demMode === null ? regionalDemBase : null;
    const effectiveRegionalExt   = effectiveRegionalBase ? regionalDemExt : null;
    const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

    // ── ① 9タイル取得（CS立体図と同じ） ──
    // tileOutputSize=null: Q地図使用時は512px、DEM5A/10Bのみ時は256px（自動）
    const _curveT0 = performance.now();
    const neighborOffsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0], [0,  0], [1,  0],
      [-1,  1], [0,  1], [1,  1],
    ];
    const bitmaps = await Promise.all(neighborOffsets.map(([dx, dy]) =>
      fetchCompositeDemBitmap(
        zoomLevel, tileX + dx, tileY + dy,
        abortController.signal,
        effectiveRegionalBase, effectiveRegionalExt,
        demMode, effectiveRegionalOrder, null
      )
    ));
    if (!bitmaps[4]) return { data: _transparentPngBuffer() };

    const tileSize    = bitmaps[4].width;
    const pixelLength = _calculatePixelResolution(tileSize, zoomLevel, tileY);

    // ガウシアンパラメータ（CS立体図と同じ）
    const sigma       = Math.min(Math.max(3 / pixelLength, 1.6), 7) * terrainScale;
    const kernelRadius = Math.ceil(sigma * 3);
    const buffer      = kernelRadius + 1;
    const mergedSize  = tileSize + buffer * 2;

    // ── ② 9タイル結合 ──
    const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
    const mc = mergedCanvas.getContext('2d');
    bitmaps.forEach((bmp, idx) => {
      if (!bmp) return;
      if (idx === 4) {
        mc.drawImage(bmp, 0, 0, tileSize, tileSize, buffer, buffer, tileSize, tileSize);
      } else {
        const { sx, sy, sWidth: sw, sHeight: sh, dx, dy } = _calculateTilePosition(idx, tileSize, buffer);
        mc.drawImage(bmp, sx, sy, sw, sh, dx, dy, sw, sh);
      }
      bmp.close();
    });

    // ── ③ 標高配列生成 ──
    const mergedPx = mc.getImageData(0, 0, mergedSize, mergedSize).data;
    const mergedHeights = new Float32Array(mergedSize * mergedSize);
    for (let i = 0; i < mergedHeights.length; i++) {
      const p = i * 4;
      mergedHeights[i] = _getNumpngHeight(mergedPx[p], mergedPx[p + 1], mergedPx[p + 2], mergedPx[p + 3]);
    }

    // nodata マスク（アルファ値用）
    const centerAlpha = new Float32Array(tileSize * tileSize);
    for (let row = 0; row < tileSize; row++) {
      for (let col = 0; col < tileSize; col++) {
        const mi = (row + buffer) * mergedSize + (col + buffer);
        centerAlpha[row * tileSize + col] = mergedHeights[mi] === -99999 ? 0 : 255;
      }
    }

    // ── ④ GPU 計算（セマフォ取得） ──
    if (abortController.signal.aborted) throw new DOMException('Tile request aborted', 'AbortError');
    await _acquireGpuTransfer();
    if (abortController.signal.aborted) { _releaseGpuTransfer(); throw new DOMException('Tile request aborted', 'AbortError'); }
    let _curveGpuReleased = false;
    try {

    // ── ⑤ ガウシアン平滑化（分離畳み込み: CS立体図と同一ロジック） ──
    const { kX: kX2, kY: kY2 } = _getCsKernel(kernelRadius, sigma);
    const hT   = tf.tensor2d(mergedHeights, [mergedSize, mergedSize]);
    const valid   = hT.notEqual(-99999);
    const masked  = tf.where(valid, hT, 0);
    const validF2 = valid.cast('float32');
    // 水平パス
    const maskedH2 = tf.conv2d(masked.expandDims(2).expandDims(0), kX2, 1, 'valid').squeeze([0, 3]);
    const validH2  = tf.conv2d(validF2.expandDims(2).expandDims(0), kX2, 1, 'valid').squeeze([0, 3]);
    masked.dispose(); validF2.dispose();
    // 垂直パス
    const maskedHV2 = tf.conv2d(maskedH2.expandDims(2).expandDims(0), kY2, 1, 'valid').squeeze([0, 3]);
    const kSum2     = tf.conv2d(validH2.expandDims(2).expandDims(0), kY2, 1, 'valid').squeeze([0, 3]);
    maskedH2.dispose(); validH2.dispose();
    const sHRaw   = maskedHV2.div(kSum2);
    maskedHV2.dispose(); kSum2.dispose();
    const validCrop = valid.slice([buffer, buffer], [tileSize + 2, tileSize + 2]);
    const smoothedT = tf.where(validCrop, sHRaw, tf.zerosLike(sHRaw));
    [sHRaw, validCrop].forEach(t => t.dispose());

    // cc 係数（CS立体図と同一; terrainScale のみ適用・redAndBlueIntensity は 1 固定）
    const cc = pixelLength < 68
      ? Math.max(pixelLength / 2, 1.1) * Math.sqrt(terrainScale)
      : 0.188 * Math.pow(pixelLength, 1.232) * Math.sqrt(terrainScale);

    // ── ⑤ 曲率計算 + カラーリング（tf.tidy） ──
    const curvatureTensor = tf.tidy(() => {
      const cellArea  = pixelLength * pixelLength;

      // Laplacian → 曲率 cT（CS立体図と同じカーネル）
      const lapKernel = tf.tensor4d([0, 1, 0, 1, -4, 1, 0, 1, 0], [3, 3, 1, 1]);
      const smoothIn  = smoothedT.expandDims(0).expandDims(-1);
      const cT = tf.conv2d(smoothIn, lapKernel, 1, 'valid').squeeze([0, 3]).neg().div(cellArea);

      // cT を cc スケールで正規化 → min〜max を 0〜1 にクランプしてパレット着色
      // （CS立体図の L4 と同じスケール: cT / cc）
      const cTscaled = cT.div(cc); // 1/m 相当の正規化曲率

      // 0〜1 の正規化値
      const n = cTscaled.sub(curveMin).div(curveRange).clipByValue(0, 1);

      // パレット は _dem2reliefColor 相当を GPU で計算（piecewise 線形補間）
      const P     = reliefStops.map(s => [s.r, s.g, s.b]);
      const tStops = reliefStops.map(s => s.t);

      let r = tf.zerosLike(n);
      let g = tf.zerosLike(n);
      let b = tf.zerosLike(n);
      for (let i = 0; i < P.length - 1; i++) {
        const t0 = tStops[i], t1 = tStops[i + 1];
        const [r0, g0, b0] = P[i];
        const [r1, g1, b1] = P[i + 1];
        const seg = n.sub(t0).div(t1 - t0).clipByValue(0, 1);
        const inSeg = n.greaterEqual(t0).logicalAnd(n.less(t1)).cast('float32');
        const rSeg = seg.mul(r1 - r0).add(r0).mul(inSeg);
        const gSeg = seg.mul(g1 - g0).add(g0).mul(inSeg);
        const bSeg = seg.mul(b1 - b0).add(b0).mul(inSeg);
        const rNext = r.add(rSeg); r.dispose(); r = rNext;
        const gNext = g.add(gSeg); g.dispose(); g = gNext;
        const bNext = b.add(bSeg); b.dispose(); b = bNext;
      }
      // n=1.0 の端点を加算
      const atEnd  = n.greaterEqual(1.0).cast('float32');
      const rFinal = r.add(tf.scalar(P[P.length - 1][0]).mul(atEnd));
      const gFinal = g.add(tf.scalar(P[P.length - 1][1]).mul(atEnd));
      const bFinal = b.add(tf.scalar(P[P.length - 1][2]).mul(atEnd));

      // nodata → アルファ 0
      const hCrop  = hT.slice([buffer, buffer], [tileSize, tileSize]);
      const alphaT = tf.where(hCrop.notEqual(-99999), tf.scalar(255), tf.scalar(0))
        .reshape([tileSize, tileSize, 1]);

      const rgb = tf.stack([rFinal.round(), gFinal.round(), bFinal.round()], -1);
      return tf.concat([rgb, alphaT], -1);
    });
    [hT, valid, smoothedT].forEach(t => t.dispose());

    // ── ⑥ 出力 ──
    const outCanvas = new OffscreenCanvas(tileSize, tileSize);
    const cvNorm    = curvatureTensor.div(255);
    await tf.browser.toPixels(cvNorm, outCanvas);
    cvNorm.dispose();
    curvatureTensor.dispose();
    _releaseGpuTransfer();
    _curveGpuReleased = true;
    const _curveT1 = performance.now(); // GPU完了
    const curveArrayBuffer = await _rescaleComposite(outCanvas).convertToBlob({ type: 'image/webp', quality: 0.92 }).then(b => b.arrayBuffer());
    const _curveT2 = performance.now();
    const _curveDemSrcs = demMode === null            ? 'R+Q+5A+10B'
      : demMode === 'dem10b+dem5a+q' ? 'Q+5A+10B'
      : demMode === 'dem10b+dem5a'   ? '5A+10B'
      : demMode === 'q'             ? 'Q'
      : '10B';
    console.log(
      `[dem2curve] z${zoomLevel} ${tileX},${tileY} dem:${_curveDemSrcs} range:${curveMin}~${curveMax} | ` +
      `fetch:${(_curveT1-_curveT0).toFixed(0)}ms  ` +
      `blob:${(_curveT2-_curveT1).toFixed(0)}ms  ` +
      `total:${(_curveT2-_curveT0).toFixed(0)}ms`
    );
    return { data: curveArrayBuffer };
    } finally {
      if (!_curveGpuReleased) _releaseGpuTransfer();
    }
  } catch(e) {
    if (e?.name === 'AbortError') throw e;
    return { data: _transparentPngBuffer() };
  }
});

/*
  ========================================================
  色別曲率データタイルプロトコル (curve-data://)
  曲率値（CURVE_DATA_MIN〜CURVE_DATA_MAX の cTscaled）を RGB 24bit にエンコードして返す。
  A=255: 有効値 / A=0: nodata
  描画時の着色は deck.gl 側シェーダーで行う。
  dem2curve と同じ TF.js 演算だが、着色せず Float32 → RGB24 エンコードに変更。
  ========================================================
*/
export async function generateCurveDataTile(paramsUrl, abortSignal) {
  try {
    if (_tfContextLost) return { data: _transparentPngBuffer() };
    const request = _parseProtocolTileRequest(paramsUrl, 'curve-data');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;

    const terrainScale = Math.max(parseFloat(urlObj.searchParams.get('terrainScale') ?? '1') || 1, 0.1);
    const qonly = urlObj.searchParams.get('qonly') === '1';
    const regionalDemBase  = (baseUrl === QCHIZU_DEM_BASE) ? null : baseUrl;
    const regionalDemExt   = regionalDemBase ? ext : null;
    const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';

    const demMode = qonly ? 'q'
                  : zoomLevel <= 13 ? 'dem10b'
                  : zoomLevel === 14 ? 'dem10b+dem5a'
                  : zoomLevel === 15 ? 'dem10b+dem5a+q'
                  : null;
    const effectiveRegionalBase  = demMode === null ? regionalDemBase : null;
    const effectiveRegionalExt   = effectiveRegionalBase ? regionalDemExt : null;
    const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

    // ── ① 9タイル取得（dem2curve と同じ） ──
    const t0 = performance.now();
    const neighborOffsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0], [0,  0], [1,  0],
      [-1,  1], [0,  1], [1,  1],
    ];
    const bitmaps = await Promise.all(neighborOffsets.map(([dx, dy]) =>
      fetchCompositeDemBitmap(
        zoomLevel, tileX + dx, tileY + dy, abortSignal,
        effectiveRegionalBase, effectiveRegionalExt,
        demMode, effectiveRegionalOrder, null
      )
    ));
    if (!bitmaps[4]) return { data: _transparentPngBuffer() };

    const tileSize    = bitmaps[4].width;
    const pixelLength = _calculatePixelResolution(tileSize, zoomLevel, tileY);
    const sigma        = Math.min(Math.max(3 / pixelLength, 1.6), 7) * terrainScale;
    const kernelRadius = Math.ceil(sigma * 3);
    const buffer       = kernelRadius + 1;
    const mergedSize   = tileSize + buffer * 2;

    // ── ② 9タイル結合 ──
    const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
    const mc = mergedCanvas.getContext('2d');
    bitmaps.forEach((bmp, idx) => {
      if (!bmp) return;
      if (idx === 4) {
        mc.drawImage(bmp, 0, 0, tileSize, tileSize, buffer, buffer, tileSize, tileSize);
      } else {
        const { sx, sy, sWidth: sw, sHeight: sh, dx, dy } = _calculateTilePosition(idx, tileSize, buffer);
        mc.drawImage(bmp, sx, sy, sw, sh, dx, dy, sw, sh);
      }
      bmp.close();
    });

    // ── ③ 標高配列生成 ──
    const mergedPx = mc.getImageData(0, 0, mergedSize, mergedSize).data;
    const mergedHeights = new Float32Array(mergedSize * mergedSize);
    for (let i = 0; i < mergedHeights.length; i++) {
      const p = i * 4;
      mergedHeights[i] = _getNumpngHeight(mergedPx[p], mergedPx[p + 1], mergedPx[p + 2], mergedPx[p + 3]);
    }

    // ── ④ GPU 計算（セマフォ取得） ──
    if (abortSignal?.aborted) throw new DOMException('Tile request aborted', 'AbortError');
    await _acquireGpuTransfer();
    if (abortSignal?.aborted) { _releaseGpuTransfer(); throw new DOMException('Tile request aborted', 'AbortError'); }
    let _gpuReleased = false;
    try {
      // ── ⑤ ガウシアン平滑化（dem2curve と同一ロジック） ──
      const { kX, kY } = _getCsKernel(kernelRadius, sigma);
      const hT     = tf.tensor2d(mergedHeights, [mergedSize, mergedSize]);
      const valid  = hT.notEqual(-99999);
      const masked = tf.where(valid, hT, 0);
      const validF = valid.cast('float32');
      const maskedH = tf.conv2d(masked.expandDims(2).expandDims(0), kX, 1, 'valid').squeeze([0, 3]);
      const validH  = tf.conv2d(validF.expandDims(2).expandDims(0), kX, 1, 'valid').squeeze([0, 3]);
      masked.dispose(); validF.dispose();
      const maskedHV = tf.conv2d(maskedH.expandDims(2).expandDims(0), kY, 1, 'valid').squeeze([0, 3]);
      const kSum     = tf.conv2d(validH.expandDims(2).expandDims(0), kY, 1, 'valid').squeeze([0, 3]);
      maskedH.dispose(); validH.dispose();
      const sHRaw    = maskedHV.div(kSum);
      maskedHV.dispose(); kSum.dispose();
      const validCrop = valid.slice([buffer, buffer], [tileSize + 2, tileSize + 2]);
      const smoothedT = tf.where(validCrop, sHRaw, tf.zerosLike(sHRaw));
      [sHRaw, validCrop].forEach(t => t.dispose());

      const cc = pixelLength < 68
        ? Math.max(pixelLength / 2, 1.1) * Math.sqrt(terrainScale)
        : 0.188 * Math.pow(pixelLength, 1.232) * Math.sqrt(terrainScale);

      // ── ⑥ Laplacian → cTscaled (Float32) を GPU から取得 ──
      const cellArea  = pixelLength * pixelLength;
      const lapKernel = tf.tensor4d([0, 1, 0, 1, -4, 1, 0, 1, 0], [3, 3, 1, 1]);
      const cT = tf.conv2d(
        smoothedT.expandDims(0).expandDims(-1), lapKernel, 1, 'valid'
      ).squeeze([0, 3]).neg().div(cellArea);
      lapKernel.dispose(); smoothedT.dispose();
      const cTscaled = cT.div(cc);
      cT.dispose();
      const hCrop = hT.slice([buffer, buffer], [tileSize, tileSize]);

      // GPU→CPU 転送（Float32）— 着色はすべて CPU で行う
      const [cTscaledData, hCropData] = await Promise.all([cTscaled.data(), hCrop.data()]);
      cTscaled.dispose(); hCrop.dispose();
      [hT, valid].forEach(t => t.dispose());

      _releaseGpuTransfer();
      _gpuReleased = true;

      // ── ⑦ CPU エンコード（RGB 24bit） ──
      const outCanvas = new OffscreenCanvas(tileSize, tileSize);
      const outCtx    = outCanvas.getContext('2d');
      const outId     = outCtx.createImageData(tileSize, tileSize);
      const out       = outId.data;
      for (let i = 0; i < tileSize * tileSize; i++) {
        const oi = i * 4;
        if (hCropData[i] === -99999) { out[oi + 3] = 0; continue; }
        const { r, g, b } = _encodeToRgb24(cTscaledData[i], CURVE_DATA_MIN, CURVE_DATA_MAX);
        out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = 255;
      }
      outCtx.putImageData(outId, 0, 0);

      const t1 = performance.now();
      const blob = await _rescaleComposite(outCanvas, true).convertToBlob({ type: 'image/png' });
      const buf  = await blob.arrayBuffer();
      const t2   = performance.now();
      console.log(`[curve-data] z${zoomLevel} ${tileX},${tileY} dem:${_demSrcLabel(demMode)} | fetch+calc:${(t1-t0).toFixed(0)}ms  blob:${(t2-t1).toFixed(0)}ms  total:${(t2-t0).toFixed(0)}ms`);
      return { data: buf };
    } finally {
      if (!_gpuReleased) _releaseGpuTransfer();
    }
  } catch(e) {
    if (e?.name === 'AbortError') throw e;
    return { data: _transparentPngBuffer() };
  }
}

maplibregl.addProtocol('curve-data', async (params, abortController) => {
  try {
    return await generateCurveDataTile(params.url, abortController.signal);
  } catch {
    return { data: _transparentPngBuffer() };
  }
});


/*
  ========================================================
  赤色立体地図プロトコル (dem2rrim://)
  MPI（Morphometric Protection Index）と傾斜を組み合わせた赤色立体地図。
  参考: Kaneda & Chiba (2019) / https://github.com/yiwasa/Stereo-MPI-RRIM-Creator

  アルゴリズム:
    1. 8方向 × radius ステップの最大接線勾配を tf.roll でベクトル化 → arctan → 8方向平均 = MPI
    2. 傾斜: Sobelフィルタで中央差分 → atan(sqrt(dzdx² + dzdy²))
    3. RGB合成（乗算ブレンド）:
         傾斜レイヤー: 急傾斜ほど赤（白→赤）
         MPIレイヤー:  凹地ほどシアン RGB(18,112,121)（白→シアン）
    全計算をGPUで実行。CPU往復なし。
  ========================================================
*/

// MPI 探索半径（固定ピクセル数）— 品質とパフォーマンスのバランス
const RRIM_RADIUS = 10;
// 8方向 [dirY, dirX]: 行(↓+) × 列(→+)
const _RRIM_DIRS = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]];

maplibregl.addProtocol('dem2rrim', async (params, abortController) => {
  try {
    if (_tfContextLost) return { data: _transparentPngBuffer() };
    const request = _parseProtocolTileRequest(params.url, 'dem2rrim');
    if (!request) return { data: _transparentPngBuffer() };
    const { urlObj, baseUrl, tileOrder, zoomLevel, tileX, tileY, ext } = request;

    const regionalDemBase  = baseUrl === QCHIZU_DEM_BASE ? null : baseUrl;
    const regionalDemExt   = regionalDemBase ? ext : null;
    const regionalDemOrder = regionalDemBase ? tileOrder : 'xy';
    // ズーム別 DEMソース選択（demModeで一元管理）:
    //   qonly=1: Q地図のみ / z≤13: DEM10Bのみ / z14: +DEM5A / z15: +Q地図1m / z≥16(null): +地域DEM
    const qonly = urlObj.searchParams.get('qonly') === '1';
    const demMode = qonly ? 'q'
                  : zoomLevel <= 13 ? 'dem10b'
                  : zoomLevel === 14 ? 'dem10b+dem5a'
                  : zoomLevel === 15 ? 'dem10b+dem5a+q'
                  : null;
    // demMode === null（z≥16）のみ地域DEMを使用
    const effectiveRegionalBase  = demMode === null ? regionalDemBase : null;
    const effectiveRegionalExt   = effectiveRegionalBase ? regionalDemExt : null;
    const effectiveRegionalOrder = effectiveRegionalBase ? regionalDemOrder : 'xy';

    // buffer は radius 以上（tf.roll のシフトがはみ出ない最小サイズ）
    const radius = RRIM_RADIUS;
    const buffer = radius + 1;

    const _rrimT0 = performance.now();

    // ── ① 9タイル並列取得 ──
    const neighborOffsets = [
      [-1,-1],[0,-1],[1,-1],
      [-1, 0],[0, 0],[1, 0],
      [-1, 1],[0, 1],[1, 1],
    ];
    const bitmaps = await Promise.all(neighborOffsets.map(([dx, dy]) =>
      fetchCompositeDemBitmap(
        zoomLevel, tileX + dx, tileY + dy,
        abortController.signal,
        effectiveRegionalBase, effectiveRegionalExt,
        demMode, effectiveRegionalOrder
      )
    ));
    if (!bitmaps[4]) return { data: _transparentPngBuffer() };
    const _rrimT1 = performance.now(); // fetch完了

    const tileSize = bitmaps[4].width;
    const pixelLength = _calculatePixelResolution(tileSize, zoomLevel, tileY);
    const mergedSize  = tileSize + buffer * 2;

    // ── ② 9タイル結合 ──
    // Q地図カバレッジ境界では隣接タイルのサイズが中央タイルと異なる場合がある（512px vs 256px）。
    // サイズ不一致のタイルは NN でリスケールして統一する（NumPNG の高度値を保護するため NN 必須）。
    const mergedCanvas = new OffscreenCanvas(mergedSize, mergedSize);
    const mc = mergedCanvas.getContext('2d');
    bitmaps.forEach((bmp, idx) => {
      if (!bmp) return;
      if (idx === 4) {
        mc.drawImage(bmp, 0, 0, tileSize, tileSize, buffer, buffer, tileSize, tileSize);
        bmp.close();
      } else {
        // Q地図カバレッジ境界では隣接タイルが中央と異なるサイズになる場合がある。
        // NN でリスケールして統一（NumPNG 高度値保護のため NN 必須）。
        let src = bmp;
        if (bmp.width !== tileSize) {
          const tmpCv = new OffscreenCanvas(tileSize, tileSize);
          const tmpCtx = tmpCv.getContext('2d');
          tmpCtx.imageSmoothingEnabled = false;
          tmpCtx.drawImage(bmp, 0, 0, tileSize, tileSize);
          bmp.close();
          src = tmpCv; // OffscreenCanvas は close 不要
        }
        const { sx, sy, sWidth: sw, sHeight: sh, dx, dy } = _calculateTilePosition(idx, tileSize, buffer);
        mc.drawImage(src, sx, sy, sw, sh, dx, dy, sw, sh);
        if (src === bmp) bmp.close(); // リスケールしなかった場合のみ close
      }
    });

    // ── ③ NumPNG → Float32Array ──
    const mergedPx = mc.getImageData(0, 0, mergedSize, mergedSize).data;
    const mergedHeights = new Float32Array(mergedSize * mergedSize);
    for (let i = 0; i < mergedHeights.length; i++) {
      const p = i * 4;
      mergedHeights[i] = _getNumpngHeight(mergedPx[p], mergedPx[p + 1], mergedPx[p + 2], mergedPx[p + 3]);
    }
    const _rrimT2 = performance.now(); // merge+decode完了

    // ── ④ MPI 計算（全GPU、CPU往復なし） ──
    // tf.roll は TF.js 4.x に存在しないため、tf.slice で「r ステップ先の中央領域」を切り出して代用。
    // buffer >= radius なので境界折り返しは発生しない。
    const demTensor = tf.tensor2d(mergedHeights, [mergedSize, mergedSize]);
    const validMask = demTensor.notEqual(-99999);
    // nodata を 0 埋め（隣接nodata域の MPI への影響を最小化）
    const demFilled = tf.tidy(() => tf.where(validMask, demTensor, tf.zerosLike(demTensor)));
    // 中央タイル領域の基準スライス [buffer, buffer] サイズ [tileSize, tileSize]
    const demCenter = tf.tidy(() => demFilled.slice([buffer, buffer], [tileSize, tileSize]));

    let mpiSum = null;
    for (const [dirY, dirX] of _RRIM_DIRS) {
      // この方向の1ステップあたりの実距離
      const distUnit = Math.sqrt((dirX * pixelLength) ** 2 + (dirY * pixelLength) ** 2);
      let maxTan = null;
      for (let r = 1; r <= radius; r++) {
        // r ステップ先の領域を slice で切り出す（buffer のおかげで範囲外にならない）
        const offY = buffer + r * dirY;
        const offX = buffer + r * dirX;
        const tangent = tf.tidy(() =>
          demFilled.slice([offY, offX], [tileSize, tileSize])
            .sub(demCenter).div(r * distUnit)
        );
        if (maxTan === null) {
          maxTan = tangent;
        } else {
          const next = tf.maximum(maxTan, tangent);
          maxTan.dispose(); tangent.dispose();
          maxTan = next;
        }
      }
      const atanDir = tf.atan(maxTan); // この方向の最大仰角
      maxTan.dispose();
      if (mpiSum === null) {
        mpiSum = atanDir;
      } else {
        const next = mpiSum.add(atanDir);
        mpiSum.dispose(); atanDir.dispose();
        mpiSum = next;
      }
    }
    const mpiTensor = mpiSum.div(8); // 8方向平均
    mpiSum.dispose();
    const _rrimT3 = performance.now(); // MPI GPU完了

    // ── ⑤ RRIM RGB合成（全GPU、Sobel傾斜 + MPI + tf.tidy） ──
    const rrimTensor = tf.tidy(() => {
      const HALF_PI = Math.PI / 2;

      // 傾斜: Sobel（中央差分）→ atan(|∇h|) in radians
      const rawCrop = tf.where(
        validMask.slice([buffer - 1, buffer - 1], [tileSize + 2, tileSize + 2]),
        demTensor.slice([buffer - 1, buffer - 1], [tileSize + 2, tileSize + 2]),
        tf.zeros([tileSize + 2, tileSize + 2])
      );
      const rawIn  = rawCrop.expandDims(0).expandDims(-1);
      const sobelX = tf.tensor4d([-1, 0, 1, -2, 0, 2, -1, 0, 1], [3, 3, 1, 1]);
      const sobelY = tf.tensor4d([-1, -2, -1, 0, 0, 0, 1, 2, 1], [3, 3, 1, 1]);
      const dzdx   = tf.conv2d(rawIn, sobelX, 1, 'valid').squeeze([0, 3]).div(8 * pixelLength);
      const dzdy   = tf.conv2d(rawIn, sobelY, 1, 'valid').squeeze([0, 3]).div(8 * pixelLength);
      const slopeT = tf.atan(dzdx.square().add(dzdy.square()).sqrt()); // radians

      // mpiTensor はすでに [tileSize, tileSize]（demCenter と同サイズ）
      const mpiCrop = mpiTensor;

      // 傾斜正規化: 0〜1、gamma=0.8
      const vSlope      = slopeT.div(HALF_PI).clipByValue(0, 1).pow(0.8);
      const vSlopeColor = vSlope.mul(1.3).clipByValue(0, 1); // 色計算用に1.3倍強調

      // MPI正規化: 0〜1（mpi_max=1.0rad、gamma=1.0、×1.5増幅）
      const vMpi = mpiCrop.clipByValue(0, 1.0).mul(1.5).clipByValue(0, 1);

      // 傾斜レイヤー（急傾斜ほど赤: 白→赤）
      const rSlope = tf.scalar(255).sub(vSlope.mul(0.1 * 255));
      const gSlope = tf.scalar(255).sub(vSlopeColor.mul(255));
      const bSlope = tf.scalar(255).sub(vSlopeColor.mul(255));

      // MPIレイヤー（凹地ほどシアン: 白→RGB(18,112,121)）
      const rMpi = tf.scalar(255).add(vMpi.mul(18  - 255));
      const gMpi = tf.scalar(255).add(vMpi.mul(112 - 255));
      const bMpi = tf.scalar(255).add(vMpi.mul(121 - 255));

      // 乗算合成（Multiply blend = 白ベースに2レイヤーを掛け合わせ）
      const rOut = rSlope.mul(rMpi).div(255).clipByValue(0, 255).round();
      const gOut = gSlope.mul(gMpi).div(255).clipByValue(0, 255).round();
      const bOut = bSlope.mul(bMpi).div(255).clipByValue(0, 255).round();

      // nodata → アルファ 0
      const hCrop  = demTensor.slice([buffer, buffer], [tileSize, tileSize]);
      const alphaT = tf.where(hCrop.notEqual(-99999), tf.scalar(255), tf.scalar(0))
        .reshape([tileSize, tileSize, 1]);
      return tf.concat([tf.stack([rOut, gOut, bOut], -1), alphaT], -1);
    });
    [demTensor, validMask, demFilled, demCenter, mpiTensor].forEach(t => t.dispose());
    const _rrimT4 = performance.now(); // RRIM合成完了

    // ── ⑥ 出力（toPixelsまでセマフォ制御・blob変換はCPUなので解放後に実行）──
    const outCanvas = new OffscreenCanvas(tileSize, tileSize);
    const rrimNorm = rrimTensor.div(255);
    if (abortController.signal.aborted) throw new DOMException('Tile request aborted', 'AbortError');
    await _acquireGpuTransfer();
    if (abortController.signal.aborted) { _releaseGpuTransfer(); throw new DOMException('Tile request aborted', 'AbortError'); }
    const _rrimT4b = performance.now(); // セマフォ取得完了（wait終了）
    let rrimArrayBuffer;
    let _rrimGpuReleased = false;
    try {
      await tf.browser.toPixels(rrimNorm, outCanvas);
      rrimNorm.dispose();
      rrimTensor.dispose();
      const _rrimT5 = performance.now(); // toPixels完了
      _releaseGpuTransfer(); // blob変換はCPU処理なのでGPUスロットを即返却
      _rrimGpuReleased = true;
      const rrimBlob = await _rescaleComposite(outCanvas).convertToBlob({ type: 'image/webp', quality: 0.92 });
      rrimArrayBuffer = await rrimBlob.arrayBuffer();
      const _rrimT6 = performance.now();
      const _rrimDemSrcs = demMode === null              ? 'R+Q+5A+10B'
        : demMode === 'dem10b+dem5a+q'   ? 'Q+5A+10B'
        : demMode === 'dem10b+dem5a'     ? '5A+10B'
        : demMode === 'q'               ? 'Q'
        : '10B';
      console.log(
        `[dem2rrim] z${zoomLevel} ${tileX},${tileY} dem:${_rrimDemSrcs} | ` +
        `fetch:${(_rrimT1-_rrimT0).toFixed(0)}ms  ` +
        `merge+decode:${(_rrimT2-_rrimT1).toFixed(0)}ms  ` +
        `GPU(MPI 8dir×${RRIM_RADIUS}step):${(_rrimT3-_rrimT2).toFixed(0)}ms  ` +
        `GPU(sobel+rrim):${(_rrimT4-_rrimT3).toFixed(0)}ms  ` +
        `wait:${(_rrimT4b-_rrimT4).toFixed(0)}ms  ` +
        `toPixels:${(_rrimT5-_rrimT4b).toFixed(0)}ms  ` +
        `blob:${(_rrimT6-_rrimT5).toFixed(0)}ms  ` +
        `total:${(_rrimT6-_rrimT0).toFixed(0)}ms`
      );
    } finally {
      if (!_rrimGpuReleased) _releaseGpuTransfer(); // エラー時のフォールバック解放
    }
    return { data: rrimArrayBuffer };
  } catch(e) {
    if (e?.name === 'AbortError') throw e;
    return { data: _transparentPngBuffer() };
  }
});


// ================================================================
// TF.js WebGL コンテキストロスト自動回復
// GPU 圧迫で全 WebGL コンテキストが失われた後、MapLibre は自動復元するが
// TF.js は古い（無効な）コンテキストを掴み続けるため CS/RRIM が無音で失敗し続ける。
// webglcontextrestored でカーネルキャッシュを破棄し TF.js バックエンドを再初期化する。
// ================================================================
let _tfContextLost = false;

tf.ready().then(() => {
  const gl = tf.backend()?.gpgpu?.gl;
  if (!gl) return; // CPU バックエンドのとき不要

  gl.canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); // ブラウザにコンテキスト復元を促す
    _tfContextLost = true;
    console.warn('[protocols] TF.js WebGL コンテキストロスト');
  });

  gl.canvas.addEventListener('webglcontextrestored', async () => {
    console.warn('[protocols] TF.js WebGL 復元 → バックエンド再初期化中...');
    // 旧コンテキストで作成したカーネルキャッシュを破棄（そのまま使うと GPU エラー）
    for (const { kX, kY } of _csKernelCache.values()) {
      try { kX.dispose(); kY.dispose(); } catch { /* 無視 */ }
    }
    _csKernelCache.clear();
    try {
      await tf.setBackend('cpu');   // いったん CPU に退避
      await tf.setBackend('webgl'); // 新しい WebGL コンテキストで再初期化
      _tfContextLost = false;
      console.log('[protocols] TF.js 再初期化完了');
    } catch (e) {
      console.error('[protocols] TF.js 再初期化失敗:', e);
    }
  });
});

export { fetchCompositeDemBitmap };

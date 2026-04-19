/**
 * magneticDeclination.js — 磁気偏角計算モジュール
 *
 * モデル選択:
 *   'wmm2020' — geomag@1.0.0 (WMM2020・2020-2025年有効、グローバル変数 geomag)
 *   'wmm2025' — magvar@2.0.1 (WMM2025・2025-2030年有効、esm.sh 経由で動的ロード)
 *   'gsi2020' — 国土地理院 2020.0年値 2次近似式（日本国内専用・±数分精度）
 *               範囲外（日本域外）は wmm2025 にフォールバック
 *
 * 使い方:
 *   await setDeclinationModel('wmm2025'); // モデルを切り替える（初回はロード待機）
 *   const deg = getDeclination(lat, lng); // 偏角（度）を取得
 */

// 現在のモデル（デフォルト: wmm2020 で既存動作を維持）
let _model = 'wmm2020';
let _magvarFn = null; // magvar@2.0.1 の関数（wmm2025 選択時にロード）

/**
 * 国土地理院 2020.0年値 2次多項式近似式
 * 出典: https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html
 * 有効範囲: 日本国内（緯度 24〜46°、経度 123〜146°）
 * 精度: ±数分（日本国内では WMM より高精度）
 *
 * D[分] = a0 + a1*Δφ + a2*Δλ + a3*Δφ² + a4*ΔφΔλ + a5*Δλ²
 * Δφ = φ - 37°, Δλ = λ - 138°（基準点からの差分）
 * 係数単位: 分[']、正=西偏 → 返値は度[°]・正=東偏に変換
 */
function _gsiDeclination(lat, lng) {
  const dphi = lat - 37;
  const dlam = lng - 138;
  const D_min = 495.822
    + 18.462 * dphi
    -  7.726 * dlam
    +  0.007 * dphi * dphi
    -  0.007 * dphi * dlam
    -  0.655 * dlam * dlam;
  // 分→度、かつ GSI式は西偏正なので符号反転して東偏正に変換
  return -(D_min / 60);
}

/** 座標が日本国内（GSI近似式の有効範囲）か判定 */
function _inJapan(lat, lng) {
  return lat >= 24 && lat <= 46 && lng >= 123 && lng <= 146;
}

/**
 * magvar@2.0.1 (WMM2025) を esm.sh から動的ロード
 * 2回目以降はキャッシュされた関数を返す
 */
async function _loadMagvar() {
  if (_magvarFn) return _magvarFn;
  const mod = await import('https://esm.sh/magvar@2.0.1');
  _magvarFn = mod.magvar;
  return _magvarFn;
}

/**
 * モデルを切り替える
 * wmm2025 は初回呼び出し時に esm.sh からロードする（以降はキャッシュ）
 * @param {'wmm2020'|'wmm2025'|'gsi2020'} model
 */
export async function setDeclinationModel(model) {
  _model = model;
  if (model === 'wmm2025' || model === 'gsi2020') {
    await _loadMagvar(); // gsi2020 も日本域外フォールバック用に事前ロード
  }
}

/** 現在のモデル名を返す */
export function getDeclinationModel() {
  return _model;
}

/**
 * 磁気偏角を取得（度、正=東偏）
 * @param {number} lat 緯度
 * @param {number} lng 経度
 * @returns {number} 偏角（度）
 */
export function getDeclination(lat, lng) {
  switch (_model) {
    case 'wmm2020':
      // 既存: geomag グローバル変数（WMM2020）
      return geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;

    case 'wmm2025':
      if (_magvarFn) return _magvarFn(lat, lng);
      // ロード前は wmm2020 で代替
      return geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;

    case 'gsi2020':
      if (_inJapan(lat, lng)) return _gsiDeclination(lat, lng);
      // 日本域外は wmm2025 にフォールバック
      if (_magvarFn) return _magvarFn(lat, lng);
      return geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;

    default:
      return geomag.field(Math.min(89, Math.max(-89, lat)), lng).declination;
  }
}

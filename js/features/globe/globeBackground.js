/* ================================================================
   globeBackground.js — Globe投影・宇宙空間背景アニメーション
   ================================================================ */

let _globeBgEl = null;
let _updateGlobeBg = null;

// 2色間の線形補間（16進カラー）
function _lerpHex(a, b, t) {
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl2 = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, bl2].map(v => v.toString(16).padStart(2, '0')).join('');
}

// 多段階カラーストップ補間（stops: [[t, '#rrggbb'], ...]）
function _lerpMulti(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t <= t1) return _lerpHex(c0, c1, (t - t0) / (t1 - t0));
  }
  return stops[stops.length - 1][1];
}

export function init(map) {
  // Globe投影（ズーム7以下で地球が球体に見える広域表示）
  // MapLibre v5 以降で利用可能。高ズームではメルカトルに自動移行する。
  map.setProjection({ type: 'globe' });

  _globeBgEl = document.getElementById('map');

  // ズームに応じて空と背景を更新する（globe低ズーム→宇宙空間表現）
  // z7（カーマン線）→z11（対流圏）で段階的に遷移
  // 空: 黒→濃紺→深青→空青 / 地平線: 濃紺→中青→水色
  _updateGlobeBg = () => {
    if (!_globeBgEl) return;
    const z = map.getZoom();

    // z7〜z11: 緩やかに遷移、z11〜z12: 残りを1ズームで完了、z12以降固定
    const t2 = z <= 11
      ? Math.max(0, (z - 7) / 11)
      : Math.min(1, 4 / 11 + (z - 11) * (7 / 11));

    const skyColor     = _lerpMulti([[0,'#000000'],[0.2,'#000033'],[0.5,'#002277'],[0.8,'#003a99'],[1,'#0055cc']], t2);
    const horizonColor = _lerpMulti([[0,'#000820'],[0.2,'#001a4d'],[0.5,'#1a4499'],[0.8,'#4488cc'],[1,'#87ceeb']], t2);
    const skyHorizonBlend = 0.2 + 0.6 * t2;

    _globeBgEl.style.backgroundColor = horizonColor;
    map.setSky({
      'sky-color':         skyColor,
      'sky-horizon-blend': skyHorizonBlend,
      'horizon-color':     horizonColor,
      'horizon-fog-blend': 0,
      'fog-color':         horizonColor,
      'atmosphere-blend':  0,
    });
  };

  map.on('zoom', _updateGlobeBg);
  _updateGlobeBg();
}

// sim.js など他モジュールが参照するための遅延ゲッター
export function getUpdateGlobeBg() {
  return _updateGlobeBg;
}

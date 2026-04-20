/* ================================================================
   devTools.js — 開発者向けツール群
   ================================================================ */

// 地図中央切り取り PNG 出力ツール
function _initCropOverlay(map) {
  const overlay   = document.getElementById('dev-crop-overlay');
  const svg       = document.getElementById('dev-crop-svg');
  const toggleBtn = document.getElementById('dev-crop-frame-toggle');
  if (!overlay || !svg || !toggleBtn) return;

  let frameVisible = false;
  let cropW = 256, cropH = 256;

  function _drawFrame() {
    if (!frameVisible) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = vw / 2, cy = vh / 2;
    const fw = cropW, fh = cropH;
    const x1 = cx - fw / 2, y1 = cy - fh / 2;
    svg.innerHTML = `
      <defs>
        <mask id="dev-hole">
          <rect width="100%" height="100%" fill="white"/>
          <rect x="${x1}" y="${y1}" width="${fw}" height="${fh}" fill="black"/>
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(0,0,0,0.35)" mask="url(#dev-hole)"/>
      <rect x="${x1}" y="${y1}" width="${fw}" height="${fh}"
            fill="none" stroke="#ff3" stroke-width="1.5" stroke-dasharray="4 2"/>
      <text x="${cx}" y="${y1 - 4}" fill="#ff3" font-size="11" text-anchor="middle"
            font-family="monospace">${fw} × ${fh}</text>`;
  }

  toggleBtn.addEventListener('click', () => {
    frameVisible = !frameVisible;
    overlay.style.display = frameVisible ? '' : 'none';
    toggleBtn.textContent = frameVisible ? '非表示' : '表示';
    toggleBtn.style.background = frameVisible ? '#333' : '#fff';
    toggleBtn.style.color      = frameVisible ? '#ff3' : '';
    if (frameVisible) _drawFrame();
  });
  window.addEventListener('resize', _drawFrame);

  document.querySelectorAll('.dev-crop-btn').forEach(btn => {
    btn.style.cssText = 'padding:1px 7px;font-size:10px;border:1px solid #aaa;border-radius:3px;background:#fff;cursor:pointer';
    btn.addEventListener('click', () => {
      cropW = parseInt(btn.dataset.w, 10);
      cropH = parseInt(btn.dataset.h, 10);
      document.querySelectorAll('.dev-crop-btn').forEach(b => {
        b.style.background = b === btn ? '#333' : '#fff';
        b.style.color      = b === btn ? '#fff' : '';
      });
      _drawFrame();
      _exportCrop(cropW, cropH);
    });
  });

  function _exportCrop(outW, outH) {
    map.once('idle', () => {
      const canvas = map.getCanvas();
      const dpr    = window.devicePixelRatio || 1;
      const cssCx  = canvas.offsetWidth  / 2;
      const cssCy  = canvas.offsetHeight / 2;
      const px = Math.round((cssCx - outW / 2) * dpr);
      const py = Math.round((cssCy - outH / 2) * dpr);
      const pw = Math.round(outW * dpr);
      const ph = Math.round(outH * dpr);

      const out = document.createElement('canvas');
      out.width  = outW;
      out.height = outH;
      const ctx = out.getContext('2d');
      ctx.drawImage(canvas, px, py, pw, ph, 0, 0, outW, outH);

      const link = document.createElement('a');
      link.download = `crop_${outW}x${outH}.png`;
      link.href     = out.toDataURL('image/png');
      link.click();
    });
    map.triggerRepaint();
  }
}

// テーマカラーピッカー
function _initColorPicker() {
  const picker  = document.getElementById('dev-primary-color');
  const label   = document.getElementById('dev-color-label');
  const copyBtn = document.getElementById('dev-color-copy');
  if (!picker) return;

  function hexToHsl(hex) {
    let r = parseInt(hex.slice(1,3),16)/255;
    let g = parseInt(hex.slice(3,5),16)/255;
    let b = parseInt(hex.slice(5,7),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h=0, s=0, l=(max+min)/2;
    if (max !== min) {
      const d = max-min;
      s = l>0.5 ? d/(2-max-min) : d/(max+min);
      switch(max){
        case r: h=((g-b)/d+(g<b?6:0))/6; break;
        case g: h=((b-r)/d+2)/6; break;
        case b: h=((r-g)/d+4)/6; break;
      }
    }
    return [Math.round(h*360), Math.round(s*100), Math.round(l*100)];
  }

  function hslToHex(h,s,l) {
    s=Math.max(0,Math.min(100,s))/100;
    l=Math.max(0,Math.min(100,l))/100;
    const a=s*Math.min(l,1-l);
    const f=n=>{ const k=(n+h/30)%12; return Math.round(255*(l-a*Math.max(Math.min(k-3,9-k,1),-1))).toString(16).padStart(2,'0'); };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function hexToRgba(hex, a) {
    const r=parseInt(hex.slice(1,3),16);
    const g=parseInt(hex.slice(3,5),16);
    const b=parseInt(hex.slice(5,7),16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function applyTheme(hex) {
    const [h,s,l] = hexToHsl(hex);
    const root = document.documentElement;
    const hover = hslToHex(h, s, l-10);
    const dark  = hslToHex(h, s, l-20);
    const light = hslToHex(h, Math.max(0,s-40), Math.min(97,l+38));
    root.style.setProperty('--primary',       hex);
    root.style.setProperty('--primary-hover', hover);
    root.style.setProperty('--primary-dark',  dark);
    root.style.setProperty('--primary-light', light);
    root.style.setProperty('--primary-alpha', hexToRgba(hex, 0.12));
    label.textContent = hex;
    label.style.color = hex;
    document.querySelectorAll('input[type="range"]').forEach(el => {
      const pct = ((el.value - el.min) / (el.max - el.min) * 100).toFixed(1);
      el.style.background = `linear-gradient(to right, ${hex} ${pct}%, #d0d0d0 ${pct}%)`;
    });
  }

  picker.addEventListener('input', () => applyTheme(picker.value));

  const onCheck = document.getElementById('dev-on-primary-check');
  const onKnob  = document.getElementById('dev-on-primary-knob');
  if (onCheck && onKnob) {
    function applyOnPrimary(isDark) {
      const root = document.documentElement;
      if (isDark) {
        root.style.setProperty('--on-primary',       '#111111');
        root.style.setProperty('--on-primary-muted', 'rgba(0,0,0,0.60)');
        onKnob.textContent = '⚫黒';
      } else {
        root.style.setProperty('--on-primary',       '#ffffff');
        root.style.setProperty('--on-primary-muted', 'rgba(255,255,255,0.65)');
        onKnob.textContent = '⚪白';
      }
    }
    onCheck.addEventListener('change', () => applyOnPrimary(onCheck.checked));
  }

  copyBtn.addEventListener('click', () => {
    const [h,s,l] = hexToHsl(picker.value);
    const onPrimary = (onCheck?.checked) ? '#111111' : '#ffffff';
    const onMuted   = (onCheck?.checked) ? 'rgba(0,0,0,0.60)' : 'rgba(255,255,255,0.65)';
    const css = [
      `--primary:            ${picker.value};`,
      `--primary-hover:      ${hslToHex(h,s,l-10)};`,
      `--primary-dark:       ${hslToHex(h,s,l-20)};`,
      `--primary-light:      ${hslToHex(h,Math.max(0,s-40),Math.min(97,l+38))};`,
      `--primary-alpha:      ${hexToRgba(picker.value,0.12)};`,
      `--on-primary:         ${onPrimary};`,
      `--on-primary-muted:   ${onMuted};`,
    ].join('\n');
    navigator.clipboard.writeText(css).then(() => {
      copyBtn.textContent = '✓ copied';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    });
  });
}

export function initDevTools(map) {
  _initCropOverlay(map);
  _initColorPicker();
}

/* ================================================================
   printDialog.js — 印刷・エクスポートダイアログ
   ================================================================ */

export function initPrintDialog(map, { setTerrain3dEnabled, setBuilding3dEnabled } = {}) {

  // 用紙サイズ定義（縦向き基準: [width_mm, height_mm]）
  const PAPER_SIZES_MM = {
    A2: [420, 594], A3: [297, 420], A4: [210, 297], A5: [148, 210],
    B2: [515, 728], B3: [364, 515], B4: [257, 364], B5: [182, 257],
  };

  const exportBtn        = document.getElementById('print-export-btn');
  const selPaper         = document.getElementById('print-paper-size');
  const selOrientation   = document.getElementById('print-orientation');
  const selScaleSelect   = document.getElementById('print-scale-select');
  const scaleCustomRow   = document.getElementById('print-scale-custom-row');
  const scaleCustomInput = document.getElementById('print-scale');
  const selFormat        = document.getElementById('print-format');
  const selDpi           = document.getElementById('print-dpi');
  const selZoom          = document.getElementById('print-zoom');
  const infoEl           = document.getElementById('print-info');
  const frameOverlay     = document.getElementById('print-frame-overlay');
  const frameSvg         = document.getElementById('print-frame-svg');
  const simStartBlock    = document.getElementById('sim-start-block');

  // 現在の縮尺分母を返す
  function getScale() {
    if (selScaleSelect.value === 'custom') {
      return Math.max(500, parseInt(scaleCustomInput.value, 10) || 10000);
    }
    return parseInt(selScaleSelect.value, 10);
  }

  // 手入力行の表示切替
  selScaleSelect.addEventListener('change', () => {
    scaleCustomRow.style.display = selScaleSelect.value === 'custom' ? '' : 'none';
    if (selScaleSelect.value === 'custom') scaleCustomInput.focus();
  });
  const printModeState = {
    active: false,
    prevTerrainEnabled: false,
    prevBuildingEnabled: false,
    prevProjectionType: null,
    prevRenderWorldCopies: null,
    prevMinZoom: null,
    dragPitchWasEnabled: null,
    touchPitchWasEnabled: null,
    dragRotateWasEnabled: null,
    scrollZoomWasEnabled: null,
    doubleClickZoomWasEnabled: null,
    touchZoomRotateWasEnabled: null,
    usedDragRotateFallback: false,
    wheelHandler: null,
    dblClickHandler: null,
    rotateMouseDownHandler: null,
    rotateMouseMoveHandler: null,
    rotateMouseUpHandler: null,
    rotateContextMenuHandler: null,
    isRotating: false,
    rotateStartBearing: 0,
    rotateStartAngle: 0,
    suppressContextMenuOnce: false,
    frameAnchorPx: null,
    frameRefreshRaf: 0,
    frameInsetLeft: 0,
  };

  if (!exportBtn || !frameOverlay) return;

  // 向きを考慮した用紙寸法 [width_mm, height_mm] を返す
  function getPaperDim() {
    const [pw, ph] = PAPER_SIZES_MM[selPaper.value] || [210, 297];
    return selOrientation.value === 'landscape'
      ? [Math.max(pw, ph), Math.min(pw, ph)]
      : [Math.min(pw, ph), Math.max(pw, ph)];
  }

  // 指定 DPI・縮尺・緯度に対応したエクスポートズームを計算
  // MapLibre GL JS は 512px タイル基準: 78271.51696 × cos(lat) / 2^z = 0.0254 × scale / dpi
  function calcExportZoom(dpi, scale, lat) {
    return Math.log2(78271.51696 * Math.cos(lat * Math.PI / 180) * dpi / (0.0254 * scale));
  }

  function getPrintFrameInsetLeft() {
    if (window.matchMedia('(max-width: 768px)').matches) return 0;
    const sidebar = document.getElementById('sidebar');
    return sidebar ? sidebar.offsetWidth : 0;
  }

  function getPrintFrameLayout() {
    printModeState.frameInsetLeft = getPrintFrameInsetLeft();
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = getScale();
    const zoom  = map.getZoom();
    const lat   = map.getCenter().lat;
    // MapLibre GL JS は 512px タイル基準（係数 78271.51696 = 40075016.686 / 512）
    const metersPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, zoom));
    const fW = (pw_mm / 1000 * scale) / metersPerPx;
    const fH = (ph_mm / 1000 * scale) / metersPerPx;
    const ovW = Math.max(0, frameOverlay.offsetWidth - printModeState.frameInsetLeft);
    const ovH = frameOverlay.offsetHeight;
    // 地図有効領域の中心を基準に枠を配置（クランプしない — 枠は画面外に出てよい）
    const centerX = printModeState.frameInsetLeft + ovW / 2;
    const centerY = ovH / 2;
    const x  = Math.round(centerX - fW / 2);
    const y  = Math.round(centerY - fH / 2);
    const bW = Math.round(fW);
    const bH = Math.round(fH);
    return {
      x, y, bW, bH, ovW, ovH,
      anchorPx: [centerX, centerY],
    };
  }

  // 地図上の印刷範囲フレームを SVG で描画（開発用切り取りツールと同方式）
  function updatePrintFrame() {
    if (!frameOverlay.classList.contains('visible')) return;
    const { x, y, bW, bH, anchorPx } = getPrintFrameLayout();
    const [anchorX, anchorY] = anchorPx;
    const crossSize = 10;
    printModeState.frameAnchorPx = anchorPx;
    // SVG hole-mask: 全面 rect に穴を開けて均一なマスクを実現
    frameSvg.innerHTML = `
      <defs>
        <mask id="pf-hole">
          <rect width="100%" height="100%" fill="white"/>
          <rect x="${x}" y="${y}" width="${bW}" height="${bH}" fill="black"/>
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(0,0,0,0.38)" mask="url(#pf-hole)"/>
      <rect x="${x}" y="${y}" width="${bW}" height="${bH}"
            fill="none" stroke="rgba(0,0,0,0.45)" stroke-width="4"/>
      <rect x="${x}" y="${y}" width="${bW}" height="${bH}"
            fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2"/>
      <line x1="${anchorX - crossSize}" y1="${anchorY}" x2="${anchorX + crossSize}" y2="${anchorY}"
            stroke="rgba(0,0,0,0.45)" stroke-width="4" stroke-linecap="round"/>
      <line x1="${anchorX - crossSize}" y1="${anchorY}" x2="${anchorX + crossSize}" y2="${anchorY}"
            stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>
      <line x1="${anchorX}" y1="${anchorY - crossSize}" x2="${anchorX}" y2="${anchorY + crossSize}"
            stroke="rgba(0,0,0,0.45)" stroke-width="4" stroke-linecap="round"/>
      <line x1="${anchorX}" y1="${anchorY - crossSize}" x2="${anchorX}" y2="${anchorY + crossSize}"
            stroke="rgba(255,255,255,0.95)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="${anchorX}" cy="${anchorY}" r="3.5" fill="rgba(0,0,0,0.45)"/>
      <circle cx="${anchorX}" cy="${anchorY}" r="2.5" fill="rgba(255,255,255,0.98)"/>`;
  }

  // 出力サイズ情報を更新
  function getExportZoom(lat) {
    if (selZoom.value !== 'auto') return parseFloat(selZoom.value);
    return calcExportZoom(parseInt(selDpi.value, 10), getScale(), lat);
  }

  function updateInfo() {
    const [pw_mm, ph_mm] = getPaperDim();
    const dpi   = parseInt(selDpi.value, 10);
    const scale = getScale();
    const outW  = Math.round(pw_mm / 25.4 * dpi);
    const outH  = Math.round(ph_mm / 25.4 * dpi);
    const groundW = Math.round((pw_mm / 1000) * scale);
    const groundH = Math.round((ph_mm / 1000) * scale);
    const lat   = map.getCenter().lat;
    const z     = getExportZoom(lat);
    infoEl.textContent = `出力: ${outW}×${outH} px　ズーム: ${z.toFixed(1)}\n範囲: ${groundW}×${groundH} m`;
  }

  function schedulePrintFrameRefresh() {
    if (!isPrintPanelVisible()) return;
    if (printModeState.frameRefreshRaf) cancelAnimationFrame(printModeState.frameRefreshRaf);
    printModeState.frameRefreshRaf = requestAnimationFrame(() => {
      printModeState.frameRefreshRaf = requestAnimationFrame(() => {
        printModeState.frameRefreshRaf = 0;
        map.resize();
        if (printModeState.active && map.setMinZoom) {
          map.setMinZoom(getPrintModeMinZoom());
        }
        updatePrintFrame();
        updateInfo();
      });
    });
  }

  // 印刷モードが有効かどうか判定（パネルが active かつサイドバーが開いている）
  function isPrintPanelVisible() {
    const printPanel = document.getElementById('panel-print');
    const sbPanel    = document.getElementById('sidebar-panel');
    return printPanel?.classList.contains('active') && !sbPanel?.classList.contains('sb-hidden');
  }

  function lockPrintPitchControls() {
    printModeState.dragPitchWasEnabled  = map.dragPitch?.isEnabled?.() ?? null;
    printModeState.touchPitchWasEnabled = map.touchPitch?.isEnabled?.() ?? null;
    printModeState.dragRotateWasEnabled = map.dragRotate?.isEnabled?.() ?? null;
    printModeState.usedDragRotateFallback = !map.dragPitch?.disable && !!map.dragRotate?.disable;

    if (map.dragPitch?.disable) map.dragPitch.disable();
    else if (map.dragRotate?.disable) map.dragRotate.disable();

    if (map.touchPitch?.disable) map.touchPitch.disable();
  }

  function unlockPrintPitchControls() {
    if (map.dragPitch?.enable && printModeState.dragPitchWasEnabled) map.dragPitch.enable();
    if (map.touchPitch?.enable && printModeState.touchPitchWasEnabled) map.touchPitch.enable();
    if (printModeState.usedDragRotateFallback && map.dragRotate?.enable && printModeState.dragRotateWasEnabled) {
      map.dragRotate.enable();
    }
  }

  function getClampedPrintZoom(nextZoom) {
    const minZoom = getPrintModeMinZoom();
    const maxZoom = map.getMaxZoom?.() ?? 24;
    return Math.max(minZoom, Math.min(maxZoom, nextZoom));
  }

  function getPrintModeMinZoom() {
    const baseMinZoom = printModeState.active && printModeState.prevMinZoom !== null
      ? printModeState.prevMinZoom
      : (map.getMinZoom?.() ?? 0);
    const mapRect = map.getContainer().getBoundingClientRect();
    const { anchorPx } = getPrintFrameLayout();
    const anchorY = Math.max(0, Math.min(mapRect.height, anchorPx[1] - mapRect.top));
    const distTop = Math.max(1, anchorY);
    const distBottom = Math.max(1, mapRect.height - anchorY);
    const anchorLngLat = getPrintFrameAnchorLngLat();
    const latRad = Math.max(-85.05112878, Math.min(85.05112878, anchorLngLat.lat)) * Math.PI / 180;
    const mercatorY = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
    const eps = 1e-6;
    const minWorldFromTop = distTop / Math.max(mercatorY, eps);
    const minWorldFromBottom = distBottom / Math.max(1 - mercatorY, eps);
    const requiredWorldSize = Math.max(minWorldFromTop, minWorldFromBottom, 256 * Math.pow(2, baseMinZoom));
    const verticalLimitMinZoom = Math.log2(requiredWorldSize / 256);
    return Math.max(baseMinZoom, verticalLimitMinZoom);
  }

  function getPrintFrameAnchorLngLat() {
    const mapRect = map.getContainer().getBoundingClientRect();
    const { anchorPx } = getPrintFrameLayout();
    const anchorX = anchorPx[0] - mapRect.left;
    const anchorY = anchorPx[1] - mapRect.top;
    return map.unproject([anchorX, anchorY]);
  }

  function getPrintFrameAnchorClientPx() {
    const { anchorPx } = getPrintFrameLayout();
    return { x: anchorPx[0], y: anchorPx[1] };
  }

  function enablePrintCenterZoom() {
    const container = map.getContainer();
    printModeState.scrollZoomWasEnabled = map.scrollZoom?.isEnabled?.() ?? null;
    printModeState.doubleClickZoomWasEnabled = map.doubleClickZoom?.isEnabled?.() ?? null;
    printModeState.touchZoomRotateWasEnabled = map.touchZoomRotate?.isEnabled?.() ?? null;

    if (map.scrollZoom?.disable) map.scrollZoom.disable();
    if (map.doubleClickZoom?.disable) map.doubleClickZoom.disable();

    printModeState.wheelHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentZoom = map.getZoom();
      const wheelStep = e.deltaMode === 1 ? 0.18 : 0.12;
      const zoomDelta = -Math.sign(e.deltaY || 0) * wheelStep;
      if (!zoomDelta) return;
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.zoomTo(getClampedPrintZoom(currentZoom + zoomDelta), {
        around: anchor,
        duration: 0,
        essential: true,
      });
    };

    printModeState.dblClickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.zoomTo(getClampedPrintZoom(map.getZoom() + 1), {
        around: anchor,
        duration: 120,
        essential: true,
      });
    };

    container.addEventListener('wheel', printModeState.wheelHandler, { passive: false });
    container.addEventListener('dblclick', printModeState.dblClickHandler);
  }

  function disablePrintCenterZoom() {
    const container = map.getContainer();
    if (printModeState.wheelHandler) {
      container.removeEventListener('wheel', printModeState.wheelHandler);
      printModeState.wheelHandler = null;
    }
    if (printModeState.dblClickHandler) {
      container.removeEventListener('dblclick', printModeState.dblClickHandler);
      printModeState.dblClickHandler = null;
    }

    if (map.scrollZoom?.enable && printModeState.scrollZoomWasEnabled) map.scrollZoom.enable();
    if (map.doubleClickZoom?.enable && printModeState.doubleClickZoomWasEnabled) map.doubleClickZoom.enable();
    if (map.touchZoomRotate?.enable && printModeState.touchZoomRotateWasEnabled) map.touchZoomRotate.enable();
  }

  function enablePrintCenterRotate() {
    const container = map.getContainer();
    if (map.dragRotate?.disable) map.dragRotate.disable();

    printModeState.rotateMouseDownHandler = (e) => {
      const isRotateDrag = e.button === 2 || (e.button === 0 && (e.ctrlKey || e.metaKey));
      if (!isRotateDrag) return;
      const anchorClient = getPrintFrameAnchorClientPx();
      printModeState.isRotating = true;
      printModeState.suppressContextMenuOnce = e.button === 2;
      printModeState.rotateStartBearing = map.getBearing();
      printModeState.rotateStartAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
      e.preventDefault();
      e.stopPropagation();
    };

    printModeState.rotateMouseMoveHandler = (e) => {
      if (!printModeState.isRotating) return;
      const anchorClient = getPrintFrameAnchorClientPx();
      const currentAngle = Math.atan2(e.clientY - anchorClient.y, e.clientX - anchorClient.x);
      const deltaDeg = (currentAngle - printModeState.rotateStartAngle) * 180 / Math.PI;
      const anchor = getPrintFrameAnchorLngLat();
      map.stop();
      map.rotateTo(printModeState.rotateStartBearing - deltaDeg, {
        around: anchor,
        duration: 0,
        essential: true,
      });
      e.preventDefault();
      e.stopPropagation();
    };

    printModeState.rotateMouseUpHandler = () => {
      printModeState.isRotating = false;
      setTimeout(() => { printModeState.suppressContextMenuOnce = false; }, 0);
    };

    printModeState.rotateContextMenuHandler = (e) => {
      if (!printModeState.suppressContextMenuOnce) return;
      e.preventDefault();
      e.stopPropagation();
      printModeState.suppressContextMenuOnce = false;
    };

    container.addEventListener('mousedown', printModeState.rotateMouseDownHandler);
    window.addEventListener('mousemove', printModeState.rotateMouseMoveHandler);
    window.addEventListener('mouseup', printModeState.rotateMouseUpHandler);
    container.addEventListener('contextmenu', printModeState.rotateContextMenuHandler);
  }

  function disablePrintCenterRotate() {
    const container = map.getContainer();
    if (printModeState.rotateMouseDownHandler) {
      container.removeEventListener('mousedown', printModeState.rotateMouseDownHandler);
      printModeState.rotateMouseDownHandler = null;
    }
    if (printModeState.rotateMouseMoveHandler) {
      window.removeEventListener('mousemove', printModeState.rotateMouseMoveHandler);
      printModeState.rotateMouseMoveHandler = null;
    }
    if (printModeState.rotateMouseUpHandler) {
      window.removeEventListener('mouseup', printModeState.rotateMouseUpHandler);
      printModeState.rotateMouseUpHandler = null;
    }
    if (printModeState.rotateContextMenuHandler) {
      container.removeEventListener('contextmenu', printModeState.rotateContextMenuHandler);
      printModeState.rotateContextMenuHandler = null;
    }
    printModeState.isRotating = false;
    printModeState.suppressContextMenuOnce = false;

    if (!printModeState.usedDragRotateFallback && map.dragRotate?.enable && printModeState.dragRotateWasEnabled) {
      map.dragRotate.enable();
    }
  }

  async function enterPrintMode() {
    if (printModeState.active) return;
    printModeState.active = true;
    printModeState.prevTerrainEnabled = terrain3dCard?.classList.contains('active') ?? false;
    printModeState.prevBuildingEnabled = building3dCard?.classList.contains('active') ?? false;
    printModeState.prevProjectionType = map.getProjection?.()?.type ?? null;
    printModeState.prevRenderWorldCopies = map.getRenderWorldCopies?.() ?? null;
    printModeState.prevMinZoom = map.getMinZoom?.() ?? null;

    lockPrintPitchControls();
    if (printModeState.prevProjectionType !== 'mercator') map.setProjection({ type: 'mercator' });
    if (map.setRenderWorldCopies) map.setRenderWorldCopies(true);
    if (map.setMinZoom) map.setMinZoom(getPrintModeMinZoom());
    enablePrintCenterZoom();
    enablePrintCenterRotate();
    map.easeTo({ pitch: 0, duration: 500, essential: true });

    if (printModeState.prevTerrainEnabled) setTerrain3dEnabled(false);
    if (printModeState.prevBuildingEnabled) await setBuilding3dEnabled(false);
    if (simStartBlock) simStartBlock.style.display = 'none';
  }

  async function exitPrintMode() {
    if (!printModeState.active) return;
    printModeState.active = false;
    if (simStartBlock) simStartBlock.style.display = '';

    disablePrintCenterRotate();
    disablePrintCenterZoom();
    unlockPrintPitchControls();
    if (printModeState.prevProjectionType && printModeState.prevProjectionType !== 'mercator') {
      map.setProjection({ type: printModeState.prevProjectionType });
    }
    if (map.setRenderWorldCopies && printModeState.prevRenderWorldCopies !== null) {
      map.setRenderWorldCopies(printModeState.prevRenderWorldCopies);
    }
    if (map.setMinZoom && printModeState.prevMinZoom !== null) {
      map.setMinZoom(printModeState.prevMinZoom);
    }
    setTerrain3dEnabled(!!printModeState.prevTerrainEnabled);
    await setBuilding3dEnabled(!!printModeState.prevBuildingEnabled);
  }

  async function syncFrameVisibility() {
    if (isPrintPanelVisible()) {
      await enterPrintMode();
      frameOverlay.classList.add('visible');
      schedulePrintFrameRefresh();
    } else {
      frameOverlay.classList.remove('visible');
      await exitPrintMode();
    }
  }

  // panel-print の active クラス変化を監視
  const printPanel = document.getElementById('panel-print');
  if (printPanel) {
    new MutationObserver(() => { void syncFrameVisibility(); })
      .observe(printPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // サイドバーパネルの sb-hidden クラス変化を監視（パネルを閉じたときに印刷モード解除）
  const sbPanel = document.getElementById('sidebar-panel');
  if (sbPanel) {
    new MutationObserver(() => { void syncFrameVisibility(); })
      .observe(sbPanel, { attributes: true, attributeFilter: ['class'] });
  }

  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => { void syncFrameVisibility(); });
  });
  document.querySelectorAll('.sidebar-close-btn').forEach(btn => {
    btn.addEventListener('click', () => { void syncFrameVisibility(); });
  });

  // マップ移動・ズームでフレームを更新
  map.on('move', updatePrintFrame);
  map.on('zoom', updatePrintFrame);
  window.addEventListener('resize', schedulePrintFrameRefresh);
  new ResizeObserver(schedulePrintFrameRefresh).observe(frameOverlay);
  new ResizeObserver(schedulePrintFrameRefresh).observe(map.getContainer());

  // 設定変更時の更新
  [selPaper, selOrientation, selScaleSelect].forEach(el => {
    el.addEventListener('change', schedulePrintFrameRefresh);
  });
  scaleCustomInput.addEventListener('input',  schedulePrintFrameRefresh);
  scaleCustomInput.addEventListener('change', updateInfo);
  selDpi.addEventListener('change', updateInfo);
  selZoom.addEventListener('change', updateInfo);

  // エクスポート実行
  async function execExport() {
    const [pw_mm, ph_mm] = getPaperDim();
    const scale = getScale();
    const dpi   = parseInt(selDpi.value, 10);
    const fmt   = selFormat.value;
    const outW  = Math.round(pw_mm / 25.4 * dpi);
    const outH  = Math.round(ph_mm / 25.4 * dpi);

    if (outW > 8192 || outH > 8192) {
      alert(`出力サイズ ${outW}×${outH}px は大きすぎます。\nDPI または用紙サイズを小さくしてください。`);
      return;
    }

    exportBtn.disabled = true;
    exportBtn.textContent = '生成中...';
    showMapLoading();

    try {
      // エクスポート時の中心は印刷フレームのアンカー座標（サイドバーオフセット考慮済み）
      const { anchorPx } = getPrintFrameLayout();
      const center = map.unproject(anchorPx);
      const zoom   = getExportZoom(center.lat);

      const container = document.createElement('div');
      container.style.cssText =
        `position:fixed;left:-${outW + 100}px;top:0;width:${outW}px;height:${outH}px;visibility:hidden;`;
      document.body.appendChild(container);

      const rawStyle    = map.getStyle();
      // テレイン枠・境界レイヤーを除外（印刷出力に枠を含めない）
      const FRAME_LAYER_IDS = new Set([
        'frames-fill', 'frames-outline', 'frames-hover',
        'terrain-boundary-fill', 'terrain-boundary-outline',
      ]);
      const exportStyle = {
        ...rawStyle,
        terrain: undefined,
        layers: rawStyle.layers
          .filter(l => !FRAME_LAYER_IDS.has(l.id))
          .map(l => {
            // raster レイヤーの輪郭線プロパティを除去（MapLibre GL JS 5.x で追加）
            if (l.type !== 'raster') return l;
            const paint = { ...l.paint };
            delete paint['raster-border-color'];
            delete paint['raster-border-width'];
            return { ...l, paint };
          }),
      };

      const exportMap = new maplibregl.Map({
        container,
        style: exportStyle,
        center,
        zoom,
        bearing: map.getBearing(),
        pitch: 0,
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0,
      });

      // タイル読み込み完了（idle）を最大30秒待機
      await new Promise((resolve) => {
        exportMap.once('idle', resolve);
        setTimeout(resolve, 30000);
      });

      const srcCanvas = exportMap.getCanvas();
      const outCanvas = document.createElement('canvas');
      outCanvas.width  = outW;
      outCanvas.height = outH;
      outCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, outW, outH);

      exportMap.remove();
      container.remove();

      const mimeType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
      const dataURL  = outCanvas.toDataURL(mimeType, 0.92);

      if (fmt === 'pdf') {
        await exportAsPdf(dataURL, pw_mm, ph_mm);
      } else {
        const a = document.createElement('a');
        a.href = dataURL;
        a.download = `map_export.${fmt}`;
        a.click();
      }
    } catch (e) {
      console.error('エクスポートエラー:', e);
      alert('エクスポートに失敗しました:\n' + e.message);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'エクスポート';
      hideMapLoading();
    }
  }

  // jsPDF を使って PDF に変換してダウンロード
  async function exportAsPdf(dataURL, pw_mm, ph_mm) {
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('jsPDF の読み込みに失敗しました'));
        document.head.appendChild(s);
      });
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: pw_mm > ph_mm ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [pw_mm, ph_mm],
    });
    doc.addImage(dataURL, 'PNG', 0, 0, pw_mm, ph_mm);
    doc.save('map_export.pdf');
  }

  exportBtn.addEventListener('click', execExport);
  void syncFrameVisibility();
  updateInfo();

}

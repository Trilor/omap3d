/**
 * overlayController.js — CS立体図・オーバーレイ表示制御
 *
 * 担当:
 *   - currentOverlay 状態管理（getter/setter）
 *   - updateCsVisibility() — CS/オーバーレイレイヤー表示切替
 *   - オーバーレイカードのクリックイベント
 *   - CS立体図 透明度スライダー
 *   - zoomend / movestart による自動更新
 *
 * 使い方: init(map) を map.on('load') 内で呼ぶ。
 */

import {
  REGIONAL_CS_LAYERS, REGIONAL_RRIM_LAYERS, CS_INITIAL_OPACITY,
} from '../../core/config.js';
import {
  contourState,
  COLOR_CONTOUR_Q_IDS, COLOR_CONTOUR_DEM5A_IDS, COLOR_CONTOUR_DEM1A_IDS,
} from '../../core/contours.js';
import {
  OVERLAY_DATA_CONFIGS,
  scheduleDataOverlayDeckSync, scheduleSlopeDeckSync,
  applyColorReliefTiles, autoFitColorRelief,
  applySlopeReliefTiles, autoFitSlopeRelief,
  applyCurvatureReliefTiles, autoFitCurvatureRelief,
  refreshColorReliefTrackLayout, refreshSlopeReliefTrackLayout, refreshCurvatureReliefTrackLayout,
} from '../../core/reliefOverlay.js';
import { getCurrentBasemap } from '../basemap/basemapController.js';
import { updateRegionalAttribution } from '../../core/attribution.js';
import { showMapLoading, hideMapLoading, showMapTileLoading } from '../../ui/mapLoading.js';
import { saveUiState, updateShareableUrl } from '../../store/uiStateManager.js';
import { updateSliderGradient } from '../../utils/slider.js';

let _map = null;

let _currentOverlay = 'none';

export function getCurrentOverlay() { return _currentOverlay; }
export function setCurrentOverlay(v) { _currentOverlay = v; }

export function updateCsVisibility() {
  const basemap    = getCurrentBasemap();
  const overlayOn  = _currentOverlay !== 'none';
  const overlay    = _currentOverlay;

  const sliderCs = document.getElementById('slider-cs');
  const sliderVal = parseFloat(sliderCs?.value ?? 0);
  const z = _map.getZoom();

  // 非選択の data-render レイヤーを非表示にする
  Object.keys(OVERLAY_DATA_CONFIGS).forEach(key => {
    if (key === overlay) return;
    const cfg = OVERLAY_DATA_CONFIGS[key];
    if (_map.getLayer(cfg.maplibreLayerId)) {
      _map.setLayoutProperty(cfg.maplibreLayerId, 'visibility', 'none');
    }
  });

  // 選択中のオーバーレイは data-render:// プロトコル経由で raster タイルを更新
  if (overlay in OVERLAY_DATA_CONFIGS) {
    scheduleDataOverlayDeckSync(overlay);
  }
  const showColorRelief     = overlay === 'color-relief';
  const showSlopeRelief     = overlay === 'slope';
  const showCurvatureRelief = overlay === 'curvature';
  const showRrimRelief      = overlay === 'rrim';
  if (_map.getLayer('rrim-relief-layer')) {
    _map.setLayoutProperty('rrim-relief-layer', 'visibility', showRrimRelief ? 'visible' : 'none');
    if (_map.getLayer('rrim-qchizu-layer')) _map.setLayoutProperty('rrim-qchizu-layer', 'visibility', showRrimRelief ? 'visible' : 'none');
    if (showRrimRelief) {
      _map.setPaintProperty('rrim-relief-layer', 'raster-opacity', sliderVal);
      if (_map.getLayer('rrim-qchizu-layer')) _map.setPaintProperty('rrim-qchizu-layer', 'raster-opacity', sliderVal);
    }
  }
  const crCtrls = document.getElementById('color-relief-controls');
  if (crCtrls) crCtrls.style.display = (overlay === 'color-relief' || overlay === 'color-contour') ? '' : 'none';
  if (overlay === 'color-relief' || overlay === 'color-contour') refreshColorReliefTrackLayout();
  const srCtrls = document.getElementById('slope-relief-controls');
  if (srCtrls) srCtrls.style.display = overlay === 'slope' ? '' : 'none';
  if (overlay === 'slope') refreshSlopeReliefTrackLayout();
  const cvCtrls = document.getElementById('curvature-relief-controls');
  if (cvCtrls) cvCtrls.style.display = overlay === 'curvature' ? '' : 'none';
  if (overlay === 'curvature') refreshCurvatureReliefTrackLayout();

  // 色別等高線の表示制御（contourState.demMode に応じて排他表示）
  const showColorContour = overlay === 'color-contour';
  const ccBaseVis = showColorContour ? 'visible' : 'none';
  COLOR_CONTOUR_Q_IDS.forEach(id => {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'q1m') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM5A_IDS.forEach(id => {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'dem5a') ? 'visible' : 'none');
  });
  COLOR_CONTOUR_DEM1A_IDS.forEach(id => {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility',
      (ccBaseVis === 'visible' && contourState.demMode === 'dem1a') ? 'visible' : 'none');
  });

  // CS立体図: 他の生成系オーバーレイ選択時は非表示
  const csOverlay = (showColorRelief || showColorContour || showSlopeRelief || showCurvatureRelief || showRrimRelief) ? 'none' : overlay;
  const csKey = csOverlay !== 'none' ? csOverlay
              : basemap.startsWith('cs-') ? basemap
              : null;

  const show1m  = !!csKey && csKey !== 'none';
  const show05m = !!csKey && csKey !== 'cs-1m' && z >= 16;

  if (_map.getLayer('cs-relief-layer')) {
    _map.setLayoutProperty('cs-relief-layer', 'visibility', show1m ? 'visible' : 'none');
    if (_map.getLayer('cs-qchizu-layer')) _map.setLayoutProperty('cs-qchizu-layer', 'visibility', show1m ? 'visible' : 'none');
    if (show1m) {
      _map.setPaintProperty('cs-relief-layer', 'raster-opacity', sliderVal);
      if (_map.getLayer('cs-qchizu-layer')) _map.setPaintProperty('cs-qchizu-layer', 'raster-opacity', sliderVal);
    }
  }
  REGIONAL_CS_LAYERS.forEach(layer => {
    if (_map.getLayer(layer.layerId)) {
      _map.setLayoutProperty(layer.layerId, 'visibility', show05m ? 'visible' : 'none');
      if (show05m) {
        _map.setPaintProperty(layer.layerId, 'raster-opacity', sliderVal);
      }
    }
  });

  // 赤色立体図: rrim 選択時 z>=17 で地域DEMレイヤーを重ねる
  const showRrim05m = showRrimRelief && z >= 16;
  REGIONAL_RRIM_LAYERS.forEach(layer => {
    if (_map.getLayer(layer.layerId)) {
      _map.setLayoutProperty(layer.layerId, 'visibility', showRrim05m ? 'visible' : 'none');
      if (showRrim05m) {
        _map.setPaintProperty(layer.layerId, 'raster-opacity', sliderVal);
      }
    }
  });

  document.getElementById('slider-cs').disabled = !overlayOn;
  updateRegionalAttribution();
}

export function isCsLayerVisible() {
  return !!(_map?.getLayer('cs-relief-layer') &&
    _map.getLayoutProperty('cs-relief-layer', 'visibility') === 'visible');
}

export function isGeneratingLayer() {
  return isCsLayerVisible() || _currentOverlay === 'color-relief' || _currentOverlay === 'slope' || _currentOverlay === 'curvature' || _currentOverlay === 'rrim';
}

export function init(map) {
  _map = map;
  _initListeners();
}

function _initListeners() {
  _map.on('movestart', () => {
    if (isGeneratingLayer()) showMapTileLoading();
  });

  // オーバーレイカードのクリックハンドラー
  document.getElementById('overlay-cards')?.addEventListener('click', (e) => {
    const card = e.target.closest('.bm-card');
    if (!card) return;
    document.querySelectorAll('#overlay-cards .bm-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    _currentOverlay = card.dataset.key;
    updateShareableUrl();
    saveUiState();
    updateCsVisibility();
    if (_currentOverlay === 'cs' || _currentOverlay === 'color-relief' || _currentOverlay === 'slope' || _currentOverlay === 'curvature' || _currentOverlay === 'rrim') showMapLoading();
    else hideMapLoading();
    if (_currentOverlay === 'color-relief') { applyColorReliefTiles(); autoFitColorRelief(); }
    if (_currentOverlay === 'slope') { applySlopeReliefTiles(); autoFitSlopeRelief(); }
    if (_currentOverlay === 'curvature') { applyCurvatureReliefTiles(); autoFitCurvatureRelief(); }
    if (_currentOverlay === 'color-contour') _map.triggerRepaint();
  });

  _map.on('zoomend', updateCsVisibility);

  // ズーム変化時にオーバーレイを再同期（data-render:// の stops パラメータ更新）
  _map.on('zoomend', () => {
    if (_currentOverlay in OVERLAY_DATA_CONFIGS) scheduleDataOverlayDeckSync(_currentOverlay);
  });

  // CS立体図 透明度スライダー（全国・地域別共通）
  const sliderCs = document.getElementById('slider-cs');
  if (sliderCs) {
    sliderCs.value = CS_INITIAL_OPACITY;
    updateSliderGradient(sliderCs);
    sliderCs.addEventListener('input', () => {
      const v = parseFloat(sliderCs.value);
      updateSliderGradient(sliderCs);
      if (_map.getLayer('cs-relief-layer')) {
        _map.setPaintProperty('cs-relief-layer', 'raster-opacity', v);
        if (_map.getLayer('cs-qchizu-layer')) _map.setPaintProperty('cs-qchizu-layer', 'raster-opacity', v);
      }
      REGIONAL_CS_LAYERS.forEach(layer => {
        if (_map.getLayer(layer.layerId)) {
          _map.setPaintProperty(layer.layerId, 'raster-opacity', v);
        }
      });
      if (_currentOverlay === 'color-relief') scheduleDataOverlayDeckSync('color-relief');
      if (_currentOverlay === 'slope') scheduleSlopeDeckSync();
      if (_currentOverlay === 'rrim' && _map.getLayer('rrim-relief-layer')) {
        _map.setPaintProperty('rrim-relief-layer', 'raster-opacity', v);
        if (_map.getLayer('rrim-qchizu-layer')) _map.setPaintProperty('rrim-qchizu-layer', 'raster-opacity', v);
      }
      if (_currentOverlay === 'curvature') scheduleDataOverlayDeckSync('curvature');
      if (_currentOverlay === 'rrim') {
        REGIONAL_RRIM_LAYERS.forEach(layer => {
          if (_map.getLayer(layer.layerId)) _map.setPaintProperty(layer.layerId, 'raster-opacity', v);
        });
      }
      updateShareableUrl();
      saveUiState();
    });
  }
}

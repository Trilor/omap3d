/**
 * uiStateManager.js — UI状態の永続化・URL共有・復元
 *
 * 担当:
 *   - saveUiState()        localStorage へ現在の UI 状態を保存
 *   - updateShareableUrl() URL クエリパラメータを現在状態で更新
 *   - restoreUiState()     URL クエリ / localStorage から UI 状態を復元
 *
 * 使い方: init(deps) を map.on('load') 内の早い段階で呼ぶ。
 * DOM 要素は ID で直接取得（引数渡し不要）。
 * app.js 側の関数（switchBasemap 等）は deps 経由で注入し循環 import を回避。
 */

import { savePersistedState, loadPersistedState } from './uiPersistence.js';
import {
  getSidebarPanel, isSidebarOpen,
  restoreSidebarState,
} from './uiState.js';
import { updateSliderGradient } from '../utils/slider.js';
import { contourState, setAllContourVisibility } from '../core/contours.js';
import {
  applyMagneticLineColor, setUserMagneticInterval,
} from '../core/magneticLines.js';
import { updateMagneticAttribution } from '../core/attribution.js';
import { showMapLoading } from '../ui/mapLoading.js';

let _deps = {};

/**
 * @param {{
 *   getCurrentBasemap: () => string,
 *   getCurrentOverlay: () => string,
 *   setCurrentOverlay: (v: string) => void,
 *   getUserContourInterval: () => number,
 *   setUserContourInterval: (v: number) => void,
 *   getMap: () => maplibregl.Map,
 *   switchBasemap: (key: string) => void,
 *   applyContourInterval: (iv: number) => void,
 *   updateCsVisibility: () => void,
 *   setTerrain3dEnabled: (on: boolean, opts: object) => void,
 *   setBuilding3dEnabled: (on: boolean, opts: object) => Promise<void>,
 * }} deps
 */
export function init(deps) {
  _deps = deps;
}

// ---- DOM ヘルパー（内部）----

function _el(id) { return document.getElementById(id); }

// ---- 公開 API ----

export function saveUiState() {
  savePersistedState({
    basemap:             _deps.getCurrentBasemap(),
    overlay:             _deps.getCurrentOverlay(),
    overlayOpacity:      _el('slider-cs')?.value,
    contourVisible:      _el('contour-card')?.classList.contains('active'),
    contourDem:          _el('sel-contour-dem')?.value,
    contourInterval:     _el('sel-contour-interval')?.value,
    magneticVisible:     _el('magnetic-card')?.classList.contains('active'),
    magneticModel:       _el('sel-magnetic-model')?.value,
    magneticInterval:    _el('sel-magnetic-combined')?.value,
    magneticColor:       _el('sel-magnetic-color')?.value,
    terrain3d:           _el('terrain3d-card')?.classList.contains('active'),
    terrainExaggeration: _el('sel-terrain-exaggeration')?.value,
    building:            _el('building3d-card')?.classList.contains('active'),
    buildingSrc:         _el('sel-building')?.value ?? 'plateau',
    sidebarPanel:        getSidebarPanel(),
    sidebarOpen:         isSidebarOpen(),
  });
}

export function updateShareableUrl() {
  const p = new URLSearchParams(location.search);
  const basemap = _deps.getCurrentBasemap();
  const overlay = _deps.getCurrentOverlay();

  // ベースマップ（デフォルト: orilibre → 省略）
  if (basemap && basemap !== 'orilibre') p.set('base', basemap);
  else p.delete('base');

  // オーバーレイ（デフォルト: none → 省略）
  if (overlay && overlay !== 'none') p.set('overlay', overlay);
  else p.delete('overlay');

  // 透明度（デフォルト: 1.0 → 省略）
  const sliderCs = _el('slider-cs');
  const opacity = parseFloat(sliderCs?.value ?? 1);
  if (Math.abs(opacity - 1.0) > 0.005) p.set('opacity', opacity);
  else p.delete('opacity');

  // 等高線（ON = デフォルト → 省略; OFF時のみ明示）
  const contourCard = _el('contour-card');
  if (contourCard?.classList.contains('active')) {
    p.delete('contour');
    const ci = _el('sel-contour-interval')?.value;
    if (ci !== '5') p.set('cont_int', ci); else p.delete('cont_int');
    const cd = _el('sel-contour-dem')?.value;
    if (cd !== 'q1m') p.set('cont_dem', cd); else p.delete('cont_dem');
  } else {
    p.set('contour', '0'); p.delete('cont_int'); p.delete('cont_dem');
  }

  // 磁北線（ON = デフォルト → 省略; OFF時のみ明示）
  const magneticCard = _el('magnetic-card');
  if (magneticCard?.classList.contains('active')) {
    p.delete('magnetic');
    const mi = _el('sel-magnetic-combined')?.value;
    if (mi !== '300') p.set('mag_int', mi); else p.delete('mag_int');
    const mm = _el('sel-magnetic-model')?.value;
    if (mm !== 'gsi2020') p.set('mag_model', mm); else p.delete('mag_model');
  } else {
    p.set('magnetic', '0'); p.delete('mag_int'); p.delete('mag_model');
  }

  // 3D地形（OFF → 省略）
  const terrain3dCard = _el('terrain3d-card');
  if (terrain3dCard?.classList.contains('active')) {
    p.set('terrain', '1');
    const ex = _el('sel-terrain-exaggeration')?.value;
    if (ex !== '1') p.set('exag', ex); else p.delete('exag');
  } else {
    p.delete('terrain'); p.delete('exag');
  }

  // 建物（OFF → 省略）
  const building3dCard = _el('building3d-card');
  if (building3dCard?.classList.contains('active')) {
    p.set('building', '1');
    const bs = _el('sel-building')?.value ?? 'plateau';
    if (bs !== 'plateau') p.set('bld_src', bs); else p.delete('bld_src');
  } else {
    p.delete('building'); p.delete('bld_src');
  }

  const qs = p.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
}

export function restoreUiState() {
  try {
    const up = new URLSearchParams(location.search);
    const s  = loadPersistedState();
    const map = _deps.getMap();

    // ベースマップ：URL > localStorage
    const targetBase = up.get('base') || s.basemap;
    if (targetBase) {
      const card = document.querySelector(`#basemap-cards .bm-card[data-key="${targetBase}"]`);
      if (card) {
        document.querySelectorAll('#basemap-cards .bm-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        _deps.switchBasemap(targetBase);
      }
    }

    // 透明度：URL > localStorage
    const sliderCs = _el('slider-cs');
    const targetOpacity = up.has('opacity') ? parseFloat(up.get('opacity')) : parseFloat(s.overlayOpacity ?? 1);
    if (sliderCs) { sliderCs.value = targetOpacity; updateSliderGradient(sliderCs); }

    // 等高線DEMソース：URL > localStorage
    const selContourDem = _el('sel-contour-dem');
    const targetContDem = up.get('cont_dem') || s.contourDem;
    if (targetContDem && selContourDem) {
      selContourDem.value = targetContDem;
      selContourDem._csRefresh?.();
      contourState.demMode = targetContDem;
    }

    // 等高線間隔：URL > localStorage
    const selContourInterval = _el('sel-contour-interval');
    const targetContInt = up.get('cont_int') || s.contourInterval;
    if (targetContInt && selContourInterval) {
      selContourInterval.value = targetContInt;
      selContourInterval._csRefresh?.();
      _deps.setUserContourInterval(parseFloat(targetContInt) || 5);
    }

    // 等高線表示：URL > localStorage（デフォルトON）
    const contourCard = _el('contour-card');
    const contourOn = up.has('contour') ? up.get('contour') !== '0' : (s.contourVisible ?? true);
    if (contourOn && contourCard) {
      contourCard.classList.add('active');
      _deps.applyContourInterval(_deps.getUserContourInterval());
      setAllContourVisibility(map, 'visible');
    }

    // 磁北線モデル：URL > localStorage
    const selMagneticModel = _el('sel-magnetic-model');
    const targetMagModel = up.get('mag_model') || s.magneticModel;
    if (targetMagModel && selMagneticModel) { selMagneticModel.value = targetMagModel; selMagneticModel._csRefresh?.(); }
    const selMagneticColor = _el('sel-magnetic-color');
    if (s.magneticColor && selMagneticColor) {
      selMagneticColor.value = s.magneticColor; selMagneticColor._csRefresh?.();
      applyMagneticLineColor();
    }

    // 磁北線間隔：URL > localStorage
    const selMagneticCombined = _el('sel-magnetic-combined');
    const targetMagInt = up.get('mag_int') || s.magneticInterval;
    if (targetMagInt && selMagneticCombined) {
      selMagneticCombined.value = targetMagInt;
      selMagneticCombined._csRefresh?.();
      setUserMagneticInterval(parseInt(targetMagInt, 10) || 300);
    }

    // 磁北線表示：URL > localStorage（デフォルトON）
    const magneticCard = _el('magnetic-card');
    const magneticOn = up.has('magnetic') ? up.get('magnetic') !== '0' : (s.magneticVisible ?? true);
    if (magneticOn && magneticCard) {
      magneticCard.classList.add('active');
      if (map.getLayer('magnetic-north-layer')) {
        map.setLayoutProperty('magnetic-north-layer', 'visibility', 'visible');
      }
      updateMagneticAttribution();
    }

    // 地形誇張倍率：URL > localStorage
    const selTerrainExaggeration = _el('sel-terrain-exaggeration');
    const targetExag = up.get('exag') || s.terrainExaggeration;
    if (targetExag && selTerrainExaggeration) { selTerrainExaggeration.value = targetExag; selTerrainExaggeration._csRefresh?.(); }

    // 3D地形表示：URL > localStorage
    const terrainOn = up.has('terrain') ? up.get('terrain') === '1' : !!s.terrain3d;
    _deps.setTerrain3dEnabled(terrainOn, { updateCard: true });

    // 建物ソース：URL > localStorage
    const selBldEl = _el('sel-building');
    const targetBldSrc = up.get('bld_src') || s.buildingSrc || 'plateau';
    if (selBldEl) { selBldEl.value = targetBldSrc; selBldEl._csRefresh?.(); }

    // 建物表示：URL > localStorage
    const buildingOn = up.has('building') ? up.get('building') === '1' : !!s.building;
    void _deps.setBuilding3dEnabled(buildingOn, { updateCard: true });

    // オーバーレイ：URL > localStorage
    const targetOverlay = up.get('overlay') || s.overlay;
    if (targetOverlay && targetOverlay !== 'none') {
      const card = document.querySelector(`#overlay-cards .bm-card[data-key="${targetOverlay}"]`);
      if (card) {
        document.querySelectorAll('#overlay-cards .bm-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        _deps.setCurrentOverlay(targetOverlay);
        _deps.updateCsVisibility();
        if (['cs', 'color-relief', 'slope', 'curvature', 'rrim'].includes(targetOverlay)) showMapLoading();
      }
    }

    // タブ（サイドバーパネル）：ui/uiState.js に委譲
    restoreSidebarState(s);
  } catch {}
}

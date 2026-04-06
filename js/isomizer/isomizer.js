// isomizer.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)
// 設定データ（YAML）はすべて orilibre-config.js にインライン化済み。

import { addImages }      from "./addImages.js";
import { addSources }     from "./addSources.js";
import { addLayers }      from "./addLayers.js";
import { generateStyle, resolveColor }  from "./generateStyle.js";
import { DESIGN_PLAN, SYMBOL_PALETTE, COLOR_PALETTES, IMAGE_PALETTE } from "./orilibre-config.js";

// 初回 isomizer() 呼び出し後に保持する colorMap
// { layerId: { colorKey: string, paintProp: string } }
let _colorMap = null;

/**
 * OriLibre スタイルをマップに適用する。
 * @param {maplibregl.Map} map
 * @param {'hex'|'iof'} paletteName 使用する色セット（デフォルト: 'hex'）
 */
export async function isomizer(map, paletteName = 'hex') {
  try {
    const palette = COLOR_PALETTES[paletteName] ?? COLOR_PALETTES.hex;
    const style = await generateStyle(
      DESIGN_PLAN.rules,
      DESIGN_PLAN.sources,
      SYMBOL_PALETTE["symbol-palette"],
      palette
    );

    _colorMap = style.colorMap;

    await addImages(map,  IMAGE_PALETTE["image-palette"]);
    await addSources(map, DESIGN_PLAN.sources);
    await addLayers(map,  style.layers);

    return map;
  } catch (error) {
    console.error("Error during isomizer process:", error);
  }
}

/**
 * 初期化済みのマップ上の OriLibre レイヤー色を別の色セットに切り替える。
 * isomizer() 呼び出し後にのみ有効。
 * @param {maplibregl.Map} map
 * @param {'hex'|'iof'} paletteName 切り替え先の色セット
 */
export function recolorMap(map, paletteName) {
  if (!_colorMap) return;
  const palette = COLOR_PALETTES[paletteName] ?? COLOR_PALETTES.hex;
  for (const [layerId, { colorKey, paintProp }] of Object.entries(_colorMap)) {
    if (!map.getLayer(layerId)) continue;
    const hex = resolveColor(colorKey, palette);
    if (hex === undefined) continue;
    map.setPaintProperty(layerId, paintProp, hex);
  }
}

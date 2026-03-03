// isomizer.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)
// 設定データ（YAML）はすべて orilibre-config.js にインライン化済み。

import { addImages }      from "./addImages.js";
import { addSources }     from "./addSources.js";
import { addLayers }      from "./addLayers.js";
import { generateStyle }  from "./generateStyle.js";
import { DESIGN_PLAN, SYMBOL_PALETTE, COLOR_PALETTE, IMAGE_PALETTE } from "./orilibre-config.js";

export async function isomizer(map) {
  try {
    const style = await generateStyle(
      DESIGN_PLAN.rules,
      DESIGN_PLAN.sources,
      SYMBOL_PALETTE["symbol-palette"],
      COLOR_PALETTE["color-palette"]
    );

    await addImages(map,  IMAGE_PALETTE["image-palette"]);
    await addSources(map, DESIGN_PLAN.sources);
    await addLayers(map,  style.layers);

    return map;
  } catch (error) {
    console.error("Error during isomizer process:", error);
  }
}

// generateStyle.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)

const MM_TO_PX = 3.8; // (96 DPI)
const withIf = (cond, obj) => (cond ? obj : {});

function mmToPx(mm, precision = 1) {
  const factor = 10 ** precision;
  return Math.round(mm * MM_TO_PX * factor) / factor;
}

/** CMYK (0–100) → #RRGGBB 変換（ICC プロファイルなしの単純変換） */
function cmykToHex(c, m, y, k) {
  const r = Math.round(255 * (1 - c / 100) * (1 - k / 100));
  const g = Math.round(255 * (1 - m / 100) * (1 - k / 100));
  const b = Math.round(255 * (1 - y / 100) * (1 - k / 100));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * color-palette の colors 配列から colorKey に対応する hex 文字列を返す。
 * 色定義が { hex } の場合はそのまま、{ cmyk } の場合は変換する。
 * placeholder（空オブジェクト）は undefined を返す。
 */
function getColor(colorKey, colors) {
  const [group, color] = colorKey.split(".");
  const groupIndex = colors.findIndex((item) => item[group]);
  const colorIndex = colors[groupIndex][group].findIndex((item) => item[color]);
  const def = colors[groupIndex][group][colorIndex][color];
  if (def.cmyk) return cmykToHex(...def.cmyk);
  return def.hex; // { hex } または placeholder の undefined
}

/** getColor を外部（isomizer.js の recolorMap）から利用するためのエクスポート */
export function resolveColor(colorKey, colors) {
  return getColor(colorKey, colors);
}

function getColorOrderIndex(colorKey, colors) {
  const [group, color] = colorKey.split(".");
  const groupIndex = colors.findIndex((item) => item[group]);
  const colorIndex = colors[groupIndex][group].findIndex((item) => item[color]);
  const paddedGroupIndex = groupIndex.toString().padStart(2, "0");
  const paddedColorIndex = colorIndex.toString().padStart(2, "0");
  return `${paddedGroupIndex}-${paddedColorIndex}`;
}

function normalizeSymbolType(type) {
  switch (type) {
    case "point": return "symbol";
    case "area":  return "fill";
    default:      return type;
  }
}

function getSymbolFromPalette(symbolId, symbols) {
  const symbol = symbols.find((s) => s.symbol_id === symbolId);
  if (!symbol) return null;
  return { ...symbol, type: normalizeSymbolType(symbol.type) };
}

function generateLayerId(index, symbolId, suffix = "") {
  return suffix ? `${index}-${symbolId}-${suffix}` : `${index}-${symbolId}`;
}

function resolveLayerStyle(symbol, hex) {
  const paint  = { ...(symbol.paint  || {}) };
  const layout = { ...(symbol.layout || {}) };

  switch (symbol.type) {
    case "line": {
      paint["line-color"] = hex;
      if (symbol.property["line-width(mm)"]) {
        paint["line-width"] = mmToPx(symbol.property["line-width(mm)"]);
      }
      if (symbol.property["line-dasharray(mm)"]) {
        paint["line-dasharray"] = symbol.property["line-dasharray(mm)"].map((v) => mmToPx(v));
      }
      break;
    }
    case "fill": {
      if (!("fill-pattern" in paint)) {
        paint["fill-color"] = hex;
      }
      break;
    }
    case "symbol": {
      if (symbol.property["image-id"]) {
        layout["icon-image"] = symbol.property["image-id"];
      }
      if (symbol.property["icon-size(mm)"]) {
        layout["icon-size"] = mmToPx(symbol.property["icon-size(mm)"]);
      }
      break;
    }
    case "background": break;
  }

  return { paint, layout };
}

function createBaseLayer({ id, symbol, paint, layout }) {
  return {
    id,
    type: symbol.type,
    ...withIf(symbol.minzoom, { minzoom: symbol.minzoom }),
    ...withIf(symbol.maxzoom, { maxzoom: symbol.maxzoom }),
    ...withIf(Object.keys(layout).length, { layout }),
    ...withIf(Object.keys(paint).length,  { paint  }),
  };
}

function withSource(layer, link) {
  return {
    ...layer,
    ...withIf(link.source,          { source:         link.source }),
    ...withIf(link["source-layer"], { "source-layer": link["source-layer"] }),
    ...withIf(link.filter,          { filter:          link.filter }),
  };
}

/**
 * ルールからレイヤーを生成し、{ layer, colorKey, paintProp } の配列を返す。
 * paintProp は recolorMap で setPaintProperty に使うプロパティ名。
 * fill-pattern レイヤーや色を持たないレイヤーは paintProp: null。
 */
function generateLayersFromRule(rule, symbols, colors) {
  return rule.symbol_id.flatMap((symbolId) => {
    const symbol = getSymbolFromPalette(symbolId, symbols);
    if (!symbol) throw new Error(`Symbol not found for symbol_id: ${symbolId}`);

    if (symbol.type === "background") {
      const colorKey = symbol.property["color-key"];
      const hex      = getColor(colorKey, colors);
      const index    = getColorOrderIndex(colorKey, colors);
      const layer    = { id: generateLayerId(index, symbolId), type: "background", paint: { "background-color": hex } };
      return [{ layer, colorKey, paintProp: "background-color" }];
    }

    // fill-pattern を持つ fill レイヤーは色を持たない
    const hasFillPattern = symbol.type === "fill" && "fill-pattern" in (symbol.paint || {});
    const paintProp = symbol.type === "line" ? "line-color"
      : symbol.type === "fill" && !hasFillPattern ? "fill-color"
      : null;

    return rule.links.map((link, linkIndex) => {
      const colorKey = symbol.property["color-key"];
      const hex      = getColor(colorKey, colors);
      const index    = getColorOrderIndex(colorKey, colors);

      const suffixParts = [link.source, link["source-layer"], linkIndex].filter(Boolean);
      const suffix      = suffixParts.join("-");

      const { paint, layout } = resolveLayerStyle(symbol, hex);
      const baseLayer = createBaseLayer({ id: generateLayerId(index, symbolId, suffix), symbol, paint, layout });
      return { layer: withSource(baseLayer, link), colorKey, paintProp };
    });
  });
}

/**
 * 全ルールからレイヤーと colorMap を生成する。
 * colorMap: { layerId: { colorKey, paintProp } } — recolorMap で使用。
 */
async function generateLayers(rules, symbols, colors) {
  const entries = rules.flatMap((rule) => {
    try {
      return generateLayersFromRule(rule, symbols, colors);
    } catch (error) {
      console.error(`Failed to process rule with symbol_id ${rule.symbol_id}: ${error.message}`);
      return [];
    }
  });
  entries.sort((a, b) => a.layer.id.localeCompare(b.layer.id));

  const layers   = entries.map(e => e.layer);
  const colorMap = {};
  for (const { layer, colorKey, paintProp } of entries) {
    if (paintProp) colorMap[layer.id] = { colorKey, paintProp };
  }
  return { layers, colorMap };
}

export async function generateStyle(rules, sources, symbols, colors) {
  try {
    const { layers, colorMap } = await generateLayers(rules, symbols, colors);
    return { version: 8, sources, layers, colorMap };
  } catch (error) {
    console.error("Error generating style:", error);
    throw error;
  }
}

// orilibre-config.js
// OriLibre - Japan の設定データ（ローカルコピー）
// 元ソース: tjmsy/isomizer-projectfiles@0.3 / tjmsy/orilibre
// YAML ファイルを JavaScript オブジェクトに変換、SVG はインライン埋め込み済み。

// ===== design-plan.yml =====
export const DESIGN_PLAN = {
  sources: {
    ofm: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    },
    gsivt: {
      type: "vector",
      attribution: "<a href='https://maps.gsi.go.jp/development/vt.html'>国土地理院ベクトルタイル</a>",
      tiles: ["https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/{z}/{x}/{y}.pbf"],
      maxzoom: 16,
    },
    fude: {
      type: "vector",
      attribution: "<a href='https://github.com/optgeo/ag?tab=readme-ov-file#%E5%87%BA%E5%85%B8' target='_blank'>筆ポリゴン(農林水産省)</a>",
      tiles: ["https://optgeo.github.io/ag-tiles/zxy/{z}/{x}/{y}.pbf"],
      minzoom: 11,
      maxzoom: 13,
    },
  },
  rules: [
    { symbol_id: ["background"] },
    {
      symbol_id: ["101-contour"],
      links: [{ source: "contour-source", "source-layer": "contours" }],
    },
    {
      symbol_id: ["208-boulder-field"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["all", ["in", "class", "rock"], ["in", "subclass", "scree"]],
      }],
    },
    {
      symbol_id: ["213-sandy-ground"],
      links: [{ source: "ofm", "source-layer": "landcover", filter: ["in", "class", "sand"] }],
    },
    {
      symbol_id: ["214-bare-rock"],
      links: [{ source: "ofm", "source-layer": "landcover", filter: ["==", "subclass", "bare_rock"] }],
    },
    {
      symbol_id: ["301-uncrossable-water"],
      links: [{ source: "gsivt", "source-layer": "waterarea" }],
    },
    {
      symbol_id: ["301-1-water-boundary"],
      links: [
        { source: "gsivt", "source-layer": "coastline", filter: null },
        { source: "gsivt", "source-layer": "river",     filter: ["in", "ftCode", 5201, 5202, 5203] },
        { source: "gsivt", "source-layer": "lake",      filter: ["in", "ftCode", 5231, 5232, 5233] },
      ],
    },
    {
      symbol_id: ["304-crossable-watercourse"],
      links: [{ source: "gsivt", "source-layer": "river", filter: ["in", "ftCode", 5301] }],
    },
    {
      symbol_id: ["306-minor-seasonal-water-channel"],
      links: [{ source: "gsivt", "source-layer": "river", filter: ["in", "ftCode", 5302] }],
    },
    {
      symbol_id: ["307-uncrossable-marsh"],
      links: [{ source: "ofm", "source-layer": "landcover", filter: ["in", "class", "wetland", "marsh"] }],
    },
    {
      symbol_id: ["401-open-land"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["all",
          ["in", "class", "grass"],
          ["!=", "subclass", "golf_course"],
          ["!=", "subclass", "scrub"],
          ["!=", "subclass", "park"],
          ["!=", "subclass", "garden"],
          ["!=", "subclass", "meadow"],
          ["!=", "subclass", "grassland"],
          ["!=", "subclass", "heath"],
          ["!=", "subclass", "logging"],
        ],
      }],
    },
    {
      symbol_id: ["403-rough-open-land"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["in", "subclass", "meadow", "grassland", "heath", "logging"],
      }],
    },
    {
      symbol_id: ["405-forest"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["any",
          ["in", "class", "forest", "wood", "park", "tree"],
          ["in", "subclass", "park"],
        ],
      }],
    },
    {
      symbol_id: ["408-vegetation-walk"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["any", ["==", "subclass", "scrub"], ["==", "wood:density", "dense"]],
      }],
    },
    {
      symbol_id: ["412-cultivated-land"],
      links: [{ source: "fude", "source-layer": "farmland" }],
    },
    {
      symbol_id: ["413-orchard"],
      links: [{
        source: "ofm", "source-layer": "landcover",
        filter: ["in", "subclass", "orchard", "vineyard"],
      }],
    },
    {
      symbol_id: ["501-paved-area"],
      links: [{
        source: "ofm", "source-layer": "landuse",
        filter: ["in", "class", "pitch", "track", "playground"],
      }],
    },
    {
      symbol_id: ["502-1-aeroway-taxiway-center", "502-2-aeroway-taxiway-outline"],
      links: [{ source: "ofm", "source-layer": "aeroway", filter: ["all", ["==", "class", "taxiway"]] }],
    },
    {
      symbol_id: ["502-1-aeroway-runway-center", "502-2-aeroway-runway-outline"],
      links: [{ source: "ofm", "source-layer": "aeroway", filter: ["all", ["==", "class", "runway"]] }],
    },
    {
      symbol_id: ["502-1-highway-minor-center", "502-2-highway-minor-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["!=", "brunnel", "tunnel"], ["in", "class", "minor", "service"]],
      }],
    },
    {
      symbol_id: ["502-1-highway-secondary-tertiary-center", "502-2-highway-secondary-tertiary-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["!=", "brunnel", "tunnel"], ["in", "class", "secondary", "tertiary"]],
      }],
    },
    {
      symbol_id: ["502-1-highway-primary-center", "502-2-highway-primary-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["!=", "brunnel", "tunnel"], ["in", "class", "primary"]],
      }],
    },
    {
      symbol_id: ["502-1-highway-trunk-center", "502-2-highway-trunk-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["!=", "brunnel", "tunnel"], ["in", "class", "trunk"]],
      }],
    },
    {
      symbol_id: ["502-1-highway-motorway-center", "502-2-highway-motorway-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["!=", "brunnel", "tunnel"], ["in", "class", "motorway"]],
      }],
    },
    {
      symbol_id: ["504-vehicle-track"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["==", "class", "track"], ["!in", "brunnel", "tunnel"]],
      }],
    },
    {
      symbol_id: ["505-footpath"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["==", "class", "path"], ["!in", "brunnel", "tunnel"]],
      }],
    },
    {
      symbol_id: ["509-1-railway-center", "509-2-railway-outline"],
      links: [{
        source: "ofm", "source-layer": "transportation",
        filter: ["all", ["==", "class", "rail"], ["!=", "brunnel", "tunnel"]],
      }],
    },
    {
      symbol_id: ["520-out-of-bounds"],
      links: [{
        source: "ofm", "source-layer": "landuse",
        filter: ["in", "class",
          "residential", "neighbourhood", "suburb", "commercial", "industrial",
          "cemetery", "hospital", "school", "railway", "retail", "military", "quarter",
        ],
      }],
    },
    {
      symbol_id: ["521-building", "521-2-building-outline"],
      links: [{
        source: "gsivt", "source-layer": "building",
        filter: ["in", "ftCode", 3101, 3102, 3103],
      }],
    },
    {
      symbol_id: ["522-canopy", "522-2-canopy-outline"],
      links: [{
        source: "gsivt", "source-layer": "building",
        filter: ["in", "ftCode", 3111, 3112],
      }],
    },
    {
      symbol_id: ["532-1-stairway-center", "532-2-stairway-outline"],
      links: [{
        source: "gsivt", "source-layer": "road",
        filter: ["in", "ftCode", 2731, 2732, 2733],
      }],
    },
  ],
};

// ===== symbol-palette.yml =====
export const SYMBOL_PALETTE = {
  "symbol-palette": [
    { symbol_id: "background", type: "background", property: { "color-key": "lower.background" } },
    {
      symbol_id: "101-contour", type: "line",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-width": ["match", ["get", "level"], 1, 1, 0.56] },
      property: { "color-key": "upper.brown" },
    },
    {
      symbol_id: "202-cliff", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.38 },
    },
    {
      symbol_id: "206-gigantic-boulder", type: "fill",
      paint: {},
      property: { "color-key": "upper.black" },
    },
    {
      symbol_id: "208-boulder-field", type: "fill",
      paint: { "fill-pattern": "boulder-field-pattern" },
      property: { "color-key": "lower.placeholder_boulder-field-pattern" },
    },
    {
      symbol_id: "213-sandy-ground", type: "fill",
      paint: { "fill-pattern": "sandy-ground-pattern" },
      property: { "color-key": "lower.placeholder_sandy-ground-pattern" },
    },
    {
      symbol_id: "214-bare-rock", type: "fill",
      paint: {},
      property: { "color-key": "upper.black_25%" },
    },
    {
      symbol_id: "301-uncrossable-water", type: "fill",
      paint: {},
      property: { "color-key": "upper.blue" },
    },
    {
      symbol_id: "301-1-water-boundary", type: "line",
      layout: { "line-join": "bevel", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black_water_boundary", "line-width(mm)": 0.54 },
    },
    {
      symbol_id: "302-shallow-water", type: "fill",
      paint: {},
      property: { "color-key": "upper.blue_50%" },
    },
    {
      symbol_id: "304-crossable-watercourse", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.blue", "line-width(mm)": 0.45 },
    },
    {
      symbol_id: "304-stream", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 13, 0.5, 20, 6] },
      property: { "color-key": "upper.blue" },
    },
    {
      symbol_id: "304-river", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.8, 20, 6] },
      property: { "color-key": "upper.blue" },
    },
    {
      symbol_id: "305-small-crossable-watercourse", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.blue", "line-width(mm)": 0.27 },
    },
    {
      symbol_id: "306-minor-seasonal-water-channel", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.blue", "line-width(mm)": 0.27, "line-dasharray(mm)": [1.88, 0.38] },
    },
    {
      symbol_id: "307-uncrossable-marsh", type: "fill",
      paint: { "fill-pattern": "marsh-pattern" },
      property: { "color-key": "upper.placeholder_marsh-pattern" },
    },
    {
      symbol_id: "401-open-land", type: "fill",
      paint: {},
      property: { "color-key": "lower.yellow" },
    },
    {
      symbol_id: "403-rough-open-land", type: "fill",
      paint: {},
      property: { "color-key": "lower.yellow_50%" },
    },
    {
      symbol_id: "405-forest", type: "fill",
      paint: {},
      property: { "color-key": "lower.white" },
    },
    {
      symbol_id: "406-vegetation-slow-running", type: "fill",
      paint: {},
      property: { "color-key": "lower.green_30%" },
    },
    {
      symbol_id: "408-vegetation-walk", type: "fill",
      paint: {},
      property: { "color-key": "lower.green_60%" },
    },
    {
      symbol_id: "410-vegetation-fight", type: "fill",
      paint: {},
      property: { "color-key": "lower.green_100%" },
    },
    {
      symbol_id: "412-cultivated-land", type: "fill",
      paint: { "fill-pattern": "cultivated-land-pattern" },
      property: { "color-key": "lower.placeholder_cultivated-land-pattern" },
    },
    {
      symbol_id: "413-orchard", type: "fill",
      paint: { "fill-pattern": "orchard-pattern" },
      property: { "color-key": "lower.placeholder_orchard-pattern" },
    },
    {
      symbol_id: "415-distinct-cultivation-boundary", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.21 },
    },
    {
      symbol_id: "501-paved-area", type: "fill",
      paint: {},
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "501-paved-area-casing", type: "line",
      paint: {},
      property: { "color-key": "upper.black_casing", "line-width(mm)": 0.5 },
    },
    {
      symbol_id: "502-1-wide-road-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.brown_50%", "line-width(mm)": 0.45 },
    },
    {
      symbol_id: "502-2-wide-road-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.21 },
    },
    {
      symbol_id: "502-1-aeroway-taxiway-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 1, 17, 10] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-aeroway-taxiway-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 2, 17, 12] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-aeroway-runway-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 4, 17, 50] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-aeroway-runway-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 5, 17, 55] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-highway-minor-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 13.5, 0, 14, 2.5, 20, 12.5] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-highway-minor-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 12, 0.5, 13, 1, 14, 3.5, 20, 14] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-highway-secondary-tertiary-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 6.5, 0, 8, 0.5, 20, 13] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-highway-secondary-tertiary-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 8, 1.5, 20, 17] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-highway-primary-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 8.5, 0, 9, 0.5, 20, 18] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-highway-primary-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 7, 0, 8, 0.6, 9, 1.5, 20, 22] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-highway-trunk-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 6.5, 0, 7, 0.5, 20, 18] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-highway-trunk-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 5, 0, 6, 0.6, 7, 1.5, 20, 22] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "502-1-highway-motorway-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 6.5, 0, 7, 0.5, 20, 18] },
      property: { "color-key": "upper.brown_50%" },
    },
    {
      symbol_id: "502-2-highway-motorway-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 4, 0, 5, 0.4, 6, 0.6, 7, 1.5, 20, 22] },
      property: { "color-key": "upper.black_casing" },
    },
    {
      symbol_id: "503-road", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.53 },
    },
    {
      symbol_id: "504-vehicle-track", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.53, "line-dasharray(mm)": [4.5, 0.38] },
    },
    {
      symbol_id: "505-footpath", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black_footpath", "line-width(mm)": 0.38, "line-dasharray(mm)": [3, 0.38] },
    },
    {
      symbol_id: "506-small-footpath", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.27, "line-dasharray(mm)": [1.5, 0.38] },
    },
    {
      symbol_id: "508-narrow-ride", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.21, "line-dasharray(mm)": [3, 0.38] },
    },
    {
      symbol_id: "509-1-railway-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.white", "line-width(mm)": 0.3, "line-dasharray(mm)": [1.0, 1.5] },
    },
    {
      symbol_id: "509-2-railway-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black", "line-width(mm)": 0.7 },
    },
    {
      symbol_id: "520-out-of-bounds", type: "fill",
      paint: {},
      property: { "color-key": "lower.yellow_green" },
    },
    {
      symbol_id: "521-building", type: "fill",
      paint: {},
      property: { "color-key": "upper.black_65%" },
    },
    {
      symbol_id: "521-2-building-outline", type: "line",
      minzoom: 14,
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 14, 0.5, 20, 0.75] },
      property: { "color-key": "upper.black_building_outline" },
    },
    {
      symbol_id: "522-canopy", type: "fill",
      paint: {},
      property: { "color-key": "upper.black_20%" },
    },
    {
      symbol_id: "522-2-canopy-outline", type: "line",
      minzoom: 14,
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: { "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 14, 0.25, 20, 0.375] },
      property: { "color-key": "upper.black" },
    },
    {
      symbol_id: "532-1-stairway-center", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.white_stairway", "line-width(mm)": 0.25, "line-dasharray(mm)": [0.20, 0.08] },
    },
    {
      symbol_id: "532-2-stairway-outline", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "upper.black_stairway", "line-width(mm)": 1.0 },
    },
    {
      symbol_id: "601-magnetic-north-line", type: "line",
      layout: { "line-join": "miter", "line-cap": "butt" },
      paint: {},
      property: { "color-key": "overlay.black", "line-width(mm)": 0.15 },
    },
  ],
};

// ===== color-palette.yml =====
export const COLOR_PALETTE = {
  "color-palette": [
    {
      lower: [
        { background:                        { hex: "#9BBB1D" } },
        { yellow_green:                      { hex: "#9BBB1D" } },
        { white:                             { hex: "#FFFFFF" } },
        { "placeholder_boulder-field-pattern":  {} },
        { "green_30%":                       { hex: "#C5FFC4" } },
        { "green_60%":                       { hex: "#8AFF74" } },
        { "green_100%":                      { hex: "#3FFF17" } },
        { "yellow_50%":                      { hex: "#FFDD9A" } },
        { "placeholder_sandy-ground-pattern":   {} },
        { yellow:                            { hex: "#FFBA35" } },
        { "placeholder_cultivated-land-pattern": {} },
        { "placeholder_orchard-pattern":        {} },
      ],
    },
    {
      upper: [
        { brown:                { hex: "#D25C00" } },
        { green:                { hex: "#3FFF17" } },
        { black_water_boundary: { hex: "#000000" } },
        { "blue_50%":           { hex: "#4DFFFF" } },
        { blue:                 { hex: "#00FFFF" } },
        { "placeholder_marsh-pattern": {} },
        { black_casing:         { hex: "#000000" } },
        { black_footpath:       { hex: "#000000" } },
        { "brown_50%":          { hex: "#E8AD80" } },
        { "black_25%":          { hex: "#BFBFBF" } },
        { "black_20%":          { hex: "#CCCCCC" } },
        { black:                { hex: "#000000" } },
        { black_stairway:       { hex: "#595959" } },
        { white_stairway:       { hex: "#FFFFFF" } },
        { "black_65%":              { hex: "#595959" } },
        { white:                    { hex: "#FFFFFF" } },
        { black_building_outline:   { hex: "#000000" } },
      ],
    },
    {
      overlay: [
        { black:  { hex: "#000000" } },
        { purple: { hex: "#A824FF" } },
      ],
    },
  ],
};

// ===== image-palette.yml（SVGインライン埋め込み済み）=====
export const IMAGE_PALETTE = {
  "image-palette": [
    {
      id: "cultivated-land-pattern",
      svg: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="3.0px" height="3.0px" viewBox="0 0 4.8 4.8"><style type="text/css">.st1{fill:#000000;}</style><rect fill="#ffba35" width="4.8" height="4.8"/><circle class="st1" cx="2.4" cy="2.4" r="1.0"/></svg>`,
    },
    {
      id: "sandy-ground-pattern",
      svg: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="5" height="5" viewBox="0 0 83 83" preserveAspectRatio="none"><path fill="#ffdd9a" d="M-41.5-41.5v166h166v-166z"/><path fill="#000000" d="M41.5 31.5a10 10 0 0 1 0 20a10 10 0 0 1 0-20M0 -10a10 10 0 0 1 0 20a10 10 0 0 1 0-20M83 -10a10 10 0 0 1 0 20a10 10 0 0 1 0-20M0 73a10 10 0 0 1 0 20a10 10 0 0 1 0-20M83 73a10 10 0 0 1 0 20a10 10 0 0 1 0-20"/></svg>`,
    },
    {
      id: "boulder-field-pattern",
      svg: `<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="30" height="30" fill="white"/><polygon points="13.12,10.45 11.98,12.78 14.92,12.29" fill="black"/><polygon points="25.33,19.09 23.93,20.81 25.78,22.25" fill="black"/><polygon points="5.04,8.17 3.88,10.36 5.78,10.97" fill="black"/><polygon points="8.97,22.12 7.36,23.09 9.48,23.83" fill="black"/><polygon points="19.88,6.45 18.35,8.09 20.78,8.93" fill="black"/><polygon points="12.43,15.87 11.06,17.23 13.17,17.68" fill="black"/><polygon points="23.23,11.33 22.09,13.11 24.03,13.56" fill="black"/><polygon points="17.45,26.56 15.89,27.93 17.87,28.34" fill="black"/><polygon points="27.89,14.12 26.36,15.78 28.24,16.59" fill="black"/></svg>`,
    },
    {
      id: "marsh-pattern",
      svg: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="3.0px" height="3.0px" viewBox="0 0 3.0 3.0"><rect x="0" y="0" width="100%" height="3.0" fill="#ffffff"></rect><rect x="0" y="0" width="100%" height="1.0" fill="#00ffff"></rect></svg>`,
    },
    {
      id: "orchard-pattern",
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="0.8mm" height="0.8mm" viewBox="0 0 8 8"><rect fill="#ffba35" width="8" height="8"/><circle cx="4" cy="4" r="2" fill="#3dff17"/></svg>`,
    },
  ],
};

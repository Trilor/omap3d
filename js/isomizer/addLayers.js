// addLayers.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)

export async function addLayers(map, layers) {
  layers.forEach((layer) => {
    try {
      map.addLayer(layer);
    } catch (error) {
      console.error(`Error adding layer ${layer.id}:`, error);
    }
  });
}

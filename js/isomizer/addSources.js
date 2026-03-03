// addSources.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)

export async function addSources(map, sourcesJson) {
  Object.entries(sourcesJson).forEach(([sourceId, sourceData]) => {
    map.addSource(sourceId, sourceData);
  });
}

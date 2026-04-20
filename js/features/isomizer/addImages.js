// addImages.js - ローカルコピー (tjmsy/maplibre-gl-isomizer@0.3)

function getExtension(path) {
  return path?.split("?")[0].split(".").pop()?.toLowerCase();
}

async function loadImageFromUrl(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  return img;
}

async function svgTextToImage(svgText) {
  const cleaned = svgText.replace(
    /<!--[\s\S]*?-->|<script[\s\S]*?<\/script>/g,
    ""
  );
  const blob = new Blob([cleaned], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    return await loadImageFromUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function getImage({ svg, url, file }) {
  if (svg && (url || file)) {
    console.warn("Both 'svg' and 'url/file' are provided. 'svg' will be used.");
  }
  if (url && file) {
    console.warn("Both 'url' and deprecated 'file' are provided. 'url' will be used.");
  }

  if (typeof svg === "string" && svg.trim()) {
    return svgTextToImage(svg);
  }

  const src = url || file;
  if (!src) return null;

  const ext = getExtension(src);

  if (ext === "svg") {
    const res = await fetch(src);
    if (!res.ok) {
      throw new Error(`Failed to fetch SVG: ${src} (${res.status})`);
    }
    const text = await res.text();
    return svgTextToImage(text);
  }

  if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return loadImageFromUrl(src);
  }

  throw new Error(`Unsupported image format: ${src}`);
}

export async function addImages(map, imagePalette) {
  for (const { id, svg, url, file } of imagePalette) {
    try {
      if (!id) {
        console.warn("Missing image id. Skipping entry:", { svg, url, file });
        continue;
      }
      if (map.hasImage(id)) {
        console.warn(`Image id '${id}' already exists. Skipping.`);
        continue;
      }
      const img = await getImage({ svg, url, file });
      if (!img) continue;
      map.addImage(id, img);
    } catch (e) {
      console.error(`Error processing image with id ${id}:`, e);
    }
  }
}

import io, sys

def patch_index():
    with open('index copy.html', 'r', encoding='utf-8') as f:
        lines = f.readlines()

    # 1. 共有CanvasとMutexを用いた gsjdem プロトコルへの置き換え
    start_idx = -1
    end_idx = -1
    for i, line in enumerate(lines):
        if "maplibregl.addProtocol('gsjdem', async (params, abortController) => {" in line:
            start_idx = i
        if start_idx != -1 and "return { data: await blob.arrayBuffer() };" in line:
            end_idx = i + 2  # include the });
            break

    if start_idx != -1 and end_idx != -1:
        new_gsjdem = [
            "    let gsjdemMutex = Promise.resolve();\n",
            "    let sharedCanvas = null;\n",
            "    let sharedCtx = null;\n",
            "\n",
            "    maplibregl.addProtocol('gsjdem', async (params, abortController) => {\n",
            "      const url = params.url.replace('gsjdem://', 'https://');\n",
            "      const response = await fetch(url, { signal: abortController.signal });\n",
            "      if (!response.ok) throw new Error(`GSJ DEM fetch failed: ${response.status}`);\n",
            "      const bitmap = await createImageBitmap(await response.blob());\n",
            "\n",
            "      return new Promise((resolve, reject) => {\n",
            "        gsjdemMutex = gsjdemMutex.then(async () => {\n",
            "          if (abortController.signal.aborted) {\n",
            "            reject(new Error('Aborted'));\n",
            "            return;\n",
            "          }\n",
            "          try {\n",
            "            if (!sharedCanvas) {\n",
            "              if (typeof OffscreenCanvas !== 'undefined') {\n",
            "                sharedCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);\n",
            "              } else {\n",
            "                sharedCanvas = document.createElement('canvas');\n",
            "              }\n",
            "              sharedCanvas.width = bitmap.width;\n",
            "              sharedCanvas.height = bitmap.height;\n",
            "              sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });\n",
            "            } else if (sharedCanvas.width !== bitmap.width || sharedCanvas.height !== bitmap.height) {\n",
            "              sharedCanvas.width = bitmap.width;\n",
            "              sharedCanvas.height = bitmap.height;\n",
            "            }\n",
            "\n",
            "            sharedCtx.drawImage(bitmap, 0, 0);\n",
            "            const imageData = sharedCtx.getImageData(0, 0, bitmap.width, bitmap.height);\n",
            "            const data = imageData.data;\n",
            "\n",
            "            for (let i = 0; i < data.length; i += 4) {\n",
            "              const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];\n",
            "              if ((r === 128 && g === 0 && b === 0) || a !== 255) {\n",
            "                data[i] = 128; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;\n",
            "                continue;\n",
            "              }\n",
            "              const bits24 = (r << 16) | (g << 8) | b;\n",
            "              const height = ((bits24 << 8) >> 8) * 0.01;\n",
            "              const t = height + 32768;\n",
            "              data[i]     = Math.min(255, Math.max(0, Math.floor(t / 256)));\n",
            "              data[i + 1] = Math.min(255, Math.max(0, Math.floor(t % 256)));\n",
            "              data[i + 2] = Math.min(255, Math.max(0, Math.floor((t % 1) * 256)));\n",
            "              data[i + 3] = 255;\n",
            "            }\n",
            "\n",
            "            sharedCtx.putImageData(imageData, 0, 0);\n",
            "            let blob;\n",
            "            if (sharedCanvas.convertToBlob) {\n",
            "              blob = await sharedCanvas.convertToBlob({ type: 'image/png' });\n",
            "            } else {\n",
            "              blob = await new Promise(res => sharedCanvas.toBlob(res, 'image/png'));\n",
            "            }\n",
            "            resolve({ data: await blob.arrayBuffer() });\n",
            "          } catch (e) {\n",
            "            reject(e);\n",
            "          }\n",
            "        });\n",
            "      });\n",
            "    });\n"
        ]
        del lines[start_idx:end_idx]
        for line in reversed(new_gsjdem):
            lines.insert(start_idx, line)

    # 2. pixelRatio 制約の追加
    map_start_idx = -1
    for i, line in enumerate(lines):
        if 'const map = new maplibregl.Map({' in line:
            map_start_idx = i
            break
            
    if map_start_idx != -1:
        for i in range(map_start_idx, map_start_idx + 10):
            if "container: 'map'," in lines[i]:
                lines.insert(i + 1, "      pixelRatio: Math.min(window.devicePixelRatio, 1.5),\n")
                break

    # 3. マップの背景色をグレーにし、真っ白によるローディング不安を消す
    map_css_idx = -1
    for i, line in enumerate(lines):
        if '#map {' in line:
            map_css_idx = i
            break
            
    if map_css_idx != -1:
        for i in range(map_css_idx, map_css_idx + 10):
            if "height: 100%;" in lines[i]:
                lines.insert(i + 1, "      background-color: #f2efe9;\n")
                break

    with open('index copy.html', 'w', encoding='utf-8') as f:
        f.writelines(lines)

    print("Patch applied successfully.")

if __name__ == '__main__':
    patch_index()

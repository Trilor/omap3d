/**
 * dropHandler.js — ウィンドウ全体へのドラッグ&ドロップ制御
 *
 * ドロップされたファイルをKMZ/GPX/画像の種別に振り分けて各ハンドラに渡す。
 *
 * 使い方: init({ onKmz, onGpx, onImage, onImageWithJgw }) を起動直後に呼ぶ。
 */

/**
 * @param {{
 *   onKmz:         (file: File) => Promise<void>,
 *   onGpx:         (file: File) => Promise<void>,
 *   onImage:       (file: File) => void,
 *   onImageWithJgw:(imgs: File[], jgw: File|null) => void,
 * }} callbacks
 */
export function init({ onKmz, onGpx, onImage, onImageWithJgw }) {
  const dropOverlay = document.getElementById('drop-overlay');
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer.types.includes('Files') && e.relatedTarget === null) {
      dropOverlay?.classList.add('visible');
    }
  });

  document.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay?.classList.remove('visible');
    }
  });

  document.addEventListener('dragover', (e) => { e.preventDefault(); });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay?.classList.remove('visible');

    const allFiles = Array.from(e.dataTransfer.files);
    if (allFiles.length === 0) return;

    const kmzFiles = allFiles.filter(f => /\.kmz$/i.test(f.name));
    const gpxFiles = allFiles.filter(f => /\.gpx$/i.test(f.name));
    const imgFiles = allFiles.filter(f => /\.(jpe?g|png)$/i.test(f.name));
    const jgwFiles = allFiles.filter(f => /\.(jgw|pgw|tfw|wld)$/i.test(f.name));

    if (kmzFiles.length === 0 && gpxFiles.length === 0 &&
        imgFiles.length === 0 && jgwFiles.length === 0) {
      alert('.kmz・.gpx・または 画像+ワールドファイル をドロップしてください。');
      return;
    }

    for (const file of kmzFiles) await onKmz(file);
    for (const file of gpxFiles) await onGpx(file);

    if (imgFiles.length > 0 && jgwFiles.length === 0) {
      for (const file of imgFiles) onImage(file);
    } else if (imgFiles.length > 0 || jgwFiles.length > 0) {
      onImageWithJgw(imgFiles, jgwFiles.length > 0 ? jgwFiles[0] : null);
    }
  });
}

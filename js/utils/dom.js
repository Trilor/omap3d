/* ================================================================
   dom.js — DOM 操作共通ユーティリティ
   ================================================================ */

/** HTML 特殊文字をエスケープしてインジェクションを防ぐ */
export function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** data URL をファイルとしてダウンロードする */
export function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

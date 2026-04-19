/* ================================================================
   imgwModal.js — 画像+JGW ファイル配置モーダル
   ================================================================ */

import { escHtml }         from '../../utils/dom.js';
import { loadImageWithJgw } from '../../core/localMapLoader.js';

/* ---- 状態 ---- */
let _imgwModalImages  = [];   // 選択中の画像ファイル配列（File[]）
let _imgwModalJgwFile = null; // 選択中のワールドファイル（File | null）

// モーダルを開く。drag&drop 時は preImages / preJgw を事前セットできる
export function openImgwModal(preImages, preJgw) {
  _imgwModalImages  = preImages || [];
  _imgwModalJgwFile = preJgw   || null;
  updateImgwModalUI();
  document.getElementById('imgw-modal').style.display = 'flex';
}

// モーダルを閉じて状態をリセットする
export function closeImgwModal() {
  document.getElementById('imgw-modal').style.display = 'none';
  _imgwModalImages  = [];
  _imgwModalJgwFile = null;
}

// モーダル内の表示を選択状態に合わせて更新する
export function updateImgwModalUI() {
  // --- 画像ファイルリスト ---
  const imgBtn  = document.getElementById('imgw-img-btn');
  const imgList = document.getElementById('imgw-img-list');
  if (_imgwModalImages.length > 0) {
    imgList.innerHTML = _imgwModalImages
      .map(f => `<div class="imgw-file-item">${escHtml(f.name)}</div>`).join('');
    imgBtn.classList.add('has-files');
    imgBtn.textContent = `画像を変更（現在 ${_imgwModalImages.length} 枚）`;
  } else {
    imgList.innerHTML = '';
    imgBtn.classList.remove('has-files');
    imgBtn.textContent = '画像を選択（JPG / PNG）';
  }

  // --- ワールドファイル ---
  const jgwBtn  = document.getElementById('imgw-jgw-btn');
  const jgwName = document.getElementById('imgw-jgw-name');
  if (_imgwModalJgwFile) {
    jgwName.innerHTML = `<div class="imgw-file-item">${escHtml(_imgwModalJgwFile.name)}</div>`;
    jgwBtn.classList.add('has-files');
    jgwBtn.textContent = 'ワールドファイルを変更';
  } else {
    jgwName.innerHTML = '';
    jgwBtn.classList.remove('has-files');
    jgwBtn.textContent = 'ワールドファイルを選択（JGW / PGW / TFW）';
  }

  // --- 配置ボタンの有効/無効 ---
  document.getElementById('imgw-place-btn').disabled =
    _imgwModalImages.length === 0 || _imgwModalJgwFile === null;
}

// DOM イベントリスナーを登録する（DOMContentLoaded 後に呼ぶこと）
export function initImgwModal() {
  document.getElementById('imgw-modal-close-btn').addEventListener('click', closeImgwModal);
  document.getElementById('imgw-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeImgwModal();
  });

  const imgwImgInput = document.getElementById('imgw-img-input');
  document.getElementById('imgw-img-btn').addEventListener('click', () => imgwImgInput.click());
  imgwImgInput.addEventListener('change', (e) => {
    _imgwModalImages = Array.from(e.target.files);
    updateImgwModalUI();
    e.target.value = '';
  });

  const imgwJgwInput = document.getElementById('imgw-jgw-input');
  document.getElementById('imgw-jgw-btn').addEventListener('click', () => imgwJgwInput.click());
  imgwJgwInput.addEventListener('change', (e) => {
    _imgwModalJgwFile = e.target.files[0] || null;
    updateImgwModalUI();
    e.target.value = '';
  });

  document.getElementById('imgw-place-btn').addEventListener('click', executeImgwPlace);
}

// 「地図に配置」ボタン押下時の処理
export async function executeImgwPlace() {
  const crsValue = document.getElementById('imgw-crs-select').value;
  const placeBtn = document.getElementById('imgw-place-btn');
  placeBtn.disabled = true;
  placeBtn.textContent = '配置中…';

  try {
    const jgwText = await _imgwModalJgwFile.text();
    // 選択した全画像に同じワールドファイル（位置情報）を適用する
    for (const imgFile of _imgwModalImages) {
      await loadImageWithJgw(imgFile, jgwText, crsValue);
    }
    closeImgwModal();
  } catch (err) {
    console.error('画像+JGW 読み込みエラー:', err);
    alert(`読み込みエラー: ${err.message}`);
    placeBtn.disabled = false;
    placeBtn.textContent = '地図に配置';
  }
}

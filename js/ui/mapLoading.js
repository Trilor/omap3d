/**
 * mapLoading.js — マップローディングインジケーター管理
 *
 * 2種類のインジケーターを管理する:
 *   - map-loading       : 中央オーバーレイ（生成系オーバーレイ選択・切り替え時）
 *   - map-tile-loading  : 右下インジケーター（地図移動・ズーム時のタイル生成中）
 *
 * 使い方: init(map) を map.on('load') 内で呼んでから各関数を使う。
 */

let _map = null;

const _mapLoadingEl = document.getElementById('map-loading');
let _mapLoadingIdleRegistered = false;

const _mapTileLoadingEl = document.getElementById('map-tile-loading');
let _mapTileLoadingIdleRegistered = false;

export function init(map) {
  _map = map;
}

export function showMapLoading() {
  if (_mapLoadingEl) _mapLoadingEl.style.display = 'flex';
  if (_mapLoadingIdleRegistered) return;
  _mapLoadingIdleRegistered = true;
  _map.once('idle', hideMapLoading);
}

export function hideMapLoading() {
  _mapLoadingIdleRegistered = false;
  if (_mapLoadingEl) _mapLoadingEl.style.display = 'none';
}

export function showMapTileLoading() {
  if (_mapTileLoadingEl) _mapTileLoadingEl.style.display = 'flex';
  if (_mapTileLoadingIdleRegistered) return;
  _mapTileLoadingIdleRegistered = true;
  _map.once('idle', hideMapTileLoading);
}

export function hideMapTileLoading() {
  _mapTileLoadingIdleRegistered = false;
  if (_mapTileLoadingEl) _mapTileLoadingEl.style.display = 'none';
}

/* ================================================================
   eventBus.js — アプリ全体の Pub/Sub バス（EventTarget ベース）

   使い方:
     import { emit, on, off } from '../store/eventBus.js';

     on('map:ready',    ({ map }) => { ... });   // 購読
     emit('map:ready', { map });                 // 発火
     off('map:ready',  handler);                 // 解除

   主要イベント一覧:
     map:ready          — MapLibre 初期化完了  { map }
     layer:added        — ローカルマップレイヤー追加  { id, name }
     layer:removed      — ローカルマップレイヤー削除  { id }
     layer:updated      — レイヤー状態変更          { id }
     basemap:changed    — ベースマップ切替          { key }
     gpx:loaded         — GPXロード完了             { points }
     terrain:selected   — テレイン選択              { terrainId }
     sim:started        — PCシミュレーター開始
     sim:stopped        — PCシミュレーター停止
   ================================================================ */

const _bus = new EventTarget();

export const emit = (type, detail = {}) =>
  _bus.dispatchEvent(new CustomEvent(type, { detail }));

export const on = (type, fn) => {
  const handler = e => fn(e.detail);
  _bus.addEventListener(type, handler);
  return handler; // off() に渡すために返す
};

export const off = (type, handler) =>
  _bus.removeEventListener(type, handler);

/**
 * terrainStore.js — テレイン名マスタ
 *
 * ワークスペース DB から取得したテレインオブジェクトを id → object でキャッシュする。
 * app.js・layersPanel.js など複数モジュールが参照するため共有ストアとして切り出す。
 */

export const terrainMap = new Map();

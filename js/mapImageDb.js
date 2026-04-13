/* =====================================================================
   mapImageDb.js — IndexedDB による地図画像レイヤーの永続化

   スキーマ:
     DB 名    : teledrop-map-images
     バージョン: 1
     ストア名  : layers
       id         : auto-increment（PK）
       type       : 'kmz' | 'image-jgw'（読み込み元種別）
       name       : ファイル名（UI 表示用）
       imageBlob  : Blob（画像バイナリ）
       coordinates: [[lng,lat] x4]（TL→TR→BR→BL の MapLibre 順）
       opacity    : number（0〜1）
       visible    : boolean
       savedAt    : number（Date.now()）
   ===================================================================== */

const DB_NAME = 'teledrop-map-images';
const DB_VER  = 1;
const STORE   = 'layers';

let _db = null;

/** DB を開く（初回のみ実際に open する） */
async function _open() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * レイヤーを DB に保存し、割り当てられた id（number）を返す
 * @param {{ type: string, name: string, imageBlob: Blob,
 *           coordinates: number[][], opacity: number, visible: boolean,
 *           terrainId?: string|null, terrainName?: string|null }} data
 */
export async function saveMapLayer({
  type, name, imageBlob, coordinates, opacity, visible,
  terrainId = null, terrainName = null,
}) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add({
      type,
      name,
      imageBlob,
      coordinates,
      opacity:     opacity  ?? 0.8,
      visible:     visible  !== false,
      terrainId:   terrainId  ?? null,
      terrainName: terrainName ?? null,
      savedAt:     Date.now(),
    });
    req.onsuccess = (e) => resolve(e.target.result); // auto-increment id
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * DB に保存されたすべてのレイヤーを savedAt 昇順で返す
 * @returns {Promise<Array>}
 */
export async function getAllMapLayers() {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = (e) => resolve(
      (e.target.result ?? []).sort((a, b) => a.savedAt - b.savedAt)
    );
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * 指定 id のレイヤーを DB から削除する
 * @param {number} id
 */
export async function deleteMapLayer(id) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * レイヤーの opacity / visible を更新する
 * @param {number} id
 * @param {{ opacity?: number, visible?: boolean }} patch
 */
export async function updateMapLayerState(id, patch) {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(STORE, 'readwrite');
    const store   = tx.objectStore(STORE);
    const getReq  = store.get(id);
    getReq.onsuccess = (e) => {
      const rec = e.target.result;
      if (!rec) { resolve(); return; }
      Object.assign(rec, patch);
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = (e2) => reject(e2.target.error);
    };
    getReq.onerror = (e) => reject(e.target.error);
  });
}

/**
 * ストアを全消去する
 */
export async function clearAllMapLayers() {
  const db = await _open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * ストレージ使用量の推定値を返す（バイト）
 * @returns {Promise<{ usage: number, quota: number }>}
 */
export async function estimateStorageUsage() {
  try {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      return await navigator.storage.estimate();
    }
  } catch (_) { /* ignore */ }
  return { usage: 0, quota: 0 };
}

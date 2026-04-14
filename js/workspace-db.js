/**
 * workspace-db.js
 * IndexedDB v2 — ワークスペースの永続化
 *
 * 既存の teledrop-map-images DB (v1) を v2 に拡張する。
 *   layers   ストア: 変更なし（後方互換）
 *   terrains ストア: 新規追加（クラウドテレインのキャッシュ）
 *   events   ストア: 新規追加（テレインに紐づくイベント）
 *
 * terrains レコードスキーマ:
 *   id, name, name_kana, region, prefecture, type, tags[],
 *   base_scale, contour_interval, center[lng,lat], bbox[minX,minY,maxX,maxY],
 *   boundary (GeoJSON Polygon), external_url,
 *   source: 'public'|'local', visible: boolean, cached_at
 *
 * events レコードスキーマ:
 *   id, terrain_id, name, date, event_type,
 *   source: 'public'|'local', created_at
 */

const WS_DB_NAME    = 'teledrop-map-images';
const WS_DB_VERSION = 2;

let _wsDb = null;

function openWorkspaceDb() {
  if (_wsDb) return Promise.resolve(_wsDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WS_DB_NAME, WS_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // terrains ストアを追加（v1 → v2）
      if (!db.objectStoreNames.contains('terrains')) {
        const ts = db.createObjectStore('terrains', { keyPath: 'id' });
        ts.createIndex('source',     'source',     { unique: false });
        ts.createIndex('region',     'region',     { unique: false });
        ts.createIndex('prefecture', 'prefecture', { unique: false });
        ts.createIndex('name',       'name',       { unique: false });
      }

      // events ストアを追加（v1 → v2）
      if (!db.objectStoreNames.contains('events')) {
        const es = db.createObjectStore('events', { keyPath: 'id' });
        es.createIndex('terrain_id', 'terrain_id', { unique: false });
        es.createIndex('source',     'source',     { unique: false });
      }
    };

    req.onsuccess = (e) => { _wsDb = e.target.result; resolve(_wsDb); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ================================================================
// terrains ストア操作
// ================================================================

export async function getWsTerrains() {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('terrains', 'readonly');
  const store = tx.objectStore('terrains');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function getWsTerrain(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('terrains', 'readonly');
  const store = tx.objectStore('terrains');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

export async function saveWsTerrain(terrain) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('terrains', 'readwrite');
  const store = tx.objectStore('terrains');
  return new Promise((resolve, reject) => {
    const req = store.put({ ...terrain, cached_at: terrain.cached_at ?? Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteWsTerrain(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('terrains', 'readwrite');
  const store = tx.objectStore('terrains');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function updateWsTerrainVisibility(id, visible) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('terrains', 'readwrite');
  const store = tx.objectStore('terrains');
  return new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) return resolve();
      const putReq = store.put({ ...rec, visible });
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ================================================================
// events ストア操作
// ================================================================

export async function getWsEvents(terrainId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    if (terrainId) {
      const index = store.index('terrain_id');
      const req   = index.getAll(terrainId);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    } else {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }
  });
}

export async function saveWsEvent(event) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    const req = store.put({ ...event, created_at: event.created_at ?? Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteWsEvent(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

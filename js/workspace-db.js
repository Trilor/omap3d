/**
 * workspace-db.js
 * IndexedDB v3 — ワークスペースの永続化
 *
 * v1: layers ストア（旧 map-images）
 * v2: + terrains ストア / events ストア（軽量メタデータ）
 * v3: events ストアに controlDefs を持たせる + courses ストアを新規追加
 *
 * events レコードスキーマ (v3):
 *   id, terrain_id, name, source, created_at, updated_at
 *   controlDefs: { [defId]: { code, lng, lat } }  ← マスターコントロールプール
 *   nextDefId: number
 *   nextRouteId: number
 *   activeCourseId: string | null
 *
 * courses レコードスキーマ (v3):
 *   id, event_id, name, sequence: string[], legRoutes: object,
 *   selectedRoutes: [string, string|null][], updated_at
 */

const WS_DB_NAME    = 'teledrop-map-images';
const WS_DB_VERSION = 3;

let _wsDb = null;

function openWorkspaceDb() {
  if (_wsDb) return Promise.resolve(_wsDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WS_DB_NAME, WS_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db  = e.target.result;
      const old = e.oldVersion;

      // v1 → v2: terrains + events ストア
      if (old < 2) {
        if (!db.objectStoreNames.contains('terrains')) {
          const ts = db.createObjectStore('terrains', { keyPath: 'id' });
          ts.createIndex('source',     'source',     { unique: false });
          ts.createIndex('region',     'region',     { unique: false });
          ts.createIndex('prefecture', 'prefecture', { unique: false });
          ts.createIndex('name',       'name',       { unique: false });
        }
        if (!db.objectStoreNames.contains('events')) {
          const es = db.createObjectStore('events', { keyPath: 'id' });
          es.createIndex('terrain_id', 'terrain_id', { unique: false });
          es.createIndex('source',     'source',     { unique: false });
        }
      }

      // v2 → v3: courses ストアを追加
      if (old < 3) {
        if (!db.objectStoreNames.contains('courses')) {
          const cs = db.createObjectStore('courses', { keyPath: 'id' });
          cs.createIndex('event_id', 'event_id', { unique: false });
        }
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

/** 全イベントを返す */
export async function getAllWsEvents() {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** terrain_id でフィルタして返す（terrain_id = null の場合は全件） */
export async function getWsEvents(terrainId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    if (terrainId != null) {
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

/** ID でイベントを取得 */
export async function getWsEvent(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** イベントを保存（controlDefs などフルデータを含む） */
export async function saveWsEvent(event) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const req = store.put({
      created_at: now,
      ...event,
      updated_at: now,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** イベントと配下の全コースを削除 */
export async function deleteWsEvent(id) {
  const db = await openWorkspaceDb();
  const tx = db.transaction(['events', 'courses'], 'readwrite');

  // イベント削除
  const evStore = tx.objectStore('events');
  evStore.delete(id);

  // 配下コース一括削除
  const csStore = tx.objectStore('courses');
  const idx     = csStore.index('event_id');
  return new Promise((resolve, reject) => {
    const req = idx.getAllKeys(id);
    req.onsuccess = () => {
      req.result.forEach(key => csStore.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ================================================================
// courses ストア操作
// ================================================================

/** event_id に属するコース一覧を返す */
export async function getCoursesByEvent(eventId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readonly');
  const store = tx.objectStore('courses');
  const index = store.index('event_id');
  return new Promise((resolve, reject) => {
    const req = index.getAll(eventId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** ID でコースを取得 */
export async function getWsCourse(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readonly');
  const store = tx.objectStore('courses');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** コースを保存（追加・更新） */
export async function saveWsCourse(course) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readwrite');
  const store = tx.objectStore('courses');
  return new Promise((resolve, reject) => {
    const req = store.put({ ...course, updated_at: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** コースを削除 */
export async function deleteWsCourse(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readwrite');
  const store = tx.objectStore('courses');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** イベントに属する全コースのキーを取得して一括削除 */
export async function deleteCoursesForEvent(eventId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readwrite');
  const store = tx.objectStore('courses');
  const index = store.index('event_id');
  return new Promise((resolve, reject) => {
    const req = index.getAllKeys(eventId);
    req.onsuccess = () => {
      req.result.forEach(key => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

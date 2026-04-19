/**
 * workspace-db.js
 * IndexedDB v5 — ワークスペースの永続化
 *
 * v1: layers ストア（旧 map-images）
 * v2: + terrains ストア / events ストア（軽量メタデータ）
 * v3: events ストアに controlDefs を持たせる + courses ストアを新規追加
 * v4: map_sheets ストアを新規追加（コース枠 — 画像位置合わせ用フレーム情報）
 * v5: course_sets ストアを新規追加（コースセット — controlDefs を events から移動）
 *
 * events レコードスキーマ (v5):
 *   id, terrain_id, name, source, created_at, updated_at
 *   ※ controlDefs 等は course_sets に移動済み
 *
 * courses レコードスキーマ (v5):
 *   id, event_id, course_set_id, name, sequence: string[], legRoutes: object,
 *   selectedRoutes: [string, string|null][], updated_at
 *
 * map_sheets レコードスキーマ (v4):
 *   id, event_id, name,
 *   coordinates: [[lng,lat]*4] (TL→TR→BR→BL の MapLibre 順),
 *   paper_size: 'A4'|'A3'|'B4'|'B3'|null,
 *   scale: number|null  (例: 10000 → 1:10,000),
 *   created_at, updated_at
 *
 * course_sets レコードスキーマ (v5):
 *   id              : 'cs-'+timestamp
 *   event_id        : string|null  ← 大会フォルダに属する場合
 *   terrain_id      : string|null  ← テレインに直属する場合（event_id=null 時）
 *   name            : string       ← ユーザーが付けるコースセット名
 *   controlDefs     : { [defId]: { code, lng, lat } }  ← マスターコントロールプール
 *   nextDefId       : number
 *   nextRouteId     : number
 *   activeCourseId  : string|null
 *   created_at, updated_at
 */

const WS_DB_NAME    = 'teledrop-map-images';
const WS_DB_VERSION = 5;

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

      // v3 → v4: map_sheets ストアを追加（コース枠 — 画像位置合わせ用フレーム情報）
      if (old < 4) {
        if (!db.objectStoreNames.contains('map_sheets')) {
          const ms = db.createObjectStore('map_sheets', { keyPath: 'id' });
          ms.createIndex('event_id', 'event_id', { unique: false });
        }
      }

      // v4 → v5: course_sets ストアを追加（コースセット — controlDefs を events から移動）
      if (old < 5) {
        if (!db.objectStoreNames.contains('course_sets')) {
          const css = db.createObjectStore('course_sets', { keyPath: 'id' });
          css.createIndex('event_id',   'event_id',   { unique: false });
          css.createIndex('terrain_id', 'terrain_id', { unique: false });
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

export async function renameWsTerrain(id, newName) {
  const terrain = await getWsTerrain(id);
  if (!terrain) return;
  return saveWsTerrain({ ...terrain, name: newName });
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
      // terrain_id が null のイベントのみ返す（全件取得してフィルタ）
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []).filter(e => e.terrain_id == null));
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

/** イベントと配下の全コース・全コース枠・全コースセットを削除 */
export async function deleteWsEvent(id) {
  const db = await openWorkspaceDb();
  const tx = db.transaction(['events', 'courses', 'map_sheets', 'course_sets'], 'readwrite');

  // イベント削除
  tx.objectStore('events').delete(id);

  // 配下コース一括削除
  const coursesStore = tx.objectStore('courses');
  const coursesIdx   = coursesStore.index('event_id');

  // 配下コース枠一括削除
  const msStore = tx.objectStore('map_sheets');
  const msIdx   = msStore.index('event_id');

  // 配下コースセット一括削除
  const csetStore = tx.objectStore('course_sets');
  const csetIdx   = csetStore.index('event_id');

  return new Promise((resolve, reject) => {
    const coursesReq = coursesIdx.getAllKeys(id);
    coursesReq.onsuccess = () => {
      coursesReq.result.forEach(key => coursesStore.delete(key));
      const msReq = msIdx.getAllKeys(id);
      msReq.onsuccess = () => {
        msReq.result.forEach(key => msStore.delete(key));
        const csetReq = csetIdx.getAllKeys(id);
        csetReq.onsuccess = () => {
          csetReq.result.forEach(key => csetStore.delete(key));
          tx.oncomplete = () => resolve();
          tx.onerror    = () => reject(tx.error);
        };
        csetReq.onerror = () => reject(csetReq.error);
      };
      msReq.onerror = () => reject(msReq.error);
    };
    coursesReq.onerror = () => reject(coursesReq.error);
  });
}

// ================================================================
// courses ストア操作
// ================================================================

/** course_set_id に属するコース一覧を返す */
export async function getCoursesBySet(courseSetId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readonly');
  const store = tx.objectStore('courses');
  return new Promise((resolve, reject) => {
    // course_set_id インデックスがない場合は全件フィルタ
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result ?? []).filter(c => c.course_set_id === courseSetId));
    req.onerror   = () => reject(req.error);
  });
}

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

/** course_set_id に属する全コースを一括削除 */
export async function deleteCoursesBySet(courseSetId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('courses', 'readwrite');
  const store = tx.objectStore('courses');
  return new Promise((resolve, reject) => {
    // 全件フィルタ方式（course_set_id インデックスなし）
    const req = store.getAll();
    req.onsuccess = () => {
      req.result
        .filter(c => c.course_set_id === courseSetId)
        .forEach(c => store.delete(c.id));
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ================================================================
// map_sheets ストア操作（コース枠 — 画像位置合わせ用フレーム情報）
// ================================================================

/** コース枠を保存（追加・更新） */
export async function saveWsMapSheet(sheet) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('map_sheets', 'readwrite');
  const store = tx.objectStore('map_sheets');
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const req = store.put({
      created_at: now,
      ...sheet,
      updated_at: now,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** event_id に属するコース枠一覧を返す */
export async function getMapSheetsByEvent(eventId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('map_sheets', 'readonly');
  const store = tx.objectStore('map_sheets');
  const index = store.index('event_id');
  return new Promise((resolve, reject) => {
    const req = index.getAll(eventId);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** ID でコース枠を取得 */
export async function getWsMapSheet(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('map_sheets', 'readonly');
  const store = tx.objectStore('map_sheets');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** コース枠を削除 */
export async function deleteWsMapSheet(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('map_sheets', 'readwrite');
  const store = tx.objectStore('map_sheets');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** イベントに属する全コース枠を一括削除 */
export async function deleteMapSheetsForEvent(eventId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('map_sheets', 'readwrite');
  const store = tx.objectStore('map_sheets');
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

// ================================================================
// course_sets ストア操作（コースセット — controlDefs の保持単位）
// ================================================================

/** コースセットを保存（追加・更新） */
export async function saveWsCourseSet(courseSet) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readwrite');
  const store = tx.objectStore('course_sets');
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const req = store.put({
      created_at: now,
      ...courseSet,
      updated_at: now,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** ID でコースセットを取得 */
export async function getWsCourseSet(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readonly');
  const store = tx.objectStore('course_sets');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

/** event_id に属するコースセット一覧を返す */
export async function getCourseSetsForEvent(eventId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readonly');
  const store = tx.objectStore('course_sets');
  const index = store.index('event_id');
  return new Promise((resolve, reject) => {
    const req = index.getAll(eventId);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

/** terrain_id に直属するコースセット一覧を返す（event_id=null） */
export async function getCourseSetsForTerrain(terrainId) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readonly');
  const store = tx.objectStore('course_sets');
  const index = store.index('terrain_id');
  return new Promise((resolve, reject) => {
    const req = index.getAll(terrainId);
    req.onsuccess = () =>
      resolve((req.result ?? []).filter(cs => cs.event_id == null));
    req.onerror   = () => reject(req.error);
  });
}

/** 全コースセットを返す（マイグレーション用） */
export async function getAllWsCourseSets() {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readonly');
  const store = tx.objectStore('course_sets');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

/** コースセットを削除（配下コースは deleteCoursesBySet で別途削除） */
export async function deleteWsCourseSet(id) {
  const db    = await openWorkspaceDb();
  const tx    = db.transaction('course_sets', 'readwrite');
  const store = tx.objectStore('course_sets');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

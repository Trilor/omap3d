/**
 * deleteModal.js — 削除確認モーダル管理
 *
 * テレイン・大会・コースセット・コースの削除確認ダイアログを統括する。
 * 削除完了後の UI 更新（エクスプローラー再描画など）は callbacks 経由で app.js に委譲し、
 * このモジュールはモーダル表示・非表示と DB 操作のみを担う。
 *
 * 使い方: init(map, callbacks) を呼んだ後、各 show* 関数を使う。
 */

import { localMapLayers } from '../../store/localMapStore.js';
import { gpxState } from '../../gpx/gpxState.js';
import {
  getWsTerrains, getWsEvents,
  getCourseSetsForEvent, getCoursesBySet,
  getWsCourseSet, deleteWsTerrain,
} from '../../api/workspace-db.js';
import { deleteEvent, deleteCourseSet, deleteCourseById, flushSave } from '../../core/course.js';
import { updateWorkspaceTerrainSource } from '../../core/terrainSearch.js';

let _map = null;
let _callbacks = {};

/**
 * @param {maplibregl.Map} map
 * @param {{
 *   onTerrainDeleted: (terrainId: string) => void,
 *   onEventDeleted: () => Promise<void>,
 *   onCourseSetDeleted: () => Promise<void>,
 *   onCourseDeleted: (courseId: string) => Promise<void>,
 * }} callbacks
 */
export function init(map, callbacks) {
  _map = map;
  _callbacks = callbacks;
  _initListeners();
}

// ---- モーダル表示/非表示（内部ヘルパー）----

function _hideDeleteModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.style.display = 'none';
}

function _showDeleteModal(modalId, config) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  Object.entries(config).forEach(([key, value]) => {
    if (key === 'data') return;
    const el = document.getElementById(key);
    if (el) el.textContent = value;
  });

  Object.entries(config.data || {}).forEach(([key, value]) => {
    modal.dataset[key] = value;
  });

  modal.style.display = 'flex';
}

// ---- 公開 API ----

export async function showTerrainDeleteModal(terrainId) {
  let terrains = [];
  try { terrains = await getWsTerrains(); } catch { /* ignore */ }
  const terrain = terrains.find(t => t.id === terrainId);
  if (!terrain) return;

  let eventCount = 0;
  let courseCount = 0;
  try {
    const events = await getWsEvents(terrainId);
    eventCount = events.length;
    for (const ev of events) {
      const sets = await getCourseSetsForEvent(ev.id);
      for (const cs of sets) {
        const courses = await getCoursesBySet(cs.id);
        courseCount += courses.length;
      }
    }
  } catch { /* ignore */ }

  _showDeleteModal('terrain-delete-modal', {
    'delete-modal-event-count': eventCount,
    'delete-modal-course-count': courseCount,
    data: { terrainId },
  });
}

export async function showEventDeleteModal(eventId) {
  let eventName = '大会';
  let courseCount = 0;
  try {
    const terrains = await getWsTerrains();
    for (const t of terrains) {
      const events = await getWsEvents(t.id);
      const ev = events.find(e => e.id === eventId);
      if (ev) {
        eventName = ev.name;
        const sets = await getCourseSetsForEvent(ev.id);
        for (const cs of sets) {
          const courses = await getCoursesBySet(cs.id);
          courseCount += courses.length;
        }
        break;
      }
    }
  } catch { /* ignore */ }

  _showDeleteModal('event-delete-modal', {
    'event-delete-modal-name': eventName,
    'event-delete-modal-course-count': courseCount,
    data: { eventId },
  });
}

export async function showCourseSetDeleteModal(courseSetId) {
  let csName = 'コースセット';
  let courseCount = 0;
  try {
    const cs = await getWsCourseSet(courseSetId);
    if (cs) {
      csName = cs.name;
      const courses = await getCoursesBySet(courseSetId);
      courseCount = courses.length;
    }
  } catch { /* ignore */ }

  _showDeleteModal('courseset-delete-modal', {
    'courseset-delete-modal-name': csName,
    'courseset-delete-modal-course-count': courseCount,
    data: { courseSetId },
  });
}

export function showCourseDeleteModal(courseId, courseName = 'コース') {
  _showDeleteModal('course-delete-modal', {
    'course-delete-modal-name': courseName,
    data: { courseId },
  });
}

// ---- イベントリスナー初期化（内部）----

function _initListeners() {
  // 背景クリック・クローズ・キャンセル
  ['terrain-delete-modal', 'event-delete-modal', 'courseset-delete-modal', 'course-delete-modal'].forEach(modalId => {
    document.getElementById(modalId)?.addEventListener('click', (e) => {
      if (e.target.id === modalId) _hideDeleteModal(modalId);
    });
    document.getElementById(modalId + '-close')?.addEventListener('click', () => _hideDeleteModal(modalId));
    document.getElementById(modalId + '-cancel')?.addEventListener('click', () => _hideDeleteModal(modalId));
  });

  // テレイン削除確定
  document.getElementById('terrain-delete-modal-confirm')?.addEventListener('click', async () => {
    const modal = document.getElementById('terrain-delete-modal');
    const terrainId = modal?.dataset.terrainId;
    if (!terrainId) return;

    localMapLayers.filter(m => m.terrainId === terrainId).forEach(m => { m.terrainId = null; });
    if (gpxState.terrainId === terrainId) gpxState.terrainId = null;

    await deleteWsTerrain(terrainId);
    const all = await getWsTerrains();
    updateWorkspaceTerrainSource(_map, all);
    _hideDeleteModal('terrain-delete-modal');
    _callbacks.onTerrainDeleted?.(terrainId);
  });

  // 大会削除確定
  document.getElementById('event-delete-modal-confirm')?.addEventListener('click', async () => {
    const modal = document.getElementById('event-delete-modal');
    const eventId = modal?.dataset.eventId;
    if (!eventId) return;
    await deleteEvent(eventId);
    _hideDeleteModal('event-delete-modal');
    await _callbacks.onEventDeleted?.();
  });

  // コースセット削除確定
  document.getElementById('courseset-delete-modal-confirm')?.addEventListener('click', async () => {
    const modal = document.getElementById('courseset-delete-modal');
    const courseSetId = modal?.dataset.courseSetId;
    if (!courseSetId) return;
    await deleteCourseSet(courseSetId);
    _hideDeleteModal('courseset-delete-modal');
    await _callbacks.onCourseSetDeleted?.();
  });

  // コース削除確定
  document.getElementById('course-delete-modal-confirm')?.addEventListener('click', async () => {
    const modal = document.getElementById('course-delete-modal');
    const courseId = modal?.dataset.courseId;
    if (!courseId) return;
    deleteCourseById(courseId);
    await flushSave();
    _hideDeleteModal('course-delete-modal');
    await _callbacks.onCourseDeleted?.(courseId);
  });
}

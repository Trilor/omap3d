/**
 * treeStore.js — DBから取得済みのデータを TreeItem ツリーに変換するファクトリ
 *
 * app.js の _renderExplorerOnce が非同期データ取得を行った後、
 * buildTreeData() を呼び出してツリーを組み立てる。
 * DOMレンダリングは treeRenderer.js が担当する。
 */

import { TreeItem } from './TreeItem.js';

/**
 * テレインデータ配列から TreeItem ツリーを構築して返す
 *
 * @param {object} opts
 *   terrainData        [{ terrain, maps, gpx, eventsData, standaloneSets }]
 *   uncatMaps          localMapLayers のうち terrainId=null のもの
 *   uncatGpx           gpxState（未分類の場合のみ）または null
 *   uncatEvents        [{ event, courseSets, sheetsWithImages }]（terrain_id=null）
 *   selectedTerrainId  ドリルダウン選択中のテレインID（null = 通常）
 * @returns {TreeItem[]}
 */
export function buildTreeData({ terrainData, uncatMaps, uncatGpx, uncatEvents, selectedTerrainId }) {
  const items = [];

  if (selectedTerrainId) {
    // ── ドリルダウンモード: 選択テレインの内容のみ（テレインフォルダなし）──
    const selected = terrainData.find(d => d.terrain.id === selectedTerrainId);
    if (selected) {
      const { eventsData, standaloneSets, maps, gpx } = selected;
      eventsData.forEach(({ event, courseSets, sheetsWithImages }) =>
        items.push(_mkEventItem(event, courseSets, sheetsWithImages)));
      standaloneSets.forEach(({ courseSet, courses }) =>
        items.push(_mkCourseSetItem(courseSet, courses)));
      maps.forEach(entry => items.push(_mkMapItem(entry)));
      if (gpx) items.push(_mkGpxItem(gpx));
    }
  } else {
    // ── 通常モード: 全テレインをフォルダで包んで表示 ──
    for (const { terrain, maps, gpx, eventsData, standaloneSets } of terrainData) {
      const terrainItem = new TreeItem(terrain.id, 'terrain', terrain.name, { terrain });
      eventsData.forEach(({ event, courseSets, sheetsWithImages }) =>
        terrainItem.addChild(_mkEventItem(event, courseSets, sheetsWithImages)));
      standaloneSets.forEach(({ courseSet, courses }) =>
        terrainItem.addChild(_mkCourseSetItem(courseSet, courses)));
      maps.forEach(entry => terrainItem.addChild(_mkMapItem(entry)));
      if (gpx) terrainItem.addChild(_mkGpxItem(gpx));
      items.push(terrainItem);
    }

    // 未分類フォルダ
    if (uncatMaps.length > 0 || uncatGpx || uncatEvents.length > 0) {
      const ucItem = new TreeItem('uncategorized', 'uncategorized', '未分類', {});
      uncatEvents.forEach(({ event, courseSets, sheetsWithImages }) =>
        ucItem.addChild(_mkEventItem(event, courseSets, sheetsWithImages)));
      uncatMaps.forEach(entry => ucItem.addChild(_mkMapItem(entry)));
      if (uncatGpx) ucItem.addChild(_mkGpxItem(uncatGpx));
      items.push(ucItem);
    }
  }

  return items;
}

// ----------------------------------------------------------------
// 内部ファクトリ
// ----------------------------------------------------------------

function _mkEventItem(event, courseSets, sheetsWithImages) {
  const item = new TreeItem('event-' + event.id, 'event', event.name, { event });
  courseSets.forEach(({ courseSet, courses }) =>
    item.addChild(_mkCourseSetItem(courseSet, courses)));
  sheetsWithImages.forEach(({ sheet, images }) =>
    item.addChild(_mkMapSheetItem(sheet, images)));
  return item;
}

function _mkCourseSetItem(courseSet, courses) {
  const item = new TreeItem('courseSet-' + courseSet.id, 'courseSet', courseSet.name, { courseSet });
  courses.forEach(c =>
    item.addChild(new TreeItem(
      'course-' + c.id,
      'course',
      c.name,
      { course: c, courseSetId: courseSet.id, eventId: courseSet.event_id ?? null }
    ))
  );
  return item;
}

function _mkMapSheetItem(sheet, images) {
  const item = new TreeItem('sheet-' + sheet.id, 'mapSheet', sheet.name, { sheet });
  images.forEach(img => item.addChild(_mkMapItem(img)));
  return item;
}

function _mkMapItem(entry) {
  return new TreeItem('map-' + entry.id, 'map', entry.name, { entry });
}

function _mkGpxItem(gpxState) {
  return new TreeItem('gpx-main', 'gpx', gpxState.fileName ?? 'GPXトラック', { gpxState });
}

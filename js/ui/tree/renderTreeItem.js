/**
 * renderTreeItem.js — Composite パターン再帰的 DOM レンダラー
 *
 * 使い方:
 *   1. initRenderer(ctx) でコンテキストを設定（アプリ起動時に一度だけ）
 *   2. renderItem(treeItem) で TreeItem → HTMLElement を再帰的に生成
 *
 * ctx オブジェクトの必須フィールドは initRenderer() の JSDoc を参照。
 */

/** @type {object|null} */
let _ctx = null;

/**
 * レンダラーコンテキストを設定する（アプリ起動時に一度だけ呼ぶ）
 * @param {object} ctx — アプリの状態・コールバック群
 */
export function initRenderer(ctx) {
  _ctx = ctx;
}

/**
 * TreeItem から DOM 要素を生成して返す（再帰）
 * @param {import('./TreeItem.js').TreeItem} item
 * @returns {HTMLElement}
 */
export function renderItem(item) {
  switch (item.type) {
    case 'terrain':        return _renderTerrain(item);
    case 'uncategorized':  return _renderUncategorized(item);
    case 'event':          return _renderEvent(item);
    case 'courseSet':      return _renderCourseSet(item);
    case 'course':         return _renderCourse(item);
    case 'mapSheet':       return _renderMapSheet(item);
    case 'map':            return _renderMap(item);
    case 'gpx':            return _renderGpx(item);
    default: {
      const el = document.createElement('div');
      el.textContent = `[unknown type: ${item.type}]`;
      return el;
    }
  }
}

// ================================================================
// 型別レンダラー
// ================================================================

function _renderTerrain(item) {
  const { terrain } = item.data;
  const key = terrain.id;
  const collapsed = _ctx.collapsed.get(key) ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-terrain-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.terrainId = terrain.id;
  _ctx.setupFolderDropTarget(folder, terrain.id);

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-terrain-hd';

  const chevron = _mkChevron(14);

  const tfIcon = document.createElement('span');
  tfIcon.className = 'expl-terrain-icon';
  // 山型アイコン（テレイン = 土地・地形）
  tfIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20l4-8 4 8"/><path d="M2 20l6-12 3 6"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-terrain-label';
  lbl.textContent = terrain.name;

  // source バッジ（ローカルテレインのみ）
  if (terrain.source === 'local') {
    const srcBadge = document.createElement('span');
    srcBadge.className = 'expl-terrain-source-badge';
    srcBadge.textContent = 'ローカル';
    lbl.appendChild(srcBadge);
  }

  // 内容バッジ（大会・地図・GPX 件数）
  const evCount  = item.children.filter(c => c.type === 'event').length;
  const mapCount = item.children.filter(c => c.type === 'map').length;
  const hasGpx   = item.children.some(c => c.type === 'gpx');
  if (evCount > 0 || mapCount > 0 || hasGpx) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    const parts = [];
    if (evCount  > 0) parts.push(`大会 ${evCount}`);
    if (mapCount > 0) parts.push(`地図 ${mapCount}`);
    if (hasGpx)       parts.push('GPX');
    badge.textContent = parts.join(' | ');
    lbl.appendChild(badge);
  }

  // ⋮ メニュー
  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-terrain-more';
  moreBtn.title = 'その他';
  moreBtn.innerHTML = _svgMore();
  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, [
      { label: 'この場所へ移動', action: () => {
          if (terrain.center) {
            _ctx.map.easeTo({ center: terrain.center, zoom: Math.max(_ctx.map.getZoom(), 12), duration: _ctx.EASE_DURATION });
          }
        }
      },
      { separator: true },
      { label: 'ワークスペースから削除', danger: true, action: () => _ctx.showTerrainDeleteModal(terrain.id) },
    ]);
  });

  hd.appendChild(chevron);
  hd.appendChild(tfIcon);
  hd.appendChild(lbl);
  hd.appendChild(moreBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-terrain-more')) return;
    const next = !(_ctx.collapsed.get(key) ?? false);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });
  folder.appendChild(hd);

  // ── ボディ ──
  const body = document.createElement('div');
  body.className = 'expl-terrain-body';
  item.children.forEach(child => body.appendChild(renderItem(child)));
  folder.appendChild(body);
  return folder;
}

function _renderUncategorized(item) {
  const key = 'uncategorized';
  const collapsed = _ctx.collapsed.get(key) ?? true;

  const folder = document.createElement('div');
  folder.className = 'expl-terrain-folder expl-uncategorized' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.terrainId = 'null'; // DnD ターゲット識別用
  _ctx.setupFolderDropTarget(folder, null);

  const hd = document.createElement('div');
  hd.className = 'expl-terrain-hd';

  const chevron = _mkChevron(14);

  const ucIcon = document.createElement('span');
  ucIcon.className = 'expl-terrain-icon';
  ucIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-terrain-label expl-uncategorized-label';
  lbl.textContent = '未分類';

  if (item.children.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    badge.textContent = item.children.length + ' 件';
    lbl.appendChild(badge);
  }

  hd.appendChild(chevron);
  hd.appendChild(ucIcon);
  hd.appendChild(lbl);
  hd.addEventListener('click', () => {
    const next = !(_ctx.collapsed.get(key) ?? true);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });
  folder.appendChild(hd);

  const body = document.createElement('div');
  body.className = 'expl-terrain-body';
  item.children.forEach(child => body.appendChild(renderItem(child)));
  folder.appendChild(body);
  return folder;
}

function _renderEvent(item) {
  const { event } = item.data;
  const key = item.id; // 'event-' + event.id
  const collapsed = _ctx.collapsed.get(key) ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-event-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.eventId = event.id;

  // コースセット DnD ドロップターゲット（event フォルダへのドロップ）
  folder.addEventListener('dragover', e => {
    if (!_ctx.dnd.get() || _ctx.dnd.get().type !== 'courseSet') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    folder.classList.add('dnd-over');
  });
  folder.addEventListener('dragleave', e => {
    if (!folder.contains(e.relatedTarget)) folder.classList.remove('dnd-over');
  });
  folder.addEventListener('drop', async e => {
    e.preventDefault();
    folder.classList.remove('dnd-over');
    const dndItem = _ctx.dnd.get();
    if (!dndItem || dndItem.type !== 'courseSet') return;
    const { id } = dndItem;
    _ctx.dnd.clear();
    await _ctx.moveCourseSet(id, { eventId: event.id, terrainId: null });
    await _ctx.renderExplorer();
  });

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-event-hd';

  const chevron = _mkChevron(12);

  const evIcon = document.createElement('span');
  evIcon.className = 'expl-event-icon';
  // トロフィーアイコン（大会）
  evIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4a2 2 0 01-2-2V5h4"/><path d="M18 9h2a2 2 0 002-2V5h-4"/><path d="M6 9a6 6 0 0012 0"/><path d="M12 15v4"/><path d="M8 19h8"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-event-label';
  lbl.textContent = event.name;
  lbl.title = 'F2: 名前を変更　右クリック: メニュー';

  // F2ハンドラー登録
  _ctx.renameHandlers.set(item.id, () => {
    _ctx.startInlineRename(lbl, event.name, async n => {
      await _ctx.renameEvent(event.id, n);
      await _ctx.renderExplorer();
    });
  });

  const eventMoreBtn = document.createElement('button');
  eventMoreBtn.className = 'expl-item-more';
  eventMoreBtn.title = 'オプション';
  eventMoreBtn.innerHTML = _svgMore();

  const menuItems = () => [
    { label: '名前を変更', action: () => _ctx.renameHandlers.get(item.id)?.() },
    { label: 'コースセットを追加', action: async () => {
        _ctx.collapsed.set(key, false);
        folder.classList.remove('is-collapsed');
        await _ctx.createCourseSet(event.id, null, 'コースセット');
        await _ctx.renderExplorer();
        _ctx.openCourseEditor();
      }
    },
    { label: 'この場所へ移動', action: () => _ctx.flyToEventControls(event) },
    { separator: true },
    { label: '大会を削除', danger: true, action: () => _ctx.showEventDeleteModal(event.id) },
  ];

  eventMoreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = eventMoreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, menuItems());
  });

  hd.appendChild(chevron);
  hd.appendChild(evIcon);
  hd.appendChild(lbl);
  hd.appendChild(eventMoreBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-item-more')) return;
    const next = !(_ctx.collapsed.get(key) ?? false);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _ctx.showCtx(e.clientX, e.clientY, menuItems());
  });
  folder.appendChild(hd);

  // ── ボディ ──
  const body = document.createElement('div');
  body.className = 'expl-event-body';
  item.children.forEach(child => body.appendChild(renderItem(child)));
  folder.appendChild(body);
  return folder;
}

function _renderCourseSet(item) {
  const { courseSet } = item.data;
  const key = item.id; // 'courseSet-' + courseSet.id
  const collapsed = _ctx.collapsed.get(key) ?? false;
  const isActive  = _ctx.getActiveCourseSetId() === courseSet.id;

  const folder = document.createElement('div');
  folder.className = 'expl-courseset-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.courseSetId = courseSet.id;

  // DnD 設定（コースセットフォルダ自体をドラッグ可能）
  _ctx.makeDraggable(folder, { type: 'courseSet', id: courseSet.id });

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-courseset-hd';

  const chevron = _mkChevron(12);

  const csIcon = document.createElement('span');
  csIcon.className = 'expl-courseset-icon';
  // Oコントロール二重円アイコン
  csIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>`;

  // ラベル（クリックで展開/折りたたみ + コースセット読み込み）
  const lbl = document.createElement('span');
  lbl.className = 'expl-courseset-label';
  lbl.textContent = courseSet.name;
  lbl.title = 'クリック: 開く/閉じる　F2: 名前を変更　右クリック: メニュー';

  lbl.addEventListener('click', async e => {
    e.stopPropagation();
    const wasCollapsed = _ctx.collapsed.get(key) ?? false;
    _ctx.collapsed.set(key, !wasCollapsed);
    folder.classList.toggle('is-collapsed', !wasCollapsed);
    if (wasCollapsed) {
      if (_ctx.getActiveCourseSetId() !== courseSet.id) {
        await _ctx.loadCourseSet(courseSet.id);
        _ctx.showAllControlsTab();
        _ctx.openCourseEditor();
      } else {
        _ctx.showAllControlsTab();
      }
      _ctx.activeId.set(item.id);
      _ctx.renderExplorer();
    }
  });

  // F2ハンドラー登録
  _ctx.renameHandlers.set(item.id, () =>
    _ctx.startInlineRename(lbl, courseSet.name, async n => {
      await _ctx.renameCourseSet(courseSet.id, n);
      await _ctx.renderExplorer();
    })
  );

  const csMoreBtn = document.createElement('button');
  csMoreBtn.className = 'expl-item-more';
  csMoreBtn.title = 'オプション';
  csMoreBtn.innerHTML = _svgMore();

  const menuItems = () => [
    { label: 'コースを追加', action: async () => {
        if (_ctx.getActiveCourseSetId() !== courseSet.id) await _ctx.loadCourseSet(courseSet.id);
        const newCourseId = _ctx.addCourseToActiveEvent();
        if (newCourseId) _ctx.activeId.set('course-' + newCourseId);
        _ctx.collapsed.set(key, false);
        folder.classList.remove('is-collapsed');
        await _ctx.flushSave();
        await _ctx.renderExplorer();
        _ctx.openCourseEditor();
      }
    },
    { label: '名前を変更', action: () => _ctx.renameHandlers.get(item.id)?.() },
    { separator: true },
    { label: 'コースセットを削除', danger: true, action: () => _ctx.showCourseSetDeleteModal(courseSet.id) },
  ];

  csMoreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = csMoreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, menuItems());
  });

  hd.appendChild(chevron);
  hd.appendChild(csIcon);
  hd.appendChild(lbl);
  hd.appendChild(csMoreBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-item-more, .expl-courseset-label')) return;
    const next = !(_ctx.collapsed.get(key) ?? false);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _ctx.showCtx(e.clientX, e.clientY, menuItems());
  });
  folder.appendChild(hd);

  // ── ボディ（コースアイテム）──
  const body = document.createElement('div');
  body.className = 'expl-courseset-body';

  // アクティブコースセットのみサマリーを取得してアクティブ状態を付与
  const activeSummary = isActive ? _ctx.getCoursesSummary() : [];
  const summaryMap    = new Map(activeSummary.map(s => [s.id, s]));

  item.children.forEach(child => {
    const c = child.data.course;
    // isActive/isEmpty をレンダリング直前に注入
    child.data.isActive = summaryMap.get(c.id)?.isActive ?? false;
    child.data.isEmpty  = summaryMap.get(c.id)?.isEmpty  ?? (c.sequence?.length === 0);
    body.appendChild(renderItem(child));
  });
  folder.appendChild(body);
  return folder;
}

function _renderCourse(item) {
  const { course, courseSetId, isActive, isEmpty } = item.data;
  const row = document.createElement('div');
  row.className = 'expl-item' + (item.id === _ctx.activeId.get() ? ' is-active' : '');

  const icon = document.createElement('span');
  icon.className = 'expl-item-icon expl-course-flag-icon';
  // 三角旗アイコン（赤色）
  icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-item-label';
  lbl.textContent = course.name;

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = _svgMore();

  const openThisCourse = async () => {
    document.querySelectorAll('.expl-item.is-active').forEach(el => el.classList.remove('is-active'));
    row.classList.add('is-active');
    _ctx.activeId.set(item.id);
    if (courseSetId && _ctx.getActiveCourseSetId() !== courseSetId) {
      await _ctx.loadCourseSet(courseSetId);
    }
    _ctx.setActiveCourse(course.id);
    _ctx.renderExplorer();
    _ctx.openCourseEditor();
  };

  const renameThisCourse = () => _ctx.startInlineRename(lbl, course.name, async n => {
    await _ctx.renameCourse(course.id, n);
    await _ctx.renderExplorer();
  });
  _ctx.renameHandlers.set(item.id, renameThisCourse);

  const ctxItems = () => [
    { label: 'コースを編集',  action: openThisCourse },
    { label: '名前を変更',    action: renameThisCourse },
    { separator: true },
    { label: 'JSON エクスポート',               action: () => document.getElementById('course-export-btn')?.click() },
    { label: 'IOF XML エクスポート',             action: () => document.getElementById('course-xml-btn')?.click() },
    { label: 'Purple Pen (.ppen) エクスポート', action: () => document.getElementById('course-ppen-btn')?.click() },
    { separator: true },
    { label: 'コースを削除', danger: true, action: () => _ctx.showCourseDeleteModal(course.id, course.name) },
  ];

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, ctxItems());
  });
  row.addEventListener('click', () => openThisCourse());
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _ctx.showCtx(e.clientX, e.clientY, ctxItems());
  });

  row.appendChild(icon);
  row.appendChild(lbl);
  row.appendChild(moreBtn);
  return row;
}

function _renderMapSheet(item) {
  const { sheet } = item.data;
  const key = item.id; // 'sheet-' + sheet.id
  const collapsed = _ctx.collapsed.get(key) ?? false;

  const folder = document.createElement('div');
  folder.className = 'expl-sheet-folder' + (collapsed ? ' is-collapsed' : '');
  folder.dataset.sheetId = sheet.id;

  // ── ヘッダー ──
  const hd = document.createElement('div');
  hd.className = 'expl-sheet-hd';

  const chevron = _mkChevron(12);
  chevron.addEventListener('click', e => {
    e.stopPropagation();
    const next = !(_ctx.collapsed.get(key) ?? false);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });

  const sheetIcon = document.createElement('span');
  sheetIcon.className = 'expl-sheet-icon';
  sheetIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>`;

  const lbl = document.createElement('span');
  lbl.className = 'expl-sheet-label';
  const scaleStr = sheet.scale      ? ` 1:${sheet.scale.toLocaleString()}` : '';
  const sizeStr  = sheet.paper_size ? ` ${sheet.paper_size}` : '';
  lbl.textContent = sheet.name + sizeStr + scaleStr;
  lbl.title = 'F2: 名前を変更　右クリック: メニュー';

  if (item.children.length > 0) {
    const badge = document.createElement('span');
    badge.className = 'expl-terrain-badge';
    badge.textContent = item.children.length + ' 枚';
    lbl.appendChild(badge);
  }

  // F2ハンドラー登録
  _ctx.renameHandlers.set(item.id, () =>
    _ctx.startInlineRename(lbl, sheet.name, async n => {
      await _ctx.saveWsMapSheet({ ...sheet, name: n });
      await _ctx.renderExplorer();
    })
  );

  const sheetMoreBtn = document.createElement('button');
  sheetMoreBtn.className = 'expl-item-more';
  sheetMoreBtn.title = 'オプション';
  sheetMoreBtn.innerHTML = _svgMore();

  const ctxItems = () => [
    { label: '名前を変更', action: () => _ctx.renameHandlers.get(item.id)?.() },
    { label: 'この枠の場所へ移動', action: () => {
        if (!sheet.coordinates) return;
        const lngs = sheet.coordinates.map(c => c[0]);
        const lats  = sheet.coordinates.map(c => c[1]);
        const panelWidth = document.getElementById('sidebar')?.offsetWidth ?? _ctx.SIDEBAR_DEFAULT_WIDTH;
        _ctx.map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          {
            padding: { top: _ctx.FIT_BOUNDS_PAD, bottom: _ctx.FIT_BOUNDS_PAD,
                       left: panelWidth + _ctx.FIT_BOUNDS_PAD_SIDEBAR, right: _ctx.FIT_BOUNDS_PAD },
            duration: _ctx.EASE_DURATION,
          }
        );
      }
    },
    { separator: true },
    { label: 'コース枠を削除', danger: true, action: async () => {
        if (!confirm(`「${sheet.name}」を削除しますか？\n（紐づく画像の配置は残ります）`)) return;
        // 紐づく map アイテムの mapSheetId をクリア
        item.children.forEach(child => {
          if (child.data.entry) child.data.entry.mapSheetId = null;
        });
        if (_ctx.activeId.get() === item.id) _ctx.activeId.set(null);
        await _ctx.deleteWsMapSheet(sheet.id);
        await _ctx.renderExplorer();
      }
    },
  ];

  sheetMoreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = sheetMoreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, ctxItems());
  });

  hd.appendChild(chevron);
  hd.appendChild(sheetIcon);
  hd.appendChild(lbl);
  hd.appendChild(sheetMoreBtn);
  hd.addEventListener('click', e => {
    if (e.target.closest('.expl-item-more, .expl-section-chevron')) return;
    _ctx.activeId.set(item.id);
    const next = !(_ctx.collapsed.get(key) ?? false);
    _ctx.collapsed.set(key, next);
    folder.classList.toggle('is-collapsed', next);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _ctx.showCtx(e.clientX, e.clientY, ctxItems());
  });
  folder.appendChild(hd);

  // ── ボディ（画像アイテム）──
  const body = document.createElement('div');
  body.className = 'expl-sheet-body';
  item.children.forEach(child => body.appendChild(renderItem(child)));
  folder.appendChild(body);
  return folder;
}

function _renderMap(item) {
  const { entry } = item.data;
  const row = document.createElement('div');
  row.className = 'expl-item' + (item.id === _ctx.activeId.get() ? ' is-active' : '');

  const icon = document.createElement('span');
  icon.className = 'expl-item-icon';
  icon.innerHTML = _svgMapIcon();

  const lbl = document.createElement('span');
  lbl.className = 'expl-item-label';
  lbl.textContent = entry.name;

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = _svgMore();

  const renameMapItem = () => _ctx.startInlineRename(lbl, entry.name, async n => {
    entry.name = n;
    _ctx.renderOtherMapsTree();
    await _ctx.renderExplorer();
  });
  _ctx.renameHandlers.set(item.id, renameMapItem);

  const ctxItems = () => [
    { label: '地図を中心に表示', action: () => {
        if (entry.bbox) {
          const b = entry.bbox;
          _ctx.map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 600 });
        }
      }
    },
    { label: '名前を変更', action: renameMapItem },
    { separator: true },
    { label: '削除', danger: true, action: () => {
        if (confirm(`「${entry.name}」を削除しますか？`)) {
          _ctx.removeLocalMapLayer(entry.id);
          _ctx.renderExplorer();
        }
      }
    },
  ];

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _ctx.showCtx(r.right + 4, r.top, ctxItems());
  });
  row.addEventListener('click', () => {
    _ctx.activeId.set(item.id);
    _ctx.renderExplorer();
    _ctx.openRightPanel(entry.name.replace(/\.kmz$/i, ''), _ctx.buildMapLayerRightPanel(entry));
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _ctx.showCtx(e.clientX, e.clientY, ctxItems());
  });

  row.appendChild(icon);
  row.appendChild(lbl);
  row.appendChild(moreBtn);
  _ctx.makeDraggable(row, { type: 'map', id: String(entry.id) });
  return row;
}

function _renderGpx(item) {
  const { gpxState } = item.data;
  const row = document.createElement('div');
  row.className = 'expl-item' + (item.id === _ctx.activeId.get() ? ' is-active' : '');

  const icon = document.createElement('span');
  icon.className = 'expl-item-icon';
  icon.innerHTML = _svgGpxIcon();

  const lbl = document.createElement('span');
  lbl.className = 'expl-item-label';
  lbl.textContent = gpxState.fileName ?? 'GPXトラック';

  const moreBtn = document.createElement('button');
  moreBtn.className = 'expl-item-more';
  moreBtn.title = 'オプション';
  moreBtn.innerHTML = _svgMore();

  const renameGpx = () => _ctx.startInlineRename(lbl, gpxState.fileName ?? 'GPXトラック', async n => {
    gpxState.fileName = n;
    await _ctx.renderExplorer();
  });
  _ctx.renameHandlers.set(item.id, renameGpx);

  moreBtn.addEventListener('click', e => {
    e.stopPropagation();
    const r = moreBtn.getBoundingClientRect();
    _ctx.showExplorerGpxCtx(r.right + 4, r.top, renameGpx);
  });
  row.addEventListener('click', () => {
    _ctx.activeId.set(item.id);
    _ctx.renderExplorer();
    _ctx.openRightPanel(gpxState.fileName ?? 'GPX', _ctx.buildGpxRightPanel());
  });
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    _ctx.showExplorerGpxCtx(e.clientX, e.clientY, renameGpx);
  });

  row.appendChild(icon);
  row.appendChild(lbl);
  row.appendChild(moreBtn);
  _ctx.makeDraggable(row, { type: 'gpx', id: 'gpx-main' });
  return row;
}

// ================================================================
// DOM ヘルパー
// ================================================================

/** シェブロン（▼）アイコン要素を生成 */
function _mkChevron(size) {
  const el = document.createElement('span');
  el.className = 'expl-section-chevron';
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  return el;
}

/** 三点リーダーアイコン HTML */
function _svgMore() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
}

/** 地図レイヤーアイコン HTML */
function _svgMapIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}

/** GPX トラックアイコン HTML */
function _svgGpxIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`;
}

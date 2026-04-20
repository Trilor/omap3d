/**
 * explorerState.js — エクスプローラーの状態管理
 *
 * Getter/Setter パターンで状態を公開する。DOM・map 参照なし。
 */

// ---- エクスプローラー選択状態 ----
let _activeId = null;
export const getActiveId = () => _activeId;
export const setActiveId = (id) => { _activeId = id; };

// ---- コンテキストメニュー ----
let _ctx = null;
export const getCtx = () => _ctx;
export const setCtx = (el) => { _ctx = el; };

// ---- リネームハンドラーマップ ----
export const renameHandlers = new Map();

// ---- セクション折りたたみ ----
const _collapsed = { course: false };
export const isCollapsed = (key) => !!_collapsed[key];
export const setCollapsed = (key, val) => { _collapsed[key] = val; };

// ---- テレインビューモード ----
let _terrainViewMode = 'grid'; // 'grid' | 'tree'
export const getTerrainViewMode = () => _terrainViewMode;
export const setTerrainViewMode = (mode) => { _terrainViewMode = mode; };

// ---- グリッドで選択中のテレイン ----
let _selectedTerrain = null;
export const getSelectedTerrain = () => _selectedTerrain;
export const setSelectedTerrain = (id) => { _selectedTerrain = id; };

// ---- 次回 renderExplorer でフォーカス展開するテレイン ----
let _focusTerrain = null;
export const getFocusTerrain = () => _focusTerrain;
export const setFocusTerrain = (id) => { _focusTerrain = id; };

// ---- ファイルインプット経由のインポート先テレイン ----
let _pendingImportTerrain = null;
export const getPendingImportTerrain = () => _pendingImportTerrain;
export const setPendingImportTerrain = (id) => { _pendingImportTerrain = id; };

let _pendingGpxTerrain = null;
export const getPendingGpxTerrain = () => _pendingGpxTerrain;
export const setPendingGpxTerrain = (id) => { _pendingGpxTerrain = id; };

// ---- レンダリング多重実行防止フラグ ----
let _rendering = false;
let _renderPending = false;
export const isRendering = () => _rendering;
export const setRendering = (v) => { _rendering = v; };
export const isRenderPending = () => _renderPending;
export const setRenderPending = (v) => { _renderPending = v; };

// ---- DnD 中アイテム ----
let _dndItem = null;
export const getDndItem = () => _dndItem;
export const setDndItem = (item) => { _dndItem = item; };

// ---- 開いている ＋ポップオーバー ----
let _openAddPopover = null;
export const getOpenAddPopover = () => _openAddPopover;
export const setOpenAddPopover = (el) => { _openAddPopover = el; };

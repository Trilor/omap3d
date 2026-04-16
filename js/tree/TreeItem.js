/**
 * Composite パターン — ツリーノードのデータクラス
 *
 * type:
 *   'terrain'       — テレインフォルダ
 *   'uncategorized' — 未分類フォルダ
 *   'event'         — 大会フォルダ
 *   'courseSet'     — コースセットフォルダ
 *   'course'        — コースアイテム
 *   'mapSheet'      — コース枠フォルダ
 *   'map'           — 地図レイヤーアイテム
 *   'gpx'           — GPXトラックアイテム
 */
export class TreeItem {
  /**
   * @param {string}  id    — ツリー内のユニークキー（例: 'event-123', 'map-456'）
   * @param {string}  type  — ノード種別（上記参照）
   * @param {string}  name  — 表示名
   * @param {object}  data  — type 固有の追加データ（terrain/event/course 等の元レコード）
   */
  constructor(id, type, name, data = {}) {
    this.id       = id;
    this.type     = type;
    this.name     = name;
    this.data     = data;
    /** @type {TreeItem[]} */
    this.children = [];
  }

  /** 子ノードを追加してthisを返す（チェーン可能） */
  addChild(item) {
    this.children.push(item);
    return this;
  }

  /**
   * 自身および全子孫を深さ優先で探索し、predicate が true になる最初のノードを返す
   * @param {(item: TreeItem) => boolean} predicate
   * @returns {TreeItem|null}
   */
  find(predicate) {
    if (predicate(this)) return this;
    for (const c of this.children) {
      const r = c.find(predicate);
      if (r) return r;
    }
    return null;
  }

  /**
   * 直接の子に predicate が true になるものがある場合に this を返す（親探索用）
   * @param {(item: TreeItem) => boolean} predicate
   * @returns {TreeItem|null}
   */
  findParent(predicate) {
    for (const c of this.children) {
      if (predicate(c)) return this;
      const r = c.findParent(predicate);
      if (r) return r;
    }
    return null;
  }
}

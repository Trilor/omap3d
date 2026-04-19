/* ================================================================
   customSelect.js — ネイティブ <select> をカスケードメニュー風UIに置き換え
   ブラウザはネイティブ select の open 状態をCSSで変更できないため、
   JS でカスタムドロップダウンを構築して .cascade-* クラスで統一する。

   公開API（sel._csRefresh / sel._csSync）:
     sel._csRefresh()  options が変わった後に呼ぶ（一覧を再構築）
     sel._csSync()     sel.value を直接書き換えた後に手動同期
   ================================================================ */

export function makeCustomSelect(sel) {
  // ---- ラッパー div（レイアウト担当）----
  // 元 select のクラスをラッパーに移す（flex / width 等のレイアウト CSS を継承する）
  const wrap = document.createElement('div');
  wrap.className = (sel.className ? sel.className + ' ' : '') + 'custom-select-wrap';
  if (sel.id) wrap.setAttribute('data-select-id', sel.id);

  // ---- トリガーボタン（外観担当、.cascade-btn でスタイル済み）----
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cascade-btn';
  btn.disabled = sel.disabled;

  // ---- ドロップダウンパネル（body直下に配置して z-index と overflow を回避）----
  const panel = document.createElement('div');
  panel.className = 'cascade-menu custom-select-menu';

  // ---- DOM 置き換え ----
  // select を非表示のまま DOM に保持することで getElementById / .value 等の JS 互換性を維持する
  sel.style.display = 'none';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(sel);
  document.body.appendChild(panel);

  // ---- オプション一覧を構築 ----
  function buildItems() {
    panel.innerHTML = '';
    Array.from(sel.options).forEach(opt => {
      if (opt.style.display === 'none') return; // 非表示オプションはスキップ
      const item = document.createElement('div');
      item.className = 'cascade-item';
      item.dataset.value = opt.value;
      item.textContent = opt.text;
      if (opt.disabled) {
        item.classList.add('disabled');
        item.style.opacity = '0.4';
        item.style.pointerEvents = 'none';
        item.style.cursor = 'default';
      }
      panel.appendChild(item);
    });
  }

  // ---- ボタン表示テキストと選択状態を同期 ----
  function syncDisplay() {
    const opt = sel.options[sel.selectedIndex];
    btn.textContent = opt ? opt.text : '';
    btn.disabled = sel.disabled;
    panel.querySelectorAll('.cascade-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.value === sel.value);
    });
  }

  buildItems();
  syncDisplay();

  // ---- メニュー開閉 ----
  function openPanel() {
    // 他の開いているカスタムセレクトをすべて閉じる
    document.querySelectorAll('.custom-select-menu.open').forEach(m => {
      if (m !== panel) m.classList.remove('open');
    });

    // 開くたびに項目を再構築（option テキストが動的に変わる場合に追従）
    buildItems();
    syncDisplay();

    const r = btn.getBoundingClientRect();

    // 実際の高さを計測するために visibility:hidden のまま一時表示
    panel.style.visibility = 'hidden';
    panel.classList.add('open');
    const panelH = Math.min(panel.scrollHeight, Math.floor(window.innerHeight * 0.5));
    panel.classList.remove('open');
    panel.style.visibility = '';

    // 画面下端に収まらない場合は上方向に展開
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < panelH && r.top > spaceBelow;
    if (openUp) {
      panel.style.top = (r.top - panelH - 2) + 'px';
    } else {
      panel.style.top = (r.bottom + 2) + 'px';
    }
    panel.style.left   = r.left + 'px';
    panel.style.minWidth = r.width + 'px';
    panel.classList.toggle('open-up', openUp);
    panel.classList.add('open');
    panel.classList.remove('left');
    hilEl = null;
    // 選択中の項目が見えるようにスクロール
    const selectedItem = panel.querySelector('.selected');
    if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
  }
  function closePanel() { panel.classList.remove('open', 'open-up'); }

  // CSS :hover に依存せず JS でハイライトを管理
  let hilEl = null;
  panel.addEventListener('mouseover', e => {
    const item = e.target.closest('.cascade-item');
    if (!item || item === hilEl) return;
    if (hilEl) hilEl.classList.remove('highlighted');
    item.classList.add('highlighted');
    hilEl = item;
    panel.classList.remove('left');
  });
  panel.addEventListener('mouseleave', () => {
    if (hilEl) { hilEl.classList.remove('highlighted'); hilEl = null; }
    panel.classList.add('left');
  });

  // btn / panel の mousedown は document に伝播させない
  // （伝播すると document の closePanel が先に発火し、click のトグル判定がずれる）
  btn.addEventListener('mousedown',   e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());
  document.addEventListener('mousedown', closePanel);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (sel.disabled) return;
    panel.classList.contains('open') ? closePanel() : openPanel();
  });
  panel.addEventListener('click', e => {
    const item = e.target.closest('.cascade-item:not(.disabled)');
    if (!item) return;
    sel.value = item.dataset.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    closePanel();
  });

  // ---- programmatic な sel.value 変更を検知して表示を同期 ----
  // （例: document.getElementById('import-paper-size').value = 'A4'）
  const proto = HTMLSelectElement.prototype;
  const origDesc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (origDesc) {
    Object.defineProperty(sel, 'value', {
      get: ()  => origDesc.get.call(sel),
      set: v   => { origDesc.set.call(sel, v); syncDisplay(); },
      configurable: true,
    });
  }
  // change イベント経由の変更にも対応（programmatic な dispatchEvent を含む）
  sel.addEventListener('change', syncDisplay);

  // ---- 公開 API ----
  sel._csRefresh = () => { buildItems(); syncDisplay(); };
  sel._csSync    = syncDisplay;
}

/* すべての <select> 要素をカスタムUIに変換する */
export function initCustomSelects() {
  document.querySelectorAll('select').forEach(makeCustomSelect);
}

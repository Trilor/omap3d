/* ================================================================
   placeSearch.js — 地名検索（国土地理院 地名検索 API）
   ================================================================ */

let _map = null;

export function init(map) {
  _map = map;
}


// 都道府県コード（JIS X 0401）→ 都道府県名
const PREF_NAMES = {
  '01':'北海道','02':'青森県','03':'岩手県','04':'宮城県','05':'秋田県',
  '06':'山形県','07':'福島県','08':'茨城県','09':'栃木県','10':'群馬県',
  '11':'埼玉県','12':'千葉県','13':'東京都','14':'神奈川県','15':'新潟県',
  '16':'富山県','17':'石川県','18':'福井県','19':'山梨県','20':'長野県',
  '21':'岐阜県','22':'静岡県','23':'愛知県','24':'三重県','25':'滋賀県',
  '26':'京都府','27':'大阪府','28':'兵庫県','29':'奈良県','30':'和歌山県',
  '31':'鳥取県','32':'島根県','33':'岡山県','34':'広島県','35':'山口県',
  '36':'徳島県','37':'香川県','38':'愛媛県','39':'高知県','40':'福岡県',
  '41':'佐賀県','42':'長崎県','43':'熊本県','44':'大分県','45':'宮崎県',
  '46':'鹿児島県','47':'沖縄県'
};

// addressCode の上位2桁で都道府県を、title の先頭から市区町村を抽出
function parseResultMeta(item) {
  const prefCode = (item.properties?.addressCode || '').slice(0, 2);
  const pref = PREF_NAMES[prefCode] || '';
  const title = item.properties?.title || '';
  let city = '';
  if (pref && title.startsWith(pref)) {
    const rest = title.slice(pref.length);
    // 番地・丁目などの数字が始まる手前までを市区町村名として取得
    const m = rest.match(/^([^0-9０-９\-－]+)/);
    city = m ? m[1] : rest;
  }
  return { pref, city };
}

let _searchTimer = null; // デバウンス用タイマー
let _searchAbort  = null; // 進行中リクエストのキャンセル用

function updateClearBtn() {
  const hasValue = document.getElementById('unified-search-input').value.length > 0;
  document.getElementById('unified-search-clear').style.display = hasValue ? 'block' : 'none';
}

export function clearSearch() {
  const input = document.getElementById('unified-search-input');
  input.value = '';
  document.getElementById('unified-search-msg').textContent = '';
  document.getElementById('unified-search-results').innerHTML = '';
  updateClearBtn();
  input.focus();
}
// ---- 検索履歴ユーティリティ ----
const _HISTORY_MAX = 10;

function _historyLoad(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
}
function _historySave(key, item) {
  const list = _historyLoad(key).filter(v => v !== item);
  list.unshift(item);
  localStorage.setItem(key, JSON.stringify(list.slice(0, _HISTORY_MAX)));
}
function _historyDelete(key, item) {
  const list = _historyLoad(key).filter(v => v !== item);
  localStorage.setItem(key, JSON.stringify(list));
}

// unified-search 履歴ドロップダウンを表示（入力が空のときのみ）
function _showUnifiedHistory() {
  const results = document.getElementById('unified-search-results');
  const msg     = document.getElementById('unified-search-msg');
  const list    = _historyLoad('sh_unified');
  if (list.length === 0) { results.innerHTML = ''; msg.textContent = ''; return; }
  results.innerHTML = '';
  msg.textContent = '';
  const header = document.createElement('div');
  header.className = 'search-history-header';
  header.textContent = '最近の検索';
  results.appendChild(header);
  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'place-result-item search-history-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'result-source-icon';
    iconEl.textContent = '🕐';
    el.appendChild(iconEl);
    const nameEl = document.createElement('span');
    nameEl.className = 'place-result-name';
    nameEl.textContent = item;
    el.appendChild(nameEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'search-history-del';
    delBtn.setAttribute('aria-label', '履歴から削除');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      _historyDelete('sh_unified', item);
      _showUnifiedHistory();
    });
    el.appendChild(delBtn);
    el.addEventListener('click', () => {
      document.getElementById('unified-search-input').value = item;
      updateClearBtn();
      results.innerHTML = '';
      clearTimeout(_searchTimer);
      searchPlace();
    });
    results.appendChild(el);
  });
}

// catalog-search 履歴ドロップダウンを表示
function _showCatalogHistory() {
  const container = document.getElementById('catalog-search-history');
  if (!container) return;
  const list = _historyLoad('sh_catalog');
  if (list.length === 0) { container.innerHTML = ''; container.style.display = 'none'; return; }
  container.innerHTML = '';
  container.style.display = 'block';
  const header = document.createElement('div');
  header.className = 'search-history-header';
  header.textContent = '最近の検索';
  container.appendChild(header);
  list.forEach(item => {
    const el = document.createElement('div');
    el.className = 'place-result-item search-history-item';
    const iconEl = document.createElement('span');
    iconEl.className = 'result-source-icon';
    iconEl.textContent = '🕐';
    el.appendChild(iconEl);
    const nameEl = document.createElement('span');
    nameEl.className = 'place-result-name';
    nameEl.textContent = item;
    el.appendChild(nameEl);
    const delBtn = document.createElement('button');
    delBtn.className = 'search-history-del';
    delBtn.setAttribute('aria-label', '履歴から削除');
    delBtn.textContent = '×';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      _historyDelete('sh_catalog', item);
      _showCatalogHistory();
    });
    el.appendChild(delBtn);
    el.addEventListener('click', () => {
      const inp = document.getElementById('catalog-search');
      if (inp) { inp.value = item; inp.dispatchEvent(new Event('input')); }
      container.style.display = 'none';
    });
    container.appendChild(el);
  });
}

export function searchPlace() {
  const query   = document.getElementById('unified-search-input').value.trim();
  const msg     = document.getElementById('unified-search-msg');
  const results = document.getElementById('unified-search-results');

  if (!query) {
    results.innerHTML = '';
    msg.textContent   = '';
    return;
  }

  // 前のリクエストをキャンセル
  if (_searchAbort) { _searchAbort.abort(); }
  _searchAbort = new AbortController();

  results.innerHTML = '';
  msg.textContent = '';

  // 地理院API（非同期）で地名検索
  msg.textContent = '地名を検索中…';
  msg.style.color = '#888';

  fetch(
    `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`,
    { signal: _searchAbort.signal }
  )
    .then(r => r.json())
    .then(data => {
      msg.textContent = '';
      if (!data || data.length === 0) {
        msg.textContent = '見つかりませんでした';
        msg.style.color = '#c00';
        return;
      }
      data.forEach(item => {
        if (!item?.geometry?.coordinates || !item?.properties) return;
        const [lng, lat] = item.geometry.coordinates;
        const { pref, city } = parseResultMeta(item);

        const el = document.createElement('div');
        el.className = 'place-result-item';

        const iconEl = document.createElement('span');
        iconEl.className = 'result-source-icon';
        iconEl.textContent = '📍';
        el.appendChild(iconEl);

        const nameEl = document.createElement('span');
        nameEl.className = 'place-result-name';
        nameEl.textContent = item.properties.title;
        el.appendChild(nameEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'place-result-meta';
        const prefEl = document.createElement('span');
        prefEl.textContent = pref;
        metaEl.appendChild(prefEl);
        if (city) {
          const cityEl = document.createElement('span');
          cityEl.textContent = city;
          metaEl.appendChild(cityEl);
        }
        el.appendChild(metaEl);

        el.addEventListener('click', () => {
          _map.flyTo({ center: [lng, lat], zoom: 15, duration: 1500 });
          document.getElementById('unified-search-input').value = item.properties.title;
          _historySave('sh_unified', item.properties.title);
          msg.textContent = '';
          updateClearBtn();
        });
        results.appendChild(el);
      });
    })
    .catch(e => {
      if (e.name === 'AbortError') return; // キャンセルは無視
      msg.textContent = '';
    });
}


export function initListeners() {

// Enter キー
document.getElementById('unified-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(_searchTimer); searchPlace(); }
});

// フォーカス時: 入力が空なら履歴を表示
document.getElementById('unified-search-input').addEventListener('focus', () => {
  const q = document.getElementById('unified-search-input').value.trim();
  if (!q) _showUnifiedHistory();
});

// 入力中のライブ検索（350ms デバウンス）+ クリアボタン表示制御
document.getElementById('unified-search-input').addEventListener('input', () => {
  updateClearBtn();
  clearTimeout(_searchTimer);
  const q = document.getElementById('unified-search-input').value.trim();
  if (!q) {
    _showUnifiedHistory();
    document.getElementById('unified-search-msg').textContent = '';
    return;
  }
  document.getElementById('unified-search-results').innerHTML = '';
  _searchTimer = setTimeout(searchPlace, 350);
});

// フォーカスを外したとき履歴を閉じる（候補クリックは mousedown で先に発火するため delay）
document.getElementById('unified-search-input').addEventListener('blur', () => {
  setTimeout(() => {
    const q = document.getElementById('unified-search-input').value.trim();
    if (!q) {
      document.getElementById('unified-search-results').innerHTML = '';
      document.getElementById('unified-search-msg').textContent = '';
    }
  }, 200);
});

// クリアボタン
document.getElementById('unified-search-clear').addEventListener('click', clearSearch);

}

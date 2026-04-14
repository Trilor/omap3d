/* ================================================================
   main.js — ESモジュール エントリーポイント
   ロード順序:
 1. protocols.js  … pmtiles / gsjdem:// / dem2cs:// プロトコル登録
     2. app.js        … 地図初期化・KMZ・GPX・UI イベント
   ================================================================ */

import './protocols.js';
import './workspace-db.js';
import './terrain-search.js';
import './app.js';

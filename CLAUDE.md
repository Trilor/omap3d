# CLAUDE.md

## Project Overview

**TeleDrop** はオリエンテーリング競技者向けの完全クライアントサイド 3D 地図・ルート振り返りビューアー。
**【最大要件】** すべてのファイル処理はブラウザのメモリ内でのみ実行。サーバーへのファイル送信禁止。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | HTML 構造 |
| `style.css` | CSS 全体 |
| `js/main.js` | エントリーポイント |
| `js/app.js` | アプリ本体（地図・KMZ・GPX・UI） |
| `js/config.js` | 定数・URL |
| `js/protocols.js` | `gsjdem://` / `dem2cs://` プロトコル |
| `js/contours.js` | 等高線・DEM レイヤー管理 |
| `js/isomizer/` | OriLibre スタイル構築 |

## Tech Stack

- **地図**: MapLibre GL JS 4.7.1
- **ベースマップ**: OriLibre（isomizer）
- **3D地形**: Q地図タイル + `gsjdem://` プロトコル（NumPNG→Terrarium）
- **等高線**: mlcontour + Q地図 / DEM5A / DEM1A
- **CS立体図**: `dem2cs://` プロトコル（TensorFlow.js GPU演算）
- **KMZ**: JSZip + DOMParser
- **空間計算**: Turf.js / geomag（WMM磁気偏角）
- **UI**: Vanilla JS（フレームワーク不使用）

## Git ワークフロー

**変更のたびにローカルコミットを行う。プッシュは明示的に指示があるまで絶対に行わない。**

```bash
git add <変更ファイル>
git commit -m "種別: 変更内容の説明"
# push は「プッシュして」と指示されるまで実行しない
```

リポジトリ: `https://github.com/Trilor/teledrop`

## コーディングルール

- コメントは日本語
- UI 表示テキストは日本語
- 動作中の KMZ・GPX・UI の根幹を壊さないこと

## UI コンポーネント — 設計ルール

### モーダル統一デザイン
3つのモーダル（環境設定・地図位置合わせ・印刷）は共通クラスで外観を統一：
- `.modal-wrapper` — border-radius / box-shadow / border
- `.modal-header` — タイトルバー（primary 色）
- `.modal-close-btn` — ×ボタン（円形）
- サイズは各モーダルの ID セレクタで個別定義

### プルダウン（CustomSelect）
ネイティブ `<select>` の open 状態は CSS で変更不可なため、JS でカスタム実装。

- **`makeCustomSelect(sel)`** — `js/app.js` 末尾に定義。`initCustomSelects()` が全 `<select>` に適用
- **`sel._csRefresh()`** — options を動的に変更した後に必ず呼ぶ（例: `updateReadmapBgKmzOptions` の末尾）
- **`sel.value = ...`** — setter を上書き済みのため自動同期される
- カスケードメニュー（2段階）は `.cascade-*` クラス。`.ppi-cascade-*` は後方互換エイリアス

### CSS セレクト統一
- `select {}` グローバルルールで chevron・border・radius を一括定義
- 個別クラスでは `background-color`（**shorthand の `background` は使わない** — chevron が消える）と padding / font-size のみ上書き
- `.cascade-btn` / `.ppi-cascade-btn` は `<button>` なので外観を「共通パネルプルダウン」セクションで個別定義

### z-index 管理
| 要素 | z-index |
|---|---|
| モーダルオーバーレイ | 10000 |
| `.cascade-menu` | 10100 |
| `.cascade-sub` | 10101 |

モーダル内でプルダウンを使う場合、メニューを `document.body` 直下に配置して `position: fixed` で描画すること（`overflow: hidden` の祖先を回避）。

## 過去の教訓

- **等高線・磁北線セレクト**: ズーム変更時にプルダウン表示を書き換えない。内部の `getEffectiveContourInterval()` はタイル計算にのみ使用し、UI は触らない
- **Attribution**: `attrib-inner` への innerHTML 直接注入は不安定（MapLibre が上書きする）。動的出典は `updateRegionalAttribution()` 経由のみ
- **印刷ボタン**: `@watergis/maplibre-gl-export` は削除済み。カスタム `PrintButtonControl` + `open-print-dialog` CustomEvent で実装

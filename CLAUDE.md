# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

OMAP 3D は、オリエンテーリング競技者向けの完全クライアントサイド（ブラウザ完結型）3D地図・ルート振り返りビューアー。KMZ（地図）とGPX（軌跡）を読み込み、高精度な3D地形上にルートを重ねてアニメーションで振り返ることができる。

**【最大要件】** すべてのファイル処理はユーザーのブラウザのメモリ内でのみ実行すること。サーバーへのファイル送信は絶対に行わないアーキテクチャとする。

## Tech Stack

- **地図描画**: MapLibre GL JS 4.7.1（CDN unpkg）
- **ベースマップ**: OriLibre（isomizer：`tjmsy/maplibre-gl-isomizer`）がYAML設定を読み込んでベクタースタイルを動的構築
- **3D地形DEM**: Q地図タイル（`mapdata.qchizu.xyz`）、`gsjdem://` カスタムプロトコルで NumPNG→Terrarium 変換
- **等高線**: mlcontour（`maplibre-contour`）+ Q地図タイル（主）/ 産総研DEM5A（補完）/ 湖水深合成
- **CS立体図**: `csdem://` カスタムプロトコルでDEMタイルからブラウザ内生成（TensorFlow.js GPU演算）。全国1m + 都道府県別0.5m
- **KMZパース**: JSZip（CDN）でZIP解凍 → DOMParser でKML解析 → 座標変換 → MapLibreレイヤー追加
- **GPXパース**: ネイティブ `DOMParser` + `querySelectorAll('trkpt')`（外部ライブラリ不使用）
- **空間計算**: Turf.js（CDN）― 磁北線・方位角計算に使用
- **磁気偏角**: geomag 1.0.0（WMM/NOAA）― 磁北線の動的生成に使用
- **PMTiles**: プロトコル登録済み（将来の自前データ配信に備え）
- **UI**: HTML5 / CSS3 / Vanilla JavaScript（フレームワーク不使用）
- **単一ファイル構成**: `index.html` にすべてインライン（外部JSファイルなし）

## GitHub リポジトリ

URL: `https://github.com/Trilor/omap3d`

## Git ワークフロー

コードの変更や新機能の実装を行う際は、以下のワークフローを遵守すること。

```bash
# 実装完了後
git add index.html
git commit -m "機能の説明"
git push origin main
```

## コーディングルール

- **コメント**: 数学的処理やアニメーションループには処理の意図を日本語で詳細にコメント
- **既存コード保護**: 動作しているKMZ・GPX機能やUIの根幹部分を壊さないこと
- **UI言語**: UI表示テキストは日本語

## Attribution（出典）アーキテクチャ

### 現在の実装

- `map` 初期化に `attributionControl: false` を設定し、デフォルトの出典コントロールを無効化
- `map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '...' }), 'bottom-right')` で固定テキストを表示
- 固定テキスト: `(Q地図 1mDEM | 国土地理院 基盤地図情報・湖水深 | WMM/NOAA) を加工して作成`
- 個別ソース（terrain-dem, contour-source 系, cs-relief）の `attribution` は `''`（空）に設定済み
- ラスターベースマップ（地理院タイル・OSM）は `RASTER_BASEMAPS` の `attr` に著作権を保持
- 都道府県別CS立体図の出典は `REGIONAL_CS_LAYERS` 配列の各要素に `attribution` 文字列として定義し、`updateRegionalAttribution()` が `.maplibregl-ctrl-attrib-inner` に `#regional-cs-attr` span を append して動的表示

### 注意事項

- `attrib-inner` への innerHTML 直接注入は **避けること**。MapLibre が moveend 等のイベントで上書きするため不安定
- `customAttribution` は静的文字列のみ設定可能（後から変更不可）
- 都道府県別CS出典の動的表示は `updateRegionalAttribution()` のみで行い、MapLibre の仕組みに干渉しない

## コード構造（index.html 全3703行）

### 外部ライブラリ読み込み（9–85行）

| ライブラリ | 用途 | 行 |
|---|---|---|
| MapLibre GL JS 4.7.1 | 地図描画 | 16–17 |
| PMTiles 3.2.0 | 将来の自前タイル配信用 | 27 |
| JSZip 3.10.1 | KMZ（ZIP）解凍 | 38 |
| mlcontour + js-yaml | 等高線生成・YAML読み込み | 47–49 |
| Turf.js 6 | 空間演算・方位計算 | 65 |
| geomag 1.0.0 | WMM磁気偏角計算 | 74 |
| TensorFlow.js 4 | CS立体図GPU演算 | 84 |

### CSS（86–761行）

| セクション | 行 |
|---|---|
| 全画面レイアウト | 87–108 |
| UIパネル本体 | 111–226 |
| 表示設定行・チェックボックス・スライダー | 228–434 |
| KMZボタン・地形誇張スライダー | 436–496 |
| ドラッグ＆ドロップ・操作ヒント | 498–532 |
| 等高線・縮尺セレクト | 534–587 |
| GPX再生タイムライン・視点トグル | 610–760 |

### HTML body（764–956行）

| 要素 | 行 |
|---|---|
| 地図コンテナ `#map` | 764–766 |
| UIパネル（OMAP/KMZ・GPX・CS立体図・表示設定） | 767–936 |
| 視点切り替えトグルボタン | 937–938 |
| GPX再生タイムラインパネル | 939–954 |
| ドラッグ＆ドロップオーバーレイ | 955–956 |

### JavaScript — 定数・カスタムプロトコル（960–1541行）

| 機能 | 行 |
|---|---|
| PMTilesプロトコル登録 | 961–970 |
| DEM合成ユーティリティ（Q地図 > DEM5A > 湖水深 > 地域DEM） | 973–1069 |
| `gsjdem://` プロトコル（NumPNG→Terrarium変換） | 1072–1116 |
| `csdem://` プロトコル（CS立体図ブラウザ生成） | 1121–1328 |
| DEM・CS・OriLibre ベースURL定数 | 1335–1353 |
| 地域別CS立体図定義 `REGIONAL_CS_LAYERS`（17都道府県） | 1355–1502 |
| 初期表示パラメータ（位置・ズーム・傾き・方向） | 1504–1517 |
| KMZ/CS不透明度初期値・ラスターベースマップ定義 | 1519–1536 |

### JavaScript — MapLibre 初期化（1543–1639行）

| 機能 | 行 |
|---|---|
| `new maplibregl.Map()`（attributionControl: false） | 1551–1593 |
| 出典表示（AttributionControl + customAttribution） | 1595–1603 |
| NavigationControl（ズーム・コンパス） | 1606–1618 |
| GeolocateControl（現在位置） | 1620–1639 |

### JavaScript — `map.on('load')` 内処理（1642–2215行）

| 機能 | 行 |
|---|---|
| 湖水深等高線 `window.fetch` オーバーライド | 1724–1784 |
| ラスターベースマップソース・レイヤー追加 | 1809–1824 |
| mlcontour DemSource 初期化（Q地図・DEM5A・湖水深） | 1833–1889 |
| OriLibre（isomizer）スタイル構築 + 低ズーム外洋修正 | 1906–1979 |
| 等高線レイヤー処理（isomizer生成・フォールバック） | 1981–2100 |
| CS立体図ソース・レイヤー追加 | 2114–2139 |
| 3D地形（Terrain）有効化 | 2141–2151 |
| 地域別CS立体図ソース・レイヤー追加 | 2153–2184 |
| 磁北線ソース・レイヤー追加 | 2186–2211 |

### JavaScript — KMZ 読み込み・管理（2217–2609行）

| 機能 | 行 |
|---|---|
| KMZレイヤー管理リスト | 2217–2237 |
| KMZ処理メイン（解凍・KML解析・座標変換・地図追加） | 2258–2526 |
| KMZ一覧UI描画（チェックボックス・スライダー・削除） | 2534–2593 |
| KMZレイヤー削除 | 2596–2609 |

### JavaScript — GPX 再生（2612–3035行）

| 機能 | 行 |
|---|---|
| ユーティリティ（時間フォーマット・シークバー・時間表示） | 2612–2641 |
| GPXレイヤー削除 | 2643–2660 |
| GPX処理メイン（XMLパース・GeoJSON生成・レイヤー追加） | 2662–2833 |
| マーカー座標更新・位置補間 | 2835–2909 |
| カメラ更新（1人称／3人称視点） | 2911–2942 |
| アニメーションループ | 2944–2993 |
| 再生／一時停止・視点モード切り替え | 2995–3035 |

### JavaScript — UIイベントハンドラ（3037–3703行）

| 機能 | 行 |
|---|---|
| ファイル選択ボタン（KMZ・GPX） | 3037–3086 |
| ドラッグ＆ドロップ制御 | 3089–3144 |
| スライダーグラデーション更新 | 3151–3160 |
| 磁北線動的生成（WMM偏角計算） | 3162–3302 |
| 都道府県別CS出典の動的表示（`updateRegionalAttribution`） | 3304–3341 |
| CS立体図ラジオボタン制御・透明度スライダー | 3343–3389 |
| 地形誇張チェック＆スライダー | 3392–3433 |
| 等高線チェック＆セレクト（間隔自動調整） | 3435–3546 |
| 磁北線チェック＆セレクト | 3548–3568 |
| ベースマップ切り替え（`switchBasemap`） | 3570–3616 |
| パネル折りたたみ | 3618–3625 |
| 縮尺セレクト（ズーム連動） | 3627–3669 |
| ズームレベルセレクト | 3671–3688 |
| 初期値設定（UI反映） | 3691–3700 |


# OMAP 3D：総合要件定義・設計書

## 1. プロジェクト概要
オリエンテーリング競技者向けの、完全クライアントサイド（ブラウザ完結型）で動作する3D地図・ルート振り返りビューアー。
ユーザーが手元のKMZ（地図）やGPX（軌跡）を読み込ませることで、高精度な3D地形上にルートを重ね、アニメーションで振り返ることができる。

**【最大要件】**
すべてのファイル処理（解釈・描画）はユーザーのブラウザのメモリ内でのみ実行すること。サーバーへのファイルアップロード（HTTPリクエストでの送信）は絶対に行わないアーキテクチャとする。

## 2. 技術スタック（CDN経由・Vanilla JS）

| ライブラリ | 用途 | 備考 |
|---|---|---|
| MapLibre GL JS 4.7.1 | 地図描画・3D地形・レイヤー制御 | unpkg CDN |
| isomizer（OriLibre） | ベースマップのベクタースタイル動的構築 | `tjmsy/maplibre-gl-isomizer` |
| mlcontour | DEMタイルから等高線を動的生成 | `maplibre-contour-adding-Numerical-PNG-Tile` |
| JSZip | KMZファイル（ZIP形式）の解凍 | cdnjs CDN |
| Turf.js | 方位角計算（GPXリプレイのカメラ制御） | unpkg CDN |
| PMTiles | 将来の自前タイル配信に備えてプロトコル登録済み | unpkg CDN |

**GPXパース**: 外部ライブラリ不使用。ネイティブ `DOMParser` + `querySelectorAll('trkpt')` で解析する。
**UIフレームワーク**: 不使用。HTML5 / CSS3 / Vanilla JavaScript のみ。
**単一ファイル構成**: `index.html` にすべてインライン（外部JSファイルなし）。

## 3. データソース

### 3D地形DEM
- **Q地図タイル** `mapdata.qchizu.xyz/03_dem/52_gsi/all_2025/` （国土地理院測量成果）
- タイル形式は GSJ NumPNG 互換のため、`gsjdem://` カスタムプロトコルで Terrarium 形式に変換してから MapLibre に渡す

### 等高線
- **産総研シームレス標高タイル** `tiles.gsj.jp/tiles/elev/land/` （NumPNG形式）
- mlcontour の DemSource を通じて動的に等高線ベクタータイルを生成する

### CS立体図
- **全国（5m DEM由来）**: 地理院タイル `cyberjapandata.gsi.go.jp/xyz/cs/`
- **都道府県別（0.5m DEM由来）**: 下表のタイルを重ね、全国CSより上層に表示する

| 府県 | タイル提供元 |
|---|---|
| 京都府 | forestgeo.info（G空間情報センター） |
| 滋賀県 | forestgeo.info（G空間情報センター） |
| 大阪府 | forestgeo.info（G空間情報センター） |
| 兵庫県 | rinya-hyogo.geospatial.jp |
| 岐阜県 | forestgeo.info（G空間情報センター） |
| 愛媛県 | rinya-ehime.geospatial.jp（TMSスキーム） |

## 4. レイヤースタック（上が前面）

```
KMZ画像レイヤー（動的追加・常に最上層）
  ↑ 都道府県別CS立体図（0.5m）
  ↑ CS立体図 全国（5m）
  ↑ 色別標高図（デフォルト非表示）
  ↑ OriLibreベクタースタイル群（ベースマップ）
```

### CS立体図の描画設定（乗算代替）
白浮きを防ぎコントラストを強調するため以下の値で描画する：
- `raster-opacity: 0.6`
- `raster-contrast: 0.2`
- `raster-brightness-max: 0.8`

## 5. Attribution（出典）アーキテクチャ

MapLibre 標準の Attribution 表示機能を使い、現在表示されているレイヤーの出典のみを右下に動的表示する。

### 原則
1. `map` 初期化時に `customAttribution` を設定しない
2. 各 `map.addSource()` の `attribution` プロパティに HTML リンク形式で出典を記述する
3. レイヤーのON/OFFは必ず `setLayoutProperty(layerId, 'visibility', 'none'/'visible')` で行う
   → `visibility: 'none'` のソースは MapLibre が attribution から自動除外する
   → `setPaintProperty(raster-opacity, 0)` による疑似非表示は使わない

### 初期非表示レイヤーの addLayer パターン
```javascript
map.addLayer({
  id: 'some-layer',
  type: 'raster',
  source: 'some-source',
  layout: { visibility: 'none' },   // 非表示で開始
  paint: { 'raster-opacity': 1.0 }, // opacity は実際の値を設定（0にしない）
});
```

### 都道府県別CS立体図の attribution 形式
```
<a href="https://www.geospatial.jp/ckan/dataset/csmap_XXXX" target="_blank">XX県 CS立体図</a>
（<a href="https://www.geospatial.jp/ckan/pages/terms-and-conditions" target="_blank">公共データ利用規約第1.0版</a>に基づく）
```

## 6. 画面UIとコンポーネント構成

画面は地図全体を背景とし、その上に以下のUI要素（絶対配置）を重ねる。

1. **左パネル（折りたたみ可）**:
   - OMAP / KMZ セクション: 読み込み済みレイヤー一覧（チェック・透明度スライダー・削除ボタン）
   - GPX 軌跡セクション: 読み込みボタン・状態表示・プライバシー注記
   - CS立体図セクション: 全国チェック＋透明度スライダー / 都道府県別サブアコーディオン
   - 表示設定セクション: 等高線ON/OFF・間隔セレクト / 縮尺表示 / 地形誇張スライダー

2. **視点切り替えトグルボタン（GPX読み込み後に表示）**:
   - 「1人称視点（ドローン追従）」と「3人称視点（俯瞰）」を切り替え

3. **タイムライン・コントロールパネル（画面下部、GPX読み込み後に表示）**:
   - 再生 / 一時停止ボタン
   - シークバー（時間ベース）
   - 時間表示（`現在時間(MM:SS) / 総時間(MM:SS)`）
   - 再生速度セレクト（10x / 30x / 60x / 120x）

## 7. GPX 3Dリプレイ機能のロジック

アニメーションは「距離」ではなく、GPXの `<time>` タグに基づく「経過時間（ミリ秒）」をベースとする（立ち止まっていた時間をリアルに再現するため）。

### 座標補間
毎フレーム、`currentTime` がGPX配列のどの区間に位置するかを特定し、区間内の経過割合から現在地座標（Lat/Lng）を線形補間する。
方位角は Turf.js `turf.bearing()` で p0 → p1 の方向を計算する。

### カメラ制御（視点モード別）

| | 1人称（ドローン）視点 | 3人称（俯瞰）視点 |
|---|---|---|
| Zoom | 18.5 | 15.5 |
| Pitch | 72° | 47° |
| Bearing | 進行方向（turf.bearing） | 0（北固定） |
| Center | 補間した現在地に追従 | 補間した現在地に追従 |

## 8. Git ワークフロー

### 作業前のセーフティコミット
```bash
git add .
git commit -m "変更前の状態を保存"
```

### 実装完了後のコミット＆Push
```bash
git add .
git commit -m "〇〇機能の実装"
git push origin main
```

リポジトリ: `https://github.com/Trilor/omap3d`

## 9. コーディング規約

- **コメント**: 数学的処理（時間補間・方位角計算）やアニメーションループには、処理の意図を1行ずつ**日本語**で詳細にコメントすること
- **既存コード保護**: 動作しているKMZ読み込み機能・UIの根幹部分を壊さないこと
- **UI言語**: UI表示テキストは日本語、コード変数名は英語

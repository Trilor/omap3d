# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

OMAP 3D は、オリエンテーリング競技者向けの完全クライアントサイド（ブラウザ完結型）3D地図・ルート振り返りビューアー。KMZ（地図）とGPX（軌跡）を読み込み、高精度な3D地形上にルートを重ねてアニメーションで振り返ることができる。

**【最大要件】** すべてのファイル処理はユーザーのブラウザのメモリ内でのみ実行すること。サーバーへのファイル送信は絶対に行わないアーキテクチャとする。

## Tech Stack

- **地図描画**: MapLibre GL JS 4.7.1（CDN unpkg）
- **ベースマップ**: OriLibre（isomizer：`tjmsy/maplibre-gl-isomizer`）がYAML設定を読み込んでベクタースタイルを動的構築
- **3D地形DEM**: Q地図タイル（`mapdata.qchizu.xyz`）、gsjdem カスタムプロトコルで NumPNG→Terrarium 変換
- **等高線**: mlcontour（`maplibre-contour`）+ 産総研シームレス標高タイル（`tiles.gsj.jp`）
- **CS立体図**: 地理院タイル（全国5m）＋各都道府県0.5mタイル（forestgeo.info / geospatial.jp 等）
- **KMZパース**: JSZip（CDN）でZIP解凍 → DOMParser でKML解析
- **GPXパース**: ネイティブ `DOMParser` + `querySelectorAll('trkpt')`（外部ライブラリ不使用）
- **空間計算**: `Turf.js`（CDN）― 方位角計算に使用
- **PMTiles**: プロトコル登録済み（将来の自前データ配信に備え）
- **UI**: HTML5 / CSS3 / Vanilla JavaScript（フレームワーク不使用）
- **単一ファイル構成**: `index.html` にすべてインライン（外部JSファイルなし）

## GitHub リポジトリ

URL: `https://github.com/Trilor/omap3d`

## Git ワークフロー（絶対ルール）

コードの変更や新機能の実装を行う際は、以下のワークフローを**必ず**遵守すること。

### 1. 作業前のセーフティコミット
```bash
git add .
git commit -m "変更前の状態を保存"
```

### 2. 実装完了後のコミット＆Push
```bash
git add .
git commit -m "〇〇機能の実装"
git push origin main
```

## コーディングルール

- **コメント**: 数学的処理（時間補間・方位角計算）やアニメーションループには、処理の意図を1行ずつ**日本語**で詳細にコメントすること
- **既存コード保護**: 動作しているKMZ読み込み機能・UIの根幹部分を壊さないこと
- **UI言語**: UI表示テキストは日本語、コード変数名・コメントは英語または日本語

## Attribution（出典）アーキテクチャ

MapLibre 標準の Attribution 表示機能を使う。独自のクレジット文字列操作は行わない。

### ルール
1. **`map` 初期化に `customAttribution` を設定しない**
2. **各 `map.addSource()` の設定内に `attribution` プロパティを定義する**（HTMLリンク形式推奨）
3. **レイヤーのON/OFFは必ず `setLayoutProperty(layerId, 'visibility', 'none'/'visible')` で行う**
   - `setPaintProperty(raster-opacity, 0)` による疑似非表示は使わない
   - MapLibre は `visibility: 'none'` のレイヤーのソースを attribution から自動除外する

### 初期非表示レイヤーの addLayer パターン
```javascript
map.addLayer({
  id: 'some-layer',
  type: 'raster',
  source: 'some-source',
  layout: { visibility: 'none' },   // ← 非表示で開始
  paint: { 'raster-opacity': 1.0 }, // ← opacity は実際の値を設定
});
```

### 都道府県別CS立体図の attribution 形式
```javascript
attribution: '<a href="https://www.geospatial.jp/ckan/dataset/csmap_XXXX" target="_blank">XX県 CS立体図</a>（<a href="https://www.geospatial.jp/ckan/pages/terms-and-conditions" target="_blank">公共データ利用規約第1.0版</a>に基づく）'
```

## 設計仕様

詳細は `omap3d.md` を参照。

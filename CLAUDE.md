# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

OMAP 3D は、オリエンテーリング競技者向けの完全クライアントサイド（ブラウザ完結型）3D地図・ルート振り返りビューアー。KMZ（地図）とGPX（軌跡）を読み込み、高精度な3D地形上にルートを重ねてアニメーションで振り返ることができる。

**【最大要件】** すべてのファイル処理はユーザーのブラウザのメモリ内でのみ実行すること。サーバーへのファイル送信は絶対に行わないアーキテクチャとする。

## Tech Stack

- **地図描画**: MapLibre GL JS（CDN）
- **3D地形**: 産総研シームレス標高タイル（Terrain-RGB）
- **GPXパース**: `togeojson`（CDN）
- **空間計算**: `Turf.js`（CDN）
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

## 設計仕様

詳細は `omap3d.md` を参照。

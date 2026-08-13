# データフロー / 取込ガード

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> CLAUDE.md には要点と禁止事項だけを残している。


```
keiba-data-shared-admin（入力）
  │ [ペア揃いガード] racebook + computer の両方が揃ったときだけ発火
  ↓ repository_dispatch (prediction-updated / results-updated)
.github/workflows/import-on-dispatch.yml
.github/workflows/import-results-on-dispatch.yml
  ↓
astro-site/scripts/importPrediction{,Jra}.js
  │ [中身 date 検証ガード] ±1日マージで拾ったファイルも中身 date が
  │ 指定日と一致するもののみ採用
astro-site/scripts/importResults{,Jra}.js
  ↓
astro-site/src/data/archive{,Jra}.json
  ↓ 自動commit/push
Netlify自動ビルド→本番反映
```

### 📊 入力データの構成（前提）

予想ページに表示されるデータは、admin 側の **2 つの入力経路** から成る：

| admin 経路 | 役割 | 取込元パス（keiba-data-shared） |
|---|---|---|
| `/admin/computer-manager` | **予想本体**（コンピ指数 + 印 + 役割振り分け） | `{cat}/predictions/computer/YYYY/MM/YYYY-MM-DD-{CODE}.json` |
| `/admin/race-data-importer` | **補完情報**（騎手・調教師・斤量・性齢・近走など、表示に必須の値） | `{cat}/racebook/YYYY/MM/YYYY-MM-DD-{CODE}.json` |

- **予想の本体は computer-manager**。コンピ指数と印・役割振り分けはこちらから来る
- **race-data-importer は補完**。予想ロジック自体には使わないが、騎手・調教師・斤量・
  性齢・近走など**ページ表示やfeatureScores計算に必須**の値を埋める
- 両方揃って初めて完全な予想ページが描画できる → だから dispatch も「両方揃いガード」

### 🛡️ 二段防御: ペア揃いガード + 中身 date 検証（2026-05-23 集約）

`prediction-updated` dispatch の取込で **前日データが当日 prediction に混入する**
事故（2026-05-24 案件: 36レース中24レースが23日と完全同一）を恒久的に防ぐため、
入力側と取込側に**二段の防御**を入れる。

#### Step 1: 入力側ガード（`keiba-data-shared-admin/netlify/lib/pair-guard.mjs`）
- `racebook` JSON と `computer` JSON の両方が `keiba-data-shared` に揃ったときだけ
  `prediction-updated` dispatch を発火
- race-data-importer / computer-manager のどちらが先でも、**後勝ちで1回**発火
- 詳細は admin 側 CLAUDE.md「🧠 keiba-intelligence連携」参照

#### Step 2: 取込側ガード（`astro-site/scripts/importPredictionJra.js`）
- `fetchRacebookData` 内で **rbData.date が指定日と一致するもののみ採用**
- ±1日マージロジック自体は維持（「ファイル名は前日付だが中身は当日」運用の救済）
- admin ガードをすり抜けた場合の追加防御

#### 触ってはいけないこと
- ±1日マージロジックを削除しない（2026-05-15 案件の救済機能）
- 中身 date 検証ガードを無効化しない（24日案件の追加防御）
- 入力側ガードと取込側ガードは**両方で1セット**。片方だけ無効化しない

#### 検知時のログ
- 入力側: `⏸️ [PairGuard] dispatch保留: ...` （Netlify Functions ログ）
- 取込側: `⏭️ [RACEBOOK-GUARD] ... スキップ（中身 date=... ≠ 指定日 ...）`
  （GitHub Actions ログ）


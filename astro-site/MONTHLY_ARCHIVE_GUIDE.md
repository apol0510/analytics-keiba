# 📅 アーカイブ管理 — 月替わりの手作業は**廃止**（2026-09-02）

## 結論

**月が変わったときにやることは、もう何もありません。** 自動取込がすべて行います。

以前この文書にあった「月初に per-month ファイルを作り、各 index に import を追記する」手順と、
それを行う 2 スクリプト（`create-new-month-archive.js` / `update-archive-imports.js`）は**削除しました**。

## 現在の実態

| 項目 | 現在 |
|---|---|
| 新しい月のデータ | GitHub Actions の自動取込が **combined JSON** に書く（`src/data/archiveResults.json` / `archiveResultsJra.json` / `archiveSanrenpukuResults.json` / `archiveSanrenpukuResultsJra.json`） |
| per-month JSON（`archiveResults_YYYY-MM.json` 等） | **凍結済みの初期化 snapshot**。馬単 2026-04 / 三連複 2026-05 が最後で、以降 1 件も作られていない |
| 月の一覧 | combined の日付 **∪** per-month snapshot の union（`archive/nankan/index.astro`）。snapshot が無い月も combined 側から出るので**欠けない** |
| 馬単アーカイブのトップ | `archive/index.astro` が combined を実行時に読む（per-month は import しない） |
| 三連複の月別・年別 | `archive-sanrenpuku/{2025,2026}/index.astro` と `[year]/[month].astro` が per-month JSON を import |
| 三連複のランディング | `archive-sanrenpuku/index.astro` / `archive-sanrenpuku-jra/index.astro` は **301 → `/archive-sanrenpuku-all/`**（本文なし） |

データフローの正本は [`docs/DATA_FLOW.md`](./docs/DATA_FLOW.md)。

## 確認コマンド

```bash
npm run validate     # per-month JSON の参照漏れ / 不正な import / combined JSON の妥当性
```

`npm run build` の中で走る `validate:archive`（`validate-archive-json.cjs`）とは別物です。

## 📂 データファイルの場所ルール（**これは今も有効**）

1. ✅ **確認・読み込みは必ず `/src/data/`**（例: `src/data/archiveResults_2026-03.json`）
2. ✅ **更新・書き込みも必ず `/src/data/`**
3. ✅ 更新したら `/public/data/` へ同期コピー
   ```bash
   cp src/data/archiveResults_2026-03.json public/data/
   ```
4. ❌ してはいけないこと
   - `/public/data/` を見て「データがない」と判断する
   - `/public/data/` に直接書き込む
   - `/src/data/` を確認せずに新規作成する

**理由**: `/src/data/` がビルド時に読まれる**マスター**、`/public/data/` はブラウザ配信用の**コピー**。

## ⚠️ per-month JSON を消さないこと

凍結されていても、`archive/nankan/**` が `readFileSync` で読み、
`archive-sanrenpuku/{2025,2026}/` と `[year]/[month].astro` が `import` しています。
**`import` されていない ＝ 未使用ではありません。** 消すとその月の実績が欠けます。

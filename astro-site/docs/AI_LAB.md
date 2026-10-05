# AI ラボ（正本）

2026-10-05 MK 確定。当初案の「全頭の期待値」は KAP の契約（オッズを外部へ再配布しない）に当たるため、**AI 勝率** に置き換えた（同日）。開発中の AI（KAP = keiba-ai-predictor）の見立てを、有料会員がマイページから見られる「居場所」。
本当に開発していることが伝わるよう、KAP のダッシュボードと同じく **自動更新・次のレースへの自動追従・発走までのカウントダウン** で動く。

## 1. 見せるもの / 見せないもの

| 見せる | 見せない |
|---|---|
| 中央競馬の各レースの **全頭の AI 勝率ランキング**（KAP の独自能力モデル・人気/オッズを使わない） | 🛑 **オッズ・期待値**（KAP 契約 `docs/stage-a-contract.md`「No external redistribution of odds」。期待値はオッズを逆算できるので同じ扱い） |
| | **金額**（KAP の推奨金額・stake） |
| 発走後: **AK の上位 5 頭**（本命→対抗→単穴→連下最上位→連下・同役割は pt 降順） | **KAP が選んだ馬**（穴馬に偏り、本命を拾わないため確実に外す） |
| 答え合わせ: 1〜3 着／1 着が AK 上位 5 頭か／勝ち馬の AI 勝率順位 | 「実購入なし」「仮想注文」等の訴求（MK の趣旨と異なる） |
| 成績: 結果が出た全レースで「1 着が AK 上位 5 頭」「勝ち馬が AI 勝率上位 5 頭」 | 回収率／市場由来（market-implied）の勝率 |

- 南関は未運用（KAP 側が中央のみ）。
- AK 上位 5 頭は **発走後だけ** 出す（発走前は有料予想＝1 件ずつ取得の価値を守る）。
- 「試験運用中」と明記する。

## 2. データの流れ

```
KAP（MK の PC・launchd）── 開催中は 2 分ごと ──▶ POST /api/ailab/ingest/（x-ailab-secret）
   全頭の p_calibrated（days/<date>/predictions/<race_id>.jsonl・独自能力モデルのみ）
                                              │ sanitizeIngest: 全頭の AI 勝率だけを残す（オッズ・期待値・買い目・金額は捨てる・market-implied は拒否）
                                              │ attachAk: AK の予想（SSR に残る直近日）から上位 5 頭と発走時刻
                                              ▼
                     Redis ak:ailab:v1:jra:day:{date}（180 日）＋ ak:ailab:v1:jra:days（ZSET）
                                              ▼
/ai-lab/（gatePaidPage: Light/Premium/三連複）── 30 秒ごと ──▶ GET /api/ailab/view/（ak_session の署名だけ）
```

- 自動更新の API は **Airtable を呼ばない**（30 秒ごとに会員判定すると Airtable の月間上限を超える）。ページ本体は gatePaidPage で権利を確かめる。
- 画面データは全員共通なので、関数内で 20 秒キャッシュする。
- 結果（着順）は AK の結果アーカイブ（`archiveResultsJra.json`）から読む（`acquiredResults.buildResultIndex`）。
- MK の PC が止まっている間は更新が止まる。画面に「データ HH:MM:SS 更新」を出す。
- 取込の秘密値 `AILAB_INGEST_SECRET` は Netlify（production・Functions）と MK の PC（`~/.analytics-keiba-ops/ailab-ingest-secret`、権限 600）だけに置く。値をログ・commit・docs に出さない。

## 3. 実装

| 目的 | ファイル |
|---|---|
| 判定・整形（純粋） | `src/lib/ailab/aiLab.js` |
| 保存 | `src/lib/ailab/aiLabStore.js` |
| 画面データ | `src/lib/ailab/aiLabServer.js` |
| 取込 API | `src/pages/api/ailab/ingest.js` |
| 自動更新 API | `src/pages/api/ailab/view.js` |
| 画面 | `src/pages/ai-lab/index.astro`（マイページから入口） |
| 送信（KAP 側） | keiba-ai-predictor `scripts/ailab_export.py`（launchd） |
| 検証 | `npm run test:ailab`（`check:safety` に組込済み） |

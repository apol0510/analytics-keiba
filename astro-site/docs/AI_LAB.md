# AI ラボ（正本）

**2026-10-07 MK 確定（仕様変更）**。2026-10-05 版（中央のみ・AI 勝率ランキング・オッズ／期待値を出さない・発走後に AK 上位 5 頭と答え合わせ）を**置き換える**。
開発中の AI（KAP = keiba-ai-predictor）が**全出走馬を評価している途中の様子**を、有料会員がマイページから見られる場所。

基準 UI は KAP の Stage A dashboard（`127.0.0.1:8766/?market=nankan`）。中央（JRA）・南関を**同じ UI・同じ情報設計**で切り替える。
2026-10-05 版の中央 AI ラボの UI・表示は廃止し、この共通 UI へ移行した（「中央は既存仕様維持」「南関だけ新 UI」はしない）。

## 1. 見せるもの / 見せないもの

| 見せる（中央・南関とも同じ） | 見せない |
|---|---|
| market 切替（中央 JRA / 南関）・開催場・レース・前レース / 次レース・**次レースへの自動追従** | 🛑 **買い目・KAP が選んだ馬・推奨馬**（数頭のピックアップは、馬券に絡まなかったときに「外れた」というマイナスの印象になる） |
| **全出走馬**の AI 勝率・**単勝オッズ**・**期待値**（AI 勝率 × 単勝オッズ）・馬名（AK の予想データにあれば）・**AK の印**（期待値の横・上位 5 頭 ◎本命 ○対抗 ▲単穴 △連下最上位 △連下・2026-10-07 MK 追記） | 🛑 金額（stake）・注文・精算・strategy の判断 |
| **発走までのカウントダウン**（JST・発走時刻ちょうどで「発走済み」） | 🛑 的中／不的中を競わせる見せ方・成績の集計 |
| **自動更新**（30 秒）とデータの鮮度（「データ HH:MM:SS 更新」・オッズの観測時刻と基準） | 🛑 特定の馬の強調（行の色付け・並べ替えの初期値も馬番順） |
| 「開発中・試験運用」「研究中の数値で購入をすすめるものではない」 | 市場由来（market-implied＝オッズから作った）勝率 |

- オッズ・期待値は、KAP の dashboard の「全頭の期待値」と**同じ値**（`field_expected_values`）。判断時刻（発走 10 分前）を過ぎたら判断時刻時点、それまでは最新。
- **AK の印（2026-10-07 MK 追記）**: 全頭表示のまま、期待値の横の列に AK の予想の上位 5 頭の印を出す（印の無い馬は空欄・行の強調はしない）。画面の見出しは「印」、凡例は「◎本命 ○対抗 ▲単穴 △連下」（「AK 印」とは書かない・MK 指示）。上位 5 頭は既存の単一源（本命 ＋ `getTop5Challengers`）、記号は公開ページ（`freePublicView`）と同じ。取込時に AK の予想データから添える（`aiLabAk.attachAk`）。KAP から来た印は保存しない。
  公開の無料プレビューは上位 4 頭の印を既に出しているため、新たに見えるのは 5 頭目（連下）の △ だけ。
- AI の評価（勝率）は KAP が判断時刻（発走の約 10 分前）に作る。それまでのレースは「AI の評価は発走の約 10 分前に出ます」と出す（数値を出さない）。

## 2. fail closed（誤った数値を出さない・`aiLab.raceDisplay` / `sanitizeIngest`）

| 状況 | 表示 |
|---|---|
| 評価前・予測なし・市場由来の勝率 | 行を出さない（「評価待ち」） |
| 発走前で、AK のデータ受信が 10 分より古い（KAP / MK の PC が止まっている） | オッズ・期待値を出さない（AI 勝率だけ）＋「データの更新が止まっているため…」 |
| 発走前で、オッズの観測が 10 分より古い | オッズ・期待値を出さない＋「オッズの更新を待っています」 |
| オッズの観測時刻が無い | オッズ・期待値を出さない |
| 馬ごとの値が範囲外（勝率 0〜1・オッズ 1.0 超・期待値 0〜1000）／期待値 ≠ 勝率 × オッズ（±0.005）／オッズ無しの期待値 | その値を `-`（推測で埋めない） |
| 発走後 | 判断時刻時点（固定）の値をそのまま出す（古さで隠さない） |
| race_id・market・日付・発走時刻・馬番の重複など形式の不正 | 取込を 400 で拒否（保存しない） |

## 3. データの流れ

```
KAP（MK の PC・launchd com.keiba.ailab-export・2 分ごと）
  scripts/ailab_export.py（ak_ailab_ingest.v3）: market ごとに collect（全レース・発走時刻）＋ field_expected_values（全頭）
  ──▶ POST /api/ailab/ingest/（x-ailab-secret）
        sanitizeIngest: 保存してよい項目だけ（馬番・AI 勝率・単勝オッズ・期待値・発走時刻・オッズの時点）
        attachNames: AK の予想データ（SSR に残る直近日）から馬名
        ▼
  Redis ak:ailab:v2:{jra|nankan}:day:{date}（180 日・受信時刻つき）＋ ak:ailab:v2:{market}:days（ZSET）
        ▼
/ai-lab/（gatePaidPage: Light/Premium/三連複）── 30 秒ごと ──▶ GET /api/ailab/view/?market=&date=（ak_session の署名だけ）
```

- 自動更新の API は **Airtable を呼ばない**（30 秒ごとに会員判定すると Airtable の月間上限を超える）。ページ本体は gatePaidPage で権利を確かめる。
- 画面データは全員共通なので、関数内で market・日付ごとに 15 秒キャッシュする。
- 日付の既定: 今日（JST）のデータがあれば今日、無ければ直近。最初に開く market: 今日これから発走するレースがある market（早い方）→ 今日のデータがある market → 直近。`?market=` で指定可。
- MK の PC が止まっている間は更新が止まる（画面の「データ HH:MM:SS 更新」と §2 の fail closed）。
- 取込の秘密値は MK の PC（`~/.analytics-keiba-ops/ailab-ingest-secret`、権限 600）にだけ置き、AK 側は **その SHA-256 をコード定数 `INGEST_KEY_SHA256`（`aiLabStore.js`）に置いて照合**する（キーそのものは commit しない）。ローテーションは「PC のファイルを作り直す → 定数を差し替えて deploy」。
- 🛑 **Netlify の env に秘密値を足さない**。Functions の env は AWS Lambda の 4KB 上限ぎりぎりで、2026-10-05 に 1 つ足しただけで全 Function の作成が失敗し、本番 deploy が 2 回止まった。
- 旧キー `ak:ailab:v1:jra:*`（2026-10-05 版）は読まない（TTL で消える）。

## 4. KAP 側の契約

KAP `docs/stage-a-contract.md` の「No external redistribution of odds」に **AK AI Lab export の例外**を追加した（2026-10-07 MK 決定・KAP decisions D-2026-10-07a）。
送るのは単勝のオッズ・期待値・AI 勝率（全頭）だけ。他券種のオッズ・買い目・金額・判断は送らない。log・PR へオッズ値を出さない規則は不変。

## 5. 実装

| 目的 | ファイル |
|---|---|
| 判定・整形・表示の規則（純粋・**ブラウザと共通**） | `src/lib/ailab/aiLab.js` |
| 馬名・AK の印を添える（サーバー専用） | `src/lib/ailab/aiLabAk.js` |
| 保存 | `src/lib/ailab/aiLabStore.js` |
| 画面データ | `src/lib/ailab/aiLabServer.js` |
| 取込 API | `src/pages/api/ailab/ingest.js` |
| 自動更新 API | `src/pages/api/ailab/view.js` |
| 画面（中央・南関で共通の部品） | `src/components/ailab/AiLabBoard.astro`（ページ `src/pages/ai-lab/index.astro`・マイページから入口） |
| 送信（KAP 側） | keiba-ai-predictor `scripts/ailab_export.py`（launchd `com.keiba.ailab-export`） |
| 検証 | `npm run test:ailab`（`check:safety` に組込済み）・KAP `tests/test_ailab_export.py` |

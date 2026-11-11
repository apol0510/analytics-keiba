# 無料予想 → Premium 導線と特別価格（実験記録・2026-11-11 開始）

MK 2026-11-11: 無料ユーザーの満足を保ったまま、Premium の新規購入と月額継続売上を増やす。
**最優先 KPI は実購入数・月額新規契約数・翌月継続率。無料ユーザーの再訪率を維持することも評価基準。**
決定と Claude の判断の区別は `docs/decisions.md` 2026-11-11。

## 1. 問題とデータ（GA4 property 517256438・2026-10-14〜11-10 の 28 日・本番ホストのみ）

| 段 | 値 |
|---|---|
| 全ユーザー | 2,934 |
| `/free/nankan/` | 813 users・7,971 views（1 人 9.8 回・平均 3 分 34 秒）|
| `/free/jra/` | 701 users・6,226 views（1 人 8.9 回・平均 6 分 23 秒）|
| `/free/` | 670 users（平均 32 秒・入口）|
| `/free-prediction/nankan/`・`/jra/` | 184・133 users |
| `/pricing/` | 246 users |
| `card_checkout_click` → `begin_checkout` | 8 → 5 users |
| `purchase`（実購入）| **1 件（¥2,980）** |
| `application_start` → `application_submitted`（銀行振込）| 9 → 1 users |
| `free_live_board_cta_click`（/free-prediction/ の LIVE ボード）| 18 users |

⚠️ GA4 の `purchase` は同期間に 54 件・¥200,920 と出るが、**53 件は 2026-10-22 のローカル E2E**（`transaction_id` が `I-E2E…`・hostname=localhost）。
ローカルからの送信は 10/22 に止めた（BaseLayout）。今回 `begin_checkout` / `purchase` を本番ホスト以外から送らないようにした（Deploy Preview の Sandbox 購入も入らない）。
読むときは hostname=analytics.keiba.link で絞る。

### 見つかった離脱点

| # | 離脱点 | 証拠 |
|---|---|---|
| F1 | 無料予想だけで用が足りる。有料版の案内は「詳細」を開いた中と最下部だけ | 1 人 9〜10 回見るのに `/pricing/` は 1 日あたり無料予想の 1/6 程度。無料予想内の有料案内のクリックは**計測されていなかった** |
| F2 | 有料版で何が手に入るか見えない | プレビューは鍵付きカードの列。料金ページの説明は「高精度AI予想・詳細な投資戦略」 |
| F3 | 文言の食い違い | 料金 FAQ「無料でも AI指数・印・分析」→ 無料に AI 指数は無い |
| F4 | 年額カードが閉じた「銀行振込のプラン」の中 | 料金ページの年額カード払いは既定で閉じた枠の中 |

## 2. 仮説

H1: 各レースの行に Premium の 1 行（→ 見本）と、終了したレースの Premium 画面の見本を置くと、無料予想 → 料金ページの遷移が増える。
H2: 特別価格（初回だけ）と 1 日 1 回の案内で、料金ページ → カード申込 → 購入が増える。
H3: 無料予想の情報量を変えず、案内は 1 日 1 回・小型なので、無料予想の再訪率は下がらない。

## 3. 介入（PR・2026-11-11）

- 無料予想: 各レースの行に「🔒 このレースの買い目は Premium で公開 ›」（→ `/free-prediction/sample/`）。印・詳細はそのまま
- 見本 `/free-prediction/sample/?cat=`: 今日より前の直近の開催日のメインレースの Premium 画面（結果は出さない）
- 特別価格の案内カード: `/free/`・`/free/{jra,nankan}/`・`/free-prediction/{jra,nankan}/` に 1 日 1 回（18 秒後・半分まで読んだ・詳細を 2 つ開いた時点）。端末の 10% は非表示群
- 料金ページ: 1 画面目を中身と無料版との比較へ・特別価格と更新額・年額カードをカード決済の枠へ・閲覧傾向に合うプランを先頭・FAQ 修正
- 決済: Paddle の新規定期課金に初回だけの値引き（更新は通常料金）

## 4. 計測（正本 `astro-site/docs/GA4_CONVERSION_FUNNEL.md` §3-4）

| 段 | イベント |
|---|---|
| 無料予想 → Premium | `free_premium_row_click`・`free_premium_detail_click`（`category`）|
| 見本 | `premium_sample_view`・`premium_sample_cta_click` |
| 案内カード | `campaign_card_impression`・`campaign_card_click`・`campaign_card_other_click`・`campaign_card_dismiss`・`campaign_card_holdout`（`plan`・`campaign_group`）|
| 料金 → 購入 | `/pricing/` page_view → `card_checkout_click`（プラン選択）→ `begin_checkout` → `purchase`（`value` = 実際の初回請求額・`discount`）|
| 比較群 | ユーザー プロパティ `ak_cmp_group`（show / holdout）。GA4 でユーザー スコープのカスタム ディメンションに登録して購入率を群で比べる |
| 継続率・解約率 | GA4 では測らない。Paddle の購読（`custom_data.ak_cmp = special-2026-11`）を `revenueMonthly` と同じ読み取り鍵で月次に数える（初回購入の翌月に `subscription_recurring` の取引が completed になった割合）|
| 再訪率 | GA4 の `/free/{jra,nankan}/` のリピーター（returning users）比率・1 人あたり表示回数。基準は §1 |

閉じる率 = `campaign_card_dismiss` / `campaign_card_impression`。

## 5. 評価

| 項目 | 内容 |
|---|---|
| 主指標 | 実購入数（`purchase`・本番ホスト）と Paddle の新規購読数・翌月継続率 |
| 段の指標 | 無料予想 users → 行・詳細・案内カードのクリック → `/pricing/` users → `card_checkout_click` → `begin_checkout` → `purchase` |
| 比較 | `ak_cmp_group` show と holdout の購入率（holdout は 10% なので件数が少ないうちは参考） |
| 期間 | 本番反映から 28 日（中間 14 日）。翌月継続率は初回購入の 1 か月後から |
| 判断 | 件数が少ない（基準 28 日で実購入 1 件）ため、14 日の短期ノイズで仕様を変えない |
| 悪化時 | 無料予想の再訪率（returning users 比率・1 人あたり表示回数）が基準から明確に下がり、購入も増えない場合は案内カードを止める（`SUBSCRIPTION_CAMPAIGN.open=false` で特別価格ごと閉じる、またはカード部品だけ外す PR）|

## 6. rollback

- 特別価格: `subscriptionCampaign.js` の `open: false` の PR（表示・案内カード・値引きが同時に消える。既に値引きで始まった購読は更新から通常料金なので影響なし）
- 導線・見本・料金ページ: PR の revert（決済サーバー・会員データは変更なし）

## 7. 結果（評価時に追記）

| 日付 | 期間 | 値 | 判断 |
|---|---|---|---|
| | | | |

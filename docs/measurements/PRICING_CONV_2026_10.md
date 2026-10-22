# 料金ページ → 申込開始の転換（実験記録・2026-10-22 開始）

MK 2026-10-22: AK の**新規購入**を増やす。最初の対象は「料金ページ → 申込開始」。

## 1. 問題とデータ（GA4 property 517256438・2026-09-23〜10-20 の 28 日）

| 指標 | 値 |
|---|---|
| 全ユーザー | 2,917 |
| `/pricing/` | 600 views / 233 active users（平均エンゲージメント 1分41秒） |
| `application_start` | 25 events / 12 users |
| `application_submitted` | 3 events / 3 users（＝今月の銀行振込 3 件 ¥87,960） |
| `begin_checkout` | 1（カード決済の計測は 2026-10-21 #822 から） |
| `purchase` | 1（¥4,980） |
| `sign_up` | 6 users／`/free-signup/` 115 users |
| 流入 | セッションの 69% が Direct |

### 「5%（12 / 233）」の正しい読み方（コードで確認）

- `application_start` は**銀行振込モーダルが開いた**とき（`openBankModal` を `funnel-analytics.js` が包む）。
  料金ページ以外でも出る: `/dashboard/`（年払い・買い切り・三連複）、`/premium-prediction/nankan/`、`/premium-upgrade/`、
  `/light-predictions/`、`/sanrenpuku-demo/`、`/archive-sanrenpuku-all/`、`/withdrawal-upsell/`、`/spring-campaign/`、`/premium-plus-v2/` 等。
- 一方、分母の 233 は `/pricing/` だけ。**分子は全ページ・分母は料金ページ**なので、料金ページ単独の率は 5% **以下**。
  ページ別の内訳は GA4 で「ページパス × イベント名」（`page_location` は自動付与）で分けられる。
  ※ 今回のセッションのブラウザは GA4 property を閲覧できず、内訳は未取得（§6）。
- 同じ人がモーダルを開き直すと再度出る（25 events / 12 users）。Light 会員の更新・既存会員の申込も含む。
- `application_submitted` は**振込を済ませた後の報告フォーム**の受理。モーダルの手順は「①振込 → ②報告フォーム」なので、
  12 → 3 には「その場で振り込めない（後日の振込・別端末）」が含まれる。購入完了ではない（入金確認は Airtable）。
- **カード決済は `application_start` に入らない。** 料金ページの「クレジットカードで申し込む」（月額 3 本・年払い）は
  別経路（`monthly-create-checkout` → PayPal）。この経路で見えていたのは `begin_checkout`（10/21〜）と `purchase` だけ。

## 2. 見つかった離脱点（証拠）

本番 `/pricing/` を read-only で実測（Playwright・390×844 と 1280×800・申込・決済・フォーム送信はしていない）。

| # | 離脱点 | 証拠 |
|---|---|---|
| D1 | **カードで払いたい人が、カード決済の枠に気付けない** | 見出しは「Premium（中央＋南関）は、年払い・買い切りの**銀行振込**でお申し込みいただけます」だけ。クレジット決済の枠は**無料プランのカードの下**（スマホで y=2,589px＝3 画面下、PC で y=1,823px）。「無料会員登録」で一覧が終わったように見える位置 |
| D2 | **2026-10-15〜10-21、未ログインのカード申込はログインへ飛ばされていた** | 無料会員はセッションを持たず、ログイン → 料金ページの往復で申し込めなかった（#820 で修正・10/21 本番）。28 日の基準期間の大半で、新規の方のカード経路は実質閉じていた → `begin_checkout` 1 |
| D3 | FAQ が古い | 「①ログイン（無料会員登録）→ ②…」（#820 以降ログイン不要）。支払い方法の FAQ に年払いのカード（10/20〜）が無い |
| D4 | カード経路の途中が計測されていない | 押した → メール入力 → 断られた／通信失敗、のどこで止まったか GA4 に何も出ない（本番でボタンを押しメール入力画面まで進めても、イベント 0 件を確認）|
| D5 | 銀行振込は「振込後の報告フォーム」 | モーダルを開いた人のうち、その場で振り込めない人はページを離れる（後で同じページに戻って再度開く必要がある）。12 → 3 の主因と推定。今回は変えない（§7） |
| D6 | 未ログインのカード購入者は、PayPal から戻ると「ログインしてご確認ください」 | `paypal-subscription-confirm` がセッション必須（401）。**購入は Webhook で反映される**が、戻り画面に完了が出ず、GA4 `purchase` も送られない（未ログイン購入は `purchase` に数えられない）。決済サーバーの変更になるため今回は変えない（§7）|
| — | 最初の購入ボタン | スマホで y=888〜929px（844px の 1 画面目の直下）。致命的ではない |

## 3. 仮説

H1: カード決済の枠への入口を料金ページ上部に 1 本置き（D1）、FAQ を事実に揃える（D3）と、
料金ページ訪問者のうちカード申込を始める人（`card_checkout_click`）が増え、`begin_checkout` → `purchase` が増える。
D2 の修正（#820・10/21）と合わせて、新規の方がカードで買える状態が初めて料金ページから見える。

## 4. 介入（本 PR）

- `/pricing/` 見出しの下に「クレジットカードでのお申し込みはこちら ↓」（`#credit-payment` へ移動）を 1 本だけ。
  主役（年払い・買い切り）の順序・見出し・価格・商品・権利は**変えない**。「月額」「自動更新」「PayPal」は前面に出さない（2026-10-15 MK 指示）。
  カード受付が閉じているとき・Premium 契約中の方には出さない。
- FAQ: 「利用開始までの流れ」をログイン不要の実際の手順に、「支払い方法」に年払いのカード（自動更新）を追記。
- 計測（`funnel-analytics.js` の 1 か所・閉じた語彙・PII なし）:
  `pricing_card_link_click` / `card_checkout_click` / `card_checkout_email_form` / `card_checkout_blocked` / `card_checkout_error`。
  仕様は `astro-site/docs/GA4_CONVERSION_FUNNEL.md`。

## 5. 評価

| 項目 | 内容 |
|---|---|
| 主指標 | 新規購入数＝`purchase`（カード）＋ 新規の `application_submitted`（銀行振込）と、売上 measurement（`docs/measurements/revenue-*.json`） |
| 段の指標 | `/pricing/` active users → `pricing_card_link_click` → `card_checkout_click` → `card_checkout_email_form` → `begin_checkout` → `purchase`。銀行振込は `/pricing/` 上の `application_start` → `application_submitted` |
| 基準値 | §1（28 日）。カード段は基準なし（新設）→ 最初の 14 日を基準として扱う |
| 期間 | merge・本番反映から 28 日（中間 14 日）。同時期に #820（未ログインのカード申込の修正）が効くため、`begin_checkout`／`purchase` の増加は**両者の合算**として読む。リンク単独の効果は `pricing_card_link_click` → `card_checkout_click` の比で見る |
| 判断 | 件数が少ない（基準 28 日で購入 4 件）ため、14 日の短期ノイズで仕様を変えない。`card_checkout_email_form` → `begin_checkout` が低ければ次はメール入力段、`begin_checkout` → `purchase` が低ければ PayPal 承認段（D6）を次の仮説にする |
| 悪化時 | 銀行振込の `application_start`（料金ページ）が大きく減り、カード購入も増えない場合は revert |

## 6. 未取得・前提

- GA4 のページ別内訳（`application_start` のうち `/pricing/` 上の数）は、このセッションのブラウザに閲覧権限が無く未取得。
  評価時に GA4 探索で「ページパス × イベント名」を取る。
- 新イベントはキーイベントにしない（`purchase` / `application_submitted` が転換）。

## 7. 今回やらないこと（次の候補）

- D5 銀行振込: 「振込先を控えてあとで振り込む」導線（口座情報のメール送付など）。販売手続きの変更なので MK 判断。
- D6 未ログイン購入者の戻り画面: 購読 ID だけで完了表示・`purchase` を出せるよう `paypal-subscription-confirm` を変える案。決済サーバーの変更なので別 PR。

## 8. rollback

本 PR の revert（ページ・計測スクリプトだけ。サーバー・決済・顧客データは変更なし）。

## 9. 結果（評価時に追記）

| 日付 | 期間 | 値 | 判断 |
|---|---|---|---|
| | | | |

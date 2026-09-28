# GA4 有料化ファネル計測 — 正本

> 2026-09-18 MK 確定。既存 GA4（測定 ID は `src/layouts/BaseLayout.astro` が唯一持つ）を使い、
> **どの段階で離脱し、どこから有料転換につながっているか**を GA4 上で運用確認できるようにする。
> アクセス数を見ることが目的ではない。

## 1. 追う導線

```
流入（検索・メール・直接）
  → /free/（無料予想本体）
  → /free-signup/（無料登録）→ 無料会員として継続利用・DRM
  → /free-prediction/（有料版プレビュー）・/results-showcase/（有料実績ショーケース）
  → /pricing/
  → 申込開始（振込モーダルを開く）
  → 申込成功（サーバーが申込を受理）
```

> 2026-09-27 訂正: `/free/` と `/free-prediction/` は役割が違うので**別の段**。
> ページの役割は `docs/spec.md` 冒頭「無料導線のページ役割と現在のファネル」が正本。

## 2. 各段を何で見るか

| 段 | 見るもの | 種別 |
|---|---|---|
| 流入 | `session_start` / 参照元は GA4 が自動で持つ | 既存 |
| 無料予想 到達（`/free/`＝無料予想本体・無料獲得の主入口）| `page_view` — Page path が `^/free/` | 既存 |
| 無料登録ページ 到達 | `page_view` — Page path が `^/free-signup/`（`page_referrer` で `/free/` 由来を絞れる）| 既存 |
| 有料版プレビュー 到達（`/free-prediction/`）| `page_view` — Page path が `^/free-prediction(/\|-)` | 既存 |
| results-showcase 到達 | `page_view` — Page path が `/results-showcase/` で始まる | 既存 |
| pricing 到達 | `page_view` — Page path が `/pricing/` で始まる | 既存 |
| **申込開始** | **`application_start`** | **追加** |
| **申込成功** | **`application_submitted`** | **追加** |

### なぜ前半 3 段にイベントを足さないか

URL で確実に判別できるからである。イベントを増やすと同じ事実が 2 通りの数え方を持ち、
どちらが正かで必ず揉める。**URL で分かる段は page_view だけで数える。**

申込はモーダルの中で起きて **URL が変わらない**。page_view では
「申込を始めた」と「申込が通った」を区別できないので、ここだけイベントで固定する。

### 無料予想の正規表現に `/free-signup/` を入れないこと

`^/free` で雑に拾うと **無料登録ページ `/free-signup/`** と**有料版プレビュー `/free-prediction/`** が
無料予想に混ざる。無料予想の段は `^/free/`（末尾スラッシュ必須）だけを拾う。

### `/free/` と `/free-prediction/` を同じ段にしない（2026-09-27 MK 確定）

役割が違う（正本: `docs/spec.md` 冒頭「無料導線のページ役割と現在のファネル」）。

| 段 | ページ | 見る目的 |
|---|---|---|
| 無料予想 | `/free/` | 無料獲得ファネル: 流入 → `/free/` → `/free-signup/` → 登録完了 |
| 有料版プレビュー | `/free-prediction/` | 有料転換ファネル: 有料版の価値確認 → `/pricing/` → 申込 |

`/free-prediction/` → `/free-signup/` は主要ファネルとして扱わない。
（2026-09-18 版はこの 2 つを 1 段に数えていた。GA4 の探索は未作成なので、作るときはこの段で組む。）

## 3. イベント仕様

| | `application_start` | `application_submitted` |
|---|---|---|
| 意味 | 振込申込モーダルが開いた | **サーバーが申込を受理した** |
| 発火点 | `openBankModal()` の呼び出し後 | 申込 API の成功分岐（成功画面の表示 / `result.success`）|
| パラメータ | `plan`, `plan_type` | `plan`, `plan_type` |

### `plan`（閉じた語彙。これ以外は出ない）

`Premium Plus` / `Premium Sanrenpuku` / `Premium` / `Light` / `other`

Airtable の `RequestedPlan` と同じ語彙に揃えてある（`derivePlanFromProductName` と
突き合わせるテストがある）。GA4 の申込数と Airtable の申込レコードを突き合わせられる。

### `plan_type`

`Monthly` / `Annual` / `Lifetime`

## 4. やってはいけないこと

1. **ボタンのクリックを「申込成功」にしない。**
   `application_submitted` はサーバーが受理を返した後からしか出ない。
2. **`application_submitted` を「入金確認」と読まない。**
   入金確認（課金の確定）は Airtable の手作業で、ブラウザには届かない。
   このイベントは**申込フォームの受理**まで。GA4 の `purchase` を使わないのはこのため
   （`purchase` は売上確定を意味してしまう）。
3. **個人情報を送らない。** 送るのは上の閉じた語彙だけ。氏名・メール・会員 ID・
   金額・振込日・レコード ID は渡さない。商品名に個人情報が紛れても `other` に落ちる。
4. **ページごとに `gtag(...)` を書かない。** 申込導線は 13 ページにコピペで散在しており、
   ページへ書くと必ず直し漏れる（過去に 16 ページ中 15 ページが直し漏れた事故がある）。

## 5. 実装（単一源）

| 目的 | ファイル |
|---|---|
| **計測本体（GA4 へ送るのはここだけ）** | `astro-site/public/js/funnel-analytics.js` |
| 全ページへの読み込み | `astro-site/src/layouts/BaseLayout.astro` |
| 振る舞いテスト | `astro-site/src/lib/analytics/funnelAnalytics.test.mjs` |
| 配線の退行検知 | `astro-site/src/lib/analytics/funnelWiring.guard.test.mjs` |
| 実行 | `npm run test:analytics`（`check:safety` / CI に組込済み）|

### どうやってページを触らずに拾っているか

`campaign-price.js` と同じやり方で、**既存の関数を包む**。

| 段 | 包む対象 | 効く範囲 |
|---|---|---|
| 申込開始 | global の `openBankModal` | 13 ページすべて |
| 申込成功 | `SubmissionResult.showSuccessScreen`（`history.type === 'bank-transfer'` のときだけ）| 12 ページ |

`dashboard.astro` だけは共通の成功画面を使っていないので、**そこにだけ 1 行**置いてある。

`openBankModal` は `onclick="openBankModal(...)"` から呼ばれている。インライン `onclick` は
**global しか見ない**ので、この呼び方が残る限り包み込みは必ず効く。
逆に `is:inline` を外して ES module にすると global でなくなり、**onclick ごと壊れる**。
guard テストがこれを検知する。

### 二重計測への備え

- 同じイベント・同じ `plan` が **2 秒以内**に続いたら 2 通目を捨てる
  （ハンドラ二重登録などの事故の重複を潰す）。
- 時間をおいた再訪（同じ人がもう一度モーダルを開く）は**捨てない**。本物の行動である。
- 包み込みは 1 回しか掛からない（`__akFunnelModalWrapped` / `__akFunnelSuccessWrapped`）。
- リロード・戻る操作では成功分岐を通らないので、申込成功は再送されない。
- GA4 の探索でファネルを見るときは**ユーザー単位**で数えるため、
  同一ユーザーの複数回の `application_start` は 1 段として数えられる。

## 6. GA4 管理画面側の作業（コードではできない）

以下は Google 側の設定で、コードからは行えない。**未実施でもイベントは届く。**

### GA4 側の現状（2026-09-27 実測・MK 承認のうえ A+B+C を実施）

プロパティ: `analytics-keiba`（Google アカウント内のアカウント「Work Space Project」/ property 517256438）。
データストリーム `analytics-keiba`（`https://analytics.keiba.link/`）の測定 ID は **`G-BTDCZE1B13`** で、
`BaseLayout.astro` と一致する。

| # | 設定 | 状態 |
|---|---|---|
| 1 | カスタム ディメンション `plan`（範囲: イベント / パラメータ `plan`）| ✅ 設定済み（2026-09-18 作成）|
| 2 | カスタム ディメンション `plan_type`（同上）| ✅ 設定済み（2026-09-18 作成）|
| 3 | `application_submitted` を**キーイベント**に指定（A）| ✅ 2026-09-27 実施。**指定した日以降のデータにだけ効く**（過去は遡らない）|
| — | `application_start` | キーイベントに**しない**（開いただけで転換とは言えない）。実施後も非キーイベントを確認 |
| — | `purchase`（GA4 既定のキーイベント・データなし）/ `cta_click`（Premium Plus の既存計測）| **触らない**。実施後も変化なしを確認 |
| 4 | 無料獲得ファネル探索（B）| ✅ 「**AK 無料獲得ファネル 2026-09-27**」を新規作成 |
| 5 | 有料転換ファネル探索（C）| ✅ 「**AK 有料転換ファネル 2026-09-27**」を新規作成 |

#### B: AK 無料獲得ファネル 2026-09-27

| 段 | 条件 |
|---|---|
| 1 流入 | `session_start` |
| 2 無料予想（/free/）| `page_view` かつ `page_location` が正規表現 `^https://analytics\.keiba\.link/free/.*` に一致 |
| 3 無料登録ページ（/free-signup/）| `page_view` かつ `page_location` が正規表現 `^https://analytics\.keiba\.link/free-signup/.*` に一致 |

**登録完了イベントは未実装**のため、このファネルは `/free-signup/` 到達までを計測する（イベントは足さない）。
直近 28 日（2026-08-30〜09-26）: 3,387 → 1,235 → 137 ユーザー。

#### C: AK 有料転換ファネル 2026-09-27

| 段 | 条件 |
|---|---|
| 1 有料版プレビュー・実績 | `page_view` かつ `page_location` が正規表現 `^https://analytics\.keiba\.link/(free-prediction(/|-)|results-showcase/).*` に一致（`/free/` は含めない）|
| 2 料金ページ | `page_view` かつ `page_location` が正規表現 `^https://analytics\.keiba\.link/pricing/.*` に一致 |
| 3 申込開始 | `application_start` |
| 4 申込成功 | `application_submitted` |

直近 28 日: 762 → 180 → 6 → 0 ユーザー。

#### ⚠️ 探索の「正規表現に一致」は**完全一致**（`.*` を付ける）

GA4 の探索でイベント パラメータに使う「次の正規表現に一致」は**値全体が一致したときだけ**数える
（部分一致の選択肢は無い）。`^https://…/free/` のように書くと、`/free/jra/` やクエリ付きの URL が落ちる。
実測: C の段 1 は `.*` 無しで 52、`.*` 付きで 767 ユーザー。B も作成直後は `.*` 無しで 675 だったのを
`.*` 付きに直して 1,235 になった。**新しく条件を書くときは末尾に `.*` を付ける。**

#### 旧探索「AK 有料化ファネル」（2026-09-18 作成）— 履歴として保持・今後開かない

- 旧定義（6 段: 流入 → 無料予想到達 → 実績ショーケース → 料金ページ → 申込開始 → 申込成功）の**履歴として保持**する。
  変更・削除・再確認はしない。**read-only の確認目的でも開かない**（開くだけで更新日時が変わるため）。
- 2 段目「無料予想到達」の条件は `^https://analytics\.keiba\.link/(free(-prediction)?/|free-prediction-)`（`.*` 無し）で、
  **`/free/` と `/free-prediction/` を同じ段に数えていた**うえ、上の完全一致のため `/free/jra/` 等を数えていなかった可能性がある。
  現在の正本の段とは違うので、分析には B・C を使う。
- 最後の定義確認は 2026-09-27 の read-only 確認（ステップ編集画面を開き「キャンセル」で閉じた直後に 6 段が元のまま）。
- その閲覧で**更新日時が 2026/09/18 → 2026-09-27 16:57 に変わった**。探索を開いた操作に伴うメタ情報の更新の可能性があるが、
  **定義変更が起きたとは確認できていない**（再確認のために開くとまた日時が変わるため、確認しない）。

### ✅ 完了済み — GA4 と Search Console のリンク（2026-09-18 / MK が手動設定）

| 項目 | 値 |
|---|---|
| GA4 property | `analytics-keiba` |
| web stream | `analytics-keiba` |
| stream URL | `https://analytics.keiba.link/` |
| Search Console プロパティ | `https://analytics.keiba.link/` |
| 確認 | GA4 画面で「リンク作成済み」を確認済み |

これにより、検索クエリ別の到着後行動を GA4 側で見られる。**再設定は不要。**

## 7. 反映後の確認手順（**未完了**。本番反映後に行う）

1. GA4 → 管理 → **DebugView** を開く。
2. ブラウザで本番の `/pricing/` を開き、プランのボタンを押してモーダルを出す
   → `application_start`（`plan` / `plan_type` 付き）が出る。
3. **申込は送信しない**（実データが Airtable に入る）。`application_submitted` の確認は
   実際の申込が 1 件入った後に、GA4 のリアルタイム / イベントレポートで見る。
4. 前半 3 段は `page_view` の Page path で見る（イベントは増えていない）。

## 8. rollback

`BaseLayout.astro` の `<script src="/js/funnel-analytics.js" is:inline></script>` 1 行を外せば
計測は完全に止まる（申込導線は 1 行も変えていないので影響しない）。
`dashboard.astro` の 1 行は `window.AkFunnel &&` で守ってあり、スクリプトが無ければ何もしない。

## 9. 将来課題（今回やらないこと）

- **入金確認を GA4 に載せること**（Measurement Protocol・`client_id` の保管が要る）。
  件数と日数はサーバー側で取れるようになった（§10）。GA4 上で流入元と結びつける必要が出たら別タスク。
- **click 計測**。メール側の click 計測はアカウント全体で有効にすると
  マジックリンクが壊れるため禁止（`docs/progress.md`）。GA4 のサイト内計測とは別問題。

## 10. サーバー側の決済ファネル（申込受理 → 入金確認 / 2026-09-29 追加）

### なぜ要るか（2026-09-29 棚卸し・8/31〜9/28 実測）

| 段 | 取れていた値 | 問題 |
|---|---|---|
| pricing 閲覧 | GA4 page_view | 取れている |
| 申込開始 | GA4 `application_start` 10 件（9 人）| 取れている（ブラウザ計測なので欠けはあり得る）|
| 申込成功 | GA4 `application_submitted` **1 件** | 同期間の入金確認は Airtable 実測 **4 件**＝広告ブロック等で**大きく欠ける** |
| 入金確認 | Airtable `PaidAt`（1 人 1 行・上書き）| 件数は後から数えられるが、**申込日時・報告→確認の日数・放置件数は残らない**（`Requested*` は確認でクリア）|

### 何を記録するか（正本 `src/lib/payments/paymentFunnel.js`）

Airtable の列は増やさず、Redis（Upstash）に**件数だけ**を残す。識別子は recordId のみ（メール・氏名・金額は入れない）。

| event | 記録点 | 条件 |
|---|---|---|
| `application_received` | `bank-transfer-application.js` の成功応答の直前 | Airtable 保存が成功した分岐（既存更新／競合時の更新／新規作成）と Premium Plus（会員 recordId 確定時）だけ |
| `payment_confirmed` | `confirm-bank-payment.js` の昇格 PATCH 成功後 | プランは `RequestedPlan`（三連複買い切りは プラン 欄が変わらないため）|
| `confirm_lead` | 同上 | 報告→入金確認の日数区分 `d0/d1/d2-3/d4-7/d8plus`。計測開始前の申込は日数を推測しない |

- 同じ日・同じ人・同じ商品は 1 回だけ数える（再送・Automation 再発火で水増ししない）。
- 報告済みで入金確認待ちの人は `open` に残り、経過日数の分布が見える（`d8plus` は放置の疑い）。
- **計測の失敗・Redis 未設定・遅延（700ms 超）で申込も昇格も止めない**（例外を投げない）。Redis 未設定は「0 件」ではなく `measurement_unavailable`。
- Premium Plus の既存ファネル（`ak:pp:funnel:v1`）とは別名前空間。あちらの集計は変えない。

### 読み方

`POST /.netlify/functions/admin-payment-funnel` `{action:'summary', days:30}`（`x-admin-secret`・読み取り専用）。
計測は本番反映日から。**反映前の申込には日数が付かない**ので、比較は反映後 30 日以降に行う。

### rollback

両 Function の `recordPaymentApplication` / `recordPaymentConfirmation` の呼び出しを外すだけ（申込・昇格の処理は 1 行も変えていない）。
Redis の `ak:pay:funnel:v1:*` は消しても業務に影響しない。

### テスト

`src/lib/payments/paymentFunnel.test.mjs`（`test:bank-payment` → `check:safety`）: 語彙が閉じている・PII を入れない・同日重複・日数区分の境界・
確認待ちの経過日数・障害/遅延で例外を投げない・配線位置（保存成功後／昇格 PATCH 成功後）・admin API が書き込まない。

# GA4 有料化ファネル計測 — 正本

> 2026-09-18 MK 確定。既存 GA4（測定 ID は `src/layouts/BaseLayout.astro` が唯一持つ）を使い、
> **どの段階で離脱し、どこから有料転換につながっているか**を GA4 上で運用確認できるようにする。
> アクセス数を見ることが目的ではない。

## 1. 追う導線

```
流入（検索・メール・直接）
  → 無料予想
  → /results-showcase/（有料実績ショーケース）
  → /pricing/
  → 申込開始（振込モーダルを開く）
  → 申込成功（サーバーが申込を受理）
```

## 2. 各段を何で見るか

| 段 | 見るもの | 種別 |
|---|---|---|
| 流入 | `session_start` / 参照元は GA4 が自動で持つ | 既存 |
| 無料予想 到達 | `page_view` — Page path が `^/free(-prediction)?/\|^/free-prediction-` | 既存 |
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

`^/free` で雑に拾うと **無料登録ページ `/free-signup/`** が無料予想に混ざる。
上の正規表現は `/free/…` と `/free-prediction/…` と `/free-prediction-…` だけを拾い、
`/free-signup/` は拾わない。

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

### 未実施 — 残り 4 件（承認待ち）

| # | 作業 | 何が変わるか | 未実施だと |
|---|---|---|---|
| 1 | カスタム ディメンション `plan` を登録（範囲: イベント / イベント パラメータ `plan`）| プラン別に申込を分解できる | イベント数は見えるがプラン別に割れない |
| 2 | カスタム ディメンション `plan_type` を登録（同上）| 月額 / 年額 / 買い切り別に見られる | 同上 |
| 3 | `application_submitted` を**キーイベント**に指定 | 参照元別のコンバージョンとして扱われる | 参照元別の転換が標準レポートに出ない |
| 4 | 探索 → 目標到達プロセスデータ探索で上表 6 段を作る | 離脱段が見える | 毎回手で組む必要がある |

> `application_start` はキーイベントにしない（開いただけで転換とは言えない）。

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

- **入金確認（課金の確定）の計測**。Airtable で `PaymentConfirmed` が付いた時点は
  ブラウザに無いので、GA4 Measurement Protocol でサーバーから送る必要がある。
  `client_id` の保管が要るため別タスク。
- **click 計測**。メール側の click 計測はアカウント全体で有効にすると
  マジックリンクが壊れるため禁止（`docs/progress.md`）。GA4 のサイト内計測とは別問題。

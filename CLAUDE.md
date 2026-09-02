# CLAUDE.md - analytics-keiba 司令塔

> **このファイルは索引と「破ってはいけない約束」だけを持つ。**
> 仕様の詳細は `astro-site/docs/` 配下が**正本**。ここに詳細を書き戻さないこと
> （毎セッション読み込まれるため、肥大すると本当に読むべきルールが埋もれる）。

## プロジェクト識別

```
プロジェクト名: analytics-keiba
作業ディレクトリ: /Users/user/Projects/analytics-keiba/astro-site
本番URL: https://analytics.keiba.link
コンセプト: 南関競馬 + 中央（JRA）競馬 統合AI予想プラットフォーム
前身: /Users/user/Projects/nankan-analytics
参照: /Users/user/Projects/keiba-intelligence（先行実装・**独立運用**）
```

---

# 実装担当としての責任

Claudeは、ただのコード記述係ではなく、実装から検証まで担当するエンジニアとして行動する。

- 変更前に既存仕様・関連コード・既存テストを確認する。
- 変更には、必要なテストの追加または更新を含める。
- 実装後は関連テスト、lint、型検査、build、safety checkを可能な範囲で自ら実行する。
- 失敗した場合は報告だけで止まらず、原因を修正して再実行する。
- テスト未実行、失敗中、未検証の状態を「完成」と報告しない。
- 外部API・DB・ファイル操作は、失敗・空データ・タイムアウト・再実行を考慮し、エラーを握り潰さず安全側に処理する。
- 重要な不具合修正では、先に再現テストを作り、修正後に再発しないことを確認する。
- 完成条件は「コードを書いたこと」ではなく、要求された動作を検証できたこととする。

---

## 🚨 最重要：AI作業ルール 🚨

### 作業開始時に必ず明示

```
【今回の目的】
【変更対象ファイル】
【完了条件】
```

### 絶対禁止事項

1. **推測でコードを書かない** — Read ツールで実ファイルを確認する
2. **指示されていない変更を勝手に広げない**
3. **完了条件を満たさない完了宣言をしない**
4. **数値修正は修正前後の比較を必ず出す**（表形式）
5. **commit 前に `git diff` を確認する**
6. **本番反映前に確認方法を示す**
7. **検証を「一時的に無効化」しない**（CI・safety check・guard すべて）
8. **このファイル（CLAUDE.md）へ仕様の詳細を書き戻さない** — 下記「文書の置き場所」に従う

### 画面を伴う機能は「結果が見えるところ」までが実装（2026-08-23 集約）

サーバーが正しく動いても、**お客様・運営者が画面から結果を読み取れないなら未完成**。
指示されていなくても、以下は**毎回セットで実装する**（「言われなかったから」は理由にならない）。

| 種類 | 満たすこと |
|---|---|
| **送信できるフォーム** | 送信後に**お礼**を出し、**申込中の画面（口座情報・手順・入力欄）を残さない**。次の行き先（マイページ等）を必ず置く |
| **失敗したとき** | 成功と見分けがつく表示にする。**通信断は「成功」とも「失敗」とも言わない** |
| **値が変わる操作**（クーポン適用・プラン変更など） | **その値を出している要素を 1 つ残らず更新する**。1 か所でも古いままなら「変わらない」と読まれる |
| **金額** | 表示は**サーバーが返した値だけ**。画面で計算しない。**同じ画面に違う金額を出さない** |
| **管理画面の操作** | 実行前に**何が起きるか**、実行後に**何が起きたか**を出す。戻せない操作は「戻せない」と明示する |
| **毎回同じ入力を求めない** | 操作者名・定型の理由などは保存するか既定値を持つ。ただし**監査記録は空にしない**（既定値を記録する） |

**過去事例（2026-08-23）**: Premium Plus の申込で、金額の表示 4 か所のうち 2 か所しか
更新しておらず「クーポンを適用しても金額が変わらない」状態だった。また送信後に
`<form>` だけを隠していたため、口座番号と振込手順が残り「送信したのに同じ画面」に見えていた。
どちらもサーバー側は正しく動いていた。

検証: `npm run test:order-ux`（`check:safety` に組込済み）

### 金額は「見せた額 = 請求する額」まで検証する（2026-08-25 集約）

**サーバーが正しい**と**お客様に正しく見えている**は別の事実。
`RequestedAmount` だけを検査するテストは、画面が古い金額のままでも全部 pass する。

| 必ず満たすこと | 検証 |
|---|---|
| 商品名の読み替えは**共有の単一源**（`payments/productName.js`）| 画面とサーバーが自前で正規化しない |
| 画面が出す金額は**サーバーが返した値だけ** | 画面で割引を計算しない・金額を直書きしない |
| **請求額が画面の額を上回らない** | サイト中の購入ボタンを全部集めて突き合わせる |
| 割引が乗る組み合わせが**実在する** | 「1 つも乗らない」＝検査が素通りしている |
| すでに特別価格の商品には**重ねない** | `- Campaign` 等を上書きしない |

**過去事例（2026-08-24〜25 に 4 回）**:
①開けない会員ページを申込先にした ②存在しない商品の価格を案内した
③既存の特別価格を上書きした ④案内は割引価格なのに申込モーダルは元の金額のままだった。
いずれも**自分が書いた値を自分で確認するテスト**しか無く素通りした。

⚠️ 申込モーダル（`openBankModal`）は**16 ページにコピペで散在**している。
ページごとに直さず、`public/js/campaign-price.js` が**1 か所で包む**。
（過去に「15 ページ直し漏れて全部 400 失敗」の事故あり）

検証: `npm run test:promotions`（`check:safety` に組込済み）

### 文書の置き場所（CLAUDE.md を再肥大させない）

CLAUDE.md は**毎セッション全文が読み込まれる**。詳細を戻すと、守るべき禁止事項が埋もれる。

| 書く内容 | 置き場所 |
|---|---|
| 禁止事項・停止条件・不変条件（1〜3 行で言い切れるもの） | **CLAUDE.md** |
| 仕様・手順・閾値・フィールド一覧・経緯・インシデント記録 | `astro-site/docs/` の**正本** |

- 新しい仕様を書くときは **既存の正本を先に探す**。無ければ新規 doc を作る
- **新規 doc は必ず CLAUDE.md の「ドキュメント索引」へ 1 行追加**する（到達不能な doc を作らない）
- 同じ規則を CLAUDE.md と doc の両方に**詳細まで**書かない（正本は 1 つ）

### 停止して確認を取る操作

PR の merge / production deploy / 本番データ書込み / env の変更 / queue 登録 / 実送信 /
実顧客レコードの変更。**これらは承認前に必ず止まる。**

### 自律完遂の運用

段取り・完了条件・報告様式は [`docs/AUTONOMOUS_DELIVERY.md`](./astro-site/docs/AUTONOMOUS_DELIVERY.md)。

---

## 🌐 本番 URL ルール（運用厳守）

| 項目 | 値 |
|---|---|
| **本番 URL** | `https://analytics.keiba.link/` |
| **使用禁止 URL** | `https://analytics.keiba.jp/`（誤記・存在しない）|
| **Netlify サブドメイン** | `https://*.netlify.app/` は **Deploy Preview 専用**。本番案内に使わない |

**禁止**: 本番確認 URL を推測で生成しない。ドメインを記憶や雰囲気で補完しない。
不明なら**ユーザー確認を取る**。PR 説明・本番反映確認の案内・目視確認の指示・
外部ドキュメントの URL すべてに適用する。

---

## 🧭 修正対象範囲ルール（4領域横断確認）

表示・ロジック・データ反映・UI・文言・不具合修正は、**原則 4 領域すべてを確認範囲に含める**。
一部だけ直して「完了」扱いにしない。

| # | 領域 | ページ |
|---|---|---|
| 1 | JRA **無料** | `src/pages/free-prediction/jra.astro` |
| 2 | JRA **有料** | `src/pages/premium-prediction/jra.astro` |
| 3 | NANKAN **無料** | `src/pages/free-prediction/nankan.astro` |
| 4 | NANKAN **有料** | `src/pages/premium-prediction/nankan.astro` |

**必ず横断確認する対象**: 指数表示 / 総合評価 / 買い目 / 不要馬 / 過去走 / 特徴量・評価ポイント /
レース一覧・詳細 / アーカイブ結果 / 取込・変換ロジック / 表示文言・演出 UI。

**特定領域のみが対象の場合**は、作業前または報告時に
**対象範囲 / 対象外とした範囲 / 対象外にした理由 / 中央・南関・無料・有料への影響**を明記する。
明記なしで一領域だけ修正して push することは禁止。

> 過去事例（2026-05-24）: JRA 有料版の `総合評価★` を `AI総合指数` へ移行した際、
> 無料 JRA に旧ブロックが残り、ユーザー指摘で発覚した。

パリティ検証: `npm run check:jra-nankan-parity`

---

## 📚 ドキュメント索引（**正本はこちら**）

### 予想・表示

| 領域 | 正本 |
|---|---|
| 予想ロジック（スコア・役割決定） | [`PREDICTION_LOGIC.md`](./astro-site/docs/PREDICTION_LOGIC.md) |
| 買い目生成（メイン5点 / 通常2段 / 抑え判定） | [`MAIN_RACE_BETTING.md`](./astro-site/docs/MAIN_RACE_BETTING.md) |
| 購入点数・回収率 | [`BET_POINT_LOGIC.md`](./astro-site/docs/BET_POINT_LOGIC.md) |
| 指数表示（raw − 1 / AI総合指数） | [`DISPLAY_INDEX_RULES.md`](./astro-site/docs/DISPLAY_INDEX_RULES.md) |
| データ取込フロー・二段防御 | [`DATA_FLOW.md`](./astro-site/docs/DATA_FLOW.md) |
| CI safety check | [`SAFETY_CHECKS.md`](./astro-site/docs/SAFETY_CHECKS.md) |
| 旧 KI 風ブロックの再混入防止 | [`KI_RELIC_GUARDS.md`](./astro-site/docs/KI_RELIC_GUARDS.md) / [`PREMIUM_JRA_RULES.md`](./astro-site/docs/PREMIUM_JRA_RULES.md) / [`FREE_JRA_RULES.md`](./astro-site/docs/FREE_JRA_RULES.md) |
| archive 同期・取込要否の監視契約 | [`ARCHIVE_SYNC_MONITORING.md`](./astro-site/docs/ARCHIVE_SYNC_MONITORING.md) |
| keiba-intelligence との分離（独立運用） | [`KI_INDEPENDENCE.md`](./astro-site/docs/KI_INDEPENDENCE.md) |

### 商品・導線

| 領域 | 正本 |
|---|---|
| Premium Plus（1日1鞍・単品） | [`PREMIUM_PLUS.md`](./astro-site/docs/PREMIUM_PLUS.md) / [`PREMIUM_PLUS_STAGED_RELEASE.md`](./astro-site/docs/PREMIUM_PLUS_STAGED_RELEASE.md) / [`PREMIUM_PLUS_STORAGE_DESIGN.md`](./astro-site/docs/PREMIUM_PLUS_STORAGE_DESIGN.md) |
| 有料実績ショーケース | [`RESULTS_SHOWCASE.md`](./astro-site/docs/RESULTS_SHOWCASE.md) |
| 販売導線の制御（UpsellTarget） | [`UPSELL_TARGET.md`](./astro-site/docs/UPSELL_TARGET.md) |
| **クーポン基盤（Premium Plus 専用ではない）** | [`COUPON_PLATFORM.md`](./astro-site/docs/COUPON_PLATFORM.md) |

### 顧客・決済・メール

| 領域 | 正本 |
|---|---|
| **メールアドレスの正本（support / noreply の役割）** | [`EMAIL_ADDRESSES.md`](./astro-site/docs/EMAIL_ADDRESSES.md) |
| ログイン（マジックリンク） | [`AUTH_LOGIN.md`](./astro-site/docs/AUTH_LOGIN.md) / [`AUTH_SESSION_DESIGN.md`](./astro-site/docs/AUTH_SESSION_DESIGN.md) |
| **有料ページ認可の単一源（ページに独自 plan 判定を書かない）** | [`PAID_PAGE_AUTHORIZATION.md`](./astro-site/docs/PAID_PAGE_AUTHORIZATION.md) |
| 管理画面の Basic 認証（`/admin/*`） | [`ADMIN_BASIC_AUTH.md`](./astro-site/docs/ADMIN_BASIC_AUTH.md) |
| 銀行振込 入金確認フロー | [`BANK_TRANSFER_FLOW.md`](./astro-site/docs/BANK_TRANSFER_FLOW.md) |
| 入金確認メール v2 | [`PAYMENT_EMAIL_V2.md`](./astro-site/docs/PAYMENT_EMAIL_V2.md) |
| 顧客マーケティング管理 | [`CUSTOMER_MARKETING.md`](./astro-site/docs/CUSTOMER_MARKETING.md) / [`CAMPAIGN_SEQUENCE.md`](./astro-site/docs/CAMPAIGN_SEQUENCE.md) / [`ENGAGEMENT_SUPPRESSION.md`](./astro-site/docs/ENGAGEMENT_SUPPRESSION.md) |
| カムバック施策（無料特典 + 割引オファー） | [`COMEBACK_GRANTS.md`](./astro-site/docs/COMEBACK_GRANTS.md) |
| SendGrid Event Webhook | [`SENDGRID_WEBHOOK.md`](./astro-site/docs/SENDGRID_WEBHOOK.md) / [`EMAIL_EVENT_LEDGER.md`](./astro-site/docs/EMAIL_EVENT_LEDGER.md) / [`DELIVERY_MEASUREMENT.md`](./astro-site/docs/DELIVERY_MEASUREMENT.md) |
| 顧客重複整理 | [`CUSTOMER_DEDUPE.md`](./astro-site/docs/CUSTOMER_DEDUPE.md) / [`CUSTOMERS_DEDUP_GUIDE.md`](./astro-site/docs/CUSTOMERS_DEDUP_GUIDE.md) |
| ポイント交換 | [`POINT_EXCHANGE_FULFILLMENT.md`](./astro-site/docs/POINT_EXCHANGE_FULFILLMENT.md) |
| 管理画面の絞り込み用語 | [`ADMIN_FILTER_DICTIONARY.md`](./astro-site/docs/ADMIN_FILTER_DICTIONARY.md) |
| メルマガ基盤（Airtable 設計 / プレビュー / backfill） | [`NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md`](./astro-site/docs/NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) / [`NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md`](./astro-site/docs/NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) / [`NEWSLETTER_PREVIEW_USAGE.md`](./astro-site/docs/NEWSLETTER_PREVIEW_USAGE.md) / [`NEWSLETTER_BRAND_BACKFILL_SPEC.md`](./astro-site/docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md) / [`NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md`](./astro-site/docs/NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) |

### 移設の対応表

CLAUDE.md 再編（2026-08-13）で旧セクションがどこへ行ったかの全件対応表は
[`CLAUDE_MD_MIGRATION_AUDIT.md`](./astro-site/docs/CLAUDE_MD_MIGRATION_AUDIT.md)。

---

## 🚫 領域別の不変条件（詳細は各正本へ）

破ると本番事故になるものだけを並べる。**変更したくなったら、まず正本を読むこと。**

### 🎟 クーポン（**Premium Plus 専用ではない** / 2026-08-20 MK 確定）

**クーポンは今後ほかの商品・プランでも利用する。Premium Plus は最初の利用商品にすぎない。**
正本は [`COUPON_PLATFORM.md`](./astro-site/docs/COUPON_PLATFORM.md)。

- 判定（操作の種類 / 排他規則 / 状態遷移 / 監査の書式 / fail closed）は
  **共通層 `src/lib/coupons/`** に置く。**商品ごとに判定を書かない**
- 商品固有なのは**クーポン定義**と**保有状態の置き場所（binding）**の 2 つだけ。
  **2 商品目で Premium Plus のコードをコピーしない**
- **付与と再発行は排他**（履歴なし → 付与 / 履歴あり → 再発行）。
  取得済み・利用予約中・使用済み・台帳確認不能は**どちらも不可**
- **UI だけの制御にしない**。サーバーが必ず同じ判定を再実行する
- 履歴は **append-only**（`CouponOperationHistory`・**本番テーブル未作成 / MK 判断待ち**）。
  **`PromotionalOffers` に監査行を混ぜない**（価格の無い行が顧客分類を壊す）
- 割引額 / 期限 / 配布条件 / 併用可否 / 自動付与条件は**商品ごとに MK が決める**。
  **決まっていない条件を既定値で埋めない**

### 🔐 有料ページの認可（2026-09-02 集約）

**認可はサーバー側 `gatePaidPage`（`ak_session` + `resolveEntitlements`）だけで決める。
ページに独自の plan 判定を書かない。** 正本は
[`PAID_PAGE_AUTHORIZATION.md`](./astro-site/docs/PAID_PAGE_AUTHORIZATION.md)。

事故: 三連複は買い切りの**追加権**で、入金確認時に書かれるのは `LifetimeSanrenpuku=true`
**だけ**（`プラン` は `Premium` のまま）。`plan` 文字列だけを見るページ独自スクリプトが、
購入済み会員を**無料体験ページへリダイレクト**し、**三連複アーカイブから締め出し**、
**追加購入 CTA を出し続けて**いた。サーバー gate と `AccessControl` は正しく通していた。

- ページ内で `localStorage` / `sessionStorage` の plan を読んで**表示可否を決めない**
  （入力補助・表示ラベル・UI 状態の保存は対象外）
- `user-plan` / `userPlan` / `userData` に書いてよいのは**サーバー応答が返した値だけ**。
  クライアントが作った値・URL クエリ由来の値を書かない
  （有料会員の正本は `src/pages/auth/verify.astro`。`login` / `free-signup` / `dashboard` は
  `auth-user` の応答を保存するが、有料会員は `requiresMagicLink` で必ず検証経路へ回る）
- **URL クエリから権限を作らない**（`/welcome/?plan=` は撤去済み）
- 正規の書き込み元が無い権限チャネルを読まない
  （`auth_data` / `sessionStorage.temp_auth` は削除済み。**復活させない**）
- 三連複の保有を `plan` 文字列だけで判定しない。必ず `lifetimeSanrenpuku` を併せて見る
- 南関だけ / 中央だけにページ独自の表示判定を足さない（**片側だけ壊れる**）
- `gatePaidPage({ requiredPlan: [...] })` は any-of。三連複アーカイブ 6 ページは
  `SANRENPUKU_ARCHIVE_PLANS`（馬単アップセル面 ＋ 保有者の実績面）を共有する

検証: `npm run test:auth-session`（`paidPageSingleSourceGate.test.mjs`）— `check:safety` に組込済み

### 単一源を再実装しない

| 判定 | 単一源 |
|---|---|
| 抑え / 不要馬 | `src/utils/osaeClassification.js` |
| AI総合指数の表示 | `src/lib/shared-prediction-logic.js` の `getHorseAiIndex()` |
| メイン判定・買い目生成 | `src/utils/mainRaceBetting.js` |
| 販売導線の選択 | `src/lib/upsell/upsellTarget.js` |
| マーケ対象判定 | `src/lib/marketing/customerMarketingAudience.js` |
| 銀行振込の書込みフィールド | `src/lib/payments/bankPaymentFlow.js` |
| メールアドレス（問い合わせ先 / 送信元） | `netlify/functions/config/email-config.js` |
| 権限（entitlement） | `src/lib/entitlements/resolveEntitlements.js` |
| 有料ページの入口（サーバー認可） | `src/lib/auth/paidPageGate.js` の `gatePaidPage()` |
| 三連複 CTA / 予告 / 結果の出し分け | `src/lib/sanrenpuku/sanrenpukuCtaStage.js` |

ページ側・Function 側にローカル判定を再実装しない。

**重み・閾値・判定基準を変更したら、コードと該当する正本 MD を必ず両方更新する**
（予想ロジックの重み / 購入点数の閾値 / 段階公開の日数 など）。
片方だけ直すと、次に読む人が古い方を信じる。

### 表示

- **外部由来の元指数をそのまま画面に出さない。表示は必ず `raw − 1`。**
  JSX に `{horse.computerIndex}` / `{horse.sourceComputerIndex}` を直接埋めるのは禁止
- AI総合指数のフォールバックに `pt` / `totalScore` / `displayScore` / `rawScore` /
  `confidence` / `score` を使わない（別スケール。100 超の異常値になる）
- 壊れた馬データは**取込側 (sanitize)** で直す。表示側で `)` を replace 等の隠蔽をしない

### 旧フォーマット禁止

| 禁止（旧） | 必須（新） |
|---|---|
| `raceResults` ❌ | `races` ✅ |
| `honmeiHit` ❌ | `isHit` ✅ |
| `umatanHit` ❌ | `hitLines` ✅ |
| `sanrenpukuHit` ❌ | （廃止・後継なし） |

検証: `npm run validate:archive`

### 買い目

- メインレースは **一方向馬単 `→` 最大 5 点**（裏目は買わない＝不的中）
- 通常レースは **双方向 `↔` の本命軸 + 対抗軸 2 段**
- 上位プランへの導線は「買い目数」ではなく「**閲覧できるレース数**」で作る
- 過去 archive は再判定しない

### Premium Plus

- **単品購入**（サブスクではない）／**Premium Sanrenpuku 会員にのみ表示**
- Premium / Light / 無料ページに CTA を置かない（`noindex` + robots.txt Disallow）
- 実績数値の**手書き禁止**（`computeStats()` の戻り値のみ）
- **不的中の日も必ずアップロードする**（的中日だけ上げると的中率が嘘になる）
- 実績画像は Netlify Blobs。`public/upsell-images/` へのハードコード方式は**復活させない**

### 顧客・決済・メール

- **メール送信・キャンペーンは `プラン` / `PlanType` / `Status` / `有効期限` /
  `LifetimeSanrenpuku` / `PaymentConfirmed` / `PaymentEmailSent` を 1 バイトも書かない**
- 昇格の唯一の経路は `PaymentConfirmed` → `confirm-bank-payment`
- **退会は「課金停止」であって「メール拒否」ではない**。マーケ除外にしない
  （`suspended` / `banned` は除外を維持）
- **grant ≠ paid contract / offer ≠ entitlement**。無料特典・割引は権利も価格資格も与えない
- **`NEWSLETTER_AUTOMATION_ENABLED` をマーケティングのために ON にしない**
  （AK の全メール自動化のマスタースイッチ。専用ゲートだけで解禁する）
- SendGrid suppression は毎回照合し、**取得に失敗したら送信計画を作らない**（fail closed）
- secret の値そのものを CLAUDE.md / ログ / commit に**絶対に記載しない**
- **メールアドレスを Function / ページへ直書きしない。**
  問い合わせ・返信先 = `support@keiba.link`（`SUPPORT_EMAIL` / `ADMIN_EMAIL`）、
  システム送信元 = `noreply@keiba.link`（`FROM_EMAIL`）。正本は
  `netlify/functions/config/email-config.js` **1 ファイルだけ**。
  旧サイト名残の `nankan.analytics@gmail.com` / `nankan-analytics@keiba.link` は
  2026-08-31 に現役経路から全廃済み（**復活させない**）。検証: `npm run test:email-identity`
- ただし**決済メールは `senderIdentity.js`**（正式送信元 support / noreply への fallback 禁止）、
  **メルマガは `brand-config.js`**（From は DeliveryKey の構成要素＝変えると二重送信）。
  「統一」を理由にこの 2 経路を `FROM_EMAIL` へ寄せ替えない。正本:
  [`EMAIL_ADDRESSES.md`](./astro-site/docs/EMAIL_ADDRESSES.md)
- **認証情報をソースへ書かない**（env にだけ置く）。env 未設定は「認証不要」ではなく
  **誰も通さない**（fail closed）。正本: [`ADMIN_BASIC_AUTH.md`](./astro-site/docs/ADMIN_BASIC_AUTH.md)

### Customers の取得（15,962 件）

- **無フィルタの全件走査を作らない。** 用途別に `filterByFormula` で絞るか、
  絞れないなら **fail closed**（少ない件数を正しい件数として見せない）
- **`MAX_PAGES` を上げるのは解決ではない**（打ち切りがタイムアウトに変わるだけ）

検証: `npm run check:no-unbounded-scan`

### keiba-intelligence（AK と KI の分離）

**`keiba-intelligence` 側を絶対に触らない。**
2026-05-23〜 AK と KI は**別サービスとして独立運用**する。両方とも稼働を続け、
それぞれ独自の顧客へ予想を提供する。

- AK 側のロジック修正を KI へ **自動的に横展開しない**
- KI 側は **必要な場合のみ個別に修正**する
- admin (`keiba-data-shared-admin`) からの dispatch / データ供給は **当面維持**
- **過去の経緯を理由に同期作業を再開してはいけない**（2026-05-22 以前の同期義務は撤廃済み）

運用方針・過去の経緯の全文は
[`KI_INDEPENDENCE.md`](./astro-site/docs/KI_INDEPENDENCE.md)（**正本**）。

---

## 🔧 開発コマンド

```bash
cd /Users/user/Projects/analytics-keiba/astro-site
npm run dev                    # 開発サーバー
npm run build                  # validate → build → SSR 関数の prune
npm run validate:archive       # 旧フォーマット混入の検証
npm run import:prediction      # 南関 予想取込（:jra で JRA）
npm run import:results         # 南関 結果取込（:jra で JRA）
npm run check:safety           # 恒久ルール検証を全部（CI と同じ）
npm run verify:safety          # build + check:safety（push 前推奨）
```

**予想ページ・カード・全レースプレビューを変更したら必ず `npm run check:safety` を実行する。**
個別の `check:*` / `test:*` は `package.json` を参照（すべて `check:safety` に組込済み）。

### CI で強制していること（正本: [`SAFETY_CHECKS.md`](./astro-site/docs/SAFETY_CHECKS.md)）

1. 指数表示は必ず `raw − 1`
2. 全レースプレビューで全頭が分類される（表示合計 = 出走頭数）
3. **無料版のモザイクは「描画されて」初めてマスク**
   （gradient 文字の中では子の `blur()` が効かない。親に `stat-value-masked` を付ける）
4. 旧 KI 風ブロックが混入していない（3 ページ分の guard + 構造パリティ）
5. Customers の無フィルタ全件走査＋黙って打ち切りが無い
6. **「当日」を出すページはビルド時に日付を決めない**（SSR 必須）
   — 静的生成のままビルド時刻で当日を決めていた `/dark-horse-picks/` が、
   毎日「前日のレース」を終日表示していた（2026-08-30 お客様報告）。
   前日 / 最新日への fallback を足さないこと

**CI を通さずに指数表示や馬分類を変更してはいけない。**

新しい guard を足すときは
**`package.json` の `check:safety` と `.github/workflows/safety-check.yml` の
`paths` と `jobs.safety.steps` の 3 箇所すべて**に追加する（paths だけでは CI 実行されない）。

---

## 📝 技術スタック

Astro 5 + Sass（SSR）/ Netlify Pro（Functions・Blobs）/ Airtable Pro（顧客）/
SendGrid（メール）/ Upstash Redis（計測・スナップショット）/ Gemini 2.5 Flash（AI解説）/
Stripe + 銀行振込（決済）

### 特徴量システム

`src/utils/featureScores.js` に全ページ共通の算出ロジック
（Speed Index / Stamina Rating / Form Trend / Track Compatibility / Distance Fitness /
Jockey Factor / 期待値（predictedOdds が無ければ控除率 25%））。

### GitHub Actions

`.github/workflows/` に配置。Concurrency Group は
**南関 `archive-nankan-update` / JRA `archive-jra-update`** で統一。
監視契約（偽の緑を作らないための exit code 規約）は
[`ARCHIVE_SYNC_MONITORING.md`](./astro-site/docs/ARCHIVE_SYNC_MONITORING.md)。

### Netlify 環境変数（必須）

```
AIRTABLE_API_KEY / AIRTABLE_BASE_ID
SENDGRID_API_KEY / SENDGRID_FROM_EMAIL / SENDGRID_CUSTOM_FIELD_ANALYTICS
GEMINI_API_KEY
GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME / GITHUB_BRANCH
```

機能別のゲート env（既定 OFF）は各正本を参照。**env 変更は要承認**。

---

## 関連プロジェクト

| プロジェクト | 役割 |
|---|---|
| `keiba-intelligence` | 先行実装。**独立運用・触らない** |
| `keiba-data-shared-admin` | データ入力管理ツール |
| `nankan-analytics` | 旧実装（段階的に引退） |

---

## 完了報告の簡潔化

各フェーズの完了報告は、原則として以下だけを簡潔に記載する。

- 判定
- 実施内容
- 変更ファイル
- テスト結果
- Git状態（branch / commit / PR URL）
- 異常・未確定事項（blocker を含む）
- 次工程案

成功したコマンドの全文、重複する説明、既知仕様の再掲は省略する。
エラー、想定外差分、安全条件違反がある場合のみ、必要なログを提示する。

**各リポジトリ固有の安全条件、伝播確認、本番確認、取得回数、rollback 条件など、
既存の必須報告項目は省略しない。**

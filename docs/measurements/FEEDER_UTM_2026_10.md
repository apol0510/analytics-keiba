# feeder サイトからの流入計測（UTM・2026-10-22 開始）

> 目的: AK 以外のサイト（feeder）が AK へ送る流入を、**サイト別に** `sign_up` / 申込 / `purchase` まで GA4 で追えるようにする。
> AK・KI の月間売上（KAO D-158）に対し、その他サイトは「導線として送客できているか」で評価する（KAO CLAUDE.md §3）。
> GA4 の既存ファネル・イベント仕様の正本は [`astro-site/docs/GA4_CONVERSION_FUNNEL.md`](../../astro-site/docs/GA4_CONVERSION_FUNNEL.md)。本書は feeder 別の読み方と既知の欠けだけを持つ。

## 1. 契約（feeder 側が付けるもの）

| パラメータ | 値 |
|---|---|
| `utm_source` | 送り元サイトの識別子（`<site>`。サイトごとに固定・小文字） |
| `utm_medium` | `referral`（固定） |

- AK 側は UTM を**書き換えない・消さない**。GA4 は着地ページの `page_location` から自動で読む。
- `utm_campaign` 等は任意（あれば GA4 がそのまま使う）。

## 2. ベースライン

- **2026-10-22 より前に UTM 付きの feeder 流入は無い**（feeder 側の UTM 付与は 2026-10-22 開始）。
  したがって `Session medium = referral` かつ feeder の `utm_source` を持つセッションは 2026-10-22 以降だけに出る。比較は「開始前 = 0」から。
- 2026-10-22 以前の feeder 由来の流入は、GA4 では各サイトのホスト名の `referral`（UTM なし）か `(direct)` として混在しており、サイト別には分けられない。推定値は作らない。

## 3. AK 側で UTM が保たれることの確認（2026-10-22 実測・コード確認）

| 経路 | 結果 |
|---|---|
| 着地ページの GA4 設定（`BaseLayout.astro` の `gtag('config')`）| `page_location` を上書きしない＝ `utm_*` は GA4 にそのまま届く。2026-10-22 から、**`token` パラメータだけ**を `page_location` / `page_referrer` から外す（マジックリンクのログイン用トークンを GA4 に送らないため）。`utm_*` は残る（`gaPageLocation.test.mjs`）|
| 静的 SEO 記事 `/seo/<slug>/` | 記事自身が同じ測定 ID の gtag を持つ（`page_location` の上書き無し）|
| リダイレクト（例: 旧 `nankan-analytics.keiba.link/<slug>/` → `analytics.keiba.link/<slug>/` → `/seo/<slug>/`）| Netlify の 301 はクエリを引き継ぐ（1 段目を本番で実測: `?utm_source=…&utm_medium=referral` が `Location` に残る）。2 段目は本 PR の deploy preview で確認 |
| URL を書き換える処理（`history.replaceState`）| `AiLabBoard`（AI ラボの絞り込み）と `dashboard`（`url.search` を保持）だけ。着地時の UTM は GA4 が読んだ後なので影響しない |
| `sign_up`（`/free-signup/`）| 登録完了は同じページ・同じセッションで発火 → feeder のセッションに付く |
| `application_start` / `application_submitted`（銀行振込）| サイト内のモーダル・同じセッションで発火 → feeder のセッションに付く |

## 4. 既知の欠け（コードでは直さない／直せない）

| # | どこで | 何が起きるか | 対応 |
|---|---|---|---|
| 1 | **マジックリンクでのログイン** | メールのリンクから開くと新しいセッションになる。Web メール（例: Yahoo! メール）から開くとそのドメインの `referral` が新しい流入元になり、**セッション単位の流入元は feeder でなくなる**。メールアプリ内ブラウザ・別端末で開くと GA4 の client_id 自体が変わり、**同一ユーザーとしても結べない** | 簡単・安全な修正は無い（マジックリンクに UTM を付けると「メール」流入に上書きされて逆効果。端末を跨ぐには user_id 連携が要る＝別タスク）。読むときは §5 の**ユーザー単位（First user source）**を使い、会員ページ以降の行動は欠けうる前提で読む |
| 2 | **Stripe / PayPal から戻った後の `purchase`** | 決済は外部ドメイン（`checkout.stripe.com` / `www.paypal.com`）で行われ、戻り先（`/checkout/success/` 等）は外部からの `referral` として**新しいセッション**になりうる。その場合 `purchase` のセッション流入元は stripe / paypal になる | GA4 管理画面の作業（コード外）: 管理 → データストリーム `analytics-keiba` → タグ設定 → **除外する参照のリスト**に `checkout.stripe.com` / `stripe.com` / `paypal.com` / `www.paypal.com` を登録すると、戻りが元のセッションに続く。⚠️ feeder のドメインは**登録しない**（登録すると feeder 流入が消える）。未登録の間は `purchase` を First user source で読む |
| 3 | 広告ブロック・GA4 の取りこぼし | `application_submitted` は実測で Airtable より大きく欠ける（`GA4_CONVERSION_FUNNEL.md` §10）| 件数の正本はサーバー側（決済ファネル・Airtable・月次売上 measurement）。GA4 は**比率と流入元の内訳**に使う |

## 5. GA4 での読み方（feeder 別ファネル）

### a. まず流入量（レポート）

レポート → 集客 → **トラフィック獲得**。ディメンション「セッションの参照元 / メディア」、フィルタ「セッションのメディア = `referral`」。
`<site> / referral` の行がサイト別の流入。列「キーイベント」を `application_submitted` / `purchase`（必要なら `sign_up`）に切り替えて転換数を見る。

> `sign_up` がキーイベント未指定なら、キーイベント列には出ない（イベント数は「エンゲージメント → イベント」で見られる）。
> キーイベントの指定は GA4 管理画面の作業で、指定した日以降にだけ効く。

### b. ファネル（探索）

探索 → **ファネルデータ探索**（新規）。

| 段 | 条件 |
|---|---|
| 1 流入 | `session_start` |
| 2 無料登録完了 | `sign_up` |
| 3 申込開始 | `application_start` または `begin_checkout` |
| 4 申込成功・購入 | `application_submitted` または `purchase` |

- **内訳**: 「最初のユーザーの参照元 / メディア（First user source / medium）」— §4 の欠け（マジックリンク・決済戻り）を跨いでも feeder に結びつくのはこちら。
  補助として「セッションの参照元 / メディア」も並べる（同一セッション内で完結した転換だけを数える厳しめの値）。
- **フィルタ**: 該当ディメンションのメディア = `referral` かつ参照元が feeder の `utm_source` 一覧に一致。正規表現条件は**値全体の一致**なので末尾に `.*` を付けるか完全な値で書く（`GA4_CONVERSION_FUNNEL.md` §6）。
- 期間は **2026-10-22 以降**（§2）。流入が少ないうちは比率を判断に使わない（サンプルが小さい間に施策を頻繁に変えない）。

### c. 数え方の注意

- First user source は「そのユーザーが初めて来た経路」。2026-10-22 以前から AK を知っていたユーザーは feeder に数えられない（過小側）。
- 同じユーザーが複数の feeder を経由した場合、First user は最初の 1 つ、Session は各セッションの値。

## 6. rollback

本書は読み方の記録。`token` 除去は `BaseLayout.astro` の `akGaConfig` を外して `gtag('config', 'G-BTDCZE1B13')` に戻せば元どおり（UTM の扱いは変わらない）。

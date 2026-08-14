# Premium Plus 運用ガイド

`/premium-plus/` — 1 日 1 鞍・三連単フォーメーションの**単品商品**。

## ⛔ Phase 5 結論（2026-07-16）: サーバー側書込み経路は本番 hard block・現状 404 inert

`premium-plus-media` API のサーバー側 manifest 更新経路（upload / seed / hide / show /
rollback）は、**Netlify Blobs 単独では multi-writer の lost-update を防げないと確定した**ため、
env フラグとは独立に**コードレベルで hard block** している。安全な storage backend が
実装されるまで有効化してはならない。

- **本番判定 = No-Go**。`/premium-plus/` ページ自体（SSR 会員ゲート）は従来どおり稼働するが、
  `premium-plus-media` Function は **GET / POST とも常時 404**（`PREMIUM_PLUS_STORAGE_SAFE = false`
  コード定数 ＋ `PREMIUM_PLUS_ENABLED` env の二重 kill）。
- 画像日次更新（この doc の「方法 A / B」）は **この書込み経路に依存するため現状は使用不可**。
  安全な backend が入るまで実運用の画像更新はできない（設計見直しが前提）。

### 何が起きたか（#13 実 lost-update の確定証拠）

canary（`premium-plus-canary` 隔離ストア）で並び順を検証したところ、eventual 遅延下で
**実際の lost-update が再現**した。manifest チェーンの証拠:

- #4 upload → manifest `50fad4a6`（v1）、pointer → 50fad4a6
- #13 stale write（別 operationId）→ manifest `010738f9`（v1, **`previousManifestId="" `= 空 snapshot
  から生成**）。その pointer への **`setJSONIfNew`（create-only）が成功して #4 の pointer を上書き**
  し、50fad4a6 を orphan 化した。
- #18 hide は #13 の manifest に chain した。

`setJSONIfNew` は既存キーに対して `modified:false`（=409）を返すべきところ **成功した**。

### 根本原因（重要・次工程の前提を修正）

**Netlify Blobs は同一キー競合について last-write-wins であり、concurrency control mechanism
（atomic compare-and-swap）を提供しない。** `onlyIfNew` / `onlyIfMatch` は best-effort であって
strong な排他保証ではなく、eventual read で「キー無し／古い etag」を見た writer が既存の勝者を
上書きできる。

- **strong consistency は「読取り鮮度」の設定であり、atomic CAS の保証ではない。**
  したがって **Netlify Functions 2.0 / modern Blobs runtime への移行だけでは #13 は解決しない**
  （この前提は撤回済み）。`uncachedEdgeURL` による strong 読取を足しても、書込みの排他は得られない。
- 以前コード内に書いていた「etag CAS が正当性を担保」「eventual でも stale は CAS 失敗→リトライに
  なるだけで破損しない」「atomic なので TOCTOU にならない」は **実 Netlify Blobs には当てはまらない**
  （in-memory テストストアは atomic 条件付き書込みを*モデル化*しているため、機械テストは design が
  正しいことのみを示す。実ストアがそのモデルを破る）。該当コメントは実態へ是正済み。

### readCurrentStable の位置づけ（是正）

`readCurrentStable`（収束読取）は **freshness mitigation（読取鮮度の best-effort 改善）であって
correctness guarantee ではない**。同一 edge の cache を読み続ける burst では収束しないことがあり、
lost-update を防ぐ機能はない。以前「fail-closed で stale client を 409 で弾く」と記述していたが、
**その 409 は CAS の strong 排他に依存しており、実 Blobs ではその依存が成立しない**ため、
correctness の主張から除外した。読取鮮度の改善策としてコードに残すが、安全性の根拠にはしない。

### 次期設計

lost-update 防止・operationId 一意性・rollback・障害復旧・運用コストの比較と推奨案は
[`PREMIUM_PLUS_STORAGE_DESIGN.md`](./PREMIUM_PLUS_STORAGE_DESIGN.md) を参照（read-only 比較・未着手）。
storage migration / 外部 DB 作成 / env 投入 / 実データ書込みは**まだ行わない**。

---


## 🚦 導線は段階公開（2026-07-28〜）

Premium Sanrenpuku 購入直後に ¥68,000 の購入 CTA を見せない。
**PHASE 1 非公開 → 2 予告 → 3 商品閲覧 → 4 受付解禁**の時間差導線と、
PHASE 4 到達後の **OPEN / CLOSING / CLOSED**（JST 判定）を通す。

判定の単一源は `src/lib/premiumPlus/premiumPlusRelease.js`。
仕様・解禁手順・未決定事項は [`PREMIUM_PLUS_STAGED_RELEASE.md`](./PREMIUM_PLUS_STAGED_RELEASE.md) を参照。

販売対象は 2 つの入口を持つ（2026-07-29〜）:
**ROUTE A** = Premium Sanrenpuku 購入者 / **ROUTE B** = 通常 Premium 会員で加入 30 日以上・三連複未購入。
どちらも自動では販売可にならず、**管理者が会員ごとに手動選別**する
（`PremiumPlusEligibility` = 販売可 / 保留 / 販売対象外。新規候補は必ず「保留」から）。
管理画面: `/admin/premium-plus-eligibility`

> ⚠️ **Airtable に Premium Plus 用フィールドが未作成のため、現状は全会員が PHASE 1（商品ページ 404）**。
> 有効化には `SanrenpukuPaidAt` / `PremiumPlusEligibility` 系 6 フィールドの作成（schema 変更）と
> env `PREMIUM_PLUS_FIELDS_READY=1` が必要。どちらも未実行。

## 🕟 16:30 以降は「翌日分」を売る（2026-08-13〜）

以前は 16:30 を過ぎると「本日分の受付は終了しました」で**購入できなかった**。
商品は毎日あるのに、締切後に来た人を翌日まで待たせて購入意欲を捨てていた。
いまは**対象日が翌日へ切り替わるだけ**で、買えない時間帯は無い。

```
00:00〜16:29 JST → 本日分を販売
16:30〜23:59 JST → 翌日分を販売
```

16:30 は既存の受付締切（`PP_INTAKE_SCHEDULE.closedFromMin`）と同じ値。
**締切の意味が「売らない」から「翌日分へ切り替わる」に変わっただけ**。

判定の単一源は `src/lib/premiumPlus/premiumPlusSaleDate.js`。
**画面・注文・管理画面はここだけを使う**（それぞれで日付を計算しない）。

### 対象日をどこまで運ぶか

| 場所 | 何を出す |
|---|---|
| 商品ページ | 購入ボタンの**すぐ上**に「8月14日分 Premium Plus」 |
| 注文 | 商品名に対象日を含める（`Premium Plus 8月14日分 (¥68,000)`）|
| 管理者通知メール / お客様控え / 申請履歴 | 上の商品名がそのまま運ばれる |
| 管理画面 | 「いま販売中: 8月14日分 …／ 翌日分 受付中」を常設 |
| CTA 表示 | 「Plus CTA（翌日分受付中）」（旧「（受付時間外）」）|

### ⚠️ 対象日はサーバーが確定させる

フォームを開いたまま 16:30 をまたぐと、画面は「本日分」のつもりでも実際は翌日分。
**クライアントが送った `saleTargetDate` は採用しない**。
`bank-transfer-application` が `resolveSaleTarget(Date.now())` で出し直し、
ズレたらログに残す。これで再送・再読込でも対象日がぶれない。

### 受付状態は 5 つ（CLOSED を購入可に読み替えない）

| 状態 | 時間帯 | 購入 |
|---|---|---|
| `open` / `limited` / `closing` | 00:00〜16:29 | 可（本日分）|
| **`next_day_open`** | 16:30〜23:59 かつ**対象日の開催を確認できた** | 可（翌日分・次の開催日分）|
| `closed` | 16:30〜23:59 かつ**確認できない** | **不可** |

⚠️ `closed` を「購入可」に読み替えてはいけない。
「売らない」と「別の日を売る」は意味が違い、同じ値に押し込むと
fail closed の判定そのものが消える。**専用状態を持つ**。

### 開催は既定で「ある」。例外日だけ次の販売日へ送る

**平日は南関、週末は中央（JRA）**があり、中央・南関とも開催が無い日は
**年 1〜3 日程度**しかない。つまり「開催がある」が既定で「無い」が例外。

そのため開催日を全部数え上げる方式（allow-list）は採らない。
取り込みが遅れただけで販売が止まり、実態に対して代償が大きすぎる。

`src/data/premiumPlusRaceCalendar.json` は **`noRaceDates`（例外リスト）だけ**を持つ。

```json
{ "noRaceDates": ["2026-08-15"], "checkedUntil": "2026-09-30" }
```

- **例外リストが空でも通常販売は続く**（販売の必須条件ではない）
- **確認期限（`checkedUntil`）が切れても販売は止めない**。警告するだけ
- 例外日に当たったときだけ、次の販売可能日へ送る

期限切れは `npm run check:race-calendar`（`check:safety` に組込）と
管理画面の常設表示で警告する。**CI は落とさない**（販売条件ではないため）。

> 公式日程の自動取込は**将来改善**として分離した。年 1〜3 日の例外は
> 手で `noRaceDates` に足せるので、販売開始を止める理由にしない。

### 開催区分（画面・管理画面に出す）

内部の導出規則は 平日 = **南関** / 土日 = **中央**（`circuitForDate`。`circuitForJst` と同じ規則）。

⚠️ **これは曜日から導いた「目安」であって、その日の実際の開催場ではない。**
公式日程を見ているわけではないので、「南関」「中央」と言い切ると開催実態を断定したことになる。
そのため**画面に出すラベルは必ず「基本：南関」/「基本：中央」**とする
（単一源 `CIRCUIT_LABEL`。`premiumPlusSaleDate.test.mjs` が「基本：」の欠落を検知する）。

商品ページの説明文も同様に「**基本：**平日は南関、土日は中央（JRA）。実際の開催場はその日の開催によります。」
と書く（`stagedReleaseGuard.test.mjs` がこの文言を固定している）。

### 対象日は構造化項目として保存する（冪等）

商品名の文字列だけに頼らず、Airtable の **`SaleTargetDate`**（`YYYY-MM-DD`）へ保存する。

**一度確定した対象日は二度と再計算しない。** 未確定の申込
（`PaymentConfirmed=false`）に保存済みの対象日があればそれが正。
再送・再読込・翌日以降の再実行でも動かない（`resolveOrderSaleDate`）。
確定後にカレンダーが変わっても、**客に約束した日は変えない**。

#### schema 追加の手順（本番未実施）

1. Airtable `Customers` に **`SaleTargetDate`（単一行テキスト）** を作成
2. `netlify env:set PREMIUM_PLUS_SALE_DATE_FIELD_READY 1 --context production --force`
3. 再デプロイ

env 未設定のうちは**フィールドを書かない**ので、作成前に反映しても 422 にならない。

#### rollback

`netlify env:unset PREMIUM_PLUS_SALE_DATE_FIELD_READY --context production` → 再デプロイ。
コード変更なしで「保存しない」状態へ戻る。保存済みの値は残るが読むだけなので害は無い。
フィールド自体の削除は不要。

### ⚠️ 商品の届け方（閲覧権の実体）

Premium Plus は**単品購入**で、`planName` を送らないため
`confirm-bank-payment` のプラン昇格経路を**通らない**。
買い目は入金確認後に**MK が手動で届ける**（サイト上に購入者専用の閲覧画面は無い）。
したがって「どの日の買い目を届けるか」は**注文の商品名と管理者通知メール**が保持する。
ここに対象日が入っていることが、翌日分購入者へ当日分を渡さないための担保。

## 変更してはいけない前提

| 前提 | 実装での担保 |
|---|---|
| 単品商品（サブスクではない） | ページに継続課金の表現を置かない。FAQ に明記 |
| **Premium Sanrenpuku 会員にのみ表示**。Premium / Light には存在も知らせない | `AccessControl requiredPlan="Premium Sanrenpuku"` + `<meta name="robots" content="noindex, nofollow">` + `public/robots.txt` の `Disallow: /premium-plus/` + CTA は三連複ページのみ |
| 超精密 AI が厳選 1 鞍を提供 | コピーの中核。レース数を増やす訴求はしない |
| 価格 ¥98,000 → ¥68,000 | `premium-plus.astro` 冒頭の `PRICE` / `LIST_PRICE` |

**CTA (`PremiumPlusCta.astro`) を Premium / Light / 無料ページに置いてはいけない。**
置いてよいのは Premium Sanrenpuku 会員だけが到達するページに限る。

## 毎日の画像更新（1 日 1 枚）

画像は **Netlify Blobs** に保存する。git に置かないため **ビルド不要・数秒で本番反映**される。

### 方法 A: 管理画面

<https://analytics.keiba.link/admin/premium-plus-images>

1. 管理者シークレット（`PREMIUM_PLUS_ADMIN_SECRET`）を一度入力（ブラウザに保存される）
2. 投票内容照会のスクショをドラッグ＆ドロップ（ペーストも可）
3. 開催日 / 会場 / レース番号 / 投票金額 / 的中・不的中 / 払戻額 を入力
4. 「アップロードして本番反映」→ 数秒で `/premium-plus/` と `/premium-sanrenpuku/` に反映

### 方法 B: ターミナル

```bash
cd astro-site
export PREMIUM_PLUS_ADMIN_SECRET='...'   # Netlify に設定した値

# 的中した日
npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
  --date 2026-07-15 --venue 川崎 --race 6 --stake 16000 --payout 277000

# 不的中だった日（--miss。払戻は不要）
npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
  --date 2026-07-16 --venue 大井 --race 11 --stake 16000 --miss

# 削除（同じ日付で再アップロードすれば上書きなので通常は不要）
npm run upload:premium-plus -- --delete 2026-07-15
```

同じ日付を再アップロードすると**後勝ちで上書き**される（1 日 1 鞍のため）。

## 🚨 不的中の日も必ずアップロードする

**的中した日だけを上げると、的中率が「100%」になり数値そのものが信用されなくなる。**

刷新前（2026-03-02〜04-10）に保存されていた 30 枚は的中日のみで、不的中の日の控えが存在しない。
そのため seed 分は `legacy: true` を立て、**的中率・回収率の母数から除外**している
（最高払戻・的中時平均払戻にだけ寄与する）。

的中率タイルは、legacy を除いたサンプルが **10 鞍**たまるまで自動的に非表示のまま。
不的中を含めて毎日上げていれば、10 鞍目で自動的に公開される。

## 実績数値は手書き禁止

ページに出る数値は **`src/lib/premiumPlusShowcase.js` の `computeStats()` の戻り値だけ**。
`.astro` に数値を直接書かないこと。

旧版は「的中率78% / 平均配当¥281,340 / 最高配当¥973,500 / 期待リターン265% /
Premium会員の52%が利用 / 満足度4.9 / 継続率94%」を**手書き固定値**で持っており、
根拠が示せないうえ画像の更新も 3 ヶ月止まっていた。同じ事故を構造的に防ぐための設計。

| 数値 | 母数 |
|---|---|
| 的中率 / 回収率 | legacy を除く直近 30 鞍（10 鞍未満なら非表示） |
| 最高払戻 / 的中時平均払戻 | legacy を含む全的中エントリ |

## セットアップ（初回のみ）

```bash
# 1. 管理者シークレットを本番に設定
netlify env:set PREMIUM_PLUS_ADMIN_SECRET '<ランダムな長い文字列>' --context production --force

# 2. 再デプロイ（env は Function に再デプロイで反映される）
curl -X POST -d '{}' '<Netlify Build Hook URL>'

# 3. 過去 30 枚を Blobs へ流し込む（1 回だけ）
cd astro-site
export PREMIUM_PLUS_ADMIN_SECRET='<上と同じ値>'
npm run seed:premium-plus -- --dry-run   # 確認
npm run seed:premium-plus                # 実行
```

**シークレットの値そのものを CLAUDE.md / commit / ログに書かないこと。**

## インシデント記録: 2026-07-24 `/premium-plus/` 本番 500 → rollback で復旧

> PR #157 から**恒久的に有効な事実だけ**を抜き出して再構成した（2026-08-08）。
> 当時の「残リスク」節は `origin/main` が壊れた版だった前提のもので、
> 既に解消しているため持ち込まない。

**要約**: `954880b` の deploy 後に `/premium-plus/` が SSR 500。
修復コミット `365e184` を push しても**解消せず**、
deploy `6a62eadd`（`99d7b15`）への **rollback（Netlify restore）で復旧**した。

| 項目 | 内容 |
|---|---|
| 影響範囲 | **`/premium-plus/` に限局**（`/`・`/dashboard`・`/pricing`・`/login` は 200。redirect loop なし）|
| 500 を確認した deploy | `954880b` / `365e184` の**両 artifact とも permalink で 500 再現** = 本番エッジキャッシュ問題ではない |
| 復旧手段 | Netlify restore で `6a62eadd`（`99d7b15`）を再公開（2026-07-24T05:20:19Z）|
| 復旧確認 | 未認証 `/premium-plus/` = **404** を 3 回連続確認 |
| production env 変更 / data write | **0 / 0** |

### 恒久的に有効な教訓

1. **500 応答に `X-PP-Template-Version` ヘッダが無い = render フェーズの throw。**
   frontmatter で set したヘッダが破棄されているかどうかが、
   frontmatter で落ちたのか render で落ちたのかの切り分けになる。
2. **deploy permalink で artifact 単体を叩けば、エッジキャッシュ問題と切り分けられる。**
   復旧を急ぐ前にこれを取ると、rollback 先の判断が確実になる。
3. ⚠️ **テストが本番 SSR artifact の drift を捕捉できない。**
   当時 build OK・`test:premium-plus` 14 件・`test:premium-plus-media` 99 件が pass していたのに
   本番 artifact は 500 だった。**ローカル green は本番 SSR の健全性を保証しない。**
   SSR ページを触ったら deploy 後に実 URL を叩いて確認する。
4. **root cause は未確定のまま。** 「page 新版 × lib 旧版の混在」はコード証拠のみの仮説で、
   exception stack trace（本番 500 は body 空）は取得できていない。
   Netlify build-cache の module drift だと**断定はしていない**。

## 📏 実閲覧の計測（「表示判定」と「実閲覧」は別物 / 2026-08-13〜）

管理画面の販売一覧には **意味の違う 2 列**がある。混同すると
「見えているはず」を「見た」と読み違え、販売判断を誤る。

| 列 | 何を表すか | 出どころ |
|---|---|---|
| **表示判定** | 設定と条件から導いた「この人には出るはず」 | `resolveUpsellForCustomer`（判定） |
| **実閲覧** | 実際に届いた記録（CTA 表示 / クリック / 商品ページ到達） | Redis `ak:pp:funnel:v1`（実測） |

### 記録するもの・しないもの

| 何 | どこで記録するか |
|---|---|
| CTA 表示 | ブラウザ。**画面に入ったときだけ**（IntersectionObserver）。DOM に足しただけでは数えない |
| CTA クリック | ブラウザ（`keepalive` で送るので遷移で消えない） |
| 商品ページ到達 | **SSR で直接**。JS 無効・広告ブロック・即離脱でも落ちない |

- 記録するのは **`ak_session` から解決した recordId だけ**。アドレスも氏名も保存しない。
  クライアントが送った id は**一切使わない**（イベント名しか送らない）。
- **Airtable へは 1 バイトも書かない。**
- 同じ種別は **30 分（`DEDUPE_MS`）に 1 回**しか数えない（再描画・戻る操作で増やさない）。
- bot / UA なしは数えない。

### ⚠️ 除外してよいのは「管理者プレビュー」だけ

判定は `premiumPlusFunnelServer.isAdminPreviewRequest`（**明示された印だけ**を見る）。
次はすべて**除外してはいけない**。やると通常の顧客閲覧まで消えて「見ていない」に化ける。

- 運営者本人の recordId（例: 0510apolone）だから除外 → **誤り**。本人が顧客として見たら計上する
- 管理画面から遷移した（Referer が `/admin`）から除外 → **誤り**
- 管理シークレットが付いているから除外 → **誤り**

固定テスト: `src/lib/premiumPlus/premiumPlusFunnelExclusion.test.mjs`

### ⚠️ 記録が無いことを「0 回」と書かない

記録が無い理由は「本当に見ていない」だけではない。
**計測開始より前だった / Redis を読めない**も同じく記録が無い。どれも**確認不能**。

- 画面表示は必ず **「未確認」**。`0 回` `見ていない` と書かないこと
- 計測開始時刻（`started_at`）を常設で出し、**それ以前は記録が存在せず確認できない**と明記する
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 未設定なら全員「未確認」（0 ではない）

### 個別検索（氏名・アドレスの一部）

一覧は販売候補だけに絞っているので候補外の人は出ない。
`action='lookup'` は **氏名の一部・アドレスの一部**で引ける（例: `Daniel` / `0510apolone` / `tori`）。
式の組み立ては `premiumPlusAdminSearch.js` が単一源。一致が多すぎるときは
**一部を返さず 400（`search_too_broad`）**で絞り込みを促す（先頭 N 件を「これで全部」と
読ませない）。検索結果にも実閲覧を載せる。

### 運用 UI（2026-08-13〜 / 計測が本番稼働したあと）

計測は本番稼働し、E2E で 表示 / クリック / 商品ページ到達の 3 種別とも記録されることを
確認済み。ここから先は**運用**の話になるので、管理画面に次を出す。

| 何 | どこ |
|---|---|
| 種別ごとの **回数・初回・最終**（JST） | 一覧「実閲覧」列 / 詳細パネル |
| **段階**（表示済み未クリック / クリック済み未到達 / 到達済み / 未確認）| 同上 + 絞り込み |
| **反応が新しい順**の並べ替え | 並び替えセレクト |
| **表示 → クリック → 到達**の人数と転換率 | 一覧上部の転換バー |
| **新規反応**（前回この画面を見たあとの反応）| 実閲覧列のバッジ |
| **最終更新時刻**と自動更新の状態 | 転換バーの下 |

判定の単一源は `src/lib/premiumPlus/premiumPlusFunnelAnalytics.js`。
**画面で段階や率を組み立て直さない**（サーバーも同じ関数を使う）。

#### 段階は「到達した最も先」で決める

`reached` > `clicked_not_reached` > `viewed_not_clicked` > `unknown`。

⚠️ **表示記録が無くてもクリックがあれば「押した」を優先**する。
表示は IntersectionObserver 由来で落ちることがあり、そこで `unknown` に倒すと
「押したのに未確認」という誤表示になる。

#### 転換率は分母が確定しないとき出さない

`0%` と書くと「誰も押していない」と読まれるが、実際は「まだ分からない」。
分母 0 のときサーバーは `null` を返し、画面は **「未確定」**と出す。

#### 新規反応の基準はブラウザだけが持つ

前回この画面を見た時刻を `sessionStorage` に置くだけ。**サーバーにも Redis にも保存しない**
（状態も個人情報も増やさない）。基準が無い初回は**誰も新規にしない**（全員に付けると意味が消える）。
既読になるのは**手動の「再読み込み」だけ**で、自動更新では既読にしない
（見ていない間に入った反応を消さないため）。

#### CTA の導線（クリック元）を区別する（2026-08-13〜）

同じ Premium Plus の CTA でも、**どのサーフェスで押されたか**で意味が違う。

| source | どこ | 種類 |
|---|---|---|
| `dashboard` | ダッシュボードの「会員限定のご案内を見る」 | 流入 |
| `sanrenpuku` | 三連複会員ページの Premium Plus 案内枠 | 流入 |
| `plus_page` | Premium Plus 商品ページ内の購入ボタン（価格ブロック / 1 鞍の抽出） | 商品ページ内 |

表示 / クリック / 商品ページ到達の**すべて**を導線別に記録し、
管理画面は**合計に加えて導線別の回数・初回・最終**を出す（一覧・詳細・上部の転換率）。

##### ⚠️ 導線には性質の違う 2 種類がある（混ぜて並べない）

| 種類 | 意味 | 「到達」 |
|---|---|---|
| `entry`（流入） | 商品ページ**へ送る**導線 | 出す。表示 → クリック → 到達が繋がる |
| `on_page`（商品ページ内） | 商品ページ**の中**の導線 | **出さない**。到達はこの導線より上流 |

商品ページ内の導線に到達を数えると、必ず 0 になり
**「誰も到達しなかった」と読めてしまう**。0 名ではなく**指標が存在しない**ので、
`reached` / `clickToReach` は `null`（未確定）にして理由を添える
（単一源 `ON_PAGE_REACH_NOTE`）。画面は「到達 —」と出し、**0 と書かない**。

種類は `FUNNEL_SOURCE_KIND_OF` が単一源。画面は `kindLabel` をそのまま出すので、
導線を増やしても管理画面をベタ書きで直す必要はない。

##### 保存の形（後方互換）

既存の合計はそのまま。**同じ JSON に足すだけ**にする。Redis のキーは増やさない。

```json
{ "firstAt": …, "lastAt": …, "count": 1,
  "sv": 1, "legacy": 0,
  "bySource": { "dashboard": {…}, "sanrenpuku": {…} },
  "noSource": { "firstAt": …, "lastAt": …, "count": 1 } }
```

| 鍵 | 意味 |
|---|---|
| `count` | **合計**。全導線共通の 30 分窓で数えた回数（**意味を変えない**）|
| `sv` | 導線別集計のスキーマ版。**無い値は導線別計測より前** |
| `bySource` | 導線ごとの回数・初回・最終（**導線ごとの 30 分窓**）|
| `noSource` | 計測開始後に source なしで届いた分 |
| `legacy` | 計測開始前にあった回数（初回の source 付き書込み時に固定）|

##### ⚠️ 重複除外は「イベント種別 × source」単位

**全導線共通で除外してはいけない。** dashboard を押した 10 分後の sanrenpuku
クリックが丸ごと消える。同じ導線の 30 分以内の再クリックだけを落とす。

合計（`count`）は従来どおり全導線共通の窓のままにする（互換維持）。

##### ⚠️ 導線別の和が合計を超えることがある（正常）

例: dashboard クリックの 10 分後に sanrenpuku をクリック
→ **合計 1 / dashboard 1 / sanrenpuku 1**（和 2 > 合計 1）

数え方が違うだけで、どちらも正しい値。**管理画面にもその旨を常設で書く**
（`SOURCE_TOTAL_NOTE`）。食い違いを不具合と誤解させない。

##### ⚠️ 不明を「合計 − 内訳の和」で出さない

上のとおり和が合計を超えるので、**引き算すると負になる**。
不明は次の 2 つを**別々に明示**する。

| 種別 | 何 |
|---|---|
| `legacy`（クリック元不明・計測前）| 導線別計測より前の記録 |
| `noSource`（クリック元なし）| 計測開始後に source なしで届いた記録 |

##### ⚠️ 過去データを書き換えない

**導線別の計測を始める前に記録された分は legacy のまま置く。**
人間が「あれはダッシュボード経由だった」と知っていても、データは書き換えない。
`0510apolone` の既存クリックがこれに当たる。
`sv` が既にある値の `legacy` にも触れない。

##### source は必ずサーバーで検証する

- 固定 allow-list（`normalizeFunnelSource`）を通し、**該当しない値は `null`**
  （= 導線の指定なし。合計にだけ数える）
- クライアントが送ってきた任意の文字列は**保存しない**。
  クライアント側では採否を判断しない（信用しない）
- 商品ページ到達は `?from=dashboard` / `?from=sanrenpuku` を
  `readPlusSourceFromUrl` が allow-list 経由で読む
- ⚠️ **`?from=` が受けるのは流入導線だけ**（`normalizeEntrySource`）。
  `?from=plus_page` は採用しない。商品ページ内の導線は「ここへ来た経路」ではなく、
  URL は誰でも付けられるため、通すと到達の内訳が汚れる
- 商品ページ内のクリックは URL ではなく**ページ内の計測**（`cta_click` + `source: 'plus_page'`）
  で数える。送信の判断は `premiumPlusFunnelClient.js` の 1 か所だけが持つ

#### 自動更新の条件（`AUTO_REFRESH_MS = 90000`）

次のすべてを満たすときだけ動く。**間隔を短くしない。**

- このタブが表示中（背景タブで叩き続けない）
- 詳細・操作パネルを開いていない（操作中に足元を変えない）
- 管理シークレットが入力済み（無駄な 403 を作らない）
- 前回の自動更新が終わっている（重ねない）

自動更新は画面のメッセージを**上書きしない**（`call(payload, { quiet: true })`）。
管理者の操作結果が自動更新に消されるのを防ぐ。

### 決済まで計測する（2026-08-13〜）

段階は **表示 → クリック → 商品ページ到達 → 決済開始 → 購入完了** の 5 つ。

| 段階 | 記録する場所 | 性質 |
|---|---|---|
| 表示 / クリック | ブラウザ → `/api/pp-funnel.json` | クライアント発火・サーバー検証 |
| 商品ページ到達 | 商品ページ SSR | サーバー |
| **決済開始** | `bank-transfer-application` | **サーバー**。申込が Function へ到達した時点 |
| **購入完了** | `confirm-bank-payment` | **サーバー側の確定イベントのみ** |

#### ⚠️ 購入完了は「確定」でしか記録しない

記録するのは、`PaymentConfirmed=true` を Airtable から**再読込して検証**し、
昇格 PATCH が**成功した後**だけ。**画面の成功表示では記録しない**
（客が見た画面は確定ではない）。記録 API（クライアント経路）は
`purchase` / `checkout_start` を**受け付けない**。

#### ⚠️ 二重計上を潰す

| 経路 | 対策 |
|---|---|
| Webhook 再送 / Automation 再実行 | **`orderKey` につき 1 回**。記録済みなら何も書かない |
| `orderKey` が無い | **recordId につき 1 回**（単品購入のため） |
| 申込フォームの再送信・再読込 | 既存と同じ 30 分・種別 × source の重複除外 |

`orderKey` は確定内容から作る（`recordId:プラン:PaidAt`）。
**現在時刻や乱数を使わない**（毎回違う鍵になり二重計上する）。

計測が失敗しても**昇格・決済は巻き戻さない**（決済成功を最優先で保持する）。

#### ⚠️ 購入の導線は推測しない

購入時点でサーバーは導線を知らないので、**決済開始で記録した source を引き継ぐ**。

| 決済開始の導線 | 購入の帰属 |
|---|---|
| 1 つだけ | その導線 |
| 2 つ以上 | **`ambiguous`（導線を特定できず）**。どちらへも寄せない |
| 無い | `noSource` |

#### 期間集計（今日 / 7 日 / 30 日）

`ak:pp:funnel:v1:daily` HASH、フィールド `YYYYMMDD|event|source`。

- **recordId を含まない**（集計値のみ・PII なし）
- 書込み時に `HINCRBY`、読取りは `HGETALL` 1 回
- 保持は 91 日。書込み時に古いフィールドを 1 つ `HDEL`（自己クリーンアップ）
- **日次カウンタは補助**。ここが失敗しても本体の記録は巻き戻さない
- ⚠️ 期間集計は**件数**、転換バーは**人数**。単位が違うので画面に明記する

#### 抽出

「クリック済み未購入」「到達済み未購入」を出す。
**購入を確認できない人（読み取り失敗）はどちらにも入れない**（別に数える）。

### 関連ファイル（計測）

| 目的 | ファイル |
|---|---|
| 集計（純粋・I/O 注入） | `src/lib/premiumPlus/premiumPlusFunnelStore.js` |
| Redis 接続 / SSR 記録 / プレビュー判定 | `src/lib/premiumPlus/premiumPlusFunnelServer.js` |
| ブラウザ側の配線（キュー方式・単一源） | `src/lib/premiumPlus/premiumPlusFunnelClient.js` |
| 記録 API（POST のみ・存在秘匿 404） | `src/pages/api/pp-funnel.json.js` |
| 個別検索の式 | `src/lib/premiumPlus/premiumPlusAdminSearch.js` |
| **段階・並び順・転換率（純粋）** | `src/lib/premiumPlus/premiumPlusFunnelAnalytics.js` |
| **決済開始・購入完了の記録** | `src/lib/premiumPlus/premiumPlusFunnelServer.js`（`recordPlusCheckoutStart` / `recordPlusPurchase`）|
| 購入の確定点 | `netlify/functions/confirm-bank-payment.js` |
| 決済開始の記録点 | `netlify/functions/bank-transfer-application.js` |
| テスト | `src/lib/premiumPlus/premiumPlusFunnel*.test.mjs`（`npm run test:premium-plus-media` / `check:safety` に組込済み） |

## 📣 案内済みかどうか（「販売可」と「届いた」は別 / 2026-08-13〜）

**2026-08-13 実測: `premium-plus-offer` の配信は本番全体で 0 件だった。**
販売可にして CTA を出していた会員に、こちらからは**一度も案内を送っていなかった**。
CTA は「ログインして該当ページを開けば見える」ものなので、案内が 0 通なら
その人が Premium Plus に気づく経路は事実上ない。それでも管理画面には
「販売可」「CTA 表示中」と出ていたため、**売れる状態に見えて誰にも届いていない**状態が続いていた。

一覧の 3 列は**すべて別の軸**で、1 つでも欠けると判断を誤る。

| 列 | 何を表すか | 出どころ |
|---|---|---|
| **表示判定** | 設定と条件から導いた「この人には出るはず」 | `resolveUpsellForCustomer`（判定） |
| **実閲覧** | 本人が画面で見た実測 | Redis `ak:pp:funnel:v1` |
| **案内** | **こちらから送った実績** | Airtable `CampaignDeliveries` |

### 4 つの状態

| 状態 | 意味 | 要対応 |
|---|---|---|
| **案内済み** | `Status='sent'` が 1 通以上ある | — |
| **未着（送信失敗）** | 送信を試みたが `failed` のみ。本人には届いていない | ✅ |
| **未案内** | 履歴を読めたうえで 1 通も無い | ✅（`channel=plus` のときだけ） |
| **未確認** | 配信履歴を**読み取れなかった** | — |

**「要対応」バッジは `upsellChannel === 'plus'` のときだけ付ける。**
三連複を売る相手・売らない相手に Plus の案内が無いのは正常なので、要対応にしない。

### ⚠️ 迷ったら「未確認」に倒す（両方向に事故がある）

| 誤表示 | 起きること |
|---|---|
| 送っていないのに **案内済み** | 運用者が動かない。その会員は**永久に案内されない**（最悪） |
| 送ったのに **未案内** | 二重送信を誘発する |

読み取れないときは**どちらでもない「未確認」**にする。**`0 通` と書かない。**

- `queued`（送信待ち）と `cancelled` は「送った」に数えない
- `failed` しか無いときは**案内済みにしない**（届いていないため）
- `CampaignType` は **前方一致**（`premium-plus-offer:`）で引く。版を上げても
  過去に送った相手が「未案内」に戻らないようにする

### 取得は名指しのみ（全件走査を作らない）

`CampaignDeliveries` は 14,000 行超で、全件走査は Function の実行時間で終わらない。

- 対象は **recordId（`CustomerRecordId`）とアドレス（`RecipientEmail`）の OR** で名指しする。
  `CustomerRecordId` は後から入った列で古い行には無いことがあり、**片方だけで引くと
  送ったのに「未案内」**と出る
- 取り切れなければ `assertFetchComplete` が投げ、**全員「未確認」**へ倒す
  （短い結果を「送っていない」と読ませない）

### 関連ファイル（案内）

| 目的 | ファイル |
|---|---|
| 判定の単一源（純粋・I/O なし） | `src/lib/premiumPlus/plusNotifiedStatus.js` |
| 取得と配線 | `netlify/functions/premium-plus-eligibility.js`（`attachPlusNotified`） |
| 画面 | `src/pages/admin/premium-plus-eligibility.astro`（`notifiedCell` / `renderNotifyNote`） |
| キャンペーン正本 | `src/lib/marketing/campaignCatalog.js`（`campaignId: 'premium-plus-offer'`） |
| テスト | `plusNotifiedStatus.test.mjs` / `plusNotifiedWiring.guard.test.mjs`（`check:safety` に組込済み） |

## 🧑‍💼 管理画面の日常業務（`/admin/premium-plus-eligibility/` / 2026-08-13 検証）

管理者が最後まで遂行できるべき導線と、その安全条件。

```
検索 → 個別状態確認 → 資格変更 → 正本への保存 → 再読込確認 → 変更履歴 → 失敗時の再処理
```

### 操作の前に

- **操作者名を入力する**（接続パネル）。未入力だと**書き込みボタンを押せない**。
  入れずに書けていた頃は変更履歴が全部 `admin` になり、誰の操作か追えなかった。

### 検索でしか出てこない人がいる

一覧は**販売候補**だけを出す。無料会員などは候補集合の外なので、
**検索でしか出てこない**（区分列に「検索のみ（候補外）」と出る）。

⚠️ その人を操作したあと一覧を取り直すと、素朴な実装では**行ごと消えて詳細が壊れる**
（本番データで再現: 無料会員の Daniel）。`searchedRows` で保持しているので消さないこと。

### 保存の確認は「読み直し」でやる

保存後は `action='lookup'`（**recordId 指定**）で 1 件だけ読み直し、
**Airtable の値**で確認する。送った値が通った前提にしない。
アドレスではなく recordId で引くのは、**Email 未設定の会員**でも確認できるようにするため。

### 失敗の 3 値を混ぜない

| 結果 | 意味 | 画面 |
|---|---|---|
| 成功 | サーバーが成功を返した | 「保存を確認済み」 |
| 失敗 | サーバーが失敗を返した（**書かれていない**）| そのまま再操作してよい |
| **不明** | 通信が切れた（**書かれたか分からない**）| 上部に警告を出し続け、「再読込して確認」を促す |

⚠️ **不明を失敗に丸めない。** 丸めると、実際は保存済みなのに同じ操作を繰り返す。

### 同時編集

画面は「見ていた時点の最終更新」を `expectedUpdatedAt` として送る。
別の管理者が先に変えていれば **409 `stale_record`** で止まる（黙って上書きしない）。
`expectedUpdatedAt` を送らない呼び出しは従来どおり通す（後方互換）。

### 変更履歴の見え方（正本 と このタブ は別物）

| 種類 | 内容 | 寿命 |
|---|---|---|
| **正本** | `PremiumPlusEligibilityUpdatedAt` / `UpdatedBy` / `Reason` | Airtable に恒久。ただし**最後の 1 回だけ** |
| このタブの操作履歴 | 前後・結果（成功/失敗/不明）・操作者 | `sessionStorage`。**タブを閉じると消える** |

**このタブの履歴を監査記録として扱わないこと。**

### ⛔ 未対応（本番スキーマ変更が要るため停止）

- **恒久的な変更履歴台帳**（何度でも遡れる履歴）。Airtable に履歴テーブル/列が無い。
  PAT に `schema.bases:write` が無いので**フィールド追加は Airtable 画面で手動**
- **販売CTA（UpsellTarget）の競合検知**。更新時刻の列が無く版を作れない
- **操作者名のサーバー側必須化**。現在は画面側で必須。API 直叩きは `admin` のまま残る

検証: `npm run test:premium-plus-media`（`check:safety` に組込済み）。
導線の固定は `src/lib/premiumPlus/adminOperationsFlow.guard.test.mjs`。

## 関連ファイル

| 目的 | ファイル |
|---|---|
| 集計ロジック（単一源・純粋） | `src/lib/premiumPlusShowcase.js` |
| 管理画面の操作履歴（純粋・保存先注入） | `src/lib/premiumPlus/adminOperationLog.js` |
| 業務導線の固定（guard） | `src/lib/premiumPlus/adminOperationsFlow.guard.test.mjs` |
| テスト | `src/lib/premiumPlusShowcase.test.mjs`（`npm run test:premium-plus` / `check:safety` に組込済み） |
| 画像 API（Blobs） | `netlify/functions/premium-plus-media.js` |
| 商品ページ | `src/pages/premium-plus.astro` |
| 三連複ページの CTA | `src/components/PremiumPlusCta.astro` → `src/pages/premium-sanrenpuku.astro` |
| 管理画面 | `src/pages/admin/premium-plus-images.astro` |
| アップロード CLI | `scripts/uploadPremiumPlusImage.mjs` |
| 過去分の流し込み | `scripts/seedPremiumPlusLegacy.mjs` + `scripts/data/premium-plus-legacy.json` |

## 旧実装（参考・復活させないこと）

- `public/upsell-images/upsell-YYYYMMDD.png` をページに**ハードコード**し、
  `scripts/update-premium-plus-images.sh` が sed で書き換える方式だった（削除済み）。
  更新が止まると古い日付が本番に残り続けるため、Blobs 方式へ移行した。
- `public/upsell-images/` 自体は `withdrawal-upsell.astro` がまだ参照しているため**残す**。
  `scripts/update-all-images.sh` は withdrawal-upsell 専用に縮小済み。

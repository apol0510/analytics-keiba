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

### 関連ファイル（計測）

| 目的 | ファイル |
|---|---|
| 集計（純粋・I/O 注入） | `src/lib/premiumPlus/premiumPlusFunnelStore.js` |
| Redis 接続 / SSR 記録 / プレビュー判定 | `src/lib/premiumPlus/premiumPlusFunnelServer.js` |
| ブラウザ側の配線（キュー方式・単一源） | `src/lib/premiumPlus/premiumPlusFunnelClient.js` |
| 記録 API（POST のみ・存在秘匿 404） | `src/pages/api/pp-funnel.json.js` |
| 個別検索の式 | `src/lib/premiumPlus/premiumPlusAdminSearch.js` |
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

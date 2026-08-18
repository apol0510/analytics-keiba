# Premium Plus 販売対象と段階公開（ROUTE A / B × 販売資格 × PHASE 1〜4）

`/premium-plus-v2/`（商品ページ）への導線を、**販売してよいと管理者が判断した会員に対してだけ、
時間差で開いていく**方式。購入直後に ¥68,000 の購入 CTA を見せない。

> 対象範囲: Premium Plus 導線のみ。JRA / NANKAN の**無料版**予想ページには一切置かない
> （Premium Plus の存在を無料会員に知らせないため）。有料 4 ページ
> （premium-sanrenpuku / premium-sanrenpuku-jra / premium-prediction/nankan / premium-prediction/jra）
> には予告スロットのみを対称に設置している。予想表示ロジックには触れていない。

## 全体像

```
                    Premium会員
                         │
              ┌──────────┴──────────┐
     Sanrenpuku購入済         Sanrenpuku未購入
              │                     │
     SanrenpukuPaidAt        Premium加入30日未満 → 対象外
              │                     │
          ROUTE A              30日以上 → ROUTE B
              └──────────┬──────────┘
                         │
              PremiumPlusEligibility
         （新規候補は必ず review = 保留）
                         │
        ┌────────────────┼────────────────┐
    eligible          review           blocked
        │             CTAなし          CTAなし
   段階公開 PHASE 1〜4
        │
  OPEN / CLOSING / CLOSED
        │
   purchaseEnabled
```

## 判定の単一源

| 層 | ファイル | 役割 |
|---|---|---|
| 判定（純粋・import ゼロ） | `src/lib/premiumPlus/premiumPlusRelease.js` | route / 販売資格 / anchor / phase / 受付ステータス |
| 会員状態アダプタ（純粋） | `src/lib/premiumPlus/premiumPlusMember.js` | Airtable fields → 判定入力。**会員判定は既存正本 `entitlements/resolveEntitlements.js` を再利用** |
| 書き込みフィールド（純粋） | `src/lib/premiumPlus/premiumPlusEligibility.js` | confirm / 管理画面が書く Plus 専用フィールドの組み立て |
| 取得（唯一の I/O） | `src/lib/premiumPlus/purchaseAnchorLookup.js` | Customers を GET するだけ（書き込みなし） |
| 管理者プレビュー（純粋） | `src/lib/premiumPlus/premiumPlusPreview.js` | 単一源の結果を read-only で整形。時刻 / PHASE シミュレーションを内包 |
| **管理画面の表示条件（純粋）** | `src/lib/premiumPlus/premiumPlusAdminAudience.js` | 管理画面の一覧に**名前を出すか**だけを決める。公開判定とは別（下記） |

**ページ・コンポーネントに日数条件・時刻条件・プラン判定を書かないこと。**

判定の入力は次の 4 つだけ:

1. 会員状態（Sanrenpuku 保有 / 通常 Premium 有効）
2. 購入確定日時（route 固有）＋ 販売許可日
3. 現在日時（JST）
4. 受付時刻（PHASE 4 到達後のみ）

**実績（的中 / 不的中）は入力にしない。** 「当たった日は売る / 外した日は売らない」に見える
連動を構造的に禁止するため、判定モジュールが実績台帳を import していないことを guard テストで固定。

## 判定順序（STEP 1〜7）

1. 会員状態（`resolveEntitlements` の `canViewSanrenpuku` / `canViewPremium`）
2. **route**: Sanrenpuku 保有 → `sanrenpuku` / 通常 Premium 有効 かつ 加入 30 日以上 → `premium_30d` / それ以外 → `none`
3. **販売資格**: `PremiumPlusEligibility` が `eligible` 以外はここで打ち切り
3.5. **販売の一時停止**: `PremiumPlusSalePaused` が true ならここで打ち切り（下記）
4. **anchor**: route 固有の購入確定日時と販売許可日から決める
5. **phase**: anchor からの JST 暦日で 1〜4
6. **受付ステータス**: PHASE 4 のときだけ OPEN / CLOSING / CLOSED
7. **purchaseEnabled**: PHASE 4 かつ CLOSED でない

### ROUTE A / ROUTE B は排他

Sanrenpuku 購入済みになったユーザーには ROUTE B を適用しない（`resolvePlusRoute` が
先に ROUTE A を返す）。ROUTE B 進行中に三連複を買えば ROUTE A へ切り替わり、
両方が同時に立つ構造にはしていない。

## 会員単位の販売 一時停止（`PremiumPlusSalePaused` / 2026-08-17）

「この会員にだけ、いまは Premium Plus を売らない」を **資格とは独立した軸**で持つ。
販売資格（eligible / review / blocked）は**そのまま残る**。

### 既存フィールドで代用できない理由（検討済み・不採用）

| 代用案 | なぜ不可 |
|---|---|
| `PremiumPlusEligibility='blocked'` | ① 意味が違う（blocked は**恒久判断**、停止は一時的）。管理画面で同じに見えると再開すべき相手が埋もれる ② **再開で段階公開がリセット**される。`buildEligibilityUpdateFields` は review/blocked → eligible の実遷移で `PremiumPlusEligibleAt` を now に更新するため、止めて戻すだけで PHASE が Day 0 に戻る |
| `PremiumPlusEligibility='review'` | 同上（意味＝「まだ判断していない」/ anchor リセットも同じ） |
| `PremiumPlusReleaseOverride` に値を追加 | あれは phase 進行を飛ばす override。上書きすると「今すぐ販売可」の設定が消える |
| `UpsellTarget='none'` | **販売導線の選択**（三連複を含む）であって Plus 専用ではない。三連複 CTA まで巻き添えで消える。さらに申込 Function は UpsellTarget を読まないので **URL 直打ちを止められない** |

→ 専用フィールドを 1 本足すのが唯一「恒久的に・混同なく」表現できる形。

### 効果（停止中）

`resolvePremiumPlusRelease` が STEP 3.5 で打ち切り、Plus のフラグが**全部 false** になる。

| 面 | 停止中 |
|---|---|
| dashboard の案内ボタン | 出ない（`/api/upsell.json` の channel が plus にならない） |
| 三連複ページの予告枠 | 出ない（`showTeaser=false` → stage API 404） |
| `/premium-plus/` `/premium-plus-v2/` | **404**（`showProductPage=false`） |
| 価格・購入 CTA | 出ない（`showPurchaseCta=false` / `purchaseEnabled=false`） |
| **申込 API（URL 直打ち・古いタブからの再送）** | **403 `sale_paused`**（`bank-transfer-application.js`。メール送信より前・`sideEffects:'none'`） |

⚠️ 画面側の非表示だけでは**止まらない**（URL 直打ち・コンソール・古いタブが回避できる）。
**申込を止められるのはサーバー側の 403 だけ**なので、この経路を外さないこと。

### 影響しないもの

- **他会員**（判定はその会員の fields / marker からのみ導出）
- **16:30 以降の翌日分販売**（停止していない会員は従来どおり買える）
- **通常の eligibility 判定 / PHASE / anchor**（一切書き換えない）
- **三連複の販売導線**（Plus だけを止める）

### 判定の正本は Airtable フィールドだけ

停止判定は `PremiumPlusSalePaused` を **`resolvePlusMemberFromFields` →
`resolvePremiumPlusRelease` の既存の単一源が読む**。表示 4 経路（dashboard CTA /
三連複ページ予告 / `/premium-plus/` / `/premium-plus-v2/`）はこの結果に従うだけで、
ページ側・API 側に停止判定を書かない。

申込 API だけは別経路（`resolveUpsellForCustomer` を通らない）なので、
`bank-transfer-application.js` が同じフィールドを読んで 403 を返す。
**画面の非表示だけでは URL 直打ちを止められないため、この 403 が唯一の実効的な停止点。**

#### 読めなかったときの扱い

Airtable を読めなかったときは **停止側へ倒さない**。
「読めない＝停止」にすると、Airtable の一時障害だけで**通常会員全員の購入まで止まる**。

- 表示系は元々 fail closed（fields が無いと `channel` が none になり何も売らない）
- 申込 API は「正本が停止と読めたとき」だけ 403。読めなかった窓では停止済み会員を
  捕まえられないが、**通常会員を巻き添えにしないことを優先する**（承認済みの方針）

⚠️ 外部ストア（Redis 等）を使った二重化・2 系統判定は **この正本に含まれない**。
必要になった場合は設計として別途承認を取ること。

### 表示の区別（**資格と停止は別の軸**）

| 状態 | バッジ | `describeReleaseState` |
|---|---|---|
| 販売対象外 | `blocked`（赤） | `販売対象外` |
| 一時停止 | `paused`（琥珀） | `一時停止中（資格は保持）` |

**同じ文言・同じ色にしないこと。** 混ぜると再開すべき相手が恒久的な対象外の中に埋もれる。

#### 資格の軸は「停止を外した状態」で解く（2026-08-18 修正）

停止中は `resolvePremiumPlusRelease` が denied（`phase=LOCKED(1)` / `overrideApplied=false`）を
返す。これを管理一覧の**資格表示**へそのまま流すと、保存値が変わっていないのに

- 資格バッジが「即時販売」→「PHASE 1」に化ける
- 「即時販売」の件数が減る（`rows.filter(r => r.overrideApplied)`）

（2026-08-18 に本番で実際に発生。3 → 2 に減った。）

**単一源**: `src/lib/premiumPlus/premiumPlusAdminEligibilityAxis.js`。
停止中の会員だけ**停止フラグを外して同じ resolver を解き直し**、その
`phase` / `overrideApplied` を資格表示に使う。判定を書き写さないので、
停止していない会員との差が構造的に生まれない。

⚠️ **資格の軸は管理画面の資格表示専用。** 顧客向け（`upsellChannel` / `state` /
`showProductPage` / 申込 403）は**停止を反映した release が正本**で、そちらへ流用しない
（流用すると「資格を直したら売れてしまう」最悪の回帰になる。guard テストで固定）。

⚠️ **`classify()` に停止を混ぜてはいけない。** 一度これをやって次の 3 つを同時に壊した:

1. 停止中の会員が「販売可 / 保留 / 販売対象外」の**どのフィルタにも出てこない**
   （状態キーが `paused` に化けるため）
2. サマリー件数はサーバーが `eligibility` で数えるので、**件数と表示行が食い違う**
3. 状態バッジが上書きされ、**その会員が eligible なのか blocked なのか読めない**

正しい形:

- `classify()` は**資格の軸だけ**を返す（従来どおり）
- 停止は `pauseBadge()` が**別バッジとして添える**（資格バッジは残す）
- 絞り込みは `fPause`（停止中だけ / 停止していないものだけ）で**独立して**行う
- 件数は `counts.salePaused` を**別に**出す（`eligible` / `immediate` から差し引かない。
  停止中でも資格は「販売可」のままが正しいため）

### 本番で使えないときは admin に明示する

`salePause.writable`（= Airtable フィールドの gate）が false のとき、
一覧の先頭に**未有効の告知**を常設し、停止ボタンを無効化する。

**「ボタンがあるから使える」と誤認させないこと。** 有効化の手順（フィールド作成 / env）を
✅❌ 付きで出し、いま何が欠けているかをその場で読めるようにする。
応答に `salePause` が無い（旧デプロイ）ときも**使える扱いにしない**。

### 操作（管理画面 → 詳細パネル「販売の一時停止」）

1 クリックで `販売中 ⇔ 一時停止` を切り替える。再開も**同じ場所の同じボタン**。
API は `action='setSalePause'`（`{ recordId, paused, reason?, actor, expectedPausedAt? }`）。

- 操作者名が未入力なら押せない（変更履歴が `admin` に潰れるのを防ぐ）
- 停止時のみ確認ダイアログ＋理由入力（任意）。再開は確認なしで即戻せる
- 保存後は `refreshOne`（recordId 指定）で **Airtable から読み直して**確認する
- 同時編集は `expectedPausedAt` で検知（**停止側の版**。資格の UpdatedAt とは別軸）
- 既に同じ状態なら PATCH しない（`changed:false`。監査日時を無駄に動かさない）

### rollback

1. **運用での取り消し**: 同じボタンで「販売を再開」→ 元の PHASE・資格がそのまま戻る
2. **機能ごと止める**: `PREMIUM_PLUS_SALE_PAUSE_READY` を unset → 停止操作は 503 で受け付けなくなる
   （既にチェック済みのレコードは**停止したまま**なので、先に画面から再開しておくこと）
3. **コードごと戻す**: `git revert`。フィールドが残っていても読み手が消えるだけで、
   未設定＝停止していない扱いに戻る

## 販売資格 PremiumPlusEligibility

| 内部値 | 管理画面表示 | 意味 |
|---|---|---|
| `eligible` | **販売可** | 段階公開・受付判定へ進める |
| `review` | **保留** | 管理者確認待ち。購入 CTA を出さない（**新規候補の初期値**） |
| `blocked` | **販売対象外** | 何日経過しても購入 CTA を出さない |

- **自動で eligible にしない。** 30 日到達も三連複購入も「候補になる」だけ。
- 未設定 / 不正値 / 読取失敗はすべて **review 相当**（fail closed）。`blocked` へ自動で倒さないのは、
  blocked が「管理者が明示的に付けた印」だから。
- 「ブラックリスト」という語は使わない（管理画面ラベルもテストで固定）。

### blocked にしても絶対に変更しないもの

`Status` / `プラン` / `PlanType` / `有効期限` / `PaidAt` / `LifetimeSanrenpuku` /
Sanrenpuku 閲覧権限 / `PaymentEmailSent` / `PaymentEmailStatus` / `Requested*` / 退会系。

`premiumPlusEligibility.js` の `PP_WRITABLE_FIELDS` allow-list と `assertOnlyPlusFields()` で
構造的に強制し、PATCH 直前にも再確認する。**資格変更でメール・LINE・通知は一切送らない。**

### 自動 blocked は禁止

不的中後の問い合わせ / 苦情 / 閲覧回数 / ログイン頻度 / 購入回数 / 推定利益・損失 /
予想結果 / 過去の的中・不的中 / 属性 / KMA スコア / 開封率 / LINE 反応 —
これらを理由にシステムが blocked を書くコードを追加しないこと。正本は管理者の手動判断。

## 段階（PHASE）

| PHASE | いつ | 何が出るか |
|---|---|---|
| **1 LOCKED** | anchor から 0〜2 日目 | 何も出さない。商品ページは **404**（存在秘匿） |
| **2 TEASER** | 3 日目〜 | 会員ページに短い予告のみ。**金額なし・購入ボタンなし・商品ページリンクなし** |
| **3 PREVIEW** | 6 日目〜 | 商品ページ閲覧可（説明 / 実績 / 過去結果 / 本日の1鞍 UI）。購入 CTA は「受付準備中」へ置換 |
| **4 SALE** | 10 日目〜 | ¥98,000 → ¥68,000・銀行振込 CTA を通常表示。加えて本日の受付ステータス |

日数は `PP_PHASE_START_DAY` で定数化（今回は 3 / 6 / 10 のまま）。JST 暦日で計数する。

### 予告文言は route ごとに分ける

- ROUTE A（三連複利用者）: 既存コンセプトのまま
  「全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ、新しい予想を準備しています。」
- ROUTE B（通常 Premium・三連複未購入）: 三連複前提の文章を使わない
  「全レース型とは異なる、もうひとつの選択肢。」「対象レースを増やすのではなく、その日の全開催から1鞍だけを選ぶ。」

**商品ページ本文は共通**（入口の差分だけで対応。本文は変更しない）。

### 予告文言は phase でも分ける（2026-08-07 追加）

`teaserCopyForRoute(route, phase)` は **route と phase の両方**で文言を決める。

| phase | 文言 | 導線リンク |
|---|---|---|
| **2 / 3（待機中）** | 「…新しい予想を**準備しています**」（従来どおり・変更しない） | PHASE 2 は無し / PHASE 3 は `内容を見る →` |
| **4（開通済み）** | 「準備しています」を**出さない**。ROUTE A =「新しい予想をご用意しました」 | `詳細を見る →` |

- **背景（事故）**: 2026-08-07 まで文言が route だけで決まっており、override 等で PHASE 4
  （閲覧・購入が開通済み）になった会員にも「準備しています」が出続けていた。ある会員は
  8 日間購入可能だったのに、画面上は「まだ買えない」と読める状態だった。
- **トーン制約**: PHASE 4 でも**予告枠は予告枠のまま**。「お申し込み受付中」「今すぐ購入」等の
  営業的な強調表現・スタイル変更・クラス追加は入れない。差し替わるのは**文字列だけ**。
- **受付時間（intake）では文言を変えない**。予告枠は受付状態を語らない（CLOSED 表示は商品ページの役割）。
- `linkLabel` も単一源（`PP_RELEASE_COPY`）が持つ。`PremiumPlusStageTeaser.astro` に
  ラベルをベタ書きしない。ラベルが空ならリンクごと出さない（fail closed）。
- phase 未指定・不正値は**待機中**の文言に倒す（fail closed）。

検証: `src/lib/premiumPlus/premiumPlusTeaserCopy.test.mjs`（`check:safety` に組込済み）

## anchor（購入日基準 vs 販売許可日基準）

`PP_PHASE_ANCHOR_MODE`（既定 **`'later'`**）で切り替える定数。

| mode | 挙動 | 評価 |
|---|---|---|
| `purchase`（案A） | 購入確定日のみ | 遅い解除で即 PHASE 4。既存会員（購入日不明）は永久に PHASE 1 |
| `eligible`（案B） | 販売許可日のみ | 常に解除日から段階公開。通常フローでも購入日を無視する |
| **`later`（推奨・既定）** | **両者の遅い方** | 通常フロー（購入とほぼ同時に eligible）は案A と同じ。blocked→eligible の遅い解除は解除日から PHASE 1。**購入日が無い既存会員も、eligible にした日を anchor にできる** |

### 販売許可日は専用フィールド `PremiumPlusEligibleAt`（監査日時と兼用しない）

anchor に使うのは **`PremiumPlusEligibleAt` だけ**。監査用の
`PremiumPlusEligibilityUpdatedAt` を anchor に兼用してはいけない。

> 兼用すると、内部メモの編集 / 同じ資格の再保存 / blocked・review への変更で日時が動き、
> **段階公開 phase が意図せず Day 0 へ戻る**（例: PHASE 4 で販売中の会員のメモを直した瞬間に
> 商品ページが 404 になる）。

`PremiumPlusEligibleAt` の更新規則（`buildEligibilityUpdateFields`）:

| 操作 | EligibleAt | UpdatedAt（監査） |
|---|---|---|
| review / blocked → **eligible**（実遷移） | **now へ更新** | 更新 |
| eligible → eligible の再保存（メモだけの変更を含む） | **touch しない** | 更新 |
| eligible → blocked / review | **touch しない**（解除前の値を残す） | 更新 |
| blocked → review など eligible を経由しない遷移 | **touch しない** | 更新 |
| 三連複購入時の初期化（review を入れる） | **書かない** | 更新 |

blocked → eligible の再解除では、その**再解除日時**へ更新される（= そこから PHASE 1 で再開）。
判定に必要な「変更前の資格」は管理 Function が Airtable から読み直す（クライアント申告は信用しない）。

## 「今すぐ販売可」（段階公開 override）

管理者が **特定会員だけ** 段階公開を飛ばして即 PHASE 4 にできる。既存の PHASE 1→4 は維持したまま、
明示 override として実装する（**日時の偽装ではない**）。

### フィールド

`PremiumPlusReleaseOverride`（単一選択 / 空 or `phase4`）**1 つだけ**。
監査は既存の `PremiumPlusEligibilityUpdatedAt` / `...UpdatedBy` を再利用し、
`PremiumPlusReleaseOverrideAt` / `...UpdatedBy` は**作らない**（不要なスキーマ肥大を避ける）。

> ⚠️ `PremiumPlusEligibleAt` や `SanrenpukuPaidAt` を過去日に書き換えて即時販売を実現しては
> **いけない**。監査不能になり、override を外したときに戻せなくなる。

### phase 判定の優先順位（この順序を変えない）

| # | 条件 | 結果 |
|---|---|---|
| 1 | audience 不成立（route = none） | 非公開 |
| 2 | `PremiumPlusEligibility != eligible` | 非公開（**override があっても**） |
| 3 | 有効な `phase4` override | **PHASE 4** |
| 4 | それ以外 | 通常の段階公開（anchor からの JST 暦日） |
| 5 | PHASE 4 のとき | OPEN / CLOSING / CLOSED（override 経由でも同じ） |

**override は eligibility の代替ではない。** review / blocked の会員が override だけで
販売可能になることは構造的に起きない（guard テストで固定）。

### 管理画面の 4 操作

| ボタン | eligibility | override | EligibleAt |
|---|---|---|---|
| 段階公開で販売可 | eligible | **解除** | 非 eligible からの遷移時のみ now |
| **今すぐ販売可** | eligible | **phase4** | 同上 |
| 保留 | review | **解除** | touch しない |
| 販売対象外 | blocked | **解除** | touch しない |

- review / blocked へ落とすとき override を必ず解除する。残すと後で再 eligible にした瞬間に
  「意図しない即時販売」が復活する
- 即時販売 → 段階公開は **override だけ**解除。EligibleAt は書き換えないので、元の販売許可日から
  通常の段階公開が再開する
- 「今すぐ販売可」は `window.confirm` で
  **「この会員は即時PHASE 4となり、価格と購入CTAが表示されます。」** を明示し、承諾後のみ write。
  処理中は行内の全ボタンを disable（二重送信対策）
- 状態表示は `describeReleaseState()` の単一源:
  保留 / 段階公開中 PHASE 1〜3 / 販売中 PHASE 4 / 即時販売 / 販売対象外

### schema 未作成時は fail closed

override フィールドは eligibility 系より**後から**追加するため、gate を分けている
（`isReleaseOverrideEnabled` = `PREMIUM_PLUS_FIELDS_READY=1` **かつ** `PREMIUM_PLUS_OVERRIDE_READY=1`）。

- 無効の間は「今すぐ販売可」を **503** で拒否し、ボタンも disabled
- 無効の間は override フィールドを **PATCH に含めない**（未作成フィールドを混ぜると 422 で
  同じ PATCH の eligibility 更新まで巻き添えになる）
- 読み取り側は未作成なら `undefined` → `null`（override なし）＝通常の段階公開

## 本日の受付ステータス（PHASE 4 到達後のみ / 2026-07-30 確定）

**JST の時刻だけで決まる 4 状態。毎日共通で、開催区分（中央 / 南関 / 昼開催 / ナイター）による分岐は廃止した。**

| JST | 状態 | 表示 | 購入 |
|---|---|---|---|
| 00:00〜12:29 | `open` | **本日分 受付中** | 可 |
| 12:30〜14:59 | `limited` | **本日分 残りわずか** | 可 |
| 15:00〜16:29 | `closing` | **本日分 まもなく受付終了** | 可 |
| 16:30〜23:59 | `closed` | **本日分の受付は終了しました** | **不可** |

- 境界は `PP_INTAKE_SCHEDULE`（`limitedFromMin=750` / `closingFromMin=900` / `closedFromMin=990`）の 1 か所だけ。
  **ページ・API に時刻分岐や文言をベタ書きしない**（guard テストで固定）
- CLOSED でも商品説明・実績は閲覧可（404 にしない）。購入不可はボタン `disabled` ＋
  `openBankModal()` の早期 return で二重防御
- **override による即時 PHASE 4 でも同じ時間制御**。16:30 以降に「今すぐ販売可」にしても
  `purchaseEnabled=false`（管理画面の override は phase を 4 にするだけで、受付時間には介入しない）
- 時刻が不正なら CLOSED（fail closed = 売らない側）
- `circuit`（曜日由来の中央/南関）は戻り値に残るが**受付判定には使わない**参考情報

### ⚠️「残りわずか」は時刻のみ

`limited` は **12:30〜14:59 という時間帯**を表すだけで、販売件数・在庫・販売上限とは**一切連動しない**。
件数カウンタ・販売上限機能を追加してはいけない（guard テストで在庫系の識別子と文言を禁止）。

## Airtable フィールド（本番未作成・要承認）

2026-07-29 時点で **6 フィールドは作成済み**（read-only 実測）。
`PremiumPlusReleaseOverride` の **1 つだけが未作成**（要承認）。

| フィールド | 型 | 用途 |
|---|---|---|
| `SanrenpukuPaidAt` | 日時（ISO 文字列） | ROUTE A の anchor。三連複の**入金確認・権限付与が成功した**購入確定日時（申込日時ではない） |
| `PremiumPlusEligibility` | 単一選択 `eligible` / `review` / `blocked` | 販売資格 |
| `PremiumPlusEligibilityReason` | テキスト（200 字） | 管理者だけが見る内部メモ。**顧客画面に絶対に出さない** |
| `PremiumPlusEligibleAt` | 日時 | **段階公開 anchor**。eligible への実遷移時のみ更新 |
| `PremiumPlusReleaseOverride` | 単一選択 `phase4`（空 = override なし） | 「今すぐ販売可」。**未作成・要承認** |
| `PremiumPlusEligibilityUpdatedAt` | 日時 | **監査専用**（phase には使わない） |
| `PremiumPlusEligibilityUpdatedBy` | テキスト | 監査（操作者） |

### 販売 一時停止フィールド（**本番未作成・要承認 / 2026-08-17 追加**）

| フィールド | 型 | 用途 |
|---|---|---|
| `PremiumPlusSalePaused` | **チェックボックス** | 停止中か。未作成・未チェック = 停止していない |
| `PremiumPlusSalePausedAt` | 日時 | 停止/再開の操作日時（監査） |
| `PremiumPlusSalePausedBy` | テキスト | 操作者（監査） |
| `PremiumPlusSalePauseReason` | テキスト（200 字） | 停止理由。**管理者だけが見る。顧客画面に出さない** |

- gate は **`PREMIUM_PLUS_SALE_PAUSE_READY === '1'`**（`isSalePauseEnabled()`。
  `PREMIUM_PLUS_FIELDS_READY=1` も併せて必要）。override と gate を分けるのは、
  未作成フィールドを含む PATCH が 422 で**他の更新まで巻き添えにする**ため。
- **読み取りに gate は不要**（フィールドが無い＝停止していない＝従来どおり）。
- **停止操作だけ fail closed**。gate off のときは 503 `sale_pause_not_ready` を返し、
  画面のボタンも無効化する。**書けないのに「停止しました」と見せない**
  （止めたつもりで売れ続けるのが最悪の事故）。
- 投入順序: **① Airtable で 4 フィールド作成 → ② env `PREMIUM_PLUS_SALE_PAUSE_READY=1` →
  ③ redeploy**。逆順にしても壊れないが、②③ の前は停止操作が 503 のまま。

### 再募集クーポン フィールド（**本番未作成・要承認 / 2026-08-18 追加**）

| フィールド | 型 | 用途 |
|---|---|---|
| `PremiumPlusReopenCouponClaimedAt` | 日時 | **取得日時。値があれば取得済み**（これが取得済みの唯一の根拠） |
| `PremiumPlusReopenCouponId` | テキスト | どのクーポン定義か（`premium-plus-reopen-priority@v1`） |
| `PremiumPlusReopenCouponSource` | テキスト | 取得元（`pause-notice` / `coupon-page`） |

- gate は **`PREMIUM_PLUS_REOPEN_COUPON_READY === '1'`**（`isReopenCouponEnabled()`。
  `PREMIUM_PLUS_FIELDS_READY=1` も併せて必要）。停止フラグの gate とは**別**にする
  （未作成フィールドを含む PATCH が 422 で他の更新まで巻き添えにするため）。
- **読み取りに gate は不要**（フィールドが無い＝未取得）。
- **取得操作だけ fail closed**。gate off のときは 503 `coupon_storage_unavailable` を返す。
  **保存できないのに「取得しました」と見せない**（再開時に抽出できない相手が生まれるため）。
- **チェックボックスを別に作らないこと。** 取得済みフラグと日時の 2 本立てにすると、
  片方だけ書けたときに「取得済みだが日時不明」というズレが生まれる。
- 投入順序: **① Airtable で 3 フィールド作成 → ② env `PREMIUM_PLUS_REOPEN_COUPON_READY=1` →
  ③ redeploy**。②③ の前は取得操作が 503 のまま（画面にもその旨を出す）。

- 既存 Audit Log 機構は AK に無い（Payment Email v2 の状態列があるだけ）ため、
  UpdatedAt / UpdatedBy の 2 列で最小限の監査を持つ。履歴テーブルは作らない。
- **EligibleAt と UpdatedAt は責務が違うので必ず別フィールドにする**（上の更新規則を参照）。
- **`PaidAt` を ROUTE A の anchor に流用しない。** `PaidAt` は Light / Premium の
  会員ランク購入確定日時であり、既存 Premium 会員が後から三連複を買うと
  「馬単購入日」が anchor になって購入直後に PHASE 4 へ飛ぶ。

### 書き込みは env gate 付き（未作成フィールドへ PATCH しない）

存在しないフィールドへ PATCH すると Airtable は 422 を返し、**同じ PATCH に含まれる他の更新も落ちる**。
そのため Plus フィールドへの書き込みは `PREMIUM_PLUS_FIELDS_READY === '1'` でのみ有効
（`isPlusFieldsEnabled()`）。フィールド作成後に env を立てて有効化する。

## Sanrenpuku 購入時のフロー

```
Premium Sanrenpuku 購入確定（PaymentConfirmed）
  ↓ 既存の昇格 PATCH（LifetimeSanrenpuku=true / Requested* クリア）  ← 変更なし
  ↓ 【Step 4.5・別 PATCH・best effort】
      SanrenpukuPaidAt を記録（既に値があれば書き換えない）
      PremiumPlusEligibility=review（未設定のときだけ。管理者判断は上書きしない）
  ↓ 管理画面「保留」に出る
  ↓ 管理者が 販売可 / 販売対象外 を選択
  ↓ eligible のみ段階公開へ
```

**Step 4.5 が失敗しても昇格・メールを巻き戻さない。** 独立した PATCH ＋ try/catch で、
二重昇格 / 二重メール / Payment Email v2 の再送 / Status 巻き戻し / LifetimeSanrenpuku 取消を起こさない。
guard テストが「昇格 PATCH より後」「try/catch」「throw / 500 を返さない」を固定している。

### 冪等性

| 再実行ケース | 挙動 |
|---|---|
| confirm 再実行（LifetimeSanrenpuku 既に true） | `SanrenpukuPaidAt` は既存値を保持（更新しない） |

### 三連複購入日時の記録は「無言で失敗させない」（2026-08-08 追加）

三連複の購入日時は **`SanrenpukuPaidAt` にしか残らない**。
`RequestedAmount` は承認時にクリアされ、金額は管理者宛メールにしか残らないため、
この PATCH が落ちると**購入の裏取りが永久に取れなくなる**
（2026-08-07 の監査で実際に「本当に購入したのか確認できない」会員が 1 名出た）。

そこで、本 PATCH は **best effort のまま**（昇格を巻き戻さない設計は変えない）で、
結果を必ず 1 つ確定させてログと応答に出す。

| 結果 | 意味 |
|---|---|
| `recorded` | 記録できた（`sanrenpukuPaidAtRecorded` で購入日時を書いたかも分かる）|
| `nothing_to_write` | 既に記録済み（冪等・正常）|
| `gate_closed` | `PREMIUM_PLUS_FIELDS_READY` 未設定。**購入日時が残らない**ので env を確認する |
| `failed_http_<status>` / `failed_error` | **記録に失敗**。昇格は成立しているので、購入日時だけ手当てが要る |

- ログの目印は **`[sanrenpuku-plus-init]`**。成功は `console.log` / 失敗は `console.warn`
- ログに secret・メール・氏名は出さない
- `confirm-bank-payment` の応答にも `sanrenpukuPlusInit` / `sanrenpukuPaidAtRecorded` を載せる
  （**三連複購入のときだけ**。通常購入の応答形は変えない）
- **既存顧客への遡及 write はしない**。記録されるのは今後の確認分だけで、
  2026-07-29 より前に購入した会員の `SanrenpukuPaidAt` は空のまま

固定テスト: `src/lib/payments/sanrenpukuPaidAt.guard.test.mjs`
| 管理者が eligible / blocked 設定済み | confirm 再実行で **review へ戻さない** |
| 書くものが何も無い | PATCH 自体を行わない（null 返し） |

## ROUTE B の 30 日 anchor

ROUTE B の anchor は既存の `PaidAt`（通常 Premium の入金確認日時）を使う。

**判明している性質（read-only 実測）:**

- `PaidAt` を持つのは 1440 件中 **12 件**。2026-07 の入金確認フロー以降のレコードだけ。
- `buildConfirmationFields()` は Light / Premium の会員ランク購入時に `PaidAt = 入金確認日時` を書く。
  更新・再契約でも同じ経路を通るため、**更新のたびに上書きされる**（＝ 30 日カウントがリセットされる）。
- 三連複購入時は `PaidAt` を書かない（会員ランクを変えないため）。

**判断: ROUTE B の anchor として `PaidAt` を使ってよい。** 理由:

- ROUTE B は「加入から一定期間 Sanrenpuku を買っていない人に**提案してよいか**」の粗いふるいであり、
  最終的な販売可否は管理者の手動選別が決める。更新でカウントが伸びても**提案が遅れるだけ**で
  誤って早く売ることはない（安全側にズレる）。
- `PaidAt` が無い会員は route 対象外（fail closed）。**推測で加入日を作らない。**

**採用しなかった代替案:**

- `有効期限 − PlanType 期間`（Annual なら 1 年）で逆算 … 手入力された既存 `有効期限` が混在し、
  値の意味が保証できない。推測になるため不採用。
- `登録日` … 会員登録日であって Premium 加入日ではない。
- `PremiumFirstPaidAt` を新設 … 精度は上がるが、上記のとおり遅れる方向のズレしか起きないため、
  現時点でスキーマを増やす価値が薄い。必要になったら追加する。

### ⚠️ 公開条件と「管理画面の表示条件」を同じにしない（2026-07-30 集約）

**事故**: 管理画面 `/admin/premium-plus-eligibility/` の list API が、公開判定
`resolvePremiumPlusRelease()` の `route === none` をそのまま**一覧の表示条件**に流用していた。
その結果、**有効な Premium 会員なのに `PaidAt` が空な旧会員が一覧から丸ごと消えて**いた
（Airtable のビューには 11 名見えるのに管理画面は 3 名）。`PaidAt` は 2026-07-10 の入金確認
フロー刷新（`126b6a7`）で初めて書かれるようになったフィールドで、それ以前に有料化した会員は
構造的に持たない。**旧データが足りないこと**と**販売対象外であること**は別の話であり、
前者を理由に人そのものが一覧から消えると、管理者はその会員の存在に気づけない。

**恒久設計**: 2 つの判定を**別モジュール**に分ける。

| 判定 | 単一源 | 決めること | 誰に影響するか |
|---|---|---|---|
| 公開（audience） | `premiumPlusRelease.js` | 顧客に何を見せるか | 顧客 |
| レビュー候補の表示 | `premiumPlusAdminAudience.js` | 管理画面の一覧に名前を出すか | 管理者だけ |

`resolveAdminCandidate()` が返す区分（表示専用・販売資格ではない）:

| kind | 対象 | 販売可にした場合 |
|---|---|---|
| `route_a` / `route_b` | route 成立 | 段階公開が始まる |
| `waiting_30d` | 有効 Premium・加入 30 日未満 | まだ公開されない（あと N 日を画面に表示） |
| `anchor_missing` | 有効 Premium・`PaidAt` が空 | **公開されない**（画面に理由を明示） |
| `explicit` | route 不成立だが資格設定済み | 管理者の判断の痕跡を消さないため表示 |

**守るべき条件（guard テストで固定 / `premiumPlusAdminAudience.test.mjs`）:**

- 一覧に出すこと自体が販売資格を一切与えない。`PremiumPlusEligibility` 未設定は review のまま
- 新たに表示対象へ加えた会員は `resolvePremiumPlusRelease()` が `allowed:false`。
  管理者が `eligible` や `phase4` override を付けても、route 未成立なら公開されない（fail closed）
- 表示条件の判定に**推測の日付フォールバックを入れない**（`登録日` / `createdTime` / `有効期限`
  を anchor 代用にしない。上記「採用しなかった代替案」と同じ理由）
- Premium 会員でない層（Free / Light / 期限切れ / pending / 退会 / 停止 / test）は表示しない
- list API はインラインで表示条件を再実装せず、必ずこのモジュールへ委譲する

**残っている判断（未実施 / 要承認）**: `anchor_missing` の会員を実際に販売対象にするには
Airtable の `PaidAt` を実際の入金確認日で補正する（Customers への write）必要がある。
`PaidAt` を推測で埋めることも、route 判定から 30 日条件を外すこともしない。

### read path から書かない

ROUTE B の 30 日到達は **AK runtime の read だけで「未設定 = review 相当」として扱う**。
ページ閲覧時に Airtable へ write しない（read path に副作用を作らない）。
DB 上へ review を materialize する batch / reconciler は**作らない**（不要な write を増やさない）。

## 既存会員の扱い（migration 方針）

read-only 実測（2026-07-29 / 1440 件・PII 非出力）:

| 区分 | 件数 |
|---|---|
| 三連複保有（LifetimeSanrenpuku=true or 旧 tier premium-sanrenpuku/combo） | **22**（うちアカウント有効 14） |
| └ `SanrenpukuPaidAt` を持つもの | **0**（フィールド自体が無い） |
| 有効な通常 Premium 会員 | 19 |
| └ 三連複未購入 | **15**（`PaidAt` あり 7 / なし 8） |
| └ うち `PaidAt` 基準で 30 日以上経過 | **0**（7 件はすべて 7 月の入金確認） |
| `PremiumPlusEligibility` を持つもの | 0 |

既存 22 件の三連複購入日は**復元できない**（`PaidAt` は会員ランク購入日で意味が違う、
`RequestedPlan` は承認時にクリア済み、payment history テーブルは無い）。

**方針: A（既存会員は review のままにして管理者が個別に解禁）を採用する。**

- 全員 eligible への一括 migration は**禁止**（管理者選別が目的そのもの）。
- 既存会員は `SanrenpukuPaidAt` が無くても、管理者が eligible にした時点で
  `PremiumPlusEligibilityUpdatedAt` が anchor になり（mode `later`）、そこから PHASE 1 で段階公開が始まる。
  **専用 anchor も一斉基準日も新設不要。**
- 対象は最大 22 件（実質 14 件）なので手動選別で十分。

## 管理画面

`/admin/premium-plus-eligibility`（`/admin/*` の Basic-Auth 背後 ＋ `x-admin-secret`）

**UI は 2026-07-30 に「管理テーブル + 詳細操作パネル」型へ再設計（表示のみ。write 契約・
preview 契約・判定ロジックは不変）。**

- **管理接続**: 既定で閉じる。上部に `● 管理API 接続済み` のピルだけ出し、必要時に
  「管理接続設定」で開く（secret は非表示）
- **サマリー**: 1 行のバー `即時販売 N | 販売可 N | 保留 N | 販売対象外 N | 候補 N`。
  数字クリックで状態フィルターが切り替わる。ROUTE A/B は直下に補助表示
- **検索・フィルター**: 1 行に `[Email 検索] [状態▼] [Route▼]`。どちらもクライアント側のみで
  API を追加で呼ばない
- **一覧（PC）**: 1 行 1 顧客のテーブル
  `顧客 | 状態 | プラン | Route | PHASE | 販売許可日 | 最終更新 | 操作`
  - Email は省略表示 + `title` で全文
  - **操作列は「詳細・操作」ボタン 1 個だけ。write ボタンは一覧に出さない**（誤操作防止）
- **状態バッジ（短いラベル）**: `保留`(青) / `PHASE 1〜3`(緑) / `販売中`(濃緑) /
  `即時販売`(ゴールド) / `販売対象外`(赤)
- **詳細・操作パネル**（右サイドパネル。**write はここだけ**）
  - 基本情報: Email / 状態 / プラン / 三連複 / Route / PHASE / Premium経過 / 販売許可日 /
    最終更新 / 内部メモ
  - 表示確認: `[表示プレビュー]`
  - 通常操作: `[段階公開で販売可]` `[保留]`
  - 強い操作: `[今すぐ販売可]`（確認ダイアログ必須）`[販売対象外]`（危険色の枠で区別）
  - 現在の状態と同じ操作は disabled（「適用中」を表示）
  - 内部メモ入力（write payload の `reason` に載る）
- **並び順**: 保留 → 販売可・販売中 → 即時販売 → 販売対象外。同群は最終更新の新しい順
- **モバイル（860px 以下）**: テーブルを **1 顧客 1 コンパクトカード**へ自動切替。
  横スクロールはさせない。カードには Email / 状態 / プラン・Route・PHASE / `[詳細・操作]` だけ出す
  （販売許可日・最終更新は隠す）。詳細・操作は同じパネルで扱う

### 配色（AK ダークテーマ）

ブラウザ標準の白い button / select / checkbox を出さないため、`.ppe button, .ppe select,
.ppe input, .ppe textarea` に**既定のダーク配色**を先に当てている。CSS 変数は `.ppe` に定義:
`--nv-0 #0b1120`（入力欄）/ `--nv-1 #0d1729`（パネル）/ `--nv-2 #111c33`（既定ボタン）/
`--nv-3 #1b2a47`（hover）/ `--gold #f5c451` / `--green #34d399` / `--red #f87171`。

| 用途 | 配色 |
|---|---|
| 再読み込み / 詳細・操作 / 表示プレビュー | ダークブルー gradient + 薄いブルー border |
| 管理接続設定 | ネイビー + slate 文字 |
| 段階公開で販売可 | 深いグリーン gradient（蛍光にしない） |
| **今すぐ販売可** | **ゴールド gradient**（Premium Plus の主要操作） |
| 保留 | slate / blue-gray |
| 販売対象外 | ダーク赤背景 + 赤 border/文字（**危険操作のみ赤**） |
| disabled | 背景はダークのまま `opacity .42` / `cursor: not-allowed` |

- `select` は `appearance: none` + 自前シェブロン（data URI SVG）。`option` にもダーク背景を指定
- `checkbox` は `accent-color: var(--gold)`（独自実装せずブラウザ互換を優先）
- focus は `outline: 2px solid rgba(245,196,81,.6)`（ゴールド）
- 状態バッジはすべてダーク背景 + 淡色文字。即時販売のみゴールド gradient（**白 pill は禁止**）
- guard が **白背景 `#fff`/`white`・黒文字 `#000` の指定が 1 つも無いこと**を固定

> ⚠️ **スタイルは `<style is:global>` + 全セレクタ `.ppe` 名前空間で書くこと。**
> Astro の scoped style は `.cust[data-astro-cid-xxx]` へ変換され、**JS で生成する行・バッジ・
> ボタンには一切適用されない**（2026-07-30 に本番で発生）。guard テストで
> `is:global` / `.ppe` 名前空間 / ビルド後 CSS に `data-astro-cid` が無いことを固定している
- フィールド未作成（`PREMIUM_PLUS_FIELDS_READY` 未設定）の間は**閲覧のみ**（ボタンは disabled、
  API も 503）。既存の管理画面を作り替えず、1 画面だけ追加している。

Function: `netlify/functions/premium-plus-eligibility.js`（`action: 'list' | 'update'`）

## 管理者プレビュー（表示確認・完全 read-only）

`/admin/premium-plus-eligibility/` の各行の **「表示プレビュー」** ボタンでモーダルが開き、
その会員に Premium Plus がどう見えるかを確認できる。

### 絶対にやらない（安全要件）

- 会員セッション（`ak_session`）の発行・なりすまし・Cookie 差し替え
- magic login link の発行 / メール・LINE・通知の送信
- Customers への書き込み（eligibility / override / EligibleAt / Payment 系すべて）

Airtable は **GET のみ**。判定は既存の単一源（`resolvePlusMemberFromFields` →
`resolvePremiumPlusRelease` → `describeReleaseState` / `intakeCopy`）へ委譲し、
**プレビュー用に phase / intake を複製しない**（guard テストで固定）。

### 見られる内容

route / eligibility / override / overrideApplied / PHASE / 状態 / anchor /
intake（4 状態の実文言）/ showTeaser / showProductPage / showPurchaseCta /
purchaseEnabled / 価格ブロックの有無 / CTA の有効無効 / CLOSED 時の閲覧可否 /
商品ページの HTTP（200 or 404）。**Email・氏名は返さない**（PII 非出力）。

### シミュレーション（管理画面内に閉じる）

| 種類 | 入力 | 内容 |
|---|---|---|
| 時刻 | `atMin`（JST の分・0〜1439） | 現在時刻 / 12:29 / 12:30 / 14:59 / 15:00 / 16:29 / 16:30 / 19:00。候補は `PP_INTAKE_SCHEDULE` から導出するので受付時刻を変えれば自動追従する |
| PHASE | `phaseDaysAgo`（0〜3650） | anchor を N 日前にして PHASE 1〜4 の表示を確認。**anchor 系（SanrenpukuPaidAt / EligibleAt）だけ**を差し替え、`PaidAt`（ROUTE B の 30 日判定）は触らないので **route は変わらない** |

どちらも `action='preview'` の応答内だけに作用する。会員向けページ / stage API は常に
`Date.now()` と実データで解決するため影響しない（guard テストで固定）。
**本番データ・EligibleAt・現在時刻は書き換えない。**

UI には常に **「管理者プレビュー / 実顧客には影響しません」** を表示する。

### 認可

`/admin/*` の Basic-Auth（Edge Function）＋ `x-admin-secret`。認可チェックは `preview` 分岐より
**前**にあり、未認証は 403（guard テストで順序を固定）。recordId は URL に載せずモーダル内で扱う。

## KMA（keiba-marketing-automation）との責務分離

別 project / 別 repository。AK と統合しない。

| | 役割 |
|---|---|
| **AK** | Plus 販売資格の**正本**（eligible / review / blocked）・route 判定・ページ閲覧と CTA 制御・purchaseEnabled・管理画面 |
| **KMA** | Premium 加入後 Sanrenpuku 未購入者へのマーケティング / 三連複購入後の段階的コミュニケーション / メール・LINE sequence / due 判定 / campaign 管理 |

**interface 契約:**

- KMA は `PremiumPlusEligibility` を **eligible へ変更してはいけない**。
  マーケティング対象 ≠ 販売許可。管理者の eligible 判断が最優先。
- KMA が読んでよい: `PremiumPlusEligibility` / `SanrenpukuPaidAt` / `PaidAt`（配信セグメント用）
- KMA が書いてよい: なし（本 doc 時点）
- AK 側は資格変更でメール・LINE・通知を送らない。連絡が必要なら KMA の別工程で行う。

KMA 側の変更は本作業の範囲外。

## fail closed 一覧

次のいずれかに該当したら販売不可（表示しない側へ倒す）:

- 販売資格が未設定 / 不正値 / 読取失敗
- anchor 不明
- route 不明（none）
- session 不正・Cookie なし・鍵未設定
- Customers が取得できない（通信失敗・タイムアウト・レコード無し）
- 会員状態が不明（entitlement 判定不可）

## 現在地（2026-07-29）

- [x] 段階公開 PHASE 1〜4 ＋ OPEN / CLOSING / CLOSED（`56f5466`）
- [x] ROUTE A / ROUTE B の route 判定と排他
- [x] PremiumPlusEligibility（eligible / review / blocked・fail closed・自動 eligible なし）
- [x] anchor 3 方式の比較と `later` 既定
- [x] Sanrenpuku 購入確定時の Plus 初期化（別 PATCH・best effort・env gate）
- [x] 管理画面（一覧 / 保留絞り込み / 3 ボタン / 内部メモ）
- [x] route 別の予告文言
- [x] テスト（fixture / mock のみ・本番データ不使用）
- [x] 販売許可日 anchor を専用フィールド `PremiumPlusEligibleAt` へ分離（案A・監査日時と兼用しない）
- [x] Airtable に 6 フィールドを作成（2026-07-29 完了）
- [x] `PREMIUM_PLUS_FIELDS_READY=1` を production に設定（2026-07-29 完了）
- [x] 「今すぐ販売可」override のコード実装（コードのみ・本番未反映）
- [ ] **Airtable に `PremiumPlusReleaseOverride` を作成**（承認待ち・本番 schema 変更）
- [ ] **`PREMIUM_PLUS_OVERRIDE_READY=1` を production に設定**（承認待ち・本番 env 変更）
- [ ] 既存 22 件の個別解禁（管理者操作）
- [x] 受付締切時刻の確定（2026-07-30・JST 共通 4 状態）
- [ ] main への push / production deploy（承認待ち）

## 販売管理 API は候補だけを取る（2026-08-13 / 全件走査を廃止）

### 何が起きていたか

`premium-plus-eligibility` の `action='list'` は Customers を**無フィルタで先頭から GET** し、
`MAX_PAGES=40`（＝先頭 4,000 件）で打ち切っていた。Customers が 15,962 件へ育った結果、
**即時販売 3 名が 3 名とも窓の外**になり、管理画面はこう表示していた:

| 指標 | 画面（誤） | 実際 |
|---|---|---|
| 即時販売 | 0 | **3** |
| 保留 | 6 | **15** |
| ROUTE A（三連複） | 0 | **3** |

顧客側の CTA は正常に出ていたため、**管理者だけが「誰にも売れていない」と誤認**する形だった。

### Customers 15,962 件の内訳（2026-08-13 実測）

| 区分 | 件数 |
|---|---|
| `Source = customer-import:*`（CSV 取り込み） | 14,489 |
| Source 空（元からの AK 基盤） | 1,026 |
| `nankan-analytics`（旧サービスからの引き継ぎ） | 447 |
| **合計** | **15,962** |

プラン: Free 15,864 / Premium 58 / Premium Sanrenpuku 17 / Light 14 / Test 6 / Premium Combo 3。
Status=active 46 / 有効期限が未来 23 / ログイン履歴あり 144 / 退会 37 / 配信停止 2。

**販売管理が見るべきなのはこのうち ~98 件（1 ページ）だけ**で、残り 15,864 件の無料連絡先は
route も premiumActive も成立しないため候補になり得ない。

### 対処: server-side filter（MAX_PAGES は増やさない）

正本は `premiumPlusAdminAudience.js` の `buildAdminCandidateFormula()`。

```
OR(
  NOT({プラン} = 'Free'),          ← 有料プラン履歴のある人だけ
  {LifetimeSanrenpuku},            ← 三連複買い切り（プランは Premium のまま）
  NOT({PremiumPlusEligibility} = BLANK()),      ← 管理者が判断済み
  NOT({PremiumPlusReleaseOverride} = BLANK())   ← override だけ残る異常系
)
```

- **全件走査しない / `MAX_PAGES` を増やして解決しない**
- **並び順を `Email` 昇順で固定**（Airtable の既定ビュー順に結果が左右されない）
- **集計と一覧は同じ `rows` から算出**（別集合を数えない）
- 上限に達したら `candidate_scan_limit` で **fail closed**。
  画面は件数も一覧も出さず「0 件ではありません」と明示する

#### 🛡️ 超集合の原則

formula は `resolveAdminCandidate().listed === true` になり得る人を **1 人も落としてはいけない**
（落とすと管理者から永久に見えない）。余分に取るのは安全。
`premiumPlusAdminBounded.test.mjs` の総当たりで固定している。

**退会・配信停止・無反応除外を formula に足さないこと。**
`resolveAdminCandidate` はこれらで人を落とさないので、formula 側で落とすと
超集合が壊れる。特に**無反応除外は Customers のフィールドではない**
（正本は `engagementPolicy.js` + Redis 集計 + CampaignDeliveries。**配信抑止のみで
Customers は書き換えない／削除しない**）ため、Airtable formula では表現できず、
販売資格の判定にも使わない（メールを開かない有料会員を販売管理から消してはいけない）。

### Email 個別検索は候補集合を迂回する

一覧は候補だけへ絞るので、無料会員など候補外の人は出ない。
`action='lookup'` が Email 完全一致で 1 件だけ直接引き、`inCandidateSet: false` を添えて返す。
行の組み立ては一覧と同じ `buildAdminRow`（値がズレない）。

### 本番実測（2026-08-13・修正後）

| 指標 | 値 |
|---|---|
| formula の取得 | **98 件 / 1 ページ / 1.2 秒**（旧: 全件 160 ページ / 79 秒） |
| 一覧に出る候補 | 18 |
| 即時販売 | **3** |
| 販売可 eligible | 3 |
| 保留 review | 15 |
| 販売対象外 blocked | 0 |
| ROUTE A（三連複） | 3 |
| ROUTE B（Premium 30日） | 2 |
| 全件走査との突き合わせ | **取りこぼし 0** |

## 販売停止中の直 URL と 再募集クーポン（2026-08-18）

### 何を変えたか（変えていないこと）

停止中の会員が**以前保存した直 URL** で `/premium-plus/` `/premium-plus-v2/` に来たとき、
404 ではなく**受付休止のご案内ページ**（HTTP 200）を返す。それ以外は一切変えていない。

| | 停止中の挙動 |
|---|---|
| dashboard の Plus CTA | **従来どおり非表示**（`/api/upsell.json` は `channel=none`） |
| 三連複ページの Plus 予告 | **従来どおり非表示** |
| 商品ページの購入 CTA・価格 | **出さない**（休止ページに購入導線は 1 つも無い） |
| 申込 Function | **従来どおり 403 `sale_paused` / `sideEffects:'none'`** |
| 販売資格 / override / PHASE anchor | **変えない**（再開すれば元の状態がそのまま戻る） |

### 誰に休止ページを出すか

判定は単一源 **`resolvePlusPauseNoticeView()`**（`premiumPlusRelease.js`）で、
`resolveUpsellForCustomer().pauseNotice` として配る。

**停止フラグを外したら商品ページを見られたはずの人だけ**に出す。
`denied()` は停止フラグを全経路の戻り値に載せるため、`salePaused === true` だけを条件にすると
route 未成立・`blocked`・無料会員にまで**商品の存在が漏れる**。

| 会員 | 停止中の直 URL |
|---|---|
| 販売可（PHASE 3 以上）| **受付休止ページ 200** |
| `blocked`（販売対象外）| 404（恒久判断を一時停止で上書きしない） |
| `review`（保留）/ PHASE 2 以下 | 404 |
| Plus の候補ではない（無料・Premium 加入直後 等）| 404 |
| `UpsellTarget=none` / `sanrenpuku` | 404（管理者が別の導線を指定しているため） |

### 再募集クーポン（取得権であって、割引ではない）

休止ページから会員本人が取得できる。**取得しても権利は 1 ミリも増えない。**

- 申込・課金・Premium 昇格・**メール送信・queue 登録は一切発生しない**
- 販売停止は解除されない（`PremiumPlusSalePaused` を 1 バイトも書かない）
- 書くのは `PremiumPlusReopenCoupon*` の 3 フィールドだけ
  （`assertOnlyCouponFields` が PATCH 直前に機械的に検査する）

**割引額・割引率・特別価格・有効期限は未確定**（`PP_REOPEN_COUPON.terms.determined = false`）。
`promotionOfferCatalog.js`（価格の正本）に Premium Plus の offer が 1 件も無いため、
**ここで金額を作らない**。顧客画面にも金額を出さず「募集再開時にご案内します」とだけ書く。

> **なぜ `PromotionalOffers` に 1 行積まないのか**
> あの台帳は「価格が入った購入条件」の台帳で、`offerFilterModel.js` /
> `customerTimeline.js` / `recommendedActions.js` が `Status` / `ExpiresAt` / `OfferPrice`
> を読んで顧客を分類している。価格も期限も無い行を混ぜると、割引オファーを 1 度も
> 受け取っていない顧客が管理画面で「期限切れのオファーのみ」と表示される（嘘の分類）。

### 取得の認可（サーバー側だけで決める）

`POST /api/premium-plus-coupon.json`

1. `ak_session` を検証（未ログイン → 404）
2. 対象レコードは**セッション由来の recordId のみ**。body の id / email は読まない
3. `resolveCouponClaimDecision()` が `pauseNotice.showPauseNotice === true` を要求。
   対象外は **404**（存在秘匿。401/403 は使わない）
4. 既に取得済みなら **PATCH せずに 200**（冪等・取得日時を上書きしない＝二重取得なし）
5. gate off / PATCH 失敗は **503**（「取得した」と言わない）

URL 直打ち・fetch の直接呼び出し・古いタブからの再送でも同じ判定を通る。
**画面が CTA を出していたかどうかは根拠にしない。**

### クーポンページ `/premium-plus-coupon/`

会員が自分の状態だけを見る。クーポン名 / 取得済み / 取得日時 / 「募集再開時に利用可能」/
現在の受付状況 / 未取得なら取得 CTA。**一覧・検索・他人指定の経路を持たない**ので、
他会員のクーポンは構造的に見えない。`noindex` + robots.txt `Disallow`。

### 販売停止を解除したあとの扱い（正本）

| | 解除後 |
|---|---|
| 取得済みクーポン | **そのまま残る**（取得日時も保持。期限は未設定＝勝手に失効させない） |
| 商品ページ | 通常の商品ページへ戻る（休止ページは出なくなる） |
| クーポンページ | **取得済みの会員は引き続き閲覧できる**（状態確認のため） |
| 新規取得 | **できない**（取得 CTA は「いま案内対象」のときだけ。`claimable: noticeTarget`） |
| 販売資格 / PHASE | 停止前の状態がそのまま戻る（クーポンは判定に一切影響しない） |

### 再募集するときの手順

1. `promotionOfferCatalog.js` に Premium Plus 用の `purchase_offer` を追加する
   （**金額・割引率・TTL はそこが正本**。`/pricing/` との突き合わせ guard も効く）
2. 管理画面 `/admin/premium-plus-eligibility/` の「クーポン取得済み」で対象会員を抽出する
3. 既存の offer 発行経路（`promotionalOffer.js` / `PromotionalOffers`）で offer を発行する

**本 PR は 1〜2 の抽出までしか用意していない。** 3 の発行・実メール送信・queue 登録・
価格変更・課金は含まない。

### 管理画面（3 つの軸を混ぜない）

| 軸 | 何を表す | 表示 |
|---|---|---|
| 販売資格 | `PremiumPlusEligibility` / PHASE | 既存の資格バッジ（停止で動かさない） |
| 販売の一時停止 | `PremiumPlusSalePaused` | `一時停止中`（琥珀）バッジ + `fPause` |
| **再募集クーポン** | 顧客本人が取得した事実 | `クーポン取得済み`（青緑）バッジ + `fCoupon` + 件数 |

クーポンは**管理者が付与・取消する操作を持たない**（顧客の取得でしか増えない）。
詳細パネル「再募集クーポン」で取得状況・取得日時・取得元を読むだけ。

### 関連ファイル

| 目的 | ファイル |
|---|---|
| クーポン保有状態の単一源 | `src/lib/premiumPlus/premiumPlusReopenCoupon.js` |
| 休止ページを出す条件 | `src/lib/premiumPlus/premiumPlusRelease.js` (`resolvePlusPauseNoticeView`) |
| 顧客への配布 | `src/lib/upsell/upsellTarget.js` (`pauseNotice`) |
| 休止 / クーポンページの HTML | `src/lib/premiumPlus/premiumPlusPauseNoticePage.js` |
| 取得 API | `src/pages/api/premium-plus-coupon.json.js` |
| クーポンページ | `src/pages/premium-plus-coupon.astro` |
| 管理一覧 | `netlify/functions/premium-plus-eligibility.js` / `src/pages/admin/premium-plus-eligibility.astro` |

検証: `npm run test:premium-plus-media`（`check:safety` に組込済み）

## ⚠️ 「表示される判定である」と「実表示済み」は区別する

2026-08-13 に「Premium Plus CTA は誰にも表示されていない」と誤報告した。実際は表示されていた。

**現時点で証明できていること**（コード・実データ）:

- 対象会員の保存値は `PremiumPlusEligibility=eligible` + `PremiumPlusReleaseOverride=phase4`
- 本番と同じ関数（`resolveUpsellForCustomer`）で `channel=plus` / `phase=4` /
  `showTeaser` `showProductPage` `showPurchaseCta` `purchaseEnabled` すべて true
- したがって**「表示される判定である」**

**証明できていないこと**:

- **その会員本人の署名セッションでの実画面表示と、リンク先が 200 で開くこと**。
  `ak_session` が必要で未実施。**「実表示済み」とは書かないこと。**

実際に表示されている CTA の実装元（実測）:

| 画面 | 実装 | 表示条件 | リンク先 |
|---|---|---|---|
| ダッシュボード「会員限定のご案内を見る」 | `dashboard.astro` `#plus-upsell-section` | `/api/upsell.json` の `channel === 'plus'` | `/premium-plus-v2/` |
| 三連複「新しい予想をご用意しました」 | `PremiumPlusStageTeaser.astro`（文言 `teaserOpen`） | `plus.showTeaser` かつ PHASE 4・ROUTE A | `/premium-plus/` |

`PremiumPlusCta.astro` は 2026-07-15 から `premium-sanrenpuku.astro` でコメントアウトされたまま
（別物）。**コンポーネント名だけで「CTA が無い」と判断しないこと。**
未ログインでは `/premium-plus/` `/premium-plus-v2/` `/api/upsell.json` とも **404**（存在秘匿）で、
**未ログインで取得した HTML を「CTA が無い」証拠に使ってはいけない。**

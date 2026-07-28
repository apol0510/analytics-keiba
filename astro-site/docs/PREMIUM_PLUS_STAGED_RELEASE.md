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
4. **anchor**: route 固有の購入確定日時と販売許可日から決める
5. **phase**: anchor からの JST 暦日で 1〜4
6. **受付ステータス**: PHASE 4 のときだけ OPEN / CLOSING / CLOSED
7. **purchaseEnabled**: PHASE 4 かつ CLOSED でない

### ROUTE A / ROUTE B は排他

Sanrenpuku 購入済みになったユーザーには ROUTE B を適用しない（`resolvePlusRoute` が
先に ROUTE A を返す）。ROUTE B 進行中に三連複を買えば ROUTE A へ切り替わり、
両方が同時に立つ構造にはしていない。

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

## anchor（購入日基準 vs 販売許可日基準）

`PP_PHASE_ANCHOR_MODE`（既定 **`'later'`**）で切り替える定数。

| mode | 挙動 | 評価 |
|---|---|---|
| `purchase`（案A） | 購入確定日のみ | 遅い解除で即 PHASE 4。既存会員（購入日不明）は永久に PHASE 1 |
| `eligible`（案B） | 販売許可日のみ | 常に解除日から段階公開。通常フローでも購入日を無視する |
| **`later`（推奨・既定）** | **両者の遅い方** | 通常フロー（購入とほぼ同時に eligible）は案A と同じ。blocked→eligible の遅い解除は解除日から PHASE 1。**購入日が無い既存会員も、eligible にした日を anchor にできる** |

`later` は追加フィールドを増やさない: 販売許可日は監査用の
`PremiumPlusEligibilityUpdatedAt` をそのまま使う（`PremiumPlusEligibleAt` を別途作らない）。

## 本日の受付ステータス（PHASE 4 到達後のみ）

| 状態 | 表示 | 購入操作 |
|---|---|---|
| OPEN | 「本日のPremium Plus受付」「現在受付中」「受付状況は時間帯・申込状況により変動します。」 | 可 |
| CLOSING | 「本日のPremium Plus受付」「受付終了が近づいています」 | 可 |
| CLOSED | 「本日分の受付は終了しました」「次回受付時に、このページからお申し込みいただけます。」 | **不可** |

CLOSED でも商品説明・実績は閲覧可（404 にしない）。購入不可はボタン `disabled` ＋
`openBankModal()` の早期 return で二重防御。

### ⚠️ 受付締切時刻は「未決定」（今回も確定しない）

AK 内に正式仕様が存在しないため暫定値のまま:

```
chuo（土日 = 中央）  : CLOSING 13:00 / CLOSED 15:00 JST
nankan（平日 = 南関）: CLOSING 18:00 / CLOSED 20:00 JST
```

運用で確定したら `PP_INTAKE_WINDOW` と本 doc を**同時に**更新すること。

## Airtable フィールド（本番未作成・要承認）

2026-07-29 時点で **以下 5 フィールドはいずれも本番 Customers に存在しない**（1440 件を read-only 実測）。

| フィールド | 型 | 用途 |
|---|---|---|
| `SanrenpukuPaidAt` | 日時（ISO 文字列） | ROUTE A の anchor。三連複の**入金確認・権限付与が成功した**購入確定日時（申込日時ではない） |
| `PremiumPlusEligibility` | 単一選択 `eligible` / `review` / `blocked` | 販売資格 |
| `PremiumPlusEligibilityReason` | テキスト（200 字） | 管理者だけが見る内部メモ。**顧客画面に絶対に出さない** |
| `PremiumPlusEligibilityUpdatedAt` | 日時 | 監査 ＋ anchor mode `later` の販売許可日 |
| `PremiumPlusEligibilityUpdatedBy` | テキスト | 監査（操作者） |

- 既存 Audit Log 機構は AK に無い（Payment Email v2 の状態列があるだけ）ため、
  UpdatedAt / UpdatedBy の 2 列で最小限の監査を持つ。履歴テーブルは作らない。
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

- 一覧: メール / プラン / 三連複有無 / Premium 加入経過日数 / route / 販売資格 / 内部メモ / 更新日時 / phase
- 絞り込み: 「保留（確認待ち）だけ表示」
- 操作: `[販売可]` `[保留]` `[販売対象外]` ＋ 内部メモ
- フィールド未作成（`PREMIUM_PLUS_FIELDS_READY` 未設定）の間は**閲覧のみ**（ボタンは disabled、
  API も 503）。既存の管理画面を作り替えず、1 画面だけ追加している。

Function: `netlify/functions/premium-plus-eligibility.js`（`action: 'list' | 'update'`）

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
- [ ] **Airtable に 5 フィールドを作成**（承認待ち・本番 schema 変更）
- [ ] **`PREMIUM_PLUS_FIELDS_READY=1` を production に設定**（承認待ち・本番 env 変更）
- [ ] 既存 22 件の個別解禁（管理者操作）
- [ ] 受付締切時刻の確定
- [ ] main への push / production deploy（承認待ち）

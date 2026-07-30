# カムバック特典（無料 entitlement）

以前 AK を離れた顧客へ、現在の AK をもう一度体験してもらうための**無料特典**を
管理画面から付与する機能。`/admin/premium-plus-eligibility` の「🎁 カムバック特典」タブ。

> **状態: 未本番（2026-07-30）**
> Airtable のフィールドは**未作成**、env gate は**未設定**、本番への付与実績は**ゼロ**。
> 有効化には §7 の承認手順が必要。

---

## 1. 設計の核

### paid entitlement ≠ promotional entitlement

| | 課金契約（既存） | カムバック特典（本機能） |
|---|---|---|
| 正本フィールド | `プラン` / `PlanType` / `有効期限` / `Status` / `PaidAt` / `PaymentConfirmed` | `LightLifetimeGranted*` / `PremiumTrialUntil*` |
| 書き込む場所 | 入金確認フロー（`bankPaymentFlow.js`）・決済メール v2 | `promotionalGrants.js` のみ |
| 本機能から | **読むだけ**（1 バイトも書かない） | 書く |

無料特典を課金フィールドで表現しない理由:

- `有効期限` に書くと**無料なのに「支払済み」に見える**（`PaidAt` / `PaymentConfirmed` と矛盾）
- 既存の有料期限を上書きして**課金済みの権利を短縮**しうる
- 期限切れ通知・再契約導線・売上集計が無料特典を課金として数えてしまう

### 合成規則はひとつだけ

> **強い方を採用する。特典は権利を増やすだけで、減らさない。**

```
canViewPremium        = 有料 Premium 有効  または  Premium 無料期間が有効
canViewLight          = 上記のいずれか  または  有料 Light 有効  または  Light 永久無料
canViewSanrenpuku     = 変更なし（三連複買い切りは特典の影響を受けない）
canPurchaseSanrenpuku = 変更なし（**有料** Premium 会員だけ。無料特典で購入資格は配らない）
```

「Premium 無料期間の終了後は Light 永久無料へ戻る」は**状態遷移ではなく上式の帰結**。
trial が期限切れになると premium 側が false になり、light だけが残る。専用の遷移処理は持たない。

---

## 2. データモデル（Customers のカラム / 13 個）

grant 台帳テーブルではなく **Customers のカラム**を採用した理由:

- runtime の権限判定（`resolveEntitlements` / `memberResolution`）は
  **Customers 1 レコードの fields だけ**を入力にする純粋関数。別テーブルにすると
  ログイン・セッション更新のたびに Airtable への追加照会が必要になり、
  レイテンシと「照会失敗時どうするか」という新しい fail closed 判断が増える
- 特典は種別 2 つ・1 顧客あたり各 1 つだけ。台帳の多行性が要らない
- **複合オファーが 1 レコードの 1 PATCH で完結する**（→ §5 原子性）
- MK が Airtable 画面でそのまま「誰が Light 永久無料か」を見られる（JSON 1 列方式より運用しやすい）

| フィールド | 型 | 用途 |
|---|---|---|
| `LightLifetimeGranted` | Checkbox | Light 永久無料の保有 |
| `LightLifetimeGrantedAt` | Date (ISO, time 込み) | 付与日時 |
| `LightLifetimeGrantedBy` | Single line text | 付与した管理者 |
| `LightLifetimeGrantOp` | Single line text | **operationId（冪等性の鍵）** |
| `LightLifetimeRevokedAt` | Date (ISO) | 取り消し日時 |
| `LightLifetimeRevokeReason` | Single line text | 取り消し理由（管理者メモ） |
| `PremiumTrialUntil` | Date (ISO) | Premium 無料期間の終了時刻（空 = 特典なし） |
| `PremiumTrialGrantedAt` | Date (ISO) | 付与日時 |
| `PremiumTrialGrantedBy` | Single line text | 付与した管理者 |
| `PremiumTrialGrantOp` | Single line text | operationId |
| `PremiumTrialRevokedAt` | Date (ISO) | 取り消し日時 |
| `PremiumTrialRevokeReason` | Single line text | 取り消し理由 |
| `ComebackGrantSource` | Single line text | 施策名（例 `comeback-2026-07`） |

### 取り消しの表現

grant 値そのものを消し（`Granted=false` / `Until` を空に）、`RevokedAt` / `RevokeReason` を残す。
「granted のまま revoked フラグを立てる」方式にしないのは、runtime が
**「値が無ければ権利が無い」**という最も壊れにくい判定でいられるようにするため。

それでも整合が崩れた（値が残ったまま `RevokedAt` の方が新しい）レコードは
**fail closed で権利なし**と解釈し、`inconsistent` として管理画面に出す。自動修復はしない。

### 無料期間の計算

`PremiumTrialUntil = 付与時刻 + 30 日`（実時間）。`有効期限` の JST 暦日計算
（`addOneYearJst`）とは**別物**なので JST 丸めをしない。丸めると
「23:50 に付与した人だけ 1 日短い」が生まれ、課金側の暦日計算とも紛らわしくなる。

---

## 3. オファー（管理画面で選べるのは 3 つ）

| offerId | 内容 | 内部の grant |
|---|---|---|
| `light_lifetime` | Light 永久無料 | `light_lifetime` |
| `premium_trial_30d` | Premium 30日無料 | `premium_trial_30d` |
| `comeback_full` | **Premium 30日無料 ＋ その後 Light 永久無料**（主要施策） | `premium_trial_30d` + `light_lifetime` |

複合オファー専用の grant 種別・状態は**作らない**。2 つの独立 grant の組み合わせで表現する。

---

## 4. 対象外の判定（dry-run で必ず件数を出す）

| 理由 | 意味 |
|---|---|
| `unknown_customer` | 選択された recordId が Customers に無い |
| `data_incomplete` | メールアドレス未登録 / 不正（ログインできないので付与しない） |
| `account_suspended` | 停止・banned・テストアカウント |
| `withdrawal_blocked` | **退会 / 強制ログアウト** → §4-1 |
| `already_granted` | 既に同じ特典が有効（Light は再付与しない / trial は暗黙延長しない） |
| `already_applied` | **同じ operationId で適用済み**（再実行時のスキップ） |
| `paid_stronger` | 有料 Premium が trial 終了日より後まで有効 → 無料期間を足す意味が無い |
| `grant_inconsistent` | 特典データ不整合（自動上書きせず個別確認へ） |

### 4-1. 退会者は付与対象外（要判断事項）

退会（`WithdrawalRequested=true` / `Status='withdrawn'`）は
`memberResolution` の**拒否ゲート**に該当し、**ログイン自体ができない**。
そのため特典を書いても使えず、「Premium 30日無料です」という案内が破られる。

本機能は退会フラグを**絶対に触らない**（`PROMO_FORBIDDEN_FIELDS`）。
退会フラグの解除は課金契約側の判断であり、特典付与の副作用にしてはいけない。

→ 一覧では「退会」バッジ＋「付与不可」を表示し、dry-run では `withdrawal_blocked` として件数を出す。
**退会者にもカムバック特典を届けたい場合は、退会フラグの扱いを別途決める必要がある**（未決）。

---

## 5. 原子性・冪等性・復旧

### 顧客単位では原子的

複合オファーの 2 つの grant は**同じ Customers レコードの別フィールド**に書く。
したがって **1 顧客 = 1 PATCH** で両方が同時に確定し、
「片方だけ付いた」状態は**構造上作れない**（`adminComebackFlow.test.mjs` で固定）。

### 顧客をまたぐ範囲は原子的でない（Airtable にトランザクションが無い）

10 件ずつの batch PATCH のうち後半が失敗しうる。これを次の 3 点で安全にする:

1. すべての書き込みが**同じ operationId** を持つ
2. 同じ operationId の再実行は各フィールドで `already_applied` として無視される
   → **何度でも安全に再実行できる**
3. 失敗時は「適用済み / 失敗 / 未着手」の件数と復旧手順を返し、
   同じ operationId で dry-run し直すと**残りだけ**が対象になる

失敗したら**その時点で以降のバッチを実行しない**（部分適用を最小限に留める）。

### reconcile

`action='reconcile'` で operationId の適用状況を read-only で突合できる。
管理画面「前回操作の突合」ボタン。

### TOCTOU 防止

`grant` は dry-run が返した `planFingerprint` が必須。対象集合・オファー・
書き込む内容のいずれかが変わっていれば **409 で全体停止**（1 バイトも書かない）。

> 一部適用後の再開では fingerprint は当然変わる。**同じ operationId で dry-run をやり直す**のが
> 正しい再開手順で、冪等性により二重付与にならない。

---

## 6. メールとの分離（厳守）

- この Function は **SendGrid / ScheduledEmails / CampaignDeliveries に一切触れない**
  （`adminComebackFunction.guard.test.mjs` がソースレベルで固定）
- 「特典を付与 → 自動でメール送信」は**禁止**。付与成功後に管理者が
  マーケティングタブから案内キャンペーンを選んで送る
- **付与前に案内メールを送らない**（使えない特典を約束することになる）
- メール送信の失敗を理由に付与を巻き戻さない（別トランザクション）

案内文面は `campaignCatalog.js` の `comeback-offer`（v1・**enabled=false の下書き**）。
特典付与フローが本番稼働し、実際に付与を行ってから有効化する。

---

## 7. 本番化に必要な手順（順序厳守）

| # | 手順 | 承認 |
|---|---|---|
| 1 | Airtable Customers に §2 の 13 フィールドを作成 | 要 |
| 2 | `COMEBACK_GRANT_FIELDS_READY=1` を Netlify production に設定 → redeploy | 要 |
| 3 | 管理画面で dry-run（この時点で付与ボタンは無効） | — |
| 4 | `COMEBACK_GRANT_ENABLED=true` を production に設定 → redeploy | 要 |
| 5 | **1 名（自分のテストアカウント）で付与 → ログイン確認 → 取り消し** | — |
| 6 | 本番対象へ付与 | 要 |
| 7 | 付与済みを確認してから `comeback-offer` キャンペーンを有効化（version はそのまま）し送信 | 要 |

⚠️ 順序を逆にしない。フィールド未作成のまま PATCH すると Airtable は 422 を返し、
**同じ PATCH の他の更新も巻き添えで失敗する**（Premium Plus 導入時と同じ罠）。

### rollback

- `netlify env:unset COMEBACK_GRANT_ENABLED --context production` → redeploy
  でコード変更なしに付与を停止できる（既に付与した特典は残る）
- 付与済み特典の取り消しは管理画面の「特典を取り消す」（promotional grant だけを消す）

---

## 8. 関連ファイル

| 目的 | ファイル |
|---|---|
| **特典の単一源**（フィールド名・付与/取消の組み立て・allowlist） | `src/lib/entitlements/promotionalGrants.js` |
| 権限合成（閲覧） | `src/lib/entitlements/resolveEntitlements.js` |
| 権限合成（ログイン） | `src/lib/auth/memberResolution.js` |
| 付与計画（dry-run の中身・冪等・fingerprint） | `src/lib/comeback/comebackGrantPlan.js` |
| 一覧・絞り込み | `src/lib/comeback/comebackAudience.js` |
| 管理 API | `netlify/functions/admin-comeback-grants.js` |
| 管理画面（タブ3） | `src/pages/admin/premium-plus-eligibility.astro` |
| 案内メール（下書き） | `src/lib/marketing/campaignCatalog.js` の `comeback-offer` |
| テスト | `src/lib/entitlements/promotionalGrants*.test.mjs` / `src/lib/comeback/*.test.mjs` |

検証: `npm run test:comeback` / `npm run test:entitlements`（どちらも `check:safety` に組込済み）

---

## 9. 触ってはいけないこと

- `promotionalGrants.js` の allowlist を広げない（課金・契約・三連複・Plus 販売資格）
- 退会フラグ・`ForceLogout` を特典付与の副作用で書き換えない
- 特典付与とメール送信を 1 操作に結合しない
- `canPurchaseSanrenpuku` / Premium Plus の `premiumActive` に無料特典を混ぜない
  （`paidPremiumActive` を使う）
- gate（`COMEBACK_GRANT_FIELDS_READY` / `COMEBACK_GRANT_ENABLED`）を「一時的に」外さない

# UpsellTarget（販売CTA の手動選択）運用ポリシー

管理者が会員ごとに「どの販売導線を見せるか」を 1 つだけ選ぶ機能の運用記録。
判定そのものは `src/lib/upsell/upsellTarget.js` / `src/lib/premiumPlus/premiumPlusRelease.js` が正本。
仕様は `docs/spec.md`「販売CTA の自動判定を管理画面で確認する」を参照。

## 現状（2026-08-07 実測 / read-only）

| 項目 | 実測値 |
|---|---|
| Airtable `Customers.UpsellTarget` | **存在する**。`singleSelect` / choices `["auto","sanrenpuku","plus","none"]`（期待値と完全一致・過不足なし）|
| production env `UPSELL_TARGET_FIELD_READY` | **`1`（設定済み）** |
| 管理 API `list` の `upsellEnabled` | **`true`**（＝管理画面の 4 択ラジオは操作可能）|
| 明示指定されている会員 | **0 件**（`{"auto":16,"sanrenpuku":0,"plus":0,"none":0}`）|
| 顧客側の CTA への影響 | **なし**（全員 `auto` のため自動判定どおり）|

> ⚠️ **schema 変更・env 変更はいずれも不要**。列も env も既に整っている。
> 2026-08-07 の作業中、管理画面のコード（`disabled = !data.upsellEnabled`）だけを見て
> 「env 未設定・ラジオ disabled」と誤って報告した。**gate の状態は必ず env と API 応答で実測する。**

Customers の関連フィールドも作成済み: `PremiumPlusEligibility`(singleSelect) /
`PremiumPlusReleaseOverride`(singleSelect) / `PremiumPlusEligibleAt`(dateTime) /
`SanrenpukuPaidAt`(dateTime) / `LifetimeSanrenpuku`(checkbox) / `PaidAt`(dateTime)。

## 検証ポリシー（2026-08-07 確定）

### 🚫 実顧客レコードをテストに使わない

**テスト目的で実顧客のレコード・顧客体験を変更してはいけない。**
「ROUTE 対象外の 1 名を `auto → none → auto` で往復して確認する」といった手順は**禁止**。
値を元に戻しても、その間その会員の販売導線は実際に変わっている。

### 1. 既定は write なしの read-only 確認

有効化状態の確認は、次の 5 点だけで完結させる。**Airtable への書き込みは行わない。**

| 確認項目 | 方法 |
|---|---|
| production deploy が ready | Netlify の deploy 一覧（対象 commit が `ready`）|
| `upsellEnabled = true` | 管理 API `list` の応答フィールド |
| 管理画面の 自動 / 三連複 / Plus / なし が操作可能 | ラジオの `disabled` は `!data.upsellEnabled` 依存 → 上記が true なら操作可能 |
| 既存の `UpsellTarget` 明示値 0 件 | `list` の `upsellCounts`（`auto` 以外がすべて 0）|
| 顧客側表示の変化 0 | 全員 `auto` なら自動判定どおりで不変。未ログインの Premium Plus 3 経路が 404 のままであることも併せて確認 |

### 2. 実 write 検証が必要な場合は専用テストレコード

- **実顧客は使わない**
- **production Airtable へのテストレコード作成自体も、別途の明示承認まで実施しない**
- 承認が出るまでは read-only 確認だけで運用する

### 3. rollback

```
netlify env:unset UPSELL_TARGET_FIELD_READY --context production
# → 正式 Build Hook `analytics-keiba-auto-deploy` を curl POST で再デプロイ
```

コード変更は不要。`netlify deploy --build --prod` は `/premium-plus` に 401 regression を
生むため**使わない**。

> ⚠️ **gate は書き込み側だけを閉じる。読み取りは閉じない。**
> `isUpsellFieldEnabled` は `setUpsell` の書き込み可否にしか効かず、
> `readUpsellTarget` は gate を見ない（未設定・未知は `auto`）。
> したがって **unset しても、既に手動指定されている会員の指定は読み取り側で有効なまま**残る。
> 完全に自動判定へ戻すには、**unset の前に該当会員を `auto` へ戻す**必要がある。
> 現状は明示指定 0 件なので、いま unset すれば副作用なく元に戻る。

## 変更してはいけないこと

- 実顧客レコードをテスト目的で書き換えない
- `UpsellTarget` は**販売導線の選択のみ**。会員権・販売資格・決済状態を上書きしない
  （`assertOnlyPlusFields` と guard テストで構造的に保証している）
- 明示指定でも各商品の fail closed 条件（保有済み・blocked・契約状態）は再評価する
- 三連複 CTA と Plus CTA を同時に表示しない

## 関連

`docs/spec.md`「販売CTA の自動判定を管理画面で確認する」/
`docs/decisions.md` 2026-08-07 /
`src/lib/upsell/upsellExplain.js` / `src/lib/upsell/upsellIntegration.guard.test.mjs`

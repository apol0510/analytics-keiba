# Redis canary 運用手順（取り込みジョブ用 Lua の実 Redis 検証）

**この branch は canary だけを本番へ入れる。** 取り込みジョブ本体（親ジョブ・排他・正本・
管理画面）は含まない。それらは別 PR（#235）で Draft・BLOCKED のまま止めてある。

## なぜ Function なのか

`UPSTASH_REDIS_REST_URL` / `_TOKEN` は Netlify の **secret（`is_secret: true`）**で、
scope は `functions`・値を持つ context は `production` だけ。作成後は CLI でも API でも
値を取り出せず、`deploy-preview` / `branch-deploy` には値が無い。
**secret を Netlify の外へ出さずに production Redis を検証する唯一の方法**が、
この専用 Function を production へ置いて叩くこと。

## 触るもの・触らないもの

| | |
|---|---|
| 書き込む | `customer-import:canary:<canaryId>:` 配下 / `customer-import:canary-run:<canaryId>`（墓標） |
| **触らない** | `customer-import:lock:global` / `customer-import:fence` / `customer-import:email:*` / `customer-import:job:*` / `payemail:*` |
| 依存しない | Airtable / Customers / メール送信（import が存在しない） |

`createCanaryRunner` が名前空間外を**構造的に拒否**する。全キー列挙（`KEYS`）は禁止、
走査は `SCAN MATCH <prefix>*` のみ。**最大キー 32 / 最大コマンド 150 / TTL 15 分**。

## 安全装置

- **POST のみ**（GET は 405）＋ `x-admin-secret`
- **`CUSTOMER_IMPORT_CANARY_ENABLED=true` が無ければ常時 403**（認証より手前・Redis 初期化より前）
- `canaryId` は**サーバー側生成**（`^\d{14}-[a-f0-9]{8}$` 以外は拒否）
- `run` は確認文字列 **`REDIS-CANARY <canaryId>`** 必須
- **1 canaryId につき run はちょうど 1 回**（墓標を `SET NX`。timeout でも再実行不可）
- `preview` は **Redis へ一切接続しない**（同期関数で runner も `await` も持たない）
- URL / token / Redis の値 / メール / hash 全文を**返さない・ログにも出さない**

## production deploy は **3 回で固定**（条件分岐なし）

env 変更は **redeploy 必須**として扱う（Netlify CLI の警告 + AK 実績: 入金確認メール v2 の
各境界はすべて `env 変更 → redeploy`）。

| # | source | env 状態 | deploy 方法 | 確認 | rollback |
|---|---|---|---|---|---|
| **D1** | 本 branch の固定 SHA | `CANARY_ENABLED` **unset** | `netlify deploy --build --prod --context production` | Function が存在し `preview` が **403** | main を Build Hook で 1 回 |
| **D2** | **D1 と同じ固定 SHA** | `CANARY_ENABLED=true` 設定**後** | 同上（再 deploy） | `preview` が **200** | main を Build Hook で 1 回 |
| **D3** | `origin/main` の固定 HEAD | **unset 済み** | **Build Hook**（AK 標準） | Function が **404** / env unset / 公開 SHA が origin/main | — |

**順序は fail-closed**（コードが先・env が後）。**Function 未配備で env を true にしない。**

> ⚠️ 手動 deploy は `commit_ref` が origin/main と一致しない deploy を作る。
> AK は過去に手動 deploy を使っていない。**D3 で必ず origin/main へ戻す。**

## 実行手順

1. **D1** → `action:'preview'` が **403** であることを確認
2. `netlify env:set CUSTOMER_IMPORT_CANARY_ENABLED true --context production`
3. **D2**（同じ SHA を再 deploy）→ `preview` が **200** であることを確認
4. `preview` で **canaryId を発行**（Redis 非接触）
5. `run` を **exactly 1 回**（`REDIS-CANARY <canaryId>`）
6. `status` で結果と残存を確認
7. `cleanup` → **canary データ prefix 残存 0**（墓標は残る＝再実行は拒否されたまま）
8. `finalize`（`REDIS-CANARY-FINALIZE <canaryId>`）→ **墓標も 0**
9. `netlify env:unset CUSTOMER_IMPORT_CANARY_ENABLED --context production`
10. **D3** → `preview` が **404**・env unset・公開 SHA が origin/main を確認

**Redis 異常・cleanup 異常が出たら追加 run をしない。** 残存キーは prefix からの相対名
（値・PII なし）だけを報告して停止する。

## 墓標と「残存 0」の両立

| キー | cleanup | finalize |
|---|---|---|
| 検証データ `customer-import:canary:<id>:` | **削除**（残存 0） | 残存 0 を再確認 |
| 実行済み墓標 `customer-import:canary-run:<id>` | **残す**（再実行を拒否） | **削除**（最終 0） |

`finalize` は **Function 無効化の直前に 1 度だけ**。墓標を消した後は Redis 側で
同一 canaryId の再実行を拒否できないため、直ちに手順 9・10 へ進むこと。

## DBSIZE の扱い

**参考値。合否判定に使わない。** 他の AK 機能（入金確認メール等）が同時に Redis へ書く
可能性があるため、実行前と一致しないだけでは異常と断定しない。
正本の判定は **canary prefix の作成数・削除数・残存 0**。

## 検証対象の同一性

`src/lib/crm/importCanaryContracts.js` は、取り込みジョブ側の実装
（PR #235 の `importClaimStore.js` / `importJobReconcile.js`）から**改変せず抜き出した**もの。
**両者は常に同一でなければならない。** 取り込みジョブ本体を本番へ入れる際に、
同一性を検証する guard を追加すること。

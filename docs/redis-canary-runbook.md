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
- **`preview` / `run` は `CUSTOMER_IMPORT_CANARY_ENABLED=true` のときだけ許可**（無効なら 403）。
  ゲートは **Redis 初期化より前**（下の「action 別ゲート」を参照）
- `canaryId` は**サーバー側生成**（`^\d{14}-[a-f0-9]{8}$` 以外は拒否）
- `run` は確認文字列 **`REDIS-CANARY <canaryId>`** 必須
- **1 canaryId につき run はちょうど 1 回**（墓標を `SET NX`。timeout でも再実行不可）
- `preview` は **Redis へ一切接続しない**（同期関数で runner も `await` も持たない）
- URL / token / Redis の値 / メール / hash 全文を**返さない・ログにも出さない**

## action 別ゲート（**窓を作らない順序**）

| action | `enabled=true` | `enabled=false` / unset |
|---|---|---|
| `preview` / `run` | 許可 | **403** `canary_disabled` |
| `status` / `cleanup` | 許可 | 許可 |
| `finalize` | **403** `canary_still_enabled` | 許可 |

**すべての action で `x-admin-secret` 必須。** ゲートは **Redis 初期化より前**に判定する。

> ### なぜ finalize を逆向きに塞ぐのか
>
> env 変更は **redeploy して初めて production Function へ反映される**。
> したがって `finalize → env unset → deploy` の順にすると、
> **墓標が消えているのに run がまだ有効**な時間帯が生まれ、
> その deploy が失敗すれば有効なまま残る。
>
> そこで `finalize` は **`enabled` が false / unset のときだけ**通す。
> 墓標を消せるのは「env を unset し、その反映 deploy が完了した後」だけになり、
> **その時点で run は必ず 403**。窓が構造的に生じない。

## production deploy は **4 回で固定**（条件分岐なし）

| # | source | SHA | env | 方法 | rollback |
|---|---|---|---|---|---|
| **D1** | `chore/customer-import-redis-canary` | 固定 SHA | `CANARY_ENABLED` **unset** | `netlify deploy --build --prod --context production` | main を Build Hook 1 回 |
| **D2** | **同 branch・同 SHA** | 同一 | `=true` 設定**後** | 同上 | env unset → D3 |
| **D3** | **同 branch・同 SHA** | **unset 後** | 同上 | main を Build Hook 1 回 |
| **D4** | `main` | **実行直前に再取得した origin/main HEAD** | 3 つとも unset | **Build Hook**（AK 標準） | — |

**順序は fail-closed**（コードが先・env が後）。**Function 未配備で env を true にしない。**

### 事前 gate（D1 の前に必ず確認）

- repo / branch / HEAD / working tree
- PR #236 HEAD = 固定 SHA、CI green
- **origin/main HEAD を実行直前に再取得して固定**
- production env: `CUSTOMER_IMPORT_CANARY_ENABLED` / `CUSTOMER_IMPORT_WRITE_ENABLED` /
  `CUSTOMER_IMPORT_JOB_ENABLED` が**すべて unset**
- 日次 Build Hook や他の deploy が進行中でない
- rollback 用の main Build Hook が使える

## 実行手順

1. **D1**（コード配備・env unset）
   → `preview` と `run` が **403 `canary_disabled`** / Redis write **0**
2. `netlify env:set CUSTOMER_IMPORT_CANARY_ENABLED true --context production`
3. **D2**（同一 SHA を再 deploy）
   → `preview` **200**
4. `preview` で **canaryId 発行**（Redis 非接触）
5. `run` を **exactly 1 回**（`REDIS-CANARY <canaryId>`）
6. `status` で結果確認
7. `cleanup` → **データ prefix 残存 0 / 墓標 1 件残存**
8. `netlify env:unset CUSTOMER_IMPORT_CANARY_ENABLED --context production`
9. **D3**（同一 SHA を再 deploy。**Function は残したまま無効状態を反映**）
   → `preview` / `run` が **403** であることを確認
10. **`finalize` を exactly 1 回**（`REDIS-CANARY-FINALIZE <canaryId>`）
    → **データ prefix 0 / 墓標 0**
11. 再度 `preview` / `run` が **403** であることを確認
12. **D4**（実行直前に再取得した origin/main HEAD を Build Hook で 1 回）
    → Function **404** / 3 つの env すべて unset / 公開 SHA 復帰 / canary 残存 0

### D1〜D3 の間に origin/main が進んだ場合

- **D4 の戻し先は決め打ちにせず、最新の origin/main を再確認する**
- 想定外のコード変更が入っていたら **D4 の前に停止して差分を報告**
- canary の無効化を優先する必要があるときは、**まず D3 で 403 に戻す**

### 異常時

`run` / `cleanup` / Redis が異常なら **追加 run をしない**。
env 閉鎖（unset → D3）を優先し、残存キーは prefix からの相対名（値・PII なし）だけ報告する。

## 墓標と「残存 0」の両立

| キー | cleanup | finalize |
|---|---|---|
| 検証データ `customer-import:canary:<id>:` | **削除**（残存 0） | 残存 0 を再確認 |
| 実行済み墓標 `customer-import:canary-run:<id>` | **残す**（再実行を拒否） | **削除**（最終 0） |

`finalize` は **env を無効化し、その反映 deploy（D3）を終えた後にしか通らない**（有効なら 403）。
そのため墓標を消す時点で `run` は必ず 403 で、**「墓標が無いのに run できる時間帯」は生じない**。
D3 が失敗した場合は Function が有効なまま残るが、その状態では `finalize` が 403 で拒否されるので
墓標は消えない（＝ exactly-once は保たれたまま）。復帰は main の Build Hook 1 回。

## DBSIZE の扱い

**参考値。合否判定に使わない。** 他の AK 機能（入金確認メール等）が同時に Redis へ書く
可能性があるため、実行前と一致しないだけでは異常と断定しない。
正本の判定は **canary prefix の作成数・削除数・残存 0**。

## 検証対象の同一性

`src/lib/crm/importCanaryContracts.js` は、取り込みジョブ側の実装
（PR #235 の `importClaimStore.js` / `importJobReconcile.js`）から**改変せず抜き出した**もの。
**両者は常に同一でなければならない。** 取り込みジョブ本体を本番へ入れる際に、
同一性を検証する guard を追加すること。

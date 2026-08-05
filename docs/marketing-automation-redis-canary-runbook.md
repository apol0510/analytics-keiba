# メルマガ自動化 Redis canary 運用手順

**この branch は Redis primitive だけを本番へ入れる。** 管理 UI・管理 API・scheduler・
enqueue 共通化・Airtable 処理は含まない。それらは PR #237 で Draft のまま止めてある。

## 触るもの・触らないもの

| | |
|---|---|
| 書き込む | `ak:marketing-automation:canary:<canaryId>:` 配下 / `ak:marketing-automation:canary-run:<canaryId>`（墓標） |
| **触らない** | `ak:marketing-automation:def:*` / `run:*` / `recipient:*` / `index:active` / `lock:*` / `fence` / `payemail:*` / `customer-import:*` / KMA 系 |
| 依存しない | Airtable / Customers / メール送信（import が存在しない） |

`createCanaryRunner` が名前空間外を**構造的に拒否**する。`KEYS` 禁止、走査は `SCAN MATCH <prefix>*` のみ。
**最大キー 24 / 最大コマンド 120 / TTL 15 分**（墓標は 24 時間）。

**実アドレス・氏名・顧客 ID を使わない。** 受信者は `canary-<n>@example.invalid` の
固定ダミーを sha256 したものだけ。URL / token / Redis の値 / hash 全文は出力しない。

## 検証対象が PR #237 と同一であること

`automationCanaryContracts.js` は PR #237 の `automationStore.js` から**改変せず抜き出した**もの。
`EXPECTED_SHA256` に抽出時点の sha256 を記録し、テストが一致を固定している。
**取り違えた Lua を本番で走らせない。**

## action 別ゲート（窓を作らない順序）

| action | `ENABLED=true` | `false` / unset |
|---|---|---|
| `preview` / `run` | 許可 | **403** `canary_disabled` |
| `status` / `cleanup` | 許可 | 許可 |
| `finalize` | **403** `canary_still_enabled` | 許可 |

**すべての action で `x-admin-secret` 必須。POST のみ。** ゲートは **Redis client 初期化より前**。

> `finalize`（墓標の削除）は **env を無効化し、その反映 deploy を終えた後**にしか通らない。
> 墓標を消す時点で `run` は必ず 403 になり、「墓標が無いのに run できる時間帯」が生じない。

## production deploy と env の開閉（4 回で固定）

env 変更は **redeploy 必須**として扱う（Netlify の仕様・AK の実績）。

| # | source | env | 方法 | 確認 |
|---|---|---|---|---|
| **D1** | 本 branch の固定 SHA | `ENABLED` **unset** | `netlify deploy --build --prod --context production` | Function 存在・`preview`/`run` が **403** |
| **D2** | **同 SHA** | `ENABLED=true` 設定後 | 同上 | `preview` **200** → `run` ×1 → `status` → `cleanup` |
| **D3** | **同 SHA** | **unset 後** | 同上 | `preview`/`run` **403** → `finalize` ×1 → データ 0・墓標 0 |
| **D4** | `main` | 3 つとも unset | **Build Hook** | Function **404** / 公開 SHA が origin/main |

⚠️ Netlify CLI は git worktree で `base` を解決できないため、**通常 clone から実行する**。
⚠️ `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**今回追加・変更しない**。

### 事前 gate

repo / branch / HEAD / working tree / CI green / origin/main HEAD を実行直前に再取得 /
`MARKETING_AUTOMATION_REDIS_CANARY_ENABLED` と `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` が
**ともに unset** / 他 deploy 非進行 / Build Hook 可用。

## 結果の 3 経路（取り逃し対策）

直前の顧客取込 canary では **run の HTTP 応答を出力処理ミスで失い**、各項目の PASS/FAIL を
証明できなかった。run exactly 1・retry 0 ではやり直しが効かないので、**同じ結果を 3 経路**で
復元できるようにする。

| # | 経路 | 取得方法 |
|---|---|---|
| 1 | **HTTP 応答** | `run` の戻り値（専用ファイルへ `-o`） |
| 2 | **Redis result** | `ak:marketing-automation:canary:<canaryId>:d:result` を `status` が復元 |
| 3 | **Function ログ** | run 完了時の 1 行 JSON（`marketing_automation_redis_canary_result`） |

**run は cleanup しない。** result はデータ prefix 内にあり、`cleanup` で一緒に消える。
3 経路の一致を確認するまで `cleanup` を実行しないこと。

`status` は result が**無い / 壊れている / schema 違い**なら
`result_unavailable` / `result_invalid` / `result_schema_mismatch` を返し、**PASS 扱いにしない**。

保存内容に **URL / token / Redis 値 / アドレス / hash 全文 / stack / 顧客情報は入らない**
（`assertResultSafe` が構造的に拒否）。ログにも **canaryId 全文・key・値**を出さない（末尾 8 桁のみ）。

## curl の出力分離（**body と HTTP status を同じファイルへ混ぜない**）

```bash
# 0) 作業ディレクトリ（D4 完了まで消さない）
CANARY_DIR=$(mktemp -d /tmp/mkauto-canary.XXXXXX); echo "$CANARY_DIR"
URL=https://analytics.keiba.link/.netlify/functions/admin-marketing-automation-redis-canary
# SECRET は履歴・transcript へ出さない（環境変数で渡す）
read -rs SECRET

# 1) preview（Redis 非接触）— body と status を分ける
PREV_HTTP=$(curl -sS -o "$CANARY_DIR/preview.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d '{"action":"preview"}')
echo "preview HTTP=$PREV_HTTP"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CANARY_DIR/preview.json" \
  && echo "preview parse OK"
CID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).canaryId' "$CANARY_DIR/preview.json")
echo "canaryId=$CID"

# 2) run を exactly 1 回（retry 0）— **body と status を別々に**
RUN_HTTP=$(curl -sS -o "$CANARY_DIR/run.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d "{\"action\":\"run\",\"canaryId\":\"$CID\",\"confirmation\":\"MKAUTO-CANARY $CID\"}")
echo "run HTTP=$RUN_HTTP"
# ⚠️ parse に失敗しても **ファイルを消さない**
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CANARY_DIR/run.json" \
  && echo "run parse OK" || echo "run parse FAILED（ファイルは保持）"

# 3) status で Redis result を復元（read-only）
ST_HTTP=$(curl -sS -o "$CANARY_DIR/status.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d "{\"action\":\"status\",\"canaryId\":\"$CID\"}")
echo "status HTTP=$ST_HTTP"

# 4) Function ログを取得（3 経路目）
netlify logs --source functions \
  --function admin-marketing-automation-redis-canary --since 30m \
  | tee "$CANARY_DIR/function.log"
```

**禁止**: `curl -o file -w '%{http_code}'` の出力を**同じファイルへ**書くこと
（前回これで JSON が壊れ、結果を失った）。`-o` と `-w` は必ず分ける。

**一時ファイルは D4 完了まで保持する。** `trap ... EXIT` での自動削除は使わない。
結果の確認が全て終わってから手動で `rm -rf "$CANARY_DIR"` する。
`SECRET` を `echo` / `set -x` / transcript へ出さない。

## 実行手順

1. **D1** → `preview` / `run` が **403** / Redis write 0
2. `netlify env:set MARKETING_AUTOMATION_REDIS_CANARY_ENABLED true --context production`
3. **D2** → `preview` **200** → canaryId 発行（Redis 非接触）
4. `run` を **exactly 1 回**（`MKAUTO-CANARY <canaryId>`）・**retry 0**
   → 応答を `run.json` へ保存し、parse 成功を確認
5. `status` → **保存済み result を復元**し、`run.json` と
   `overallOk` / チェック名 / 件数 / ok が一致することを確認
6. **Function ログ**の 1 行 JSON で `overallOk` とチェック数が一致することを確認
7. **3 経路が一致してから** `cleanup`（データ prefix 残存 0 / 墓標 1）
8. `netlify env:unset MARKETING_AUTOMATION_REDIS_CANARY_ENABLED --context production`
9. **D3** → `preview` / `run` が **403** を確認 → `finalize`
   → **データ 0 / 墓標 0** → 再度 403 を確認
10. **D4** → Function **404** / 公開 SHA 復帰
11. すべて確認できてから一時ファイルを削除

### 合格条件（**すべて満たさなければ PASS にしない**）

- `run` が **HTTP 200**
- 応答 `overallOk=true`
- `status` の result `overallOk=true`
- Function ログ `overallOk=true`
- **3 経路のチェック名・件数・ok が一致**
- Phase 0 / Phase 1 の各チェックが**すべて ok=true**
- `runCount=1` / `retryCount=0` / prefix 外操作 **0**
- cleanup 後 データ **0**・墓標 **1**
- finalize 後 データ **0**・墓標 **0**

### 3 経路のいずれかが欠落・不一致のとき

- **Phase 1 成功と判定しない**
- **追加 run をしない**
- `status` と Function ログの取得を続ける
- 復元できなければ **env 閉鎖 → cleanup → finalize → main 復帰**まで行い、
  **canary 未達**として報告する

## canary 項目

**Phase 0**: PING / DBSIZE（**参考値のみ**・合否に使わない）/ `EVAL return 1` / レイテンシ

**Phase 1**:
`SET NX` 排他 / fencing token 単調増加 / **Definition CAS 相当の Lua**（新規作成・
version 一致更新 OK・不一致 CONFLICT）/ 所有権再検証（OK / STOLEN / LOST）/
他人の token で解放不可 / deterministic runId の二重開始拒否 /
recipient hash claim の二重取得拒否 / prefix 外 read・write・delete 拒否 /
timeout・不明応答の fail-closed / cleanup 後データ残存 0 / finalize 後 墓標 0

## Function の削除

canary 完了後は **D4（main を Build Hook で 1 回）**で本番から消える
（main にこの Function は存在しないため、削除用の特別な commit は不要）。
即時無効化は `env:unset` + 反映 deploy。

## 限界

**Lua 本文はローカルテストで実行していない**（サーバ側でしか動かないため、
fake は識別子で分岐して意味論を再現している）。**Lua 本文の正しさは本 canary でのみ確認できる。**

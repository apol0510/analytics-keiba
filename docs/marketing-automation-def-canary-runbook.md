# メルマガ自動化 Definition 保存 canary 運用手順

**この branch は Definition の保存・取得・CAS だけを本番へ入れる。** 管理 UI・管理 API・
scheduler・enqueue 共通化・`admin-marketing.js` の変更・Airtable 処理・メール送信は含まない。
それらは PR #237 で Draft のまま止めてある。

先行の Redis primitive canary（PR #238）は `ak:marketing-automation:canary:` という
**専用 prefix の中だけ**で Lua を確かめた。本 canary は一段進めて、**本番と同じキー空間**
（`def:*` と `index:active`）へ canary 専用 Definition を **1 件だけ**作り、
実運用と同じ形で作成 → get → CAS 更新 → pause → cancel → index 追加・除去 → 削除を確かめる。

## 触るもの・触らないもの

| | |
|---|---|
| 書き込む | `ak:marketing-automation:def:canary-<canaryId>` のみ / `ak:marketing-automation:index:active` の **canary member 1 つだけ** / `ak:marketing-automation:def-canary:<canaryId>:result`（結果・TTL 24h） |
| **触らない** | 他の `def:*` / `run:*` / `recipient:*` / `lock:*` / `fence` / `canary:*` / `payemail:*` / `customer-import:*` / KMA 系 |
| 依存しない | Airtable / Customers / ScheduledEmails / CampaignDeliveries / メール送信（import が存在しない） |

`createDefCanaryStore` の `assertKey` / `assertMember` が上記以外を**構造的に拒否**する。
`KEYS` / `SCAN` は使わない。使えるコマンドは `GET / SET / DEL / EXISTS / SADD / SREM / SMEMBERS / EVAL` のみ。

**実顧客・実 campaign を使わない。PII なし。** campaignId は `canary-campaign` の固定ダミー、
`automationId` は `canary-<canaryId>` 固定。`assertNoPii` が Definition 内のアドレス様文字列を拒否する。
URL / token / Redis の値 / hash 全文は応答にもログにも出さない。

### `index:active` は共有キー

`index:active` だけは**他の Definition と共有**する。SADD / SREM は canary member 1 つに限定し、
実行前後で `compareIndexExcludingCanary` により**他の member が 1 つも変わっていないこと**を突き合わせる。
なお main にメルマガ自動化本体は存在しないので、本番の `index:active` は**現時点で空のはず**である
（空でなければ想定外 → 中止する）。

## 検証対象が PR #237 と同一であること

`automationDefCanaryStore.js` の CAS Lua は PR #237 の `automationStore.js` から
**改変せず抜き出した**もの。`EXPECTED_CAS_SHA256` に抽出時点の sha256 を記録し、テストが一致を固定する。
`DEF_FIELDS` / key 生成規則も同一。**取り違えた実装を本番で走らせない。**

## action 別ゲート（窓を作らない順序）

| action | `ENABLED=true` | `false` / unset |
|---|---|---|
| `preview` / `run` | 許可 | **403** `def_canary_disabled` |
| `status` / `cleanup` | 許可 | 許可 |
| `finalize` | **403** `def_canary_still_enabled` | 許可 |

**すべての action で `x-admin-secret` 必須。POST のみ。** ゲートは **Redis client 初期化より前**。

> 二重実行の防止は**墓標ではなく canary Definition 自身**が担う。`run` は最初に
> `EXISTS` を確認し、既にあれば `409 already_exists` で止まる。
> `cleanup` 後は再 run が可能になるため、**cleanup は 3 経路一致を確認した後にだけ行い、
> その直後に env を閉じる**。`finalize`（残存 0 の最終確認）は env 無効化の反映後にしか通らない。

⚠️ `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**今回追加・変更しない**（Function が参照もしない）。

## production deploy と env の開閉（4 回で固定）

env 変更は **redeploy 必須**として扱う（Netlify の仕様・AK の実績）。

| # | source | env | 方法 | 確認 |
|---|---|---|---|---|
| **D1** | 本 branch の固定 SHA | `ENABLED` **unset** | `netlify deploy --build --prod --context production` | Function 存在・`preview`/`run` が **403** |
| **D2** | **同 SHA** | `ENABLED=true` 設定後 | 同上 | `preview` **200** → `run` ×1 → `status` → `cleanup` |
| **D3** | **同 SHA** | **unset 後** | 同上 | `preview`/`run` **403** → `finalize` ×1 → 残存 0 |
| **D4** | `main` | 追加 env なし | **Build Hook** | Function **404** / 公開 SHA が origin/main |

⚠️ Netlify CLI は git worktree で `base` を解決できないため、**通常 clone から実行する**。

### 事前 gate

repo / branch / HEAD / working tree clean / CI green / origin/main HEAD を実行直前に再取得 /
`MARKETING_AUTOMATION_DEF_CANARY_ENABLED` と `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` が
**ともに unset** / 他 deploy 非進行 / Build Hook 可用 / `index:active` が空。

## 結果の 3 経路（取り逃し対策）

顧客取込 canary では **run の HTTP 応答を出力処理ミスで失い**、各項目の PASS/FAIL を証明できなかった。
run exactly 1・retry 0 ではやり直しが効かないので、**同じ判定を 3 経路**で復元できるようにする。

| # | 経路 | 取得方法 |
|---|---|---|
| 1 | **HTTP 応答** | `run` の戻り値（専用ファイルへ `-o`） |
| 2 | **Redis result** | `ak:marketing-automation:def-canary:<canaryId>:result` を `status` が復元 |
| 3 | **Function ログ** | run 完了時の 1 行 JSON（`marketing_automation_def_canary_result`） |

3 経路とも `overallOk` と `checks[].name` / `ok` を同じ形で持つ（`compareResultPaths` で突合できる）。
`status` は result が**無い / 壊れている / schema 違い / 別 run のもの**なら
`result_unavailable` / `result_invalid` / `result_schema_mismatch` を返し、**PASS 扱いにしない**。
保存内容に URL / token / Redis 値 / アドレス / hash 全文 / stack は入らない（`assertResultSafe` が拒否）。

**`run` は cleanup しない。** result は `cleanup` / `finalize` で消えるので、
**3 経路の一致を確認するまで `cleanup` を実行しない。**

## curl の出力分離（**body と HTTP status を同じファイルへ混ぜない**）

```bash
# 0) 作業ディレクトリ（D4 完了まで消さない）
CANARY_DIR=$(mktemp -d /tmp/mkauto-def-canary.XXXXXX); echo "$CANARY_DIR"
URL=https://analytics.keiba.link/.netlify/functions/admin-marketing-automation-def-canary
# SECRET は履歴・transcript へ出さない
read -rs SECRET

# 1) preview（Redis 非接触）
PREV_HTTP=$(curl -sS -o "$CANARY_DIR/preview.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d '{"action":"preview"}')
echo "preview HTTP=$PREV_HTTP"
CID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).canaryId' "$CANARY_DIR/preview.json")
echo "canaryId=$CID"

# 2) run を exactly 1 回（retry 0）— **body と status を別々に**
RUN_HTTP=$(curl -sS -o "$CANARY_DIR/run.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d "{\"action\":\"run\",\"canaryId\":\"$CID\",\"confirmation\":\"DEF-CANARY $CID\"}")
echo "run HTTP=$RUN_HTTP"
# ⚠️ parse に失敗しても **ファイルを消さない**
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$CANARY_DIR/run.json" \
  && echo "run parse OK" || echo "run parse FAILED（ファイルは保持）"

# 3) status で Redis result を復元（read-only）
ST_HTTP=$(curl -sS -o "$CANARY_DIR/status.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d "{\"action\":\"status\",\"canaryId\":\"$CID\"}")
echo "status HTTP=$ST_HTTP"

# 4) Function ログ（3 経路目）
netlify logs --source functions \
  --function admin-marketing-automation-def-canary --since 30m \
  | tee "$CANARY_DIR/function.log"
```

**禁止**: `curl -o file -w '%{http_code}'` の出力を**同じファイルへ**書くこと（前回これで JSON を壊した）。
**一時ファイルは D4 完了まで保持する。** `trap ... EXIT` での自動削除は使わない。
`SECRET` を `echo` / `set -x` / transcript へ出さない。

## 実行手順

1. **D1** → `preview` / `run` が **403** / Redis write 0
2. `netlify env:set MARKETING_AUTOMATION_DEF_CANARY_ENABLED true --context production`
3. **D2** → `preview` **200** → canaryId 発行（Redis 非接触）
4. `run` を **exactly 1 回**（`DEF-CANARY <canaryId>`）・**retry 0** → `run.json` の parse 成功を確認
5. `status` → 保存済み result を復元し、`run.json` と `overallOk` / チェック名 / 件数 / ok が一致
6. **Function ログ**の 1 行 JSON でも一致を確認
7. **3 経路が一致してから** `cleanup`（`残存0=true`）
8. `netlify env:unset MARKETING_AUTOMATION_DEF_CANARY_ENABLED --context production`
9. **D3** → `preview` / `run` が **403** → `finalize` → `finalized=true`（Definition 0 / 結果 0 / index 除去済）
10. **D4** → Function **404** / 公開 SHA 復帰
11. すべて確認できてから一時ファイルを削除

### 合格条件（**すべて満たさなければ PASS にしない**）

- `run` が **HTTP 200** / 応答 `overallOk=true` / `resultSaved=true`
- `status` の `結果復元=true` かつ result `overallOk=true`
- Function ログ `overallOk=true`
- **3 経路のチェック名・件数・ok・overallOk が一致**
- 9 項目（10 チェック）が**すべて ok=true**
- `runCount=1` / `retryCount=0` / 許可キー外の操作 **0**
- `indexOtherMembers.same=true`（他 member 不変）
- cleanup 後 `残存0=true`、finalize 後 `finalized=true`

### 3 経路のいずれかが欠落・不一致のとき

- **成功と判定しない**
- **追加 run をしない**
- `status` と Function ログの取得を続ける
- 復元できなければ **env 閉鎖 → cleanup → finalize → main 復帰**まで行い、**canary 未達**として報告する

## canary 項目（run の 10 チェック）

1. Definition を作成できる（`expectedVersion=''` で新規作成）
2. get で読み戻せる / 2b. PII を含まない
3. version 一致なら更新できる
4. version 不一致は **CONFLICT** で拒否（上書きされない）
5. `index:active` へ追加できる
6. pause（PAUSED へ遷移）できる
7. cancel（CANCELLED へ遷移）できる
8. `index:active` から除去できる
9. `index` の他 member を変えていない

## Function の削除

canary 完了後は **D4（main を Build Hook で 1 回）**で本番から消える
（main にこの Function は存在しないため、削除用の commit は不要）。即時無効化は `env:unset` + 反映 deploy。

## 限界

**Lua 本文はローカルテストで実行していない**（サーバ側でしか動かないため、fake は意味論を再現している）。
**Lua 本文の正しさは本番 canary でのみ確認できる。** また `SET`/`EVAL` の CAS は
Upstash の単一ノード上での逐次実行に依存しており、**分散環境の linearizability を証明するものではない**。

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
| 書き込む | `ak:marketing-automation:def:canary-<canaryId>` のみ / `ak:marketing-automation:index:active` の **canary member 1 つだけ** / `ak:marketing-automation:def-canary:<canaryId>:result`（結果・TTL 24h） / `ak:marketing-automation:def-canary:<canaryId>:run`（**墓標**・TTL 24h） |
| **触らない** | 他の `def:*` / `run:*` / `recipient:*` / `lock:*` / `fence` / `canary:*` / `payemail:*` / `customer-import:*` / KMA 系 |
| 依存しない | Airtable / Customers / ScheduledEmails / CampaignDeliveries / メール送信（import が存在しない） |

`createDefCanaryStore` の `assertKey` / `assertMember` が上記以外を**構造的に拒否**する。
`KEYS` / `SCAN` は使わない。使えるコマンドは `GET / SET / DEL / EXISTS / SADD / SREM / SMEMBERS / EVAL` のみ。

**実顧客・実 campaign を使わない。PII なし。** campaignId は `canary-campaign` の固定ダミー、
`automationId` は `canary-<canaryId>` 固定。`assertNoPii` が Definition 内のアドレス様文字列を拒否する。
URL / token / Redis の値 / hash 全文は応答にもログにも出さない。

### `index:active` は共有キー

`index:active` だけは**他の Definition と共有**する。SADD / SREM は canary member 1 つに限定し、
実行前後で `compareIndexExcludingCanary` により **canary 以外の member が完全一致すること**を突き合わせる。

- **既存 member の件数に前提を置かない。** 0 件でも複数件でも同じ厳密さで比較する
  （「空だから安全」という素通しはしない）。件数一致ではなく**集合そのものの一致**を見る。
  1 つでも増減・入替があれば `same=false` で不合格。増減の内訳は `added` / `removed` に出る。
- **取得失敗・不正応答は fail-closed。** `SMEMBERS` が配列でない / 文字列以外を含む / 通信断のときは
  `index_unavailable` で中断し、**空配列へ丸めない**。before / after が配列でなければ `same=false`。

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

### run exactly 1 の構造保証（墓標）

`run` は最初に **墓標 `def-canary:<canaryId>:run` を `SET NX` で 1 回だけ**取る。
取れなければ `409 already_run` で即停止する（Definition の作成にも Redis の書き込みにも進まない）。
Definition の `EXISTS` 確認は二重の副次ガードとして残す。

| 段階 | 墓標 | 再 run |
|---|---|---|
| `run` 直後 | **あり** | 不可（`already_run`） |
| `cleanup` 後 | **あり（消さない）** | 不可（`already_run`） |
| `finalize` 後 | なし | **その時点で env は無効 = `run` は 403** |

> `cleanup` は Definition・結果・index の canary member **だけ**を消し、**墓標は残す**。
> 墓標を消すのは **env を無効化し、その反映 deploy を終えた後の `finalize`** だけ。
> → 「墓標が無いのに run できる時間帯」が生じない。

### cleanup は 3 経路の完全一致の前に実行できない（構造ゲート）

`cleanup` は保存済み結果を読み、**HTTP 応答と Function ログの `checks[{name, ok}]` をそのまま**
受け取って突き合わせてからでないと削除しない。

**渡すもの**（HTTP 応答・ログの値を加工せず、順序どおりに）:

| フィールド | 内容 |
|---|---|
| `httpOverallOk` / `httpChecks` | `run.json` の `overallOk` と `checks`（`{name, ok}` の配列） |
| `logOverallOk` / `logChecks` | Function ログ 1 行 JSON の `overallOk` と `checks` |

**一致判定は完全一致のみ**。Redis 保存結果に対して **件数・順序・`name`・`ok`・`overallOk` の
すべて**が一致した場合だけ削除する。

| 状況 | 応答 | 削除 |
|---|---|---|
| 結果を復元できない / 壊れている / schema 違い / 別 run | `409` `result_unavailable` 等 | **しない** |
| `checks` 欠落・空・型違い | `409` `paths_not_verified`（`missing_checks` / `invalid_check`） | **しない** |
| **check 名の重複** | `409` `paths_not_verified`（`duplicate_check_name`） | **しない** |
| 件数違い | `409`（`check_count_mismatch`） | **しない** |
| **順序違い・name 違い** | `409`（`check_name_mismatch`） | **しない** |
| `ok` が 1 つでも違う | `409`（`check_ok_mismatch`） | **しない** |
| `overallOk` 違い | `409`（`overall_ok_mismatch`） | **しない** |
| 3 経路が完全一致 | `200` `pathsVerified=true` | する（**墓標は残す**） |

> ⚠️ **boolean と件数だけの照合は禁止・かつ受け付けない。**
> `httpOverallOk` / `logOverallOk` / `checkCount` だけを渡しても `paths_not_verified` になる。
> 「件数と overallOk は合うが中身が違う」偽の一致を構造的に排除するため。

不一致の内訳は応答の `不一致` に `{path, reason, detail}` で返る（`detail` は違反した index / check 名）。
結果が復元できないときは **cleanup せず、env 閉鎖 → 反映 deploy → `finalize` で回収**する。

⚠️ `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**今回追加・変更しない**（Function が参照もしない）。

## production deploy と env の開閉（4 回で固定）

env 変更は **redeploy 必須**として扱う（Netlify の仕様・AK の実績）。

| # | source | env | 方法 | 確認 |
|---|---|---|---|---|
| **D1** | 本 branch の固定 SHA | `ENABLED` **unset** | `netlify deploy --build --prod --context production` | Function 存在・`preview`/`run` が **403** |
| **D2** | **同 SHA** | `ENABLED=true` 設定後 | 同上 | `preview` **200** → `run` ×1 → `status` → `cleanup` |
| **D3** | **同 SHA** | **unset 後** | 同上 | `preview`/`run` **403** → `finalize` ×1 → **墓標含め残存 0** |
| **D4** | `main` | 追加 env なし | **Build Hook** | Function **404** / 公開 SHA が origin/main |

⚠️ Netlify CLI は git worktree で `base` を解決できないため、**通常 clone から実行する**。

### 事前 gate

repo / branch / HEAD / working tree clean / CI green / origin/main HEAD を実行直前に再取得 /
`MARKETING_AUTOMATION_DEF_CANARY_ENABLED` と `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` が
**ともに unset** / 他 deploy 非進行 / Build Hook 可用。

⚠️ **`index:active` の中身は事前条件にしない。** 空でも複数件でも実行してよい。
要求するのは「実行前後で canary 以外の member が完全一致すること」だけ。

## 結果の 3 経路（取り逃し対策）

顧客取込 canary では **run の HTTP 応答を出力処理ミスで失い**、各項目の PASS/FAIL を証明できなかった。
run exactly 1・retry 0 ではやり直しが効かないので、**同じ判定を 3 経路**で復元できるようにする。

| # | 経路 | 取得方法 |
|---|---|---|
| 1 | **HTTP 応答** | `run` の戻り値（専用ファイルへ `-o`） |
| 2 | **Redis result** | `ak:marketing-automation:def-canary:<canaryId>:result` を `status` が復元 |
| 3 | **Function ログ** | run 完了時の 1 行 JSON（`marketing_automation_def_canary_result`）を `netlify logs --source functions --function <name> --since <t> --json` で取得し、JSON Lines から抽出 |

⚠️ `netlify logs:function` は **live stream 専用**（deprecated）で、実行済みの run のログは取れない。
必ず `netlify logs --since ...` を使い、`--since` は run の時刻を含む幅にする（実測は 40m で取得できた）。

3 経路とも `overallOk` と `checks[{name, ok}]` を**同じ順序・同じ形**で持つ。
突合は `verifyThreePaths`（件数・順序・`name`・`ok`・`overallOk` の完全一致 / 重複名は不可）。
`status` は result が**無い / 壊れている / schema 違い / 別 run のもの**なら
`result_unavailable` / `result_invalid` / `result_schema_mismatch` を返し、**PASS 扱いにしない**。
保存内容に URL / token / Redis 値 / アドレス / hash 全文 / stack は入らない（`assertResultSafe` が拒否）。

**`run` は cleanup しない。** result は `cleanup` / `finalize` で消えるので、
**3 経路の一致を確認するまで `cleanup` を実行しない**（Function 側でも構造的に拒否する）。

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

# 4) Function ログ（3 経路目）— **--json で JSON Lines として保存する**
#    ⚠️ `netlify logs:function` は live stream 専用で**過去の実行を返さない**（deprecated）。
#       run 済みのログを取るには必ず `netlify logs --since ...` を使う。
netlify logs --source functions \
  --function admin-marketing-automation-def-canary --since 40m --json \
  > "$CANARY_DIR/function.log" 2> "$CANARY_DIR/function.err"
echo "log lines=$(wc -l < "$CANARY_DIR/function.log")"

# 5) ⚠️ 3 経路の完全一致を確認してから cleanup。
#    HTTP 応答とログの checks[{name, ok}] を**加工せず・順序どおり**渡す。
#    （欠落・件数違い・順序違い・name/ok 違い・重複名・boolean だけの主張は
#      すべて 409 paths_not_verified で削除を拒否される）

# 5-1) JSON Lines から対象 event を抽出する（引数は環境変数で渡す）
#      各行は JSON オブジェクトで、canary の 1 行 JSON は**その文字列フィールドの中**にある。
#      行そのものが JSON の場合にも当たるよう、両方を走査する。
LOG_FILE="$CANARY_DIR/function.log" OUT="$CANARY_DIR/log-result.json" node -e '
  const fs = require("fs");
  const EVENT = "marketing_automation_def_canary_result";
  const lines = fs.readFileSync(process.env.LOG_FILE, "utf8").split("\n").filter(Boolean);
  const found = [];
  for (const line of lines) {
    let outer = null; try { outer = JSON.parse(line); } catch {}
    const texts = [];
    if (outer && typeof outer === "object") {
      for (const v of Object.values(outer)) if (typeof v === "string") texts.push(v);
    }
    texts.push(line);
    for (const t of texts) {
      const i = t.indexOf("{");
      if (i < 0) continue;
      try { const o = JSON.parse(t.slice(i)); if (o && o.event === EVENT) found.push(o); } catch {}
    }
  }
  console.log("raw lines:", lines.length, "/ canary result lines:", found.length);
  if (found.length !== 1) {
    console.error(found.length === 0
      ? "ログ 1 行 JSON が見つかりません（--since を広げて再取得。run はしない）"
      : "canary result 行が複数あります（canaryIdSuffix で run のものを特定すること）");
    process.exit(1);
  }
  fs.writeFileSync(process.env.OUT, JSON.stringify(found[0], null, 2));
'

# 5-2) HTTP 応答とログから checks をそのまま組み立てる（値の書き換えはしない）
RUN_FILE="$CANARY_DIR/run.json" LOG_RESULT="$CANARY_DIR/log-result.json" \
CID="$CID" OUT="$CANARY_DIR/cleanup-req.json" node -e '
  const fs = require("fs");
  const http = JSON.parse(fs.readFileSync(process.env.RUN_FILE, "utf8"));
  const log  = JSON.parse(fs.readFileSync(process.env.LOG_RESULT, "utf8"));
  const pick = (a) => a.map((c) => ({ name: c.name, ok: c.ok }));
  fs.writeFileSync(process.env.OUT, JSON.stringify({
    action: "cleanup", canaryId: process.env.CID,
    httpOverallOk: http.overallOk, httpChecks: pick(http.checks),
    logOverallOk: log.overallOk,  logChecks:  pick(log.checks),
  }));
'
# 送る中身を目で確認してから投げる
cat "$CANARY_DIR/cleanup-req.json"

CL_HTTP=$(curl -sS -o "$CANARY_DIR/cleanup.json" -w '%{http_code}' \
  -X POST "$URL" -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  --data-binary @"$CANARY_DIR/cleanup-req.json")
echo "cleanup HTTP=$CL_HTTP"
```

**禁止**: `curl -o file -w '%{http_code}'` の出力を**同じファイルへ**書くこと（前回これで JSON を壊した）。
**一時ファイルは D4 完了まで保持する。** `trap ... EXIT` での自動削除は使わない。
`SECRET` を `echo` / `set -x` / transcript へ出さない。

## 実行手順

1. **D1** → `preview` / `run` が **403** / Redis write 0
2. `netlify env:set MARKETING_AUTOMATION_DEF_CANARY_ENABLED true --context production`
3. **D2** → `preview` **200** → canaryId 発行（Redis 非接触）
4. `run` を **exactly 1 回**（`DEF-CANARY <canaryId>`）・**retry 0** → `run.json` の parse 成功を確認
   （墓標が立つので、以後この canaryId では再 run できない）
5. `status` → 保存済み result を復元し、`run.json` と `overallOk` / チェック名 / 件数 / ok が一致
6. **Function ログ**の 1 行 JSON でも一致を確認
7. **3 経路が完全一致してから** `cleanup`（HTTP 応答とログの `checks[{name, ok}]` をそのまま渡す）
   → `pathsVerified=true` / `照合.checkCount` が観測値と一致 / `canary残存0=true` / **`墓標維持=true`**
8. `netlify env:unset MARKETING_AUTOMATION_DEF_CANARY_ENABLED --context production`
9. **D3** → `preview` / `run` が **403** → `finalize`
   → `finalized=true`（Definition 0 / 結果 0 / **墓標 0** / index 除去済 / 他 member 不変）
10. **D4** → Function **404** / 公開 SHA 復帰
11. すべて確認できてから一時ファイルを削除

### 合格条件（**すべて満たさなければ PASS にしない**）

- `run` が **HTTP 200** / 応答 `overallOk=true` / `resultSaved=true`
- `status` の `結果復元=true` かつ result `overallOk=true` / `墓標残存=true`
- Function ログ `overallOk=true`
- **3 経路が完全一致**（件数・**順序**・`name`・`ok`・`overallOk`。重複 check 名が無いこと）
- 9 項目（10 チェック）が**すべて ok=true**
- `runCount=1` / `retryCount=0` / 許可キー外の操作 **0**
- `indexOtherMembers.same=true` かつ `added=0` / `removed=0`（**0 件でも複数件でも完全一致**）
- cleanup 後 `pathsVerified=true` / `照合.一致範囲` が「件数・順序・name・ok・overallOk」/
  `canary残存0=true` / **`墓標維持=true`**
- cleanup 後に `run` を投げたら **`409 already_run`**（墓標が効いている確認・副作用なし）
- finalize 後 `finalized=true`（**墓標含め残存 0**）

### 3 経路のいずれかが欠落・不一致のとき

- **成功と判定しない**
- **追加 run をしない**（墓標があるので構造的にもできない）
- `status` と Function ログの取得を続ける
- **`cleanup` は実行しない**（Function 側でも `409` で拒否される）
- 復元できなければ **env 閉鎖 → 反映 deploy → `finalize` → main 復帰**まで行い、
  **canary 未達**として報告する

## canary 項目（run の 10 チェック）

1. Definition を作成できる（`expectedVersion=''` で新規作成）
2. get で読み戻せる / 2b. PII を含まない
3. version 一致なら更新できる
4. version 不一致は **CONFLICT** で拒否（上書きされない）
5. `index:active` へ追加できる
6. pause（PAUSED へ遷移）できる
7. cancel（CANCELLED へ遷移）できる
8. `index:active` から除去できる
9. `index` の canary 以外の member が**完全一致**（0 件でも複数件でも同じ厳密さ）

## Function の削除

canary 完了後は **D4（main を Build Hook で 1 回）**で本番から消える
（main にこの Function は存在しないため、削除用の commit は不要）。即時無効化は `env:unset` + 反映 deploy。

## 限界

**Lua 本文はローカルテストで実行していない**（サーバ側でしか動かないため、fake は意味論を再現している）。
**Lua 本文の正しさは本番 canary でのみ確認できる。** また `SET`/`EVAL` の CAS は
Upstash の単一ノード上での逐次実行に依存しており、**分散環境の linearizability を証明するものではない**。

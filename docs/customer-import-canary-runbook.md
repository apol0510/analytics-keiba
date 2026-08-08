# 大量取り込み canary 実行手順（隔離 Upstash / 非本番 context 限定）

> **目的**: PR #235 の `SAVE_FENCED_LUA`（fencing CAS）が**実 Redis 上で**正しく判定することを、
> AK 本番 Redis・Airtable・実顧客から**完全に分離した環境**で実証する。
>
> **不変条件**: production Redis へ書かない / Airtable へ書かない / メールを送らない /
> 実 `ImportBatchId`・実メール・Customers を一切使わない。

## 分離の仕組み（コードで強制済み）

canary は **canary 専用の env 名でしか Redis へ接続しない**。

| 用途 | env 名 |
|---|---|
| canary の接続先 | `CANARY_UPSTASH_REDIS_REST_URL` / `CANARY_UPSTASH_REDIS_REST_TOKEN` |
| 本番 Redis | `UPSTASH_REDIS_REST_URL` / `_TOKEN` — **canary は接続に使わない** |

`checkCanaryIsolation()` が Redis へ 1 コマンド送る前に次を強制する。

1. `CONTEXT` が production → **拒否**。未設定・空・未知値も**本番扱いで拒否**（fail closed）
2. canary 専用 env が無い → 拒否
3. canary の URL が本番の URL と**一致** → 拒否（env の貼り間違い検知）

`importCanaryIsolation.guard.test.mjs`（11 件）が、接続に本番 env 名を使う退行・
隔離チェックの削除・context 判定の fail-open をいずれも fail させる（実測済み）。

## 手順

### 1. 隔離 Upstash を 1 個作る

- **AK 本番とは別のデータベース**を新規作成する（同一 DB を prefix で分けるのではない）
- リージョンは任意。無料枠で足りる（最大 32 キー / TTL 900 秒）

### 2. 非本番 context にだけ env を入れる

```bash
# ⚠️ --context production は絶対に付けない
netlify env:set CANARY_UPSTASH_REDIS_REST_URL   '<canary の URL>'   --context deploy-preview --secret
netlify env:set CANARY_UPSTASH_REDIS_REST_TOKEN '<canary の token>' --context deploy-preview --secret
netlify env:set CUSTOMER_IMPORT_CANARY_ENABLED  'true'              --context deploy-preview
```

投入後に **production context に 1 つも入っていないこと**を確認する。

```bash
netlify env:list --context production --json   # CANARY_* が 0 件であること
```

### 3. Deploy Preview で実行

PR #235 の Deploy Preview に対して実行する（**production URL では実行しない**）。

```
POST https://deploy-preview-235--analytics-keiba.netlify.app/.netlify/functions/admin-customer-import-redis-canary
x-admin-secret: <管理シークレット>
```

1. `action: 'issue'` … canaryId をサーバー側で発行（利用者は指定できない）
2. `action: 'run'` … Phase 0 / 1 / 2 + cleanup を実行
3. `action: 'finalize'` … 墓標も消して残存を完全に 0 にする

### 4. 合否

| # | 条件 | 判定元 |
|---|---|---|
| 1 | 正本が無ければ `MISSING`・何も書かない | phase2 checks 1 / 1b |
| 2 | same token → 保存可 | phase2 check 2 |
| 3 | newer token → 保存可 | phase2 check 3 |
| 4 | stale token → `STALE`・正本が変わらない | phase2 checks 4 / 4b |
| 5 | A(1) → lease 失効 → B(2) 保存 → A(1) 復帰 → **B 維持 / A 拒否** | phase2 checks 5a / 5b / 5c |
| 6 | cleanup 後 canary data key **0** | `cleanup.remaining` |
| 7 | finalize 後 墓標を含め**完全 0** | `finalized: true` / `rootRemaining: 0` |
| 8 | prefix 外キーの変更 **0** | `runner.assertKey` が構造的に拒否（例外で停止）|
| 9 | Airtable write **0** | canary は Airtable クライアントを持たない |
| 10 | 実送信 **0** | canary は送信経路を持たない |

**報告に含めてよいのは HTTP status / PASS-FAIL / キー件数だけ。** URL・token・canaryId 以外の値は出さない。

### 5. 後始末（必須）

```bash
netlify env:unset CUSTOMER_IMPORT_CANARY_ENABLED  --context deploy-preview
netlify env:unset CANARY_UPSTASH_REDIS_REST_URL   --context deploy-preview
netlify env:unset CANARY_UPSTASH_REDIS_REST_TOKEN --context deploy-preview
```

隔離 Upstash は削除してよい（canary 以外に用途が無い）。

## rollback

canary は**本番データを 1 件も変更しない**ため巻き戻す対象が無い。異常時は:

1. `CUSTOMER_IMPORT_CANARY_ENABLED` を unset → Function は**常時 403**
2. Redis 側は `cleanup` → `finalize` で残存 0
3. それでも残る場合は隔離 Upstash ごと削除する（本番に影響しない）

## やってはいけないこと

- `--context production` で `CANARY_*` を入れる
- 本番 Redis の URL / token を `CANARY_*` に入れる（コードが `canary_points_at_production` で拒否する）
- production URL に対して canary を実行する
- URL / token を PR・ログ・報告に書く

# 大規模継続配信 activation runbook（100 名カナリア → 段階拡大）

**状態: 未実行。** production env 変更・Redis 書込み・実付与・実送信はまだ 1 件も行っていない。
このドキュメントは**承認後にそのまま実行できる手順**として書いてある。

対象: `journeyId = light-trial-to-premium-v1`（体験中 6 通 + 体験終了後 18 通 = 最大 24 接点）
実装: PR #348（squash `5cfeb22b`）本番反映済み・全ゲート OFF

---

## 1. activation preflight（production env の現状 / 2026-08-15 実測）

値は表示せず、設定の有無だけを確認した。

| # | 工程 | env | 現在 | activation で必要 | 変更 |
|---|---|---|---|---|---|
| 1 | 付与（列の実在） | `COMEBACK_GRANT_FIELDS_READY` | `1` | `1` | **不要** |
| 2 | 付与（実行許可） | `COMEBACK_GRANT_ENABLED` | `true` | `true` | **不要** |
| 3 | 付与（自動化の許可） | `LIGHT_TRIAL_AUTOGRANT_ENABLED` | UNSET | `true` | **要設定** |
| 4 | キュー登録 | `MARKETING_CAMPAIGN_ENABLED` | UNSET | `true` | **要設定** |
| 5 | 実送信 | `MARKETING_CAMPAIGN_DISPATCH_ENABLED` | UNSET | `true` | **要設定** |
| 6 | 自動運転 | `MARKETING_ROLLOUT_ENABLED` | UNSET | `true` | **要設定**（最後に開ける） |

補助（既に PRESENT・変更不要）: `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` /
`PREMIUM_PLUS_ADMIN_SECRET` / `SENDGRID_API_KEY`。

⚠️ `LIGHT_TRIAL_AUTOGRANT_ARMED`（当日日付）は **設定しない**。
自動運転が展開状態（Redis）から当日日付を差し込むため、env での日次書き換えは不要。

⚠️ **env 変更は redeploy しないと反映されない**（Netlify の仕様）。
`netlify env:set` の後に production build を 1 回回す。

---

## 2. Redis rollout state（開始時に入れる予定値 / **まだ書いていない**）

鍵: `ak:marketing-rollout:state:light-trial-to-premium-sequence`
（道のり単位。キャンペーンが 2 本でも状態は 1 つ）

| 項目 | 予定値 | 意味 |
|---|---|---|
| `stage` | `canary10` → 確認後 `steady100` | 段階。カナリアは 10、その後 100/日 |
| `dailyLimit` | `100` | 1 日あたりの付与上限（`HARD_DAILY_MAX = 2000` で頭打ち） |
| `killed` | `false` | 緊急停止（`true` で次の tick から全停止） |
| `alwaysArmed` | `true` | 日次の武装を自動化（env の日付書き換えを不要にする） |
| `armedFor` | `null` | `alwaysArmed` を使うので未使用 |
| `pendingHandoffOp` | `null` | 付与後の引き継ぎ（自動で入る） |
| `pendingJobIds` / `jobSteps` / `dispatchWatch` | 空 | 実行中に自動で埋まる |
| `note` | `activation canary 2026-08-xx` | 誰が何のために開始したか |

**CAS 前提値**: 現在キーは**存在しない**（`action=rollout` が `metricsPartial: not_initialized`）。
初回書き込みは `expectedVersion: null`（新規作成）で行う。
既にキーがある場合は `load()` が返した `state.version` をそのまま渡す。**版が違えば書かない**。

**rollback 時の状態**:

| やり方 | 効き方 | 使う場面 |
|---|---|---|
| 管理画面から `killed: true`（`store.kill()`） | **次の tick から停止**（redeploy 不要・数分） | 想定外の挙動をすぐ止めたい |
| `stage: 'paused'` / `dailyLimit: 0` | 新規付与だけ止め、積んだぶんは送る | 付与ペースだけ落としたい |
| env を UNSET（`MARKETING_ROLLOUT_ENABLED` 他） + redeploy | 完全停止（数分〜十数分） | 恒久的に閉じる |

⚠️ **kill switch は「送信途中のジョブ」を取り消さない**（送信中のバッチは走り切る）。
即時に送信も止めるなら `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy。

---

## 3. 第 2 カナリア = 100 名（read-only preflight / 2026-08-15 実測）

いきなり 14,479 名へ開放しない。**まず 100 名**。

| 項目 | 実測 | 出所 |
|---|---|---|
| 候補として読んだ件数 | **100**（1 ページ） | `action=trialGrant`（batchSize=100） |
| うち付与予定（eligible） | **100** | `batch` |
| 除外（理由別） | **0 件**（`excludedByReason: {}`） | 同上 |
| 既付与との重複 | **0**（既付与 10 名は候補に入らない） | 付与済みは formula の対象外 |
| 既送信との重複 | **0**（Step1 送信済みは既付与 10 名のみ） | `sequence`: `sentByStep[1] = 10` |
| 関所（前回ぶんの未処理） | **0** → `nextBatchAllowed: true` | `barrier.outstandingStep1` |
| まだ候補がある | `true`（残りは 14,000 名規模） | `moreAvailable` |
| コホート | `imp-2026-08-09-001` | `cohort.byBatch` |
| 想定 Step1 送信数 | **付与に成功した人数（最大 100）** | 付与直後に Step1 が期日（`delayDays: 0`） |

除外の内訳が 0 件なのは、**未付与・非有料・配信可能な人だけが候補として引かれる**ため
（過去付与 / 有料会員 / 期限なし付与 / 付与中 / 配信不可は formula と plan の両方で外れる）。
配信停止・バウンス・suppression は**送信直前にもう一度**判定される（二重の防御）。

⚠️ 100 名は**このバッチの先頭 100 名**であり、名簿は付与実行時にもう一度確定する
（`planFingerprint` が一致しなければ実行しない）。

---

## 4. 100 名実行後の成功条件（次段階へ進める判定）

**全部満たしたときだけ**次（500 名）へ進む。1 つでも欠けたら停止して原因を潰す。

| # | 指標 | 合格ライン | 確認方法（read-only） |
|---|---|---|---|
| 1 | grant 成功件数 | **95 以上 / 100**（失敗は理由が説明できること） | cron ログ / `action=trialGrant` の再実行で残数が減っている |
| 2 | queue 件数 | **付与成功数と一致** | `action=jobs` の `recipientCount` |
| 3 | sent | **queue 件数と一致**（`failed` は 0 が目標、5% 未満まで許容） | `action=jobs` の `counts.sent` / `sentCount` |
| 4 | skipped | 理由が説明できること（配信停止・バウンス等） | `counts.skipped` / `skipByReason` |
| 5 | duplicate | **0**（同じ人へ同じ touch が 2 通いかない） | `action=sequence` の `sentByStep` と受信者数が一致 |
| 6 | hard bounce | **2% 未満** | EmailBlacklist の増分 |
| 7 | complaint（苦情） | **0.1% 未満**（1 件でも出たら内容を確認） | EmailBlacklist / provider |
| 8 | unsubscribe | **2% 未満**（超えたら文面と頻度を見直す） | EmailBlacklist の増分 |
| 9 | provider acceptance | 送信数 = SendGrid 受理数 | dispatcher のログ / `sentCount` |
| 10 | **delivered は別計測** | Event Webhook の `delivered` で後追い（受理 ≠ 着弾） | `EmailEvents` |
| 11 | Customers の課金系変更 | **0**（`プラン` / `PlanType` / `Status` / `有効期限` が変わっていない） | 実行前後で対象レコードを read-only 比較 |
| 12 | gate 再閉鎖 / kill switch | **再閉鎖できる**か、`killed: true` で次 tick が止まる | `action=rollout` が `canProceed: false` を返す |

⚠️ 3 と 10 を混同しない。**`sent` は「送信基盤が受理した」**であって着弾ではない。

---

## 5. activation 実行手順（承認後）

### Step 0. 直前確認（read-only）

1. `action=rollout` … `canProceed: false` / 閉じている env 名が出ること
2. `action=trialGrant`（batchSize=100） … `batch` / `excludedByReason` / `barrier.nextBatchAllowed: true`
3. `action=jobs` … PENDING の marketing ジョブが**無い**こと
4. `planFingerprint` を控える（実行時に一致を要求する）

### Step 1. env を開ける（4 つ）

```bash
netlify env:set LIGHT_TRIAL_AUTOGRANT_ENABLED true --context production --force
netlify env:set MARKETING_CAMPAIGN_ENABLED true --context production --force
netlify env:set MARKETING_CAMPAIGN_DISPATCH_ENABLED true --context production --force
netlify env:set MARKETING_ROLLOUT_ENABLED true --context production --force   # ← 最後
```

### Step 2. deploy（env を効かせる）

Build Hook を 1 回叩き、`origin/main` を production build する。
**deploy 完了まで自動運転は動かない**（env が読めないため）。

### Step 3. Redis rollout state を開始（CAS 新規作成）

`stage: canary10` / `dailyLimit: 100` / `alwaysArmed: true` / `killed: false` /
`expectedVersion: null` で作成 → `action=rollout` で `canProceed: true` を確認。

### Step 4. 付与（自動 / cron が 1 tick で実行）

cron は 1 時間ごと。`stage` の上限まで付与する。
手動で先に進めたい場合も**新しい経路を作らない**（cron を待つ）。

### Step 5. queue（自動 / 次の tick）

付与の引き継ぎ（`pendingHandoffOp`）から Step1 を dry-run → 指紋一致 → 登録。

### Step 6. background dispatch（自動 / 次の tick）

起動直前に dry-run で `expectedWillSend` を確定してから Background を起動。
**202 は送信成功ではない**。台帳で確認する。

### Step 7. 台帳確認（read-only）

`action=jobs` … `counts.sent` / `failed` / `skipped`、
`action=sequence` … `sentByStep`、`action=rollout` … 進行と現在の touch。

### Step 8. gate 再閉鎖 / kill switch の確認

カナリアの結果を確認するまで、次のバッチを走らせたくない場合:

- **すぐ止める**: 管理画面から `killed: true`（次 tick から停止・redeploy 不要）
- **恒久的に閉じる**: env を UNSET して redeploy

---

## 6. rollback

| 事象 | 対応 | 所要 |
|---|---|---|
| 送信内容が想定と違う | `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy（積むが送らない） | 数分〜十数分 |
| 付与が想定より速い / 多い | `dailyLimit` を下げる or `stage: 'paused'`（Redis・redeploy 不要） | 即時（次 tick） |
| 全部止めたい | `killed: true` → そのうえで env 4 つを UNSET + redeploy | 即時 + 数分 |
| 付与してしまった人を戻したい | **自動では戻さない**。`admin-comeback-grants` の取消（`LightGrantRevokedAt`）を手動で | 手動 |
| 送ってしまったメール | **取り消せない**。配信停止の申し出に個別対応する | — |

⚠️ **付与の取消は自動化しない。** 権利を勝手に剥がすと、既に使い始めた人の体験を壊す。

---

## 7. まだやらないこと（次の承認境界）

- production marketing gate の ON
- Redis rollout state の本番開始設定
- 100 名への実付与 / 実メール送信
- 500 名以降への拡大（100 名の成功条件を満たしてから）

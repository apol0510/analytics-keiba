# 反応なし配信の除外（engagement suppression）

1 万数千件規模のキャンペーンで、**何度送っても反応が無い相手への配信を止める**仕組み。
目的は SendGrid 費用の削減だけではなく、**迷惑メール報告とドメイン評価の悪化を防ぎ、
届けたい相手に届く状態を保つこと**。

> **会員資格・課金とは無関係。** ここで決めるのは「通常のマーケティングメールを送ってよいか」だけ。
> `Customers` レコードは消さないし、プラン・有効期限・権限には 1 バイトも触れない。
> 取引メール（決済確認 / 認証 / サポート返信 / 期限通知）には**適用しない**。

---

## 1. 状態と閾値（単一源: `src/lib/marketing/engagementPolicy.js`）

| 状態 | 条件（反応が 1 つも無い場合） | 送信 |
|---|---|---|
| `ACTIVE` | open / click / 購入 / ログインのいずれかがある | 送る |
| `UNKNOWN` | 送信が 5 通未満（判断材料不足） | 送る |
| `LOW_ENGAGEMENT` | **5 通**送って無反応 | **送る**（観察段階。まだ止めない） |
| `INACTIVE` | **10 通** delivered で無反応 | **送らない** |
| `HARD_INACTIVE` | **20 通** delivered で無反応 | **送らない** |

- 閾値は `engagementPolicy.js` の `DEFAULT_THRESHOLDS` **1 か所だけ**。他へ複製しない
  （env `MARKETING_LOW_ENGAGEMENT_SENDS` / `MARKETING_INACTIVE_DELIVERED` /
  `MARKETING_HARD_INACTIVE_DELIVERED` で上書き可。大小関係が壊れた設定は既定へ倒す）
- **除外は永続しない。** 開封・クリック・購入・ログインが 1 つでも届けば次回は `ACTIVE` に戻る
- unsubscribe（本人の意思表示）とは**別の状態**。bounce / provider suppression は従来どおり最優先

## 2. 反応の正本（どこを読んでいるか）

| 指標 | 正本 | 読み方 |
|---|---|---|
| sent / delivered | `CampaignDeliveries`（`EmailType='campaign'` / `Status='sent'`） | 宛先ぶんだけ名指し取得 |
| **open** | SendGrid Event Webhook → Redis 集計 `ak:mkt:eng:v1:open` | `HGETALL` 1 回 |
| **click** | 同上 `ak:mkt:eng:v1:click` | `HGETALL` 1 回 |
| 購入 | `Customers.PaidAt` | 既存の一覧取得 |
| ログイン | `Customers.LastLoginAt` / `最終ログイン` | 既存の一覧取得 |

### なぜ Blob / Airtable を数え直さないか

- `EmailEvents` は Airtable の容量対策で **Blob へ移し、行を削除した**（`MARKETING_EVENT_SINK=blob`）。
  **全件走査へ戻すことは禁止**（`EMAIL_EVENT_LEDGER.md` / `AIRTABLE_CAPACITY.md`）
- Blob（NDJSON・append-only）は**監査の正本**だが、1 バッチ 1 blob なので
  15,000 名ぶんの集計を 1 リクエストで作ると Function の実行時間に収まらない
- そこで **受信した瞬間に畳む**（`engagementSignalStore.js`）。読み出しは `HGETALL` 数回で終わる

### 記録の形（`src/lib/marketing/engagementSignalStore.js`）

```
ak:mkt:eng:v1:open   { <EmailHash>: <最後に開封した ms> }
ak:mkt:eng:v1:click  { <EmailHash>: <最後にクリックした ms> }
ak:mkt:eng:v1:meta   { schema, started_at, first_open_at, last_event_at }
```

- フィールドは**アドレスではなく `EmailHash`**（`emailEventLedger.js` と同じ
  `sha256(lower(email))` の先頭 32 桁）。Redis に生アドレスを置かない
- **回数は持たない**（判定に要るのは「反応があったか / いつか」だけ）。
  よって 1 バッチ `HSET` 1 回で書けて、provider の再送で二重に数えることも無い
- 書き込み失敗は**致命にしない**（webhook を落とさない）。生ログは Blob 側に残る

## 3. fail closed（1 つでも欠けたら誰も除外しない）

判定は `src/lib/marketing/engagementGuard.js`。次のどれか 1 つでも欠ければ
**guard は 1 人も除外しない**（`applied:false` を管理画面に必ず表示する）。

| 理由コード | いつ |
|---|---|
| `guard_off` | `MARKETING_ENGAGEMENT_GUARD=off`（緊急停止） |
| `signal_store_unavailable` | Redis 未設定・読み取り失敗 |
| `open_not_measured` | 配信基盤の開封計測が `enabled` でない（**無効も不明も不可**） |
| `no_open_recorded` | 集計に open が 1 件も無い（届いている証拠が無い） |
| `signal_stale` | 最後の受信から時間が経ちすぎ（既定 7 日 / `MARKETING_ENGAGEMENT_MAX_SIGNAL_AGE_MS`） |
| `no_coverage_start` | 集計の開始時刻が分からない |

### 数える期間

**集計が記録を始めた時刻（`started_at`）以降の配信だけ**を delivered / sent に数える。

- それ以前の送信は「開かれなかった」のか「記録していなかった」のか区別できない。
  数えれば**開封している人を切る**ことになる
- 送信時刻が読めない配信行も数えない（期間内だと証明できない）
- `MARKETING_ENGAGEMENT_COVERAGE_SINCE` で**後ろへずらす**ことだけできる。
  記録開始より前へは戻せない（`Math.max` で固定）

この設計のため、**deploy 直後は誰も除外されない**。反応の記録が貯まり、
かつ記録開始後に 10 通届いた人が現れて初めて除外が始まる。

## 4. どこで効くか

| 画面・経路 | 効き方 |
|---|---|
| セグメント下見（`action:'segments'`） | 「送信できる人数」から差し引く。理由 `engagement_blocked` で件数表示 |
| dry-run（`action:'dryRun'`） | 除外明細に `engagement_blocked` が出る |
| 実 enqueue（`action:'send'`） | **同じ関数（`handlePlan`）を通る**ので判定が食い違わない |
| 送信確認モーダル | 「実送信 N 名 / うち 反応なしで除外 M 名」を並べて表示 |

- dry-run と enqueue の間に対象が変われば `planFingerprint` の不一致で 409（従来どおり）
- 材料が同じなら結果は同じ（再実行で変わらない）

## 5. 運用

### 状況を見る

`/admin/premium-plus-eligibility/` → セグメントの下見 → 「人数を数える」。
`適用中 / 適用していません`、5 区分の人数、閾値、数えている期間、
最後に反応を受信した時刻が出る。**適用していないときの人数は参考値**と明記される。

### 止める

`MARKETING_ENGAGEMENT_GUARD=off` を設定して redeploy（env 変更は再デプロイが要る）。
コード変更なしで従来の挙動（engagement 除外なし）へ戻る。

### やってはいけないこと

- `engagementByEmail` を「材料が揃っていない状態で」渡すこと（誤除外になる）
- 閾値を `campaignSend.js` / Function / 画面へ直書きすること
- `EmailEvents` の全件走査へ戻すこと
- open が取れないことを「反応が無い」と読み替えること
- 除外された人の `Customers` レコードを消すこと

## 6. 関連ファイル

| 目的 | ファイル |
|---|---|
| 状態と閾値（単一源） | `src/lib/marketing/engagementPolicy.js` |
| 反応の集計（Redis I/O） | `src/lib/marketing/engagementSignalStore.js` |
| 適用可否・期間・除外集合 | `src/lib/marketing/engagementGuard.js` |
| delivered / sent の集計 | `src/lib/marketing/engagementStats.js` |
| 送信計画側の guard | `src/lib/marketing/campaignSend.js`（`MK_EXCLUSION.ENGAGEMENT_BLOCKED`） |
| セグメント下見 | `src/lib/crm/audienceSegments.js`（`SEG_EXCLUDE.ENGAGEMENT_BLOCKED`） |
| 配線（下見・dry-run・enqueue） | `netlify/functions/admin-marketing.js` |
| 反応の記録 | `netlify/functions/sendgrid-webhook.js` |
| 画面 | `src/pages/admin/premium-plus-eligibility.astro`（`mkRenderEngagement`） |

### テスト

```bash
npm run test:marketing   # engagementGuard / engagementSignalStore / 配線 guard / 統合
npm run test:crm         # セグメント下見の数え方
npm run check:safety     # 上記を含む全 safety check
```

`engagementWiring.guard.test.mjs` が **配線そのもの**を検査する
（判定モジュールの単体テストは通るのに実送信では 1 人も除外されない、という
2026-08-10 の状態を再発させないため）。

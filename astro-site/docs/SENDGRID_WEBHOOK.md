# SendGrid Event Webhook（署名検証 / fail closed）

`netlify/functions/sendgrid-webhook.js` の受信契約。**公開 URL であり、書き込む
`EmailBlacklist` は実運用の suppression list**（`newsletter-preview.js` が配信除外に使用）。

## 経緯（2026-07-21）

Payment Email v2 の次 Phase（S9 Event Webhook）の前提調査で、**既存の
`sendgrid-webhook.js` が署名検証・認証を一切持たないまま公開 URL として稼働している**
ことを検知した。

成立していた事故:

- 第三者が `[{"event":"bounce","email":"<任意アドレス>","reason":"invalid"}]` を POST するだけで、
  任意アドレスを `HARD_BOUNCE` として `EmailBlacklist` に登録できる
  → **その顧客がメルマガ配信対象から恒久的に外れる**
- `spamreport` なら `severity=critical` で 1 回の POST で HARD_BOUNCE 化
- `filterByFormula=SEARCH("${email}", {Email})` が**未エスケープの外部入力を formula へ直挿し**
  → formula injection で意図しないレコードへの PATCH が成立
- `console.log` に受信メールアドレスをそのまま出力（PII）

Payment Email v2 が作った欠陥ではなく**以前から存在した欠陥**。S9 が触る対象ファイル・
必要 secret・署名検証モジュールと完全に同一のため、**S9 の前提工事（Phase 0）**として先に実施した。

## 契約（不変条件）

1. **署名検証を通ったリクエストだけを処理する。** 検証は単一源
   `src/lib/webhooks/sendgridSignature.js`。Function 側に再実装しない。
2. **検証鍵が未設定なら 403。** 「鍵が無いときは検証を省略する」分岐を**絶対に作らない**
   （guard テストで禁止）。設定不備は 500 ではなく **403**（「一時障害だから後で届く」と誤解させない）。
3. **検証成功後にのみ body を parse する。** 未検証リクエストには構文エラー（400）を返さず
   認証段の 403 を返す（未認証入力の構文エラーを外部へ区別して返さない）。
4. **Airtable への書き込みは検証成功後にのみ発生する。** 検証失敗時は 1 バイトも書かない。
5. **PII / secret を出さない。** メールアドレス・署名・鍵・Airtable 応答本文・例外本文を
   ログ／応答へ出さない。失敗理由は**固定 reason コードのみ**。
6. **formula への外部入力は `airtableFormula.js` 経由**（`emailMatchFormula`・LOWER(TRIM()) 正規化）。
   旧 `SEARCH()`（部分一致 + 直挿し）は復活させない。

## 署名仕様

| 項目 | 値 |
|---|---|
| 署名対象 | **`timestamp + 受信したままの raw body`** の連結文字列 |
| 署名ヘッダ | `X-Twilio-Email-Event-Webhook-Signature`（base64 DER ECDSA） |
| timestamp ヘッダ | `X-Twilio-Email-Event-Webhook-Timestamp`（UNIX 秒） |
| 検証鍵 | base64 SPKI(DER) 公開鍵（ECDSA P-256） |
| リプレイ窓 | timestamp のずれ **±24 時間**（既定）を超えたら拒否。env `SENDGRID_WEBHOOK_MAX_SKEW_SEC` で調整可。§監査で追加した是正 1 を参照 |

> ⚠️ **`req.json()` を先に呼んではいけない**。`JSON.parse` → `JSON.stringify` の再直列化では
> 署名が一致しない。必ず `await req.text()` で raw body を取り、それを検証対象にする。

## reason コード（応答・ログに出るのはこれだけ）

`verification_key_missing` / `verification_key_invalid` / `signature_missing` /
`timestamp_missing` / `timestamp_invalid` / `timestamp_skew` / `body_missing` /
`signature_mismatch` / `verify_error`

いずれも**鍵・署名・timestamp・メールアドレスの値そのものを含まない**。

## env

| env | 責務 |
|---|---|
| `SENDGRID_WEBHOOK_VERIFICATION_KEY` | SendGrid が発行する **Verification Key**（base64 SPKI 公開鍵）。**未設定なら全リクエスト 403** |

- **公開鍵**であり秘密鍵ではないが、**値そのものを CLAUDE.md / ログ / commit に書かない**運用は維持する。
- Netlify の scope は **Functions**、context は **production**（他 context へ広げない）。

## 本番反映の順序（高リスク境界・ユーザー操作）

> ✅ **2026-07-22: この順序どおりに実施完了**（§Phase 0 本番反映・Webhook 有効化 完了記録）。
> 以下は当時の判断根拠と、今後同種の作業を行うときの手順として残す。
>
> ⚠️（当時）**SendGrid 管理画面の現在の状態は未確認**だった。「未登録／無効であることをユーザーが
> 確認済み」と記載していたが、**その確認は行われていなかった**（やり取りの読み違い）。断定を撤回し、
> 以下を**間接証拠にもとづく推定**として扱った。**その後 API で確認し 0 本登録が確定**している。

### 間接証拠（read-only・Airtable `EmailBlacklist`）

| 項目 | 実測（2026-07-22） |
|---|---|
| `EmailBlacklist` 総件数 | 11 件 |
| Notes に `Webhook` を含む（= 本 Function 由来）レコード | **7 件** |
| その作成日 | **2025-09-21 〜 2025-09-23 に集中** |
| それ以降の webhook 由来レコード | **0 件（約 10 ヶ月）** |
| 既存レコード更新の痕跡（`Webhook <ISO>` 追記） | **0 件** |

**読み取れること**:
- この公開エンドポイントは 2025 年 9 月に**実際に本番 Airtable へ書き込んでいた**
  （= 無認証書込みの脆弱性は机上ではなく**到達可能だった**）。
- **それ以降 10 ヶ月間まったく書き込みがない**。約 1,000 通規模のメルマガ配信で
  バウンスが 10 ヶ月ゼロは考えにくいため、**現在は無効の可能性が高い**。
- ただし「バウンスが実際に 0 件だった」可能性も排除できないため、**確定ではない**。

### deploy 前に必ず確認すること（ユーザー操作）

SendGrid 管理画面 → Settings → Mail Settings → **Event Webhook** の有効/無効。

| 実際の状態 | 本変更を deploy した場合 |
|---|---|
| **未登録 / 無効** | **機能損失ゼロ**（届いていないものを 403 にするだけ）。env 投入も不要 |
| **有効（署名検証 OFF）** | **バウンス収集が止まる**。先に検証キーの provision と管理画面での Signature Verification 有効化が必要（下記順序） |

**未確認のまま merge しない。**

将来 Event Webhook を有効化するときは**この順序を厳守**する:

1. SendGrid 管理画面で Event Webhook を作成（**まだ有効化しない**）
2. **Signature Verification を ON** にして Verification Key を発行
3. Netlify に `SENDGRID_WEBHOOK_VERIFICATION_KEY` を **production / Functions scope** で設定
4. **production redeploy**（env は redeploy しないと反映されない）
5. SendGrid 側で Event Webhook を **有効化**
6. SendGrid の「Test Your Integration」で 200 を確認

> 逆順にすると、署名付きイベントが届いているのに鍵が無く **全件 403**（＝バウンス情報の取りこぼし）になる。
> ただし **fail closed 側に倒れるだけで、誤った書込みは発生しない**。

**rollback**: SendGrid 側で Event Webhook を無効化する（env を消すと 403 になるだけで、
「検証なしで受け付ける」状態には**戻せない／戻さない**）。

---

## Phase 0 本番反映・Webhook 有効化 完了記録（2026-07-22）

上記「本番反映の順序」を**逆順にせず**実施し、**署名検証なしの公開受信窓を閉じた**。
本番メール送信 0 通 / 手動 Airtable 書込み 0 件 / 本番 Customers 接続 0。

### 実施した順序と結果

| # | 実施 | 結果 |
|---|---|---|
| 0 | SendGrid 登録状況を **API で read-only 確認** | `GET /v3/user/webhooks/event/settings/all` = 200 / **登録 0 本**（`max_allowed=2`）。§間接証拠の推定が**確定**。「未確認のまま merge しない」条件を充足 |
| 1 | **PR #149 を squash merge**（コードを先に本番へ） | merge commit **`137a348`**。この時点では鍵未設定のため受信側は**全リクエスト 403** |
| 2 | SendGrid で Event Webhook を作成（**enabled OFF のまま Save**） | `AK Event Webhook` / Post URL は本番エンドポイントと一致 / **Signed Event Webhook = ON**（Verification Key 発行） |
| 3 | `SENDGRID_WEBHOOK_VERIFICATION_KEY` を Netlify へ設定 | **Secret=true / Functions scope のみ / Production のみ**（他 context は空）。値は会話・ログ・git・本書のいずれにも残していない |
| 4 | **production redeploy**（Build Hook 1 回・コード差分ゼロ） | published **`6a609fe22791d800080c2ff0`** / commit `137a348` / ready。**env の `updated_at` < deploy の `published_at`** を確認して runtime 反映を機械的に判定 |
| 5 | SendGrid で **Enable endpoint を ON** | `enabled=true` / `signed=true` / URL 一致 / 対象イベントは **bounce・dropped・spam_report・unsubscribe の 4 つのみ**（`delivered` ほかは false のまま・追加していない） |
| 6 | ~~Test Your Integration~~ | **実施しない方針**（下記） |

### Test Integration を行わない判断（2026-07-22）

**理由**: 現行実装では、テスト payload に `bounce` / `dropped` / `spamreport` / `unsubscribe` が
含まれ**署名検証を通過した場合、本番 `EmailBlacklist` にダミーレコードが作成される**
（`processFailureEvent` → `findExistingRecord` で不在 → `createNewRecord`）。
`EmailBlacklist` は `newsletter-preview.js` が配信除外に使う**実運用の suppression list** であり、
検証のために本番テーブルへダミーを書き込むことは避ける。

- 公式ドキュメントは「example events の JSON 配列を POST する」「実データは含まない」とのみ記載で、
  **どのイベント種別・どの宛先が含まれるかは未記載**（＝書込みが起きるか事前に確定できない）。
- **代わりに organic event（実バウンス等）での実証を待つ**。実バウンスの記録は汚染ではなく
  **本来復旧させたかった動作そのもの**である。
- なお書込みが起きるのは**鍵が正しいときだけ**で、鍵不一致なら 403 で 1 バイトも書かない
  （fail closed の self-limiting な性質）。

### baseline（organic event 到達の判定基準 / 2026-07-22 read-only 取得）

| 項目 | 値 |
|---|---|
| `sendgrid-webhook` の Function 到達（直近 24h） | **0 件** |
| `EmailBlacklist` 総件数 | **11 件** |
| Status 内訳 | HARD_BOUNCE **4** / SOFT_BOUNCE **7** |
| `BounceCount` 合計 | **16** |
| 2026 年の新規レコード | **0 件**（作成日は 2025-09-10: 3 / 09-21: 3 / 09-23: 5） |

> ログ取得手段の妥当性は確認済み（同じ `netlify logs` コマンドで `payment-email-dispatcher` の
> 定期実行ログは取得できる）。**「ログが見えない」のではなく「到達が 0 件」**である。

### 未完了: 鍵一致の E2E 実証

**Verification Key が正しいことは、まだエンドツーエンドで実証されていない。**

- 設定時に「SendGrid の `public_key` == Netlify の値」をプログラム比較で一致確認済み。
  ただしその後 env を **Secret 化**したため、**値の再照合はできない**（API から取得不可）。
- 署名を自作しての検証は**不可能**（署名には SendGrid 側の秘密鍵が必要）。
- 未署名リクエストの 403 は**鍵の正しさを何も証明しない**。
- → **実証は organic event の到達を待つ**。

### 次回確認（read-only のみ・書込みなし）

```
netlify logs --source functions --function sendgrid-webhook --since 24h
# + EmailBlacklist の 総件数 / Status 内訳 / BounceCount 合計（メールアドレス・recordId は出力しない）
```

| 観測 | 判定 |
|---|---|
| `📨 処理完了: {received, processed, failed}` が出る | **署名検証 OK＝鍵一致が実証**（Phase 0 の完了条件） |
| `🚫 署名検証 NG: verification_key_invalid` / `signature_mismatch` が**継続**する | **鍵不一致の疑い → 直ちに SendGrid 側で Enable endpoint を OFF**。SendGrid は最大 24 時間リトライするため、OFF で取りこぼしを止める。fail closed なので**誤書込みは発生しない** |
| 総件数が 11 を超える / `BounceCount` 合計が 16 を超える | 実バウンスが正しく記録された（2025-09 以降止まっていた収集の復旧） |

**S9 本体（`accepted` → `delivered` 反映）は未実装・別 Phase**。本 Function は `EmailBlacklist` のみを扱い、
Payment Email の状態は 1 バイトも書かない。

## 検証

`npm run test:webhooks`（`check:safety` に組込済み / CI で個別 step 実行）

| ファイル | 内容 |
|---|---|
| `src/lib/webhooks/sendgridSignature.test.mjs` | 実 ECDSA 鍵ペアで署名 → 正常系 / 鍵未設定 / body 改竄 / 別鍵 spoof / timestamp 差替 / skew / 不正 DER / reason に値を含めない |
| `src/lib/webhooks/airtableFormula.test.mjs` | injection 入力のエスケープ / 制御文字除去 / 完全一致 formula |
| `src/lib/webhooks/sendgridWebhook.guard.test.mjs` | Function の**配線固定**: 単一源 import / 鍵未設定で省略しない / 検証前に parse しない / 検証前に fetch しない / 403 で即 return / formula 直挿し禁止 / ログに email を出さない |

## 未対応（別タスク）

- **Payment Email v2 状態への反映（S9 本体）は未実装**。本 Phase は署名検証と fail closed のみ。
  `accepted` → `delivered` / `bounced` / `dropped` の反映には
  `custom_args`（`record_id` / `idempotency_key`）照合・イベント冪等・out-of-order 処理が必要
  （純粋ロジック `decideWebhookEvent()` は `paymentEmailState.js` に実装済み）。
- 本 Function は現在 `EmailBlacklist`（メルマガ suppression）のみを扱う。
  **Payment Email の状態は 1 バイトも書かない**。

---

## 監査で追加した是正（2026-07-22）

初版レビューで検出した 3 点を修正済み。

### 1. timestamp 許容窓を 10 分 → **24 時間**（可用性側へ）

SendGrid は配信に失敗した Event Webhook を**最大 24 時間リトライ**する。リトライが元の
timestamp / 署名を保持して届く場合、10 分窓では**リトライ分を恒久的に取りこぼす**
（デプロイ中の数分の失敗が永久ロストになる）。

真正性の担保は**署名そのもの**であり、この窓は「大昔に捕捉された署名付きリクエストの再送」を
弾く補助的防御にすぎない。リプレイの実害は `BounceCount` の二重加算までで、署名鍵が漏れない限り
任意アドレスの登録はできない。よって**取りこぼさない側に倒す**。

絞りたい場合のみ env **`SENDGRID_WEBHOOK_MAX_SKEW_SEC`**（秒）で上書きできる。

### 2. Email 照合を `LOWER(TRIM())` 正規化へ（重複レコード防止）

素の `{Email}="..."` だと大文字小文字・前後空白の差で既存レコードを取り逃し、
**更新すべきところで新規レコードを作る**。結果 `EmailBlacklist` が二重化し、
`BounceCount` の積み上げが分断されて HARD_BOUNCE 閾値（5 回）に到達しなくなる。
repo 共通方針（`auth-user.js` / `send-magic-link.js`）と同じ `emailMatchFormula()` に統一した。

### 3. 検索失敗を「未登録」と混同しない（fail closed）

`findExistingRecord` が非 200 / 例外のとき、旧実装は `null` を返し**新規作成へ流れていた**。
Airtable の一時障害のたびに重複レコードが増える。`{ok:false}` を返して**何もせずスキップ**する。

## 既知の限界（本 Phase では未対応）

- **イベント重複の冪等性なし**: SendGrid は同一イベントを複数回配信しうる（exactly-once ではない）。
  現状は届いた回数だけ `BounceCount` が増える（旧実装から変わらず）。
  恒久対応するなら `sg_event_id` を保持して重複を弾く必要がある（**新規フィールド追加を伴う**）。
- **S9（Payment Email 状態への反映）は未実装**。本 Function は `EmailBlacklist` のみを扱い、
  Payment Email の状態は 1 バイトも書かない。

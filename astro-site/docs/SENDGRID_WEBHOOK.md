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
6. **formula への外部入力は `airtableFormula.js` 経由**（`equalsFormula`）。
   旧 `SEARCH()`（部分一致 + 直挿し）は復活させない。

## 署名仕様

| 項目 | 値 |
|---|---|
| 署名対象 | **`timestamp + 受信したままの raw body`** の連結文字列 |
| 署名ヘッダ | `X-Twilio-Email-Event-Webhook-Signature`（base64 DER ECDSA） |
| timestamp ヘッダ | `X-Twilio-Email-Event-Webhook-Timestamp`（UNIX 秒） |
| 検証鍵 | base64 SPKI(DER) 公開鍵（ECDSA P-256） |
| リプレイ窓 | timestamp のずれ **±600 秒**を超えたら拒否 |

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

現状（2026-07-21）**SendGrid 側で Event Webhook は未登録／無効**であることをユーザーが確認済み。
そのため本 PR の deploy は**機能損失ゼロ**（届いていないものを 403 にするだけ）で、
env 投入も不要。

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

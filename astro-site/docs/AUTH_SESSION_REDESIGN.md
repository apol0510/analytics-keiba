# 認証再設計（有料セッション）設計メモ

> 状態: **PR-A（セッション共通ライブラリ）実装済み。PR-B 以降は未着手。**
> 目的: 無料会員はリンク不要のまま、**有料会員だけサーバー側で本人確認（署名 Cookie）を必須**にし、
> 有料コンテンツ本文を未認証者へ一切配信しない。localStorage を有料権限の真実源にしない。

## 確定した完成形

- 無料会員: メール入力だけで利用可。**マジックリンクを送らない / `ak_session` を発行しない / 有料権限ゼロ**。
  無料用クライアント状態（例 `ak_free_profile`, 非 HttpOnly）は表示補助のみで、有料アクセス判定に使わない。
- 有料会員: 正規マジックリンク（`send-magic-link` → `verify-magic-link`）で本人確認 → **署名済み HttpOnly `ak_session` Cookie** を発行。
  有料アクセス可否はこの Cookie を**サーバー側で検証**して判断する。localStorage は有料権限判定に使わない。
- 保護は 2 段階（両方が完成条件）:
  - **Phase 1**: Netlify Edge Function で有料 URL を前段ゲート（未認証は本文を返さない）。
  - **Phase 2**: Astro middleware + 有料ページ SSR 化（認可後のみ本文を描画）。
- 本番投入順序は必ず **PR-A → PR-B → PR-C**。**有効な `ak_session` を発行できる PR-B より前に Edge ゲートを本番有効化しない**。

## セッション方式（採用: B = 署名 Cookie + sessionVersion）

- 毎リクエスト（Edge/middleware）= **署名 + `exp` のみ検証、Airtable 参照なし**（高速）。
- 失効は Customers.`SessionVersion` を +1（解約/プラン変更/強制ログアウト/退会）→ 次のリフレッシュで `sv` 不一致 → 失効（ラグ ≤ TTL）。
- リフレッシュ時のみ Airtable 再照会 → Airtable 参照は概ね「1 回 / TTL / アクティブ会員」に収束。
- Cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`、`ak_session`、HMAC-SHA256 署名、短寿命（Phase 1 は 15–30 分想定、ライブラリ上限 60 分）。

## セッション payload 仕様（PR-A）

最小・PII 最小化。氏名 / points / 支払 / 内部メモ / レコード全体は**含めない**。

| キー | 内容 |
|---|---|
| `v` | スキーマ version（現行 1、未知は拒否） |
| `sub` | 会員識別子（Airtable recordId 推奨 or 正規化 email） |
| `plan` | canonical 有料プラン（free は不可） |
| `venueAccess` | `all` / `jra` / `nankan` |
| `sessionVersion` | 整数 ≥ 0（PR-B/refresh で照合） |
| `issuedAt` / `expiresAt` | epoch 秒 |

トークン形式: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64))`。

## plan / venue 正規化（PR-A `normalize.js`）

- canonical plan: `free` / `light` / `premium` / `premium-combo` / `premium-plus` / `premium-sanrenpuku` / `premium-sanrentan`。
  旧表記・大小・日本語（standard/ライト/プレミアム/三連複/三連単 等）を正規化。未知は拒否。**free は有料セッション発行不可**。
- canonical venue: `all` / `jra` / `nankan`（未指定は `all`）。未知は拒否。

## PR-A ライブラリ構成（`src/lib/session/`）

ランタイム非依存（Node Functions / Astro middleware / Netlify Edge 共有）。無理に 1 ファイルへ統合しない。
`process.env` / `Deno.env` / `Buffer` / `fs` / `window` / `localStorage` を本体で参照しない。環境変数の読み取りは PR-B 以降の呼び出し側。

| ファイル | 責務 |
|---|---|
| `constants.js` | 定数（Cookie 名 / version / TTL 上限 / 鍵最小長 / plan・venue 集合） |
| `base64url.js` | base64url encode/decode（TextEncoder + btoa/atob、Buffer 非依存） |
| `normalize.js` | plan/venue 正規化・`isPaidPlan` |
| `payload.js` | payload 構造・時刻・権限の検証（構造化 reason を返す） |
| `crypto.js` | HMAC-SHA256 署名/検証（Web Crypto `subtle`、timing-safe `verify`） |
| `cookie.js` | Set-Cookie 生成（属性固定 / logout Cookie） |
| `index.js` | `createSession` / `verifySession` 公開 API |

- `createSession(input, secret, {ttlSeconds, now?, crypto?})`: 鍵欠落/短すぎ/不正で失敗、free 発行不可、TTL 上限あり。**デフォルト秘密鍵なし**。
- `verifySession(token, secret, {now?, crypto?})`: 例外を漏らさず `{valid, payload}` / `{valid:false, reason}`。鍵欠落は fail closed（`NO_SECRET`）。reason は機密を含まない列挙値。

## SessionVersion 後方互換（PR-B 設計メモ）

- PR-A は payload の `sessionVersion` を整数として扱う設計・テストのみ。**Airtable フィールドはまだ追加しない**。
- PR-B: Airtable `Customers.SessionVersion` 欠落時は **0 として扱う後方互換**を用意。導入後に 1 以上へ更新可能。
- `sessionVersion` の**比較**は PR-B / refresh 側の責務（PR-A では比較しない・Airtable に接続しない）。

## EDGE_GATE_ENABLED 方針（PR-C 設計メモ）

Phase 1 Edge ゲートの有効/無効フラグ。**単なる `if (!enabled) return next()` は禁止**（未設定を pass-through にしない）。

- 本番:
  - 環境変数 **未設定 → fail closed（ゲート有効・保護優先）**
  - `"true"` → ゲート有効
  - 明示した緊急解除値 `"false"` → pass-through
- Deploy Preview: 明示設定に従う。**未設定時の挙動をテストで固定**する。

## PR 分割と依存

| PR | 内容 | 依存 | 状態 |
|---|---|---|---|
| **PR-A** | セッション共通ライブラリ + テスト + 静的 guard + テスト配線 + 本メモ | — | **本 PR** |
| PR-B | `verify-magic-link` の `ak_session` 発行（有料判定）/ logout / session-refresh / auth-user 未認証更新廃止 / 無料・有料経路分離 | A | 未着手 |
| PR-C | Phase 1 Edge 緊急ゲート（URL allowlist / cookie 検証 / 未認証本文遮断 / fail closed / 安全 redirect） | A, B | 未着手 |
| PR-D… | Phase 2 SSR 化 + Astro middleware（ページ群ごと分割） | A, B | 未着手 |
| PR-E | クライアント AccessControl の権威性除去 / localStorage 旧キー移行 / auth-user 未認証更新の締め / **PR #128 close 判断** | D 完了後 | 未着手 |

本番投入順序: **PR-A → PR-B → PR-C**。PR-B（Cookie 発行）より前に PR-C（Edge ゲート）を本番有効化しない。

## PR-B 開始前に必要なユーザー操作（PR-A では不要）

1. Netlify 環境変数 `SESSION_SIGNING_SECRET`（32 文字以上のランダム値）を Functions と Edge の両方に設定。値はコード/ログ/PR に出さない。
2. 任意: `SESSION_TTL_MINUTES`（既定 20）、`EDGE_GATE_ENABLED`（PR-C 用）。
3. Airtable `Customers.SessionVersion`（integer, default 0）を追加（PR-B の失効制御用）。
4. product 判断: `/dark-horse-picks/` は公開ティーザーとして保護対象外（確定）。無料会員の毎日ログインポイントは廃止（確定）。新規登録初回ポイントは、レコード作成時付与（既存レコードの未認証更新ではない）のため維持可。

## 商品判断（確定 / 調査結果）

- `/dark-horse-picks/`: 公開ティーザー。保護対象外。
- 無料会員の**毎日ログインポイントは廃止**（PR-B で auth-user の未認証更新を停止）。
- 新規無料登録の**初回ポイントは維持可**: points は `point-exchange.js` / `claim-reward.js` で交換価値を持つが、初回付与は「新規レコード作成時」の 1 回で、**既存レコードの未認証更新ではない**ため方針（未認証 email で既存レコードを更新しない）と両立する。

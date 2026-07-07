# 有料セッション（ak_session）設計メモ

新認証設計の **PR-A（共通ライブラリ）** 実装分の仕様と、PR-B / PR-C で必要になる
前提・未実施事項をまとめる。実装は `src/lib/auth/`、テストは同ディレクトリの
`*.test.mjs`（`npm run test:auth-session`）。

> **本番投入順序は必ず PR-A → PR-B → PR-C。**
> 有効な `ak_session` を発行できる PR-B より先に、Edge ゲート（PR-C）を本番有効化しない。

## 認証方式（確定事項）

- 無料会員はメールアドレス入力だけで利用可（マジックリンクを送らない）。
- 無料会員用の状態は **有料アクセス権限に一切使わない**。
- 有料会員だけ正規マジックリンク認証を必須とする。
- 有料アクセスは **署名済み HttpOnly Cookie（`ak_session`）だけ**をサーバー側で検証する。
- localStorage は有料権限の判定に **使用しない**。

## PR-A スコープ（この PR で実装したもの）

セッション共通ライブラリ（純粋関数）・型・テスト・設計メモ・テスト配線のみ。
**Function / Edge / middleware / ページ / Airtable / Netlify 環境変数は一切変更しない。**

- 本番秘密鍵（`SESSION_SIGNING_SECRET`）は設定しない。
- Airtable スキーマ（`SessionVersion` フィールド）は追加しない。
- 単体テストは **テスト専用の固定鍵**を関数引数で注入する（本番用途ではない）。
- 実装コードに本番鍵・デフォルト秘密鍵を埋め込まない。

## ライブラリ構成（`src/lib/auth/`）

| ファイル | 責務 | ランタイム依存 |
|---|---|---|
| `constants.js` | バージョン / Cookie 名 / TTL 上限 / 時刻ズレ / 許可キー / Edge モード定数 | なし |
| `planNormalization.js` | plan / venueAccess 正規化・有料判定 | なし |
| `encoding.js` | base64url / UTF-8 変換（`btoa`/`atob`/`TextEncoder`。Buffer 非依存） | Web 標準のみ |
| `sessionCrypto.js` | HMAC-SHA256 署名 / timing-safe 検証 / 鍵検証 | `globalThis.crypto.subtle`（引数注入可） |
| `sessionPayload.js` | payload 生成 / 検証（allow-list・型・意味・TTL・時刻） | なし |
| `sessionCookie.js` | Set-Cookie 生成（セッション / ログアウト）・Cookie 読取 | なし |
| `session.js` | `createSession` / `verifySession` オーケストレータ | 署名層経由 |
| `edgeGatePolicy.js` | `EDGE_GATE_ENABLED` の 3 値解決（PR-C 設計） | なし |
| `index.js` | 公開エントリ（再エクスポート） | — |

### 3 ランタイム互換の担保

Node Functions / Astro middleware / Netlify Edge(Deno) で共有する。無理に 1 ファイルへ
統合せず、**ランタイム非依存ロジック**と **Web Crypto 署名層**を分ける。ライブラリ本体は:

- `Buffer` に依存しない（`btoa`/`atob` + `TextEncoder`/`TextDecoder`）。
- `process.env` / `Deno.env` を内部で読まない（環境変数は PR-B 以降の呼び出し側で読む）。
- `window` / `localStorage` / `document` / `fs` / `node:*` を参照しない。
- Web Crypto は `globalThis.crypto.subtle`（または引数 `subtle`）から使う。

これらは `staticGuards.test.mjs` の静的 guard で恒久的に強制する。

## payload 仕様

最小限の情報のみ。氏名 / points / 支払情報 / 内部メモ / Airtable レコード全体は入れない
（`ALLOWED_PAYLOAD_KEYS` の allow-list で強制。allow-list 外キーを含む payload は拒否）。

| キー | 型 | 説明 |
|---|---|---|
| `v` | integer | スキーマバージョン（現行 `1`）。未知は拒否。 |
| `sub` | string | 顧客の不透明 ID（Airtable recordId 等）。**email は入れない**。 |
| `plan` | string | 正規プラン（有料のみ。`free` は不可）。 |
| `venueAccess` | string[] | 正規 venue 配列（`['jra']` / `['nankan']` / `['jra','nankan']`）。 |
| `sessionVersion` | integer(>=0) | 失効管理用。詳細は下記。 |
| `issuedAt` | number(ms) | 発行時刻（epoch ミリ秒）。 |
| `expiresAt` | number(ms) | 失効時刻。`> issuedAt` かつ TTL 上限内。 |

### 検証ルール（`validatePayload` / `verifySession`）

オブジェクト以外・配列・必須キー欠落・不正型・未知 `v`・`expiresAt <= issuedAt`・
TTL 上限（`MAX_SESSION_TTL_MS` = **最大 30 分**）超過・未来すぎる `issuedAt`（`CLOCK_SKEW_MS` = 5 分超）・
`free` plan・不明 venue・`sessionVersion` 欠落 / 負数・不明キーはすべて拒否。
TTL 上限は短寿命セッション設計の絶対上限で、発行時（`buildPayload`/`createSession`）と
検証時（`validatePayload`/`verifySession`）の両方で強制する。
`CLOCK_SKEW_MS` は「未来すぎる `issuedAt`」の判定にのみ使い、**有効期限の延長には使わない**
（`now > expiresAt` を過ぎたら即 `expired`）。
失敗は例外を投げず **構造化された理由コード**（`PAYLOAD_REJECT` / `VERIFY_REJECT`）で返す。
ログに payload / email 相当 / secret は出さない（本体は `console` を使わない）。

## トークン / 署名仕様

```
token = base64url(UTF-8 JSON payload) + "." + base64url(HMAC-SHA256)
```

- 署名対象（signingInput）は **1 つ目の base64url payload 文字列**そのもの。
- 検証は timing-safe な `crypto.subtle.verify` を使う（**単純な文字列比較はしない**）。
- 秘密鍵は必ず引数注入。空 / 短すぎ（`MIN_SECRET_LENGTH` = 32 文字未満）/ 非文字列は失敗。
- 鍵欠落時は fail closed（`verifySession` は `key_missing` を返す）。

## Cookie 仕様

| 属性 | 値 |
|---|---|
| 名前 | `ak_session` |
| `HttpOnly` | 常に付与 |
| `Secure` | 常に付与 |
| `SameSite` | `Lax`（既定） |
| `Path` | `/`（既定） |
| `Max-Age` | 呼び出し側指定（正の整数）。ログアウト用は `0` |

`serializeLogoutCookie()` は値空・`Max-Age=0`・同一 Path / SameSite / Secure / HttpOnly。

## plan / venue 正規化

旧表記・大小文字・日本語・全角/半角を明示した正規値へ変換。未知は拒否（null → 発行 / 検証で拒否）。

- 正規プラン: `free`（発行不可）/ `light` / `premium` / `premium-predictions` /
  `premium-sanrenpuku` / `premium-sanrentan` / `premium-combo` / `premium-plus`。
- 別名例: `standard`→`light`、`プレミアム三連複`→`premium-sanrenpuku`、`pro-plus`→`premium-plus` など。
- 正規 venue: `jra` / `nankan`。`all`/`both`/`すべて` は両者へ展開。venue 配列は正規順にソート・重複除去。

> **PR-B の要対応**: 現行 Airtable `PlanType` の完全な語彙（`Premium Combo` / `Premium Plus` /
> `Premium Predictions` 等）との対応は `PLAN_ALIASES` に集約済み。DB 実値を read-only で確認し、
> 取りこぼす別名があれば **この表にのみ追記**する（表示側にローカル判定を作らない）。

## SessionVersion（失効管理）

- PR-A では payload の `sessionVersion` を **整数として扱える設計とテスト**のみを実装。
- Airtable フィールドはまだ追加しない。
- **PR-B 設計時**: フィールド欠落を `0` として扱う後方互換を用意し、フィールド導入後に値を
  1 以上へ更新可能にする。`sessionVersion` の比較（セッション失効判定）自体は **PR-B または
  refresh 側の責務**。PR-A では Airtable へ接続しない。

## EDGE_GATE_ENABLED の解決（PR-C 設計）

`edgeGatePolicy.resolveEdgeGateMode({ context, rawValue })` が 3 値へ解決する。
`if (!enabled) return next()` のような素通りは禁止。

| context | `rawValue` | 結果 |
|---|---|---|
| production | 未設定 / 不正値 | `fail-closed`（全拒否） |
| production | `"true"` | `enabled`（Cookie 検証） |
| production | `"false"`（緊急解除） | `pass-through`（素通り） |
| deploy-preview / branch / dev | `"true"` | `enabled` |
| deploy-preview / branch / dev | `"false"` | `pass-through` |
| deploy-preview / branch / dev | 未設定 | `enabled`（本番同等の保護。素通りは明示 `"false"` のみ） |
| deploy-preview / branch / dev | 不正値 | `fail-closed` |

環境変数（`EDGE_GATE_ENABLED` / Netlify `CONTEXT`）の読取は PR-C の Edge 本体で行う。

## PR-B 開始前に必要なユーザー操作

1. **本番秘密鍵の発行と設定**: `SESSION_SIGNING_SECRET`（32 文字以上のランダム値）を Netlify
   環境変数に設定（本番 / Deploy Preview の扱いも決める）。※ PR-A では未設定でよい。
2. **Airtable `SessionVersion` フィールド追加**（Customers）: 整数、既定 `0`。強制ログアウト時に
   +1 する運用を決める。
3. **セッション TTL の確定**: `MAX_SESSION_TTL_MS` = **最大 30 分**を絶対上限に、実 TTL を PR-B の
   発行側で指定（通常 20 分予定）。有料プラン有効期限は Cookie 再発行（延長）側で扱い、
   単一セッションの寿命は 30 分を超えない。Cookie の `Max-Age` も同じ実 TTL から生成する。
4. **`sub` に使う不透明 ID の確定**（Airtable recordId を採用するか）。

## PR-B 実装（無料/有料ログイン分離 + Cookie 発行）

PR-A の共通ライブラリを実際の認証経路へ配線した段階。**Edge ゲート・有料ページ SSR 化は
まだ行わない**（PR-C）。認可の真実源は HttpOnly Cookie `ak_session` に移行するが、
移行期は既存 localStorage（`user-plan` 等）を **非権威** の UI 互換として残す（PR-C/PR-D で削除）。

### 会員判定の単一源: `resolveMembership`（`src/lib/auth/memberResolution.js`）

サーバー専用・純粋関数。Airtable レコードの `fields` と `now` を受け取り I/O しない。
クライアント由来の plan は**引数に取らない**（推測・採用しない）。

| フィールド（正本） | 用途 |
|---|---|
| `プラン`（英語 `Plan` は互換別名） | ティア。`PlanType` は課金サイクルでありティアではない → **参照しない** |
| `Status` | `pending`/`入金待ち` は Free 扱い。`suspended`/`inactive`/`停止`/`解約` 等は denied |
| `有効期限`（`ValidUntil`/`ExpiryDate`/`ExpirationDate` は互換） | 期限切れ有料は **Free に落とさず denied** |
| `WithdrawalRequested` / `ForceLogout` | 真なら denied（lifetime より優先） |
| `VenueAccess`（文字列 `jra`/`nankan`/`all`） | 正規配列へ。未指定は両会場、未知値は denied |
| `LifetimeSanrenpuku`（`三連複Lifetime` 互換） | 真なら `premium-sanrenpuku` として paid 維持 |
| `SessionVersion`（**未作成**。欠落=0） | 負数/非整数/異常型は denied |

出力: `{ memberType: 'free'|'paid'|'denied', normalizedPlan, venueAccess, sessionVersion, recordId, reason, lifetimeSanrenpuku }`

### 経路別の分岐

| Function | 役割 |
|---|---|
| `auth-user.js`（無料経路） | email のみ。明確な Free だけ即時ログイン（固定 `plan:'free'`）。有料は `requiresMagicLink:true`（plan 名は返さない）。denied は 403。未登録は `/free-signup/`。**日次ポイント付与は廃止・email 入力での既存レコード更新ゼロ**。初回 1pt は新規作成時 1 回のみ |
| `send-magic-link.js`（有料送信） | `resolveMembership` が **paid のときだけ** token 発行 + 送信。free/denied/未登録は一定の 200（会員情報を列挙しない）。token は uuid v4・15分・単回 |
| `verify-magic-link.js`（検証+発行） | 純粋オーケストレータ `runVerifyMagicLink` に Airtable/secret/時計を注入。token 検証 → Customers 再取得 → `resolveMembership` → **paid のみ** `createSession`(20分) + `ak_session` 発行 → 会員判定・Cookie 準備成功後に token を再確認して使用済み化 → 更新成功時のみ `Set-Cookie` |
| `logout.js`（新規） | `ak_session` を Max-Age=0・同一属性で削除。Airtable/secret に触れない。全端末失効は SessionVersion 導入（PR-C）の別運用 |

### 秘密鍵の扱い

- `SESSION_SIGNING_SECRET` は **呼び出し側（Function）が `process.env` から読む**。
- 未設定・短すぎ（< 32 文字）は **fail closed**（verify は 503）。fallback 鍵は持たない。
- 値をログ・レスポンスへ出さない。テストは固定のテスト専用鍵を注入。

### token 単回性（Airtable の制約）

Airtable に原子的 compare-and-set が無いため、使用済み更新の**直前に token を再読込**して
未使用を再確認する最小リスク設計。会員判定・Cookie 準備が成功してから使用済みにし、
**使用済み更新が成功した場合だけ** `Set-Cookie` を返す（更新失敗時は Cookie を発行しない）。

### session refresh

PR-B には含めない（**PR-B2 へ分離**）。最初の有料ログイン Cookie は **20 分で失効**し、
その後は再度マジックリンクが必要。無制限ローリング更新は将来 PR-B2 で頻度制限付きで実装する。

### PR-C 前に必要なユーザー操作

1. Netlify に `SESSION_SIGNING_SECRET`（32 文字以上のランダム値）を設定（本番/Deploy Preview）。
   **未設定のままだと有料マジックリンク検証は 503（fail closed）で Cookie を発行しない**。
2. Airtable Customers に `SessionVersion`（整数・既定 0）フィールドを追加（欠落時は 0 として動作）。
3. `EDGE_GATE_ENABLED` の本番方針確定（PR-C の Edge ゲート導入時）。

## PR #128 / #129 の扱い

- **PR #128**: OPEN・未マージ・保留。merge / close / 追加 commit / cherry-pick を **しない**。
  新設計の参考資料としてのみ使用。
- **PR #129**: 問い合わせ自動入力として切り離し済み（本設計とは独立、マージ済み）。

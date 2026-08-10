# ログイン認証（マジックリンク方式）

> analytics-keiba のログイン仕様。
> Airtable Customers（nankan-analytics 既存DB）を引き継ぎ、認証フローは
> keiba-intelligence 流の **マジックリンク**（メール送信→リンククリック→セッション）。

## 設計方針

| 軸 | 採用 |
|---|---|
| 顧客DB | **nankan-analytics の Airtable Base を共有**（Customers テーブル流用） |
| 認証フロー | **マジックリンク**（メールアドレスだけで即ログインできる旧方式は廃止） |
| 認証情報の保存 | **localStorage**（AccessControl.astro の既存仕様と互換） |
| トークン保管 | nankan-analytics Airtable に **AuthTokens テーブル**を新設 |
| 別 Base 参照 | **しない**（keiba-intelligence の Airtable Base は使わない） |

## 構成要素

| パス | 役割 |
|---|---|
| `src/pages/login.astro` | メールアドレス入力フォーム → `send-magic-link` |
| `src/pages/auth/verify.astro` | URL の `?token=...` を `verify-magic-link` で検証 |
| `netlify/functions/send-magic-link.js` | Customers 確認 → AuthTokens 作成 → SendGrid でリンク送信 |
| `netlify/functions/verify-magic-link.js` | AuthTokens 検証（未使用 / 期限内）→ Customers 取得 → セッション JSON 返却 |
| `src/components/AccessControl.astro` | `localStorage['user-plan']` を読んでアクセス可否判定（既存挙動を維持） |

## ログインフロー

```
[ユーザー]
   ↓ メール入力
/login
   ↓ POST /.netlify/functions/send-magic-link  { email }
[Airtable] Customers 検索（存在しなくても 200 を返す＝enumeration 防止）
[Airtable] AuthTokens に {Token, Email, ExpiresAt(15分後), Used:false} 作成
[SendGrid] メール送信（リンク = /auth/verify?token=...）

[ユーザー] メールのリンククリック
/auth/verify?token=...
   ↓ GET /.netlify/functions/verify-magic-link?token=...
[Airtable] AuthTokens でトークン検証（未使用 / 期限内）
[Airtable] AuthTokens.Used = true（再使用防止）
[Airtable] Customers から PlanType / VenueAccess / 有効期限などを取得
   ↓ レスポンス { redirectTo, userPlan }
[クライアント] localStorage['user-plan'] = userPlan
[クライアント] redirectTo へ遷移（/premium-prediction/nankan/ など）
```

## 会員判定（`resolveMembership` が単一源）

ログイン可否は Airtable の値から `src/lib/auth/memberResolution.js` が決める。
**クライアントから送られた plan は使わない。**

| Customers の状態 | memberType | ログイン | 有料コンテンツ |
|---|---|---|---|
| Free | `free` | ✅ 即時 | ❌ |
| 有効な有料契約 | `paid` | ✅ マジックリンク | ✅ |
| 入金待ち（`Status=pending`） | `free` | ✅ 即時 | ❌ |
| **有効期限切れ**（`reason=expired`） | **`free`** | **✅ 即時** | ❌ |
| **退会申請**（`reason=withdrawal_requested`） | **`free`** | **✅ 即時** | ❌ |
| `LifetimeSanrenpuku=true`（base 期限切れでも） | `paid` | ✅ マジックリンク | ✅ 三連複のみ |
| 利用停止 / `ForceLogout` / 未知プラン（`Test` 等）/ plan 欠落 / 複数解釈 / SessionVersion 異常 | `denied` | ❌ 403 | ❌ |
| `UnsubscribedAnalyticsKeiba=true` | 判定に**影響しない** | 状態どおり | 状態どおり |

### ⏰ 期限切れ・退会申請を `free` に戻した経緯（2026-08-01）

PR-B（`7c479db` / 2026-07-08）で期限切れ有料・退会申請を `denied` にしたが、これは
**PR-B 以前の挙動からの意図しない後退**だった。旧 `auth-user.js` は期限切れでも 200 を返し
「有効期限が切れています。無料会員としてご利用いただけます。」と案内していた。

`denied` の間、元有料会員は理由の分からない 403
（「このアカウントではログインできません」）に当たり、**マイページ・保有ポイント・
ポイント交換・再契約導線のすべてに到達できなかった**。退会確認メールの
「契約期間終了後は自動的に Free プランに切り替わります」という案内とも矛盾していた。
2026-08-01 の本番実測では **75 名**（期限切れ 38 / 退会申請 37）が該当し、うち 67 名は
カムバック割引案内メールの配信対象だった（＝メールを読んでログインすると必ず 403）。

**旧挙動そのままには戻していない。**

- 旧: `プラン` の値（Premium / Light 等）をそのまま返し、クライアント側で期限を見て落としていた
- 新: **`normalizedPlan` は `'free'` 固定**。元のプラン名は返さない（権限判定に使わせない）

`memberType='free'` なので `issuePaidSessionCookie` / `sessionRefresh` /
`verifyMagicLinkFlow` / `shouldSendMagicLink` はいずれも通らず、**有料権限は 1 つも付かない**
（`authPolicies.test.mjs` の通しテストで固定）。Airtable の
`プラン` / `有効期限` / `PaymentConfirmed` / `PaidAt` / `PaymentEmailSent` は
**読むだけで書き換えない**（この経路は Customers へ 1 バイトも書かない）。

判定順（上から評価）:

1. `ForceLogout` / 利用停止 / SessionVersion 異常 → `denied`
2. プラン値が未知（`Test` 等）→ `denied`（退会・期限に関係なく）
3. `WithdrawalRequested=true` → `free`（無料特典も見ない＝特典で有料へ戻さない）
4. plan 欠落 → `LifetimeSanrenpuku` があれば三連複 `paid`、無ければ `denied`
5. `Status=pending` → `free`
6. 期限切れ → `LifetimeSanrenpuku` があれば三連複 `paid`、カムバック無料特典があればその範囲で `paid`、
   どちらも無ければ **`free`**
7. それ以外 → `paid`

### 契約終了の案内（プラン名は出さない）

`auth-user` は `previousPlanEnded: true`（真偽値のみ）を返し、`/login` が
「以前のご契約は終了しているため、無料会員としてログインしました」と案内する。
**プラン名・有効期限・金額は返さない**（メールアドレスだけで叩ける経路なので、
契約内容の詳細を列挙させない）。

無料ログイン時は、有料時代に書かれた `isExpired` / `originalPlan` / `validUntil` /
`lifetimeSanrenpuku` / `nankan_user` / `auth_data` 等の localStorage 残骸を削除する。
`AccessControl.astro` はこれらを見て有料 UI を出しうるため、
**入口だけ直して表示が漏れる**状態を防ぐ。

## 🍪 セッションは「リンクを開いたブラウザ」にだけ入る（2026-08-10 集約）

`ak_session` は **HttpOnly Cookie**（`sessionCookie.js` が固定生成）:

```
ak_session=<署名付き値>; Max-Age=2592000; Path=/; SameSite=Lax; HttpOnly; Secure
```

- **Domain 属性を付けない = host-only**。`analytics.keiba.link` にのみ送られる
- Max-Age は `DEFAULT_SESSION_TTL_MS`（**30日**）。`verify-magic-link` は `ttlMs` を渡さず既定値を使う
- 絶対上限は `ABSOLUTE_SESSION_TTL_MS`（90日）

### そのため「別ブラウザでは再ログインが必要」になる

Cookie は**リンクを開いたブラウザのクッキー領域にしか保存されない**。
メールアプリ内ブラウザ（iOS の WKWebView など）でマジックリンクを開くと、
そのアプリ内ブラウザにだけログインが残り、あとから Safari / Chrome を開くと未ログインになる。

これは仕様どおりだが、**利用者からは「ログインが保持されない不具合」に見える**
（2026-08-09〜10 に有効な有料会員から複数の問い合わせ。最有力仮説・未確定）。
そこで以下 2 箇所で必ず案内する。**消さないこと**（`loginReasonNotice.guard.test.mjs` が強制）:

| 場所 | 文面 |
|---|---|
| ログインメール（`send-magic-link.js`）| 「普段ご利用の Safari / Chrome などのブラウザでリンクを開いてください」 |
| `/auth/verify` 成功画面 | 「このブラウザへのログインが完了しました。次回から同じブラウザのブックマークからアクセスできます」 |

同画面の自動遷移は **6秒**（3秒では案内を読み切れないため）。ガードが 5000ms 未満を弾く。

### keep-alive（idle TTL の延長）— 単一源は `SessionKeepAlive.astro`

`ak_session` の Max-Age は**発行時に固定**される。誰も `refresh-session` を叩かなければ
一度も延びず、**最終ログインから 30 日で必ず再ログイン**になる。

そこで会員確定ページは共通部品 **`src/components/SessionKeepAlive.astro`** を置く。
表示のたび（および復帰時の `visibilitychange`）に `refresh-session` を 1 回叩き、
サーバーが Airtable を再照会して延長 / 据置 / 失効を決める。

| 配置先 | ページ |
|---|---|
| `gatePaidPage` で守る 11 ページ | `premium-prediction/{jra,nankan}` / `premium-predictions-{funabashi,urawa}` / `light-predictions{,-jra,-urawa,-funabashi}` / `premium-sanrenpuku{,-jra}` / `premium-select` |
| `verifyPlanAccess` で守る 2 ページ | `premium-plus` / `premium-plus-v2` |

**約束（`sessionKeepAlive.guard.test.mjs` が強制）**:

- `gatePaidPage` を使う SSR ページは**必ず**配線する（新規ページの漏れを検知）
- 実装をページへ直書きしない。`refresh-session` を叩いてよいのは部品だけ（単一源）
- **会員と確定していないページへ置かない**（未ログイン利用者が毎表示 401 を叩くだけになる）
- 1 ページに 1 個だけ（多重 ping を防ぐ）

> 2026-08-10 以前は `/premium-plus/` にしか入っておらず、予想ページしか見ない会員
> （＝大半）は 30 日ごとに必ず締め出されていた。
>
> 権利の鮮度自体は `gatePaidPage` が表示ごとに Airtable を引くので元から担保されている
> （退会・期限切れは次の表示で即失効）。keep-alive が足すのは **Cookie の寿命**だけ。
> 失効していてもその場では追い出さず、Cookie 削除により次の遷移で拒否される（fail closed）。

### 再発行の閾値は idle TTL に比例させる（スライディングウィンドウ）

keep-alive を叩いても、サーバーが再発行しなければ Cookie は延びない。
`decideRefresh` は **残り idle TTL が閾値以下のときだけ** 再発行する（それ以外は `keep` = 204）。

| 定数 | 値 | 意味 |
|---|---|---|
| `REFRESH_THRESHOLD_RATIO` | `0.5` | 残りが idle TTL の**半分**を切ったら再発行 |
| `REFRESH_THRESHOLD_FLOOR_MS` | 5分 | 比例値の下限（極端に短い TTL 用） |
| `resolveRefreshThresholdMs(idleTtlMs)` | — | 実効閾値 = `max(下限, idleTtlMs × 比率)` |

idle TTL 30日なら閾値は **15日**。つまり:

- **15日以内に 1 度でも会員ページを開けば失効しない**
- 再発行は最大でも半 TTL に 1 回（延長後は残りが 30日に戻る）＝ `Set-Cookie` は増えない
- 上限は絶対 TTL 90日（`ABSOLUTE_SESSION_TTL_MS`）。これを跨ぐと `reject` で再ログインが必要

> ⚠️ **閾値を固定値に戻さないこと。** 以前は固定 5 分だった。idle TTL が 20 分だった頃は
> 妥当だったが、2026-07-24 に **idle TTL だけ 30 日へ延ばした際に閾値が据え置かれ**、
> 再発行は「30 日の最後の 5 分間にアクセスした場合」しか起きなくなっていた。
> keep-alive を全有料ページへ配線しても Cookie は延びず（本番で 204=keep を実測）、
> 会員は最終ログインから 30 日で必ず締め出されていた。
> `sessionRefresh.test.mjs` の「閾値が idle TTL に対して極端に小さくならない」が再発を検知する。

## 🚦 有料ページの拒否は「認証失敗」と「一時障害」を分ける（2026-08-10）

`gatePaidPage`（`src/lib/auth/paidPageGate.js`）の拒否は 2 系統に分かれる。

### 一時障害 → **503**（`/login` へ送らない）

`TRANSIENT_DENY_REASONS` = `lookup_unavailable` / `lookup_failed` / `key_missing` /
`env_missing` / `unknown_required_plan`

`Retry-After: 30` 付きの案内ページを返し、**「ログイン状態は保持されています。ログインし直す必要はありません」**
と明示する。ページ内に `/login` への導線は置かない（ガードで強制）。

> ⚠️ 2026-08-08 の障害の教訓: Airtable の一時障害（429 / タイムアウト）で有効会員が
> `302 /login` に飛ばされ、「ログインが切れた」と誤認して再ログインを繰り返した。
> 再ログインしても Airtable は復旧しないので直らず、負荷が増えて 429 がさらに出る悪循環になった。
> **利用者が再ログインしても直らない失敗を `/login` へ送らない**のがこの分離の目的。

### 認証失敗 → `/login/?r=<コード>` へ 302

| 内部 reason | `?r=` | `/login` の表示 |
|---|---|---|
| `no_cookie` / `verify_failed` / `no_subject` / `customer_not_found` | `no_session` | ログイン情報が確認できませんでした（＋別ブラウザ問題の案内）|
| `session_expired`（payload が `expired` / `absolute_expired`）| `session_expired` | ログインの有効期限が切れました |
| `plan_not_allowed` / `entitlement_denied` | `not_entitled` | 現在のご契約プランの対象外です |

- コードは `LOGIN_REASON_CODE` の allow-list。**未知の内部 reason は既定値へ丸める**ので、
  Location ヘッダに未知の文字列は出ない
- `/login` 側は `?r=` を**そのまま描画しない**。allow-list 一致時のみ固定文言を `textContent` で入れる
- 表示可能コードと gate の公開コードの一致は `loginReasonNotice.guard.test.mjs` が強制する
- `notFound: true`（存在秘匿ページ）でも**一時障害は 503**。この分岐へ来るのは有効な署名 Cookie を
  持つ利用者だけなので、ページの存在は漏れない

## Airtable スキーマ

### Customers（既存・nankan-analytics 流用）

代表的に参照されるカラム（無くても動作するが、有るとプラン判定が正しく動く）:

| カラム | 用途 |
|---|---|
| `Email` | 必須。Magic link 検索キー |
| `Name` または `お名前` | メール本文の宛名 |
| `Status` | `inactive` の場合のみ拒否（`active` / 未設定 / 他値は通す） |
| `PlanType` | `pro` / `pro-plus` / `premium` / `premium-plus` / `standard` / `light` / `free-registered` 等 |
| `VenueAccess` | `jra` / `nankan` / `all`（プラン別 redirect に使用） |
| `ExpirationDate` または `有効期限` | 有効期限（任意） |
| `LifetimeSanrenpuku` | 三連複 Lifetime 権利（任意） |
| `AccessEnabled` | 認証完了時に true に更新される |

### AuthTokens（新規追加）

**nankan-analytics Airtable Base に Airtable UI から手動で作成する。**

| カラム | 型 | 用途 |
|---|---|---|
| `Token` | Single line text | UUID v4。検索キー |
| `Email` | Email | 紐付くユーザー |
| `CreatedAt` | Date (ISO) | 発行時刻 |
| `ExpiresAt` | Date (ISO) | 有効期限。単一源は `src/lib/auth/constants.js` の `MAGIC_LINK_TTL_MINUTES`（現在 **60分**）|
| `Used` | Checkbox | 使用済みフラグ |
| `Ip_Address` | Single line text | 発行リクエスト元 IP |
| `User_Agent` | Long text | 発行リクエストの User-Agent |

## 環境変数（Netlify ダッシュボードで設定）

| 変数名 | 値 | 必須 |
|---|---|---|
| `AIRTABLE_API_KEY` | nankan-analytics と同じ Personal Access Token | ✅ |
| `AIRTABLE_BASE_ID` | nankan-analytics と同じ Base ID（例: `apptmQUPAlgZMmBC9`） | ✅ |
| `SENDGRID_API_KEY` | SendGrid 送信用 API Key | ✅ |
| `SENDGRID_FROM_EMAIL` | 送信元メール（例: `noreply@analytics.keiba.link`） | 推奨 |
| `MAGIC_LINK_BASE_URL` | マジックリンクのベース（既定 `https://analytics.keiba.link`） | 任意 |

設定方法:
```
Netlify dashboard → Sites → analytics-keiba → Site settings → Environment variables
```

## セキュリティの担保

- トークンは UUID v4 + 15分 TTL + 1回限り（`Used` で再使用拒否）
- 存在しないメールでも 200 を返してメールアドレス列挙を防止
- CORS は `analytics.keiba.link` / `analytics-keiba.netlify.app` / localhost のみ許可
- `Status === 'inactive'` のアカウントは明示的に拒否
- `localStorage` に保存するセッションには expiry を含める（7日）

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `500 Airtable env not configured` | Netlify env に `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` を設定 |
| `500 SendGrid env not configured` | `SENDGRID_API_KEY` 未設定 |
| `Token not found` | リンクが古い／コピペミス。`/login` から再送 |
| `Token expired` | 15分超過。`/login` から再送 |
| `Token already used` | リンクは1回限り。`/login` から再送 |
| メール届かない | SendGrid の Sender Authentication / DNS 確認 |
| Customers 検索でヒットしない | nankan-analytics 側の Customers にメール登録があるか確認 |

## 関連ドキュメント

- `astro-site/docs/PREDICTION_LOGIC.md` — 予想ロジック
- `astro-site/docs/BET_POINT_LOGIC.md` — 購入点数ロジック

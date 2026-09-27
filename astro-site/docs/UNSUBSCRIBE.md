# 配信停止（Unsubscribe）— 正本

> **完成条件: Unsubscribe は 1 件ごとの人手対応を要求しない。**
> 利用者がメールクライアントで「配信停止」を押す → AK へ自動反映 → 以後のマーケティング
> メールから自動除外、までが**無人で完結**すること。MK の日常作業は 0。
>
> 以下は**完成形として認めない**:
> - `unsubscribe@keiba.link` の受信箱を人が見る
> - MK が Airtable / EmailBlacklist を手編集する
> - Claude へ 1 件ずつ依頼する

## 1. 経路は HTTPS ワンクリックだけ（mailto は出さない）

送信メールに付けるヘッダ（単一源 `src/lib/unsubscribe/listUnsubscribeHeaders.js`）:

```
List-Unsubscribe: <https://analytics.keiba.link/.netlify/functions/unsubscribe?email=…&brand=analytics-keiba>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

### 🚫 mailto を併記しない（2026-09-16 確定 / 実害あり）

旧実装は全 6 経路で `<https://…>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>` と
併記していた。**Apple Mail は mailto があるとそちらを選ぶ**ため、利用者が配信停止を押すと
`unsubscribe@keiba.link` へメールが飛ぶだけで **AK 側の状態は 1 ビットも変わらない**。
受信箱を人が見て手で止めるまで配信が続いていた（2026-09-16 に実際に届いて発覚）。

主要クライアントは HTTPS ワンクリックに対応しているため、mailto を外して問題ない:

| クライアント | 挙動 |
|---|---|
| Gmail（Web / モバイル）| `List-Unsubscribe-Post` を見て HTTPS へ POST |
| Yahoo! / AOL | 同上 |
| Outlook.com / Microsoft | HTTPS の URI を開く |
| Apple Mail（macOS 13+ / iOS 16+）| RFC 8058 対応。**mailto が無ければ HTTPS を使う** |
| 旧版・その他 | ネイティブボタンが出ないだけ。**本文末尾の配信停止リンクは常にある** |

**guard**: `listUnsubscribeHeaders.test.mjs` が全送信 Function を走査し、
mailto 併記と単一源の迂回を検出する。

## 2. 記録先は 2 つ（どちらかに入れば「止まった」）

配信対象は 2 つの母集団に分かれている。**両方へ書きにいく。**

| 母集団 | 保管場所 | 停止の表現 | 送信直前の除外 |
|---|---|---|---|
| 会員・登録者 | Airtable `Customers` | `UnsubscribedAnalyticsKeiba` = true | `customerMarketingAudience.js`（唯一の明示的なメール拒否）|
| 見込み客（CSV 取り込み）| Redis `ak:prospect:` | `state=SUPPRESSED` / `suppressedReason=unsubscribe` | `prospectDispatchContext.js` の `suppressed` |

> ⚠️ **見込み客を忘れない。** 配信の大半は見込み客宛で、旧実装は `Customers` しか見ておらず
> `email-not-found` → 200 を返して**何も記録していなかった**。押した本人は止めたつもりで届き続ける。

判定の単一源は `src/lib/unsubscribe/unsubscribeOutcome.js`:

- `planUnsubscribeSinks()` … どこへ書くか
- `summarizeUnsubscribeOutcome()` … 成功/失敗の判定

## 3. fail closed（握り潰さない）

| 状況 | 返す status | 意味 |
|---|---|---|
| どちらかに記録できた | **200** | 止まった |
| 既に停止済み（冪等）| **200** | 止まっている |
| どこにも居ない | ワンクリック **200** / JSON **404** | 目的は達成。アドレスの存在有無を漏らさない |
| **記録できなかった** | **502** | 2xx を返さない。止まっていないのに「止まった」と言わせない |
| brand / メール形式が不正 | 400 | 入力エラー |
| 設定不足 | 503 | 直す機会を失わないため 2xx にしない |

## 4. 混同しない

- **配信停止 ≠ 退会**。`WithdrawalRequested` は課金契約の話で、メール拒否ではない
- **配信停止 ≠ 権限**。`プラン` / `Status` / `有効期限` は 1 つも触らない
- **transactional は止めない**。入金確認・利用開始メール（`payment-email-worker` /
  `confirm-bank-payment`）は配信停止フラグを**見ない**（guard で固定）
- **配信再開（resubscribe）は `Customers` だけ**。見込み客の抑止は解除しない
  （再取り込み・再登録で復活させない）。SendGrid の `group_resubscribe` も同じ（§8）

## 5. 他人を止められない（URL に署名する）

ワンクリックの宛先は **URL 側**（`?email=…`）が正本。POST body の値は宛先に使わない。
**それだけでは足りない**: URL の `email` を書き換えて POST すれば他人を止められるため、
受信者ごとの URL に **改ざん防止の署名**を付ける（2026-09-16 / MK 指摘）。

```
?email=…&brand=…&sig=<HMAC-SHA256 の先頭 32 hex>
sig = HMAC(signingKey, `${brand}\n${email.toLowerCase()}`)
```

`brand` も署名対象に入れる（入れないと片方のブランドの URL を使い回せる）。

### 鍵（新しい production env を増やしていない）

| 優先 | 由来 |
|---|---|
| 1 | `UNSUBSCRIBE_LINK_SECRET`（任意。完全分離したくなったとき）|
| 2 | `PROMO_OFFER_SECRET` から **`HMAC(secret, 'ak:unsubscribe-link:v1')` で派生**（既定・production 設定済み）|

`PROMO_OFFER_SECRET` は「受信者ごとのメールリンクに署名する」同じ用途の鍵なので派生して再利用する。
**一方向なので、この派生鍵が漏れても offer トークンは偽造できない**（用途分離）。
admin secret のような bearer 資格情報は鍵に使わない。

**署名は優先鍵 1 本、検証は設定済みの全鍵**で行うため、後から専用鍵を足しても既存リンクは生き続ける。

### 判定

| ケース | 結果 | 書き込み |
|---|---|---|
| 署名が一致 | 受理 | する |
| **email を書き換え** | **400 `signature-invalid`** | **0** |
| **brand を書き換え** | **400 `signature-invalid`** | **0** |
| **sig 欠落** | **400 `signature-required`** | **0** |
| **sig 改ざん** | **400 `signature-invalid`** | **0** |
| 鍵が 1 本も無い | 503 `signature-key-missing` | 0 |

検証は **Airtable / Redis へ触る前**に行う（guard テストで順序を固定）。
ワンクリックでも 2xx を返さない＝「止まった」と誤解させない。

### 既に送信済みのメール（署名なしリンク）

既定は **strict（署名必須）**。`UNSUBSCRIBE_ALLOW_UNSIGNED=1` を立てている間だけ
署名なしを受理する。**開いている間は改ざんも通る**ので、救済が必要なときに期間を決めて
MK が明示的に開ける運用とする（既定では閉じている）。

> 本文末尾の配信停止リンクも同じ `buildUnsubscribeUrl()` で作るため、**同じ署名を通る**。
> 確認ページ（GET）は署名を query で引き継いで POST する。


## 6. 関連ファイル

| 目的 | ファイル |
|---|---|
| ヘッダの単一源 | `src/lib/unsubscribe/listUnsubscribeHeaders.js` |
| リクエスト解釈・status | `src/lib/unsubscribe/parseUnsubscribeRequest.js` |
| **URL の改ざん防止（署名）** | `src/lib/unsubscribe/unsubscribeSignature.js` |
| 記録先と成否の単一源 | `src/lib/unsubscribe/unsubscribeOutcome.js` |
| エンドポイント | `netlify/functions/unsubscribe.js` |
| 見込み客の抑止 | `src/lib/marketing/prospectStore.js` の `recordSuppression()` |
| 送信直前の除外 | `netlify/functions/marketing-campaign-dispatch.js` / `prospectDispatchContext.js` |
| **AK ⇄ SendGrid `AK Marketing` の橋渡し（§8）** | `src/lib/unsubscribe/akMarketingGroupBridge.js` |
| テスト | `npm run test:unsubscribe`（`check:safety` と CI に組込済み）|

## 7. 残っている穴（把握のうえ許容）

**過去に送信済みのメール**には mailto 付きのヘッダが残っているため、そこから配信停止された
場合は `unsubscribe@keiba.link` に届く。新規送信分では起きない。
恒久対応が要る場合は「受信メールを解析する基盤」が必要になるが、**既存 HTTPS 経路で
解決できる範囲を超える**ため、必要になった時点で別途判断する（現時点では未実装）。

## 8. AK ⇄ SendGrid unsubscribe group `AK Marketing` の橋渡し（2026-09-27 MK 確定 / **実装済み・本番未有効**）

SendGrid Marketing Campaigns の配信（選別・週次）は、配信停止を SendGrid の unsubscribe group
**`AK Marketing`（id 34108）**で扱う。旧 AK 経路は §1 の HTTPS ワンクリック → Customers。
**2 本が互いに伝わっていなかった**（2026-09-27 時点で `AK Marketing` の group 停止 34 件は Customers に未反映）。

単一源: `src/lib/unsubscribe/akMarketingGroupBridge.js`。**AK が正本**、SendGrid の group suppression は送信時の最後の砦。

### SendGrid → AK（`sendgrid-webhook.js` の 8 段目）

| イベント | `asm_group_id` | Customers |
|---|---|---|
| `group_unsubscribe` | **34108（AK Marketing）** | `UnsubscribedAnalyticsKeiba=true`（既に true なら何もしない）|
| `group_resubscribe` | **34108** | **AK 側の停止より新しいときだけ** false へ戻す。時刻が無い・古い再開では戻さない |
| 上記 2 種 | KI（29174）・テスト（28368）・その他 | **変えない**（`foreign_group`）|
| 上記 2 種 | 無い・数値でない | **変えない**（`unknown_group` / fail closed）|
| `unsubscribe`（global）・bounce・spam 等 | — | 橋渡しは関与しない（既存の `EmailBlacklist` 処理のまま）|

- 署名検証を通ったあとにだけ動く（guard テストで順序を固定）。独立した try/catch で、失敗しても他の段を止めない。
- 同じ人の複数イベントは**新しいほう**、同時刻は**停止を優先**。同じアドレスが Customers に 2 件ある場合は書かない。
- 失敗しても SendGrid に再送は求めない（他の段の書き込みまで重ねて走るため）。件数だけ残す。

### AK → SendGrid（`unsubscribe.js`）

- Customers の停止を**記録できたときだけ**、`AK Marketing` の **group suppression** へアドレスを直接加える
  （`POST /v3/asm/groups/34108/suppressions`）。**global unsubscribe は使わない**（KI の配信まで止まる）。
- 書く前に `GET /v3/asm/groups/34108` で **id と名前の両方**を照合し、違えば書かない。contact 検索はしない。
- 同じアドレスを何度加えても 1 件（冪等）。
- **利用者への応答は同期の成否で変えない**（AK が正本で、週次の宛先は AK の判定から作るため送られない）。
- **AK 側の配信再開（resubscribe）では SendGrid 側を触らない**（止め続ける側に倒す。解除の向きは未確定・下記）。

### gate

`AK_MARKETING_UNSUBSCRIBE_BRIDGE_ENABLED=true` のときだけ書く。それ以外は判定と件数だけ。
**本番の有効化は env 変更＋redeploy（要承認）**。

### 有効化の前提（未実施）

1. Event Webhook で `group_unsubscribe` / `group_resubscribe` を受け取る設定（SendGrid 設定変更・要承認。
   2026-09-18 時点で `group_unsubscribe: false`）
2. gate env の投入＋redeploy
3. 既に `AK Marketing` で止まっている 34 件（2026-09-27 実測）を Customers へ反映するかの判断（一括反映は別承認）

### 未確定（MK 判断待ち）

- AK 側で配信再開したとき、SendGrid の group suppression から外すか（現状は外さない）。
- 見込み客（prospect）経路は `group_unsubscribe` を **group を問わず**停止扱いにしている（`prospectPolicy.classifyEvent`）。
  KI の group 停止で AK の見込み客が止まり得る（安全側だが分離の原則とは合わない）。今回は変更していない。

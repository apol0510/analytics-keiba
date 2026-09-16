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
  （再取り込み・再登録で復活させない）

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
| **旧 mailto 残件の一括精算（一度きり）** | `src/lib/unsubscribe/unsubscribeBackfill.js` / `netlify/functions/admin-unsubscribe-backfill.js` |
| 記録先と成否の単一源 | `src/lib/unsubscribe/unsubscribeOutcome.js` |
| エンドポイント | `netlify/functions/unsubscribe.js` |
| 見込み客の抑止 | `src/lib/marketing/prospectStore.js` の `recordSuppression()` |
| 送信直前の除外 | `netlify/functions/marketing-campaign-dispatch.js` / `prospectDispatchContext.js` |
| テスト | `npm run test:unsubscribe`（`check:safety` と CI に組込済み）|

## 7. 旧 mailto 残件の一括精算（**一度きり**・通常運用ではない）

**cutoff: `2026-09-16T14:56:15.220Z`（= PR #558 が production へ published された実測時刻）。**
merge 時刻（14:54:44Z）ではない。

この時刻より前に送ったメールには mailto 付きヘッダが残っているため、そこから配信停止された
依頼は `unsubscribe@keiba.link` の受信箱に溜まり、**AK 側には反映されていない**。
その積み残しを**一度だけ**まとめて反映し、旧 mailto 残件をゼロにしてクローズする。

> **以後の通常運用にはしない。** 正規経路は §1〜§6（HTTPS ワンクリック）だけ。
> 受信箱を人が見る運用へ戻さない。

### 手順（`admin-unsubscribe-backfill`）

1. 受信箱から旧方式の依頼アドレスを抽出（宛先が `unsubscribe@keiba.link` /
   件名 `Unsubscribe` / 自動解除本文 / cutoff より前の送信メール由来）。
   問い合わせ・返信・迷惑メールは混ぜない
2. **dry-run**（既定）で件数を確定する
3. `dryRun:false` ＋ **`expectedCount`（dry-run で出た `needsWrite` と同じ数）**で適用

```
POST /.netlify/functions/admin-unsubscribe-backfill
  x-admin-secret: <UNSUBSCRIBE_BACKFILL_SECRET>
  { "emails": [...], "dryRun": true, "operationId": "legacy-mailto-2026-09-17" }
```

### 安全条件

| 条件 | 実装 |
|---|---|
| 書き込みは #558 の正本を再利用 | `updateUnsubscribeStatus` / `suppressProspect` を呼ぶだけ |
| dry-run が既定 | `dryRun !== false` |
| 承認した人数と違えば実行しない | `expectedCount` 不一致で 409 |
| 二重実行しても副作用なし | 既停止者は `already` で変更なし |
| Customers / 見込み客の**双方**に対応 | 片方にしか居ない人も停止できる |
| **判定不能は書かない** | 片方でも読めなければ `unknown` → 書き込み 0 |
| 契約・権限・退会・決済に触れない | guard テストで固定 |
| メール送信 0 | guard テストで固定 |
| 生アドレスを出さない | 戻り値・ログとも `emailTraceId` のハッシュのみ |
| 途中失敗の追跡 | `traces[]` と `applied[]` を trace 単位で返す（207 で部分成功） |
| 認可 | `UNSUBSCRIBE_BACKFILL_SECRET` **専用**。他の管理 secret へ fallback しない |

### rollback / 再実行

- **再実行**: 同じ入力をそのまま投げ直す。既に停止済みの人は変更されない（冪等）
- **rollback**: 誤って止めた人は `Customers` の `UnsubscribedAnalyticsKeiba` を false へ戻す
  （= 配信再開）。見込み客の抑止は意図的に解除しない仕様なので、必要なら
  Redis の `state` を個別に戻す判断が要る
- 部分失敗（207）は `applied[]` の trace で「どこまで成功したか」を突き合わせ、
  同じ入力で再実行すれば残りだけが処理される

### 残っている穴

cutoff より前のメールは今後も mailto から依頼が届き得る。**この一括精算でゼロにした後も、
受信箱に新しく届いたら同じ手順でもう一度精算する**（恒常的な受信メール解析基盤は作らない）。

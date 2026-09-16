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

## 5. 他人を止められない

ワンクリックの宛先は **URL 側**（`?email=…`）が正本。POST body の値は宛先に使わない。
body から任意アドレスを止められると第三者による嫌がらせが成立する。

## 6. 関連ファイル

| 目的 | ファイル |
|---|---|
| ヘッダの単一源 | `src/lib/unsubscribe/listUnsubscribeHeaders.js` |
| リクエスト解釈・status | `src/lib/unsubscribe/parseUnsubscribeRequest.js` |
| 記録先と成否の単一源 | `src/lib/unsubscribe/unsubscribeOutcome.js` |
| エンドポイント | `netlify/functions/unsubscribe.js` |
| 見込み客の抑止 | `src/lib/marketing/prospectStore.js` の `recordSuppression()` |
| 送信直前の除外 | `netlify/functions/marketing-campaign-dispatch.js` / `prospectDispatchContext.js` |
| テスト | `npm run test:unsubscribe`（`check:safety` と CI に組込済み）|

## 7. 残っている穴（把握のうえ許容）

**過去に送信済みのメール**には mailto 付きのヘッダが残っているため、そこから配信停止された
場合は `unsubscribe@keiba.link` に届く。新規送信分では起きない。
恒久対応が要る場合は「受信メールを解析する基盤」が必要になるが、**既存 HTTPS 経路で
解決できる範囲を超える**ため、必要になった時点で別途判断する（現時点では未実装）。

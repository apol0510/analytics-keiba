# お問い合わせ（/contact/）リニューアル — 2026-11-09 MK 指示

## 問題
MK「以前は問い合わせがあったが、今はない」。

## 調べたこと（2026-11-09・個人情報は記録しない）

| 確認 | 結果 |
|---|---|
| 届いているか | 本番へ運用テストを 1 件送信 → SendGrid `delivered` → Cloudflare Email Routing（catch-all）→ 運用 Gmail の**受信トレイ**に到着。**経路は正常** |
| Cloudflare 30 日 | フォーム通知 3 件（10/22・10/30・11/2）はすべて Forwarded。Dropped / Rejected なし |
| Function ログ | contact-form のエラー 0 件（成功時はログを出していなかったので件数は数えられなかった） |
| 運用 Gmail のフォーム通知（月別） | 7 月 23 / 8 月 27 / **9 月 9 / 10 月 12（うち 10/1〜6 に 9） / 11 月 1〜8 日 1** |
| GA4 /contact/ アクティブユーザー（月別） | 5 月 26 / 6 月 9 / 7 月 51 / 8 月 36 / 9 月 25 / 10 月 21 / 11 月 1〜8 日 4 |
| /contact/ の閲覧割合 | 0.18%（7 月）→ 0.07%（10 月）。サイト全体の閲覧は横ばい |

結論: 届かないのではなく、**/contact/ へ来る人が減り、来た人も送る量が減った**。
加えて次の 2 つの欠陥があった:

1. **送信成功が画面に出ない**: 成功表示（`#formMessage`）が form の中にあり、`SubmissionResult` が成功時に form を `display:none` にするため、
   送っても何も表示されずフォームが消えるだけだった（実ブラウザで確認）。
2. **入力をそのまま HTML メールへ入れていた**: 自動返信は入力されたアドレスへ support@keiba.link 名義で届くため、HTML を差し込める状態だった。

## 変えたこと

| 項目 | 変更 |
|---|---|
| よくある質問カード | ログインのメール / 支払い・入金 / プラン・料金 / 退会。案内先リンクと「このまま質問する」（種類を選んだ状態でフォームへ）を両方出す |
| 種類 | 正本 `src/lib/contact/contactForm.js` の `CONTACT_TOPICS`（8 種・閉じた語彙）。旧件名も受け付ける |
| 入力 | お名前は任意（空なら「お客様」）。種類ごとに本文の例とヒントを出す。`/contact/?topic=payment` で種類を指定して来られる |
| 信頼 | 「運営者がすべて直接読みます」「通常 2 営業日以内」（自動返信と同じ値）。返信は support@keiba.link からと明記。旧文言「専門スタッフ」「24時間対応」は実態と自動返信の記載に合わないため削除 |
| 成功表示 | `#formMessage` を form の外へ（guard test あり） |
| 安全 | HTML エスケープ・honeypot（`website` 欄）・本文 5,000 字上限・JSON 不正は 400 |
| 計測（GA4） | `contact_form_start` / `contact_help_click` / `contact_submit`（受理後だけ）/ `contact_error`。パラメータは `contact_topic`（閉じた語彙）だけ |
| 計測（ログ） | 成功時 `[contact-form] accepted { topic }`（個人情報なし）→ `netlify logs --function contact-form` で件数を数えられる |

## 評価（実験として扱う）
- baseline: 9〜10 月 月 9〜12 件（フォーム通知）・/contact/ 月 21〜25 人。
- 見る指標: `contact_submit` / `/contact/` 到達、`contact_help_click`、月の問い合わせ件数。
- 期間: 本番反映から 28 日。件数が少ないため短期の増減で仕様を変えない。
- 次の仮説（未着手）: /contact/ への到達が減っている。ログイン画面・決済後画面・マイページなど「詰まる場所」から `/contact/?topic=…` へ直接案内する。

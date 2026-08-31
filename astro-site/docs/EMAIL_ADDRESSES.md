# メールアドレスの正本（2026-08-31 固定）

旧サイト（南関中心）時代の名残である `nankan.analytics@gmail.com` /
`nankan-analytics@keiba.link` を現役経路から全廃し、**役割ごとに 1 アドレス**へ固定した記録。

## 契約

| 役割 | アドレス | 定数（正本） |
|---|---|---|
| 問い合わせ・**返信先** | `support@keiba.link` | `SUPPORT_EMAIL` |
| 管理者宛通知の**宛先** | `support@keiba.link` | `ADMIN_EMAIL` |
| **システム送信元** | `noreply@keiba.link` | `FROM_EMAIL` |
| メール本文に出す表示用 | `support@keiba.link` | `DISPLAY_SUPPORT_EMAIL` |

正本ファイル: **`astro-site/netlify/functions/config/email-config.js`**
アドレスを変えるときは**このファイルだけ**を直す。各 Function・各ページに直書きしない。

## 受信と送信（インフラ）

- **受信**: `keiba.link` の MX は **Cloudflare Email Routing**
  （`route1/2/3.mx.cloudflare.net`）。`support@keiba.link` 宛は運用 Gmail 受信箱へ転送される。
- **送信（サービス）**: SendGrid。`keiba.link` はドメイン認証済み（受信側で 送信元/署名元 = `keiba.link`）。
  SPF: `v=spf1 include:_spf.mx.cloudflare.net include:spf.bmv.jp include:sendgrid.net ~all`
- **送信（人手の返信）**: Cloudflare Email Routing は**受信専用**で SMTP を持たない。
  Gmail から `support@keiba.link` 名義で返信するには、Gmail の
  「アカウントとインポート → 他のメールアドレスを追加」に SMTP（`smtp.sendgrid.net` / 587 /
  ユーザー名 `apikey`）で登録する。**この設定は本タスクでは未実施**（運用側の作業）。
  - ⚠️ API キー等の secret は本ドキュメント・commit・ログに**記載しない**。
  - 旧 `nankan.analytics@gmail.com` / `nankan-analytics@keiba.link` の送信元（send-as）は、
    新しい送信元の動作確認後に Gmail 側から削除する。

## 経路別マッピング

| 経路 | ファイル | to | from | reply-to |
|---|---|---|---|---|
| お問い合わせ | `netlify/functions/contact-form.js` | `ADMIN_EMAIL` | `SUPPORT_EMAIL` | 管理者宛=送信者 / 自動返信=`SUPPORT_EMAIL` |
| 退会申請 | `netlify/functions/process-withdrawal.js` | `ADMIN_EMAIL` | `SUPPORT_EMAIL` | 同上 |
| Premium Plus 問い合わせ | `netlify/functions/premium-plus-contact.js` | `ADMIN_EMAIL` | `FROM_EMAIL` | `SUPPORT_EMAIL` |
| ポイント交換申請 | `netlify/functions/point-exchange.js` | `ADMIN_EMAIL` / 申請者 | `FROM_EMAIL` | - |
| 期限切れ通知 | `netlify/functions/expiry-notification.js` | `ADMIN_EMAIL` | `FROM_EMAIL` | `FROM_EMAIL` |
| 期限 1 週間前通知 | `netlify/functions/expiry-warning-notification.js` | `ADMIN_EMAIL` | `FROM_EMAIL` | `FROM_EMAIL` |

## 例外（`email-config.js` を参照しない経路）

**触る前に必読。**「統一」を理由に寄せ替えると事故になる。

| 経路 | 単一源 | なぜ寄せ替え禁止か |
|---|---|---|
| 入金確認メール v2 | `src/lib/payments/senderIdentity.js` | 正式送信元は `support@keiba.link`。env `SENDGRID_FROM_EMAIL` と不一致なら **fail closed**。`FROM_EMAIL`（noreply）への fallback は禁止 |
| メルマガ / 一斉配信 | `src/lib/newsletter/brand-config.js` | From が `DeliveryKey`（campaign × version × 受信者 × **送信元**）の構成要素。変えると既送分と鍵が変わり**二重送信**。Reply-To は鍵に入らないので `support@keiba.link` |
| 問い合わせ / 退会の From | `email-config.js` の `SUPPORT_EMAIL` | 2025-11-26 に迷惑メール対策で noreply → support へ変更した経緯。**noreply へ戻さない** |

## 対象外

- `nankan-stripe-integration/`（**旧実装**）は本 Netlify サイトの build 対象外
  （`netlify.toml` の `base = "astro-site"`）。旧アドレスが残るが**現役経路ではない**ため触らない。
- `astro-site/src/lib/resend-utils.js` は repo 内から import されていない（現役経路ではない）。
  混乱防止のためアドレスだけ正本値へ揃え、未使用である旨をファイル冒頭に明記した。
- `docs/progress.md` / 各ファイルのコメントに残る旧アドレスは**過去経緯の記録**。ガードは
  コメントを除去してから検査するので検知されない。

## 検証

```bash
cd astro-site
npm run test:email-identity   # 旧アドレス再混入・契約値・import 配線を検査
npm run check:safety          # 上記を含む全 safety check
```

ガード本体: `astro-site/src/lib/email/emailIdentity.guard.test.mjs`
CI: `.github/workflows/safety-check.yml` に個別 step として追加済み。

検査内容:
1. `netlify/functions` / `src` / `scripts` の現役コード（コメント・テストを除く）に旧アドレスが無い
2. `email-config.js` の 4 定数が契約値どおり（`ALT_EMAIL` は復活させない）
3. メール送信する現役 Function 6 本が `email-config.js` を import している
4. 決済メールの送信元が `senderIdentity.js`（support）のまま
5. メルマガの From が `noreply` / Reply-To が `support` のまま

## rollback

コードのみの変更（env・Airtable・SendGrid 設定は不変）。
`git revert` で旧アドレスへ戻るが、**ガードが revert を検知して CI が落ちる**ため、
戻す場合は `emailIdentity.guard.test.mjs` の扱いも同時に決めること。

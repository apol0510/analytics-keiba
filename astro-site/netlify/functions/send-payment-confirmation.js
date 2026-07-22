/**
 * send-payment-confirmation.js — **廃止済み（410 Gone）**
 *
 * ⚠️ この Function は 2026-07-22 に**恒久的に無効化**した。処理は一切行わず 410 を返す。
 *
 * ## 廃止理由（二重送信の footgun）
 *
 * 旧実装は「自前で SendGrid を叩いて確認メールを送る → Airtable の `Status` を active にする」
 * 順で書き込みながら、**`PaymentEmailSent` を立てなかった**。そのため Airtable Automation
 * A2「入金確認メール自動送信」が ON の状態で誤操作すると、**同じ顧客へ確認メールが 2 通**届いた。
 *
 * 運用上は未使用だったが**公開 URL として到達可能**であり、feature flag による 403 では
 * legacy 期間中の誤操作を防げない。よって**恒久 410** とする
 * （`astro-site/docs/PAYMENT_EMAIL_V2.md` §legacy 管理経路の無効化）。
 *
 * ## 現行の正しい経路（2026-07-21〜 / gate=v2-full）
 *
 * 1. Airtable Customers の `PaymentConfirmed` にチェックを入れる（**MK の操作はこれだけ**）
 * 2. Automation A1 → `confirm-bank-payment`（v2 分岐）が昇格 PATCH と同一 PATCH で
 *    `PaymentEmailStatus='pending'` を書く（**送信はしない**）
 * 3. `payment-email-dispatcher`（Scheduled 5 分毎）→ `payment-email-worker` が **1 通だけ**送信し、
 *    `accepted` で終端する（送信元は `senderIdentity.js` = support@keiba.link）
 *
 * ## 復活させたい場合（禁止事項）
 *
 * **この Function を元に戻してはいけない。** 手動昇格が必要なら
 * `netlify/functions/admin-promote-customer.js`（状態機械に沿って `pending` を作る）を使う。
 * 自前送信 + `Status` 直書きの経路を復活させると、A2 との二重送信と
 * 「メール 0 通なのに送信済み扱い」を再導入することになる。
 *
 * 配線は `src/lib/payments/legacyPaymentRoutes.guard.test.mjs` が固定している。
 */

const GONE_BODY = {
  error: 'Gone',
  reason: 'legacy_route_removed',
  message:
    'この経路は廃止されました。入金確認は Airtable Customers の PaymentConfirmed にチェックを入れてください（以降は自動）。',
};

exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(GONE_BODY),
});

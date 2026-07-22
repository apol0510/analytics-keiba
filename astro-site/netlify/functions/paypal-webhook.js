/**
 * paypal-webhook.js — **廃止済み（410 Gone）**
 *
 * ⚠️ この Function は 2026-07-22 に**恒久的に無効化**した。処理は一切行わず 410 を返す。
 *
 * ## 廃止理由
 *
 * - **PayPal 経路は運用していない**。現行 pricing の導線は**銀行振込のみ**
 *   （`docs/PAYMENT_SYSTEM.md` / `CLAUDE.md` §銀行振込 入金確認フロー）。
 * - 旧実装は「Airtable 登録 + SendGrid ウェルカムメール送信 + `Status='active'`」を自前で行い、
 *   **`PaymentEmailSent` を立てなかった**。Automation A2 が ON の状態で発火すると
 *   **確認メールが 2 通**届く（`send-payment-confirmation.js` と同型の footgun）。
 * - **署名検証を持たない公開 URL** であり、到達可能なまま放置すると
 *   第三者の POST で本番 Customers へ書き込まれうる。
 *
 * ## 復活させる場合の必須条件（満たさずに有効化しない）
 *
 * 1. **PayPal Webhook 署名検証**（`transmission_id` / `transmission_sig` / `cert_url` 検証）を実装する
 * 2. 昇格は `bankPaymentFlow.js` / `promotionV2.js` の単一源に寄せ、
 *    `プラン` / `有効期限` / `Status` を Function 内で直書きしない
 * 3. メール送信は**自前で SendGrid を叩かず**、状態機械（`PaymentEmailStatus='pending'`）に載せて
 *    `payment-email-dispatcher` → `payment-email-worker` の**単一送信経路**へ委譲する
 *
 * 配線は `src/lib/payments/legacyPaymentRoutes.guard.test.mjs` が固定している。
 */

const GONE_BODY = {
  error: 'Gone',
  reason: 'legacy_route_removed',
  message: 'この経路は廃止されました（PayPal 決済は運用していません）。',
};

exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(GONE_BODY),
});

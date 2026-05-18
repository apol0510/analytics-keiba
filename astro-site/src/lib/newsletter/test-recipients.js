// テスト宛先 (NEWSLETTER_TEST_RECIPIENTS) の env パーサ (純粋関数、副作用ゼロ)
//
// 目的: newsletter-send-test.js でのみ使用する、env-only な宛先ホワイトリストを構築する。
//       Customers / Airtable READ は一切経由しない（コード上構造的に到達不可）。
//
// env 形式: comma-separated, e.g. "a@example.com, b@example.com,c@example.com"
//   - trim
//   - lowercase
//   - 重複排除
//   - 最低限の email 形式 validate (RFC 5321 ベースの簡易版)

const EMAIL_REGEX = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * env の生文字列をパースして normalized 宛先配列 + メタデータを返す
 * @param {string|undefined|null} envRaw - process.env.NEWSLETTER_TEST_RECIPIENTS
 * @returns {{
 *   recipients: string[],           // normalized (trim+lowercase+dedupe+validate)
 *   skipped: number,                // 無効でスキップした件数
 *   domainBreakdown: Record<string, number>,  // ドメイン別件数
 * }}
 */
export function parseTestRecipientsEnv(envRaw) {
  if (typeof envRaw !== 'string' || envRaw.trim() === '') {
    return { recipients: [], skipped: 0, domainBreakdown: {} };
  }
  const seen = new Set();
  const recipients = [];
  let skipped = 0;
  const domainBreakdown = {};
  for (const raw of envRaw.split(',')) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_REGEX.test(e)) {
      skipped += 1;
      continue;
    }
    if (seen.has(e)) continue;
    seen.add(e);
    recipients.push(e);
    const domain = e.split('@')[1];
    domainBreakdown[domain] = (domainBreakdown[domain] || 0) + 1;
  }
  return { recipients, skipped, domainBreakdown };
}

/**
 * email の trace ID (sha256 先頭 12 文字) を返す。
 * PII 漏洩防止のため、log / レスポンスで email 全文の代わりに使う。
 * 注意: 純粋関数だが node:crypto に依存するため、呼び出し側で同期 import すること。
 * @param {string} email
 * @param {object} crypto - node:crypto モジュール（依存注入）
 * @returns {string}
 */
export function emailTraceId(email, crypto) {
  if (typeof email !== 'string' || !email) return 'none';
  const norm = email.trim().toLowerCase();
  if (!norm) return 'none';
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

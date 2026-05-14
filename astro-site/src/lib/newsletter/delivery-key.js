import { createHash } from 'node:crypto';

// 受信者単位の二重配信防止用 idempotency key。
// 構成要素のどれかが変われば別配信、すべて一致なら同一配信とみなして performUpsert で重複排除する。
//
// 同一アドレスでも brand 違いは別配信として扱う（keiba-intelligence と analytics-keiba は別契約）。
// fromEmail も key に含めることで、誤った送信元での再送を別レコード扱いにする。
// （誤組合せ自体は validateBrandFromEmail で事前に弾く前提）

export function normalizeRecipientEmail(email) {
  if (typeof email !== 'string') {
    throw new Error('recipientEmail must be a string');
  }
  return email.trim().toLowerCase();
}

export function computeDeliveryKey({
  brand,
  serviceType,
  campaignType,
  campaignDate,
  audienceType,
  recipientEmail,
  contentHash,
  fromEmail,
  extraKey = '',
}) {
  const required = { brand, serviceType, campaignType, campaignDate, audienceType, recipientEmail, contentHash, fromEmail };
  for (const [k, v] of Object.entries(required)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`computeDeliveryKey: missing or invalid field "${k}"`);
    }
  }

  const parts = [
    brand,
    serviceType,
    campaignType,
    campaignDate,
    audienceType,
    normalizeRecipientEmail(recipientEmail),
    contentHash,
    fromEmail.trim().toLowerCase(),
    extraKey,
  ];

  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

// deliveryKey の構成方針を人間可読な文字列で返す（admin プレビュー用）
export function describeDeliveryKeyTemplate() {
  return 'sha256(brand|serviceType|campaignType|campaignDate|audienceType|recipientEmail(lowercase)|contentHash|fromEmail(lowercase)|extraKey)';
}

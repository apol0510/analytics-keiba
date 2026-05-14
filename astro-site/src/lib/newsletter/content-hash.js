import { createHash } from 'node:crypto';

// 件名 + 本文 から content の同一性を表す sha256 hash を生成する。
// 同じ subject + bodyHtml なら必ず同じ hash になることを保証する。
// deliveryKey の構成要素として使う。文面修正後の再送は contentHash が変わるため
// 自然と別配信として扱われる。

export function computeContentHash(subject, bodyHtml) {
  if (typeof subject !== 'string') {
    throw new Error('subject must be a string');
  }
  if (typeof bodyHtml !== 'string') {
    throw new Error('bodyHtml must be a string');
  }

  const payload = `${subject}\n\n${bodyHtml}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

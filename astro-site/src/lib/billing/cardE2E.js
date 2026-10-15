/**
 * cardE2E.js — Deploy Preview の Sandbox E2E 用に、ログインの代わりに recordId を受け取る経路（決済会社共通）
 *
 * Deploy Preview はマジックリンクでログインできない（リンクが本番 URL 固定）。そのため次の 3 条件が**すべて**揃うときだけ
 * リクエスト本文の e2eRecordId を受け取る:
 *   1. その決済会社がテストモード（Sandbox 鍵・本番サイト以外）で解決している（呼び出し側が testMode を渡す）
 *   2. ヘッダ x-ak-e2e-secret が env の CARD_E2E_SECRET（24 文字以上）と一致
 *   3. 対象レコードのメールが `+card-e2e` を含む使い捨てアドレス
 * 本番サイト・本番鍵では 1 で必ず落ちる（実会員のレコードは指定できない）。
 */
import { timingSafeEqual } from 'node:crypto';
import { airtable } from './stripeServer.js';

export const E2E_EMAIL_RE = /\+card-e2e[^@]*@/i;

function same(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return y.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export async function e2eRecordIdFor(input) {
  return (await e2eCheck(input)).id;
}

/**
 * e2eRecordIdFor と同じ判定で、通らなかった段階も返す（テストモードで秘密ヘッダが付いた要求の切り分け用）。
 * reason は段階名だけ（秘密・レコード内容は返さない）。
 */
export async function e2eCheck({ event, env, body, testMode, fetchImpl }) {
  if (testMode !== true) return { id: null, reason: 'not_test_mode' };
  const secret = env.CARD_E2E_SECRET || '';
  const got = event?.headers?.['x-ak-e2e-secret'] || '';
  if (secret.length < 24) return { id: null, reason: 'secret_unset' };
  if (!same(got, secret)) return { id: null, reason: 'secret_mismatch' };
  const id = String(body?.e2eRecordId || '');
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return { id: null, reason: 'invalid_record_id' };
  try {
    const rec = await airtable(env, fetchImpl).get(id);
    return E2E_EMAIL_RE.test(String(rec?.fields?.Email || '')) ? { id, reason: 'ok' } : { id: null, reason: 'not_e2e_record' };
  } catch (e) { return { id: null, reason: `lookup_failed_${String(e?.message || '').slice(0, 40)}` }; }
}

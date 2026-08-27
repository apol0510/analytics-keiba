/**
 * campaignPreviewFingerprint.js — **確認した中身と送る中身が同じ**ことを保証する指紋（純粋・I/O なし）
 *
 * ## なぜ件数だけでは足りないか
 *
 * `expectedWillSend` の一致だけでは「**誰に**送るか」が変わったことを検出できない。
 * 100 → 100 のまま **中身が 1 人入れ替わっている**ケースを通してしまう
 * （配信停止した人が抜け、代わりに別の人が入る等）。
 *
 * そこで **送信候補の集合そのもの**（`DeliveryKey`）と**除外理由**まで含めて指紋にする。
 * 件数が同じでも中身が違えば指紋が変わり、promote が 409 で止まる。
 *
 * ## ⚠️ アドレスを材料にしない
 *
 * 指紋の材料は `DeliveryKey`（アドレス由来の hash から作られた不可逆な鍵）と理由文字列だけ。
 * 生アドレスは受け取らないし、応答にも出ない。
 */

import { createHash } from 'node:crypto';

const str = (v) => String(v ?? '').trim();

/** 指紋の版。**材料の作り方を変えたら上げる**（古い指紋を黙って通さない）*/
export const PREVIEW_FINGERPRINT_VERSION = 'v1';

/**
 * 送信候補と除外結果から指紋を作る。
 *
 * @param {{
 *   jobId: string,
 *   send: string[],                                   // 送る相手の DeliveryKey
 *   skip: Array<{deliveryKey?: string, reason: string}>, // 送らない相手の DeliveryKey と理由
 * }} input
 * @returns {{ok: boolean, reason?: string, fingerprint: string|null,
 *            wouldSend: number, wouldSkip: number, skipByReason: object}}
 */
export function buildPreviewFingerprint({ jobId, send, skip } = {}) {
  const job = str(jobId);
  if (!job) return fail('job_id_missing');
  const sendKeys = [...new Set((Array.isArray(send) ? send : []).map(str).filter(Boolean))];
  const skipList = (Array.isArray(skip) ? skip : []).map((s) => ({
    key: str(s && s.deliveryKey), reason: str(s && s.reason) || 'unknown',
  }));

  // ⚠️ 送る相手の鍵が 1 つでも欠けていたら指紋を作らない（誰に送るか確定できていない）
  if (sendKeys.length !== (Array.isArray(send) ? send.length : 0)) {
    return fail('send_keys_not_unique');
  }
  for (const s of Array.isArray(send) ? send : []) {
    if (!str(s)) return fail('send_key_missing');
  }

  const skipByReason = {};
  for (const s of skipList) skipByReason[s.reason] = (skipByReason[s.reason] || 0) + 1;

  /*
   * 並びに依存しない材料にする（同じ集合なら同じ指紋）。
   * 除外は「鍵が無い相手」もあり得るので、鍵が無ければ理由だけを数える形で混ぜる。
   */
  const lines = [
    `job:${job}`,
    `v:${PREVIEW_FINGERPRINT_VERSION}`,
    ...sendKeys.map((k) => `s:${k}`).sort(),
    ...skipList.filter((s) => s.key).map((s) => `k:${s.key}:${s.reason}`).sort(),
    ...Object.entries(skipByReason).map(([r, n]) => `r:${r}:${n}`).sort(),
  ];
  const h = createHash('sha256');
  for (const l of lines) { h.update(l, 'utf8'); h.update('\n', 'utf8'); }
  return {
    ok: true,
    fingerprint: `${PREVIEW_FINGERPRINT_VERSION}:${h.digest('hex').slice(0, 32)}`,
    wouldSend: sendKeys.length,
    wouldSkip: skipList.length,
    skipByReason,
  };
}

function fail(reason) {
  return {
    ok: false, reason, fingerprint: null, wouldSend: 0, wouldSkip: 0, skipByReason: {},
  };
}

/** promote を止める理由 */
export const PROMOTE_REJECT = Object.freeze({
  NOT_CONFIRMED: 'not_confirmed',
  MISSING_EXPECTED: 'missing_expected_will_send',
  MISSING_FINGERPRINT: 'missing_preview_fingerprint',
  PREVIEW_UNAVAILABLE: 'preview_unavailable',
  /** ⚠️ 確認したときと**人数**が違う */
  COUNT_CHANGED: 'will_send_count_changed',
  /** ⚠️ 人数は同じでも**送る相手が入れ替わっている** */
  FINGERPRINT_CHANGED: 'preview_fingerprint_changed',
});

/**
 * 「確認したとき」と「いま」が同じかを確かめる。
 *
 * ⚠️ **件数と指紋の両方**が一致したときだけ通す。片方だけでは通さない。
 */
export function verifyPromotePreview({
  confirmed, expectedWillSend, previewFingerprint, current,
} = {}) {
  const reasons = [];
  if (confirmed !== true) reasons.push(PROMOTE_REJECT.NOT_CONFIRMED);
  const want = Number(expectedWillSend);
  if (!Number.isInteger(want) || want < 0) reasons.push(PROMOTE_REJECT.MISSING_EXPECTED);
  const fp = str(previewFingerprint);
  if (!fp) reasons.push(PROMOTE_REJECT.MISSING_FINGERPRINT);
  if (!current || current.ok !== true || !str(current.fingerprint)) {
    reasons.push(PROMOTE_REJECT.PREVIEW_UNAVAILABLE);
    return { ok: false, reasons, current: null };
  }
  if (Number.isInteger(want) && want !== current.wouldSend) reasons.push(PROMOTE_REJECT.COUNT_CHANGED);
  if (fp && fp !== str(current.fingerprint)) reasons.push(PROMOTE_REJECT.FINGERPRINT_CHANGED);
  return {
    ok: reasons.length === 0,
    reasons,
    current: { wouldSend: current.wouldSend, wouldSkip: current.wouldSkip, fingerprint: current.fingerprint },
  };
}

/** promote を許す確認文字列 */
export const PROMOTE_CONFIRM = 'PROMOTE CAMPAIGN JOB';

/**
 * prospectSequenceAdapter.js — prospect プールの 1 件を、**連続配信がそのまま扱える形**へ
 * 直す（純粋・I/O なし）
 *
 * ## なぜ「変換」なのか（新しい配信ロジックを作らない）
 *
 * CSV 取り込み分を Customers から prospect プールへ戻すとき、いちばん危険なのは
 * **配信側にもう 1 本の判定を生やしてしまう**ことだ。判定が 2 本になると、
 * 8/31・9/6 の続き（step2 / step3）で「Customers 経路では送る人／prospect 経路では
 * 送らない人」が生まれ、送信漏れか二重送信のどちらかが必ず起きる。
 *
 * そこでこのモジュールは **判定を一切持たない**。prospect を
 * **取り込みが Customers へ書いたのと同じ形の `fields`** に組み直し、
 * 既存の `resolveCustomerMarketing()` → `buildSequenceProgress()` を
 * **そのまま**通す。つまり:
 *
 *   - `DeliveryKey` は `computeCampaignDeliveryKey`（受信者アドレス由来）で**同一**
 *   - 次に送る step は `sequenceProgress.js` の同じ導出で**同一**
 *   - 停止理由（購入 / 配信停止 / コホート外 / 反応なし）も**同じ関数**が出す
 *
 * だから parity は「合わせ込み」ではなく**構造的に**成立する。
 * ズレたら、それはこの変換が `fields` を間違えて作った証拠になる。
 *
 * ## 作る `fields` は取り込み時の CREATE と同じ
 *
 * `crm/importWritePlan.js` の `buildCreateFields()` が書いたのは
 * `Email` / `プラン='Free'` / `ポイント=0` / `Source='customer-import:<batchId>'`
 * （+ 列があれば `氏名` / `CreatedBy` / `ImportBatchId` / `ImportedAt`）だけ。
 * **prospect には有料契約も無料付与もログイン実績も無い**ので、
 * 復元に必要なのはこの 4 つで足りる。
 *
 * ⚠️ **ここで会員権限を作らない。** `プラン` は常に取り込みと同じ `'Free'`。
 *    prospect が有料に見える `fields` を作ると、購入済み判定・配信対象・
 *    表示のすべてが狂う。
 * ⚠️ **recordId は Airtable の ID ではない。** `prospect:<hash>` を返す。
 *    Airtable の行を指していないことが見て分かる形にしてある
 *    （`sequenceProgress` は recordId を識別子としてしか使わない）。
 */

import { IMPORT_SOURCE_PREFIX } from '../crm/importWritePlan.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { PROSPECT_STATE, normalizeEmail } from './prospectPolicy.js';

/** prospect 由来の recordId 接頭辞（Airtable の rec… と取り違えない） */
export const PROSPECT_RECORD_PREFIX = 'prospect:';

/** その prospect は配信の土俵に乗るか（**判定はしない・状態を見るだけ**） */
export function isSendableState(state) {
  return state === PROSPECT_STATE.NEW || state === PROSPECT_STATE.SENDING;
}

export function prospectRecordId(prospect) {
  const h = String((prospect && prospect.hash) || '').trim();
  return h ? `${PROSPECT_RECORD_PREFIX}${h}` : '';
}

export function isProspectRecordId(recordId) {
  return String(recordId ?? '').startsWith(PROSPECT_RECORD_PREFIX);
}

/**
 * prospect → **取り込みが書いたのと同じ Airtable fields**。
 *
 * `batchId` は prospect が持っている値を優先する（取り込み時の batch を保つ）。
 * 持っていなければ引数の既定を使う。**どちらも無ければ null を返す**（推測しない）。
 */
export function prospectToImportFields(prospect, { defaultBatchId } = {}) {
  const p = prospect || {};
  const email = normalizeEmail(p.email);
  if (!email) return null;
  const batchId = String(p.batchId || defaultBatchId || '').trim();
  if (!batchId) return null;   // Source を作れない = コホート判定ができない → 作らない
  const fields = {
    Email: email,
    'プラン': 'Free',
    'ポイント': 0,
    Source: `${IMPORT_SOURCE_PREFIX}:${batchId}`,
  };
  if (p.name) fields['氏名'] = String(p.name);
  return fields;
}

/**
 * prospect → `buildSequenceProgress()` が受け取る `selected` の 1 要素。
 *
 * @param {{prospect: object, nowMs: number, blacklistEmails?: Set<string>,
 *          defaultBatchId?: string, history?: object}} input
 * @returns {{recordId, fields, marketing}|null} 変換できなければ null（**推測で作らない**）
 */
export function prospectToCustomerRow({
  prospect, nowMs, blacklistEmails, defaultBatchId, history,
} = {}) {
  const fields = prospectToImportFields(prospect, { defaultBatchId });
  if (!fields) return null;
  const recordId = prospectRecordId(prospect);
  if (!recordId) return null;
  return {
    recordId,
    fields,
    // ⚠️ **Customers 経路と同じ関数**。ここで独自の marketing オブジェクトを組み立てない。
    marketing: resolveCustomerMarketing({ fields, nowMs, blacklistEmails, history }),
    /** 出所（配信台帳の書き分けに使う。`deliveryKeySource.js` 参照） */
    出所: 'prospect',
  };
}

/**
 * prospect の一覧 → `selected` 相当の配列。
 *
 * **変換できなかったものは黙って落とさず理由別に数える**（取りこぼしの検知）。
 * 送信できない状態（EXHAUSTED / SUPPRESSED / PROMOTED / ENGAGED）は
 * ここで落とさず `skipped` に積む。**配信可否の判定は `sequenceProgress` に任せる**
 * ……のではなく、状態機械の側でしか分からない打ち切りだけをここで落とす。
 *
 * @returns {{rows: object[], skipped: object, counts: object}}
 */
export function buildProspectSequenceRows({
  prospects, nowMs, blacklistEmails, defaultBatchId,
} = {}) {
  const rows = []; const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  for (const p of Array.isArray(prospects) ? prospects : []) {
    const state = String((p && p.state) || PROSPECT_STATE.NEW);
    if (!isSendableState(state)) { bump(`state:${state}`); continue; }
    const row = prospectToCustomerRow({ prospect: p, nowMs, blacklistEmails, defaultBatchId });
    if (!row) { bump('unconvertible'); continue; }
    rows.push(row);
  }
  return {
    rows, skipped,
    counts: {
      母数: Array.isArray(prospects) ? prospects.length : 0,
      変換: rows.length,
      除外: (Array.isArray(prospects) ? prospects.length : 0) - rows.length,
    },
  };
}

export default prospectToCustomerRow;

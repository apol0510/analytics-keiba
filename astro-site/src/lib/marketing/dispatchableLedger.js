/**
 * dispatchableLedger.js — 「配信行の置き場所」と「実際に送れるか」を突き合わせる（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-14 の本番実測から）
 *
 * 2026-08-27 の MK 確定で、CSV 取り込み由来（`prospect`）の受信者は
 * **Airtable の `CampaignDeliveries` に 1 行も書かない**ことにした（レコード上限対策）。
 * 冪等性は Redis の集合が持つ。ここまでは意図どおり。
 *
 * ところが**送信側はその前提になっていない**。`marketing-campaign-dispatch` は
 * 1 通ごとに `custom_args` を刻むが、その値は
 * `campaignCustomArgs.js#buildCampaignCustomArgs` が
 * **Airtable の配信行からしか読まない**（`campaign_delivery_id` は Airtable の recordId）。
 * 行が無ければ `ok:false`（`delivery_not_found`）で、その相手は**必ず skip される**。
 *
 * つまり「Airtable に行を書かない受信者」は、
 * **キューには積まれるが、1 通も送られない**。しかも積んだ時点で Redis の予約
 * （`claimDelivered` の `SADD`）が入るため、**既送信として扱われ二度と対象に戻らない**。
 *
 * 本番実測（2026-09-14 / `campaign-discount-free` step2）:
 *   - prospect 11,686 名が「予約済み・キュー済み・未送信」のまま滞留
 *   - 実際に送られた step2 は **0 通**
 *
 * ## ここが守ること
 *
 * **送れない置き場所の受信者は、そもそも積まない（＝予約も取らない）。**
 * 送れないまま予約だけ焼くと、あとから経路を直しても**その人には二度と届かない**。
 * 送信経路が対応したら `AIRTABLE_ROW_REQUIRED` を false にするだけで解禁できる。
 *
 * ⚠️ ここは**判定を写すだけ**で、除外や冪等性の既存判定を緩めない。
 */

/** 積めない理由（固定コード。アドレスは混ぜない） */
export const LEDGER_DISPATCH_BLOCK = Object.freeze({
  /** Airtable に配信行が無いと `custom_args` を作れず、dispatcher が必ず skip する */
  NO_AIRTABLE_ROW: 'delivery_row_not_in_airtable',
});

/**
 * いまの送信経路が `campaign_delivery_id`（= Airtable の配信行 recordId）を
 * **必須にしている**か。
 *
 * ⚠️ `campaignCustomArgs.js` が Airtable の行だけを権威データにしている限り true。
 *    Redis だけの配信識別で送れるようにするのは**送信・計測契約の変更**なので、
 *    ここを false にするときは `campaignCustomArgs.js` と
 *    `webhooks/emailEventLedger.js` を同時に直すこと（片方だけ変えない）。
 */
export const AIRTABLE_ROW_REQUIRED = true;

/**
 * この受信者はいまの送信経路で**実際に送れる**か。
 *
 * @param {{writeAirtable: boolean}} policy `deliveryKeySource.js#resolveRecipientLedgerPolicy` の結果
 * @returns {{ok: boolean, reason: string|null}}
 */
export function canDispatchWithLedger(policy) {
  // ⚠️ **真偽値の true だけ**を「書く」と読む。文字列 `'true'` や 1 を通すと、
  //    形の違う値が紛れ込んだときに送れない相手を送れると誤判定する（fail closed）。
  const writesAirtable = Boolean(policy) && policy.writeAirtable === true;
  if (AIRTABLE_ROW_REQUIRED && !writesAirtable) {
    return { ok: false, reason: LEDGER_DISPATCH_BLOCK.NO_AIRTABLE_ROW };
  }
  return { ok: true, reason: null };
}

/**
 * 受信者を「積んでよい人」と「送れないので積まない人」に分ける。
 *
 * @param {{items: any[], policyOf: (item: any) => {writeAirtable: boolean}}} input
 * @returns {{sendable: any[], blocked: any[], blockedByReason: Record<string, number>}}
 */
export function partitionByDispatchable({ items, policyOf } = {}) {
  const sendable = [];
  const blocked = [];
  const blockedByReason = {};
  for (const item of Array.isArray(items) ? items : []) {
    const verdict = canDispatchWithLedger(typeof policyOf === 'function' ? policyOf(item) : null);
    if (verdict.ok) { sendable.push(item); continue; }
    blocked.push(item);
    blockedByReason[verdict.reason] = (blockedByReason[verdict.reason] || 0) + 1;
  }
  return { sendable, blocked, blockedByReason };
}

export default canDispatchWithLedger;

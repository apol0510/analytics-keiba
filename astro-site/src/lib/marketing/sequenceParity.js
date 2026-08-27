/**
 * sequenceParity.js — Customers 経路と prospect 経路が**同じ答えを出すか**を突き合わせる
 * （純粋・I/O なし）
 *
 * ## これが守るもの
 *
 * CSV 取り込み分を Customers から prospect プールへ移す前に、
 * **「移した後も 8/31・9/6 の配信がまったく同じ相手へ同じ step を送る」**ことを
 * 証明する。証明できないまま移すと、次の配信で送信漏れか二重送信になる。
 *
 * 比較するのは 4 点。**どれか 1 つでも差があれば移行しない**（fail closed）:
 *
 * | # | 比べるもの | 差があると何が起きるか |
 * |---|---|---|
 * | 1 | いま送れる相手（due）の集合 | 送信漏れ / 想定外の相手へ送信 |
 * | 2 | 相手ごとの次の step | 別の文面が届く・順番が飛ぶ |
 * | 3 | 相手ごとの `DeliveryKey` | **二重送信**（鍵が変わると既送信を見落とす）|
 * | 4 | 止めた相手の停止理由 | 止めるべき人へ送る / 送るべき人を止める |
 * | 5 | 相手ごとの **delivered 回数** | 打ち切り（delivered 10）の判定がズレる |
 *
 * ⚠️ **アドレスの集合そのものを返さない。** 差分は件数と、確認用に**先頭数件の
 *    ハッシュ化していないアドレス**……ではなく **DeliveryKey の断片**だけを返す。
 *    突合ログに宛先一覧を残さない。
 *
 * ⚠️ この比較は **同じ nowMs・同じ campaign・同じ blacklist** で両方を作ったときにだけ
 *    意味がある。入力条件が違えば差が出るのは当然で、それは parity の失敗ではない。
 *    呼び出し側は同じ入力から 2 つの progress を作ること。
 */

import { SEQ_STATUS } from './sequenceProgress.js';

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** 突合できない理由（**差分 0 と区別する**） */
export const PARITY_UNUSABLE = Object.freeze({
  MISSING_SIDE: 'missing_side',
  NOT_A_SEQUENCE: 'not_a_sequence',
  DIFFERENT_CAMPAIGN: 'different_campaign',
  DIFFERENT_VERSION: 'different_version',
});

/** 進行結果 → email をキーにした比較用の索引 */
export function indexProgressByEmail(progress) {
  const out = new Map();
  if (!progress || progress.ok !== true) return out;
  for (const r of progress.rows || []) {
    const email = lower(r.email);
    if (!email) continue;
    out.set(email, {
      status: r.status,
      nextStep: Number.isInteger(r.nextStep) ? r.nextStep : null,
      stopReason: r.stopReason || null,
      sentSteps: [...(r.sentSteps || [])].sort((a, b) => a - b).join(','),
    });
  }
  return out;
}

const setDiff = (a, b) => [...a].filter((x) => !b.has(x));

/**
 * 2 つの進行結果を突き合わせる。
 *
 * @param {{customers: object, prospects: object,
 *          customerKeys?: Map<string,string>, prospectKeys?: Map<string,string>}} input
 *   `*Keys` は email → DeliveryKey。渡されたときだけ鍵の一致も見る（**渡すのが望ましい**）。
 * @returns {{ok:boolean, unusable:string|null, diff:object, counts:object}}
 */
export function compareSequenceParity({
  customers, prospects, customerKeys, prospectKeys,
  /**
   * email → delivered 回数。渡されたときだけ突き合わせる（**渡すのが望ましい**）。
   * ここがズレると打ち切り（delivered 10 / 開封 0）の判定が両経路で食い違う。
   */
  customerDelivered, prospectDelivered,
} = {}) {
  const unusable = (reason) => ({
    ok: false, unusable: reason, diff: null,
    counts: { customers: 0, prospects: 0 },
  });
  if (!customers || !prospects) return unusable(PARITY_UNUSABLE.MISSING_SIDE);
  if (customers.ok !== true || prospects.ok !== true) return unusable(PARITY_UNUSABLE.NOT_A_SEQUENCE);
  if (customers.campaignId !== prospects.campaignId) return unusable(PARITY_UNUSABLE.DIFFERENT_CAMPAIGN);
  if (Number(customers.version) !== Number(prospects.version)) return unusable(PARITY_UNUSABLE.DIFFERENT_VERSION);

  const a = indexProgressByEmail(customers);
  const b = indexProgressByEmail(prospects);
  const ea = new Set(a.keys()); const eb = new Set(b.keys());

  const onlyCustomers = setDiff(ea, eb);
  const onlyProspects = setDiff(eb, ea);

  const stepMismatch = []; const statusMismatch = [];
  const stopReasonMismatch = []; const keyMismatch = []; const deliveredMismatch = [];
  const checkedDelivered = customerDelivered instanceof Map && prospectDelivered instanceof Map;
  const dueA = new Set(); const dueB = new Set();

  for (const [email, ra] of a) {
    if (ra.status === SEQ_STATUS.DUE) dueA.add(email);
    const rb = b.get(email);
    if (!rb) continue;
    if (rb.status === SEQ_STATUS.DUE) dueB.add(email);
    if (ra.nextStep !== rb.nextStep) stepMismatch.push(email);
    if (ra.status !== rb.status) statusMismatch.push(email);
    if ((ra.stopReason || null) !== (rb.stopReason || null)) stopReasonMismatch.push(email);
    if (customerKeys instanceof Map && prospectKeys instanceof Map) {
      const ka = customerKeys.get(email) || null;
      const kb = prospectKeys.get(email) || null;
      if (ka !== kb) keyMismatch.push(email);
    }
    if (checkedDelivered) {
      const da = Number(customerDelivered.get(email) || 0);
      const db = Number(prospectDelivered.get(email) || 0);
      if (da !== db) deliveredMismatch.push(email);
    }
  }
  for (const [email, rb] of b) if (rb.status === SEQ_STATUS.DUE) dueB.add(email);

  const dueOnlyCustomers = setDiff(dueA, dueB);
  const dueOnlyProspects = setDiff(dueB, dueA);

  const diff = {
    '対象のみ片側': { customers: onlyCustomers.length, prospects: onlyProspects.length },
    'due のみ片側': { customers: dueOnlyCustomers.length, prospects: dueOnlyProspects.length },
    '次step不一致': stepMismatch.length,
    '状態不一致': statusMismatch.length,
    '停止理由不一致': stopReasonMismatch.length,
    // Map を渡さなかったときは「見ていない」ことが分かるよう null にする
    'DeliveryKey不一致': (customerKeys instanceof Map && prospectKeys instanceof Map) ? keyMismatch.length : null,
    // Map を渡さなかったときは「見ていない」ことが分かるよう null にする
    'delivered不一致': checkedDelivered ? deliveredMismatch.length : null,
  };

  const checkedKeys = customerKeys instanceof Map && prospectKeys instanceof Map;
  const ok = onlyCustomers.length === 0 && onlyProspects.length === 0
    && dueOnlyCustomers.length === 0 && dueOnlyProspects.length === 0
    && stepMismatch.length === 0 && statusMismatch.length === 0
    && stopReasonMismatch.length === 0
    // ⚠️ 鍵を突き合わせていない parity は**合格にしない**（二重送信の芽を見逃す）
    && checkedKeys && keyMismatch.length === 0
    // ⚠️ delivered を突き合わせていない parity も合格にしない（打ち切り判定がズレる）
    && checkedDelivered && deliveredMismatch.length === 0;

  return {
    ok,
    unusable: null,
    /** 鍵まで見たか。false のまま ok が true になることは無い */
    keysChecked: checkedKeys,
    /** delivered まで見たか。false のまま ok が true になることは無い */
    deliveredChecked: checkedDelivered,
    diff,
    counts: {
      customers: a.size, prospects: b.size,
      due: { customers: dueA.size, prospects: dueB.size },
    },
  };
}

/**
 * 移行してよいか。**parity が完全一致のときだけ true**。
 * 「突合できなかった」を合格にしない（`unusable` は必ず false になる）。
 */
export function assertParityBeforeMigration(result) {
  const r = result || {};
  return {
    migrateAllowed: r.ok === true && r.unusable === null
      && r.keysChecked === true && r.deliveredChecked === true,
    reason: r.unusable || (r.ok === true ? null : 'parity_mismatch'),
    diff: r.diff || null,
  };
}

export default compareSequenceParity;

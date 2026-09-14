/**
 * drmEntryAllowlist.js — **最終 recipient 集合の上限制約**（純粋・I/O なし）
 *
 * ── なぜ要るか（2026-09-14 の事故）──────────────────────────────
 * `runDrmEntry` は下見（`planAutoStartEntries`）の人数を `expectedCount` と突き合わせて
 * から `runSequenceTick` へ委譲していた。ところが **`expectedCount` は入口 planner の
 * 人数しか縛っていない**。委譲先は
 *   台帳由来 ＋ 入口 ＋ **prospect**
 * で母集団を組み直し、`MARKETING_SEQUENCE_MAX_PER_TICK`（50）まで送る。
 *
 * 実測（承認は無料登録 16 名）:
 *   ScheduledEmails Recipients **50** / SentCount **46** / FailedCount 0
 *   CampaignDeliveries は **13 行**（prospect は Airtable に行を書かないため）
 *
 * ── この制約の性質 ────────────────────────────────────────────
 * ⚠️ **減らす方向にしか働かない。** 許可リストは「これ以外へ送らない」であって、
 *    「これ全員へ送る」ではない。安全判定で人数が減るのは**許容**、増えるのは**禁止**。
 * ⚠️ **候補データを注入しない。** 渡すのは **recordId の集合だけ**。
 *    `runSequenceTick` は従来どおり候補を取り直し、purchase / suppression / blacklist /
 *    既送信 / `DeliveryKey` を**自分で再検証する**（短絡させない）。
 * ⚠️ **省略時は何もしない。** 共有 tick（割引 3 本など）の挙動は 1 ミリも変えない。
 */

export const ALLOWLIST_FAIL = Object.freeze({
  /** 許可リストの外が最終集合に混ざっていた（**送らずに止める**） */
  OUTSIDE_ALLOWLIST: 'recipient_outside_allowlist',
});

const str = (v) => String(v ?? '').trim();

/**
 * 許可リストを正規化する。**空配列と未指定を区別する**。
 *
 * - `null` / `undefined` … 制約なし（既存挙動のまま）
 * - `[]`                 … **誰も許可しない**（0 件。事故時に「全部許可」へ倒れない）
 */
export function normalizeAllowlist(raw) {
  if (raw === null || raw === undefined) return null;
  const list = (Array.isArray(raw) ? raw : []).map(str).filter(Boolean);
  return new Set(list);
}

/**
 * **最終 recipient 集合**へ上限制約を掛ける。
 *
 * @param {{targets: Array<{recordId?:string}>, allowlist: Set<string>|null}} input
 * @returns {{kept: object[], dropped: number, constrained: boolean}}
 */
export function applyEntryAllowlist({ targets, allowlist }) {
  const list = Array.isArray(targets) ? targets : [];
  if (!(allowlist instanceof Set)) return { kept: list, dropped: 0, constrained: false };
  const kept = list.filter((t) => allowlist.has(str(t && t.recordId)));
  return { kept, dropped: list.length - kept.length, constrained: true };
}

/**
 * **積む直前の最後の確認**（多層防御）。
 *
 * 許可リストがあるのに外の相手が 1 人でも混ざっていたら
 * **1 件も積まない**ための判定。`applyEntryAllowlist` を通した後でも、
 * 途中の処理が対象を足していないことをここで断つ。
 *
 * ⚠️ `recordId` を持たない相手（prospect 等）は**許可リストの外**として扱う。
 *    「id が無いから素通し」にすると、事故と同じ経路がそのまま残る。
 *
 * @returns {{ok: boolean, reason: string|null, outside: number}}
 */
export function assertWithinAllowlist({ targets, allowlist }) {
  if (!(allowlist instanceof Set)) return { ok: true, reason: null, outside: 0 };
  const list = Array.isArray(targets) ? targets : [];
  const outside = list.filter((t) => !allowlist.has(str(t && t.recordId))).length;
  return {
    ok: outside === 0,
    reason: outside === 0 ? null : ALLOWLIST_FAIL.OUTSIDE_ALLOWLIST,
    outside,
  };
}

export default applyEntryAllowlist;

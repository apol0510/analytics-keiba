/**
 * importEligibility.js — 「どの行を新規作成してよいか」の判定（純粋・I/O なし）
 *
 * ── なぜ独立させるか ──────────────────────────────────────────
 * 単発 run（`admin-customer-import-run.js`）は同じ判定を関数内に持っており、
 * 本番で 3 バッチ 210 件を成功させた**実績のある経路**なのでそのまま触らない。
 * ジョブ経路は同じ順序・同じ除外集合をこのモジュールで再現し、
 * `importJobEligibility.guard.test.mjs` で**両者の除外集合が一致すること**を固定する。
 *
 * ── 決定的な並び（cursor が意味を持つ前提）────────────────────
 * 子バッチの再開位置 `cursor` は「決定的に並べた一覧の何番目まで見たか」。
 * 並びが実行のたびに変わると再開位置が意味を失うため、**アドレスの昇順に固定**する。
 * （`mergeImportFiles` の Map 挿入順も同じ入力なら同じだが、明示的に並べ替えて保証する。）
 */

/** 除外理由の固定コード（画面・監査に出すのは件数とこのコードだけ） */
export const SKIP_REASON = Object.freeze({
  FLAGGED: 'flagged',                 // 要確認（氏名食い違い・状態不明など）
  NO_EMAIL: 'no_email',
  UNSUBSCRIBED: 'unsubscribed',
  HARD_BOUNCE: 'hard_bounce',
  SOFT_BOUNCE: 'soft_bounce',
  SUSPENDED: 'suspended',
  TEST_ACCOUNT: 'test_account',
  PAID: 'paid',                       // 現役有料会員は取り込まない
  DUPLICATE_IN_AK: 'duplicate_in_ak', // AK 側重複は自動統合しない
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  EXISTING: 'existing',               // すでに AK にいる → **更新しない**
});

/** 判定に使う集合。`Set` でないものは空集合として扱う（fail closed 側へ倒す） */
const asSet = (v) => (v instanceof Set ? v : new Set());

/**
 * 決定的な並びの対象一覧を作る。**アドレス昇順に固定**する。
 * @param {Array<{email: string, name?: string, flags?: string[]}>} entries
 */
export function orderEntriesDeterministically(entries) {
  return [...(entries || [])].sort((a, b) => {
    const x = String(a?.email || ''); const y = String(b?.email || '');
    return x < y ? -1 : (x > y ? 1 : 0);
  });
}

/**
 * 1 行が新規作成の対象か。**単発 run と同じ順序で判定する**。
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function classifyCreateRow({ entry, facts, providerEmails } = {}) {
  const e = entry || {};
  if (Array.isArray(e.flags) && e.flags.length > 0) return { ok: false, reason: SKIP_REASON.FLAGGED };
  const email = String(e.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: SKIP_REASON.NO_EMAIL };

  const f = facts || {};
  if (asSet(f.unsubscribed).has(email)) return { ok: false, reason: SKIP_REASON.UNSUBSCRIBED };
  if (asSet(f.hardBounce).has(email)) return { ok: false, reason: SKIP_REASON.HARD_BOUNCE };
  if (asSet(f.softBounce).has(email)) return { ok: false, reason: SKIP_REASON.SOFT_BOUNCE };
  if (asSet(f.suspended).has(email)) return { ok: false, reason: SKIP_REASON.SUSPENDED };
  if (asSet(f.testAccounts).has(email)) return { ok: false, reason: SKIP_REASON.TEST_ACCOUNT };
  if (asSet(f.paid).has(email)) return { ok: false, reason: SKIP_REASON.PAID };
  if (asSet(f.duplicateInAk).has(email)) return { ok: false, reason: SKIP_REASON.DUPLICATE_IN_AK };
  if (asSet(providerEmails).has(email)) return { ok: false, reason: SKIP_REASON.PROVIDER_SUPPRESSED };
  // **既存は更新しない**。ここで落とすので UPDATE 経路が構造的に存在しない。
  if (asSet(f.existing).has(email)) return { ok: false, reason: SKIP_REASON.EXISTING };

  return { ok: true, reason: null };
}

/**
 * `cursor` の位置から、作成してよい行を最大 `limit` 件まで拾う。
 *
 * ⚠️ **すでに作成済みの行は `facts.existing` に入っている**ので自然に飛ばされる。
 *    つまり cursor が巻き戻っても二重作成にはならず、`skippedExisting` が増えるだけ。
 *
 * @param {{
 *   entries: Array<object>,   決定的に並べ替え済みの一覧
 *   facts: object,
 *   providerEmails: Set<string>,
 *   cursor?: number,
 *   limit: number,
 * }} input
 * @returns {{ rows, scannedTo, exhausted, skipped }}
 */
export function selectCreateRows({ entries, facts, providerEmails, cursor, limit } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const start = Math.max(0, Number.isFinite(cursor) ? Math.trunc(cursor) : 0);
  const max = Math.max(0, Number.isFinite(limit) ? Math.trunc(limit) : 0);

  const rows = [];
  const skipped = {};
  let i = start;
  for (; i < list.length && rows.length < max; i += 1) {
    const entry = list[i];
    const verdict = classifyCreateRow({ entry, facts, providerEmails });
    if (verdict.ok) {
      rows.push({ email: String(entry.email).trim().toLowerCase(), name: entry.name || '' });
    } else {
      skipped[verdict.reason] = (skipped[verdict.reason] || 0) + 1;
    }
  }
  return {
    rows,
    /** ここまで見た（次回はここから再開する） */
    scannedTo: i,
    /** 一覧を最後まで見終わったか（＝残りに作成対象が無い） */
    exhausted: i >= list.length,
    skipped,
  };
}

/**
 * 対象総数（CREATE 候補）を数える。**開始時に固定する snapshot の母数**。
 */
export function countCreateCandidates({ entries, facts, providerEmails } = {}) {
  let n = 0;
  for (const entry of (entries || [])) {
    if (classifyCreateRow({ entry, facts, providerEmails }).ok) n += 1;
  }
  return n;
}

export default selectCreateRows;

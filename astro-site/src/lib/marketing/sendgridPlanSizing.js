/**
 * sendgridPlanSizing.js — SendGrid Marketing Campaigns の**契約プランを最小に保つ**
 * （純粋・I/O なし）
 *
 * ## 方針（2026-09-18 MK 確定）
 *
 * > **必要要件を満たす範囲で、常に最小プランを選ぶ。**
 * > 上位プランを先回りして契約しない。超過料金込みで上位プランより高くなる場合だけ、
 * > 比較したうえで上位を選ぶ。
 *
 * ⚠️ **費用のために配信安全性を落とさない。** 二重送信防止 / unsubscribe /
 *    bounce・suppression / 1 日 1 通 / 最大 10 通 / delivered 10 無反応で除外 /
 *    反応者は DRM へ / 既送 step の再送禁止は**どれも削らない**。
 *    「費用を抑える」は**必要以上の contact 枠・email 枠を契約しない**ことだけで実現する。
 *
 * ## ここが計算するもの / しないもの
 *
 * | する | しない |
 * |---|---|
 * | 必要 contact 数・残送信数・月間予定通数 | 料金の金額（**公表値を推測で書かない**）|
 * | 「その枠に収まるか」の判定 | 契約の実行（**課金変更は MK 承認の直前で停止**）|
 * | 1 段階下へ下げられるかの判定 | プラン名の憶測（下表以外を勝手に足さない）|
 *
 * ⚠️ **金額を持たない。** 料金表は変わるうえ、ここに書き写すと
 *    「コードに書いてある額」と「請求額」が食い違う（AK で過去に起きた事故と同型）。
 *    判断に要るのは**枠に収まるかどうか**で、金額の比較が要る場面では
 *    そのとき公表値を確認する（`requiresQuote` が true になる）。
 * ⚠️ `includedEmailsPerMonth` が `null` は「**未確認**」であって「無制限」ではない。
 *    未確認のまま「収まる」と言わない（`unverified` に載せて人へ返す）。
 */

/**
 * 候補プラン（**MK が第一候補として挙げたものだけ**）。
 *
 * ⚠️ ここに無いプランを推測で足さない。追加するときは
 *    **SendGrid の公表値を確認した日付**を添えること。
 */
export const PLAN_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'advanced-10k',
    label: 'Marketing Campaigns Advanced 10K',
    contactCap: 10000,
    /** MK 提示の想定値（2026-09-18）。契約前に公表値で再確認する */
    includedEmailsPerMonth: 50000,
    verifiedAt: null,
  }),
  Object.freeze({
    id: 'advanced-20k',
    label: 'Marketing Campaigns Advanced 20K',
    contactCap: 20000,
    /** **未確認**（推測で埋めない）*/
    includedEmailsPerMonth: null,
    verifiedAt: null,
  }),
]);

/** 選別中の想定（1 日 1 通・最大 10 通） */
export const SELECTION_INTERVAL_DAYS = 1;
export const SELECTION_MAX_MESSAGES = 10;

/** 選別終了後の想定（週 2 回 = 月約 8 回） */
export const STEADY_SENDS_PER_WEEK = 2;
export const STEADY_SENDS_PER_MONTH = 8;

/** 毎月確認するもの（**運用の単一源**） */
export const MONTHLY_REVIEW_ITEMS = Object.freeze([
  'active contact 数',
  '月間予定送信数',
  'Automation 利用の有無',
  '超過料金の発生有無',
  '1 段階下のプランへ下げられるか',
]);

const intOr = (v, dflt) => (Number.isInteger(Number(v)) ? Number(v) : dflt);

/**
 * 選別期間の送信量。
 *
 * 1 日 1 通なので、**残りが k 通の人は k 日で配り終わる**。全員が同じ月に始まれば
 * 月間の通数は「残送信総数」とほぼ同じになる（最長でも 10 日で終わる）。
 *
 * @param {{countsByNextMessage: Record<number, number>, totalMessages?: number}} input
 * @returns {{contacts: number, remainingSends: number, peakMonthlyEmails: number,
 *            daysToFinish: number, byStart: Record<number, {contacts: number, sends: number}>}}
 */
export function estimateSelectionVolume({ countsByNextMessage, totalMessages } = {}) {
  const total = intOr(totalMessages, SELECTION_MAX_MESSAGES);
  const counts = countsByNextMessage && typeof countsByNextMessage === 'object'
    ? countsByNextMessage : {};
  const byStart = {};
  let contacts = 0;
  let remaining = 0;
  let longest = 0;
  for (let start = 1; start <= total; start += 1) {
    const c = intOr(counts[start] ?? counts[String(start)], 0);
    if (c <= 0) continue;
    const perContact = total - start + 1;
    byStart[start] = { contacts: c, sends: c * perContact };
    contacts += c;
    remaining += c * perContact;
    if (perContact > longest) longest = perContact;
  }
  return {
    contacts,
    remainingSends: remaining,
    /** 全員が同じ月に始まる前提の月間通数（**安全側 = 多め**に見る）*/
    peakMonthlyEmails: remaining,
    daysToFinish: longest === 0 ? 0 : (longest - 1) * SELECTION_INTERVAL_DAYS,
    byStart,
  };
}

/**
 * 選別終了後（継続対象だけ）の送信量。週 2 回 = 月約 8 回。
 */
export function estimateSteadyVolume({ contacts, sendsPerMonth } = {}) {
  const c = Math.max(0, intOr(contacts, 0));
  const per = Math.max(0, intOr(sendsPerMonth, STEADY_SENDS_PER_MONTH));
  return { contacts: c, sendsPerMonth: per, monthlyEmails: c * per };
}

/**
 * 最小プランを選ぶ。
 *
 * @param {{contacts: number, monthlyEmails: number, candidates?: Array}} input
 * @returns {{
 *   recommended: object|null, fits: Array, tooSmall: Array, unverified: Array,
 *   requiresQuote: boolean, requiresApproval: true, reason: string
 * }}
 */
export function recommendPlan({ contacts, monthlyEmails, candidates } = {}) {
  const c = Math.max(0, intOr(contacts, 0));
  const e = Math.max(0, intOr(monthlyEmails, 0));
  const list = (Array.isArray(candidates) && candidates.length > 0 ? candidates : PLAN_CANDIDATES)
    .slice()
    .sort((a, b) => a.contactCap - b.contactCap);

  const fits = [];
  const tooSmall = [];
  const unverified = [];
  for (const p of list) {
    if (p.contactCap < c) { tooSmall.push({ id: p.id, reason: 'contact_cap' }); continue; }
    if (p.includedEmailsPerMonth === null || p.includedEmailsPerMonth === undefined) {
      // ⚠️ **未確認を「収まる」と言わない**（人が公表値を確認してから決める）
      unverified.push({ id: p.id, missing: 'includedEmailsPerMonth' });
      continue;
    }
    if (p.includedEmailsPerMonth < e) { tooSmall.push({ id: p.id, reason: 'email_cap' }); continue; }
    fits.push(p);
  }

  const recommended = fits[0] || null;
  return {
    recommended,
    fits,
    tooSmall,
    unverified,
    /**
     * 超過料金込みで上位と比べる必要があるか。
     * **どの候補も枠に収まらない**ときだけ true（そのとき初めて金額を調べる）。
     */
    requiresQuote: recommended === null,
    /** 課金変更は**必ず MK 承認**（自動で契約しない） */
    requiresApproval: true,
    reason: recommended
      ? 'smallest_plan_that_fits'
      : (unverified.length > 0 ? 'needs_published_values' : 'no_candidate_fits'),
    需要: { contacts: c, monthlyEmails: e },
  };
}

/**
 * いまの契約を 1 段階下げられるか（**毎月の確認用**）。
 *
 * @param {{currentPlanId: string, contacts: number, monthlyEmails: number}} input
 */
export function canDowngrade({ currentPlanId, contacts, monthlyEmails } = {}) {
  const cur = PLAN_CANDIDATES.find((p) => p.id === String(currentPlanId || '')) || null;
  const rec = recommendPlan({ contacts, monthlyEmails });
  if (!cur) {
    return {
      ok: false, reason: 'unknown_current_plan', recommended: rec.recommended, requiresApproval: true,
    };
  }
  if (!rec.recommended) {
    return {
      ok: false, reason: rec.reason, recommended: null, requiresApproval: true,
    };
  }
  const smaller = rec.recommended.contactCap < cur.contactCap;
  return {
    ok: smaller,
    reason: smaller ? 'smaller_plan_fits' : 'current_plan_is_minimal',
    current: { id: cur.id, contactCap: cur.contactCap },
    recommended: rec.recommended,
    requiresApproval: true,
  };
}

/**
 * 移行〜選別終了までの**契約判断の地点**をまとめる（PROGRESS に貼る形）。
 */
export function describePlanTimeline({ selection, steady, current } = {}) {
  const sel = selection || {};
  const std = steady || {};
  const atSelection = recommendPlan({
    contacts: sel.contacts, monthlyEmails: sel.peakMonthlyEmails,
  });
  const atSteady = recommendPlan({ contacts: std.contacts, monthlyEmails: std.monthlyEmails });
  return {
    選別中: {
      contact数: sel.contacts ?? null,
      残送信総数: sel.remainingSends ?? null,
      月間予定通数: sel.peakMonthlyEmails ?? null,
      想定プラン: atSelection.recommended ? atSelection.recommended.id : null,
      未確認: atSelection.unverified,
      金額比較が要るか: atSelection.requiresQuote,
    },
    選別後: {
      contact数: std.contacts ?? null,
      月間予定通数: std.monthlyEmails ?? null,
      想定プラン: atSteady.recommended ? atSteady.recommended.id : null,
      未確認: atSteady.unverified,
    },
    ダウングレード判定: current
      ? canDowngrade({
        currentPlanId: current, contacts: std.contacts, monthlyEmails: std.monthlyEmails,
      })
      : null,
    毎月の確認: MONTHLY_REVIEW_ITEMS,
    /** ⚠️ 契約・アップグレード・ダウングレードは**実行直前で停止して MK 承認** */
    課金変更: 'requires_mk_approval',
  };
}

export default recommendPlan;

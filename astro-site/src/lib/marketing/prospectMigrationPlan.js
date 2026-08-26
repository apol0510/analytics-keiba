/**
 * prospectMigrationPlan.js — CSV 取り込み分を **prospect プールへ戻す**計画（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-08-27 調査）
 *
 * 本来の方針は「**外部 CSV は Customers へ常駐させず prospect プールで配信し、
 * 反応した人だけ Customers へ昇格する**」（`prospectPolicy.js`）。
 * ところが実際の取り込みは `admin-customer-import` 経由で **Customers へ直接 CREATE** した。
 * 本番実測（2026-08-27）:
 *
 *   Customers 15,976 件 ／ うち `Source='customer-import:…'` が **14,489 件**
 *   prospect プールは **0 件**（`writeEnabled:false` のまま一度も使われていない）
 *
 * ## この計画が決めること
 *
 * 1 件ずつ **「prospect へ戻す」か「Customers に残す」か**を決める。判断材料は
 * 取り込み由来か / 有料化したか / 反応があったか の 3 つだけ。
 *
 * | 判定 | 対象 |
 * |---|---|
 * | `keep_not_imported` | 取り込み由来でない（もとからの顧客）|
 * | `keep_converted` | **本人が動いた**証拠がある（購入・申込・入金・ログイン）|
 * | `keep_engaged` | 開封・クリックなど**反応があった**（本来の方針でも昇格対象）|
 * | `review_operator_grant` | **運営側が付けた**販売資格・無料付与だけがある（判断保留・消さない）|
 * | `review_ambiguous` | 由来の分からない値がある（ポイント残高など。判断保留・消さない）|
 * | `keep_suppressed` | 配信停止・バウンス・退会（**恒久保持を前提にしない**。下記）|
 * | `migrate` | 上のどれにも当たらない = **反応が無いまま残っている取り込み分** |
 *
 * ## 運営側の付与を「本人の反応」と同一視しない（2026-08-27 MK 確定）
 *
 * 以前の版は `PremiumPlusEligibility` / `LightGrant*` / `PremiumGrant*` があるだけで
 * `keep_converted`（＝顧客になった）としていた。これらは **運営側の一括処理や
 * 自動処理が付けた値**であって、本人が何かをした証拠ではない。同一視すると
 * 「反応した人だけ Customers に残す」という方針そのものが崩れる。
 *
 * そこで:
 *   - **本人の行動**（有料プラン / 入金 / 申込 / 買い切り / ログイン）→ `keep_converted`
 *   - **運営側の付与**（販売資格 / 無料付与）→ `review_operator_grant`
 *   - **由来不明**（`ポイント` が 0 でない等。取り込みは 0 で作る）→ `review_ambiguous`
 *
 * ⚠️ `review_*` は **prospect へ移さない**（消さない）。ただし `keep_converted` にも
 *    数えない。**理由別に分けて出す**ので、あとから人が判断できる。
 * ⚠️ **迷ったら残す（keep）。** prospect へ戻すのは「消しても失うものが無い」と
 *    確認できた行だけ。判断材料が欠けていたら移さない（fail closed）。
 *
 * ## 配信停止・バウンス・退会も「Airtable に永久保持」を前提にしない
 *
 * `keep_suppressed` は**いま消さない**という意味であって、恒久保持の宣言ではない。
 * 再取り込みでの復活を防いでいるのは `EmailBlacklist`（正本）と
 * prospect の**抑止台帳**（`ak:prospect:blocked:<sha256>`・TTL なし・アドレスを持たない）。
 * 台帳へ hash を先に載せられれば、生アドレスの行は消せる。
 * その手順と**順序**は `buildSuppressionHandoff()` に閉じ込めてある（台帳が先・削除は後）。
 *
 * ⚠️ この関数は **Airtable も Redis も触らない**。計画を返すだけで、
 *    削除は別工程・別承認（`docs/PROSPECT_MIGRATION_PLAN.md`）。
 */

import { resolveCohort, COHORT, importBatchId } from './importCohort.js';

export const MIGRATION_DECISION = Object.freeze({
  MIGRATE: 'migrate',
  KEEP_NOT_IMPORTED: 'keep_not_imported',
  KEEP_CONVERTED: 'keep_converted',
  KEEP_ENGAGED: 'keep_engaged',
  KEEP_SUPPRESSED: 'keep_suppressed',
  /** 運営側が付けた販売資格・無料付与だけがある。**本人の反応ではない**ので保留 */
  REVIEW_OPERATOR_GRANT: 'review_operator_grant',
  /** 由来の分からない値がある。**消さないが顧客化とも数えない** */
  REVIEW_AMBIGUOUS: 'review_ambiguous',
});

export const DECISION_LABEL = Object.freeze({
  migrate: 'prospect へ戻す',
  keep_not_imported: '取り込み由来でない（残す）',
  keep_converted: '本人が動いた（購入・申込・入金・ログイン。残す）',
  keep_engaged: '反応があった（残す）',
  keep_suppressed: '配信停止・バウンス・退会（いまは残す）',
  review_operator_grant: '運営側の付与だけ（判断保留・消さない）',
  review_ambiguous: '由来不明の値あり（判断保留・消さない）',
});

/** **消さない**判定（migrate 以外はすべて残す） */
export function isKeepDecision(decision) {
  return decision !== MIGRATION_DECISION.MIGRATE;
}

const has = (v) => v !== undefined && v !== null && v !== '' && v !== false;
const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * **本人が動いた**証拠（1 つでもあれば顧客として残す）。
 *
 * ⚠️ ここに運営側の付与（販売資格 / 無料付与）を入れてはいけない。
 *    入れると「運営が一括で旗を立てた人」が全員 `keep_converted` になり、
 *    「反応した人だけ残す」という方針が意味を失う。
 */
export function hasSelfConversion(fields) {
  const f = fields || {};
  const plan = norm(f['プラン'] ?? f.Plan);
  if (plan && plan !== 'free') return true;                      // 有料プラン
  if (has(f.PaidAt) || f.PaymentConfirmed === true) return true;  // 入金
  if (has(f.RequestedPlan) || has(f.RequestedAmount)) return true; // 本人の申込
  if (f.LifetimeSanrenpuku === true) return true;                 // 買い切り購入
  if (has(f['最終ログイン'])) return true;                         // ログイン実績
  return false;
}

/**
 * **運営側・自動処理が付けた**もの（本人の反応ではない）。
 *
 * これしか無いレコードは `review_operator_grant` にする。消さないが、
 * 「顧客になった」とも数えない。どちらに寄せるかは人が決める。
 */
export function hasOperatorAssignment(fields) {
  const f = fields || {};
  if (f.LightGrantLifetime === true || has(f.LightGrantUntil)) return true;
  if (f.PremiumGrantLifetime === true || has(f.PremiumGrantUntil)) return true;
  if (has(f.PremiumPlusEligibility)) return true;   // Premium Plus の販売資格
  return false;
}

/**
 * 由来の分からない値。
 *
 * 取り込みは `ポイント: 0` で作る（`crm/importWritePlan.js`）ので、0 でなければ
 * 取り込み後に**誰かが**動かしている。本人（ログイン特典）か運営かを
 * `ポイント` だけからは決められないため、保留にする。
 */
export function hasAmbiguousSignal(fields) {
  const f = fields || {};
  return Number(f['ポイント']) > 0;
}

/**
 * @deprecated 2026-08-27。運営側の付与と本人の反応を同一視していた旧判定。
 * 呼ばないこと（`hasSelfConversion` / `hasOperatorAssignment` へ分割済み）。
 * **判定経路からは外してある**。互換のために残すが、新しい経路で使わない。
 */
export function hasCustomerEvidence(fields) {
  return hasSelfConversion(fields) || hasOperatorAssignment(fields) || hasAmbiguousSignal(fields);
}

/** 配信を止めている状態（prospect へ戻さず Customers 側で管理を続ける） */
export function isSuppressed(fields) {
  const f = fields || {};
  if (f.UnsubscribedAnalyticsKeiba === true) return true;
  if (f.WithdrawalRequested === true) return true;
  if (f.ForceLogout === true) return true;
  const status = norm(f.Status ?? f.AccountStatus);
  // 日本語表記も拾う（`entitlements/resolveEntitlements.js` の停止 Status と同じ集合）
  return ['suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled', 'closed', 'withdrawn',
    '停止', '無効', '解約', '退会'].includes(status);
}

/**
 * 1 件ぶんの判定。
 *
 * @param {{ fields: object, engagedEmails?: Set<string> }} input
 * @returns {{ decision: string, reason: string|null, batchId: string|null }}
 */
export function decideForRecord({ fields, engagedEmails } = {}) {
  const f = fields || {};
  const batchId = importBatchId(f.Source);
  if (resolveCohort(f) !== COHORT.IMPORTED) {
    return { decision: MIGRATION_DECISION.KEEP_NOT_IMPORTED, reason: 'not_imported', batchId: null };
  }
  // ① 本人が動いた（購入・申込・入金・ログイン）→ 顧客として残す
  if (hasSelfConversion(f)) {
    return { decision: MIGRATION_DECISION.KEEP_CONVERTED, reason: 'self_conversion', batchId };
  }
  // ② 配信を止めている状態は、保留より先に確定させる（送らない相手なので）
  if (isSuppressed(f)) {
    return { decision: MIGRATION_DECISION.KEEP_SUPPRESSED, reason: 'suppressed', batchId };
  }
  // ③ 運営側の付与しか無い → **顧客化と同一視せず保留**（消さない）
  if (hasOperatorAssignment(f)) {
    return { decision: MIGRATION_DECISION.REVIEW_OPERATOR_GRANT, reason: 'operator_grant_only', batchId };
  }
  // ④ 由来不明の値がある → 保留（消さない）
  if (hasAmbiguousSignal(f)) {
    return { decision: MIGRATION_DECISION.REVIEW_AMBIGUOUS, reason: 'ambiguous_signal', batchId };
  }
  const email = norm(f.Email);
  if (engagedEmails instanceof Set && email && engagedEmails.has(email)) {
    return { decision: MIGRATION_DECISION.KEEP_ENGAGED, reason: 'engaged', batchId };
  }
  return { decision: MIGRATION_DECISION.MIGRATE, reason: null, batchId };
}

/**
 * 一覧ぶんの計画。**件数と recordId だけ**を返す（アドレスは持ち回らない）。
 *
 * @param {{ records: Array<{id:string, fields:object}>, engagedEmails?: Set<string> }} input
 */
export function buildMigrationPlan({ records, engagedEmails } = {}) {
  const counts = Object.fromEntries(Object.values(MIGRATION_DECISION).map((d) => [d, 0]));
  const byBatch = {};
  const migrateIds = [];
  for (const r of Array.isArray(records) ? records : []) {
    const { decision, batchId } = decideForRecord({ fields: r && r.fields, engagedEmails });
    counts[decision] += 1;
    if (batchId) {
      byBatch[batchId] = byBatch[batchId] || Object.fromEntries(Object.values(MIGRATION_DECISION).map((d) => [d, 0]));
      byBatch[batchId][decision] += 1;
    }
    if (decision === MIGRATION_DECISION.MIGRATE && r && r.id) migrateIds.push(r.id);
  }
  const total = Array.isArray(records) ? records.length : 0;
  const accounted = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    counts,
    byBatch,
    migrateIds,
    /** 母数 = 判定の合計。**合わなければ計画を使わない**（取りこぼしの検知） */
    balanced: total === accounted,
  };
}

/**
 * 巻き戻しに必要な項目がそろっているか。
 * **prospect へ移す前に、その行を Customers へ戻せることを確かめる。**
 */
export const ROLLBACK_REQUIRED_FIELDS = Object.freeze(['Email', 'Source']);

export function assertRollbackComplete({ records, migrateIds } = {}) {
  const ids = new Set(Array.isArray(migrateIds) ? migrateIds : []);
  const missing = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!ids.has(r && r.id)) continue;
    for (const f of ROLLBACK_REQUIRED_FIELDS) {
      if (!has((r.fields || {})[f])) { missing.push({ id: r.id, field: f }); break; }
    }
  }
  return { ok: missing.length === 0, missing, checked: ids.size };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 配信停止・バウンス・退会の行を「Airtable に永久保持」にしないための引き継ぎ
 * （2026-08-27 MK 確定）
 *
 * ## 何が問題か
 *
 * `keep_suppressed` を「Customers に永久に置く」と読むと、CSV 由来の停止アドレスが
 * レコード上限を恒久的に食い続ける。しかしこれらの行が担っているのは
 * **「二度と送らない」「再取り込みで復活させない」**の 2 点だけで、
 * どちらも**アドレスそのものを持たなくても**実現できる。
 *
 * ## 引き継ぎ先（どちらも既存。新しい仕組みを作らない）
 *
 * | 何を | どこへ | 生アドレスを持つか |
 * |---|---|---|
 * | 「もう送らない」の正本 | `EmailBlacklist`（Airtable・件数が小さい）| 持つ（正本なので）|
 * | 「再取り込みで復活させない」| `ak:prospect:blocked:<sha256>`（Redis・TTL なし）| **持たない**（hash のみ）|
 *
 * `planProspectIntake()` は取り込み時に `blockedHashes` を hash で照合するので、
 * **台帳に hash があれば、生アドレスがどこにも無くても復活しない**。
 *
 * ## 順序を間違えると復活する
 *
 *   1. 抑止台帳へ hash を書く（**先**）
 *   2. 台帳に載ったことを読み直して確認する
 *   3. そのうえで Customers / prospect の生アドレスを消す（**後**・別承認）
 *
 * 逆順にすると、消した瞬間から次の取り込みで**配信対象として復活する**。
 * `assertHandoffComplete()` が 2 を確かめるまで 3 へ進めない形にしてある。
 *
 * ⚠️ この関数群も **Airtable も Redis も触らない**。計画と検算だけを返す。
 * ⚠️ `EmailBlacklist` は移さない（`docs/AIRTABLE_CAPACITY.md`「触ってはいけないこと」）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 抑止の理由（台帳に残る。`prospectStore.BLOCK_KIND.SUPPRESSED` と同じ扱い） */
export const HANDOFF_REASON = Object.freeze({
  UNSUBSCRIBED: 'unsubscribe',
  WITHDRAWN: 'withdrawn',
  ACCOUNT_STOPPED: 'account_stopped',
  FORCE_LOGOUT: 'force_logout',
});

/** その行が止まっている理由を 1 つに決める（**強い順**・理由の奪い合いをさせない） */
export function resolveSuppressionReason(fields) {
  const f = fields || {};
  if (f.UnsubscribedAnalyticsKeiba === true) return HANDOFF_REASON.UNSUBSCRIBED;
  if (f.WithdrawalRequested === true) return HANDOFF_REASON.WITHDRAWN;
  if (f.ForceLogout === true) return HANDOFF_REASON.FORCE_LOGOUT;
  if (isSuppressed(f)) return HANDOFF_REASON.ACCOUNT_STOPPED;
  return null;
}

/**
 * `keep_suppressed` の行 → 抑止台帳へ載せる項目。
 *
 * **アドレスは返さない。** `hashFn` で hash 化した値だけを返す
 * （`prospectStore.emailHash` を渡す想定。渡されなければ計画を作らない）。
 *
 * @param {{records: Array<{id:string, fields:object}>, hashFn: (email:string)=>string,
 *          nowIso?: string, engagedEmails?: Set<string>}} input
 * @returns {{entries: Array<{recordId, hash, reason, at}>, skipped: object, counts: object}}
 */
export function buildSuppressionHandoff({ records, hashFn, nowIso, engagedEmails } = {}) {
  const entries = []; const skipped = {};
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };
  if (typeof hashFn !== 'function') {
    // ⚠️ hash 化できないなら**計画を作らない**（生アドレスを持ち回らないため）
    return { entries: [], skipped: { no_hash_fn: 1 }, counts: { 対象: 0, 引き継ぎ: 0 } };
  }
  const list = Array.isArray(records) ? records : [];
  let candidates = 0;
  for (const r of list) {
    const f = (r && r.fields) || {};
    const { decision } = decideForRecord({ fields: f, engagedEmails });
    if (decision !== MIGRATION_DECISION.KEEP_SUPPRESSED) continue;
    candidates += 1;
    const email = norm(f.Email);
    if (!email) { bump('no_email'); continue; }
    const reason = resolveSuppressionReason(f);
    if (!reason) { bump('reason_unresolved'); continue; }  // 理由が決まらないなら載せない
    entries.push({
      recordId: r.id || null,
      hash: hashFn(email),
      reason,
      at: String(nowIso || ''),
    });
  }
  return {
    entries, skipped,
    counts: { 対象: candidates, 引き継ぎ: entries.length, 保留: candidates - entries.length },
  };
}

/**
 * 台帳へ載ったことを確かめる。**ここが true になるまで生アドレスを消さない。**
 *
 * @param {{entries: Array<{hash:string}>, blockedHashes: Set<string>}} input
 */
export function assertHandoffComplete({ entries, blockedHashes } = {}) {
  const have = blockedHashes instanceof Set ? blockedHashes : null;
  const list = Array.isArray(entries) ? entries : [];
  if (!have) return { ok: false, reason: 'ledger_unreadable', missing: list.length, checked: 0 };
  const missing = list.filter((e) => !have.has(e && e.hash));
  return {
    ok: list.length > 0 && missing.length === 0,
    reason: missing.length === 0 ? null : 'not_in_ledger',
    missing: missing.length,
    checked: list.length,
  };
}

/**
 * 生アドレスを消してよいか（**削除の直前に必ず通す**）。
 *
 * 消してよいのは、抑止台帳に hash が載っていることを**読み直して確認できた**行だけ。
 * 台帳を読めない・1 件でも載っていないなら **1 件も消さない**（fail closed）。
 */
export function canPurgeRawEmails({ handoff, blockedHashes } = {}) {
  const check = assertHandoffComplete({ entries: (handoff || {}).entries, blockedHashes });
  return {
    purgeAllowed: check.ok === true,
    reason: check.reason,
    checked: check.checked,
    missing: check.missing,
  };
}

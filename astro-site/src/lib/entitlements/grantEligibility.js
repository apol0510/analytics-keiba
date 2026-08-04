/**
 * grantEligibility.js — 「今回の無料付与」＝**この操作をいま実行できるか**（純粋・I/O なし）
 *
 * ── 3 つを混同しない ───────────────────────────────────────────
 *   1. 現在の無料付与（freeGrantStatus.resolveCurrentFreeGrant） … 顧客の**現在状態**
 *   2. 無料付与履歴（freeGrantStatus.resolveFreeGrantHistory）   … **過去の記録**
 *   3. 今回の無料付与（**このモジュール**）                       … **いま実行できるか**
 *
 * ── 判定の出どころ ────────────────────────────────────────────
 * 実行可否の正本は `comebackGrantPlan.checkGrantable`（dry-run と同じ関数）。
 * 理由コード・ラベルも `CB_SKIP` / `CB_SKIP_LABEL` をそのまま使うので、
 * **一覧・顧客詳細・フィルター・dry-run の除外理由が同じ言葉**になる。
 *
 * ── 「有効な無料付与がある人」は付与不可ではない ────────────────────
 * 既に無料付与がある顧客でも、**より強い内容（期限が伸びる / 無期限化）なら適用される**
 * （`promotionalGrants.isStrongerGrant`）。したがって
 *   ・Light 無料期間中 … Light をもっと長く / 永久にするなら適用される → **付与できる**
 *   ・Light 永久無料   … Light へ何を出しても適用されない（Premium は可）→ **注意**
 *   ・Light も Premium も永久無料 … どのティアへ出しても適用されない → **付与できない**
 * と、**実際に起きること**へ合わせて分ける。推測で「無料期間中だから不可」にしない。
 */

import { checkGrantable, CB_SKIP, CB_SKIP_LABEL } from '../comeback/comebackGrantPlan.js';
import { resolvePromotionalGrants } from './promotionalGrants.js';
import { validateFreeGrantConsistency } from './freeGrantStatus.js';

/** 「今回の無料付与」の状態（フィルターの選択肢と 1 対 1） */
export const GRANT_ELIGIBILITY = Object.freeze({
  GRANTABLE: 'grantable',
  BLOCKED: 'blocked',
  REVIEW: 'review',
});

export const GRANT_ELIGIBILITY_LABEL = Object.freeze({
  [GRANT_ELIGIBILITY.GRANTABLE]: '今回付与できる',
  [GRANT_ELIGIBILITY.BLOCKED]: '現在の状態では付与できない',
  [GRANT_ELIGIBILITY.REVIEW]: '要確認',
});

/** 画面に出す短い説明（本文は freeGrantStatus.js が持つ。ここは再エクスポート） */
export { GRANT_ELIGIBILITY_NOTE } from './freeGrantStatus.js';

/**
 * 追加の理由コード。**既存の CB_SKIP に無いものだけ**をここで定義する
 * （dry-run と共通の理由は CB_SKIP をそのまま使う）。
 */
export const GRANT_REASON = Object.freeze({
  OK: 'grantable',
  /** Light も Premium も永久無料 ＝ どのティアへ出しても適用されない */
  ACTIVE_BOTH: 'active_both',
  /** 取消の記録と付与内容が食い違う */
  REVOKED_CONFLICT: 'revoked_conflict',
  /** 判定材料が足りない */
  UNKNOWN: 'unknown',
  // ── 注意（付与はできるが、同じ内容は適用されない）──
  ACTIVE_LIGHT_PERIOD: 'active_light_period',
  ACTIVE_LIGHT_LIFETIME: 'active_light_lifetime',
  ACTIVE_PREMIUM_PERIOD: 'active_premium_period',
  ACTIVE_PREMIUM_LIFETIME: 'active_premium_lifetime',
});

export const GRANT_REASON_LABEL = Object.freeze({
  [GRANT_REASON.OK]: '付与可能',
  [GRANT_REASON.ACTIVE_BOTH]: '付与不可：Light・Premium とも永久無料が有効',
  [GRANT_REASON.REVOKED_CONFLICT]: '要確認：取消状態と期限が不整合',
  [GRANT_REASON.UNKNOWN]: '要確認：判定材料が不足',
  [GRANT_REASON.ACTIVE_LIGHT_PERIOD]: '現在 Light 無料期間中（同じ内容は適用されません）',
  [GRANT_REASON.ACTIVE_LIGHT_LIFETIME]: 'Light 永久無料が有効（Light への付与は適用されません）',
  [GRANT_REASON.ACTIVE_PREMIUM_PERIOD]: '現在 Premium 無料期間中（同じ内容は適用されません）',
  [GRANT_REASON.ACTIVE_PREMIUM_LIFETIME]: 'Premium 永久無料が有効（Premium への付与は適用されません）',
});

/** dry-run の除外理由（CB_SKIP）を「付与不可：〜」の言い方へ寄せる */
const BLOCKED_LABEL = Object.freeze({
  [CB_SKIP.DATA_INCOMPLETE]: '付与不可：メールアドレス未登録・不正',
  [CB_SKIP.ACCOUNT_SUSPENDED]: '付与不可：アカウント停止・テストアカウント',
  [CB_SKIP.WITHDRAWAL_BLOCKED]: '付与不可：退会（この特典は退会者を対象にしていません）',
  [CB_SKIP.FORCE_LOGOUT_BLOCKED]: '付与不可：強制ログアウト',
  [CB_SKIP.DUPLICATE_EMAIL]: '付与不可：同一メールアドレスの重複レコード（ログインできません）',
  [CB_SKIP.UNKNOWN_CUSTOMER]: '付与不可：顧客レコード不明',
});

const str = (v) => String(v ?? '').trim();

/** 選択（文字列でも配列でも）→ 配列。空 / 'all' は条件なし */
function selection(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(str).filter((x) => x && x !== 'all');
}

/**
 * 「今回この顧客へ無料付与できるか」を 1 つの答えにする。
 *
 * ── `allowWithdrawn`（既定 false）────────────────────────────────
 * カムバックの Light 30 日無料を選んでいるときだけ true を渡す。判断の単一源は
 * `comeback/comebackWithdrawnPolicy.isWithdrawnGrantAllowed`。ここでは受け取った
 * 値を `checkGrantable` へそのまま渡すだけで、独自に施策を判定しない。
 *
 * @param {object|null} fields Customers の fields
 * @param {number} [nowMs]
 * @param {{ allowWithdrawn?: boolean }} [options]
 * @returns {{canGrant: boolean, status: string, reasonCode: string, reasonLabel: string,
 *            notes: Array<{code: string, label: string}>, statusLabel: string}}
 */
export function resolveGrantEligibility(fields, nowMs = Date.now(), options = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const allowWithdrawn = options && options.allowWithdrawn === true;
  const duplicateEmail = options && options.duplicateEmail === true;
  const f = fields && typeof fields === 'object' ? fields : null;
  const out = (status, reasonCode, reasonLabel, notes = []) => ({
    canGrant: status === GRANT_ELIGIBILITY.GRANTABLE,
    status,
    statusLabel: GRANT_ELIGIBILITY_LABEL[status],
    reasonCode,
    reasonLabel,
    notes,
  });

  if (!f) {
    return out(GRANT_ELIGIBILITY.BLOCKED, CB_SKIP.UNKNOWN_CUSTOMER, BLOCKED_LABEL[CB_SKIP.UNKNOWN_CUSTOMER]);
  }

  // ① 実行可否の正本（dry-run と同じ関数・同じ理由コード）
  const base = checkGrantable(f, { allowWithdrawn, duplicateEmail });
  if (!base.ok) {
    const code = base.reason;
    return out(GRANT_ELIGIBILITY.BLOCKED, code, BLOCKED_LABEL[code] || `付与不可：${CB_SKIP_LABEL[code] || code}`);
  }

  // ② 無料付与データの不整合は「要確認」（自動修復しない）
  const consistency = validateFreeGrantConsistency(f, now);
  if (!consistency.ok) {
    const revoked = consistency.reasons.some((r) => r.includes('取消'));
    const code = revoked ? GRANT_REASON.REVOKED_CONFLICT : CB_SKIP.GRANT_INCONSISTENT;
    const label = revoked
      ? GRANT_REASON_LABEL[GRANT_REASON.REVOKED_CONFLICT]
      : '要確認：無料付与データ不整合';
    return out(GRANT_ELIGIBILITY.REVIEW, code, label,
      consistency.reasons.map((r) => ({ code: CB_SKIP.GRANT_INCONSISTENT, label: r })));
  }

  // ③ 既存の付与内容から「そもそも適用されようがない」かを見る
  const g = resolvePromotionalGrants(f, now);
  const notes = [];
  if (g.light.active && g.light.lifetime) {
    notes.push({ code: GRANT_REASON.ACTIVE_LIGHT_LIFETIME, label: GRANT_REASON_LABEL[GRANT_REASON.ACTIVE_LIGHT_LIFETIME] });
  } else if (g.light.active) {
    notes.push({ code: GRANT_REASON.ACTIVE_LIGHT_PERIOD, label: GRANT_REASON_LABEL[GRANT_REASON.ACTIVE_LIGHT_PERIOD] });
  }
  if (g.premium.active && g.premium.lifetime) {
    notes.push({ code: GRANT_REASON.ACTIVE_PREMIUM_LIFETIME, label: GRANT_REASON_LABEL[GRANT_REASON.ACTIVE_PREMIUM_LIFETIME] });
  } else if (g.premium.active) {
    notes.push({ code: GRANT_REASON.ACTIVE_PREMIUM_PERIOD, label: GRANT_REASON_LABEL[GRANT_REASON.ACTIVE_PREMIUM_PERIOD] });
  }

  // 両ティアとも永久無料 ＝ どのティアへ出しても適用されない（実際に skip される）
  if (g.light.lifetime && g.premium.lifetime) {
    return out(GRANT_ELIGIBILITY.BLOCKED, GRANT_REASON.ACTIVE_BOTH,
      GRANT_REASON_LABEL[GRANT_REASON.ACTIVE_BOTH], notes);
  }

  return out(GRANT_ELIGIBILITY.GRANTABLE, GRANT_REASON.OK, GRANT_REASON_LABEL[GRANT_REASON.OK], notes);
}

/** 一覧 1 行に出す文字列（状態 + 理由。色に頼らない） */
export function formatGrantEligibility(e) {
  if (!e) return '';
  if (e.status === GRANT_ELIGIBILITY.GRANTABLE) {
    const note = e.notes && e.notes.length ? `（${e.notes.map((n) => n.label).join(' / ')}）` : '';
    return `付与可能${note}`;
  }
  return e.reasonLabel;
}

/** 選んだ状態のいずれかに当たるか（未選択なら絞らない） */
export function matchesGrantEligibility(status, sel) {
  const want = selection(sel);
  if (want.length === 0) return true;
  return want.includes(str(status));
}

/** フィルターの選択肢（画面はこれをそのまま出す） */
export const GRANT_ELIGIBILITY_OPTIONS = Object.freeze([
  { value: GRANT_ELIGIBILITY.GRANTABLE, label: GRANT_ELIGIBILITY_LABEL[GRANT_ELIGIBILITY.GRANTABLE] },
  { value: GRANT_ELIGIBILITY.BLOCKED, label: GRANT_ELIGIBILITY_LABEL[GRANT_ELIGIBILITY.BLOCKED] },
  { value: GRANT_ELIGIBILITY.REVIEW, label: GRANT_ELIGIBILITY_LABEL[GRANT_ELIGIBILITY.REVIEW] },
]);

export const GRANT_ELIGIBILITY_VALUES = Object.freeze(GRANT_ELIGIBILITY_OPTIONS.map((o) => o.value));

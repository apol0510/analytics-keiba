/**
 * premiumPlusAdminAudience.js — 管理画面に「レビュー候補として表示する」条件の単一源（純粋・I/O なし）
 *
 * ── なぜ別モジュールなのか ────────────────────────────────────────────
 * Premium Plus には性質の違う 2 つの判定がある。これを 1 つの関数で兼ねてはいけない。
 *
 *   1. **公開判定（audience）** = `resolvePremiumPlusRelease()`
 *      顧客に何を見せるか。ROUTE A / ROUTE B が成立し、かつ PremiumPlusEligibility が
 *      eligible のときだけ公開する。判定不能はすべて非公開（fail closed）。
 *
 *   2. **レビュー候補判定（このモジュール）**
 *      管理者が手動で選別するために、管理画面の一覧へ**名前を出すか**だけを決める。
 *      公開・販売・課金には一切影響しない。
 *
 * 2026-07-30 の事故: 管理画面の list API が 1 の結果（`route === none` なら除外）を
 * そのまま表示条件に使っていたため、**有効な Premium 会員なのに `PaidAt` が空な旧会員が
 * 一覧から丸ごと消えていた**。`PaidAt` は 2026-07-10 の入金確認フロー刷新（`126b6a7`）で
 * 初めて書かれるようになったフィールドで、それ以前に有料化した会員は構造的に持たない。
 * 「旧データが足りない」ことと「販売対象外」は別の話であり、前者を理由に人そのものが
 * 一覧から消えると、管理者はその会員の存在に気づけない。
 *
 * ── 設計上の絶対条件 ──────────────────────────────────────────────
 * - このモジュールは **表示するかどうか**しか返さない。eligibility を返さない・変えない。
 * - 一覧に出したことで顧客側の公開状態が変わってはいけない
 *   （公開判定は `resolvePremiumPlusRelease()` のままで、こちらは一切触らない）。
 * - 旧データ不足を**推測で埋めない**。`登録日` / `createdTime` は無料登録日であって
 *   Premium 加入日ではなく、`有効期限` は加入日から導出された値（Lifetime は遠未来の番人値）。
 *   どちらも ROUTE B の anchor に流用してはいけない。足りないことを足りないまま表示する。
 */

import { PP_ROUTE, PP_ELIGIBILITY_FIELDS, PREMIUM_30D_DAYS } from './premiumPlusRelease.js';

/**
 * ── 2026-08-13 の事故: 販売資格者が管理画面から消えていた ──────────────
 * list API は Customers を**無フィルタで全件走査**し `MAX_PAGES=40`（先頭 4,000 件）で
 * 打ち切っていた。Customers が 15,962 件へ育った結果、**即時販売 3 名が 3 名とも
 * 窓の外**になり、画面は「即時販売 0 / 保留 6 / ROUTE A 0」と表示していた
 * （実際は即時販売 3 / 保留 0 / 三連複会員 17）。顧客側の CTA は正常に出ていたのに、
 * 管理者だけが「誰にも売れていない」と誤認する状態だった。
 *
 * 対策: **Airtable 側で候補になり得ない人を落としてから読む**。
 * 実測でプラン分布は Free 15,864 / Premium 58 / Premium Sanrenpuku 17 / Light 14 /
 * Test 6 / Premium Combo 3 なので、下の formula で ~98 件（1 ページ）に収まる。
 *
 * 🛡️ **超集合の原則**: この formula は `resolveAdminCandidate().listed === true` に
 *    なり得る人を **1 人も落としてはいけない**（落とすと管理者から永久に見えなくなる）。
 *    余分に取るのは安全（JS 側の `resolveAdminCandidate` が落とす）。
 *    向きは `premiumPlusAdminAudience.test.mjs` の総当たりで固定している。
 *
 * ⚠️ Airtable の `{Field} != BLANK()` は**中身に関係なく常に真**になる（本番実測）。
 *    「空でない」は必ず `NOT({Field} = BLANK())` と書くこと。
 */
export function buildAdminCandidateFormula() {
  return [
    'OR(',
    [
      // 無料会員は route も premiumActive も成立しないので候補になり得ない。
      // ⚠️ プランが空の人は「Free と等しくない」= true 側に倒れて**含まれる**（安全側）
      "NOT({プラン} = 'Free')",
      // 三連複を買い切りで持つ現行形式（プランは Premium のまま）
      '{LifetimeSanrenpuku}',
      // 管理者が既に判断済みの相手は、route が崩れても一覧から消さない（EXPLICIT）
      `NOT({${PP_ELIGIBILITY_FIELDS.STATUS}} = BLANK())`,
      // override だけ残っている異常系も管理者に見せる
      "NOT({PremiumPlusReleaseOverride} = BLANK())",
    ].join(', '),
    ')',
  ].join('');
}

/** 上の formula と同じ判定を JS で行う（テスト用の鏡） */
export function adminCandidateFormulaAccepts(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const plan = String(f['プラン'] ?? '').trim();
  if (plan !== 'Free') return true;
  if (f.LifetimeSanrenpuku === true) return true;
  if (hasValue(f[PP_ELIGIBILITY_FIELDS.STATUS])) return true;
  if (hasValue(f.PremiumPlusReleaseOverride)) return true;
  return false;
}

/** 一覧に出す理由（＝管理者が見るべき区分）。表示専用で、販売資格ではない。 */
export const PP_CANDIDATE = Object.freeze({
  /** ROUTE A 成立（三連複保有） */
  ROUTE_A: 'route_a',
  /** ROUTE B 成立（有効 Premium・加入 30 日以上・三連複なし） */
  ROUTE_B: 'route_b',
  /** 有効 Premium・加入日あり・30 日未満（あと N 日で ROUTE B） */
  WAITING_30D: 'waiting_30d',
  /** 有効 Premium だが加入日（PaidAt）が無い＝経過日数を判定できない旧会員 */
  ANCHOR_MISSING: 'anchor_missing',
  /** route は成立しないが PremiumPlusEligibility が設定済み（管理者の判断の痕跡を消さない） */
  EXPLICIT: 'explicit',
  /** 一覧に出さない */
  NONE: 'none',
});

/** 一覧の区分ラベル（管理者向け。顧客画面には出さない） */
export const PP_CANDIDATE_LABEL = Object.freeze({
  route_a: 'ROUTE A（三連複）',
  route_b: 'ROUTE B（Premium 30日）',
  waiting_30d: 'ROUTE B 待機中',
  anchor_missing: '加入日データなし',
  explicit: '資格設定済み',
  none: '対象外',
});

/**
 * 「販売可にしても顧客側に出ない」理由。
 * 一覧に出す以上、管理者が空振りの操作をしないよう理由を明示する（黙って無効化しない）。
 */
export const PP_RELEASE_BLOCKER = Object.freeze({
  /** 加入から 30 日に到達していない（時間が解決する） */
  WAIT_30D: 'wait_30d',
  /** 加入日（PaidAt）が無く経過日数を判定できない（データ補正が必要） */
  ANCHOR_MISSING: 'anchor_missing',
});

/** ブロッカーの説明文（管理者向け・そのまま画面に出す） */
export const PP_RELEASE_BLOCKER_NOTE = Object.freeze({
  wait_30d: '加入から 30 日に到達していないため、販売可にしても顧客側にはまだ表示されません。',
  anchor_missing: '加入日（PaidAt）が未記録のため、販売可にしても顧客側には表示されません。Airtable の PaidAt を実際の入金確認日で補正してください。',
});

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * 管理画面の一覧に表示するか、その理由は何かを決める（表示専用・書き込みなし）。
 *
 * 判定順:
 *   1. ROUTE A / ROUTE B 成立 → 表示（従来どおり）
 *   2. PremiumPlusEligibility 設定済み → 表示（管理者の判断を消さない・従来どおり）
 *   3. 有効な Premium 会員（三連複なし）→ 表示。加入日の有無で区分を分ける ← 追加分
 *   4. それ以外 → 非表示
 *
 * ⚠️ 3 は**表示だけ**を増やす。eligibility は未設定のまま（= normalizeEligibility が review）で、
 *    `resolvePremiumPlusRelease()` は route が none のままなので顧客側は何も変わらない。
 *
 * @param {{
 *   fields?: object|null,   Airtable Customers の fields（PremiumPlusEligibility の有無だけ見る）
 *   member: { premiumActive?: boolean, hasSanrenpuku?: boolean, premiumPaidAtMs?: number|null },
 *   release: { route?: string, daysSincePremium?: number|null },
 * }} input
 * @returns {{
 *   listed: boolean,
 *   kind: string,
 *   label: string,
 *   daysUntilRouteB: number|null,   ROUTE B までの残日数（waiting_30d のときのみ）
 *   releaseBlockedBy: string|null,  販売可にしても公開されない理由
 *   note: string,                   管理者向けの 1 行説明（空文字なら注意なし）
 * }}
 */
export function resolveAdminCandidate({ fields, member, release } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const m = member && typeof member === 'object' ? member : {};
  const r = release && typeof release === 'object' ? release : {};

  const out = (kind, over = {}) => ({
    listed: kind !== PP_CANDIDATE.NONE,
    kind,
    label: PP_CANDIDATE_LABEL[kind] || kind,
    daysUntilRouteB: null,
    releaseBlockedBy: null,
    note: '',
    ...over,
  });

  if (r.route === PP_ROUTE.SANRENPUKU) return out(PP_CANDIDATE.ROUTE_A);
  // ROUTE C（管理者が UpsellTarget=plus / 今すぐ販売可 を指定した有効 Premium）も
  // ROUTE B と同じ「販売対象」として一覧に出す。加入日条件を免除しているだけで扱いは同じ。
  if (r.route === PP_ROUTE.PREMIUM_30D || r.route === PP_ROUTE.PREMIUM_ADMIN) return out(PP_CANDIDATE.ROUTE_B);

  // 管理者が既に何かを判断した相手は、route が崩れても一覧から消さない
  if (hasValue(f[PP_ELIGIBILITY_FIELDS.STATUS])) return out(PP_CANDIDATE.EXPLICIT);

  // ── ここから下が「表示だけ」を広げる範囲 ────────────────────────
  // 三連複を持たない有効 Premium 会員。route は none だが、販売判断の対象ではある。
  if (m.premiumActive === true && m.hasSanrenpuku !== true) {
    const days = typeof r.daysSincePremium === 'number' && Number.isFinite(r.daysSincePremium)
      ? r.daysSincePremium
      : null;

    // 加入日が読めない（旧会員）。推測で日付を作らず、足りないことをそのまま出す。
    if (!Number.isFinite(m.premiumPaidAtMs) || days === null) {
      return out(PP_CANDIDATE.ANCHOR_MISSING, {
        releaseBlockedBy: PP_RELEASE_BLOCKER.ANCHOR_MISSING,
        note: PP_RELEASE_BLOCKER_NOTE.anchor_missing,
      });
    }

    // 加入日はあるが 30 日未満。時間が経てば ROUTE B に入る。
    if (days < PREMIUM_30D_DAYS) {
      return out(PP_CANDIDATE.WAITING_30D, {
        daysUntilRouteB: PREMIUM_30D_DAYS - days,
        releaseBlockedBy: PP_RELEASE_BLOCKER.WAIT_30D,
        note: PP_RELEASE_BLOCKER_NOTE.wait_30d,
      });
    }

    // days >= 30 なら上の ROUTE B 判定で拾われているはず（保険）
    return out(PP_CANDIDATE.ROUTE_B);
  }

  return out(PP_CANDIDATE.NONE);
}

export default resolveAdminCandidate;

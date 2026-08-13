/**
 * customerScanBounds.js — Customers を**必要な人だけ**取るための絞り込み（純粋・I/O なし）
 *
 * ## なぜ
 *
 * Customers は 15,962 件。無フィルタで先頭から読んで上限で打ち切る実装は、
 * **構文も型も正しいのに本番規模でだけ人を静かに落とす**。実際に起きたこと:
 *
 *   - 販売一覧の即時販売 3 名が全員窓の外 → 「即時販売 0」
 *   - 連続配信の受信対象 10 名のうち 2 名しか見えない
 *   - 無料体験の下見が 3,629 / 14,489 と過少表示
 *
 * ## 方針（この 2 つしか許さない）
 *
 * 1. **用途別に formula で絞ってから読む**（この画面に要る候補は誰か、を式で書く）
 * 2. 絞れない用途は **fail closed**（少ない件数を正しい件数として見せない）
 *
 * 全件を読み切る道は選ばない。Airtable は 1 ページ 100 件・**base あたり毎秒 5 リクエスト**
 * なので、15,962 件は 160 ページ = **最短でも 32 秒**かかり、同期 Function の実行時間に入らない。
 * 「上限を上げる」は解決にならない（タイムアウトへ移し替えるだけ）。
 *
 * ## 🛡️ 超集合の原則
 *
 * formula は **JS 側の判定が拾う人を 1 人も落としてはいけない**。
 * 落とすと集計から人が消え、「該当者なし」が嘘になる。
 * 落としてよいのは、その条件に照らして**構造的に該当し得ない人**だけ。
 *
 * そのため各 formula には **JS の鏡（`*Mirror`）** を用意し、
 * テストで「formula が落とす人を JS も落とす」ことを固定する。
 *
 * ## ⚠️ Airtable の罠
 *
 * - `{Field} != BLANK()` は**中身に関係なく常に真**。空でないは `NOT({Field} = BLANK())`
 * - `LOWER()` はするが、正規化（NFKC・空白→ハイフン）はできない。
 *   別名は「ハイフン形」と「空白形」の**両方**を並べる
 */

import { PLAN_ALIASES } from '../auth/planNormalization.js';
import { MK_PLAN, MK_CONTRACT } from './customerMarketingAudience.js';

/** 1 回の取得で許すページ数（1 ページ 100 件）。**増やして解決しない** */
export const SCAN_MAX_PAGES = 40;

/** 絞り込めないまま読もうとしたときのコード */
export const SCAN_FAIL = Object.freeze({
  /** 条件が広すぎて候補を絞れない（＝全件走査になる） */
  NOT_NARROWABLE: 'scan_not_narrowable',
  /** 絞ったが、それでも上限に達した（件数を確定できない） */
  LIMIT: 'scan_limit',
});

const str = (v) => String(v ?? '').trim();

/** Airtable の文字列リテラルへ安全に埋める */
export function escapeFormulaValue(v) {
  return str(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const notBlank = (f) => `NOT({${f}} = BLANK())`;
const eqLower = (field, value) => `LOWER(TRIM({${field}} & '')) = '${escapeFormulaValue(value)}'`;

/**
 * 正規化トークンを Airtable で当てられる形へ広げる。
 *
 * `normalizePlanToken` は NFKC + 小文字化 + 空白/アンダースコアを `-` へ潰すが、
 * Airtable の式では小文字化しかできない。`premium-sanrenpuku` は保存値としては
 * `Premium Sanrenpuku` のこともあるので、**両方**を候補に入れる（超集合側へ倒す）。
 */
export function planTokenVariants(token) {
  const t = str(token).toLowerCase();
  return [...new Set([t, t.replace(/-/g, ' '), t.replace(/-/g, '_')])];
}

/** MK_PLAN グループ → そのグループになり得る `プラン` 生値トークン（PLAN_ALIASES が正本） */
export function planTokensFor(group) {
  const canonicalOf = {
    [MK_PLAN.PREMIUM_SANRENPUKU]: new Set(['premium-sanrenpuku', 'premium-combo']),
    [MK_PLAN.PREMIUM]: new Set(['premium', 'premium-predictions']),
    [MK_PLAN.LIGHT]: new Set(['light']),
  }[group];
  if (!canonicalOf) return [];
  // 正規値そのものと、その正規値へ落ちる別名の**両方**を集める
  const tokens = new Set([...canonicalOf]);
  for (const [alias, canonical] of Object.entries(PLAN_ALIASES)) {
    if (canonicalOf.has(canonical)) tokens.add(alias);
  }
  return [...tokens].flatMap(planTokenVariants).sort();
}

/** 有料 tier になり得る `プラン` 生値トークンすべて（free の否定に使う） */
export function paidPlanTokens() {
  return [...new Set([
    ...planTokensFor(MK_PLAN.PREMIUM_SANRENPUKU),
    ...planTokensFor(MK_PLAN.PREMIUM),
    ...planTokensFor(MK_PLAN.LIGHT),
  ])].sort();
}

const anyPlanToken = (tokens) => `OR(${tokens.map((t) => eqLower('プラン', t)).join(', ')})`;

/**
 * プラン区分の候補句。
 *
 * ⚠️ `free` は「free と書いてある人」ではない。`resolvePlanGroup` は
 * **未知の文字列も free へ倒す**（`normalizePlan(...) ?? 'free'`）ので、
 * free の候補は「**有料 tier のどれでもない人**」＝有料句の否定で表す。
 * ここを「プラン='free'」と書くと、綴り違いの無料会員が丸ごと消える。
 */
export function planGroupClause(group) {
  const lifetime = '{LifetimeSanrenpuku}';
  if (group === MK_PLAN.PREMIUM_SANRENPUKU) {
    return `OR(${lifetime}, ${anyPlanToken(planTokensFor(MK_PLAN.PREMIUM_SANRENPUKU))})`;
  }
  if (group === MK_PLAN.PREMIUM) {
    return anyPlanToken(planTokensFor(MK_PLAN.PREMIUM));
  }
  if (group === MK_PLAN.LIGHT) {
    return anyPlanToken(planTokensFor(MK_PLAN.LIGHT));
  }
  if (group === MK_PLAN.FREE) {
    return `AND(NOT(${lifetime}), NOT(${anyPlanToken(paidPlanTokens())}))`;
  }
  return null;
}

/** JS の鏡: そのプラン区分になり得るか（テストで formula と突き合わせる） */
export function planGroupMirror(group, fields) {
  const f = fields || {};
  const raw = str(f['プラン'] ?? f.Plan).toLowerCase();
  const lifetime = f.LifetimeSanrenpuku === true;
  const hit = (g) => planTokensFor(g).includes(raw);
  if (group === MK_PLAN.PREMIUM_SANRENPUKU) return lifetime || hit(MK_PLAN.PREMIUM_SANRENPUKU);
  if (group === MK_PLAN.PREMIUM) return hit(MK_PLAN.PREMIUM);
  if (group === MK_PLAN.LIGHT) return hit(MK_PLAN.LIGHT);
  if (group === MK_PLAN.FREE) return !lifetime && !paidPlanTokens().includes(raw);
  return false;
}

/**
 * 契約状態の候補句。
 *
 * `none` は Free（＝有料 tier でない）と同義なので free 句を再利用する。
 * `active` / `expiring_soon` / `expired` / `unknown` は**有料 tier である**ことが前提で、
 * 期限・Status の細かい判定は JS 側（`resolveContract`）が持つ。ここは**超集合**として
 * 「有料 tier である」だけを課す（日付比較を式で二重実装しない）。
 */
export function contractClause(state) {
  if (state === MK_CONTRACT.NONE) return planGroupClause(MK_PLAN.FREE);
  if ([MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON, MK_CONTRACT.EXPIRED, MK_CONTRACT.UNKNOWN].includes(state)) {
    return `OR({LifetimeSanrenpuku}, ${anyPlanToken(paidPlanTokens())})`;
  }
  return null;
}

/** Premium Plus 販売資格の候補句（`unset` は空欄） */
export function premiumPlusClause(state) {
  const F = 'PremiumPlusEligibility';
  if (state === 'unset') return `{${F}} = BLANK()`;
  if (['eligible', 'review', 'blocked'].includes(state)) return eqLower(F, state);
  return null;
}

/** 選択肢（同じ項目内は OR）を 1 つの句へ。1 つでも句を作れなければ null（＝絞れない） */
function orClauses(values, make) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const parts = values.map(make);
  if (parts.some((p) => !p)) return null; // 絞れない値が混ざったら諦める（超集合を壊さない）
  return parts.length === 1 ? parts[0] : `OR(${parts.join(', ')})`;
}

/**
 * 顧客一覧（`action='customers'`）の候補 formula を作る。
 *
 * **Airtable の列で表せる条件だけ**を使う（plan / contract / premiumPlus）。
 * 送信可否・履歴・最終ログイン・オファー・無反応は他テーブルや Redis 由来なので
 * 式にできない。それらは読み込んだ**あとで** JS が絞る（候補集合は超集合のまま）。
 *
 * 1 つも表せなければ `null` を返す。呼び出し側は**全件走査へ落とさず fail closed** する。
 *
 * @param {{plan?: string[], contract?: string[], premiumPlus?: string[]}} picked
 * @returns {string|null}
 */
export function buildCustomerListFormula(picked = {}) {
  const clauses = [
    orClauses(picked.plan, planGroupClause),
    orClauses(picked.contract, contractClause),
    orClauses(picked.premiumPlus, premiumPlusClause),
  ].filter(Boolean);
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `AND(${clauses.join(', ')})`;
}

/**
 * セグメント下見（`action='segments'`）の候補 formula。
 *
 * セグメントはすべて「**現役の有料会員でない人**」を見ている（有料会員は共通の絶対除外）。
 * それ以上に絞れるものだけ、追加の条件を足す。
 *
 * ⚠️ ここで落としてよいのは `match()` が構造的に false になる人だけ。
 *    「送れるか」（配信停止・バウンス・無反応）は式に入れない（判定の単一源が別にある）。
 *
 * @returns {string|null} null = 絞れない（呼び出し側は fail closed）
 */
export function buildSegmentFormula(segmentId) {
  const free = planGroupClause(MK_PLAN.FREE);
  // 支払い実績（everPaid）の痕跡。1 つでもあれば「過去有料」になり得る
  const everPaid = `OR(${[
    notBlank('PaidAt'), notBlank('有効期限'), notBlank('ExpirationDate'),
    '{LifetimeSanrenpuku}', notBlank('SanrenpukuPaidAt'),
  ].join(', ')})`;

  switch (segmentId) {
    case 'free-all':
    case 'free-recent-login':
    case 'free-dormant':
      return free;
    case 'ex-paid-now-free':
      return `AND(${free}, ${everPaid})`;
    case 'logged-in-not-purchased':
      // ログイン記録があり、支払い実績が無い
      return `AND(OR(${notBlank('最終ログイン')}, ${notBlank('LastLoginAt')}), NOT(${everPaid}))`;
    case 'expired':
    case 'withdrawn':
      // 元有料会員に限られる（有料 tier の痕跡がある人）
      return `OR({LifetimeSanrenpuku}, ${anyPlanToken(paidPlanTokens())}, ${notBlank('PaidAt')}, ${notBlank('有効期限')})`;
    case 'opened-not-logged-in':
      // 開封記録は Customers に無い（配信台帳側）。**式で絞れない**
      return null;
    default:
      return null;
  }
}

/** 無料付与の操作 ID が入る列（正本は promotionalGrants の運用） */
export const GRANT_OP_FIELDS = Object.freeze(['LightGrantOp', 'PremiumGrantOp']);

/** その付与操作で処理された人だけを引く（引き継ぎ・突合用） */
export function buildGrantOperationFormula(operationId) {
  const id = str(operationId);
  if (!id) return null;
  return `OR(${GRANT_OP_FIELDS.map((f) => eqLower(f, id.toLowerCase())).join(', ')})`;
}

/** 無料付与の操作痕跡がある人（最新の操作を探すとき用） */
export function buildAnyGrantOperationFormula() {
  return `OR(${GRANT_OP_FIELDS.map(notBlank).join(', ')})`;
}

/**
 * カムバック候補の formula。
 *
 * カムバックの対象は「**現役の有効会員でない人**」。有効会員は `Status='active'` かつ
 * 有料プランなので、その**否定**が超集合になる。
 * 画面で契約状態・プランが指定されていれば、さらに絞る。
 *
 * ⚠️ `active` を明示的に選んでいる場合（現有効会員も見たい）は否定を課さない。
 */
export function buildComebackCandidateFormula(filter = {}) {
  const clauses = [];
  const contract = Array.isArray(filter.contract) ? filter.contract : [];
  const plan = Array.isArray(filter.plan) ? filter.plan : [];

  const wantsActive = contract.includes('active') || contract.includes('expiring_soon');
  if (!wantsActive) {
    // 現役の有効会員（active × 有料プラン）を落とす。それ以外はすべて残す
    clauses.push(`NOT(AND(LOWER(TRIM({Status} & '')) = 'active', OR({LifetimeSanrenpuku}, ${anyPlanToken(paidPlanTokens())})))`);
  }
  const planClause = orClauses(plan, planGroupClause);
  if (planClause) clauses.push(planClause);

  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `AND(${clauses.join(', ')})`;
}

/** JS の鏡: カムバック候補になり得るか（テストで formula と突き合わせる） */
export function comebackCandidateMirror(filter, fields) {
  const f = fields || {};
  const contract = Array.isArray(filter?.contract) ? filter.contract : [];
  const plan = Array.isArray(filter?.plan) ? filter.plan : [];
  const wantsActive = contract.includes('active') || contract.includes('expiring_soon');
  if (!wantsActive) {
    const status = str(f.Status).toLowerCase();
    const paid = f.LifetimeSanrenpuku === true
      || paidPlanTokens().includes(str(f['プラン'] ?? f.Plan).toLowerCase());
    if (status === 'active' && paid) return false;
  }
  if (plan.length && !plan.some((g) => planGroupMirror(g, f))) return false;
  return true;
}

/** 上限に当たったときに返す本文（少ない件数を正しい件数として見せない） */
export function describeScanLimit({ what, pagesFetched, maxPages = SCAN_MAX_PAGES }) {
  return {
    error: `${what}の取得が上限（${maxPages} ページ = ${maxPages * 100} 件）に達しました。`
      + '件数を確定できないため結果を返しません（0 件・少ない件数として表示しません）。'
      + '絞り込み条件を追加してください。',
    code: SCAN_FAIL.LIMIT,
    pagesFetched,
    maxPages,
    sideEffects: 'none',
  };
}

/** 絞り込めないときに返す本文 */
export function describeNotNarrowable({ what, hint }) {
  return {
    error: `${what}を絞り込めませんでした。Customers は 15,962 件あり、`
      + '無条件で読むと先頭だけを読んで**人が静かに消えます**。'
      + (hint ? `${hint}` : '条件を 1 つ以上選んでください。'),
    code: SCAN_FAIL.NOT_NARROWABLE,
    sideEffects: 'none',
  };
}

/**
 * ── 「読まない」と決めた理由を運用者へ届けるためのエラー ─────────────────
 *
 * 取得を中断すること自体は正しい（少ない件数を正しい件数として見せない）。
 * だが **理由が `internal error` になると、運用者は何をすればよいか分からない**。
 *
 * 2026-08-13 の本番 read-only 検証で実際に起きたこと:
 *   `admin-comeback-grants` を絞り込みなしで呼ぶと `500 {"error":"internal error"}`。
 *   中身は「上限に達したので絞り込んでください」という**対処可能な**理由なのに、
 *   画面には「内部エラー」としか出ない。運用者からは**壊れている**ように見え、
 *   「条件を足せば見られる」ことに辿り着けない。
 *
 * そこで、絞り込み不可・上限到達は **型付きエラー**として投げ、
 * Function 側の catch が 400 + 理由コードへ写せるようにする。
 * `throw` のまま握り潰さない・500 にしない、が要点。
 */
export class ScanBoundsError extends Error {
  /** @param {{error: string, code: string}} body そのままレスポンス本文にできる形 */
  constructor(body) {
    super(body && body.error ? body.error : 'scan bounds exceeded');
    this.name = 'ScanBoundsError';
    this.body = body;
    this.status = 400;
  }
}

/** 上限に達した（絞ったが件数を確定できない） */
export function scanLimitError(args) {
  return new ScanBoundsError(describeScanLimit(args));
}

/** そもそも絞り込めない（無条件の全件走査になる） */
export function notNarrowableError(args) {
  return new ScanBoundsError(describeNotNarrowable(args));
}

/**
 * catch した例外を **400 応答へ写す**。対象外なら null（呼び出し側は従来どおり 500）。
 *
 * `instanceof` だけに頼らない（バンドラ経由で別インスタンスになった場合に
 * 静かに 500 へ戻ってしまうため、`name` と `code` でも判定する）。
 */
export function scanErrorResponse(e) {
  if (!e) return null;
  const isScan = e instanceof ScanBoundsError
    || (e.name === 'ScanBoundsError' && e.body && typeof e.body === 'object');
  if (!isScan) return null;
  const body = e.body && typeof e.body === 'object' ? e.body : describeScanLimit({ what: '取得' });
  // 副作用が無いことは必ず明示する（運用者が「途中まで書かれたのでは」と疑わないように）
  return { status: e.status || 400, body: { sideEffects: 'none', ...body } };
}

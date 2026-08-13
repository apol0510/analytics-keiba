/**
 * premiumPlusAdminBounded.test.mjs — 管理画面の候補取得が**誰も取りこぼさない**こと
 *   node --test src/lib/premiumPlus/premiumPlusAdminBounded.test.mjs
 *
 * 2026-08-13 の事故: list API が無フィルタ全件走査 + `MAX_PAGES=40`（先頭 4,000 件）で
 * 打ち切っていたため、**即時販売 3 名が 3 名とも窓の外**になり、管理画面は
 * 「即時販売 0 / 保留 6 / ROUTE A 0」と表示していた（実際は 3 / 0 / 三連複 17）。
 * 顧客側の CTA は正常に出ていたので、管理者だけが誤認する形だった。
 *
 * ここで固定するのは【超集合】: formula が落とした人は永久に管理者から見えない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildAdminCandidateFormula, adminCandidateFormulaAccepts, resolveAdminCandidate,
} from './premiumPlusAdminAudience.js';
import { resolvePremiumPlusRelease } from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';

const NOW = Date.parse('2026-08-13T02:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString();

/** Function 側と同じ材料で candidate を解決する */
function listedByJs(fields) {
  const member = resolvePlusMemberFromFields(fields, { nowMs: NOW });
  const release = resolvePremiumPlusRelease(fields, { nowMs: NOW });
  return resolveAdminCandidate({ fields, member, release }).listed === true;
}

// ── 🛡️ 超集合（ここが壊れると販売資格者が管理者から消える）──────────
test('【最重要】一覧に出すべき人を formula が落とさない（総当たり）', () => {
  const axes = {
    'プラン': ['Free', 'Light', 'Premium', 'Premium Sanrenpuku', 'Premium Combo', 'Test', ''],
    Status: [undefined, 'active', 'withdrawn', 'pending'],
    PlanType: [undefined, 'Annual', 'Lifetime'],
    '有効期限': [undefined, day(365), day(-10)],
    LifetimeSanrenpuku: [undefined, true],
    PremiumPlusEligibility: [undefined, 'eligible', 'review', 'blocked'],
    PremiumPlusReleaseOverride: [undefined, 'phase4'],
    PaidAt: [undefined, day(-60), day(-5)],
  };
  const keys = Object.keys(axes);
  let checked = 0;

  const walk = (i, acc) => {
    if (i === keys.length) {
      const fields = {};
      for (const [k, v] of Object.entries(acc)) if (v !== undefined) fields[k] = v;
      checked += 1;
      if (listedByJs(fields) && !adminCandidateFormulaAccepts(fields)) {
        assert.fail(`一覧に出すべき人を formula が落とした: ${JSON.stringify(fields)}`);
      }
      return;
    }
    for (const v of axes[keys[i]]) walk(i + 1, { ...acc, [keys[i]]: v });
  };
  walk(0, {});
  assert.ok(checked > 2000, `総当たりが少なすぎる: ${checked}`);
});

test('無料会員だけは落とす（候補になり得ないため）', () => {
  assert.equal(adminCandidateFormulaAccepts({ 'プラン': 'Free' }), false);
  // ただし管理者が判断済み / 買い切り三連複 / override があれば落とさない
  assert.equal(adminCandidateFormulaAccepts({ 'プラン': 'Free', PremiumPlusEligibility: 'review' }), true);
  assert.equal(adminCandidateFormulaAccepts({ 'プラン': 'Free', LifetimeSanrenpuku: true }), true);
  assert.equal(adminCandidateFormulaAccepts({ 'プラン': 'Free', PremiumPlusReleaseOverride: 'phase4' }), true);
});

test('プランが空の人は安全側（含める）へ倒す', () => {
  assert.equal(adminCandidateFormulaAccepts({}), true);
  assert.equal(adminCandidateFormulaAccepts({ 'プラン': '' }), true);
});

test('有料プランは全部拾う', () => {
  for (const p of ['Premium', 'Premium Sanrenpuku', 'Premium Combo', 'Light', 'Test']) {
    assert.equal(adminCandidateFormulaAccepts({ 'プラン': p }), true, `落ちている: ${p}`);
  }
});

// ── formula が本番で 422 にならないこと ─────────────────────────
test('【本番で 422 にしない】formula が構文として壊れていない', () => {
  const f = buildAdminCandidateFormula();
  let depth = 0; let inStr = false;
  for (const ch of f) {
    if (ch === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    assert.ok(depth >= 0, '閉じ括弧が多い');
  }
  assert.equal(depth, 0, '括弧が閉じていない');
  assert.equal(inStr, false, '文字列が閉じていない');
  const masked = f.replace(/'[^']*'/g, '§');
  assert.equal(/§\s*[A-Za-z_(]/.test(masked), false, '文字列の直後に区切りが無い');
  assert.equal(/\}\s*\{/.test(masked), false, 'フィールド参照の間に区切りが無い');
});

test('【Airtable の罠】!= BLANK() を使っていない（常に真になる）', () => {
  assert.equal(/!=\s*BLANK\(\)/.test(buildAdminCandidateFormula()), false,
    '!= BLANK() は中身に関係なく常に真。NOT({Field} = BLANK()) を使うこと');
});

// ── Function 側の配線 ──────────────────────────────────────────
const FN = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
const code = FN.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
/** 個別検索の式を組み立てる単一源 */
const SEARCH = readFileSync(new URL('./premiumPlusAdminSearch.js', import.meta.url), 'utf8');

test('【配線】list は formula で絞ってから読む（全件走査へ戻さない）', () => {
  assert.match(code, /buildAdminCandidateFormula\(\)/);
  assert.match(code, /filterByFormula: candidateFormula/);
  // 無フィルタ GET へ戻っていないこと
  assert.equal(/searchParams\.set\('pageSize', '100'\)[\s\S]{0,200}airtableHeaders\(KEY\) \}\);/.test(code), false,
    '無フィルタの全件 GET へ戻っている');
});

test('【安全】上限に達したら fail closed（黙って少なく見せない）', () => {
  assert.match(code, /candidate_scan_limit/);
  // truncated=true で break して結果を返す形が復活していないこと
  assert.equal(/truncated = true; break;/.test(code), false, 'silent truncation が復活している');
});

// ── 一覧と集計が同じ集合から出ること / lookup の迂回 ──────────────
test('【配線】並び順を明示して Airtable の既定順に依存しない', () => {
  assert.match(code, /sort: \[\{ field: 'Email', direction: 'asc' \}\]/);
});

test('【配線】一覧と集計は同じ rows から算出する（別集合を数えない）', () => {
  // counts は rows.filter(...) だけで作る
  const idx = code.indexOf('counts: {');
  const body = code.slice(idx, idx + 900);
  assert.match(body, /total: rows\.length/);
  for (const k of ['review', 'eligible', 'blocked', 'routeA', 'routeB', 'immediate']) {
    assert.ok(new RegExp(`${k}: rows\\.filter`).test(body), `${k} が rows 由来でない`);
  }
});

/** handleLookup の本体だけを切り出す */
function lookupBody() {
  const i = code.indexOf('async function handleLookup');
  const rest = code.slice(i + 10);
  const end = rest.indexOf('\nasync function ');
  return rest.slice(0, end > 0 ? end : rest.length);
}

test('【配線】個別検索は候補集合を迂回して直接引ける', () => {
  assert.match(code, /action === 'lookup'/);
  // 検索式の組み立ては単一源（premiumPlusAdminSearch）。Function 側に書き写さない
  assert.match(code, /buildLookupFormula\(/);
  assert.match(code, /filterByFormula: built\.formula/);
  const body = lookupBody();
  assert.equal(/buildAdminCandidateFormula/.test(body), false, 'lookup が候補 formula で絞っている');
  assert.match(body, /buildAdminRow\(/, '一覧と別の組み立てをしている');
});

test('【配線】氏名・アドレスの一部でも引ける（完全一致 Email だけに戻さない）', () => {
  // 手元に完全なアドレスが無い相手（例: Daniel / 0510apolone / tori）を調べられること。
  // 完全一致しか引けないと「調べられない」が「見ていない」と誤読される。
  assert.match(SEARCH, /FIND\('\$\{safe\}', LOWER\(\{\$\{f\}\} & ''\)\)/);
  assert.match(SEARCH, /SEARCH_FIELDS = Object\.freeze\(\['Email', '氏名'\]\)/);
  // 完全なアドレスのときだけ完全一致（同姓同名を巻き込まない）
  assert.match(SEARCH, /LOWER\(TRIM\(\{Email\}\)\) = /);
});

test('【安全】検索語はエスケープしてから formula へ入れる', () => {
  // 生の入力が式へ入ると、式が壊れて全件一致にも 0 件一致にも化ける
  assert.match(SEARCH, /export function escapeFormulaText/);
  assert.match(SEARCH, /replace\(\/\\\\\/g, '\\\\\\\\'\)\.replace\(\/'\/g, "\\\\'"\)/);
  assert.equal(/escapeFormulaText/.test(SEARCH), true);
  // Function 側で素の入力を式へ入れていないこと
  const body = lookupBody();
  assert.equal(/filterByFormula: `/.test(body), false, 'Function 側で式を組み立て直している');
});

test('【安全】一致が多すぎる検索は一部だけ返さない（fail closed）', () => {
  const body = lookupBody();
  assert.match(body, /search_too_broad/);
  assert.equal(/truncated = true/.test(body), false, '一部だけ返して「これで全部」と読ませている');
});

// ── 画面: truncated のときに 0 件・全体件数を出さない ────────────
const PAGE = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');

test('【表示】取得上限のときは件数も一覧も出さない（0 件と誤読させない）', () => {
  assert.match(PAGE, /件数を確定できませんでした/);
  assert.match(PAGE, /0 件ではありません/);
  // truncated 判定が render の件数表示より前にあること
  const iTrunc = PAGE.indexOf("if (data.truncated) {");
  const iCount = PAGE.indexOf("$('count').textContent = '表示 '");
  assert.ok(iTrunc > 0 && iCount > iTrunc, 'truncated 判定より前に件数を出している');
  // 集計も出さない
  assert.match(PAGE, /renderSummary\(data\.truncated \? null : \(data\.counts \|\| \{\}\)\)/);
  assert.match(PAGE, /件数は取得できていません/);
});

test('【表示】旧「一部のみ表示」の握りつぶしが復活していない', () => {
  assert.equal(/件数が多いため一部のみ表示しています', 'err'\);/.test(PAGE), false,
    '取得上限を警告だけで通す旧挙動が戻っている');
});

test('【表示】候補集合外は Email 検索で引ける導線がある', () => {
  assert.match(PAGE, /lookupOutsideCandidates/);
  assert.match(PAGE, /action: 'lookup'/);
});

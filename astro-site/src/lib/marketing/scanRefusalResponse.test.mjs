/**
 * scanRefusalResponse.test.mjs — 「読まないと決めた理由」が運用者へ届くことを固定する
 *   node --test src/lib/marketing/scanRefusalResponse.test.mjs
 *
 * ## なぜ必要か
 *
 * 全件走査をやめて fail closed にしたのは正しい（少ない件数を正しい件数として
 * 見せない）。だが 2026-08-13 の**本番 read-only 検証**で、拒否の理由が
 * `500 {"error":"internal error"}` に潰れていることが分かった。
 *
 *   POST /admin-comeback-grants {"action":"customers"}     → 500 internal error
 *   （中身は「上限に達したので絞り込んでください」という**対処できる**理由）
 *
 * 運用者からは**壊れている**ようにしか見えず、「条件を足せば見られる」ことに
 * 辿り着けない。これは「人が静かに消える」のを直した代わりに
 * 「運用者が静かに詰まる」状態を作っている。
 *
 * ここでは **理由が失われないこと**と、**副作用ゼロを明示すること**を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SCAN_FAIL,
  ScanBoundsError,
  scanLimitError,
  notNarrowableError,
  scanErrorResponse,
} from './customerScanBounds.js';
import { EmailLookupError, emailLookupErrorResponse } from '../crm/customerEmailLookup.js';

const fn = (name) => readFileSync(new URL(`../../../netlify/functions/${name}.js`, import.meta.url), 'utf8');

// ── ScanBoundsError ────────────────────────────────────────────
test('上限到達は 400 と理由コードで返る（500 にしない）', () => {
  const r = scanErrorResponse(scanLimitError({ what: 'カムバック候補', pagesFetched: 40 }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, SCAN_FAIL.LIMIT);
  assert.match(r.body.error, /絞り込み条件を追加/);
  assert.equal(r.body.sideEffects, 'none');
});

test('絞り込み不可も 400 と理由コードで返る', () => {
  const r = scanErrorResponse(notNarrowableError({ what: '顧客一覧' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, SCAN_FAIL.NOT_NARROWABLE);
  assert.equal(r.body.sideEffects, 'none');
});

test('【重要】理由に「何をすればよいか」が必ず入る', () => {
  for (const e of [scanLimitError({ what: 'x', pagesFetched: 40 }), notNarrowableError({ what: 'x' })]) {
    const r = scanErrorResponse(e);
    assert.match(r.body.error, /絞り|条件/, `対処が書かれていない: ${r.body.error}`);
  }
});

test('無関係な例外は写さない（500 のまま扱わせる）', () => {
  assert.equal(scanErrorResponse(new Error('boom')), null);
  assert.equal(scanErrorResponse(new TypeError('x')), null);
  assert.equal(scanErrorResponse(null), null);
  assert.equal(scanErrorResponse(undefined), null);
});

test('バンドル差で instanceof が効かなくても name+body で写せる', () => {
  const lookalike = Object.assign(new Error('x'), {
    name: 'ScanBoundsError', body: { error: 'e', code: SCAN_FAIL.LIMIT }, status: 400,
  });
  const r = scanErrorResponse(lookalike);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, SCAN_FAIL.LIMIT);
});

test('ScanBoundsError は Error であり message を持つ', () => {
  const e = scanLimitError({ what: 'x', pagesFetched: 1 });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof ScanBoundsError);
  assert.ok(e.message.length > 0);
});

// ── EmailLookupError ───────────────────────────────────────────
test('CSV が多すぎる場合は「分割してください」と返す', () => {
  const r = emailLookupErrorResponse(new EmailLookupError('too_many_emails', { emails: 50000, chunks: 250 }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'customer_email_lookup:too_many_emails');
  assert.match(r.body.error, /分割/);
  assert.equal(r.body.sideEffects, 'none');
});

test('重複過多は「先に重複を整理」と返す', () => {
  const r = emailLookupErrorResponse(new EmailLookupError('chunk_page_limit', { pages: 20, chunkSize: 200 }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /重複/);
});

test('未知コードでも 400 と「取り込んでいない」ことを返す', () => {
  const r = emailLookupErrorResponse(new EmailLookupError('brand_new_code'));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /取り込みは行っていません/);
});

test('【重要】detail に数値以外（アドレス等）を混ぜない', () => {
  const r = emailLookupErrorResponse(new EmailLookupError('too_many_emails', {
    emails: 10, leaked: 'someone@example.com', list: ['a@b.c'],
  }));
  assert.deepEqual(r.body.detail, { emails: 10 });
  assert.ok(!JSON.stringify(r.body).includes('example.com'), '応答にアドレスが漏れている');
});

test('無関係な例外は写さない', () => {
  assert.equal(emailLookupErrorResponse(new Error('boom')), null);
  assert.equal(emailLookupErrorResponse(null), null);
});

// ── Function 側の配線（握り潰しへの逆戻りを止める）────────────────
test('【重要】admin-comeback-grants が理由を 500 へ潰さない', () => {
  const s = fn('admin-comeback-grants');
  assert.match(s, /scanErrorResponse/);
  const c = s.slice(s.lastIndexOf('} catch (e) {'));
  assert.ok(c.indexOf('scanErrorResponse') < c.indexOf("json(500"),
    'internal error を返す前に理由を写していない');
});

test('【重要】admin-comeback-grants が素の Error で上限を投げない', () => {
  const s = fn('admin-comeback-grants');
  assert.match(s, /throw notNarrowableError\(/);
  assert.match(s, /throw scanLimitError\(/);
  assert.ok(!/throw new Error\([^)]*絞り込め/.test(s), '素の Error に戻っている');
  assert.ok(!/throw new Error\(\s*`\$\{what \|\| table\}の取得が上限/.test(s));
});

for (const name of ['admin-customer-import', 'admin-customer-import-run']) {
  test(`【重要】${name} が照合失敗を 500 へ潰さない`, () => {
    const s = fn(name);
    assert.match(s, /emailLookupErrorResponse/);
    const c = s.slice(s.lastIndexOf('} catch (e) {'));
    assert.ok(c.indexOf('emailLookupErrorResponse') < c.indexOf("json(500"),
      'internal error を返す前に理由を写していない');
  });
}

test('admin-marketing は従来どおり 400 で返している（回帰していない）', () => {
  const s = fn('admin-marketing');
  assert.match(s, /describeNotNarrowable|describeScanLimit/);
});

test('【重要】どの経路もログに CSV の中身・アドレスを出さない', () => {
  for (const name of ['admin-comeback-grants', 'admin-customer-import', 'admin-customer-import-run']) {
    const s = fn(name);
    const c = s.slice(s.lastIndexOf('} catch (e) {'));
    const logs = c.match(/console\.error\([^)]*\)/g) || [];
    for (const l of logs) {
      assert.ok(!/e\.detail|req\b|rows|emails|csv/i.test(l), `${name} のログに入力が混ざる: ${l}`);
    }
  }
});

// ── formula が実在しない列を参照しないこと ─────────────────────────
//
// 2026-08-13 本番実測: `ExpirationDate` / `LastLoginAt` は Airtable に存在せず、
// これを含む formula は INVALID_FILTER_BY_FORMULA（HTTP 422）になり、
// `ex-paid-now-free` / `logged-in-not-purchased` の 2 セグメントが恒久的に 500 だった。
// JS でフィルタしていた頃は存在しない列が undefined になるだけで気付けなかった。
import {
  CUSTOMER_FORMULA_FIELDS,
  buildSegmentFormula,
  buildCustomerListFormula,
  buildComebackCandidateFormula,
  buildGrantOperationFormula,
  buildAnyGrantOperationFormula,
} from './customerScanBounds.js';

const SEGMENT_IDS = ['free-all', 'free-recent-login', 'free-dormant', 'ex-paid-now-free',
  'expired', 'withdrawn', 'opened-not-logged-in', 'logged-in-not-purchased'];

/** formula 文字列から `{列名}` をすべて抜き出す */
const fieldsIn = (f) => [...new Set([...String(f || '').matchAll(/\{([^}]+)\}/g)].map((m) => m[1]))];

test('【重要】全 formula が実在する列だけを参照する', () => {
  const allowed = new Set(CUSTOMER_FORMULA_FIELDS);
  const formulas = [
    ...SEGMENT_IDS.map((id) => [`segment:${id}`, buildSegmentFormula(id)]),
    ['customerList', buildCustomerListFormula({ plan: ['free', 'premium', 'light', 'premium_sanrenpuku'], contract: ['expired', 'active', 'none'], premiumPlus: ['eligible', 'unset'] })],
    ['comeback', buildComebackCandidateFormula({ contract: ['expired'], plan: ['premium'] })],
    ['comeback(空)', buildComebackCandidateFormula({})],
    ['grantOp', buildGrantOperationFormula('op-123')],
    ['anyGrantOp', buildAnyGrantOperationFormula()],
  ];
  for (const [label, f] of formulas) {
    for (const field of fieldsIn(f)) {
      assert.ok(allowed.has(field), `${label} が実在しない列を参照: {${field}}`);
    }
  }
});

test('【重要】存在しないことが確定した列名を formula へ書き戻さない', () => {
  const src = readFileSync(new URL('./customerScanBounds.js', import.meta.url), 'utf8');
  // コメント行は除外して、コードに残っていないことだけを見る
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const bad of ['ExpirationDate', 'LastLoginAt']) {
    assert.ok(!code.includes(bad), `${bad} は Airtable に存在しない（コードに残っている）`);
  }
});

test('ログイン記録は正本の列名を使う', () => {
  const f = buildSegmentFormula('logged-in-not-purchased');
  assert.ok(fieldsIn(f).includes('最終ログイン'), 'ログイン列が正本ではない');
});

test('壊れていた 2 セグメントが formula を返す（null に退化させない）', () => {
  for (const id of ['ex-paid-now-free', 'logged-in-not-purchased']) {
    assert.equal(typeof buildSegmentFormula(id), 'string', `${id} の formula が無い`);
  }
});

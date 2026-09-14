/**
 * sequenceAudienceFilter.test.mjs — prospect だけを少数で実証するための絞り込み
 *   node --test src/lib/marketing/sequenceAudienceFilter.test.mjs
 *
 * ## なぜ要るか（2026-09-14 の初回実配信）
 *
 * step2 の初回 150 通は**全員 Customers 由来**で、prospect は 1 人も含まれなかった。
 * `selectNextDueStep` は出所を見ないため、母数の並び順しだいで偏る。
 *
 * ## 固定すること
 *
 *   1. 既定（引数なし）は **従来どおり全部**（挙動を変えない）
 *   1-b. **env からは読まない**（env で持つと DRM の `tickEnv = { ...env }` へ漏れる）
 *   2. `prospect` 指定で **prospect だけ**が残る
 *   3. 出所が分からない相手は**送らない側**へ倒す
 *   4. 絞り込みは**減らす方向にしか働かない**（対象を増やさない）
 *   5. 下見の要約に**アドレスを含めない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  normalizeAudienceFilter, applyAudienceFilter, describeAudiencePreview,
  sourceOfTarget, AUDIENCE_FILTER,
} from './sequenceAudienceFilter.js';
import * as AUDIENCE_MOD from './sequenceAudienceFilter.js';

const t = (email) => ({ recordId: `rec-${email}`, fields: { Email: email } });
const PROSPECTS = new Set(['p1@example.invalid', 'p2@example.invalid']);
const TARGETS = [
  t('p1@example.invalid'), t('c1@example.invalid'),
  t('p2@example.invalid'), t('c2@example.invalid'),
];

test('既定は全部（呼び出しが渡さない限り挙動は変わらない）', () => {
  assert.equal(normalizeAudienceFilter(undefined), AUDIENCE_FILTER.ALL);
  const out = applyAudienceFilter({ targets: TARGETS, prospectEmails: PROSPECTS, filter: normalizeAudienceFilter(undefined) });
  assert.equal(out.kept.length, 4);
  assert.equal(out.dropped, 0);
});

test('【重要】prospect 指定で prospect だけが残る', () => {
  const filter = normalizeAudienceFilter('prospect');
  assert.equal(filter, AUDIENCE_FILTER.PROSPECT);
  const out = applyAudienceFilter({ targets: TARGETS, prospectEmails: PROSPECTS, filter });
  assert.equal(out.kept.length, 2);
  assert.deepEqual(out.kept.map((x) => x.fields.Email).sort(), ['p1@example.invalid', 'p2@example.invalid']);
  assert.equal(out.bySource.prospect, 2);
  assert.equal(out.bySource.customer, 2);
  assert.equal(out.dropped, 2);
});

test('customer 指定で Customers だけが残る', () => {
  const filter = normalizeAudienceFilter('customer');
  const out = applyAudienceFilter({ targets: TARGETS, prospectEmails: PROSPECTS, filter });
  assert.deepEqual(out.kept.map((x) => x.fields.Email).sort(), ['c1@example.invalid', 'c2@example.invalid']);
});

test('【重要】壊れた値は全部（推測で絞らない）', () => {
  for (const bad of ['', '  ', 'PROSPECTS', 'all', 'x', null, undefined, '1']) {
    assert.equal(normalizeAudienceFilter(bad), AUDIENCE_FILTER.ALL, String(bad));
  }
});

test('大文字・前後の空白は吸収する', () => {
  assert.equal(normalizeAudienceFilter(' Prospect '), AUDIENCE_FILTER.PROSPECT);
});

test('【重要】出所が分からない相手は送らない（どのフィルタでも残さない）', () => {
  const broken = [{ recordId: 'rec-x', fields: { Email: '' } }, { recordId: 'rec-y', fields: {} }];
  for (const filter of Object.values(AUDIENCE_FILTER)) {
    const out = applyAudienceFilter({ targets: broken, prospectEmails: PROSPECTS, filter });
    assert.equal(out.kept.length, 0, filter);
    assert.equal(out.bySource.unknown, 2, filter);
  }
});

test('【重要】絞り込みは対象を増やさない', () => {
  for (const filter of Object.values(AUDIENCE_FILTER)) {
    const out = applyAudienceFilter({ targets: TARGETS, prospectEmails: PROSPECTS, filter });
    assert.ok(out.kept.length <= TARGETS.length, filter);
  }
});

test('prospect の集合が無ければ、全員 Customers 扱い（prospect 指定なら 0 人）', () => {
  const out = applyAudienceFilter({
    targets: TARGETS, prospectEmails: undefined, filter: AUDIENCE_FILTER.PROSPECT,
  });
  assert.equal(out.kept.length, 0);
  assert.equal(out.bySource.customer, 4);
});

test('出所の判定は prospect 集合の有無だけで決まる', () => {
  assert.equal(sourceOfTarget(t('p1@example.invalid'), PROSPECTS), AUDIENCE_FILTER.PROSPECT);
  assert.equal(sourceOfTarget(t('c1@example.invalid'), PROSPECTS), AUDIENCE_FILTER.CUSTOMER);
  assert.equal(sourceOfTarget(t(''), PROSPECTS), null);
});

test('【重要】下見の要約にアドレスを含めない', () => {
  const filter = AUDIENCE_FILTER.PROSPECT;
  const out = applyAudienceFilter({ targets: TARGETS, prospectEmails: PROSPECTS, filter });
  const view = describeAudiencePreview({
    bySource: out.bySource, kept: out.kept, filter, step: 2, campaignId: 'campaign-discount-free',
  });
  const json = JSON.stringify(view);
  assert.equal(json.includes('@'), false, 'アドレスが混ざっている');
  assert.equal(view['うち prospect'], 2);
  assert.equal(view['うち Customers'], 2);
  assert.equal(view['絞り込み後に送る人数'], 2);
});

/**
 * ⚠️ **env から読む口を作り直さない**（2026-09-14 の本番事故）。
 *
 * 絞り込みを env で持つと `cron-drm-autostart` の `tickEnv = { ...env }` を通じて
 * DRM の入口にも効き、DRM の対象が黙って 0 人になる。
 * env を読む関数・env 名の定数は**この単一源に置かない**。
 */
test('【重要】env から絞り込みを読む口を持たない', () => {
  assert.equal('resolveAudienceFilter' in AUDIENCE_MOD, false, 'env 読みの関数が復活している');
  assert.equal('AUDIENCE_FILTER_ENV' in AUDIENCE_MOD, false, 'env 名の定数が復活している');
  const src = readFileSync(fileURLToPath(new URL('./sequenceAudienceFilter.js', import.meta.url)), 'utf8');
  assert.equal(src.includes('process.env'), false, '単一源が env を参照している');
});

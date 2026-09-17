/**
 * prospectScanWindow.test.mjs — prospect 索引の走査窓（取りこぼさない・二重送信を増やさない）
 *   node --test src/lib/marketing/prospectScanWindow.test.mjs
 *
 * ## 何を守るか
 *
 * live の tick は索引を**無制限に**読んでいた（全 11,799 件）。これを**有限の窓**にする。
 *
 * ⚠️ 速くなる幅は主張しない（**live の全件は測れていない**。下見は 4,000 で頭打ち）。
 *    ここで固定するのは「**取りこぼさない**」「**二重送信の防御を変えない**」
 *    「**1 tick の送信人数を変えない**」の 3 点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  nextProspectCursor, createProspectScanStore, resolveProspectPerTick,
  DEFAULT_PROSPECT_PER_TICK, prospectCursorKey, PROSPECT_CURSOR_KEY_PREFIX,
} from './prospectScanWindow.js';
import { SYNC_TICK_MAX_RECIPIENTS } from './sequenceAutomation.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);

// ══════════════════════════════════════════════════════════════════
//  ① 取りこぼさない（周回すれば全員に順番が回る）
// ══════════════════════════════════════════════════════════════════

test('【最重要】周回を重ねると全員が必ず 1 度は窓に入る', () => {
  const indexSize = 11799;
  const per = DEFAULT_PROSPECT_PER_TICK;
  const seen = new Set();
  let cur = { offset: 0, pass: 0 };
  for (let tick = 0; tick < 20; tick += 1) {
    const from = cur.offset;
    const scanned = Math.min(per, indexSize - from);
    for (let i = from; i < from + scanned; i += 1) seen.add(i);
    cur = nextProspectCursor({ offset: from, scanned, indexSize, pass: cur.pass });
    if (cur.completedPass && seen.size >= indexSize) break;
  }
  assert.equal(seen.size, indexSize, `${indexSize - seen.size} 人が一度も窓に入っていない`);
});

test('【最重要】読み切ったら先頭へ戻る（次の周回が始まる）', () => {
  const r = nextProspectCursor({ offset: 10000, scanned: 1799, indexSize: 11799, pass: 3 });
  assert.equal(r.offset, 0);
  assert.equal(r.completedPass, true);
  assert.equal(r.pass, 4);
});

test('【最重要】索引が縮んで位置が末尾を越えたら先頭へ戻す（空振りを続けない）', () => {
  const r = nextProspectCursor({ offset: 9000, scanned: 500, indexSize: 5000, pass: 1 });
  assert.equal(r.offset, 0, '縮んだ索引の外側を読み続けてしまう');
  assert.equal(r.completedPass, true);
});

test('【最重要】1 件も消費できなかったら先頭へ戻す（止まらない）', () => {
  const r = nextProspectCursor({ offset: 4000, scanned: 0, indexSize: 11799, pass: 0 });
  assert.equal(r.offset, 0);
  assert.equal(r.completedPass, true);
});

/**
 * ⚠️ `loadActiveProspects` は値を読めなかった hash を落とす。
 *    **読めた人数で進めると窓が巻き戻る**ので、消費した件数で進める。
 */
test('【最重要】読めた人数ではなく「消費した件数」で進む', () => {
  // 2,000 件ぶん消費したが、実際に読めたのは 1,800 人だった場合でも 2,000 進む
  const r = nextProspectCursor({ offset: 0, scanned: 2000, indexSize: 11799, pass: 0 });
  assert.equal(r.offset, 2000);
  assert.equal(r.completedPass, false);
});

test('【重要】途中は周回数が変わらない', () => {
  const r = nextProspectCursor({ offset: 2000, scanned: 2000, indexSize: 11799, pass: 2 });
  assert.equal(r.offset, 4000);
  assert.equal(r.pass, 2);
});

// ══════════════════════════════════════════════════════════════════
//  ② 送信人数・二重送信の防御は変わらない
// ══════════════════════════════════════════════════════════════════

test('【最重要】窓の大きさは 1 tick の送信人数と別物（送信は 50 のまま）', () => {
  assert.equal(SYNC_TICK_MAX_RECIPIENTS, 50, '送信の上限が変わっている');
  assert.ok(DEFAULT_PROSPECT_PER_TICK > SYNC_TICK_MAX_RECIPIENTS,
    '窓が送信上限より小さいと、送れるのに候補が足りなくなる');
});

test('【最重要】窓を変えても二重送信の防御（DeliveryKey）は通る', () => {
  // 窓は候補の絞り込みにしか使わない。積む直前の名指し確認は従来どおり
  assert.match(CRON, /fetchActiveDeliveryKeys\(/, '積む直前の名指し確認が消えている');
  assert.match(CRON, /claimDelivered\(/, '予約が消えている');
});

test('【最重要】窓は live だけに掛ける（下見は自分の窓を持つ）', () => {
  assert.match(CRON, /maxRecipients: prospectWindowSize/, 'live の窓が掛かっていない');
  assert.match(CRON, /offset: prospectCursor\.offset/, 'live が続きから読んでいない');
  // 下見側の窓（4,000 上限）はそのまま
  assert.match(CRON, /Math\.min\(4000, Number\(win\.limit\)\)/, '下見の窓が変わっている');
});

// ══════════════════════════════════════════════════════════════════
//  ③ カーソルが壊れても送信を止めない
// ══════════════════════════════════════════════════════════════════

test('【最重要】Redis が無ければ先頭から読む（従来挙動・止めない）', async () => {
  const store = createProspectScanStore({});
  assert.equal(store.usable, false);
  assert.deepEqual(await store.read('c:v1'), { offset: 0, pass: 0, fullRequired: false });
  assert.equal((await store.write('c:v1', { offset: 10 })).ok, false);
});

test('【最重要】カーソルが壊れていても先頭から読む', async () => {
  const store = createProspectScanStore({ redisCmd: async () => 'not-json' });
  assert.deepEqual(await store.read('c:v1'), { offset: 0, pass: 0, fullRequired: false });
});

test('【重要】書き込みに失敗しても例外を投げない（送信は済んでいる）', async () => {
  const store = createProspectScanStore({ redisCmd: async () => { throw new Error('down'); } });
  const r = await store.write('c:v1', { offset: 2000, pass: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write_failed');
});

test('【重要】カーソルを往復できる', async () => {
  let stored = null;
  const store = createProspectScanStore({
    redisCmd: async (cmd) => {
      if (cmd[0] === 'SET') { [, , stored] = cmd; return 'OK'; }
      return stored;
    },
  });
  await store.write('c:v1', { offset: 4000, pass: 2 });
  assert.deepEqual(await store.read('c:v1'), { offset: 4000, pass: 2, fullRequired: false });
});

test('【最重要】「次は全件で始める」印を往復できる', async () => {
  let stored = null;
  const store = createProspectScanStore({
    redisCmd: async (cmd) => {
      if (cmd[0] === 'SET') { [, , stored] = cmd; return 'OK'; }
      return stored;
    },
  });
  await store.setFullRequired('c:v1', { offset: 2000, pass: 1 });
  assert.deepEqual(await store.read('c:v1'), { offset: 2000, pass: 1, fullRequired: true });
  // 全件を読めたら外す
  await store.clearFullRequired('c:v1', { offset: 0, pass: 2 });
  assert.deepEqual(await store.read('c:v1'), { offset: 0, pass: 2, fullRequired: false });
});

test('【最重要】印の保存に失敗しても「成功」と混同しない', async () => {
  const store = createProspectScanStore({ redisCmd: async () => { throw new Error('down'); } });
  const r = await store.setFullRequired('c:v1', { offset: 0, pass: 0 });
  assert.equal(r.ok, false, '書けていないのに成功扱いしている');
});

test('【重要】キーは campaign ごとに分かれる', () => {
  assert.notEqual(prospectCursorKey('a:v1'), prospectCursorKey('b:v1'));
  assert.ok(prospectCursorKey('a:v1').startsWith(PROSPECT_CURSOR_KEY_PREFIX));
});

// ══════════════════════════════════════════════════════════════════
//  ④ 窓の大きさは実測値から決める
// ══════════════════════════════════════════════════════════════════

test('【最重要】既定の窓は実測のある 2,000（外挿で増やさない）', () => {
  assert.equal(DEFAULT_PROSPECT_PER_TICK, 2000,
    '窓を変えるなら live の実測を添えること（下見は 4,000 で頭打ち）');
});

test('【重要】env で変えられるが 4,000 を超えない（下見で測れる範囲まで）', () => {
  assert.equal(resolveProspectPerTick({ MARKETING_SEQUENCE_PROSPECT_PER_TICK: '1000' }), 1000);
  assert.equal(resolveProspectPerTick({ MARKETING_SEQUENCE_PROSPECT_PER_TICK: '99999' }),
    DEFAULT_PROSPECT_PER_TICK);
  for (const bad of ['0', '-1', 'abc', '', undefined]) {
    assert.equal(resolveProspectPerTick({ MARKETING_SEQUENCE_PROSPECT_PER_TICK: bad }),
      DEFAULT_PROSPECT_PER_TICK, String(bad));
  }
});

test('【最重要】速くなる幅を根拠にしていない（測っていない値を書かない）', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./prospectScanWindow.js', import.meta.url)), 'utf8',
  );
  assert.match(src, /live の全件（11,799）は測れていない|live の全件は測れていない/,
    '全件が未測定であることの注記が消えている');
  assert.match(src, /外挿/, '外挿を戒める記述が消えている');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 第 1 期完了 → 第 2 期入口が、窓のせいで永久に取りこぼされないこと
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 入口の候補も窓から取るので、**遅れる**ことはある（最大 1 周）。
 *    許されないのは「**永久に入れない**」「**二重に入る**」「**他 prospect が混ざる**」。
 */
test('【最重要】窓を回せば、第 1 期完了者は全員が入口の候補になる（最大 1 周の遅れ）', async () => {
  const { planPhase2Entry } = await import('./prospectPhase2Entry.js');
  const { buildProspectDeliveryKeys } = await import('./prospectSequenceHydration.js');
  const { getCampaign } = await import('./campaignCatalog.js');
  const { getSequenceSteps } = await import('./campaignSequence.js');
  const { PROSPECT_STATE } = await import('./prospectPolicy.js');

  const BRAND = 'AK';
  const FROM = 'noreply@keiba.link';
  const PRIOR = getCampaign('campaign-discount-free', { includeDisabled: true });
  const NEXT = getCampaign('campaign-prospect-phase2', { includeDisabled: true });
  const STEPS = getSequenceSteps(PRIOR);

  // 索引 1,000 人。うち 300 人が第 1 期を配り終えている（飛び飛びに配置）
  const people = Array.from({ length: 1000 }, (_, i) => ({
    email: `p${i}@example.invalid`, state: PROSPECT_STATE.SENDING, delivered: 0,
  }));
  const done = people.filter((_, i) => i % 3 === 0);            // 334 人
  const keyMap = buildProspectDeliveryKeys({ prospects: done, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const priorDelivered = new Set();
  for (const [, byStep] of keyMap) for (const s of STEPS) { const k = byStep.get(s.stepNumber); if (k) priorDelivered.add(k); }

  // 窓を回しながら入口を作る。入った人は「開始済み」として次から外れる
  const started = new Set();
  const entered = [];
  const per = 200;
  for (let tick = 0, off = 0; tick < 10; tick += 1) {
    const window = people.slice(off, off + per);
    const r = planPhase2Entry({
      prospects: window, priorCampaign: PRIOR, nextCampaign: NEXT,
      priorDeliveredKeys: priorDelivered, nextDeliveredKeys: started,
      brand: BRAND, fromEmail: FROM, maxPerTick: 50,
    });
    assert.equal(r.ok, true);
    for (const e of r.emails) {
      // 入口は一度だけ（二重入口は許さない）
      assert.equal(entered.includes(e), false, `${e} が二重に入口へ入った`);
      entered.push(e);
      const nb = buildProspectDeliveryKeys({
        prospects: [{ email: e }], campaign: NEXT, brand: BRAND, fromEmail: FROM,
      }).get(e);
      started.add(nb.get(1));                                   // 第 2 期 step1 を送った扱い
    }
    off += per;
    if (off >= people.length) off = 0;                          // 周回
  }

  // 第 1 期完了者だけが入り、全員が入った（他 prospect の混入 0）
  assert.equal(entered.length, done.length, `入口へ入れたのは ${entered.length} / ${done.length} 人`);
  const doneSet = new Set(done.map((p) => p.email));
  for (const e of entered) assert.ok(doneSet.has(e), `第 1 期未完の ${e} が入口へ入った`);
});

test('【最重要】一度入口へ入った人は、次の周回でも再入口しない', async () => {
  const { planPhase2Entry, PHASE2_ENTRY_SKIP } = await import('./prospectPhase2Entry.js');
  const { buildProspectDeliveryKeys } = await import('./prospectSequenceHydration.js');
  const { getCampaign } = await import('./campaignCatalog.js');
  const { getSequenceSteps } = await import('./campaignSequence.js');
  const { PROSPECT_STATE } = await import('./prospectPolicy.js');

  const BRAND = 'AK';
  const FROM = 'noreply@keiba.link';
  const PRIOR = getCampaign('campaign-discount-free', { includeDisabled: true });
  const NEXT = getCampaign('campaign-prospect-phase2', { includeDisabled: true });
  const people = [{ email: 'p1@example.invalid', state: PROSPECT_STATE.SENDING, delivered: 0 }];
  const km = buildProspectDeliveryKeys({ prospects: people, campaign: PRIOR, brand: BRAND, fromEmail: FROM });
  const priorDelivered = new Set();
  for (const s of getSequenceSteps(PRIOR)) priorDelivered.add(km.get('p1@example.invalid').get(s.stepNumber));

  const first = planPhase2Entry({
    prospects: people, priorCampaign: PRIOR, nextCampaign: NEXT,
    priorDeliveredKeys: priorDelivered, brand: BRAND, fromEmail: FROM,
  });
  assert.deepEqual(first.emails, ['p1@example.invalid']);

  // 同じ人が次の周回でまた窓に入っても、開始済みなので入らない
  const nextKeys = buildProspectDeliveryKeys({ prospects: people, campaign: NEXT, brand: BRAND, fromEmail: FROM });
  const started = new Set([nextKeys.get('p1@example.invalid').get(1)]);
  const second = planPhase2Entry({
    prospects: people, priorCampaign: PRIOR, nextCampaign: NEXT,
    priorDeliveredKeys: priorDelivered, nextDeliveredKeys: started,
    brand: BRAND, fromEmail: FROM,
  });
  assert.deepEqual(second.emails, [], '周回で再入口している');
  assert.equal(second.skipped[PHASE2_ENTRY_SKIP.ALREADY_STARTED], 1);
});

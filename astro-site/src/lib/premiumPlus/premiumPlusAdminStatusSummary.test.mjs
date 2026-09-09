/**
 * premiumPlusAdminStatusSummary.test.mjs
 *   「現在の状態」要約が**状態と食い違わない**ことを固定する
 *
 * ## 2026-09-09 MK 指摘
 *
 * > この会員の再募集を開始するボタンが押せそうだからと、今すぐ販売可も押せそうで、
 * > 矛盾しているからです。なぜ矛盾がないようにテスト確認してくれないの？
 *
 * 以前の確認は「開始」と「販売再開」が**同じ行に並ばないこと**だけを見ていた。
 * 「すでに購入できる会員に『今すぐ販売可』が押せる」という食い違いは見ていなかった。
 * ここでは**状態 × 操作の全組み合わせ**を回して、矛盾が 1 件も出ないことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAdminStatusSummary, describeActionConflicts, describeNextActions, describeStageLine,
  phaseSchedule, jstDate, jstDateTime, daysSinceJst,
} from './premiumPlusAdminStatusSummary.js';

/** 小田元さんの実データ相当（2026-09-09 に本番から read-only で取得した組み合わせ）*/
const REAL_SELLING = {
  eligibility: 'eligible', phase: 4, overrideApplied: false,
  purchaseEnabled: true, showProductPage: true, showPurchaseCta: true,
  salePaused: false, eligibleAt: '2026-08-25T09:41:10.698Z',
  reopenCouponClaimed: false, reopenLaunch: { state: 'not_started' }, reopenStart: { startsAtIso: '' },
};

const row = (over = {}) => ({ ...REAL_SELLING, ...over });
const itemOf = (s, key) => s.items.find((i) => i.key === key);

// ── 出す項目が揃っている ────────────────────────────────────
test('運営判断に必要な 5 項目が、この順番で先頭に出る', () => {
  const s = describeAdminStatusSummary(row());
  assert.deepEqual(s.items.map((i) => i.key), ['purchase', 'pause', 'phase', 'coupon', 'reopen'],
    '項目が欠けている / 順番が変わっている');
  for (const i of s.items) assert.ok(String(i.value).trim(), `${i.key} の値が空`);
  assert.ok(s.headline.trim(), '見出しが空');
});

// ── 本件の状態が正しく言えている ─────────────────────────────
test('【本件】9/4 から購入できる会員を「購入できます」と断定する', () => {
  const s = describeAdminStatusSummary(row());
  assert.match(s.headline, /2026-09-04 から購入できる状態です/);
  assert.equal(s.tone, 'ok');
  assert.match(itemOf(s, 'purchase').value, /いま購入できます/);
  assert.match(itemOf(s, 'phase').value, /販売中/);
  assert.equal(itemOf(s, 'coupon').value, '未取得');
  assert.equal(itemOf(s, 'reopen').value, '未開始');
});

test('段階公開の予定日を資格確定日から出す（0/3/6/10 日目）', () => {
  const sc = phaseSchedule('2026-08-25T09:41:10.698Z');
  assert.deepEqual(sc, { day0: '2026-08-25', teaser: '2026-08-28', preview: '2026-08-31', sale: '2026-09-04' });
  assert.match(itemOf(describeAdminStatusSummary(row()), 'phase').note, /購入解禁 2026-09-04/);
});

test('「再募集の開始」は購入可否とは別軸だと必ず添える（ラベル誤読を防ぐ）', () => {
  const s = describeAdminStatusSummary(row());
  const it = itemOf(s, 'reopen');
  assert.match(it.label, /クーポンの利用期間/, 'ラベルが販売の話に見えるままになっている');
  assert.ok(!/再募集/.test(it.label), '「再募集」が主表示に残っている');
  assert.match(it.note, /購入可否とは別軸/);
});

// ── 状態ごとの言い分け ──────────────────────────────────────
test('停止中は「購入できません」と言い、停止の項目でも停止中と言う', () => {
  const s = describeAdminStatusSummary(row({ salePaused: true, purchaseEnabled: false, phase: 1 }));
  assert.match(itemOf(s, 'purchase').value, /購入できません/);
  assert.match(itemOf(s, 'pause').value, /停止中/);
  assert.equal(s.tone, 'stop');
});

test('資格が保留なら購入できないと言う', () => {
  const s = describeAdminStatusSummary(row({ eligibility: 'review', purchaseEnabled: false, phase: 1 }));
  assert.match(itemOf(s, 'purchase').value, /販売資格が保留/);
});

test('販売対象外は「一時停止」と混ぜない', () => {
  const s = describeAdminStatusSummary(row({ eligibility: 'blocked', purchaseEnabled: false }));
  assert.match(itemOf(s, 'purchase').value, /販売対象外/);
  assert.equal(itemOf(s, 'pause').value, '停止していません');
});

test('待機中（ページは見えるが買えない）を言い分ける', () => {
  const s = describeAdminStatusSummary(row({ phase: 3, purchaseEnabled: false, showPurchaseCta: false }));
  assert.match(itemOf(s, 'purchase').value, /まだ購入できません（商品ページは見えています）/);
});

test('即時販売が効いている会員は段階公開の欄でそう言う', () => {
  const s = describeAdminStatusSummary(row({ overrideApplied: true }));
  assert.match(itemOf(s, 'phase').value, /待機日数を飛ばして販売中/);
});

test('クーポン取得済みなら取得日時を出す', () => {
  const s = describeAdminStatusSummary(row({
    reopenCouponClaimed: true, reopenCouponClaimedAt: '2026-09-01T02:03:04.000Z',
  }));
  assert.equal(itemOf(s, 'coupon').value, '取得済み');
  assert.match(itemOf(s, 'coupon').note, /2026-09-01 11:03/, 'JST で出ていない');
});

test('再募集が途中まで／確認できない状態を隠さない', () => {
  for (const [state, re] of [['incomplete', /要復旧/], ['unknown', /確認できません/],
    ['paused_after_start', /緊急停止/], ['live', /開始済み/]]) {
    const s = describeAdminStatusSummary(row({ reopenLaunch: { state } }));
    assert.match(itemOf(s, 'reopen').value, re, `${state} の表示が違う`);
  }
});

test('資格確定日が読めないときは予定を捏造しない', () => {
  const s = describeAdminStatusSummary(row({ eligibleAt: '' }));
  assert.match(itemOf(s, 'phase').note, /予定を計算できません/);
  assert.doesNotMatch(s.headline, /\d{4}-\d{2}-\d{2}/, '日付が無いのに日付を出している');
});

// ── ここが本題: 矛盾を作らない ────────────────────────────────
test('【重要】すでに購入できる会員に「今すぐ販売可」を押させない', () => {
  const c = describeActionConflicts(row());
  assert.ok(c.immediate, 'すでに購入できるのに「今すぐ販売可」が押せる状態のまま');
  assert.match(c.immediate, /すでに購入できる状態/);
});

test('【重要】停止中は「今すぐ販売可」より停止解除が先だと示す', () => {
  const c = describeActionConflicts(row({ salePaused: true, purchaseEnabled: false }));
  assert.match(c.immediate, /先に停止を解除/);
});

test('即時販売が既に適用済みなら重ねて制限しない（適用中表示に任せる）', () => {
  const c = describeActionConflicts(row({ overrideApplied: true }));
  assert.equal(c.immediate, undefined);
});

test('まだ購入できない会員には「今すぐ販売可」を通す（本来の用途）', () => {
  const c = describeActionConflicts(row({ phase: 2, purchaseEnabled: false }));
  assert.equal(c.immediate, undefined, '本来押すべき相手にまで制限をかけている');
});

test('【重要】状態 × 操作の全組み合わせで、要約と操作が逆を言わない', () => {
  const bad = [];
  for (const eligibility of ['eligible', 'review', 'blocked']) {
    for (const phase of [1, 2, 3, 4]) {
      for (const salePaused of [false, true]) {
        for (const overrideApplied of [false, true]) {
          for (const launch of ['not_started', 'live', 'incomplete', 'paused_after_start', 'unknown']) {
            // purchaseEnabled はサーバーが決める値。ここは「販売中かつ停止なしかつ資格あり」を再現
            const purchaseEnabled = eligibility === 'eligible' && !salePaused
              && (phase === 4 || overrideApplied);
            const r = row({
              eligibility, phase, salePaused, overrideApplied, purchaseEnabled,
              showProductPage: purchaseEnabled || phase >= 3,
              reopenLaunch: { state: launch },
            });
            const s = describeAdminStatusSummary(r);
            const c = describeActionConflicts(r);
            const says = itemOf(s, 'purchase').value;
            const canBuy = /いま購入できます/.test(says);

            // 1. 要約が「買える」なら、購入可にする操作は押させない
            if (canBuy && overrideApplied !== true && !c.immediate) {
              bad.push(`買えると書いたのに「今すぐ販売可」が押せる: ${eligibility}/P${phase}/paused=${salePaused}`);
            }
            // 2. 要約が「買えない」なら、購入可否の欄がそう言っている
            if (!canBuy && !/購入できません/.test(says)) {
              bad.push(`買えないのに購入可否が曖昧: ${says}`);
            }
            // 3. 停止中なら、停止の欄と購入可否が必ず一致する
            if (salePaused && !/停止中/.test(itemOf(s, 'pause').value)) {
              bad.push(`停止中なのに停止欄が「停止していません」: ${eligibility}/P${phase}`);
            }
            if (salePaused && canBuy) bad.push(`停止中なのに「買える」と書いている: ${eligibility}/P${phase}`);
            // 4. 見出しと購入可否の欄が食い違わない
            const headSaysBuy = /購入できる状態です/.test(s.headline);
            if (headSaysBuy !== canBuy) bad.push(`見出しと購入可否が逆: "${s.headline}" vs "${says}"`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [], `矛盾が残っている:\n  ${bad.join('\n  ')}`);
});

test('JST 変換（UTC 基準で 1 日ズレない）', () => {
  assert.equal(jstDate('2026-08-25T09:41:10.698Z'), '2026-08-25');
  assert.equal(jstDate('2026-08-24T15:30:00.000Z'), '2026-08-25', 'JST 深夜のズレを拾っていない');
  assert.equal(jstDateTime('2026-08-24T15:30:00.000Z'), '2026-08-25 00:30');
  assert.equal(jstDate('こわれた値'), '');
});


// ══ 2026-09-09 追加要件: 細かい文章を読まなくても運営できる ══════════

const CAPS = { salePauseWritable: true, overrideEnabled: true, couponWritable: true };
const LAUNCH_START = {
  state: 'not_started',
  action: { kind: 'start', label: '▶ クーポンの利用期間（14日）を開始する', enabled: true, note: '14日間の開始を確定します。' },
};

test('【要件】色分け用の短いバッジが出る（10文字前後・長文でない）', () => {
  const cases = [
    [{ phase: 4, purchaseEnabled: true }, '購入可能', 'ok'],
    [{ phase: 2, purchaseEnabled: false }, '段階表示中', 'warn'],
    [{ phase: 1, purchaseEnabled: false, salePaused: true }, '販売停止中', 'stop'],
    [{ purchaseEnabled: false, eligibility: 'blocked' }, '販売対象外', 'stop'],
    [{ purchaseEnabled: false, eligibility: 'review' }, '資格保留', 'warn'],
  ];
  for (const [over, badge, tone] of cases) {
    const s = describeAdminStatusSummary(row(over));
    assert.equal(s.badge, badge);
    assert.equal(s.tone, tone);
    assert.ok(s.badge.length <= 8, `バッジが長い: ${s.badge}`);
  }
});

test('【要件】段階表示は人間向け（何日目・残日数・購入可否）', () => {
  const at = new Date(Date.now() - 4 * 86400000).toISOString();   // 4 日前に資格確定
  assert.match(describeStageLine(row({ eligibleAt: at, phase: 2, purchaseEnabled: false })),
    /段階表示 5 日目 ・ 予告のみ表示中 ・ あと 2 日で商品ページ表示/);
  const at7 = new Date(Date.now() - 7 * 86400000).toISOString();
  assert.match(describeStageLine(row({ eligibleAt: at7, phase: 3, purchaseEnabled: false })),
    /商品ページ閲覧可・購入はまだ不可 ・ あと 3 日で購入可能/);
  assert.match(describeStageLine(row({ phase: 4, purchaseEnabled: true })), /購入可能（2026-09-04 から）/);
  assert.match(describeStageLine(row({ salePaused: true, purchaseEnabled: false })),
    /販売停止中（購入も閲覧もできません）/);
});

test('段階表示に内部用語（PHASE / override / eligibility）を出さない', () => {
  for (const over of [{ phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 4, purchaseEnabled: true },
    { salePaused: true }, { eligibility: 'review' }, { overrideApplied: true }]) {
    const line = describeStageLine(row(over));
    for (const w of ['PHASE', 'override', 'eligibility']) {
      assert.ok(!line.includes(w), `段階表示に内部用語 "${w}" が出ている: ${line}`);
    }
  }
});

test('日数は JST の暦日で数える（当日 = 0 日目）', () => {
  const t = Date.parse('2026-08-25T09:41:10.698Z');
  assert.equal(daysSinceJst('2026-08-25T09:41:10.698Z', t), 0);
  assert.equal(daysSinceJst('2026-08-25T09:41:10.698Z', t + 86400000), 1);
  assert.equal(daysSinceJst('', t), null);
});

// ── 販売状態はトグル 1 つ ────────────────────────────────────
test('【要件】販売中なら「販売中」ボタン、停止中なら「販売停止中」ボタン（トグル 1 つ）', () => {
  const selling = describeNextActions(row({ phase: 4, purchaseEnabled: true, reopenLaunch: LAUNCH_START }), CAPS);
  const t1 = selling.find((a) => a.key === 'salePauseToggle');
  assert.equal(t1.label, '販売中');
  assert.equal(t1.kind, 'pause');
  const paused = describeNextActions(row({ salePaused: true, purchaseEnabled: false, reopenLaunch: LAUNCH_START }), CAPS);
  const t2 = paused.find((a) => a.key === 'salePauseToggle');
  assert.equal(t2.label, '販売停止中');
  assert.equal(t2.kind, 'resume');
});

test('【要件】販売の切替は常に 1 つだけ（停止と再開を並べない）', () => {
  for (const salePaused of [false, true]) {
    for (const launch of ['not_started', 'live', 'incomplete', 'paused_after_start', 'unknown']) {
      const acts = describeNextActions(row({
        salePaused, purchaseEnabled: !salePaused, phase: salePaused ? 1 : 4,
        reopenLaunch: { state: launch, action: LAUNCH_START.action },
      }), CAPS);
      const toggles = acts.filter((a) => a.kind === 'pause' || a.kind === 'resume');
      assert.equal(toggles.length, 1, `販売切替ボタンが ${toggles.length} 個ある (paused=${salePaused}/${launch})`);
      // 停止中に「販売再開も同時に行う」クーポン期間ボタンを並べない
      if (salePaused) {
        assert.ok(!acts.some((a) => a.key === 'couponPeriod'),
          '停止中にクーポン期間の開始（販売再開も行う）が並んでいる');
      }
    }
  }
});

test('【要件】すでに購入できるなら「今すぐ販売可」を出さない', () => {
  const acts = describeNextActions(row({ phase: 4, purchaseEnabled: true, reopenLaunch: LAUNCH_START }), CAPS);
  assert.ok(!acts.some((a) => a.key === 'immediate'), '結果が変わらない操作が出ている');
});

test('まだ購入できないなら「今すぐ販売可」を出す（本来の用途）', () => {
  const acts = describeNextActions(row({ phase: 2, purchaseEnabled: false, reopenLaunch: LAUNCH_START }), CAPS);
  assert.ok(acts.some((a) => a.key === 'immediate'));
});

test('書込 gate が無ければ押させない（fail closed）', () => {
  // 販売トグル / 今すぐ販売可 の gate は呼び出し側が渡す caps
  const acts = describeNextActions(row({ phase: 2, purchaseEnabled: false, reopenLaunch: LAUNCH_START }),
    { salePauseWritable: false, overrideEnabled: false });
  for (const a of acts.filter((x) => x.key !== 'couponPeriod')) {
    assert.equal(a.enabled, false, `${a.key} が gate 無しで押せる`);
    assert.ok(a.reason, `${a.key} に押せない理由が無い`);
  }
  // クーポン期間の gate は**サーバーが action.enabled に入れて渡す**（二重に判定しない）
  const denied = describeNextActions(row({
    phase: 2, purchaseEnabled: false,
    reopenLaunch: { state: 'not_started', action: { ...LAUNCH_START.action, enabled: false } },
  }), CAPS).find((a) => a.key === 'couponPeriod');
  assert.equal(denied.enabled, false, 'サーバーが不可と言っているのに押せる');
  assert.ok(denied.reason, '押せない理由が無い');
});

test('クーポン期間の名称が販売再開と誤読されない', () => {
  const acts = describeNextActions(row({ phase: 4, purchaseEnabled: true, reopenLaunch: LAUNCH_START }), CAPS);
  const c = acts.find((a) => a.key === 'couponPeriod');
  assert.ok(c, 'クーポン期間の操作が出ていない');
  assert.match(c.label, /クーポンの利用期間/);
  assert.ok(!/再募集/.test(c.label), '「再募集」という誤読される名称が残っている');
});

test('【重要】状態の全組み合わせで、要約と大ボタンが矛盾しない', () => {
  const bad = [];
  for (const eligibility of ['eligible', 'review', 'blocked']) {
    for (const phase of [1, 2, 3, 4]) {
      for (const salePaused of [false, true]) {
        for (const overrideApplied of [false, true]) {
          for (const launch of ['not_started', 'live', 'incomplete', 'paused_after_start', 'unknown']) {
            const purchaseEnabled = eligibility === 'eligible' && !salePaused
              && (phase === 4 || overrideApplied);
            const r = row({
              eligibility, phase, salePaused, overrideApplied, purchaseEnabled,
              showProductPage: purchaseEnabled || phase >= 3,
              reopenLaunch: { state: launch, action: LAUNCH_START.action },
            });
            const s = describeAdminStatusSummary(r);
            const acts = describeNextActions(r, CAPS);
            const canBuy = s.badge === '購入可能';
            const tag = `${eligibility}/P${phase}/paused=${salePaused}/ovr=${overrideApplied}/${launch}`;

            // 1. 買えるのに「今すぐ販売可」を出していない
            if (canBuy && acts.some((a) => a.key === 'immediate')) {
              bad.push(`買えるのに「今すぐ販売可」が出ている: ${tag}`);
            }
            // 2. バッジと段階表示が食い違わない
            const stage = s.stageLine;
            if (canBuy && !/購入可能/.test(stage)) bad.push(`バッジ=購入可能 なのに段階が違う: ${stage} (${tag})`);
            if (salePaused && !/販売停止中/.test(stage)) bad.push(`停止中なのに段階が違う: ${stage} (${tag})`);
            if (salePaused && canBuy) bad.push(`停止中なのに購入可能: ${tag}`);
            // 3. 販売切替は必ず 1 つ、ラベルは現状を表す
            const toggles = acts.filter((a) => a.kind === 'pause' || a.kind === 'resume');
            if (toggles.length !== 1) bad.push(`販売切替が ${toggles.length} 個: ${tag}`);
            else if ((toggles[0].label === '販売停止中') !== salePaused) {
              bad.push(`トグルのラベルが現状と逆: ${toggles[0].label} (${tag})`);
            }
            // 4. 押せない操作には必ず理由がある
            for (const a of acts) {
              if (a.enabled !== true && !a.reason) bad.push(`理由なしで押せない: ${a.key} (${tag})`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(bad, [], `矛盾が残っている:\n  ${bad.join('\n  ')}`);
});


test('【要件】上部の主表示に内部用語（PHASE / override / eligibility）を出さない', () => {
  for (const over of [{ phase: 1 }, { phase: 2 }, { phase: 3 }, { phase: 4, purchaseEnabled: true },
    { salePaused: true }, { eligibility: 'review' }, { eligibility: 'blocked' }, { overrideApplied: true }]) {
    const s = describeAdminStatusSummary(row(over));
    const shown = [s.headline, s.badge, s.stageLine,
      ...s.items.flatMap((i) => [i.label, i.value])].join(' ');
    for (const w of ['PHASE', 'override', 'eligibility']) {
      assert.ok(!shown.includes(w), `主表示に内部用語 "${w}" が出ている: ${shown.slice(0, 120)}`);
    }
    assert.ok(!shown.includes('再募集'), `主表示に誤読語「再募集」が出ている`);
  }
});

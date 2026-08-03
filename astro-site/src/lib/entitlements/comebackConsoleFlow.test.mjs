/**
 * comebackConsoleFlow.test.mjs — カムバック特典タブの操作順
 *
 * 「誰に配るか」を間違えた付与は、あとから取り消すと不信を招く。
 * 順序（探す → 選ぶ → 決める → 確認する → 付与する）と
 * **現有効会員を既定で対象にしない**ことを、画面ではなくここで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CB_STEP, CB_CONTRACT_OPTIONS, CANDIDATE_SEGMENTS, ACTIVE_FILTER_WARNING,
  UNCHANGED_NOTICE, APPLY_EFFECT_NOTICE,
  describeContractFilter, canSelectRow, hasOfferSelection, describeOfferSelection,
  resolveCbStep, canSelectCustomers, canConfigureOffer, canReview, canApply,
  computeCbFingerprint, isCbDryStale, buildCbStickyView, segmentLabel,
} from './comebackConsoleFlow.js';
import { SEGMENT } from './comebackAudience.js';

const offer = { lightOffer: 'light_lifetime', premiumOffer: 'none' };
const base = (over = {}) => ({
  loaded: true, selectedCount: 3, offer, candidateCount: 42,
  dryRun: null, dryStale: false, applied: false, busy: false, ...over,
});
const dryOk = { willGrant: 3, activeMembers: 0, fingerprint: 'fp' };

// ── 契約状態の表現 ──────────────────────────────────────────
test('契約状態はカムバックの言葉で出す（「有効」ではなく注意書きつき）', () => {
  const values = CB_CONTRACT_OPTIONS.map((o) => o.value);
  assert.deepEqual(values, ['candidates', 'expired', 'withdrawn', 'dormant', 'none', 'unknown', 'active']);
  const active = CB_CONTRACT_OPTIONS.find((o) => o.value === 'active');
  assert.equal(active.label, '現在有効な会員（通常は選択しない）');
  assert.equal(active.danger, true, '警告色にする指定が無い');
  assert.equal(CB_CONTRACT_OPTIONS[0].label, 'カムバック候補すべて');
});

test('「カムバック候補すべて」に現有効会員を含めない', () => {
  assert.deepEqual([...CANDIDATE_SEGMENTS], [SEGMENT.EXPIRED, SEGMENT.WITHDRAWN, SEGMENT.DORMANT]);
  assert.equal(CANDIDATE_SEGMENTS.includes(SEGMENT.ACTIVE_MEMBER), false);
  assert.match(describeContractFilter('candidates'), /現有効会員は除外します/);
});

test('現有効会員を選んだときは通常の対象でないと伝える', () => {
  assert.match(describeContractFilter('active'), /通常のカムバック施策では使用しません/);
  assert.match(ACTIVE_FILTER_WARNING, /特別な理由がある場合のみ/);
});

// ── 行の選択可否 ────────────────────────────────────────────
test('現有効会員と状態不明は既定で選べない（理由つき）', () => {
  const a = canSelectRow({ segment: SEGMENT.ACTIVE_MEMBER });
  assert.equal(a.selectable, false);
  assert.equal(a.reason, '現在有効な会員のため通常対象外');
  const u = canSelectRow({ segment: SEGMENT.UNKNOWN });
  assert.equal(u.selectable, false);
  assert.equal(u.reason, '契約状態を確定できないため対象外');
});

test('期限切れ・退会・休眠は選べる', () => {
  for (const seg of CANDIDATE_SEGMENTS) {
    assert.equal(canSelectRow({ segment: seg }).selectable, true, `${seg} が選べない`);
  }
});

test('付与できない状態の行も選べない', () => {
  assert.equal(canSelectRow({ segment: SEGMENT.EXPIRED, grantable: false }).selectable, false);
});

test('明示許可があれば現有効会員も選べる（既定ではない）', () => {
  assert.equal(canSelectRow({ segment: SEGMENT.ACTIVE_MEMBER, includeActiveMembers: true }).selectable, true);
});

// ── 段階の強制 ──────────────────────────────────────────────
test('Step 1 の取得前は Step 2 以降を触れない', () => {
  const s = base({ loaded: false, selectedCount: 0 });
  assert.equal(resolveCbStep(s), CB_STEP.FIND);
  assert.match(canSelectCustomers(s).reason, /対象候補を表示/);
  assert.equal(canConfigureOffer(s).allowed, false);
  assert.equal(canReview(s).allowed, false);
  assert.equal(canApply(s).allowed, false);
});

test('0 名選択では特典設定へ進めない', () => {
  const s = base({ selectedCount: 0 });
  assert.equal(resolveCbStep(s), CB_STEP.SELECT);
  assert.match(canConfigureOffer(s).reason, /1 名以上/);
});

test('特典未設定では確認へ進めない', () => {
  const s = base({ offer: { lightOffer: 'none', premiumOffer: 'none' } });
  assert.equal(hasOfferSelection(s.offer), false);
  assert.equal(resolveCbStep(s), CB_STEP.OFFER);
  assert.match(canReview(s).reason, /特典を選んで/);
});

test('確認前は実行できない', () => {
  const s = base();
  assert.equal(resolveCbStep(s), CB_STEP.REVIEW);
  assert.match(canApply(s).reason, /付与内容を確認/);
});

test('確認できれば実行へ進める', () => {
  const s = base({ dryRun: dryOk });
  assert.equal(resolveCbStep(s), CB_STEP.APPLY);
  assert.deepEqual(canApply(s), { allowed: true, reason: null });
});

test('現有効会員が混ざっていれば実行できない', () => {
  const s = base({ dryRun: { ...dryOk, activeMembers: 2 } });
  assert.match(canApply(s).reason, /現在有効な会員が含まれています/);
});

test('付与対象 0 名では実行できない', () => {
  const s = base({ dryRun: { ...dryOk, willGrant: 0 } });
  assert.match(canApply(s).reason, /付与される顧客がいません/);
});

test('実行中はどの操作も進めない', () => {
  const s = base({ busy: true, dryRun: dryOk });
  for (const fn of [canSelectCustomers, canConfigureOffer, canReview, canApply]) {
    assert.equal(fn(s).allowed, false);
  }
});

// ── 確認結果の失効 ──────────────────────────────────────────
const current = { filters: { contract: 'candidates' }, selectedIds: ['a', 'b'], offer };
test('条件・選択・特典のどれが変わっても確認結果は失効する', () => {
  const fp = computeCbFingerprint(current);
  const dry = { ...dryOk, fingerprint: fp };
  assert.equal(isCbDryStale({ dryRun: dry, current }), false);
  assert.equal(isCbDryStale({ dryRun: dry, current: { ...current, filters: { contract: 'expired' } } }), true, '条件変更で失効しない');
  assert.equal(isCbDryStale({ dryRun: dry, current: { ...current, selectedIds: ['a'] } }), true, '選択変更で失効しない');
  assert.equal(isCbDryStale({ dryRun: dry, current: { ...current, offer: { lightOffer: 'light_30d' } } }), true, '特典変更で失効しない');
  assert.equal(isCbDryStale({ dryRun: dry, current: { ...current, selectedIds: ['b', 'a'] } }), false, '並び順で失効している');
});

test('失効した確認結果では実行できない（再確認を促す）', () => {
  const s = base({ dryRun: dryOk, dryStale: true });
  assert.match(canApply(s).reason, /もう一度確認してください/);
});

// ── 平文の要約 ──────────────────────────────────────────────
test('特典の内容を平文で要約する（内部用語を使わない）', () => {
  const t = describeOfferSelection({ count: 12, lightLabel: 'Light 永久無料', premiumLabel: '' });
  assert.equal(t, '選択した 12 名へ、Light 永久無料を付与します。Premium 特典は付与しません。');
  assert.equal(t.includes('ベース'), false);
  assert.equal(t.includes('上位・任意'), false);
  assert.match(describeOfferSelection({ count: 1 }), /特典が選ばれていません/);
});

// ── 追従バー ────────────────────────────────────────────────
test('追従バーは候補・選択・特典・確認と「次の操作 1 つ」を出す', () => {
  const v = buildCbStickyView(base({ offerSummaryShort: 'Light 永久無料 / Premium なし' }));
  assert.match(v.left, /候補 42 名 \/ 選択 3 名/);
  assert.match(v.offer, /Light 永久無料/);
  assert.equal(v.review, '確認: 未確認');
  assert.equal(v.next, '付与内容を確認');
  assert.equal(buildCbStickyView(base({ loaded: false, selectedCount: 0 })).next, '対象候補を表示');
  assert.equal(buildCbStickyView(base({ selectedCount: 0 })).next, '顧客を選択');
  // 追従バーは**確認画面を開くだけ**。Step 5 本体と同じ文言でなければならない
  assert.equal(buildCbStickyView(base({ dryRun: dryOk })).next, '付与内容の最終確認へ');
  assert.equal(buildCbStickyView(base({ dryRun: dryOk, applied: true })).next, '付与結果を見る');
  assert.equal(buildCbStickyView(base({ dryRun: dryOk, dryStale: true })).review, '確認: 失効');
});

// ── 必ず出す注意 ────────────────────────────────────────────
test('変更しないもの・実行の影響を必ず伝える', () => {
  assert.match(UNCHANGED_NOTICE, /プラン・課金状態・入金状態・Premium Plus 販売資格・メール設定は変更しません/);
  assert.match(APPLY_EFFECT_NOTICE, /閲覧権限が変わります/);
  assert.match(APPLY_EFFECT_NOTICE, /メールは送信されません/);
});

test('区分の表示名が引ける', () => {
  assert.equal(segmentLabel(SEGMENT.EXPIRED), '期限切れ');
  assert.equal(segmentLabel(SEGMENT.ACTIVE_MEMBER), '現有効会員');
  assert.equal(segmentLabel('なにか'), '状態不明');
});

test('追従バーの次操作は本番付与を名乗らない（確認画面を開くだけ）', () => {
  const next = buildCbStickyView(base({ dryRun: dryOk })).next;
  // 「付与する」と確定形で名乗ってよいのは確認モーダルの最終ボタンだけ
  assert.equal(/付与する$/.test(next), false, `追従バーが本番付与を名乗っている: ${next}`);
  assert.match(next, /最終確認/, '確認画面を開くことが伝わらない');
});

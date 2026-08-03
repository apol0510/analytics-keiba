/**
 * filterDefinitions.test.mjs — 絞り込みの表示名・説明が「利用者に分かる言葉」であること
 *
 * ここで守るのは 3 点。
 *   1. すべての項目・選択肢に**表示名と説明**がある
 *   2. **内部コードをそのまま画面へ出さない**
 *   3. API の許可値と定義がズレない（説明の無い選択肢を作らない）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTER_DEFINITIONS, FILTER_IDS, EMAIL_SEARCH, ADVANCED_FILTERS,
  getFilterDefinition, getOptionDefinition, optionLabel, optionLabelMap, optionValues,
  diffAgainstAllowed, auditDefinitions, findForbiddenWords,
} from './filterDefinitions.js';
import * as defsModule from './filterDefinitions.js';
import { FREE_GRANT_NOW_VALUES, FREE_GRANT_HISTORY_VALUES } from '../entitlements/freeGrantStatus.js';
import { GRANT_ELIGIBILITY_VALUES } from '../entitlements/grantEligibility.js';

test('すべての項目・選択肢に表示名と説明がある', () => {
  const a = auditDefinitions();
  assert.equal(a.ok, true, a.problems.join(' / '));
  assert.ok(FILTER_IDS.length >= 17, `項目数が少ない: ${FILTER_IDS.length}`);
});

test('説明は 1 文で、意味が推測不要な日本語になっている', () => {
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    assert.ok(d.description.length >= 10, `${id}: 説明が短すぎる`);
    assert.ok(d.description.endsWith('。'), `${id}: 説明が文になっていない`);
    for (const o of d.options) {
      assert.ok(o.description.endsWith('。'), `${id}.${o.value}: 説明が文になっていない`);
    }
  }
});

test('内部コードをそのまま表示名にしていない', () => {
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    assert.deepEqual(findForbiddenWords(d.label), [], `${id}: 項目名に内部語`);
    for (const o of d.options) {
      const bad = findForbiddenWords(o.label);
      assert.deepEqual(bad, [], `${id}.${o.value}: 表示名に内部語 ${bad.join(',')}`);
      // コード値がそのまま表示名になっていない
      assert.notEqual(o.label, o.value, `${id}.${o.value}: コード値をそのまま出している`);
    }
  }
});

test('指摘された文言が置き換わっている', () => {
  // オファーは「状態（排他）」と「残り期間（追加条件）」の 2 軸へ分けた
  assert.equal(optionLabel('mkOfferState', 'live'), '現在申込みに使えるオファーあり');
  assert.equal(optionLabel('mkOfferWindow', 'within7'), '利用期限まで7日以内');
  assert.equal(optionValues('mkOfferState').includes('expiring7'), false, '部分集合が状態に残っている');
  assert.equal(optionLabel('mkContract', 'unknown'), '状態を判定できない旧データ');
  assert.equal(optionLabel('mkPromoState', 'active'), '無料利用権が有効');
  assert.equal(optionLabel('mkPp', 'eligible'), '販売できる');
  assert.equal(optionLabel('mkPp', 'blocked'), '販売対象外');
  assert.equal(optionLabel('mkPp', 'review'), '保留（確認待ち）');
  assert.equal(optionLabel('mkSendable', 'sendable'), '送信できる');
  assert.equal(optionLabel('mkFrequency', 'blocked'), '24時間の間隔制限中');
});

test('指定された説明文が入っている', () => {
  assert.equal(getFilterDefinition('mkContract').description, '現在の契約や有効期限の状態で顧客を絞り込みます。');
  assert.equal(getFilterDefinition('mkPlan').description, '顧客に登録されている会員プランで絞り込みます。');
  assert.match(getFilterDefinition('mkSendable').description, /バウンス・ブラックリスト/);
  assert.match(getFilterDefinition('mkPp').description, /会員プランとは別判定/);
  assert.match(getFilterDefinition('mkOfferState').description, /いまどうなっているか/);
  assert.match(getFilterDefinition('mkOfferWindow').description, /さらに絞り込みます/);
  assert.match(getFilterDefinition('cbGrantNow').description, /現在有効な Light または Premium/);
  assert.match(getFilterDefinition('cbGrantHistory').description, /付与・終了・取消した記録/);
  assert.match(getFilterDefinition('mkLastLogin').description, /最終ログインからの経過期間/);
  assert.match(getFilterDefinition('cbGrantable').description, /今回の付与操作が可能か/);
  assert.match(getOptionDefinition('mkOfferState', 'live').description, /顧客がいま申込みに使えます/);
  assert.match(getOptionDefinition('mkOfferWindow', 'within7').description, /7 日以内に終了します/);
  assert.match(getOptionDefinition('mkContract', 'unknown').description, /送信前に個別確認/);
});

test('API の許可値と定義がズレていない（説明の無い選択肢を作らない）', () => {
  const cases = [
    ['cbGrantNow', FREE_GRANT_NOW_VALUES],
    ['cbGrantHistory', FREE_GRANT_HISTORY_VALUES],
    ['cbGrantable', GRANT_ELIGIBILITY_VALUES],
  ];
  for (const [id, allowed] of cases) {
    const d = diffAgainstAllowed(id, allowed);
    assert.deepEqual(d.missingInDefinition, [], `${id}: 説明の無い許可値`);
    assert.deepEqual(d.missingInApi, [], `${id}: API に無い選択肢`);
  }
});

test('チップ・条件要約に使うラベル表が定義と一致する', () => {
  const map = optionLabelMap('mkOfferState');
  assert.equal(map.live, '現在申込みに使えるオファーあり');
  assert.deepEqual(Object.keys(map), optionValues('mkOfferState'));
});

test('未定義の項目・値は言い換えない（勝手な文言を作らない）', () => {
  assert.equal(getFilterDefinition('does-not-exist'), null);
  assert.equal(optionLabel('does-not-exist', 'x'), 'x');
  assert.equal(optionLabel('mkPlan', 'not-a-value'), 'not-a-value');
});

test('Email 個別検索と詳細条件の文言', () => {
  assert.equal(EMAIL_SEARCH.description, '特定の顧客をメールアドレスで探す場合だけ使用します。');
  assert.equal(EMAIL_SEARCH.activeBadge, 'Email 条件あり');
  assert.equal(ADVANCED_FILTERS.summary, '詳細な絞り込み条件');
  assert.match(ADVANCED_FILTERS.hint, /送信履歴・オファー・無料付与・最終ログイン/);
});

test('3 タブすべての絞り込みに定義がある', () => {
  const mk = ['mkContract', 'mkPlan', 'mkSendable', 'mkPp', 'mkHistory',
    'mkOfferState', 'mkOfferWindow', 'mkPromoState', 'mkFrequency', 'mkLastLogin'];
  const cb = ['cbContract', 'cbPlan', 'cbWithdrawn', 'cbGrantNow', 'cbGrantHistory', 'cbGrantable', 'cbHistory'];
  const sales = ['fState', 'fRoute', 'fKind', 'fUpsell'];
  for (const id of [...mk, ...cb, ...sales]) {
    assert.ok(getFilterDefinition(id), `${id} の定義が無い`);
  }
});

/* ── 棚卸し・分類・条件関係（2026-08-03）───────────────────────── */

test('全フィルターに分類（現在状態 / 履歴 / 追加条件 / 操作可否）がある', () => {
  const { FILTER_CATEGORY, categoryLabel } = defsModule;
  const valid = new Set(Object.values(FILTER_CATEGORY));
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    assert.ok(valid.has(d.category), `${id}: 分類が無い`);
    assert.ok(categoryLabel(id), `${id}: 分類の表示名が無い`);
  }
});

test('現在状態・履歴・操作可否が混在していない', () => {
  const { FILTER_CATEGORY } = defsModule;
  assert.equal(FILTER_DEFINITIONS.cbGrantNow.category, FILTER_CATEGORY.STATE);
  assert.equal(FILTER_DEFINITIONS.cbGrantHistory.category, FILTER_CATEGORY.HISTORY);
  assert.equal(FILTER_DEFINITIONS.cbGrantable.category, FILTER_CATEGORY.ACTION);
  assert.equal(FILTER_DEFINITIONS.mkOfferState.category, FILTER_CATEGORY.STATE);
  assert.equal(FILTER_DEFINITIONS.mkOfferWindow.category, FILTER_CATEGORY.EXTRA);
  assert.equal(FILTER_DEFINITIONS.mkLastLogin.category, FILTER_CATEGORY.EXTRA);
});

test('同じ項目内に同じ意味の選択肢が重複していない', () => {
  for (const [id, d] of Object.entries(FILTER_DEFINITIONS)) {
    const labels = d.options.map((o) => o.label);
    assert.equal(new Set(labels).size, labels.length, `${id}: 同じ表示名の選択肢がある`);
    const values = d.options.map((o) => o.value);
    assert.equal(new Set(values).size, values.length, `${id}: 同じ値の選択肢がある`);
  }
});

test('部分集合の関係にある条件は別フィルターへ分けている', () => {
  const { dependencyOf } = defsModule;
  const dep = dependencyOf('mkOfferWindow');
  assert.ok(dep, '残り期間の依存関係が定義されていない');
  assert.equal(dep.filterId, 'mkOfferState');
  assert.equal(dep.value, 'live');
  assert.match(dep.note, /さらに絞り込めます/);
  // 状態の側に部分集合（旧 expiring7）が残っていない
  assert.equal(optionValues('mkOfferState').includes('expiring7'), false);
});

test('矛盾する組合せを取得前に検出できる', () => {
  const { detectImpossibleCombination } = defsModule;
  const bad = detectImpossibleCombination({ mkOfferState: ['none'], mkOfferWindow: ['within7'] });
  assert.equal(bad.length, 1);
  assert.match(bad[0].message, /この条件の組合せでは対象が存在しません/);
  assert.deepEqual(detectImpossibleCombination({ mkOfferState: ['live'], mkOfferWindow: ['within7'] }), []);
  assert.deepEqual(detectImpossibleCombination({ mkOfferWindow: ['within7'] }), [], '状態未指定は矛盾にしない');
});

test('条件要約は自然文で、種類ごとにまとまっている', () => {
  const { describeConditionsNatural } = defsModule;
  const text = describeConditionsNatural({
    mkContract: ['expired'], mkPlan: ['premium'],
    mkOfferState: ['live'], mkOfferWindow: ['within7'], mkHistory: ['sent'],
  });
  assert.match(text, /期限切れ/);
  assert.match(text, /現在申込みに使えるオファーあり/);
  assert.match(text, /利用期限まで7日以内/);
  assert.match(text, /の顧客を検索します。$/);
  assert.equal(describeConditionsNatural({}), '条件を指定していません（すべての顧客が対象です）。');
});

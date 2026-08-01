/**
 * campaignPlanView.test.mjs — 実行前確認（対象者・除外者・理由）の組み立て
 *   node --test src/lib/marketing/campaignPlanView.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanView,
  updateSelection,
  offscreenSelection,
  labelFor,
  isKnownReason,
  EXCLUSION_LABEL,
  PLAN_KIND,
} from './campaignPlanView.js';

const NOW = Date.parse('2026-08-01T06:00:00.000Z');

const row = (id, over = {}) => [id, {
  recordId: id, name: `氏名${id}`, email: `${id}@example.com`,
  contract: 'expired', planGroup: 'premium', sendable: true,
  lastLoginAt: '2026-07-01T00:00:00.000Z', daysSinceLogin: 31,
  liveOfferCount: 1, promoActive: false, nextSendableAt: null,
  access: { free: true, light: false, premium: false, sanrenpuku: false },
  ...over,
}];
const rowsById = new Map([row('rec1'), row('rec2'), row('rec3')]);

// =========================================================================
// 選択（recordId が正本 / 表示中だけ）
// =========================================================================

test('#1 #2 1名・複数名の選択を recordId で保持する', () => {
  let sel = updateSelection({ current: new Set(), op: 'toggle', id: 'rec1' });
  assert.deepEqual([...sel], ['rec1']);
  sel = updateSelection({ current: sel, op: 'toggle', id: 'rec2' });
  assert.deepEqual([...sel].sort(), ['rec1', 'rec2']);
});

test('#3 「表示中のみ全選択」は表示中の recordId しか足さない', () => {
  const sel = updateSelection({ current: new Set(['rec9']), visibleIds: ['rec1', 'rec2'], op: 'add-visible' });
  assert.deepEqual([...sel].sort(), ['rec1', 'rec2', 'rec9'], '既存選択を消している/表示外を足している');
});

test('#3b 選択できない相手（送信不可など）は全選択で足さない', () => {
  const sel = updateSelection({
    current: new Set(), visibleIds: ['rec1', 'rec2', 'rec3'], op: 'add-visible',
    selectableIds: ['rec1', 'rec3'],
  });
  assert.deepEqual([...sel].sort(), ['rec1', 'rec3']);
});

test('#4 選択解除は全部消す', () => {
  assert.equal(updateSelection({ current: new Set(['rec1', 'rec2']), op: 'clear' }).size, 0);
});

test('#5 絞り込みを変えても選択は増えない（表示が変わるだけ）', () => {
  const before = new Set(['rec1']);
  // 絞り込み変更 = visibleIds が変わるだけ。op を呼ばなければ選択は不変
  const after = updateSelection({ current: before, visibleIds: ['rec5', 'rec6'], op: 'noop' });
  assert.deepEqual([...after], ['rec1']);
  // 画面外の選択は数えられる（管理者へ知らせるため）
  assert.deepEqual(offscreenSelection({ current: after, visibleIds: ['rec5', 'rec6'] }), ['rec1']);
});

test('#6 メールアドレスを識別子にしない（同一アドレスでも recordId で区別）', () => {
  const dup = new Map([
    row('recA', { email: 'same@example.com' }),
    row('recB', { email: 'same@example.com' }),
  ]);
  const view = buildPlanView({
    kind: PLAN_KIND.CAMPAIGN, selectedIds: ['recA', 'recB'], rowsById: dup, nowMs: NOW,
    result: { campaignId: 'c', version: 2, willSend: 1, excluded: 1, excludedRecords: [{ recordId: 'recB', reason: 'duplicate' }] },
  });
  assert.equal(view.included.length, 1);
  assert.equal(view.included[0].recordId, 'recA');
  assert.equal(view.excluded[0].recordId, 'recB');
});

// =========================================================================
// 対象者・除外者・理由
// =========================================================================

const campaignResult = {
  campaignId: 'expired-comeback', campaignName: 'カムバック案内', version: 2,
  subject: '【KEIBA Analytics】ご案内', sideEffects: 'none',
  planFingerprint: 'abc123def456', willSend: 1, excluded: 2,
  excludedRecords: [
    { recordId: 'rec2', reason: 'already_delivered' },
    { recordId: 'rec3', reason: 'recent_marketing_contact' },
  ],
};

test('#7 対象者と除外者を分けて返す', () => {
  const v = buildPlanView({ kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, result: campaignResult, nowMs: NOW });
  assert.deepEqual(v.included.map((x) => x.recordId), ['rec1']);
  assert.deepEqual(v.excluded.map((x) => x.recordId), ['rec2', 'rec3']);
  // 対象者には判断材料が付く
  const p = v.included[0];
  for (const k of ['name', 'email', 'contract', 'plan', 'lastLoginAt', 'sendable', 'liveOfferCount', 'nextSendableAt']) {
    assert.ok(k in p, `${k} が無い`);
  }
});

test('#8 除外理由を集計と明細の両方で返す（日本語つき）', () => {
  const v = buildPlanView({ kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, result: campaignResult, nowMs: NOW });
  assert.deepEqual(v.reasonSummary.map((s) => s.code).sort(), ['already_delivered', 'recent_marketing_contact']);
  assert.equal(v.reasonSummary.every((s) => s.count === 1), true);
  assert.equal(v.excluded[0].reasonLabel, '送信済み（同一キャンペーン）');
  assert.equal(v.excluded[1].reasonLabel, '最近マーケティング送信済み（24時間以内）');
});

test('#9 未知の理由コードがあれば実行不可（fail closed）', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2'], rowsById, nowMs: NOW,
    result: { ...campaignResult, willSend: 1, excluded: 1, excludedRecords: [{ recordId: 'rec2', reason: 'weird_new_code' }] },
  });
  assert.equal(v.executable, false, '未知コードなのに実行可能にしている');
  assert.match(v.blockers.join(' '), /未知の除外理由/);
  assert.equal(v.excluded[0].known, false);
  assert.match(v.excluded[0].reasonLabel, /未知の理由コード: weird_new_code/);
});

test('#10 選択件数と dry-run 件数が合わなければ実行不可', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, nowMs: NOW,
    result: { ...campaignResult, willSend: 1, excluded: 1, excludedRecords: [{ recordId: 'rec2', reason: 'duplicate' }] },
  });
  assert.equal(v.executable, false);
  assert.match(v.blockers.join(' '), /件数が合いません/);
});

test('対象 0 名なら実行不可として知らせる', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1'], rowsById, nowMs: NOW,
    result: { ...campaignResult, willSend: 0, excluded: 1, excludedRecords: [{ recordId: 'rec1', reason: 'already_delivered' }] },
  });
  assert.equal(v.executable, false);
  assert.match(v.blockers.join(' '), /対象が 0 名/);
});

test('#11 #12 campaignId / version / subject / 識別子を返す', () => {
  const v = buildPlanView({ kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, result: campaignResult, nowMs: NOW });
  assert.equal(v.campaignId, 'expired-comeback');
  assert.equal(v.version, 2);
  assert.equal(v.subject, '【KEIBA Analytics】ご案内');
  assert.equal(v.planFingerprint, 'abc123def456');
  assert.match(v.title, /カムバック案内（v2）/);
});

test('#13 rollback 方法を必ず返す', () => {
  const mail = buildPlanView({ kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, result: campaignResult, nowMs: NOW });
  assert.ok(mail.rollback.length >= 2);
  assert.match(mail.rollback.join(' '), /送信済みメールは取り消せません/);

  const grant = buildPlanView({
    kind: PLAN_KIND.GRANT_OFFER, selectedIds: ['rec1'], rowsById, nowMs: NOW,
    result: { selection: 'Light 30日間 無料', willGrant: 1, willOffer: 0, skipped: 0, operationId: 'cb-light-30d-free-2026-08-01-abc', sideEffects: 'none' },
  });
  assert.match(grant.rollback.join(' '), /取り消せます/);
  assert.match(grant.rollback.join(' '), /cb-light-30d-free-2026-08-01-abc/);
  assert.equal(grant.operationId, 'cb-light-30d-free-2026-08-01-abc');
});

test('特典・オファーの dry-run（skippedDetail / partSkips）も扱える', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.GRANT_OFFER, selectedIds: ['rec1', 'rec2'], rowsById, nowMs: NOW,
    result: {
      selection: 'Premium 年額 50%OFF', willGrant: 0, willOffer: 1, skipped: 1,
      operationId: 'cb-premium-annual-half-2026-08-01-xyz',
      skippedDetail: [{ recordId: 'rec2', reason: 'already_offered' }],
      parts: { partSkips: {} },
      purchaseOffer: { offerId: 'premium-annual-half', regularPrice: 49800, offerPrice: 24900 },
      sideEffects: 'none',
    },
  });
  assert.equal(v.includedCount, 1);
  assert.equal(v.excludedCount, 1);
  assert.equal(v.excluded[0].reasonLabel, '有効な割引オファーを既に保有');
  assert.equal(v.offer.offerPrice, 24900);
  assert.equal(v.executable, true);
});

test('明細が無く集計だけの API 応答でも壊れない（detailAvailable=false）', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2'], rowsById, nowMs: NOW,
    result: { ...campaignResult, willSend: 1, excluded: 1, excludedRecords: undefined, excludedDetail: [{ reason: 'already_delivered', label: 'x', count: 1 }] },
  });
  assert.equal(v.detailAvailable, false, '明細が無いのに「ある」と言っている');
  assert.equal(v.reasonSummary[0].count, 1);
  assert.equal(v.includedCount, 1);
  assert.equal(v.executable, true, '集計だけでも実行可否は判断できる');
});

test('#20 機微値を持ち出さない', () => {
  const v = buildPlanView({
    kind: PLAN_KIND.GRANT_OFFER, selectedIds: ['rec1'], rowsById, nowMs: NOW,
    result: {
      selection: 'x', willGrant: 1, willOffer: 0, skipped: 0, sideEffects: 'none',
      operationId: 'op1', offerKey: 'OK_SECRET', tokenHash: 'HASH_SECRET', token: 'RAW_TOKEN',
    },
  });
  const dump = JSON.stringify(v);
  for (const s of ['OK_SECRET', 'HASH_SECRET', 'RAW_TOKEN', 'OfferKey', 'TokenHash']) {
    assert.equal(dump.includes(s), false, `${s} が確認画面へ漏れている`);
  }
});

test('sideEffects は API の値をそのまま出す（dry-run は none）', () => {
  const v = buildPlanView({ kind: PLAN_KIND.CAMPAIGN, selectedIds: ['rec1', 'rec2', 'rec3'], rowsById, result: campaignResult, nowMs: NOW });
  assert.equal(v.sideEffects, 'none');
  assert.match(v.warning, /まだ本番は変更されていません/);
});

test('API がラベルを返したらそれを優先する（サーバーが単一源）', () => {
  assert.equal(labelFor('already_delivered', 'サーバー側の文言'), 'サーバー側の文言');
  assert.equal(isKnownReason('brand_new_code', 'サーバーが付けたラベル'), true, 'API がラベルを付けたのに未知扱いしている');
  // ラベルが無ければローカル表 → それも無ければ未知
  assert.equal(labelFor('offer_missing'), '有効な割引オファーが発行されていない');
  assert.equal(labelFor('totally_new'), '未知の理由コード: totally_new');
  assert.equal(isKnownReason('totally_new'), false);
  assert.equal(labelFor(''), '理由不明');
});

test('サーバー側の除外コードをローカル表が取りこぼしていない（ドリフト検知）', async () => {
  // このモジュールはブラウザで動くため campaignSend.js を import できない。
  // 代わりに **テスト（node 実行）で突き合わせ**、サーバー側にコードが増えたら落とす。
  const { MK_EXCLUSION_LABEL } = await import('./campaignSend.js');
  const missing = Object.keys(MK_EXCLUSION_LABEL).filter((code) => !EXCLUSION_LABEL[code]);
  assert.deepEqual(missing, [],
    `サーバー側の除外コードが画面のラベル表に無い: ${missing.join(', ')}（campaignPlanView.js の EXCLUSION_LABEL に追加してください）`);
});

test('ブラウザで動かせる（node 専用モジュールを import しない）', async () => {
  const raw = await import('node:fs').then((fs2) => fs2.readFileSync(new URL('./campaignPlanView.js', import.meta.url), 'utf8'));
  // コメント中の説明（『node:crypto に依存するため import しない』等）に反応しないよう除去する
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/from '\.\/campaignSend\.js'/.test(src), false, 'node:crypto に依存する campaignSend を import している');
  assert.equal(/node:crypto|node:fs|node:path/.test(src), false, 'node 専用モジュールを import している');
});

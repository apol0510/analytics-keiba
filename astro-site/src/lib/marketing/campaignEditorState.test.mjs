/**
 * campaignEditorState.test.mjs — 「確認した文面だけが送れる」ことの検証
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isContentConfirmed, acceptConfirmation, canSendContent, buildSendSummary,
  SEND_BLOCK, CONTENT_CHANGED_NOTICE,
} from './campaignEditorState.js';

const CAMPAIGN = { campaignId: 'expired-comeback', version: 2, name: 'カムバック', testOnly: false };
const DRAFT = { subject: '件名A', body: '{{salutation}}\n\n本文A' };

const confirmedOf = (draft) => acceptConfirmation({
  draft, contentHash: 'abcdef0123456789', planFingerprint: 'f'.repeat(64),
});

test('確認していなければ送れない', () => {
  const v = canSendContent({ campaign: CAMPAIGN, draftValid: true, draft: DRAFT, confirmed: null });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, SEND_BLOCK.NOT_CONFIRMED);
});

test('確認した文面と同じなら送れる', () => {
  const v = canSendContent({ campaign: CAMPAIGN, draftValid: true, draft: DRAFT, confirmed: confirmedOf(DRAFT) });
  assert.equal(v.allowed, true);
});

test('件名を変えたら送れない（文面変更で失効）', () => {
  const confirmed = confirmedOf(DRAFT);
  const v = canSendContent({
    campaign: CAMPAIGN, draftValid: true, confirmed,
    draft: { ...DRAFT, subject: '件名B' },
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, SEND_BLOCK.CONTENT_CHANGED);
});

test('本文を変えたら送れない（文面変更で失効）', () => {
  const confirmed = confirmedOf(DRAFT);
  const v = canSendContent({
    campaign: CAMPAIGN, draftValid: true, confirmed,
    draft: { ...DRAFT, body: '{{salutation}}\n\n本文B' },
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, SEND_BLOCK.CONTENT_CHANGED);
  assert.match(CONTENT_CHANGED_NOTICE, /もう一度確認/);
});

test('見た目が同じ差分（行末空白・改行コード）では失効しない', () => {
  const confirmed = confirmedOf(DRAFT);
  const v = canSendContent({
    campaign: CAMPAIGN, draftValid: true, confirmed,
    draft: { subject: ' 件名A ', body: '{{salutation}}  \r\n\r\n本文A' },
  });
  assert.equal(v.allowed, true, '無意味な失効を起こしている');
});

test('検証エラーのある下書きは送れない', () => {
  const v = canSendContent({ campaign: CAMPAIGN, draftValid: false, draft: DRAFT, confirmed: confirmedOf(DRAFT) });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, SEND_BLOCK.INVALID_DRAFT);
});

test('確認チェックが要る場面ではチェックなしで送れない', () => {
  const base = { campaign: CAMPAIGN, draftValid: true, draft: DRAFT, confirmed: confirmedOf(DRAFT), requireAck: true };
  assert.equal(canSendContent({ ...base, acknowledged: false }).reason, SEND_BLOCK.NOT_ACKNOWLEDGED);
  assert.equal(canSendContent({ ...base, acknowledged: true }).allowed, true);
});

test('最終確認は確認済みの文面から作る（編集途中の値を使わない）', () => {
  const confirmed = confirmedOf(DRAFT);
  const sum = buildSendSummary({
    campaign: CAMPAIGN, confirmed,
    counts: { willSend: 59, excluded: 1, selected: 60 },
  });
  assert.equal(sum.subject, '件名A');
  assert.equal(sum.body, '{{salutation}}\n\n本文A');
  assert.equal(sum.contentHashShort, 'abcdef012345');
  assert.equal(sum.willSend, 59);
  assert.equal(sum.kindLabel, '通常配信');
  assert.match(sum.irreversible, /取り消せません/);
  assert.match(sum.ackLabel, /この対象者へ送信します/);
});

test('テスト専用キャンペーンはその旨を最終確認に出す', () => {
  const sum = buildSendSummary({
    campaign: { ...CAMPAIGN, testOnly: true }, confirmed: confirmedOf(DRAFT), counts: {},
  });
  assert.equal(sum.testOnly, true);
  assert.match(sum.kindLabel, /テスト専用/);
});

test('isContentConfirmed は確認結果が無ければ false', () => {
  assert.equal(isContentConfirmed({ draft: DRAFT, confirmed: null }), false);
  assert.equal(isContentConfirmed({ draft: DRAFT, confirmed: { subject: '', body: '' } }), false);
});

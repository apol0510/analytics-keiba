/**
 * campaignContentDraft.test.mjs — 「今回送る文面」の下書き検証
 *
 * ここで守るのは 2 つ。
 *   1. テンプレート（コード）を書き換えないこと
 *   2. 危ないもの（未知の差し込み・HTML・生 URL）を**黙って通さない**こと
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDraft, defaultDraft, isDraftEdited, validateDraft, applyDraft,
  describeLength, draftSignature,
  SUBJECT_MAX, BODY_MAX, DRAFT_ERROR, DRAFT_WARNING, DRAFT_PLACEHOLDERS,
} from './campaignContentDraft.js';
import { getCampaign, renderCampaign } from './campaignCatalog.js';

const CAMPAIGN = Object.freeze({
  campaignId: 'test-campaign',
  version: 3,
  name: 'テスト',
  subject: '【KEIBA Analytics】お知らせ',
  body: '{{salutation}}\n\n本文です。',
  ctaLabel: '詳細を見る',
  ctaUrl: 'https://analytics.keiba.link/pricing/',
});

test('既定文面はテンプレートから読み込める', () => {
  const d = defaultDraft(CAMPAIGN);
  assert.equal(d.subject, CAMPAIGN.subject);
  assert.equal(d.body, CAMPAIGN.body);
  assert.equal(isDraftEdited(CAMPAIGN, d), false);
});

test('件名を変更できる', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: '【KEIBA Analytics】今日のご案内', body: CAMPAIGN.body } });
  assert.equal(v.ok, true, v.errors.join('/'));
  assert.equal(v.edited, true);
  assert.equal(applyDraft(CAMPAIGN, v.draft).subject, '【KEIBA Analytics】今日のご案内');
});

test('本文を変更できる', () => {
  const body = '{{salutation}}\n\n本日はご案内があります。';
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body } });
  assert.equal(v.ok, true, v.errors.join('/'));
  assert.equal(applyDraft(CAMPAIGN, v.draft).body, body);
});

test('編集してもテンプレート定義そのものは変わらない', () => {
  const before = JSON.stringify(CAMPAIGN);
  const applied = applyDraft(CAMPAIGN, { subject: 'べつの件名', body: '{{salutation}}\n\nべつの本文' });
  assert.equal(JSON.stringify(CAMPAIGN), before, 'テンプレートを書き換えている');
  assert.notEqual(applied.subject, CAMPAIGN.subject);
  // campaignId / version / CTA は編集の対象外
  assert.equal(applied.campaignId, CAMPAIGN.campaignId);
  assert.equal(applied.version, CAMPAIGN.version);
  assert.equal(applied.ctaUrl, CAMPAIGN.ctaUrl);
});

test('既定文面に戻せる', () => {
  const edited = applyDraft(CAMPAIGN, { subject: 'x', body: '{{salutation}}\n\ny' });
  assert.equal(isDraftEdited(CAMPAIGN, edited), true);
  assert.equal(isDraftEdited(CAMPAIGN, defaultDraft(CAMPAIGN)), false);
});

test('空の件名は送れない', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: '   ', body: CAMPAIGN.body } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes(DRAFT_ERROR.SUBJECT_EMPTY));
});

test('改行を含む件名は送れない', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: '一行目\n二行目', body: CAMPAIGN.body } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes(DRAFT_ERROR.SUBJECT_NEWLINE));
});

test('長すぎる件名・本文は送れない', () => {
  const long = validateDraft({ campaign: CAMPAIGN, draft: { subject: 'あ'.repeat(SUBJECT_MAX + 1), body: CAMPAIGN.body } });
  assert.equal(long.ok, false);
  assert.ok(long.errors.includes(DRAFT_ERROR.SUBJECT_TOO_LONG));
  const big = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: 'あ'.repeat(BODY_MAX + 1) } });
  assert.equal(big.ok, false);
  assert.ok(big.errors.includes(DRAFT_ERROR.BODY_TOO_LONG));
});

test('空の本文は送れない', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: '\n\n' } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes(DRAFT_ERROR.BODY_EMPTY));
});

test('未定義の差し込みは送れない（空文字へ黙って置換しない）', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: '{{salutation}}\n\n{{plan}} をご利用中です' } });
  assert.equal(v.ok, false);
  assert.deepEqual(v.unknownPlaceholders, ['{{plan}}']);
  assert.ok(v.errors.some((e) => e.includes('{{plan}}')));
});

test('差し込みの書き損じ（{{ の閉じ忘れ）は送れない', () => {
  const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: '{{salutation}\n\n本文' } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes(DRAFT_ERROR.BROKEN_PLACEHOLDER));
});

test('HTML は書けない', () => {
  for (const body of ['<script>alert(1)</script>', '<iframe src=x>', '<b>強調</b>', '<img onerror=x>']) {
    const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: `{{salutation}}\n\n${body}` } });
    assert.equal(v.ok, false, `${body} が通ってしまう`);
    assert.ok(v.errors.includes(DRAFT_ERROR.HTML_NOT_ALLOWED));
  }
});

test('本文に生 URL は書けない（リンクは CTA 経由）', () => {
  for (const body of ['https://example.com/a', 'javascript://x', 'http://analytics.keiba.link/']) {
    const v = validateDraft({ campaign: CAMPAIGN, draft: { subject: CAMPAIGN.subject, body: `{{salutation}}\n\n${body}` } });
    assert.equal(v.ok, false, `${body} が通ってしまう`);
    assert.ok(v.errors.includes(DRAFT_ERROR.URL_NOT_ALLOWED));
  }
});

test('使える差し込みはカタログと一致する（勝手な変数を増やさない）', () => {
  const tokens = DRAFT_PLACEHOLDERS.map((p) => p.token);
  assert.deepEqual(tokens, ['{{salutation}}']);
});

test('警告は送信を止めない（長い件名・宛名なし）', () => {
  const v = validateDraft({
    campaign: CAMPAIGN,
    draft: { subject: 'あ'.repeat(60), body: '宛名の無い本文です。' },
  });
  assert.equal(v.ok, true, v.errors.join('/'));
  assert.ok(v.warnings.includes(DRAFT_WARNING.SUBJECT_LONG));
  // 宛名はシェルが必ず出すので、本文に無くても警告しない
  assert.equal(v.warnings.includes(DRAFT_WARNING.DUPLICATE_SALUTATION), false);
});

test('正規化: 改行コード・行末空白・空行の連打をそろえる', () => {
  const a = normalizeDraft({ subject: ' 件名 ', body: '行1  \r\n\r\n\r\n\r\n行2\t\n' });
  assert.equal(a.subject, '件名');
  assert.equal(a.body, '行1\n\n\n行2');
  // 見た目が同じなら signature も同じ（無意味な失効を起こさない）
  assert.equal(draftSignature({ subject: '件名', body: '行1\n\n\n行2' }), draftSignature(a));
});

test('文字数の内訳を画面へ返す', () => {
  const d = describeLength({ subject: 'あ'.repeat(50), body: '行1\n行2' });
  assert.equal(d.subject.length, 50);
  assert.equal(d.subject.long, true);
  assert.equal(d.subject.over, false);
  assert.equal(d.body.lines, 2);
});

test('編集した文面は送信と同じレンダラーで描ける', () => {
  const sending = applyDraft(CAMPAIGN, { subject: '【KEIBA Analytics】確認', body: '{{salutation}}\n\n編集した本文' });
  const r = renderCampaign({ campaign: sending, name: '山田' });
  assert.ok(r, '描画できない');
  assert.equal(r.subject, '【KEIBA Analytics】確認');
  assert.ok(r.html.includes('山田 様'));
  assert.ok(r.html.includes('編集した本文'));
  // 配信停止は**シェルのフッター**にあり、受信者ごとの URL は送信時に差し替える。
  // 管理者が編集した本文の側に配信停止 URL が混ざっていないことを見る。
  assert.ok(r.html.includes('{{unsubscribeUrl}}'), 'フッターに差し替え印が無い');
  assert.equal(/functions\/unsubscribe\?email=/.test(r.html), false, '本文に実 URL が入っている');
});

test('実在キャンペーンの既定文面をそのまま検証できる（テンプレートが自分の検証を通る）', () => {
  const real = getCampaign('expired-comeback', { includeDisabled: true });
  assert.ok(real, 'expired-comeback が見つからない');
  const v = validateDraft({ campaign: real, draft: defaultDraft(real) });
  assert.equal(v.ok, true, `既定文面が検証に落ちる: ${v.errors.join(' / ')}`);
  assert.equal(v.edited, false);
});

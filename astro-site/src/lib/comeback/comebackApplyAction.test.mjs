/**
 * comebackApplyAction.test.mjs
 *   node --test src/lib/comeback/comebackApplyAction.test.mjs
 *
 * 「確認を開く」と「本番付与」の言葉が混ざらないこと、
 * 最終ボタンが**何名に何をするのか**を必ず名乗ることを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPEN_CONFIRM_LABEL, OPEN_CONFIRM_HINT, STICKY_SAME_ACTION_NOTE,
  APPLY_WRITE_NOTICE, APPLY_MAIL_NOTICE, APPLY_HANDOFF_NOTICE,
  APPLY_BUSY_LABEL, APPLY_DONE_LABEL, APPLY_BLOCK, APPLY_BLOCK_LABEL,
  describeBenefits, buildApplyActionLabel, buildApplyActionAriaLabel,
  canRunApply, buildApplySummaryRows,
} from './comebackApplyAction.js';

// ── 最終ボタンの文言 ────────────────────────────────────────────

test('期間限定 30 日（Light のみ）', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 28, willOffer: 0, lightLabel: 'Light 30日無料' }),
    '28 名に Light 30日無料 を付与する',
  );
});

test('永久無料（Light のみ）', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 5, lightLabel: 'Light 永久無料' }),
    '5 名に Light 永久無料 を付与する',
  );
});

test('Premium 付与あり', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 3, premiumLabel: 'Premium 30日無料' }),
    '3 名に Premium 30日無料 を付与する',
  );
});

test('Light と Premium の両方', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 12, lightLabel: 'Light 永久無料', premiumLabel: 'Premium 30日無料' }),
    '12 名に Light 永久無料 と Premium 30日無料 を付与する',
  );
});

test('特典ラベルが取れないときも人数は必ず出す', () => {
  assert.equal(buildApplyActionLabel({ willGrant: 7 }), '7 名に無料特典を付与する');
});

test('割引オファーだけのとき', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 0, willOffer: 4 }),
    '4 名に割引オファーを発行する',
  );
});

test('付与とオファーが同時のときは 1 文にまとめる', () => {
  assert.equal(
    buildApplyActionLabel({ willGrant: 10, willOffer: 4, lightLabel: 'Light 30日無料' }),
    '10 名に Light 30日無料 を付与し、4 名に割引オファーを発行する',
  );
});

test('対象 0 名なら「対象がいません」と名乗る', () => {
  assert.equal(buildApplyActionLabel({ willGrant: 0, willOffer: 0 }), '付与できる対象がいません');
  assert.equal(buildApplyActionLabel({}), '付与できる対象がいません');
});

test('抽象的な「実行する」を返さない', () => {
  const cases = [
    { willGrant: 28, lightLabel: 'Light 30日無料' },
    { willGrant: 0, willOffer: 4 },
    { willGrant: 1, willOffer: 1, premiumLabel: 'Premium 永久無料' },
  ];
  for (const c of cases) {
    const label = buildApplyActionLabel(c);
    assert.equal(/^実行する/.test(label), false, `抽象的な文言を返した: ${label}`);
    assert.match(label, /\d+ 名/, `人数が入っていない: ${label}`);
  }
});

test('aria-label は人数・内容に加えて本番変更であることを含む', () => {
  const aria = buildApplyActionAriaLabel({ willGrant: 28, lightLabel: 'Light 30日無料' });
  assert.match(aria, /28 名/);
  assert.match(aria, /Light 30日無料/);
  assert.ok(aria.includes(APPLY_WRITE_NOTICE));
  // 対象 0 名のときは余計な警告を付けない
  assert.equal(buildApplyActionAriaLabel({}), '付与できる対象がいません');
});

test('特典の平文は選んだものだけを並べる', () => {
  assert.equal(describeBenefits({ lightLabel: 'Light 30日無料' }), 'Light 30日無料');
  assert.equal(describeBenefits({ premiumLabel: 'Premium 永久無料' }), 'Premium 永久無料');
  assert.equal(describeBenefits({ lightLabel: 'A', premiumLabel: 'B' }), 'A と B');
  assert.equal(describeBenefits({}), '');
});

// ── 押せるかどうか ──────────────────────────────────────────────

test('gate が閉じていれば押せない', () => {
  const v = canRunApply({ writeEnabled: false, willGrant: 5 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, APPLY_BLOCK.WRITE_DISABLED);
  assert.ok(v.label.length > 0);
});

test('付与 0 名では押せない', () => {
  const v = canRunApply({ writeEnabled: true, willGrant: 0, willOffer: 0 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, APPLY_BLOCK.NO_TARGET);
});

test('実行中は押せない（二重クリック防止）', () => {
  assert.equal(canRunApply({ writeEnabled: true, willGrant: 5, busy: true }).reason, APPLY_BLOCK.BUSY);
});

test('完了後は同じ確認から再実行できない', () => {
  assert.equal(canRunApply({ writeEnabled: true, willGrant: 5, applied: true }).reason, APPLY_BLOCK.DONE);
});

test('gate が開いていて対象がいれば押せる', () => {
  assert.equal(canRunApply({ writeEnabled: true, willGrant: 28 }).allowed, true);
  // オファーだけでも押せる
  assert.equal(canRunApply({ writeEnabled: true, willGrant: 0, willOffer: 4 }).allowed, true);
});

test('すべての理由コードに文言がある', () => {
  for (const code of Object.values(APPLY_BLOCK)) {
    assert.ok(APPLY_BLOCK_LABEL[code], `${code} の文言が無い`);
  }
});

// ── 確認モーダルの必須項目 ──────────────────────────────────────

test('確認モーダルは要求された項目を 1 画面で出す', () => {
  const rows = buildApplySummaryRows({
    plan: { selected: 30, willGrant: 28, skipped: 2, willOffer: 0 },
    audience: { activeMembers: 0, bySegment: { expired: 20, withdrawn: 8 }, segmentLabels: { expired: '期限切れ', withdrawn: '退会' } },
    benefits: 'Light 30日無料',
    unchangedNotice: 'プラン・課金状態は変更しません。',
  });
  const keys = rows.map((r) => r.key);
  for (const k of ['selected', 'willGrant', 'skipped', 'activeMembers', 'segments', 'benefits', 'willOffer', 'unchanged', 'mail']) {
    assert.ok(keys.includes(k), `${k} が欠けている`);
  }
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.selected.value, '30 名');
  assert.equal(byKey.willGrant.value, '28 名');
  assert.equal(byKey.willGrant.tone, 'ok');
  assert.equal(byKey.skipped.value, '2 名');
  assert.equal(byKey.segments.value, '期限切れ 20 名 / 退会 8 名');
  assert.equal(byKey.mail.value, APPLY_MAIL_NOTICE);
});

test('現有効会員が混ざっていれば注意色になる', () => {
  const rows = buildApplySummaryRows({ plan: { willGrant: 5 }, audience: { activeMembers: 2 } });
  const active = rows.find((r) => r.key === 'activeMembers');
  assert.equal(active.value, '2 名');
  assert.equal(active.tone, 'ng');
});

test('付与 0 名なら付与予定人数が注意色になる', () => {
  const rows = buildApplySummaryRows({ plan: { willGrant: 0 } });
  assert.equal(rows.find((r) => r.key === 'willGrant').tone, 'ng');
});

test('欠けた入力でも落ちず「—」で埋める', () => {
  const rows = buildApplySummaryRows({});
  assert.equal(rows.find((r) => r.key === 'segments').value, '—');
  assert.equal(rows.find((r) => r.key === 'selected').value, '0 名');
});

// ── 文言の分離 ────────────────────────────────────────────────

test('確認を開く文言と本番付与の文言が混ざらない', () => {
  assert.equal(OPEN_CONFIRM_LABEL, '付与内容の最終確認へ');
  // 「確認を開く」側には「付与する」という確定の語を入れない
  assert.equal(/付与する$/.test(OPEN_CONFIRM_LABEL), false);
  assert.match(OPEN_CONFIRM_HINT, /まだ付与されません/);
  assert.match(STICKY_SAME_ACTION_NOTE, /別の操作ではありません/);
  // 本番付与側は「変更する」ことを明言する
  assert.match(APPLY_WRITE_NOTICE, /本番データを変更します/);
  assert.match(APPLY_MAIL_NOTICE, /メールを送信しません/);
  assert.match(APPLY_HANDOFF_NOTICE, /引き継げます/);
  assert.equal(APPLY_BUSY_LABEL, '付与中…');
  assert.match(APPLY_DONE_LABEL, /再実行できません/);
});

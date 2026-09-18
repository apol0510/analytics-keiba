/**
 * sendgridExitReadiness.test.mjs — 「反応したら次の号から外れる」の成立条件を固定する
 *
 * **2026-09-18 の本番実測**をそのまま入力にして、いまの構成で何が成立し何が成立しないかを
 * テストで固定する。ここが green のまま contact を投入すると、
 * **開封した人にも 10 通届く**ので、投入の前に必ずこの判定を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateExitReadiness, minimalFixes, EXIT_TRIGGERS, REMOVAL_BY,
} from './sendgridExitReadiness.js';

/** 2026-09-18 の本番実測（SendGrid API / production env） */
const MEASURED = Object.freeze({
  provider: {
    openTracking: true,          // /v3/tracking_settings/open = enabled
    clickTracking: false,        // /v3/tracking_settings/click = disabled
    webhook: {
      enabled: true, open: true, click: false, bounce: true,
      spam_report: true, unsubscribe: true, group_unsubscribe: false,
    },
    suppressionGroupAttached: true,   // 27 通すべてに AK Marketing(34108) が入っている
  },
  ak: {
    prospectEventsEnabled: true,      // MARKETING_PROSPECT_EVENTS_ENABLED
    listRemovalAutomated: false,      // ⚠️ list から外す定期実行が**無い**
    perRecipientLinkId: false,        // リンクに受信者識別子が無い
    purchaseSignalWired: false,       // 購入を prospect の反応にする配線が無い
  },
});

test('いまの構成では前提が成立しない（contact 投入へ進んではいけない）', () => {
  const r = evaluateExitReadiness(MEASURED);
  assert.equal(r.ok, false);
  assert.deepEqual(r.summary['成立している引き金'].sort(), ['bounce', 'complaint']);
  assert.ok(r.summary['成立していない引き金'].includes('open'));
  assert.ok(r.summary['成立していない引き金'].includes('unsubscribe'));
});

test('自動で外れるのは provider の suppression だけ（bounce / 苦情 / 配信停止）', () => {
  const r = evaluateExitReadiness(MEASURED);
  for (const k of ['unsubscribe', 'bounce', 'complaint']) {
    assert.equal(r.triggers[k].removedFromFutureSends, true, `${k} が外れない`);
    assert.equal(r.triggers[k].by, REMOVAL_BY.SENDGRID_SUPPRESSION);
  }
  // 配信停止は「外れる」が、AK 台帳へ残せない（webhook の group_unsubscribe が false）
  assert.equal(r.triggers.unsubscribe.removedFromFutureSends, true);
  assert.equal(r.triggers.unsubscribe.detected, false);
});

test('開封しても次の号が届く（list から外す処理が無いため）', () => {
  const r = evaluateExitReadiness(MEASURED);
  assert.equal(r.triggers.open.detected, true, '開封は検知できている');
  assert.equal(r.triggers.open.removedFromFutureSends, false, '外れてしまってはこのテストの意味が無い');
  assert.equal(r.triggers.open.by, REMOVAL_BY.NONE);
});

test('click は計測自体が無効なので反応として使えない', () => {
  const r = evaluateExitReadiness(MEASURED);
  assert.equal(r.triggers.click.detected, false);
});

test('サイト再訪・購入は紐付けられない', () => {
  const r = evaluateExitReadiness(MEASURED);
  assert.equal(r.triggers.site_revisit.detected, false);
  assert.equal(r.triggers.purchase.detected, false);
});

test('最小の直し方は「list 除外の定期実行」と「group_unsubscribe を ON」', () => {
  const fixes = minimalFixes(evaluateExitReadiness(MEASURED));
  const ids = fixes.map((f) => f.id);
  assert.ok(ids.includes('automate_list_removal'));
  assert.ok(ids.includes('enable_group_unsubscribe_event'));
  // 新しい配送基盤を作る案を出さない
  for (const f of fixes) {
    assert.equal(/自前|独自|新しい配送/.test(String(f.how)), false, `${f.id}: 自前実装を勧めている`);
  }
  // 「新しく作るものが無い」直し方が大半であること（＝最小の直し方になっている）
  const noBuild = fixes.filter((f) => String(f.newBuild).startsWith('無し'));
  assert.ok(noBuild.length >= 4, `新規実装の要らない案が少ない: ${noBuild.length}`);
});

test('list 除外を自動化すれば open / 購入まで成立する（click と再訪は別判断）', () => {
  const fixed = {
    provider: {
      ...MEASURED.provider,
      webhook: { ...MEASURED.provider.webhook, group_unsubscribe: true },
    },
    ak: {
      ...MEASURED.ak, listRemovalAutomated: true, purchaseSignalWired: true,
    },
  };
  const r = evaluateExitReadiness(fixed);
  for (const k of ['unsubscribe', 'bounce', 'complaint', 'open', 'purchase']) {
    assert.equal(r.triggers[k].detected && r.triggers[k].removedFromFutureSends, true, `${k} が成立しない`);
  }
  // click と site_revisit は別の判断（当てにしない方針）
  assert.equal(r.triggers.click.detected, false);
  assert.equal(r.triggers.site_revisit.detected, false);
  assert.equal(r.ok, false, 'click / 再訪を含めた「全部成立」はまだ false でよい');
});

test('引き金の一覧を勝手に増やさない', () => {
  assert.deepEqual(EXIT_TRIGGERS, [
    'unsubscribe', 'bounce', 'complaint', 'open', 'click', 'site_revisit', 'purchase',
  ]);
});

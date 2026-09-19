/**
 * marketingAutoOperation.test.mjs — 「MK が毎日触らない」ための自動運用を固定する
 *
 * ここが green であることが、**日々の手作業を戻さない**という約束の機械表現になる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  planContinuation, summarizeContinuation,
  CONTINUATION_LIST_NAME, CONTINUATION_STATES, MAX_CONTINUATION_PER_CALL,
} from './sendgridContinuation.js';
import {
  evaluateSelectionWatch, shouldNotify, describeWatch,
  WATCH_FINDING, WATCH_SEVERITY, WATCH_THRESHOLDS,
} from './selectionWatch.js';
import {
  planWeeklySend, validateWeeklyContent, jstDateKey, weeklyName,
  WEEKLY_DAYS, WEEKLY_MAX_PER_WEEK, WEEKLY_REFUSE, WEEKLY_LIST_NAME,
} from './weeklyNewsletterPlan.js';
import { buildWeeklyContent, renderWeekly, CONTENT_FAIL } from './weeklyNewsletterContent.js';

// ── 反応した人を次の導線へ渡す ───────────────────────────────

test('反応した人だけを継続 list へ渡す（止めた人・配り終えた人は渡さない）', () => {
  const p = planContinuation({
    changes: [
      { email: 'a@example.com', state: 'ENGAGED' },
      { email: 'b@example.com', state: 'PROMOTED' },
      { email: 'c@example.com', state: 'SUPPRESSED' },
      { email: 'd@example.com', state: 'EXHAUSTED' },
    ],
  });
  assert.deepEqual(p.emails, ['a@example.com', 'b@example.com']);
  assert.equal(p.counts.対象外, 2);
  assert.deepEqual(CONTINUATION_STATES, ['ENGAGED', 'PROMOTED']);
  assert.equal(CONTINUATION_LIST_NAME, 'ak-drm-engaged');
});

test('同じ人を二度入れない・上限を超えない', () => {
  const many = Array.from({ length: MAX_CONTINUATION_PER_CALL + 5 }, (_, i) => ({ email: `u${i}@example.com`, state: 'ENGAGED' }));
  const p = planContinuation({ changes: [...many, { email: 'u0@example.com', state: 'ENGAGED' }] });
  assert.equal(p.emails.length, MAX_CONTINUATION_PER_CALL);
  assert.equal(p.counts.上限超過, 5);
  assert.equal(p.counts.重複, 1);
});

test('要約にアドレスを入れない', () => {
  const p = planContinuation({ changes: [{ email: 'a@example.com', state: 'ENGAGED' }] });
  assert.equal(/@/.test(JSON.stringify(summarizeContinuation(p, { added: 1 }))), false);
});

// ── 毎日の見張り ─────────────────────────────────────────────

const send = (o) => ({ name: 'AK Prospect Selection s1 m01', status: 'triggered', sendAtMs: Date.UTC(2026, 8, 20, 10), requests: 300, delivered: 295, bounces: 2, spam: 0, ...o });

test('異常が無ければ「異常なし」', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 12), sends: [send()], engine: 'sendgrid',
    akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.halt, false);
  assert.equal(describeWatch(r), '異常なし');
});

test('【重大】同じ通が 2 回送られたら止める判断にする', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 12), sends: [send(), send()], engine: 'sendgrid',
    akActive: 100, providerRejected: 10, listTotal: 90,
  });
  assert.equal(r.halt, true);
  assert.ok(r.findings.some((f) => f.id === WATCH_FINDING.DUPLICATE_SEND && f.severity === WATCH_SEVERITY.CRITICAL));
});

test('【重大】予定を過ぎたのに送られていなければ検知する', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 12),
    sends: [send({ status: 'scheduled', requests: 0, delivered: 0 })],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90,
  });
  assert.ok(r.findings.some((f) => f.id === WATCH_FINDING.SEND_MISSING));
  assert.equal(r.halt, true);
});

test('【重大】旧 AK が prospect を送る設定に戻ったら検知する', () => {
  const r = evaluateSelectionWatch({ nowMs: Date.now(), sends: [], engine: 'ak' });
  assert.ok(r.findings.some((f) => f.id === WATCH_FINDING.ENGINE_CONFLICT));
});

test('反応が増えただけでは異常にしない（差が広がったときだけ）', () => {
  const base = { nowMs: Date.UTC(2026, 8, 20, 12), sends: [send()], engine: 'sendgrid', providerRejected: 10 };
  const same = evaluateSelectionWatch({ ...base, akActive: 95, listTotal: 85, previousMismatch: 0 });
  assert.equal(same.findings.some((f) => f.id === WATCH_FINDING.LIST_DRIFT), false);
  const drift = evaluateSelectionWatch({
    ...base, akActive: 200, listTotal: 90, previousMismatch: 0,
  });
  assert.ok(drift.findings.some((f) => f.id === WATCH_FINDING.LIST_DRIFT));
  assert.ok(WATCH_THRESHOLDS.driftIncrease > 0);
});

test('同じ知らせを続けて送らない', () => {
  const r = evaluateSelectionWatch({ nowMs: Date.now(), sends: [], engine: 'ak' });
  const now = Date.now();
  assert.equal(shouldNotify({ result: r, lastNotifiedAtMs: now - 60 * 1000, nowMs: now }).notify, false);
  assert.equal(shouldNotify({ result: r, lastNotifiedAtMs: now - 13 * 60 * 60 * 1000, nowMs: now }).notify, true);
  assert.equal(shouldNotify({ result: { ok: true, findings: [] }, nowMs: now }).notify, false);
});

// ── 週 2 回の一斉配信 ────────────────────────────────────────

const WED = Date.UTC(2026, 9, 5, 2); // 2026-10-05(月) 11:00 JST

test('選別が終わるまで週次は作らない', () => {
  const p = planWeeklySend({
    nowMs: WED, selectionEndsMs: WED + 24 * 3600 * 1000,
    existingNames: [], audienceCount: 100, listId: 'L',
  });
  assert.equal(p.ok, false);
  assert.equal(p.reason, WEEKLY_REFUSE.SELECTION_RUNNING);
});

test('次の水曜 19:00 JST の枠を作る', () => {
  const p = planWeeklySend({ nowMs: WED, selectionEndsMs: WED - 1, existingNames: [], audienceCount: 100, listId: 'L' });
  assert.equal(p.ok, true);
  assert.equal(p.slot.name, weeklyName('2026-10-07'));
  assert.equal(new Date(p.slot.sendAt).toISOString(), '2026-10-07T10:00:00.000Z');
  assert.deepEqual(WEEKLY_DAYS, [3, 6]);
  assert.equal(WEEKLY_LIST_NAME, 'ak-drm-engaged');
});

test('同じ名前があれば作らない（二重予約しない）', () => {
  const p = planWeeklySend({
    nowMs: WED, selectionEndsMs: WED - 1,
    existingNames: [weeklyName('2026-10-07')], audienceCount: 100, listId: 'L',
  });
  assert.equal(p.ok, true);
  assert.equal(p.slot.name, weeklyName('2026-10-10'), '次の枠（土）へ進む');
});

test('1 週間に 3 通目を作らない', () => {
  const p = planWeeklySend({
    nowMs: WED, selectionEndsMs: WED - 1,
    existingNames: [weeklyName('2026-10-07'), weeklyName('2026-10-10')],
    audienceCount: 100, listId: 'L',
  });
  assert.equal(p.ok, false);
  assert.equal(p.reason, WEEKLY_REFUSE.WEEK_LIMIT);
  assert.equal(WEEKLY_MAX_PER_WEEK, 2);
});

test('宛先が 0 人・list が無ければ作らない', () => {
  assert.equal(planWeeklySend({ nowMs: WED, selectionEndsMs: WED - 1, audienceCount: 0, listId: 'L' }).reason, WEEKLY_REFUSE.EMPTY_AUDIENCE);
  assert.equal(planWeeklySend({ nowMs: WED, selectionEndsMs: WED - 1, audienceCount: 10, listId: null }).reason, WEEKLY_REFUSE.LIST_MISSING);
});

test('JST の暦日で切る（UTC 基準にしない）', () => {
  assert.equal(jstDateKey(Date.UTC(2026, 9, 6, 15, 30)), '2026-10-07');
});

// ── 文面 ────────────────────────────────────────────────────

const SHOWCASE = {
  date: '2026-10-06',
  venues: [{
    venue: '大井',
    mainRace: { raceNumber: 11, isHit: true },
    races: Array.from({ length: 12 }, (_, i) => ({ raceNumber: i + 1, isHit: i % 3 === 0 })),
  }],
};

test('実績が無ければ文面を組まない（数字を作らない）', () => {
  assert.equal(buildWeeklyContent({ dateKey: '2026-10-07', showcase: null }).reason, CONTENT_FAIL.NO_RESULTS);
  assert.equal(buildWeeklyContent({ dateKey: '2026-10-07', showcase: { venues: [{ venue: '大井', races: [] }] } }).reason, CONTENT_FAIL.NO_MAIN_RACE);
});

test('【要件】自動で組んだ文面が品質基準を通る', () => {
  const c = buildWeeklyContent({ dateKey: '2026-10-07', showcase: SHOWCASE });
  assert.equal(c.ok, true);
  const v = validateWeeklyContent(c.step);
  assert.deepEqual(v.issues, [], `品質基準に引っかかっている: ${v.issues.join(',')}`);
  assert.equal(v.ok, true);
});

test('着地先に無いものを約束しない（有料版の中身を実績ページで約束しない）', () => {
  const c = buildWeeklyContent({ dateKey: '2026-10-07', showcase: SHOWCASE });
  const promised = c.step.benefitItems.join(' ');
  for (const hidden of ['AI 総合指数', 'AI総合指数', '全頭', '役割分け']) {
    assert.equal(promised.includes(hidden), false, `${hidden} を実績ページで約束している`);
  }
});

test('配信停止は SendGrid のタグに任せる（自前リンクを作らない）', () => {
  const c = buildWeeklyContent({ dateKey: '2026-10-07', showcase: SHOWCASE });
  const r = renderWeekly(c.step);
  assert.match(r.text, /<%asm_group_unsubscribe_raw_url%>/);
  assert.match(r.html, /<%asm_group_unsubscribe_raw_url%>/);
});

// ── 定期実行の配線（ソースで固定）─────────────────────────────

const WATCH_SRC = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-selection-watch.js', import.meta.url), 'utf8');
const WEEKLY_SRC = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-weekly.js', import.meta.url), 'utf8');
/** コメント（説明文）と実装を混同しない */
const stripComments = (src) => src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const WATCH_CODE = stripComments(WATCH_SRC);
const WEEKLY_CODE = stripComments(WEEKLY_SRC);

test('見張りは read-only ＋ 通知だけ（list も予約も触らない）', () => {
  assert.match(WATCH_SRC, /export const config = \{ schedule: '20 11 \* \* \*' \}/);
  for (const banned of ['DELETE', "'PUT'", '/schedule', 'removeFromList']) {
    assert.equal(WATCH_CODE.includes(banned), false, `${banned} を持っている`);
  }
  assert.match(WATCH_SRC, /mail\/send/, '知らせる経路はある');
});

test('週次は既定で不活性（env が無ければ何も読まない）', () => {
  assert.match(WEEKLY_SRC, /WEEKLY_GATE_ENV\] \|\| ''\)\.trim\(\) !== 'true'/);
  assert.match(WEEKLY_SRC, /reason: 'gate_closed'/);
  assert.match(WEEKLY_SRC, /resolveProspectEngine\(process\.env\) !== 'sendgrid'/);
});

test('週次が触れるのは singlesends と lists だけ（自前配送を持たない）', () => {
  assert.ok(WEEKLY_SRC.includes('/^\\/v3\\/marketing\\/(lists|singlesends)/'), '許可パスの検査が無い');
  for (const banned of ['/v3/mail/send', 'setInterval', 'dispatch', 'queue']) {
    assert.equal(WEEKLY_CODE.includes(banned), false, `${banned} を持っている`);
  }
});

// ── 初回配信後の自動点検を強める（2026-09-19 追加）─────────────

test('【要件】送った数が list の人数と食い違ったら検知する', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 12),
    sends: [send({ requests: 200, expectedRecipients: 318 })],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90,
  });
  assert.ok(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP));
});

test('送った数が list の人数とほぼ一致なら検知しない', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 12),
    sends: [send({ requests: 317, expectedRecipients: 318 })],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP), false);
});

test('まだ送っていない通・人数を控えていない通は食い違いを見ない', () => {
  const r = evaluateSelectionWatch({
    nowMs: Date.UTC(2026, 8, 20, 9),
    sends: [
      send({ status: 'scheduled', requests: 0, expectedRecipients: 318, sendAtMs: Date.UTC(2026, 8, 20, 10) }),
      send({ requests: 10, expectedRecipients: null }),
    ],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP), false);
});

test('【要件】反応は増えたのに list が減っていなければ「除外が効いていない」', () => {
  const base = {
    nowMs: Date.UTC(2026, 8, 21, 12), sends: [send()], engine: 'sendgrid',
    akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  };
  const bad = evaluateSelectionWatch({ ...base, engagedDelta: 25, listDelta: 0 });
  assert.ok(bad.findings.some((f) => f.id === WATCH_FINDING.EXIT_NOT_WORKING));
  // 反応が増えて list が減っていれば正常（除外が効いている）
  const good = evaluateSelectionWatch({ ...base, engagedDelta: 25, listDelta: -25 });
  assert.equal(good.findings.some((f) => f.id === WATCH_FINDING.EXIT_NOT_WORKING), false);
  // 反応が少し増えただけでは騒がない
  const quiet = evaluateSelectionWatch({ ...base, engagedDelta: 2, listDelta: 0 });
  assert.equal(quiet.findings.some((f) => f.id === WATCH_FINDING.EXIT_NOT_WORKING), false);
});

// ── 管理画面に出す数 / 週次の事前検査（配線をソースで固定）─────

const ADMIN_SRC = readFileSync(new URL('../../../netlify/functions/admin-sendgrid-migration.js', import.meta.url), 'utf8');

test('overview は読み取りだけで、アドレスを返さない', () => {
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'overview')"), ADMIN_SRC.indexOf("if (action === 'weeklyPreflight')"));
  assert.match(block, /sideEffects: 'none'/);
  for (const banned of ['PUT', 'DELETE', 'upsertContacts', 'removeContactsFromList']) {
    assert.equal(block.includes(banned), false, `${banned} を持っている`);
  }
  // 出すのは件数だけ（contact の生データを載せない）
  assert.equal(block.includes('contacts/search'), false);
});

test('weeklyPreflight は宛先・文面・CTA・配信停止・枠の 5 点を見る', () => {
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'weeklyPreflight')"), ADMIN_SRC.indexOf('// ── 書き込み'));
  for (const key of ['宛先', '文面', 'CTA', '配信停止', '枠']) {
    assert.ok(block.includes(`${key}:`), `${key} を見ていない`);
  }
  assert.match(block, /const ok = Object\.values\(checks\)\.every\(\(c\) => c\.ok === true\)/);
  assert.match(block, /sideEffects: 'none'/);
  assert.equal(block.includes("'POST', '/v3/marketing/singlesends'"), false, '作成の経路を持っている');
});

/**
 * marketingAutoOperation.test.mjs — 「MK が毎日触らない」ための自動運用を固定する
 *
 * ここが green であることが、**日々の手作業を戻さない**という約束の機械表現になる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
import { buildShowcaseDay, buildLatestShowcase } from '../resultsShowcase.js';

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

/**
 * ⚠️ **形を推測しない。** 素材は実物と同じ作り方（`buildShowcaseDay`）で用意する。
 *    2026-09-19 に `venues` を「会場オブジェクトの配列」と取り違えて本番の事前検査が
 *    `no_main_race` で止まった。ここを実物から作れば同じ取り違えは起きない。
 */
const DAY_ENTRY = {
  date: '2026-10-06',
  venue: '大井',
  venues: ['大井'],
  races: Array.from({ length: 12 }, (_, i) => ({
    raceNumber: i + 1,
    venue: '大井',
    bettingLines: [`4→2.5.8.10.11`],
    isHit: i % 3 === 0,
    umatan: { combination: '4-2', payout: 1200 },
    betPoints: 5,
  })),
};
const SHOWCASE = buildShowcaseDay(DAY_ENTRY);

test('素材は実物の形（venueGroups / 集計）で渡ってくる', () => {
  assert.ok(Array.isArray(SHOWCASE.venueGroups) && SHOWCASE.venueGroups.length > 0);
  assert.ok(SHOWCASE.venueGroups[0].mainRace, 'メインレースが取れていない');
  assert.equal(typeof SHOWCASE.totalRaces, 'number');
});

test('実績が無ければ文面を組まない（数字を作らない）', () => {
  assert.equal(buildWeeklyContent({ dateKey: '2026-10-07', showcase: null }).reason, CONTENT_FAIL.NO_RESULTS);
  assert.equal(
    buildWeeklyContent({ dateKey: '2026-10-07', showcase: { venueGroups: [{ venue: '大井', mainRace: null }] } }).reason,
    CONTENT_FAIL.NO_MAIN_RACE,
  );
});

test('【本件】実物の archive から組める（本番の事前検査が no_main_race で止まらない）', async () => {
  const { readFileSync: read } = await import('node:fs');
  const arr = JSON.parse(read(new URL('../../data/archiveResults.json', import.meta.url), 'utf8'));
  const real = buildLatestShowcase(arr);
  const c = buildWeeklyContent({ dateKey: null, showcase: real });
  assert.equal(c.ok, true, `実データで組めない: ${c.reason}`);
  assert.deepEqual(validateWeeklyContent(c.step).issues, []);
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

// ── 2026-09-26: 毎回「注意」が出ていた誤検知の是正 ─────────────────
const day = (d, h = 10) => Date.UTC(2026, 8, d, h);

test('【回帰】過去の通は前日の list 人数と比べない（毎回発火しない）', () => {
  // 2026-09-25 11:20Z の本番相当: start-1 は 318 → 13 人へ縮んだ。初日の通は 318 のまま
  const expectedRecipients = 13;
  const r = evaluateSelectionWatch({
    nowMs: day(25, 11),
    previousCheckedAtMs: Date.UTC(2026, 8, 24, 11, 20),
    sends: [
      send({ name: 'AK Prospect Selection s1 m01', sendAtMs: day(20), requests: 318, expectedRecipients }),
      send({ name: 'AK Prospect Selection s1 m02', sendAtMs: day(21), requests: 144, expectedRecipients }),
      send({ name: 'AK Prospect Selection s1 m06', sendAtMs: day(25), requests: 13, expectedRecipients }),
    ],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP), false, JSON.stringify(r.findings));
});

test('最新の通が本当に食い違っていれば検知する（list ごとに見る）', () => {
  const r = evaluateSelectionWatch({
    nowMs: day(25, 11),
    previousCheckedAtMs: Date.UTC(2026, 8, 24, 11, 20),
    sends: [
      send({ name: 'AK Prospect Selection s3 m07', sendAtMs: day(24), requests: 8425, expectedRecipients: 8400 }),
      send({ name: 'AK Prospect Selection s3 m08', sendAtMs: day(25), requests: 2000, expectedRecipients: 8400 }),
      send({ name: 'AK Prospect Selection s2 m07', sendAtMs: day(25), requests: 2411, expectedRecipients: 2420 }),
    ],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  const gaps = r.findings.filter((f) => f.id === WATCH_FINDING.RECIPIENT_GAP);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].detail.name, 'AK Prospect Selection s3 m08');
});

test('前回の点検より前に送った通は比べない（配り終えた list で誤検知しない）', () => {
  // start-3 は 09-27 が最終。09-28 の点検では最新の通が前回点検より前になる
  const r = evaluateSelectionWatch({
    nowMs: day(28, 11),
    previousCheckedAtMs: Date.UTC(2026, 8, 27, 11, 20),
    sends: [send({ name: 'AK Prospect Selection s3 m10', sendAtMs: day(27), requests: 1700, expectedRecipients: 3 })],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP), false);
});

test('少人数 list の数人の差は比率が大きくても見ない', () => {
  assert.ok(WATCH_THRESHOLDS.recipientGapMinCount >= 5);
  const r = evaluateSelectionWatch({
    nowMs: day(25, 11),
    sends: [send({ name: 'AK Prospect Selection s1 m06', sendAtMs: day(25), requests: 13, expectedRecipients: 12 })],
    engine: 'sendgrid', akActive: 100, providerRejected: 10, listTotal: 90, previousMismatch: 0,
  });
  assert.equal(r.findings.some((f) => f.id === WATCH_FINDING.RECIPIENT_GAP), false);
});

test('点検 cron は前回の点検時刻と list 名を渡している', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/cron-sendgrid-selection-watch.js', import.meta.url)), 'utf8');
  assert.match(src, /previousCheckedAtMs: Number\.isFinite\(state\.lastCheckedAtMs\)/);
  assert.match(src, /\n\s+listName,\n/);
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

test('overview は自動点検の最終実行時刻も返す（動いていないことに気づける）', async () => {
  const { buildMarketingOverview, WATCH_STATE_KEY } = await import('./marketingOverview.js');
  assert.equal(WATCH_STATE_KEY, 'ak:mkt:selection-watch:v1');
  const never = buildMarketingOverview({});
  assert.equal(never['自動点検'], null, '動いていないことが分かる形になっていない');
  const ran = buildMarketingOverview({ watchState: { lastCheckedAtMs: Date.UTC(2026, 8, 19, 11, 20) } });
  assert.equal(ran['自動点検']['最終実行'], '2026-09-19T11:20:00.000Z');
});

test('管理画面が出す数は 1 か所で作る（2 つの API で割れない）', () => {
  const ov = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'overview')"), ADMIN_SRC.indexOf("if (action === 'weeklyPreflight')"));
  assert.match(ov, /collectMarketingOverview\(/);
  const mkt = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  assert.match(mkt, /action === 'mailOverview'/);
  assert.match(mkt, /collectMarketingOverview\(/);
});

test('管理画面は送信基盤の名前が入った関数を叩かない', () => {
  const page = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
  assert.equal(/sendgrid/i.test(page), false, '画面に送信基盤の固有名詞が入っている');
  assert.match(page, /const MAIL_API = MKT_API;/);
  assert.match(page, /action: 'mailOverview'/);
});

test('overview は件数と日時だけを返す（アドレスを持たない）', async () => {
  const { buildMarketingOverview } = await import('./marketingOverview.js');
  const out = buildMarketingOverview({
    lists: [{ name: 'ak-prospect-select-start-1', contactCount: 318 }, { name: 'ak-drm-engaged', contactCount: 7 }],
    singleSends: [{ id: 's1', name: 'AK Prospect Selection s1 m01', status: 'scheduled', send_at: '2026-09-20T10:00:00Z' }],
    stats: [{ id: 's1', stats: { requests: 0, delivered: 0 } }],
    akActive: 11708, akEngaged: 237, weeklyEnabled: false,
  });
  assert.equal(/@/.test(JSON.stringify(out)), false, 'アドレスが混ざっている');
  assert.equal(out['選別']['予約'], 1);
  assert.equal(out['反応']['継続list'], 7);
  assert.equal(out['週次']['有効'], false);
});

// ── 過去に反応した人の取りこぼしを reconcile で埋める ──────────

test('reconcile（excluded）が継続 list への追加を計画する', () => {
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'reconcile')"), ADMIN_SRC.indexOf("    // ── 書き込み"));
  // 渡すのは反応した人だけ（判定は planContinuation に委ねる）
  assert.match(block, /planContinuation\(\{ changes: targets\.map/);
  // すでに居る人は数えて追加しない（重複 0）
  assert.match(block, /listIds\.includes\(String\(contListId\)\)\) contAlready \+= 1/);
  // 追加は継続 list 1 本だけへ
  assert.match(block, /list_ids: \[contListId\]/);
  // 受理されない宛先は分割して切り離す
  assert.match(block, /runWithSplit\(contToAdd/);
  // 下見では 1 件も足さない
  assert.match(block, /追加予定: contToAdd\.length/);
});

test('継続 list へ入れてもメールは送らない（送信の経路を持たない）', () => {
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'reconcile')"), ADMIN_SRC.indexOf("    // ── 書き込み"));
  assert.equal(block.includes('/v3/mail/send'), false);
  assert.equal(block.includes('singlesends'), false);
});

test('active 側の reconcile は継続 list を触らない', () => {
  const block = ADMIN_SRC.slice(ADMIN_SRC.indexOf("if (action === 'reconcile')"), ADMIN_SRC.indexOf("    // ── 書き込み"));
  assert.match(block, /scope === 'excluded'\s*\n?\s*\? planContinuation/);
});

// ── 「動かなかった」と「途中で落ちた」を見分ける（2026-09-19 の取りこぼし）──

test('点検は走り出しをまず残す（記録が無い＝動いていない と言い切れるように）', () => {
  const src = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-selection-watch.js', import.meta.url), 'utf8');
  const head = src.slice(src.indexOf('export default async function handler'), src.indexOf('let state ='));
  assert.match(head, /lastStartedAtMs: now/, '走り出しを最初に残していない');
});

test('overview は最終起動と最終実行の両方を返す', async () => {
  const { buildMarketingOverview } = await import('./marketingOverview.js');
  const out = buildMarketingOverview({
    watchState: { lastStartedAtMs: Date.UTC(2026, 8, 20, 11, 20), lastCheckedAtMs: Date.UTC(2026, 8, 20, 11, 21) },
  });
  assert.equal(out['自動点検']['最終起動'], '2026-09-20T11:20:00.000Z');
  assert.equal(out['自動点検']['最終実行'], '2026-09-20T11:21:00.000Z');
});

test('定期実行の式を netlify.toml とコードの両方に同じ値で書く', () => {
  const toml = readFileSync(new URL('../../../netlify.toml', import.meta.url), 'utf8');
  const watch = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-selection-watch.js', import.meta.url), 'utf8');
  const weekly = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-weekly.js', import.meta.url), 'utf8');
  const pick = (src) => (src.match(/schedule: '([^']+)'/) || [])[1];
  const tomlOf = (name) => {
    const i = toml.indexOf(`[functions."${name}"]`);
    if (i < 0) return null;
    return (toml.slice(i).match(/schedule = "([^"]+)"/) || [])[1];
  };
  assert.equal(pick(watch), tomlOf('cron-sendgrid-selection-watch'), '点検の式が食い違っている');
  assert.equal(pick(weekly), tomlOf('cron-sendgrid-weekly'), '週次の式が食い違っている');
});

// ── 読めなかったものを 0 で出さない（2026-09-19 の 400 事故）──────

test('【本件】stats の page_size は 1〜50（100 を渡すと 400 で点検が丸ごと落ちた）', async () => {
  const { STATS_PAGE_SIZE } = await import('./marketingOverview.js');
  assert.ok(STATS_PAGE_SIZE >= 1 && STATS_PAGE_SIZE <= 50);
  for (const f of ['../../../netlify/functions/cron-sendgrid-selection-watch.js', './marketingOverview.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.equal(/stats\/singlesends\?page_size=(\d+)/.test(src) && Number(RegExp.$1) > 50, false,
      `${f} が page_size>50 で stats を呼んでいる`);
  }
});

test('【重要】実績が読めないときは 0 ではなく「取得できず」にする', async () => {
  const { buildMarketingOverview } = await import('./marketingOverview.js');
  const out = buildMarketingOverview({
    singleSends: [{ id: 's1', name: 'AK Prospect Selection s1 m01', status: 'triggered' }],
    stats: [],
    unavailable: ['stats'],
  });
  assert.equal(out['選別']['実績'], null, '読めていないのに数字を出している');
  assert.equal(out['週次']['実績'], null);
  assert.deepEqual(out['取得できなかったもの'], ['stats']);
  // 読めているときは従来どおり数字が出る
  const ok = buildMarketingOverview({
    singleSends: [{ id: 's1', name: 'AK Prospect Selection s1 m01', status: 'triggered' }],
    stats: [{ id: 's1', stats: { requests: 10, delivered: 9 } }],
  });
  assert.equal(ok['選別']['実績'].delivered, 9);
});

test('点検は実績が読めなくても止まらず、読めなかったことを異常として残す', () => {
  const src = readFileSync(new URL('../../../netlify/functions/cron-sendgrid-selection-watch.js', import.meta.url), 'utf8');
  assert.match(src, /statsUnavailable = String/);
  assert.match(src, /id: 'stats_unavailable'/);
  assert.match(src, /result\.ok = false/);
});

test('画面も「取得できず」と書く（0 と書かない）', () => {
  const page = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
  assert.match(page, /'取得できず'/);
  assert.match(page, /読めなかった情報があります/);
});

/**
 * drmEntryAllowlist.test.mjs — **承認人数を超えて送らない**（2026-09-14 の事故の再発防止）
 *   node --test src/lib/drm/drmEntryAllowlist.test.mjs
 *
 * ── 事故（本番実測）────────────────────────────────────────────
 * 承認は無料登録 **16 名**。`expectedCount: 16` で live を起動したが、
 * ジョブの Recipients は **50**、SentCount は **46**。
 * CampaignDeliveries は **13 行**だけ（prospect は Airtable に行を書かないため）。
 *
 * 一次原因: **`expectedCount` は入口 planner の人数しか縛っておらず**、
 * 委譲先の `runSequenceTick` は 台帳由来 ＋ 入口 ＋ **prospect** で母集団を組み直し、
 * `MARKETING_SEQUENCE_MAX_PER_TICK`（50）まで送る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeAllowlist, applyEntryAllowlist, assertWithinAllowlist, ALLOWLIST_FAIL,
} from './drmEntryAllowlist.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const DRM = read('../../../netlify/functions/cron-drm-autostart.js');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** 無料登録者（Customers 由来・recordId あり） */
const signup = (i) => ({ recordId: `recSIGNUP${String(i).padStart(4, '0')}`, email: `s${i}@example.com` });
/** prospect（Airtable に行を持たない＝recordId が無い / 別系統） */
const prospect = (i) => ({ recordId: null, email: `p${i}@example.com`, 出所: 'prospect' });
/** 台帳由来の別 Customer（許可リストの外） */
const other = (i) => ({ recordId: `recOTHER${String(i).padStart(4, '0')}`, email: `o${i}@example.com` });

// ══════════════════════════════════════════════════════════════════
//  ① 事故の再現形（planner 16 + prospect 11,000 + maxPerTick 50）
// ══════════════════════════════════════════════════════════════════

test('【最重要】planner 16 名 + prospect 11,000 件 + maxPerTick 50 でも 16 名を超えない', () => {
  const planned = Array.from({ length: 16 }, (_, i) => signup(i));
  const allowlist = normalizeAllowlist(planned.map((p) => p.recordId));

  // tick が組み直した母集団（入口 16 + prospect 11,000 + 台帳由来の別 Customer 34）を
  // maxPerTick 50 で切った「最終集合」を模す。**並び順は偏る**（事故時も偏った）
  const prospects = Array.from({ length: 11000 }, (_, i) => prospect(i));
  const others = Array.from({ length: 34 }, (_, i) => other(i));
  const repopulated = [...prospects, ...others, ...planned];
  const cappedAt50 = repopulated.slice(0, 50);   // ← 事故時はここが 50 人ぶん送られた

  // 制約なし（事故時の挙動）
  const before = applyEntryAllowlist({ targets: cappedAt50, allowlist: null });
  assert.equal(before.kept.length, 50, '事故の再現になっていない');
  assert.equal(before.constrained, false);

  // 制約あり（修正後）
  const after = applyEntryAllowlist({ targets: cappedAt50, allowlist });
  assert.ok(after.kept.length <= 16, `16 名を超えた（${after.kept.length}）`);
  assert.equal(after.constrained, true);
  for (const t of after.kept) {
    assert.ok(allowlist.has(t.recordId), '許可リスト外が残っている');
  }
  // prospect は 1 人も残らない
  assert.equal(after.kept.some((t) => t['出所'] === 'prospect'), false, 'prospect が残っている');
  // 台帳由来の別 Customer も残らない
  assert.equal(after.kept.some((t) => String(t.recordId || '').startsWith('recOTHER')), false);
});

test('【最重要】母集団の先頭が prospect で埋まっていても 0 件になるだけ（超えない）', () => {
  const planned = Array.from({ length: 16 }, (_, i) => signup(i));
  const allowlist = normalizeAllowlist(planned.map((p) => p.recordId));
  // 50 枠が全部 prospect（入口の 16 名が 1 人も入らなかったケース）
  const cappedAt50 = Array.from({ length: 50 }, (_, i) => prospect(i));
  const after = applyEntryAllowlist({ targets: cappedAt50, allowlist });
  assert.equal(after.kept.length, 0, '許可リスト外へ送ろうとしている');
  assert.equal(after.dropped, 50);
});

// ══════════════════════════════════════════════════════════════════
//  ② 減るのは許容 / 増えるのは禁止
// ══════════════════════════════════════════════════════════════════

test('【要件】安全判定で人数が減るのは許容する', () => {
  const planned = Array.from({ length: 16 }, (_, i) => signup(i));
  const allowlist = normalizeAllowlist(planned.map((p) => p.recordId));
  // 上流の除外（購入・停止・既送信）で 16 → 9 に減った最終集合
  const reduced = planned.slice(0, 9);
  const after = applyEntryAllowlist({ targets: reduced, allowlist });
  assert.equal(after.kept.length, 9, '減った人数をさらに削っている');
});

test('【要件】許可リストは「全員へ送る」ではない（足さない）', () => {
  const planned = Array.from({ length: 16 }, (_, i) => signup(i));
  const allowlist = normalizeAllowlist(planned.map((p) => p.recordId));
  const after = applyEntryAllowlist({ targets: [], allowlist });
  assert.equal(after.kept.length, 0, '空の最終集合に人を足している');
});

test('【安全】recordId を持たない相手は「外」として扱う', () => {
  const allowlist = normalizeAllowlist(['recA']);
  const r = applyEntryAllowlist({
    targets: [{ recordId: 'recA' }, { recordId: null }, { recordId: '' }, {}],
    allowlist,
  });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped, 3);
});

test('【安全】空の許可リストは「全部許可」ではなく「誰も許可しない」', () => {
  const empty = normalizeAllowlist([]);
  assert.ok(empty instanceof Set);
  assert.equal(empty.size, 0);
  const r = applyEntryAllowlist({ targets: [signup(1), signup(2)], allowlist: empty });
  assert.equal(r.kept.length, 0, '空リストが全部許可に化けている');
  assert.equal(r.constrained, true);
});

test('【不変】省略時は何もしない（共有 tick の挙動を変えない）', () => {
  for (const raw of [null, undefined]) {
    const a = normalizeAllowlist(raw);
    assert.equal(a, null);
    const targets = [signup(1), prospect(1), other(1)];
    const r = applyEntryAllowlist({ targets, allowlist: a });
    assert.equal(r.kept.length, 3, '渡していないのに絞っている');
    assert.equal(r.constrained, false);
    assert.equal(r.dropped, 0);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ③ 積む直前の最後の確認（多層防御）
// ══════════════════════════════════════════════════════════════════

test('【安全】許可リスト外が最終集合に混ざったら積ませない', () => {
  const allowlist = normalizeAllowlist(['recA', 'recB']);
  const ok = assertWithinAllowlist({ targets: [{ recordId: 'recA' }], allowlist });
  assert.equal(ok.ok, true);
  const ng = assertWithinAllowlist({
    targets: [{ recordId: 'recA' }, { recordId: 'recZ' }, { recordId: null }], allowlist,
  });
  assert.equal(ng.ok, false);
  assert.equal(ng.reason, ALLOWLIST_FAIL.OUTSIDE_ALLOWLIST);
  assert.equal(ng.outside, 2);
});

test('【不変】省略時は最後の確認も素通し', () => {
  const r = assertWithinAllowlist({ targets: [{ recordId: 'x' }], allowlist: null });
  assert.equal(r.ok, true);
  assert.equal(r.outside, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 配線（再検証を短絡していない / 既存挙動を変えていない）
// ══════════════════════════════════════════════════════════════════

test('【配線】tick は最終集合に対してのみ制約を掛ける（再検証の後）', () => {
  /**
   * ⚠️ 2026-09-15 に**塊ごとの補充**へ変えた（枠が埋まらず 50→20→13→4 と逓減したため）。
   *    許可リストを掛ける位置は**変えていない**: 塊の中で
   *    既送信の突き合わせ → 出所フィルタ → 許可リスト の順、
   *    そのあと積む直前に `assertWithinAllowlist` で最終確認する。
   */
  const code = codeOnly(CRON);
  const idxDue = code.indexOf('chunk.filter((t) => !active.has(keyOfTarget(t)))');
  const idxFilter = code.indexOf('applyEntryAllowlist({');
  const idxAssert = code.indexOf('assertWithinAllowlist({');
  const idxPlan = code.indexOf('buildCampaignPlan({');
  assert.ok(idxDue > 0 && idxFilter > idxDue, '既送信の突き合わせより前に絞っている');
  assert.ok(idxAssert > idxFilter && idxPlan > idxAssert, '積む直前の確認が無い / 順序が違う');
});

test('【最重要】候補データを注入していない（recordId だけ）', () => {
  const code = codeOnly(DRM);
  assert.match(code, /entryAllowlist: seen\.recordIds \|\| \[\]/, '許可リストを渡していない');
  // candidate object を渡していない
  for (const bad of ['entryCandidates', 'candidates:', 'selected:', 'recipients:']) {
    assert.equal(code.includes(`${bad} seen`), false, `候補データ（${bad}）を注入している`);
  }
  // tick は従来どおり自分で取り直す
  const cron = codeOnly(CRON);
  assert.match(cron, /fetchAutoStartCandidates\(\{/, 'tick が候補を取り直していない');
  assert.match(cron, /fetchProviderSuppression\(\{/, 'tick が停止リストを引いていない');
  assert.match(cron, /fetchActiveDeliveryKeys\(\{/, 'tick が既送信を突き合わせていない');
});

test('【不変】許可リストを渡さない経路（共有 cron）はそのまま', () => {
  const code = codeOnly(CRON);
  // 定期実行エントリは entryAllowlist を渡さない
  const i = code.indexOf('export default async function handler()');
  const body = code.slice(i);
  assert.equal(body.includes('entryAllowlist'), false, '共有 cron が許可リストを渡している');
  assert.match(body, /await runSequenceTick\(\{ env: process\.env, now: Date\.now\(\), campaignId \}\)/);
});

test('【表示】許可リストで落とした人数を黙って隠さない', () => {
  const code = codeOnly(CRON);
  assert.match(code, /許可リスト外で除外/);
  assert.match(code, /entryAllowlist: allowed\.constrained/);
});

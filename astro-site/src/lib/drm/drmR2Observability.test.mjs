/**
 * drmR2Observability.test.mjs — **R2（実配信で層ごとに別の 1 通が出る）を
 *   いつ・どこで観測できるか**を実 catalog で固定する
 *   node --test src/lib/drm/drmR2Observability.test.mjs
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-09-16 に `free-signup-onboarding` の step2 が 12 名へ配信され、
 * `byRoute` に `opened:5` / `delivered:3` の 2 層が実データで現れた。
 * ここで「R2 成立」と読み違えかけたが、**step2 は分岐した結果ではない**。
 *
 *   - `responseRoutes` は 2 本とも `minSent: 2` を宣言している。
 *     step1 しか受け取っていない時点（`sentCount: 1`）では **どの route も当たらない**ので、
 *     2 通目は**構造的に線形**（step2）にしかならない。分岐は **3 通目から**。
 *   - さらに到達層の行き先 `delivered → step3` は、step2 の**線形の次**と同じ番号である。
 *     つまり到達層は**送信記録の上では線形と見分けが付かない**。
 *     「反応で行き先が変わった」ことを送信記録だけで示せるのは
 *     **開封層（`opened → step5`／step3・step4 を飛ばす）**の側だけ。
 *
 * この 2 点を散文だけで持つと、次に読む人が同じ読み違えをする。
 * **いつ観測できるか**（= どの通数で分岐が効き始めるか）を機械で固定する。
 *
 * ⚠️ ここは「分岐が起きたこと」を実配信で確認する代わりにはならない。
 *    固定するのは**観測できる条件**であって、実績ではない。
 * ⚠️ 通数の閾値（`minSent` / `maxSent`）や `delayDays` を変えるときは、
 *    `docs/progress.md` の R2 の観測時期も併せて直すこと（片方だけ直さない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign } from '../marketing/campaignCatalog.js';
import {
  resolveSequenceStep, resolveMaxSends, getSequenceSteps, stepDelayDays,
} from '../marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { buildSequenceProgress } from '../marketing/sequenceProgress.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { resolveResponseState } from './drmResponseState.js';

const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 30, 0, 0);

/** R2 の観測対象は第 1 段の育成（入口が自動で開く唯一の段） */
const ID = 'free-signup-onboarding';

const campaign = (() => {
  const c = getCampaign(ID, { includeDisabled: true });
  assert.ok(c, `${ID} が catalog にありません`);
  return c;
})();

const routeFor = (when) => campaign.sequence.responseRoutes.find((r) => r.when === when);

/** 宛先条件を満たす無料会員（実 SSOT で marketing を作る） */
function member(email) {
  const fields = { Email: email, Status: 'active' };
  return {
    recordId: `rec-${email}`,
    fields,
    marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  };
}

const keyFor = (step, email) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(campaign, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

const sentRow = (step, email, atMs) => ({
  fields: {
    EmailType: 'campaign', DeliveryKey: keyFor(step, email),
    RecipientEmail: email, Status: 'sent', SentAt: new Date(atMs).toISOString(),
  },
});

const touch = (step, email, atMs, o = {}) => ({
  step, deliveryKey: keyFor(step, email), sentAtMs: atMs,
  delivered: o.delivered ?? null, opened: o.opened ?? null, clicked: o.clicked ?? null,
});

/**
 * `steps` 通を受け取った人の進行を作る。
 * `lastAtMs` は最後の送信時刻（既定は十分前 = 期限到来）。
 */
function progressAfter({ email, steps, reaction, lastAtMs = NOW - 30 * DAY }) {
  const times = steps.map((_, i) => lastAtMs - (steps.length - 1 - i) * DAY);
  const touches = steps.map((s, i) => touch(s, email, times[i], reaction));
  const response = resolveResponseState({
    marketing: member(email).marketing,
    touches,
    campaign,
    measured: { open: true, click: false },
    providerSuppressed: null,
    softBounced: null,
  });
  const progress = buildSequenceProgress({
    campaign,
    selected: [member(email)],
    deliveries: steps.map((s, i) => sentRow(s, email, times[i])),
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(),
    softBounced: new Set(),
    responseByEmail: new Map([[email, response]]),
  });
  return { row: progress.rows[0], response };
}

const OPENED = { delivered: true, opened: true };
const DELIVERED = { delivered: true, opened: false };

// ══════════════════════════════════════════════════════════════════
//  ① 分岐が効き始めるのは 3 通目から（step2 は構造的に線形）
// ══════════════════════════════════════════════════════════════════

test('【最重要】route は 2 本とも minSent:2 — 1 通しか送っていない人は分岐できない', () => {
  for (const when of ['opened', 'delivered']) {
    const r = routeFor(when);
    assert.ok(r, `${when} の route が無い`);
    assert.equal(r.minSent, 2, `${when} の minSent が変わっている（R2 の観測時期が変わる）`);
  }
});

test('【最重要】step1 だけ受け取った人の 2 通目は、反応があっても線形 step2', () => {
  for (const [label, reaction] of [['opened', OPENED], ['delivered', DELIVERED]]) {
    const { row } = progressAfter({ email: `one-${label}@example.com`, steps: [1], reaction });
    assert.equal(row.nextStep, 2, `${label}: 2 通目が線形 step2 になっていない`);
    assert.equal(
      row.routedBy, null,
      `${label}: 1 通目の時点で分岐している（minSent:2 が効いていない）`,
    );
  }
});

test('【最重要】step2 まで受け取って初めて層ごとに行き先が割れる', () => {
  const opened = progressAfter({ email: 'two-open@example.com', steps: [1, 2], reaction: OPENED });
  const delivered = progressAfter({ email: 'two-deliv@example.com', steps: [1, 2], reaction: DELIVERED });

  assert.equal(opened.row.routedBy, 'opened:5');
  assert.equal(opened.row.nextStep, routeFor('opened').step);
  assert.equal(delivered.row.routedBy, 'delivered:3');
  assert.equal(delivered.row.nextStep, routeFor('delivered').step);
  assert.notEqual(
    opened.row.nextStep, delivered.row.nextStep,
    '層が違うのに同じ 1 通が行く（分岐していない）',
  );
});

test('【重要】maxSent:4 — 5 通目以降は分岐せず線形へ戻る', () => {
  for (const when of ['opened', 'delivered']) {
    assert.equal(routeFor(when).maxSent, 4, `${when} の maxSent が変わっている`);
  }
  const { row } = progressAfter({
    email: 'five@example.com', steps: [1, 2, 3, 4, 5], reaction: OPENED,
  });
  assert.equal(row.routedBy, null, '上限を超えても分岐している');
  assert.equal(row.nextStep, 6, '線形へ戻っていない');
});

// ══════════════════════════════════════════════════════════════════
//  ② 到達層は送信記録だけでは線形と見分けが付かない
// ══════════════════════════════════════════════════════════════════

test('【最重要】delivered の行き先は step2 の線形の次と同じ番号（記録上は区別できない）', () => {
  // step2 まで送った人の線形の次 = 3。到達層の宣言も 3。
  assert.equal(
    routeFor('delivered').step, 3,
    '到達層の行き先が変わった（R2 の観測方法の説明も直すこと）',
  );
  const { row } = progressAfter({ email: 'deliv-linear@example.com', steps: [1, 2], reaction: DELIVERED });
  assert.equal(row.nextStep, 3);
  // ⚠️ 送信記録（step 番号）だけでは線形と同じに見える。区別できるのは routedBy だけ。
  assert.equal(
    row.routedBy, 'delivered:3',
    'routedBy が無いと、到達層が分岐した証拠がどこにも残らない',
  );
});

test('【最重要】opened の行き先は線形を飛び越す（送信記録だけで分岐と分かる唯一の層）', () => {
  const { row } = progressAfter({ email: 'open-skip@example.com', steps: [1, 2], reaction: OPENED });
  assert.equal(row.nextStep, 5);
  assert.ok(row.nextStep > 3, '開封層が線形の次より先へ行っていない');
  // step3 / step4 を飛ばしている = 送信記録の上でも線形と違うと分かる
  assert.ok(![3, 4].includes(row.nextStep), '開封層が step3/4 を飛ばしていない');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 2 つの層は同時には届かない（観測できる時期が違う）
// ══════════════════════════════════════════════════════════════════

test('【最重要】開封層の方が到達層より遅れて期限が来る（delayDays が違う）', () => {
  const dDelivered = stepDelayDays(campaign, routeFor('delivered').step);
  const dOpened = stepDelayDays(campaign, routeFor('opened').step);
  assert.equal(dDelivered, 3, '到達層の待機日数が変わっている');
  assert.equal(dOpened, 14, '開封層の待機日数が変わっている');
  assert.ok(
    dOpened > dDelivered,
    '開封層が先に来る前提になっている（R2 の観測時期の説明と合わない）',
  );
});

test('【最重要】step2 直後はどちらの層もまだ期限が来ていない', () => {
  // 最後の送信が「いま」なら、3 通目の期限は待機日数ぶん先
  for (const [label, reaction] of [['opened', OPENED], ['delivered', DELIVERED]]) {
    const { row } = progressAfter({
      email: `just-${label}@example.com`, steps: [1, 2], reaction, lastAtMs: NOW,
    });
    assert.equal(row.status, 'waiting', `${label}: step2 の直後に期限が来ている`);
    const want = stepDelayDays(campaign, row.nextStep);
    assert.equal(
      row.nextSendAtMs, NOW + want * DAY,
      `${label}: 次の期限が「最後の送信 + 行き先の待機日数」になっていない`,
    );
  }
});

// ══════════════════════════════════════════════════════════════════
//  ④ 宣言そのものの健全性（行き先が実在し、上限を超えない）
// ══════════════════════════════════════════════════════════════════

test('【重要】route の行き先は実在の step で maxSends を超えない', () => {
  const max = resolveMaxSends(campaign);
  const steps = getSequenceSteps(campaign).map((s) => s.stepNumber);
  for (const r of campaign.sequence.responseRoutes) {
    assert.ok(steps.includes(r.step), `存在しない step ${r.step} へ送ろうとしている`);
    assert.ok(r.step <= max, `maxSends(${max}) を超える step ${r.step}`);
  }
});

test('【重要】clicked は宣言しない（provider 側 tracking が OFF で成立しない）', () => {
  const when = campaign.sequence.responseRoutes.map((r) => r.when);
  assert.ok(!when.includes('clicked'), '成立しない条件を route に宣言している');
});

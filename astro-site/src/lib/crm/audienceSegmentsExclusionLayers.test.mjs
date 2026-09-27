/**
 * `resolveSegmentExclusion` を「基本的な送信可否（resolveBaseExclusion）」と
 * 「施策側の制約」の 2 層へ分けたあとも、**セグメント配信の判定が 1 件も変わらない**ことを固定する。
 *
 * 比較相手は分割前の `evaluateSegment` に書かれていた判定をそのまま写した凍結コピー。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSegmentExclusion, resolveBaseExclusion, BASE_EXCLUSION_CODES, SEG_EXCLUDE,
} from './audienceSegments.js';
import { checkSelectable } from '../comeback/comebackGrantPlan.js';
import { isRecentMarketingContact } from '../marketing/campaignSend.js';

/** 分割前の判定（2026-09-27 時点の evaluateSegment 内の順序をそのまま凍結） */
function legacyExclusion({ f, e, mk, duplicate, hard, soft, provider, delivered, contact, engagementBlocked, now }) {
  if (duplicate) return SEG_EXCLUDE.DUPLICATE_EMAIL;
  if (mk.suppressionReasons.includes('invalid_email')) return SEG_EXCLUDE.INVALID_EMAIL;
  const sel = checkSelectable(f, { duplicateEmail: false });
  if (!sel.ok) {
    return sel.reason === 'force_logout_blocked' ? SEG_EXCLUDE.FORCE_LOGOUT
      : sel.reason === 'account_suspended' ? SEG_EXCLUDE.SUSPENDED_OR_TEST
        : SEG_EXCLUDE.INVALID_EMAIL;
  }
  if (mk.suppressionReasons.includes('unsubscribed')) return SEG_EXCLUDE.UNSUBSCRIBED;
  if (hard.has(e)) return SEG_EXCLUDE.BLACKLIST_HARD;
  if (soft.has(e)) return SEG_EXCLUDE.BLACKLIST_SOFT;
  if (provider === null) return SEG_EXCLUDE.PROVIDER_UNKNOWN;
  if (provider.has(e)) return SEG_EXCLUDE.PROVIDER_SUPPRESSED;
  if (mk.premiumActive || mk.lightActive) return SEG_EXCLUDE.PAID_MEMBER;
  if (delivered.has(e)) return SEG_EXCLUDE.ALREADY_DELIVERED;
  if (isRecentMarketingContact({ lastSentAtMs: contact.get(e) ?? null, nowMs: now })) return SEG_EXCLUDE.RECENT_CONTACT;
  if (engagementBlocked.has(e)) return SEG_EXCLUDE.ENGAGEMENT_BLOCKED;
  return null;
}

const NOW = Date.parse('2026-09-27T03:00:00Z');
const E = 'a@example.jp';

function* matrix() {
  const fieldsVariants = [
    { Email: E }, { Email: E, Status: 'suspended' }, { Email: E, Status: 'test' },
    { Email: E, ForceLogout: true }, { Email: 'bad' },
  ];
  const mkVariants = [
    { suppressionReasons: [] }, { suppressionReasons: ['invalid_email'] }, { suppressionReasons: ['unsubscribed'] },
    { suppressionReasons: [], premiumActive: true }, { suppressionReasons: [], lightActive: true },
  ];
  const on = (b) => (b ? new Set([E]) : new Set());
  for (const f of fieldsVariants) for (const mk of mkVariants) for (const duplicate of [false, true])
    for (const h of [false, true]) for (const so of [false, true]) for (const pv of ['null', 'no', 'yes'])
      for (const d of [false, true]) for (const c of [null, NOW - 3600e3, NOW - 30 * 86400e3]) for (const eb of [false, true]) {
        yield {
          f, e: E, mk, duplicate, hard: on(h), soft: on(so),
          provider: pv === 'null' ? null : on(pv === 'yes'),
          delivered: on(d), contact: c === null ? new Map() : new Map([[E, c]]), engagementBlocked: on(eb), now: NOW,
        };
      }
}

test('resolveSegmentExclusion は分割前の判定と全組み合わせで一致する', () => {
  let n = 0;
  for (const x of matrix()) {
    const got = resolveSegmentExclusion({
      fields: x.f, email: x.e, marketing: x.mk, duplicate: x.duplicate,
      blacklistHard: x.hard, blacklistSoft: x.soft, providerSuppressed: x.provider,
      deliveredEmails: x.delivered, lastContactAtMs: x.contact, engagementBlockedEmails: x.engagementBlocked, nowMs: x.now,
    });
    assert.equal(got, legacyExclusion(x), JSON.stringify({ ...x, hard: [...x.hard], soft: [...x.soft] }));
    n += 1;
  }
  assert.ok(n > 1000);
});

test('resolveBaseExclusion は施策側の理由（有料・反応なし・直近・既送信）を返さない', () => {
  for (const x of matrix()) {
    const got = resolveBaseExclusion({
      fields: x.f, email: x.e, marketing: x.mk, duplicate: x.duplicate,
      blacklistHard: x.hard, blacklistSoft: x.soft, providerSuppressed: x.provider,
      deliveredEmails: x.delivered, lastContactAtMs: x.contact, engagementBlockedEmails: x.engagementBlocked, nowMs: x.now,
    });
    if (got !== null) assert.ok(BASE_EXCLUSION_CODES.includes(got), got);
    // 基本側で落ちなかった人だけが施策側の判定へ進む
    const seg = resolveSegmentExclusion({
      fields: x.f, email: x.e, marketing: x.mk, duplicate: x.duplicate,
      blacklistHard: x.hard, blacklistSoft: x.soft, providerSuppressed: x.provider,
      deliveredEmails: x.delivered, lastContactAtMs: x.contact, engagementBlockedEmails: x.engagementBlocked, nowMs: x.now,
    });
    if (got !== null) assert.equal(seg, got);
  }
  for (const code of [SEG_EXCLUDE.PAID_MEMBER, SEG_EXCLUDE.ENGAGEMENT_BLOCKED, SEG_EXCLUDE.RECENT_CONTACT, SEG_EXCLUDE.ALREADY_DELIVERED]) {
    assert.ok(!BASE_EXCLUSION_CODES.includes(code), code);
  }
});

test('セグメント配信では現役有料会員は従来どおり paid_member（施策側の制約として残る）', () => {
  const x = {
    fields: { Email: E }, email: E, marketing: { suppressionReasons: [], premiumActive: true },
    providerSuppressed: new Set(), nowMs: NOW,
  };
  assert.equal(resolveBaseExclusion(x), null, '基本的な送信可否では落とさない');
  assert.equal(resolveSegmentExclusion(x), SEG_EXCLUDE.PAID_MEMBER, 'セグメント配信では従来どおり除外');
});

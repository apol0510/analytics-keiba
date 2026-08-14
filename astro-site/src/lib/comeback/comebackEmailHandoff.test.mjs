/**
 * comebackEmailHandoff.test.mjs
 *   node --test src/lib/comeback/comebackEmailHandoff.test.mjs
 *
 * 「付与できた人だけが、期限内に 1 回だけ、メール工程へ渡る」ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_TTL_MS, HANDOFF_BLOCK, HANDOFF_BLOCK_LABEL, HANDOFF_STORAGE_KEY,
  collectGrantedRecipients, summarizeGrantKind, buildHandoffTicket, validateHandoffResolution,
  saveHandoff, loadHandoff, markHandoffQueued, clearHandoff, describeHandoff, handoffNote,
  resolveHandoffUrgency,
} from './comebackEmailHandoff.js';

const NOW = Date.parse('2026-08-03T12:00:00+09:00');
const OP = 'cb-light-lifetime-2026-08-03-abcd1234';
const OTHER_OP = 'cb-light-lifetime-2026-08-03-99999999';

/** 付与済み（Light 無期限）の Customers 行 */
const grantedLight = (id, { op = OP, grantedAtMs = NOW - 60_000, revokedAtMs = null } = {}) => ({
  recordId: id,
  fields: {
    Email: `${id}@example.com`,
    LightGrantLifetime: true,
    LightGrantedAt: new Date(grantedAtMs).toISOString(),
    LightGrantOp: op,
    ...(revokedAtMs ? { LightGrantRevokedAt: new Date(revokedAtMs).toISOString() } : {}),
  },
});

/** 付与済み（Premium 30 日） */
const grantedPremium = (id, { op = OP, grantedAtMs = NOW - 60_000 } = {}) => ({
  recordId: id,
  fields: {
    Email: `${id}@example.com`,
    PremiumGrantUntil: new Date(grantedAtMs + 30 * 86400000).toISOString(),
    PremiumGrantedAt: new Date(grantedAtMs).toISOString(),
    PremiumGrantOp: op,
  },
});

/** 付与されなかった行（選択はされたが skip / 失敗） */
const notGranted = (id) => ({ recordId: id, fields: { Email: `${id}@example.com` } });

// ── 付与成功者の導出 ────────────────────────────────────────────

test('全件付与成功 → 成功者全員を引き継ぐ', () => {
  const records = [grantedLight('recA'), grantedLight('recB'), grantedPremium('recC')];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds.sort(), ['recA', 'recB', 'recC']);
  assert.equal(r.byTier.light, 2);
  assert.equal(r.byTier.premium, 1);
});

test('一部付与成功 → 成功者だけを引き継ぐ（失敗・skip は混ざらない）', () => {
  const records = [grantedLight('recA'), notGranted('recB'), notGranted('recC'), grantedLight('recD')];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds.sort(), ['recA', 'recD']);
});

test('全件失敗 → 引き継ぎ対象は 0 件でメール工程へ進めない', () => {
  const records = [notGranted('recA'), notGranted('recB')];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds, []);
  const v = validateHandoffResolution({ ...r, operationId: OP, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.NO_RECIPIENTS);
});

test('別の操作 ID の付与は引き継がない（操作をまたいで混線しない）', () => {
  const records = [grantedLight('recA'), grantedLight('recB', { op: OTHER_OP })];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds, ['recA']);
});

test('取り消し済み（revoke 後）は付与成功者に数えない', () => {
  const records = [
    grantedLight('recA'),
    grantedLight('recB', { grantedAtMs: NOW - 120_000, revokedAtMs: NOW - 60_000 }),
  ];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds, ['recA']);
});

test('recordId が無い行は引き継がない（識別子を推測しない）', () => {
  const broken = { fields: grantedLight('recA').fields };
  const r = collectGrantedRecipients({ records: [broken], operationId: OP, nowMs: NOW });
  assert.deepEqual(r.recordIds, []);
});

test('operationId が空なら 1 件も導出しない（全員が対象になる事故を防ぐ）', () => {
  const records = [grantedLight('recA'), grantedLight('recB')];
  assert.deepEqual(collectGrantedRecipients({ records, operationId: '', nowMs: NOW }).recordIds, []);
  assert.deepEqual(collectGrantedRecipients({ records, nowMs: NOW }).recordIds, []);
});

test('recordId 改ざん: クライアントが渡した ID は導出に一切使われない', () => {
  // 攻撃者が任意の recordId を送っても、Customers 側に operationId が無ければ選ばれない
  const records = [grantedLight('recA'), notGranted('recVICTIM')];
  const r = collectGrantedRecipients({
    records, operationId: OP, nowMs: NOW,
    // 引数として recordIds を受け取らない設計であることの確認も兼ねる
  });
  assert.equal(r.recordIds.includes('recVICTIM'), false);
  assert.deepEqual(r.recordIds, ['recA']);
});

// ── 期限 ────────────────────────────────────────────────────

test('期限内なら受け入れる', () => {
  const r = collectGrantedRecipients({ records: [grantedLight('recA')], operationId: OP, nowMs: NOW });
  const v = validateHandoffResolution({ ...r, operationId: OP, nowMs: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.recipientCount, 1);
  assert.equal(v.expiresAtMs, (NOW - 60_000) + HANDOFF_TTL_MS);
});

test('handoff 期限切れ: 付与時刻から TTL を過ぎたら拒否する', () => {
  const grantedAtMs = NOW - HANDOFF_TTL_MS - 1000;
  const r = collectGrantedRecipients({
    records: [grantedLight('recA', { grantedAtMs })], operationId: OP, nowMs: NOW,
  });
  assert.deepEqual(r.recordIds, ['recA'], '導出自体はできる');
  const v = validateHandoffResolution({ ...r, operationId: OP, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.EXPIRED);
});

test('期限はサーバーが付与時刻で測る（クライアントの申告値を使わない）', () => {
  const grantedAtMs = NOW - HANDOFF_TTL_MS - 1000;
  const r = collectGrantedRecipients({
    records: [grantedLight('recA', { grantedAtMs })], operationId: OP, nowMs: NOW,
  });
  // クライアントが「まだ有効」と主張しても、引数に expiresAt は無いので効かない
  const v = validateHandoffResolution({
    operationId: OP, recordIds: r.recordIds, latestGrantedAtMs: r.latestGrantedAtMs, nowMs: NOW,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.EXPIRED);
});

test('付与時刻が読めないときは受け入れない（fail closed）', () => {
  const v = validateHandoffResolution({
    operationId: OP, recordIds: ['recA'], latestGrantedAtMs: null, nowMs: NOW,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.EXPIRED);
});

test('operationId が空なら受け入れない', () => {
  const v = validateHandoffResolution({
    operationId: '', recordIds: ['recA'], latestGrantedAtMs: NOW, nowMs: NOW,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.MALFORMED);
});

// ── 引き継ぎ票（応答に載せる値） ──────────────────────────────────

test('引き継ぎ票に PII を載せない', () => {
  const t = buildHandoffTicket({
    operationId: OP, grantedCount: 3, selectedCount: 5, skippedCount: 2,
    skippedDetail: [{ reason: 'already_granted', label: '同じ特典を既に保有', count: 2 }],
    nowMs: NOW,
  });
  const serialized = JSON.stringify(t);
  assert.equal(/@example\.com|Email|recordId|rec[A-Z]/.test(serialized), false, 'PII / recordId が混ざっている');
  assert.equal(t.grantedCount, 3);
  assert.equal(t.notGrantedCount, 2);
  assert.equal(t.canHandoff, true);
  assert.equal(t.expiresAtMs, NOW + HANDOFF_TTL_MS);
});

test('付与 0 件の引き継ぎ票はメール工程へ進めない', () => {
  const t = buildHandoffTicket({ operationId: OP, grantedCount: 0, selectedCount: 4, skippedCount: 4, nowMs: NOW });
  assert.equal(t.canHandoff, false);
  assert.equal(t.blockReason, HANDOFF_BLOCK.NO_RECIPIENTS);
});

test('引き継がれない理由は件数付きの集計だけ（0 件の理由は落とす）', () => {
  const t = buildHandoffTicket({
    operationId: OP, grantedCount: 1, skippedCount: 1,
    skippedDetail: [
      { reason: 'already_granted', label: '同じ特典を既に保有', count: 1 },
      { reason: 'unsubscribed', label: '配信停止', count: 0 },
    ],
    nowMs: NOW,
  });
  assert.deepEqual(t.notGrantedReasons.map((r) => r.reason), ['already_granted']);
});

// ── ブラウザ側の一時保存 ────────────────────────────────────────

/** sessionStorage 互換のダミー（1 タブ ＝ 1 インスタンス） */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => [...m.entries()],
  };
}

test('保存 → 読み出しで引き継げる（同じタブの再読み込みに耐える）', () => {
  const s = fakeStorage();
  const t = buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW });
  assert.equal(saveHandoff(s, t), true);
  // 再読み込み ＝ 同じ storage から読み直すだけ
  const r = loadHandoff(s, NOW + 60_000);
  assert.equal(r.ok, true);
  assert.equal(r.handoff.operationId, OP);
  assert.equal(r.handoff.grantedCount, 2);
});

test('保存値に PII も recordId も入らない', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  const raw = s.getItem(HANDOFF_STORAGE_KEY);
  assert.equal(/@|Email|recordId|rec[A-Z]/.test(raw), false, `保存値に PII が入っている: ${raw}`);
});

test('異なる管理セッション（別タブ）からは引き継げない', () => {
  const tabA = fakeStorage();
  const tabB = fakeStorage();
  saveHandoff(tabA, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  const r = loadHandoff(tabB, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, HANDOFF_BLOCK.NONE);
});

test('handoff 期限切れ（ブラウザ側でも失効する）', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  const r = loadHandoff(s, NOW + HANDOFF_TTL_MS + 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, HANDOFF_BLOCK.EXPIRED);
});

test('handoff 再利用: キュー登録後は同じ引き継ぎを使い回せない', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  assert.equal(loadHandoff(s, NOW).ok, true);
  markHandoffQueued(s, ['mkt-general-announcement-v1-abcdef12-1']);
  const r = loadHandoff(s, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, HANDOFF_BLOCK.ALREADY_QUEUED);
});

test('キュー登録後の重複登録防止は再読み込みしても効く', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  markHandoffQueued(s, ['job-1']);
  // 再読み込み相当（同じ storage を読み直す）
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.ALREADY_QUEUED);
});

test('二重クリック: 同じジョブ ID を 2 回記録しても 1 件のまま', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  markHandoffQueued(s, ['job-1']);
  markHandoffQueued(s, ['job-1']);
  const parsed = JSON.parse(s.getItem(HANDOFF_STORAGE_KEY));
  assert.deepEqual(parsed.queuedJobIds, ['job-1']);
});

test('壊れた保存値は malformed（黙って通さない）', () => {
  const s = fakeStorage();
  s.setItem(HANDOFF_STORAGE_KEY, '{not json');
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.MALFORMED);
  s.setItem(HANDOFF_STORAGE_KEY, JSON.stringify({ grantedCount: 5 }));
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.MALFORMED);
});

test('付与 0 件の保存値は引き継げない', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 0, nowMs: NOW }));
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.NO_RECIPIENTS);
});

test('clearHandoff で引き継ぎを捨てられる', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  clearHandoff(s);
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.NONE);
});

test('storage が使えない環境でも落ちない', () => {
  assert.equal(saveHandoff(null, buildHandoffTicket({ operationId: OP, grantedCount: 1, nowMs: NOW })), false);
  assert.equal(loadHandoff(null, NOW).reason, HANDOFF_BLOCK.NONE);
  assert.equal(markHandoffQueued(null, ['x']), false);
  assert.equal(clearHandoff(null), false);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(loadHandoff(throwing, NOW).reason, HANDOFF_BLOCK.NONE);
});

// ── 表示・監査 ────────────────────────────────────────────────

test('すべての理由コードに画面文言がある', () => {
  for (const code of Object.values(HANDOFF_BLOCK)) {
    assert.ok(HANDOFF_BLOCK_LABEL[code], `${code} の文言が無い`);
  }
});

test('要約に人数と残り時間を出し、アドレスは出さない', () => {
  const t = buildHandoffTicket({ operationId: OP, grantedCount: 3, nowMs: NOW });
  const s = describeHandoff(t, NOW);
  assert.match(s, /付与成功 3 名/);
  // 「約 1440 分」では緊急かどうか読み取れないので時間単位にする
  assert.match(s, /期限まで 残り 約24 時間/);
  assert.equal(s.includes('@'), false);
  // 内部 ID を画面に出さない（スクリーンショット・ログに残さない）
  assert.equal(s.includes(OP), false, 'operationId が要約に出ている');
  assert.equal(describeHandoff(null, NOW), '引き継ぎなし');
});

test('監査用の印は operationId だけを含む', () => {
  assert.equal(handoffNote(OP), `handoff:${OP}`);
  assert.equal(handoffNote(''), '');
});


// ── 期限（2026-08-03 に 2 時間 → 24 時間へ延長）────────────────────

test('引き継ぎの有効期間は 24 時間', () => {
  assert.equal(HANDOFF_TTL_MS, 24 * 60 * 60 * 1000);
});

test('24 時間以内なら引き継げる（当日中に案内を出す運用に収まる）', () => {
  const grantedAtMs = NOW - 20 * 60 * 60 * 1000;      // 20 時間前の付与
  const r = collectGrantedRecipients({
    records: [grantedLight('recA', { grantedAtMs })], operationId: OP, nowMs: NOW,
  });
  const v = validateHandoffResolution({ ...r, operationId: OP, nowMs: NOW });
  assert.equal(v.ok, true, '24 時間以内なのに失効している');
});

test('24 時間を過ぎたら失効する（無期限にはしない）', () => {
  const grantedAtMs = NOW - 24 * 60 * 60 * 1000 - 60_000;
  const r = collectGrantedRecipients({
    records: [grantedLight('recA', { grantedAtMs })], operationId: OP, nowMs: NOW,
  });
  const v = validateHandoffResolution({ ...r, operationId: OP, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, HANDOFF_BLOCK.EXPIRED);
});

test('期限を延ばしても使い切りと別タブ不可は変わらない', () => {
  const s = fakeStorage();
  saveHandoff(s, buildHandoffTicket({ operationId: OP, grantedCount: 2, nowMs: NOW }));
  markHandoffQueued(s, ['job-1']);
  assert.equal(loadHandoff(s, NOW).reason, HANDOFF_BLOCK.ALREADY_QUEUED, '使い切りが効いていない');
  assert.equal(loadHandoff(fakeStorage(), NOW).reason, HANDOFF_BLOCK.NONE, '別タブから引き継げてしまう');
});

// ── 配った特典の種別（再引き継ぎで文面を選ぶために使う）──────────────

test('30 日無料の付与を「30 日」と読む', () => {
  const grantedAtMs = NOW - 60_000;
  const records = [1, 2, 3].map((i) => ({
    recordId: `rec${i}`,
    fields: {
      LightGrantUntil: new Date(grantedAtMs + 30 * 86400000).toISOString(),
      LightGrantedAt: new Date(grantedAtMs).toISOString(),
      LightGrantOp: OP,
    },
  }));
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.equal(r.kinds.light.count, 3);
  assert.equal(r.kinds.light.lifetime, false);
  assert.equal(r.kinds.light.durationDays, 30);
  assert.equal(r.kinds.light.mixed, false);
});

test('永久無料の付与を「無期限」と読む', () => {
  const r = collectGrantedRecipients({
    records: [grantedLight('recA'), grantedLight('recB')], operationId: OP, nowMs: NOW,
  });
  assert.equal(r.kinds.light.lifetime, true);
  assert.equal(r.kinds.light.durationDays, null);
  assert.equal(r.kinds.light.mixed, false);
});

test('種別が混在していたら mixed（自動判定させない）', () => {
  const grantedAtMs = NOW - 60_000;
  const records = [
    grantedLight('recA', { grantedAtMs }),                       // 永久
    {
      recordId: 'recB',
      fields: {
        LightGrantUntil: new Date(grantedAtMs + 30 * 86400000).toISOString(),
        LightGrantedAt: new Date(grantedAtMs).toISOString(),
        LightGrantOp: OP,
      },
    },                                                            // 30 日
  ];
  const r = collectGrantedRecipients({ records, operationId: OP, nowMs: NOW });
  assert.equal(r.kinds.light.mixed, true);
  assert.equal(r.kinds.light.lifetime, null);
  assert.equal(r.kinds.light.durationDays, null);
});

test('付与が無い tier は null', () => {
  const r = collectGrantedRecipients({ records: [grantedLight('recA')], operationId: OP, nowMs: NOW });
  assert.equal(r.kinds.premium, null);
  assert.equal(summarizeGrantKind([]), null);
});

// ── 引き継ぎ期限の緊急度（2026-08-13 追加）──────────────────────
//
// Light 無料体験の barrier は「Step1 が queue されるまで次の 100 名を止める」。
// 一方で引き継ぎは 24 時間で失効し、復旧口（handoffLatest）も同じ TTL で弾く。
//
// ⚠️ 失効して止まるのは**引き継ぎ経路だけ**（2026-08-14 実測）。
//    Step1 の対象は付与状態から**毎回再導出**されるので、
//    失効後も連続配信の画面から続行できる。
//    それでも残り時間を読み取れる必要はある。近道が使えるうちに済ませたいため。

test('【重要】失効を「約 0 分」と書かない（まだ使えるように読める）', () => {
  const t = { operationId: OP, grantedCount: 10, expiresAtMs: NOW - 60000 };
  const u = resolveHandoffUrgency(t, NOW);
  assert.equal(u.level, 'expired');
  assert.equal(u.remainingText, '失効');
  assert.match(describeHandoff(t, NOW), /失効/);
  assert.equal(/約 ?0 分/.test(describeHandoff(t, NOW)), false, '失効を 0 分と書いている');
  assert.match(u.note, /失効しました/);
});

test('【重要】残り時間から緊急度が分かる（付与直後と失効間際が同じ見た目にならない）', () => {
  const at = (leftMs) => resolveHandoffUrgency(
    { operationId: OP, grantedCount: 10, expiresAtMs: NOW + leftMs }, NOW,
  );
  assert.equal(at(24 * 3600e3).level, 'ok');
  assert.equal(at(4 * 3600e3).level, 'ok');
  assert.equal(at(3 * 3600e3).level, 'soon');
  assert.equal(at(31 * 60e3).level, 'soon');
  assert.equal(at(30 * 60e3).level, 'critical');
  assert.equal(at(60e3).level, 'critical');
  // 緊急のときは「何をすべきか」を出す
  assert.match(at(10 * 60e3).note, /Step1/);
  assert.match(at(2 * 3600e3).note, /Step1/);
  assert.equal(at(24 * 3600e3).note, null, '余裕があるのに警告を出している');
});

test('残り時間は人が読める単位にする', () => {
  const txt = (leftMs) => resolveHandoffUrgency(
    { operationId: OP, grantedCount: 1, expiresAtMs: NOW + leftMs }, NOW,
  ).remainingText;
  assert.equal(txt(24 * 3600e3), '残り 約24 時間');
  assert.equal(txt(90 * 60e3), '残り 約1 時間 30 分');
  assert.equal(txt(45 * 60e3), '残り 約45 分');
});

test('期限が読めない票は「まだ使える」と見せない（fail closed）', () => {
  for (const bad of [undefined, null, 0, NaN, 'いつか']) {
    const u = resolveHandoffUrgency({ operationId: OP, grantedCount: 5, expiresAtMs: bad }, NOW);
    assert.equal(u.level, 'expired', `期限 ${String(bad)} を有効扱いしている`);
    assert.match(u.note, /連続配信/, '生きている復旧経路を案内していない');
  }
});

test('引き継ぎが無いときは none（警告も出さない）', () => {
  const u = resolveHandoffUrgency(null, NOW);
  assert.equal(u.level, 'none');
  assert.equal(u.note, null);
  assert.equal(u.remainingText, '引き継ぎなし');
});

test('緊急度の文言にアドレス・内部 ID を含めない', () => {
  const t = { operationId: OP, grantedCount: 10, expiresAtMs: NOW + 60000 };
  const u = resolveHandoffUrgency(t, NOW);
  for (const s of [u.remainingText, u.note || '']) {
    assert.equal(s.includes(OP), false, '内部 ID が出ている');
    assert.equal(s.includes('@'), false);
  }
});

// ══════════════════════════════════════════════════════════════
//  失効時に「もう案内できない」と読ませない
//
//  2026-08-14 本番実測: 引き継ぎが失効しても Step1 のキュー登録は続けられる。
//  連続配信の受信者はキャンペーンの宣言から**毎回導出**され、引き継ぎ票に
//  依存しないため（失効後に 10 名が due 10 / next step 1 で解決されるのを確認）。
//  ここで「作れません」と書くと、生きている経路を見落とさせる。
// ══════════════════════════════════════════════════════════════
test('【重要】失効しても「案内は続けられる」と伝える（詰みだと読ませない）', () => {
  const u = resolveHandoffUrgency({ operationId: OP, grantedCount: 10, expiresAtMs: NOW - 1 }, NOW);
  assert.equal(u.level, 'expired');
  assert.equal(u.remainingText, '失効', '失効を「約 0 分」と書いている');
  assert.match(u.note, /続けられます/, '詰んだように読める');
  assert.match(u.note, /連続配信/, '生きている復旧経路を案内していない');
  // 取り直せないものを「取り直せ」と言わない
  assert.ok(!/カムバック特典タブから引き継ぎ直/.test(u.note),
    '失効した操作は取り直せない（同じ TTL で 410）のに再取得を勧めている');
});

test('【重要】失効の説明が「案内を作れない」と断定していない', () => {
  const u = resolveHandoffUrgency({ operationId: OP, grantedCount: 10, expiresAtMs: NOW - 1 }, NOW);
  assert.ok(!/案内を作れません/.test(u.note), '事実と違う断定が戻っている');
});

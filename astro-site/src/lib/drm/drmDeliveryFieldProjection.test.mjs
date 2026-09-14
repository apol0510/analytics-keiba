/**
 * drmDeliveryFieldProjection.test.mjs — **送信済みの人を「未送信」に見せない**
 *   node --test src/lib/drm/drmDeliveryFieldProjection.test.mjs
 *
 * ── 何が起きていたか（2026-09-14 実測 / 主事故とは独立）────────────
 * step1 を受け取った 13 名が `drmProgress` で `sentByStep: 0`・step1 に due と表示され、
 * `touchMeasurementPage` でも `touches: []` だった。配信行そのものは正しく、
 * **保存された `DeliveryKey` は step1 の鍵と一致していた**（実データで検証済み）。
 *
 * 原因は**読み取り側のフィールド射影漏れ**:
 *   `fetchDeliveryPage` が `EmailType` を要求していなかった
 *   → Airtable は要求しなかった項目を返さない
 *   → `indexDeliveries()` の `EmailType !== 'campaign'` で**全行が捨てられる**
 *
 * ⚠️ 表示だけの不具合だが、**送信済みを未送信に見せる**ので、
 *    運用者が「まだ送っていない」と誤認して撃ち直す危険がある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { indexDeliveries } from '../marketing/sequenceProgress.js';

const ADMIN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');

const row = (over = {}) => ({
  fields: {
    DeliveryKey: 'a'.repeat(64),
    CampaignType: 'free-signup-onboarding:v1',
    EmailType: 'campaign',
    Status: 'sent',
    SentAt: '2026-09-14T15:00:00.000Z',
    RecipientEmail: 's@example.com',
    ...over,
  },
});

test('【本件】EmailType が欠けた行は索引から落ちる（＝未送信に見える）', () => {
  const withType = indexDeliveries([row()]);
  assert.equal(withType.size, 1, '正しい行が索引に入らない');

  const f = { ...row().fields };
  delete f.EmailType;                     // Airtable が返さなかった状態を再現
  const without = indexDeliveries([{ fields: f }]);
  assert.equal(without.size, 0, '前提が変わった（EmailType 無しでも入るようになった）');
});

test('【最重要】配信行の取得は EmailType を必ず要求する', () => {
  const i = ADMIN.indexOf('async function fetchDeliveryPage');
  assert.ok(i > 0, 'fetchDeliveryPage が無い');
  const body = ADMIN.slice(i, i + 900);
  const m = body.match(/for \(const f of \[([^\]]+)\]\)/);
  assert.ok(m, 'フィールド一覧が読めない');
  const fields = m[1].split(',').map((x) => x.trim().replace(/['"]/g, ''));
  assert.ok(fields.includes('EmailType'),
    `EmailType を要求していない（現在: ${fields.join(', ')}）。全行が索引から落ちる`);
  // 進行の判定に要る項目が揃っているか
  for (const need of ['DeliveryKey', 'Status', 'SentAt', 'QueuedAt', 'RecipientEmail']) {
    assert.ok(fields.includes(need), `${need} が欠けている`);
  }
});

test('【契約】索引が要求する項目と、取得する項目が食い違わない', () => {
  // indexDeliveries が見る項目（実装と一致させる）
  const used = ['EmailType', 'DeliveryKey', 'Status', 'SentAt', 'QueuedAt'];
  const i = ADMIN.indexOf('async function fetchDeliveryPage');
  const m = ADMIN.slice(i, i + 900).match(/for \(const f of \[([^\]]+)\]\)/);
  const fields = m[1].split(',').map((x) => x.trim().replace(/['"]/g, ''));
  for (const u of used) {
    assert.ok(fields.includes(u), `索引が見る ${u} を取得していない`);
  }
});

/**
 * campaignAudienceFormula.test.mjs — 連続配信の受信対象を**取りこぼさず**絞れること
 *   node --test src/lib/marketing/campaignAudienceFormula.test.mjs
 *
 * 2026-08-13 の事故: `handleSequence` / `handlePlan`（引き継ぎ）が Customers を
 * 無フィルタで全件走査し先頭 4,000 件で打ち切っていたため、**Light 付与 10 名のうち
 * 2 名しか見えなかった**。その状態で queue を積むと 8 名へ案内が飛ばない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildCampaignAudienceFormula, campaignAudienceFormulaAccepts,
  buildGrantOperationFormula, grantOperationFormulaAccepts, escapeFormulaValue,
} from './campaignAudienceFormula.js';
import { getCampaign } from './campaignCatalog.js';
import { buildSequenceProgress, SEQ_STOP } from './sequenceProgress.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';

const TRIAL = getCampaign('light-trial-to-premium-sequence');
const NOW = Date.parse('2026-08-13T02:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString();

// ── 🛡️ 超集合: 送れる人を絶対に落とさない ─────────────────────
test('【最重要】実際に送れる人を formula が落とさない（総当たり）', () => {
  const axes = {
    Source: ['customer-import:imp-2026-08-09-001', 'nankan-analytics', ''],
    Email: ['a@example.com'],
    LightGrantedAt: [undefined, day(-3)],
    LightGrantUntil: [undefined, day(20), day(-1)],
    LightGrantLifetime: [undefined, true],
    LightGrantRevokedAt: [undefined, day(-1)],
    'プラン': ['Free', 'Premium'],
    Status: [undefined, 'active'],
  };
  const keys = Object.keys(axes);
  let checked = 0;
  let sendable = 0;

  const walk = (i, acc) => {
    if (i === keys.length) {
      const fields = {};
      for (const [k, v] of Object.entries(acc)) if (v !== undefined) fields[k] = v;
      checked += 1;
      const marketing = resolveCustomerMarketing({ fields, nowMs: NOW, blacklistEmails: new Set() });
      const progress = buildSequenceProgress({
        campaign: TRIAL,
        selected: [{ recordId: 'rec1', fields, marketing }],
        deliveries: [],
        brand: 'analytics-keiba',
        fromEmail: 'noreply@keiba.link',
        nowMs: NOW,
      });
      if (!progress.ok) return;
      const row = (progress.rows || [])[0];
      // **送れる人（stopped でない）を落としたら致命的**。
      // 「10 名付与したのに 2 名しか見えない」はこの性質が壊れた状態だった。
      if (row && row.status !== 'stopped') {
        sendable += 1;
        assert.equal(campaignAudienceFormulaAccepts(TRIAL, fields), true,
          `送れる人を落とした: ${JSON.stringify(fields)}`);
      }
      return;
    }
    for (const v of axes[keys[i]]) walk(i + 1, { ...acc, [keys[i]]: v });
  };
  walk(0, {});
  assert.ok(checked > 100, `総当たりが少なすぎる: ${checked}`);
  assert.ok(sendable > 0, '送れるケースが 1 件も無い（テストが無意味）');
});

test('コホート内で付与の痕跡がある人は、停止理由が何であれ必ず残す', () => {
  const base = { Source: 'customer-import:imp-2026-08-09-001', Email: 'a@example.com' };
  const traces = [
    { LightGrantUntil: day(20) },                 // 体験中
    { LightGrantUntil: day(-1) },                 // 期限切れ
    { LightGrantRevokedAt: day(-1) },             // 取消
    { LightGrantLifetime: true },                 // 期限なし
    { LightGrantedAt: day(-3) },                  // 付与記録のみ
  ];
  for (const t of traces) {
    for (const plan of ['Free', 'Premium']) {
      assert.equal(campaignAudienceFormulaAccepts(TRIAL, { ...base, ...t, 'プラン': plan }), true,
        `落としている: ${JSON.stringify({ ...t, plan })}`);
    }
  }
});

test('付与の痕跡が無い人・コホート外は落とす（15,000 件の大半）', () => {
  assert.equal(campaignAudienceFormulaAccepts(TRIAL, {
    Source: 'customer-import:imp-2026-08-09-001',
  }), false, '付与の痕跡が無いのに通している');
  assert.equal(campaignAudienceFormulaAccepts(TRIAL, {
    Source: 'nankan-analytics', LightGrantUntil: day(20),
  }), false, 'コホート外なのに通している');
});

test('期限切れ・取消・期限なしは**残す**（理由付きで数えたい）', () => {
  const base = { Source: 'customer-import:imp-2026-08-09-001' };
  for (const extra of [
    { LightGrantUntil: day(-1) },          // grant_expired
    { LightGrantRevokedAt: day(-1) },      // grant_revoked
    { LightGrantLifetime: true },          // grant_lifetime
    { LightGrantedAt: day(-3) },
  ]) {
    assert.equal(campaignAudienceFormulaAccepts(TRIAL, { ...base, ...extra }), true,
      `落としている: ${JSON.stringify(extra)}`);
  }
});

test('送信停止の判定は formula に持ち込まない（既存の単一源のまま）', () => {
  const f = buildCampaignAudienceFormula(TRIAL).formula;
  for (const banned of ['Unsubscribed', 'Withdrawal', 'engagement', 'Engagement', 'Blacklist']) {
    assert.equal(f.includes(banned), false, `送信停止の判定が formula に混入: ${banned}`);
  }
});

test('宣言が無いキャンペーンは null（= 呼び出し側が fail closed）', () => {
  assert.equal(buildCampaignAudienceFormula({ campaignId: 'x' }), null);
  assert.equal(buildCampaignAudienceFormula(null), null);
});

// ── formula の健全性 ─────────────────────────────────────────
test('【本番で 422 にしない】formula が構文として壊れていない', () => {
  for (const f of [buildCampaignAudienceFormula(TRIAL).formula, buildGrantOperationFormula('light-trial-2026-08-13')]) {
    let depth = 0; let inStr = false;
    for (const ch of f) {
      if (ch === "'") { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      assert.ok(depth >= 0);
    }
    assert.equal(depth, 0);
    assert.equal(inStr, false);
    const masked = f.replace(/'[^']*'/g, '§');
    assert.equal(/§\s*[A-Za-z_(]/.test(masked), false, '区切り落ち');
  }
});

test('【Airtable の罠】!= BLANK() を使っていない', () => {
  assert.equal(/!=\s*BLANK\(\)/.test(buildCampaignAudienceFormula(TRIAL).formula), false);
});

test('引き継ぎは operationId で名指しする', () => {
  const f = buildGrantOperationFormula('light-trial-2026-08-13');
  assert.match(f, /LightGrantOp/);
  assert.match(f, /PremiumGrantOp/);
  assert.equal(grantOperationFormulaAccepts('light-trial-2026-08-13', { LightGrantOp: 'light-trial-2026-08-13' }), true);
  assert.equal(grantOperationFormulaAccepts('light-trial-2026-08-13', { LightGrantOp: 'other' }), false);
  assert.equal(buildGrantOperationFormula(''), null);
});

test('formula へ入れる値はエスケープする', () => {
  assert.equal(escapeFormulaValue("a'b"), "a\\'b");
  const f = buildGrantOperationFormula("op'injected");
  assert.match(f, /op\\'injected/);
});

// ── Function 側の配線 ──────────────────────────────────────────
const FN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
const code = FN.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const slice = (name) => {
  const i = code.indexOf(`async function ${name}`);
  const rest = code.slice(i + 10);
  const end = rest.indexOf('\nasync function ');
  return rest.slice(0, end > 0 ? end : rest.length);
};

test('【配線】sequence は受信対象だけを読む（全件走査へ戻さない）', () => {
  const body = slice('handleSequence');
  assert.match(body, /loadCampaignAudience\(/);
  assert.equal(/loadCustomerMarketing\(/.test(body), false, '全件走査へ戻っている');
});

test('【配線】引き継ぎは operationId で名指しする（全件走査しない）', () => {
  const body = slice('handlePlan');
  assert.match(body, /buildGrantOperationFormula\(/);
  assert.equal(/loadCustomerMarketing\(/.test(body), false, '引き継ぎが全件走査へ戻っている');
});

test('【安全】部分集合のまま集計・dry-run・queue へ進まない（fail closed）', () => {
  const loader = slice('loadCampaignAudience');
  assert.match(loader, /audience_scan_limit/);
  assert.match(loader, /audience_not_narrowable/);
  // 読み取りは GET のまま（非 GET を出さない不変条件を smoke test が守っている）
  assert.equal(/method: 'POST'/.test(loader), false, '読み取りが POST になっている');
  // 上限で break して records を返す形が無いこと
  assert.equal(/pages >= MAX_PAGES\)\s*break/.test(loader), false, '黙って打ち切っている');

  const seq = slice('handleSequence');
  assert.match(seq, /if \(!audience\.ok\)/);
  assert.match(seq, /sideEffects: 'none'/);
  // 取得に失敗したら progress を作らない = queue 候補も出さない
  const okIdx = seq.indexOf('if (!audience.ok)');
  const progIdx = seq.indexOf('buildSequenceProgress(');
  assert.ok(okIdx > 0 && progIdx > okIdx, '取得の成否を確認する前に集計している');

  const plan = slice('handlePlan');
  const opIdx = plan.indexOf('if (!opAudience.ok)');
  const targetIdx = plan.indexOf('targetIds = resolved.recordIds');
  assert.ok(opIdx > 0 && targetIdx > opIdx, '取得の成否を確認する前に送信対象を確定している');
});

test('【配線】並び順を固定して Airtable の既定順に依存しない', () => {
  const loader = slice('loadCampaignAudience');
  assert.match(loader, /sort\[0\]\[field\]/);
  assert.match(loader, /'Email'/);
  assert.match(loader, /'asc'/);
});

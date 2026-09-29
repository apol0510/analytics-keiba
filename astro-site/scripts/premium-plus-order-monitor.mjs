#!/usr/bin/env node
/**
 * Premium Plus 注文の監視（毎時・premium-plus-order-monitor.yml から呼ぶ）
 *
 * 出力: --out に {ok, actions[], fingerprint, body}。Issue の開閉は workflow が行う。
 * 失敗（鍵なし・API 不通）は ok:false と理由を出して exit 2。
 */
import { writeFileSync } from 'node:fs';
import { fetchPlusOrderSummary } from '../src/lib/ops/plusOrderCheck.js';
import { operatorActions, actionsFingerprint } from '../src/lib/premiumPlus/premiumPlusOrderMonitor.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const out = arg('--out') || '/tmp/plus-order-monitor.json';
const siteUrl = process.env.SITE_URL || 'https://analytics.keiba.link/';

try {
  const s = await fetchPlusOrderSummary({ siteUrl, secret: process.env.PAYMENT_FUNNEL_READ_SECRET });
  const actions = operatorActions(s);
  const fingerprint = actionsFingerprint(s);
  const body = [
    '## Premium Plus 注文: 対応が必要です',
    '',
    ...actions.map((a) => `- ${a.text}`),
    '',
    `| 未確認 | 確認済み | 取消 | 要修復 | 新系列の購入 | 一致 |`,
    `|---|---|---|---|---|---|`,
    `| ${s.real.awaiting} | ${s.real.confirmed} | ${s.real.cancelled + s.real.revoked} | ${s.real.needsRepair} | ${s.purchase.recorded}（期待 ${s.purchase.expected}）| ${s.consistent ? '✅' : '❌'} |`,
    '',
    `- 更新: ${new Date().toISOString()}（毎時の監視。状態が変わったときだけコメントで通知）`,
    '- 画面: https://analytics.keiba.link/admin/premium-plus-eligibility/ →「🧾 Premium Plus 注文」',
    '- 対応が済むと次の監視で自動的にクローズします。',
    '',
    `<!-- fingerprint:${fingerprint} -->`,
  ].join('\n');
  writeFileSync(out, JSON.stringify({ ok: true, actions, fingerprint, body }, null, 2));
  console.log(JSON.stringify({ ok: true, actions: actions.map((a) => a.key), fingerprint }));
} catch (e) {
  writeFileSync(out, JSON.stringify({ ok: false, code: e?.code || 'unknown', detail: e?.detail || null }));
  console.error(`監視できません: ${e?.code || e?.message}`);
  process.exit(2);
}

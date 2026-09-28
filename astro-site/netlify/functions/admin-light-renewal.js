/**
 * admin-light-renewal.js — Light 月払い リマインドの確認用 API（**読み取り専用**）
 *
 *   POST {action:'dryRun'}   … 今日の対象と段の件数（送信・書き込み 0。env のモードに関係なく dry-run）
 *   POST {action:'report'}   … 送った周期ごとの Light 更新率・Light→Premium 転換率
 * 認可: x-admin-secret（admin-marketing と同じ secret）。アドレスは返さない。
 */
import { runLightRenewal, MODE, resolveMode } from '../../src/lib/marketing/lightRenewal/lightRenewalRunner.js';
import { loadLightRenewalReportData, summarizeLightRenewalOutcomes } from '../../src/lib/marketing/lightRenewal/lightRenewalReport.js';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  try {
    if (req.action === 'dryRun') {
      const r = await runLightRenewal({ mode: MODE.DRY_RUN, env: process.env, nowMs: Date.now() });
      return json(200, { ...r, configuredMode: resolveMode(process.env), sideEffects: 'none' });
    }
    if (req.action === 'report') {
      const data = await loadLightRenewalReportData({
        token: process.env.AIRTABLE_API_KEY, baseId: process.env.AIRTABLE_BASE_ID,
      });
      return json(200, { ...summarizeLightRenewalOutcomes({ ...data, nowMs: Date.now() }), sideEffects: 'none' });
    }
    return json(400, { error: 'action は dryRun / report' });
  } catch (e) {
    return json(500, { error: e && e.code ? e.code : 'error', sideEffects: 'none' });
  }
};

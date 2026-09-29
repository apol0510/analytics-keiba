/**
 * scheduled-checks.mjs — 登録簿 ops/scheduled-checks.json の確認を実行する（workflow scheduled-checks.yml から呼ぶ）
 *
 *   node scripts/scheduled-checks.mjs validate
 *   node scripts/scheduled-checks.mjs plan --completed id1,id2       → 今日の扱い（JSON）
 *   node scripts/scheduled-checks.mjs run <id> --out r.json --md r.md --fail-md f.md
 *
 * 終了コード: 0 = 成功 / 1 = 登録簿の不備 / 2 = 実行失敗 / 3 = 待機中（まだ起きていない・未確定）。2・3 は --fail-md に理由と最小作業を書く
 * 読むだけ。GSC は読み取り専用スコープ。本番の Redis / Airtable / 送信には一切触れない。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRegistry, planToday, jstToday, exitCodeFor, EXIT } from '../src/lib/ops/scheduledChecks.js';
import { createGscClient, GscError } from '../src/lib/ops/gscClient.js';
import { runGscDateArchive, renderMarkdown } from '../src/lib/ops/gscDateArchiveMeasurement.js';
import { runPremiumConversionCheck, renderConversionMarkdown } from '../src/lib/ops/premiumConversionCheck.js';
import { runPaymentFunnelCheck, renderPaymentFunnelMarkdown } from '../src/lib/ops/paymentFunnelCheck.js';
import {
  runPlusFirstOrderCheck, renderPlusFirstOrderMarkdown, runPlusOfferOutcomeCheck, renderPlusOfferOutcomeMarkdown,
} from '../src/lib/ops/plusOrderCheck.js';
import { runLightRenewalOutcomesCheck, renderLightRenewalOutcomesMarkdown } from '../src/lib/ops/lightRenewalOutcomesCheck.js';

const REGISTRY = fileURLToPath(new URL('../../ops/scheduled-checks.json', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const errors = validateRegistry(registry);
if (errors.length) { console.error(`✖ 登録簿の不備:\n- ${errors.join('\n- ')}`); process.exit(1); }

const cmd = process.argv[2];
if (cmd === 'validate') { console.log(`✓ 登録簿 OK（${registry.checks.length} 件）`); process.exit(0); }

if (cmd === 'plan') {
  const completed = new Set(String(arg('--completed') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const today = arg('--today') || jstToday();
  console.log(JSON.stringify({ today, plan: planToday(registry.checks, today, completed) }));
  process.exit(0);
}

/** 失敗理由 → 人が行う最小作業（技術的に自動化できない部分だけ） */
function humanActionFor(code, check) {
  const site = check.compare?.siteUrl;
  switch (code) {
    case 'credentials_missing':
    case 'credentials_invalid_json':
    case 'credentials_incomplete':
      return 'GitHub の repository secret `GSC_SERVICE_ACCOUNT_JSON` にサービスアカウントの JSON 鍵を登録する（Claude が作成・登録できる。必要なのは Google アカウントでの権限付与の承認だけ）。';
    case 'no_property_access':
      return `Search Console の ${site} の「ユーザーと権限」に、サービスアカウントのメールアドレスを「制限付き」で追加する（1 操作）。`;
    case 'airtable_token_missing':
      return 'GitHub の repository secret `AIRTABLE_READONLY_TOKEN` に、analytics-keiba ベースだけを読める Airtable トークン（data.records:read）を登録する。';
    case 'airtable_auth_failed':
      return 'Airtable トークンが無効（削除・権限不足）の可能性。読み取り専用トークンを作り直して secret を更新する。';
    case 'no_reminder_sent_yet':
      return 'なし（まだ Light 月払いリマインドを送っていない）。翌日の定期実行で自動的に再確認する。';
    case 'no_conversion_yet':
      return 'なし（まだ Light→Premium の入金確認が無い）。翌日の定期実行で自動的に再確認する。';
    case 'no_plus_order_yet':
      return 'なし（本物の Premium Plus 注文がまだ無い）。確認のために販売状態・案内は変えない。翌日の定期実行で自動的に再確認する。';
    case 'no_plus_confirmation_yet':
      return 'なし（注文はあるが入金確認待ち）。未確認の注文は毎時の監視 Issue「[Plus 注文] 要対応」で知らせる。入金を確認したら Plus 管理画面で「入金確認」。';
    case 'plus_order_needs_repair':
      return 'Plus 管理画面「🧾 Premium Plus 注文」で要修復の注文の「修復」を押す（未完了の処理だけやり直す・二重には数えない）。';
    case 'plus_purchase_mismatch':
      return '注文と新系列の購入件数が一致しない（計上漏れ・混入・二重計上）。Claude が調査する（admin-payment-funnel plusOrdersSummary で件数を確認できる）。';
    case 'no_application_yet':
    case 'no_confirmation_yet':
      return 'なし（まだ本番の申込受理または入金確認が無い）。翌日の定期実行で自動的に再確認する。';
    case 'funnel_missing_confirmation':
      return 'Airtable では入金確認があるのに計測が 0 件。confirm-bank-payment の Function ログで「決済ファネル（入金確認）」の reason を確認する（Claude が調査できる）。';
    case 'funnel_secret_missing':
      return 'GitHub の repository secret `PAYMENT_FUNNEL_READ_SECRET` を登録する（Netlify production の同名 env と同じ値。Claude が設定できる）。';
    case 'funnel_auth_failed':
      return 'GitHub secret と Netlify production の `PAYMENT_FUNNEL_READ_SECRET` が一致していない。両方を同じ新しい値に揃えて redeploy する（Claude が実施できる）。';
    case 'data_not_ready':
      return 'なし（GSC のデータ確定待ち）。翌日の定期実行で自動的に取り直す。';
    case 'auth_failed':
      return 'サービスアカウントの鍵が無効（削除・期限切れ）の可能性。鍵を作り直して secret を更新する。';
    default:
      return '一時的な API エラーの可能性。翌日の定期実行で自動再試行する（期限内は人の作業不要）。';
  }
}

if (cmd === 'run') {
  const id = process.argv[3];
  const check = registry.checks.find((c) => c.id === id);
  if (!check) { console.error(`✖ 未登録の id: ${id}`); process.exit(1); }
  try {
    let result;
    let md;
    if (check.kind === 'airtable-light-renewal-outcomes') {
      result = await runLightRenewalOutcomesCheck({ check, token: process.env.AIRTABLE_READONLY_TOKEN });
      md = renderLightRenewalOutcomesMarkdown({ check, result });
    } else if (check.kind === 'airtable-premium-conversions') {
      result = await runPremiumConversionCheck({ check, token: process.env.AIRTABLE_READONLY_TOKEN });
      md = renderConversionMarkdown({ check, result });
    } else if (check.kind === 'payment-funnel-first-record') {
      result = await runPaymentFunnelCheck({ check, token: process.env.AIRTABLE_READONLY_TOKEN, secret: process.env.PAYMENT_FUNNEL_READ_SECRET });
      md = renderPaymentFunnelMarkdown({ check, result });
    } else if (check.kind === 'premium-plus-first-order') {
      result = await runPlusFirstOrderCheck({ check, secret: process.env.PAYMENT_FUNNEL_READ_SECRET });
      md = renderPlusFirstOrderMarkdown({ check, result });
    } else if (check.kind === 'premium-plus-offer-outcome') {
      result = await runPlusOfferOutcomeCheck({ check, secret: process.env.PAYMENT_FUNNEL_READ_SECRET });
      md = renderPlusOfferOutcomeMarkdown({ check, result });
    } else if (check.kind === 'gsc-date-archive') {
      const client = createGscClient({ credentials: process.env.GSC_SERVICE_ACCOUNT_JSON, siteUrl: check.compare.siteUrl });
      result = await runGscDateArchive({
        check,
        client,
        fetchSitemap: async () => {
          const r = await fetch(new URL('sitemap-0.xml', check.compare.siteUrl));
          if (!r.ok) throw new GscError('sitemap_unavailable', `HTTP ${r.status}`);
          return r.text();
        },
      });
    }
    if (!md) md = renderMarkdown({ check, result });
    if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify({ id, result }, null, 2));
    if (arg('--md')) writeFileSync(arg('--md'), md);
    console.log(md);
    process.exit(0);
  } catch (e) {
    const code = e?.code || 'unknown';
    const exitCode = exitCodeFor(code);
    const body = [
      `## ${check.title} — ${exitCode === EXIT.PENDING ? '待機中（まだ起きていない・未確定）' : '実行失敗'}`,
      '',
      `- 理由: \`${code}\`${e?.detail ? `（${e.detail}）` : ''}`,
      `- 実行: ${new Date().toISOString()}（GitHub Actions scheduled-checks）`,
      `- 再試行: ${check.runUntil} まで毎日自動で再試行する`,
      '',
      `**必要な最小作業**: ${humanActionFor(code, check)}`,
    ].join('\n');
    if (arg('--fail-md')) writeFileSync(arg('--fail-md'), body);
    console.error(body);
    process.exit(exitCode);
  }
}

console.error('使い方: validate | plan [--completed a,b] | run <id> [--out f] [--md f] [--fail-md f]');
process.exit(1);

#!/usr/bin/env node
/**
 * sendgrid-create-minimal-setup.mjs — AK 用の**最小構成だけ**を SendGrid に作る
 *
 * ## 作るもの（これ以外は作らない）
 *
 * | # | 種類 | 名前 |
 * |---|---|---|
 * | 1 | unsubscribe group | `AK Marketing` |
 * | 2 | custom field | `ak_next_message`（Number）|
 * | 3 | list | `ak-prospect-select-start-1` |
 * | 4 | list | `ak-prospect-select-start-2` |
 * | 5 | list | `ak-prospect-select-start-3` |
 * | 6 | Marketing sender | `KEIBA Analytics`（from `noreply@keiba.link` / reply-to `support@keiba.link`）|
 *
 * **Automation は API で作れない**（公開 API は統計のみ）。画面で作る設定値を最後に表示する。
 *
 * ## 守ること
 *
 * - **既存のものを 1 つも変更・削除しない。** 作るのは上の名前だけで、同じ名前が既にあれば**飛ばす**
 * - **KI の資産（`keiba-intelligence` / `keiba-review` / `nankan*` / `テストグループ`）に触らない**
 * - **contact を 1 件も投入しない**（別の工程・別の承認）
 * - **Automation を live にしない**
 * - 既定は**下見**。`--apply --confirm "CREATE AK MINIMAL SETUP"` を両方渡したときだけ作る
 * - `marketing.write` が無ければ**何も作らない**（fail closed）。片方だけ作られた状態にしない
 *
 * ## 使い方
 *
 * ```bash
 * cd /Users/user/Projects/analytics-keiba
 * # 下見（何も作らない）
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-minimal-setup.mjs
 * # 実行（MK 承認のうえで）
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-minimal-setup.mjs \
 *   --apply --confirm "CREATE AK MINIMAL SETUP"
 * ```
 */

import {
  listNameFor, UNSUBSCRIBE_GROUP_NAME, buildMinimalSetupNames,
} from '../src/lib/marketing/sendgridAutomationPlan.js';
import { buildMessagePlan, TOTAL_MESSAGES } from '../src/lib/marketing/sendgridMessagePlan.js';
import { getBrandConfig } from '../src/lib/newsletter/brand-config.js';

const BRAND = 'analytics-keiba';
const CONFIRM = 'CREATE AK MINIMAL SETUP';
/** 作ってよい名前（**単一源は `sendgridAutomationPlan.js`**） */
const CREATE_ALLOWLIST = buildMinimalSetupNames();
/** 触ってはいけない既存資産の印（名前に含まれていたら**素通りする**） */
const FOREIGN = ['intelligence', 'keiba-review', 'nankan', 'テストグループ', 'review'];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = (() => {
  const i = args.indexOf('--confirm');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();

const KEY = process.env.SENDGRID_API_KEY;
const log = (...a) => console.error(...a);

if (!KEY) { console.error('SENDGRID_API_KEY がありません'); process.exit(2); }

async function sg(method, path, body) {
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}
const get = (p) => sg('GET', p);

const isForeign = (name) => FOREIGN.some((x) => String(name || '').toLowerCase().includes(x.toLowerCase()));

async function main() {
  // ── 0) 権限の確認（**write が無ければ 1 つも作らない**）──────────────
  const scopes = await get('/v3/scopes');
  const all = (scopes.body && scopes.body.scopes) || [];
  const hasRead = all.includes('marketing.read');
  const hasWrite = all.includes('marketing.write');
  const hasAsmCreate = all.includes('asm.groups.create');
  log(`scope: marketing.read=${hasRead} / marketing.write=${hasWrite} / asm.groups.create=${hasAsmCreate}`);

  if (apply && !hasWrite) {
    console.error([
      '❌ marketing.write がありません。**何も作らずに中止します**（片方だけ作らないため）。',
      '   SendGrid 画面 → Settings → API Keys → 「AK SendGrid Production」 → Edit',
      '   → Restricted Access → **Marketing** の行を **Full Access** → Update',
      '   （Automation の行は No Access のままでよい）',
      '   保存後 /v3/scopes に marketing.write が出ることを確認してから再実行してください。',
    ].join('\n'));
    process.exit(2);
  }
  if (apply && confirm !== CONFIRM) {
    console.error(`❌ --confirm "${CONFIRM}" が要ります。何も作っていません。`);
    process.exit(2);
  }

  // ── 1) いまの状態（read-only）────────────────────────────────
  const [groups, fields, lists, senders] = await Promise.all([
    get('/v3/asm/groups'), get('/v3/marketing/field_definitions'),
    get('/v3/marketing/lists?page_size=100'), get('/v3/marketing/senders'),
  ]);
  const groupNames = (Array.isArray(groups.body) ? groups.body : []).map((g) => String(g.name));
  const fieldNames = ((fields.body && fields.body.custom_fields) || []).map((f) => String(f.name));
  const listNames = ((lists.body && lists.body.result) || []).map((l) => String(l.name));
  const senderRows = Array.isArray(senders.body) ? senders.body : [];
  const senderNames = senderRows.map((s) => String(s.nickname));

  const plan = [];
  const push = (kind, name, exists, run) => plan.push({ kind, name, exists, run });

  push('unsubscribe group', CREATE_ALLOWLIST.group, groupNames.includes(CREATE_ALLOWLIST.group),
    () => sg('POST', '/v3/asm/groups', {
      name: CREATE_ALLOWLIST.group,
      description: 'KEIBA Analytics のマーケティングメール（配信停止はここで受ける）',
      is_default: false,
    }));

  push('custom field', CREATE_ALLOWLIST.field, fieldNames.includes(CREATE_ALLOWLIST.field),
    () => sg('POST', '/v3/marketing/field_definitions', {
      name: CREATE_ALLOWLIST.field, field_type: 'Number',
    }));

  for (const name of CREATE_ALLOWLIST.lists) {
    push('list', name, listNames.includes(name),
      () => sg('POST', '/v3/marketing/lists', { name }));
  }

  /**
   * sender は**既存の AK 送信元から住所欄を引き写す**（住所を推測で作らない）。
   * from は AK の正本（`brand-config.js`）。**DeliveryKey に入る値なので勝手に変えない**。
   */
  const brand = getBrandConfig(BRAND);
  const template = senderRows.find((s) => String(s.from && s.from.email).endsWith('@keiba.link'));
  push('sender', CREATE_ALLOWLIST.senderNickname, senderNames.includes(CREATE_ALLOWLIST.senderNickname),
    () => {
      if (!template) return Promise.resolve({ status: 0, body: { errors: [{ message: 'keiba.link の既存 sender が無く住所欄を引き写せない' }] } });
      return sg('POST', '/v3/marketing/senders', {
        nickname: CREATE_ALLOWLIST.senderNickname,
        from: { email: brand.defaultFromEmail, name: brand.defaultFromName },
        reply_to: { email: brand.replyToEmail || 'support@keiba.link', name: '' },
        address: template.address, address_2: template.address_2 || '',
        city: template.city, state: template.state || '', zip: template.zip || '',
        country: template.country,
      });
    });

  // ── 2) 下見 ───────────────────────────────────────────────
  console.log('── 作る予定（既にあるものは飛ばす）──');
  for (const p of plan) {
    console.log(`  ${p.exists ? 'skip（既存）' : '作る      '} : ${p.kind} / ${p.name}`);
  }
  console.log('── 触らない既存資産 ──');
  for (const n of [...groupNames, ...listNames, ...senderNames].filter(isForeign)) console.log(`  そのまま: ${n}`);

  if (!apply) {
    console.log('\n（下見です。--apply --confirm を渡すまで 1 つも作りません）');
    printAutomationSpec();
    return;
  }

  // ── 3) 作成（**作るのは allowlist の名前だけ**）────────────────
  const created = [];
  for (const p of plan) {
    if (p.exists) { created.push({ ...p, result: 'skipped_existing' }); continue; }
    // eslint-disable-next-line no-await-in-loop -- 直列に作る（途中で止めたいので）
    const r = await p.run();
    const ok = r.status >= 200 && r.status < 300;
    created.push({
      kind: p.kind, name: p.name, status: r.status, result: ok ? 'created' : 'failed',
      error: ok ? null : ((r.body && r.body.errors) || []).map((e) => e.message).join(' / ') || null,
    });
    log(`  ${ok ? '✅' : '❌'} ${p.kind} / ${p.name} (${r.status})`);
    if (!ok) { log('  中止します（途中までの状態は上のとおり）'); break; }
  }

  // ── 4) 作ったあとに read-only で確かめる ───────────────────────
  const [g2, f2, l2, s2] = await Promise.all([
    get('/v3/asm/groups'), get('/v3/marketing/field_definitions'),
    get('/v3/marketing/lists?page_size=100'), get('/v3/marketing/senders'),
  ]);
  console.log(JSON.stringify({
    作成結果: created,
    確認: {
      unsubscribeGroup: (Array.isArray(g2.body) ? g2.body : []).map((x) => ({ id: x.id, name: x.name })),
      customField: ((f2.body && f2.body.custom_fields) || []).map((x) => `${x.name}:${x.field_type}`),
      list: ((l2.body && l2.body.result) || []).map((x) => ({ name: x.name, contacts: x.contact_count })),
      sender: (Array.isArray(s2.body) ? s2.body : []).map((x) => ({
        nickname: x.nickname, verified: x.verified && x.verified.status,
      })),
    },
  }, null, 1));
  printAutomationSpec();
}

/** Automation は API で作れないので、画面で入れる値を出す */
function printAutomationSpec() {
  const r = buildMessagePlan();
  if (!r.ok) return;
  console.log('\n── Automation（**画面で作る**。API では作成できない）──');
  for (const start of [1, 2, 3]) {
    const steps = r.plan.filter((p) => p.messageNumber >= start);
    console.log(`  ${listNameFor(start)} を入口にする Automation（${steps.length} 通 / 1 日 1 通）`);
    console.log(`    unsubscribe group: ${UNSUBSCRIBE_GROUP_NAME} / sender: ${CREATE_ALLOWLIST.senderNickname}`);
    for (const s of steps) {
      console.log(`      ${s.messageNumber - start === 0 ? '即時' : `${s.messageNumber - start} 日後`}: `
        + `${s.campaignId} step${s.stepNumber} — ${s.subject}`);
    }
  }
  console.log(`  ⚠️ 合計 ${TOTAL_MESSAGES} 通の文面は `
    + '`node scripts/sendgrid-migration-audit.mjs` と同じ catalog から出す（手で書き直さない）');
}

main().catch((e) => {
  console.error(`create_failed: ${String((e && e.message) || 'unknown').slice(0, 80)}`);
  process.exit(1);
});

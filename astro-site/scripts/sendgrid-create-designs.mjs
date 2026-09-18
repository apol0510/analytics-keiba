#!/usr/bin/env node
/**
 * sendgrid-create-designs.mjs — 書き出し済みの 10 通を **Design Library へ登録する**
 *
 * ## なぜ
 *
 * Automation の各メールに HTML を手で貼ると、10 通 × 3 本 = **27 通ぶんの貼り付け**になり、
 * 途中で 1 文字ずれても誰も気づけない。Design として 1 度だけ登録し、
 * Automation からはそれを選ぶ運用にする（start 1 を作ってから **Duplicate** で 2 / 3 を作る）。
 *
 * ## 守ること
 *
 * - **ファイルの中身を 1 バイトも加工しない**（subject / HTML / text をそのまま送る）
 * - `generate_plain_content: false`（**SendGrid に text を作り直させない**）
 * - **同じ名前の Design が既にあれば作らない**（二重作成しない）
 * - 触るのは `/v3/designs` の **GET と POST だけ**（更新・削除・送信・contact は無い）
 * - 既定は**下見**。`--apply --confirm "CREATE AK DESIGNS"` の両方でだけ作る
 * - 作成後に **GET で 1 件ずつ中身を突き合わせる**（subject / html / plain が完全一致か）
 *
 * ## 使い方
 *
 * ```bash
 * cd /Users/user/Projects/analytics-keiba
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-designs.mjs
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-designs.mjs \
 *   --apply --confirm "CREATE AK DESIGNS"
 * ```
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { TOTAL_MESSAGES } from '../src/lib/marketing/sendgridMessagePlan.js';

const CONFIRM = 'CREATE AK DESIGNS';
/** Design の名前（**この形以外は作らない**） */
export const designName = (n) => `AK Prospect Selection ${String(n).padStart(2, '0')}`;
const DEFAULT_DIR = join(homedir(), '.analytics-keiba-ops', 'sendgrid-automation-content');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = (() => {
  const i = args.indexOf('--confirm');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();
const dir = (() => {
  const i = args.indexOf('--dir');
  return i >= 0 ? String(args[i + 1] || '') : DEFAULT_DIR;
})();

const KEY = process.env.SENDGRID_API_KEY;
const log = (...a) => console.error(...a);
if (!KEY) { console.error('SENDGRID_API_KEY がありません'); process.exit(2); }

/** `/v3/designs` だけを触る（**書き込みは POST のみ**） */
async function designs(method, path, body) {
  if (!['GET', 'POST'].includes(method)) throw new Error(`method_not_allowed:${method}`);
  if (!path.startsWith('/v3/designs')) throw new Error(`path_not_allowed:${path}`);
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

/** 書き出し済みの 10 通を読む（**無加工**） */
function loadMessages() {
  const indexPath = join(dir, 'INDEX.json');
  if (!existsSync(indexPath)) throw new Error(`index_not_found:${dir}`);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(index) || index.length !== TOTAL_MESSAGES) throw new Error('index_broken');
  return index
    .slice()
    .sort((a, b) => a['通し番号'] - b['通し番号'])
    .map((row) => {
      const base = String(row.html).replace(/\.html$/, '');
      const read = (ext) => readFileSync(join(dir, `${base}.${ext}`), 'utf8');
      return {
        messageNumber: row['通し番号'],
        campaignId: row.campaignId,
        step: row.step,
        name: designName(row['通し番号']),
        subject: read('subject.txt'),
        html: read('html'),
        text: read('txt'),
      };
    });
}

async function listExisting() {
  const byName = new Map();
  let path = '/v3/designs?page_size=100';
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- ページ送り
    const r = await designs('GET', path);
    if (r.status !== 200) throw new Error(`designs_list_${r.status}`);
    for (const d of (r.body && r.body.result) || []) byName.set(String(d.name), String(d.id));
    const next = r.body && r.body._metadata && r.body._metadata.next;
    if (!next) return byName;
    path = String(next).startsWith('http') ? String(next).replace('https://api.sendgrid.com', '') : String(next);
  }
  throw new Error('designs_too_many_pages');
}

async function main() {
  const messages = loadMessages();
  const existing = await listExisting();

  console.log('── 登録する Design（既にあれば飛ばす）──');
  for (const m of messages) {
    console.log(`  ${existing.has(m.name) ? 'skip（既存）' : '作る      '} : ${m.name} ` +
      `（${m.campaignId} step${m.step} / html ${m.html.length} 字 / text ${m.text.length} 字）`);
  }

  if (!apply) {
    console.log('\n（下見です。--apply --confirm を渡すまで 1 件も作りません）');
    return;
  }
  if (confirm !== CONFIRM) {
    console.error(`❌ --confirm "${CONFIRM}" が要ります。何も作っていません。`);
    process.exit(2);
  }

  // ── 作成（**中身は無加工でそのまま送る**）────────────────────
  const created = [];
  for (const m of messages) {
    if (existing.has(m.name)) { created.push({ name: m.name, result: 'skipped_existing', id: existing.get(m.name) }); continue; }
    // eslint-disable-next-line no-await-in-loop -- 直列（失敗したらそこで止める）
    const r = await designs('POST', '/v3/designs', {
      name: m.name,
      editor: 'code',
      subject: m.subject,
      html_content: m.html,
      plain_content: m.text,
      // ⚠️ true にすると SendGrid が text を作り直す（既存の text と食い違う）
      generate_plain_content: false,
    });
    const ok = r.status >= 200 && r.status < 300;
    created.push({
      name: m.name, status: r.status, result: ok ? 'created' : 'failed',
      id: ok ? String(r.body && r.body.id) : null,
      error: ok ? null : ((r.body && r.body.errors) || []).map((e) => e.message).join(' / ') || null,
    });
    log(`  ${ok ? '✅' : '❌'} ${m.name} (${r.status})`);
    if (!ok) { log('  中止します（ここまでの結果は下に出します）'); break; }
  }

  // ── 検証（**GET して 1 バイト単位で突き合わせる**）──────────────
  const after = await listExisting();
  const verified = [];
  for (const m of messages) {
    const id = after.get(m.name);
    if (!id) { verified.push({ name: m.name, 一致: false, 理由: 'not_found' }); continue; }
    // eslint-disable-next-line no-await-in-loop -- 10 件だけ
    const r = await designs('GET', `/v3/designs/${id}`);
    const d = r.body || {};
    verified.push({
      name: m.name,
      id,
      一致: String(d.subject) === m.subject
        && String(d.html_content) === m.html
        && String(d.plain_content) === m.text,
      差分: {
        subject: String(d.subject) === m.subject ? 'ok' : 'NG',
        html: String(d.html_content) === m.html ? 'ok' : `NG(${String(d.html_content || '').length} vs ${m.html.length})`,
        text: String(d.plain_content) === m.text ? 'ok' : `NG(${String(d.plain_content || '').length} vs ${m.text.length})`,
      },
      editor: d.editor || null,
    });
  }

  const out = { 作成結果: created, 検証: verified, 全件一致: verified.every((v) => v['一致'] === true) };
  const json = JSON.stringify(out, null, 1);
  if (/@/.test(json)) { console.error('PII 混入のため出力を中止します'); process.exit(3); }
  console.log(json);
  if (!out['全件一致']) process.exit(1);
}

main().catch((e) => {
  console.error(`designs_failed: ${String((e && e.message) || 'unknown').slice(0, 80)}`);
  process.exit(1);
});

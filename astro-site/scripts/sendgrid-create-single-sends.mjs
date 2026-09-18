#!/usr/bin/env node
/**
 * sendgrid-create-single-sends.mjs — 選別配信 **27 通の Single Send** を組む（既定は下見）
 *
 * ## なぜ Single Sends なのか
 *
 * Automation は**公開 API に作成・更新の経路が無く**、画面で 1 通ずつ組むしかない。
 * Single Sends は**作成・本文・宛先 list・配信停止グループ・予約まで API で完結**するので、
 * **UI 手作業ゼロ**で「1 日 1 通・最大 10 通・list 別の開始位置」を実現できる。
 * SendGrid が実配送を担う点は変わらない（**AK 側に配送エンジンを作らない**）。
 *
 * ## 作るもの（27 通）
 *
 * | 宛先 list | 送る通し番号 | 通数 |
 * |---|---|---:|
 * | `ak-prospect-select-start-1` | 01 → 10 | 10 |
 * | `ak-prospect-select-start-2` | 02 → 10 | 9 |
 * | `ak-prospect-select-start-3` | 03 → 10 | 8 |
 *
 * ## 守ること
 *
 * - **文面は書き出し済みファイルを無加工**（subject / html / plain）。
 *   `generate_plain_content: false`（SendGrid に text を作り直させない）
 * - **予約しない・送らない。** `send_at` を**組み立てない**（body に入れる経路が無い）。
 *   作られた Single Send は **draft** のまま
 * - **同じ名前があれば作らない**（名前が識別子）
 * - list / sender / unsubscribe group の id が 1 つでも解決できなければ**何も作らない**
 * - 触るのは `/v3/marketing/singlesends`・`/v3/marketing/lists`・`/v3/marketing/senders`・
 *   `/v3/asm/groups` の **GET と POST だけ**（更新・削除・schedule・送信の経路を持たない）
 * - 既定は**下見**。`--apply --confirm "CREATE AK SINGLE SENDS"` の両方でだけ作る
 * - 作成後は **GET で 1 件ずつ**（subject / html / plain / list / sender / group / status）を検証
 *
 * ## 使い方
 *
 * ```bash
 * cd /Users/user/Projects/analytics-keiba
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-single-sends.mjs
 * netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-single-sends.mjs \
 *   --apply --confirm "CREATE AK SINGLE SENDS"
 * ```
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { buildMessagePlan, TOTAL_MESSAGES } from '../src/lib/marketing/sendgridMessagePlan.js';
import { listNameFor, UNSUBSCRIBE_GROUP_NAME } from '../src/lib/marketing/sendgridAutomationPlan.js';
import {
  buildSingleSendPlan, checkDeadlineFeasibility, findDeadlineMessages,
} from '../src/lib/marketing/sendgridSingleSendPlan.js';
import { describeCampaignDeadline, CAMPAIGN_WINDOW } from '../src/lib/promotions/campaignOffers.js';

const CONFIRM = 'CREATE AK SINGLE SENDS';
const SENDER_NICKNAME = 'KEIBA Analytics';
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
/** 配信開始日（`YYYY-MM-DD`）。**渡しても予約はしない**。成立判定にだけ使う */
const startDate = (() => {
  const i = args.indexOf('--start-date');
  return i >= 0 ? String(args[i + 1] || '') : '';
})();

const KEY = process.env.SENDGRID_API_KEY;
const log = (...a) => console.error(...a);
if (!KEY) { console.error('SENDGRID_API_KEY がありません'); process.exit(2); }

/** 触ってよい入口（**これ以外は構造的に拒否**） */
const ALLOWED_PATHS = ['/v3/marketing/singlesends', '/v3/marketing/lists', '/v3/marketing/senders', '/v3/asm/groups'];
async function sg(method, path, body) {
  if (!['GET', 'POST'].includes(method)) throw new Error(`method_not_allowed:${method}`);
  if (!ALLOWED_PATHS.some((p) => path.startsWith(p))) throw new Error(`path_not_allowed:${path}`);
  // ⚠️ 予約・送信の経路を持たない（schedule / trigger は URL の形で拒否する）
  if (/\/(schedule|send|trigger)\b/.test(path)) throw new Error(`forbidden_action:${path}`);
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

/** 書き出し済み 10 通を**無加工**で読む */
function loadMessages() {
  const indexPath = join(dir, 'INDEX.json');
  if (!existsSync(indexPath)) throw new Error(`index_not_found:${dir}`);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (!Array.isArray(index) || index.length !== TOTAL_MESSAGES) throw new Error('index_broken');
  return index.slice().sort((a, b) => a['通し番号'] - b['通し番号']).map((row) => {
    const base = String(row.html).replace(/\.html$/, '');
    const read = (ext) => readFileSync(join(dir, `${base}.${ext}`), 'utf8');
    return {
      messageNumber: row['通し番号'],
      campaignId: row.campaignId,
      stepNumber: row.step,
      subject: read('subject.txt'),
      html: read('html'),
      text: read('txt'),
    };
  });
}

/** 既存 Single Send（名前 → id）。**二重作成を防ぐ** */
async function listExisting() {
  const byName = new Map();
  let path = '/v3/marketing/singlesends?page_size=100';
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- ページ送り
    const r = await get(path);
    if (r.status !== 200) throw new Error(`singlesends_list_${r.status}`);
    for (const x of (r.body && r.body.result) || []) byName.set(String(x.name), String(x.id));
    const next = r.body && r.body._metadata && r.body._metadata.next;
    if (!next) return byName;
    path = String(next).startsWith('http') ? String(next).replace('https://api.sendgrid.com', '') : String(next);
  }
  throw new Error('singlesends_too_many_pages');
}

/** Single Send の本体（**`send_at` を持たない ＝ draft のまま**） */
function buildBody(send, message) {
  return {
    name: send.name,
    send_to: { list_ids: [send.listId] },        // segment は使わない
    email_config: {
      subject: message.subject,
      html_content: message.html,
      plain_content: message.text,
      generate_plain_content: false,
      editor: 'code',
      sender_id: send.senderId,
      suppression_group_id: send.suppressionGroupId,
    },
  };
}

async function main() {
  const messages = loadMessages();
  const byNumber = new Map(messages.map((m) => [m.messageNumber, m]));

  // ── 1) id を引く（**推測しない**）────────────────────────────
  const [lists, senders, groups] = await Promise.all([
    get('/v3/marketing/lists?page_size=100'), get('/v3/marketing/senders'), get('/v3/asm/groups'),
  ]);
  const listIdByName = new Map(((lists.body && lists.body.result) || []).map((l) => [String(l.name), String(l.id)]));
  const listIdByStart = {};
  for (const n of [1, 2, 3]) {
    const id = listIdByName.get(listNameFor(n));
    if (id) listIdByStart[n] = id;
  }
  const sender = (Array.isArray(senders.body) ? senders.body : []).find((s) => String(s.nickname) === SENDER_NICKNAME);
  const group = (Array.isArray(groups.body) ? groups.body : []).find((g) => String(g.name) === UNSUBSCRIBE_GROUP_NAME);

  const plan = buildSingleSendPlan({
    messages: buildMessagePlan().plan,
    listIdByStart,
    senderId: sender && sender.id,
    suppressionGroupId: group && group.id,
  });
  if (!plan.ok) {
    console.error(`❌ 計画を作れません: ${plan.reason} ${plan.detail || ''}（何も作っていません）`);
    process.exit(2);
  }

  const existing = await listExisting();

  // ── 2) 全件検証（**作る前に**）─────────────────────────────
  const checks = plan.sends.map((s) => {
    const m = byNumber.get(s.messageNumber);
    const body = buildBody(s, m);
    return {
      name: s.name,
      通し番号: s.messageNumber,
      list: s.listName,
      dayOffset: s.dayOffset,
      既存: existing.has(s.name),
      検証: {
        subject: body.email_config.subject === m.subject && m.subject.length > 0 ? 'ok' : 'NG',
        html: body.email_config.html_content === m.html && m.html.length > 0 ? 'ok' : 'NG',
        plain: body.email_config.plain_content === m.text && m.text.length > 0 ? 'ok' : 'NG',
        list: body.send_to.list_ids[0] === s.listId ? 'ok' : 'NG',
        segment: body.send_to.segment_ids === undefined ? 'なし(ok)' : 'NG',
        sender: body.email_config.sender_id === (sender && sender.id) ? 'ok' : 'NG',
        group: body.email_config.suppression_group_id === (group && group.id) ? 'ok' : 'NG',
        plain自動生成: body.email_config.generate_plain_content === false ? 'ok' : 'NG',
        予約: 'send_at' in body ? 'NG（予約が入っている）' : 'なし(ok)',
      },
    };
  });
  const ng = checks.filter((c) => Object.values(c['検証']).some((v) => String(v).startsWith('NG')));

  console.log(JSON.stringify({
    計画: plan.totals,
    宛先: {
      list: Object.fromEntries([1, 2, 3].map((n) => [listNameFor(n), listIdByStart[n] || null])),
      sender: sender ? { id: sender.id, nickname: sender.nickname } : null,
      unsubscribeGroup: group ? { id: group.id, name: group.name } : null,
    },
    検証NG: ng.length,
    既に存在: checks.filter((c) => c['既存']).length,
    一覧: checks,
  }, null, 1));

  // ── 2-b) 期限つき文面の成立判定（**日付を含む通を期限後に置かない**）──────
  /**
   * ⚠️ Single Send は**本文を自分で持つ**ので、キャンペーン期間が終わっても
   *    予約済みのメールは止まらない。AK 側は期間外に 1 円も割り引かないので、
   *    放置すると「案内は届くのに割引が乗らない」事故になる。ここで必ず突き合わせる。
   */
  const deadlineText = describeCampaignDeadline();          // 例「2026年9月23日まで」
  const dated = findDeadlineMessages({
    contents: messages.map((m) => ({ messageNumber: m.messageNumber, subject: m.subject, html: m.html, text: m.text })),
    deadlineText,
  });
  const deadlineIso = new Date(Date.parse(CAMPAIGN_WINDOW.endsAtIso) - 1).toISOString();
  const feas = checkDeadlineFeasibility({
    sends: plan.sends, startDateIso: startDate ? `${startDate}T00:00:00+09:00` : '',
    deadlineIso, datedMessageNumbers: dated,
  });
  console.log(JSON.stringify({
    期限つきの通: dated,
    期限の表示: deadlineText,
    キャンペーン期間: CAMPAIGN_WINDOW,
    開始日: startDate || '（未指定）',
    成立: feas.ok,
    理由: feas.reason || null,
    '何日までに開始すれば成立するか': feas.latestStartByStart,
    違反: feas.violations,
  }, null, 1));

  if (ng.length > 0) {
    console.error('❌ 検証 NG があります。何も作っていません。');
    process.exit(1);
  }
  if (apply && !feas.ok) {
    console.error('❌ 期限つきの文面が期限後に出ます（または開始日が未確定）。**何も作っていません**。');
    console.error('   期間を取り直すか、開始日を早めるか、期限つきの通を外すかを決めてから再実行してください。');
    process.exit(1);
  }
  if (!apply) {
    console.error('（下見です。--apply --confirm を渡すまで 1 通も作りません）');
    return;
  }
  if (confirm !== CONFIRM) {
    console.error(`❌ --confirm "${CONFIRM}" が要ります。何も作っていません。`);
    process.exit(2);
  }

  // ── 3) 作成（**draft のまま**・同名は飛ばす）──────────────────
  const created = [];
  for (const s of plan.sends) {
    if (existing.has(s.name)) { created.push({ name: s.name, result: 'skipped_existing' }); continue; }
    const m = byNumber.get(s.messageNumber);
    // eslint-disable-next-line no-await-in-loop -- 直列（失敗したらそこで止める）
    const r = await sg('POST', '/v3/marketing/singlesends', buildBody(s, m));
    const ok = r.status >= 200 && r.status < 300;
    created.push({
      name: s.name, status: r.status, result: ok ? 'created' : 'failed',
      id: ok ? String(r.body && r.body.id) : null,
      status後: ok ? String(r.body && r.body.status) : null,
      error: ok ? null : ((r.body && r.body.errors) || []).map((e) => e.message).join(' / ') || null,
    });
    log(`  ${ok ? '✅' : '❌'} ${s.name} (${r.status})`);
    if (!ok) { log('  中止します'); break; }
  }

  // ── 4) 作成後の検証（**GET して突き合わせ**）────────────────
  const after = await listExisting();
  const verified = [];
  for (const s of plan.sends) {
    const id = after.get(s.name);
    if (!id) { verified.push({ name: s.name, 一致: false, 理由: 'not_found' }); continue; }
    // eslint-disable-next-line no-await-in-loop -- 27 件
    const r = await get(`/v3/marketing/singlesends/${id}`);
    const d = r.body || {};
    const ec = d.email_config || {};
    const m = byNumber.get(s.messageNumber);
    verified.push({
      name: s.name,
      status: d.status,
      一致: String(ec.subject) === m.subject
        && String(ec.html_content) === m.html
        && String(ec.plain_content) === m.text
        && String((d.send_to || {}).list_ids && d.send_to.list_ids[0]) === s.listId
        && Number(ec.sender_id) === s.senderId
        && Number(ec.suppression_group_id) === s.suppressionGroupId
        && !d.send_at,
      予約: d.send_at || null,
    });
  }
  const out = { 作成結果: created, 検証: verified, 全件一致: verified.every((v) => v['一致'] === true) };
  const json = JSON.stringify(out, null, 1);
  if (/@/.test(json)) { console.error('PII 混入のため出力を中止します'); process.exit(3); }
  console.log(json);
  if (!out['全件一致']) process.exit(1);
}

main().catch((e) => {
  console.error(`single_sends_failed: ${String((e && e.message) || 'unknown').slice(0, 80)}`);
  process.exit(1);
});

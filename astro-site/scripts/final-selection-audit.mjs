#!/usr/bin/env node
/**
 * final-selection-audit.mjs — 選別配信（27 通）終了後の**最終 read-only 監査**
 *
 * 2026-09-30 朝に GitHub Actions（`.github/workflows/final-selection-audit.yml`）から 1 回だけ動く。
 * Claude のセッションや手元の Mac が閉じていても動くように、repo の中に置く。
 *
 * ## 実行
 *
 *   netlify dev:exec --context production -- node astro-site/scripts/final-selection-audit.mjs \
 *     --out audit.json --summary audit.md
 *
 * 本番の管理 secret と SendGrid key は `netlify dev:exec` が子プロセスへ注入する（画面にもログにも出さない）。
 * Upstash は secret 指定で手元から読めないので、**Redis は直接読まず本番の read-only 管理 API を使う**。
 *
 * ## 絶対に守ること（`finalSelectionAudit.guard.test.mjs` で固定）
 *
 * - **読むだけ**。SendGrid は GET と「contact の export 作成」（読み出し用のジョブ）だけ。
 *   list / contact / Single Send / suppression / メール送信の書き込み経路を持たない
 * - 管理 API は許可リストの action だけ。`reconcile` は **apply / confirm を付けない**（下見だけ）
 * - 出力は**件数だけ**。アドレスを 1 件も出力しない（出す前に `@` を検査して見つかれば中止）
 * - 異常を見つけても**直さない**。記録して exit 1（ワークフローが失敗として通知する）
 *
 * ## 確かめる 7 点（docs/progress.md 先頭「⏳ 選別配信の未完了項目」）
 *
 * ① 最終配信数 ② 反応者数 ③ 10 通無反応で除外された人数 ④ bounce / 配信停止 / 苦情
 * ⑤ 除外済みなのに list に残存 ⑥ record / 索引の不整合 ⑦ 2026-09-27 の日次点検通知の原因
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { evaluateSelectionWatch, WATCH_FINDING } from '../src/lib/marketing/selectionWatch.js';

export const ADMIN_BASE = 'https://analytics.keiba.link/.netlify/functions';
/** 使ってよい管理 API（**読み取りのみ**の action だけ） */
export const READ_ONLY_ADMIN = Object.freeze({
  'admin-marketing': ['mailOverview', 'prospectSequenceCheck', 'prospectIndexAudit'],
  'admin-sendgrid-migration': ['reconcile'],
});
/** SendGrid で使ってよい呼び出し（GET は /v3/marketing/ 配下だけ。POST は export の作成だけ）*/
export const SENDGRID_POST_ALLOW = Object.freeze(['/v3/marketing/contacts/exports']);
export const SELECTION_LISTS = Object.freeze(['ak-prospect-select-start-1', 'ak-prospect-select-start-2', 'ak-prospect-select-start-3']);
export const CONTINUATION_LIST = 'ak-drm-engaged';
export const SEND_PREFIX = 'AK Prospect Selection ';
export const EXPECTED_SENDS = 27;

/**
 * 2026-09-28 の監査で確定していた既知の値（これより**増えていたら異常**）。
 * - 除外済みなのに list に残るのは start-3 の反応者 1 名（反応者は継続 list への追加と同じ呼び出しでしか外せない）
 * - 送信候補索引に居るが送れない 2 名は list に居ない既知の 2 名
 */
export const KNOWN_BASELINE = Object.freeze({ excludedResidue: 1, nowhere: 0, activeNotSendable: 2 });

/**
 * ⑦ 用: 2026-09-26 20:20 JST の点検が控えた list 人数（**実測の記録**。点検は finding を保存しない）。
 * docs/progress.md「📡 選別配信の現在地」および 09-26 夜の mailOverview（start-1 12 / start-2 2,404 / start-3 7,252）。
 */
export const WATCH_0926_LIST_BY_NAME = Object.freeze({
  'ak-prospect-select-start-1': 12, 'ak-prospect-select-start-2': 2404, 'ak-prospect-select-start-3': 7252,
});
export const WATCH_0926_CHECKED_AT = Date.UTC(2026, 8, 26, 11, 20);
export const WATCH_0927_CHECKED_AT = Date.UTC(2026, 8, 27, 11, 20);

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const log = (...a) => console.error(new Date().toISOString(), ...a);   // 進捗は stderr。値は出さない

/** 出力にアドレスが混ざっていないか（混ざっていたら書かずに止める） */
export function assertNoAddress(obj) {
  const s = JSON.stringify(obj);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) throw new Error('address_in_output');
  return obj;
}

export function makeClients(env = process.env, fetchImpl = fetch) {
  const SG = env.SENDGRID_API_KEY;
  const SEC = env.MARKETING_ADMIN_SECRET || env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SG || !SEC) throw new Error('credentials_missing');   // 値は出さない
  const sgGet = async (path) => {
    if (!String(path).startsWith('/v3/marketing/')) throw new Error(`read_only_violation:${path}`);
    const r = await fetchImpl(`https://api.sendgrid.com${path}`, { headers: { Authorization: `Bearer ${SG}` } });
    if (!r.ok) throw new Error(`sendgrid_http_${r.status}`);
    return r.json();
  };
  const sgPostExport = async (path, body) => {
    if (!SENDGRID_POST_ALLOW.includes(path)) throw new Error(`read_only_violation:${path}`);
    const r = await fetchImpl(`https://api.sendgrid.com${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${SG}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status >= 300) throw new Error(`sendgrid_http_${r.status}`);
    return r.json();
  };
  const admin = async (fn, payload, { tries = 4 } = {}) => {
    const allowed = READ_ONLY_ADMIN[fn] || [];
    if (!allowed.includes(payload && payload.action)) throw new Error(`read_only_violation:${fn}:${payload && payload.action}`);
    if (payload && ('apply' in payload || 'confirm' in payload)) throw new Error('read_only_violation:apply');
    for (let i = 0; i < tries; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- 本番へ押し寄せない
      const r = await fetchImpl(`${ADMIN_BASE}/${fn}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': SEC }, body: JSON.stringify(payload),
      }).catch(() => null);
      if (r && r.status === 200) {
        // eslint-disable-next-line no-await-in-loop -- 同上
        const j = await r.json();
        if (j && j.sideEffects && j.sideEffects !== 'none') throw new Error('not_read_only_response');
        return j;
      }
      if (r && r.status === 409) return { __indexChanged: true };
      // eslint-disable-next-line no-await-in-loop -- 実行時間切れは間を置いて再試行
      await new Promise((z) => setTimeout(z, 8000));
    }
    throw new Error(`admin_unavailable:${fn}:${payload.action}`);
  };
  return { sgGet, sgPostExport, admin };
}

/** ①④ 配信実績（27 通）*/
async function sendsAndStats(c) {
  const all = (await c.sgGet('/v3/marketing/singlesends?page_size=100')).result || [];
  const stats = (await c.sgGet('/v3/marketing/stats/singlesends?page_size=50')).results || [];
  const byId = new Map(stats.map((x) => [x.id, x.stats || {}]));
  const mine = all.filter((x) => String(x.name).startsWith(SEND_PREFIX));
  const rows = mine.map((x) => ({ name: x.name, status: x.status, sendAt: x.send_at, ...(byId.get(x.id) || {}) }))
    .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt)) || a.name.localeCompare(b.name));
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    count: rows.length,
    triggered: rows.filter((r) => r.status === 'triggered').length,
    scheduled: rows.filter((r) => r.status === 'scheduled').length,
    withoutStats: rows.filter((r) => r.requests === undefined).length,
    totals: {
      requests: sum('requests'), delivered: sum('delivered'), uniqueOpens: sum('unique_opens'), uniqueClicks: sum('unique_clicks'),
      bounces: sum('bounces'), bounceDrops: sum('bounce_drops'), invalidEmails: sum('invalid_emails'),
      unsubscribes: sum('unsubscribes'), spamReports: sum('spam_reports'), spamReportDrops: sum('spam_report_drops'),
    },
    rows: rows.map((r) => ({
      name: r.name, status: r.status, sendAt: r.sendAt, requests: r.requests ?? null, delivered: r.delivered ?? null,
      bounces: r.bounces ?? null, unsubscribes: r.unsubscribes ?? null, spamReports: r.spam_reports ?? null,
    })),
  };
}

async function listsByName(c) {
  const lists = (await c.sgGet('/v3/marketing/lists?page_size=100')).result || [];
  const out = {};
  for (const l of lists) if ([...SELECTION_LISTS, CONTINUATION_LIST].includes(l.name)) out[l.name] = { id: l.id, count: Number(l.contact_count) || 0 };
  return out;
}

/** ⑥ 送信候補索引の全窓: 「読めたのに送信行にならない」件数と delivered 分布 */
async function activeIndexScan(c) {
  let offset = 0; let digest; const t = { read: 0, converted: 0, missing: 0, windows: 0 }; const hist = {};
  for (let guard = 0; guard < 100; guard += 1) {
    // eslint-disable-next-line no-await-in-loop -- 窓を順に読む
    const j = await c.admin('admin-marketing', {
      action: 'prospectSequenceCheck', campaignId: 'campaign-discount-free', limit: 1000, offset, ...(digest ? { digest } : {}),
    });
    if (j.__indexChanged) { offset = 0; digest = undefined; Object.assign(t, { read: 0, converted: 0, missing: 0, windows: 0 }); for (const k of Object.keys(hist)) delete hist[k]; continue; }
    t.windows += 1; t.read += j.loaded['読み込み']; t.converted += j.loaded['変換']; t.missing += j.window.missing || 0;
    for (const [k, v] of Object.entries((j.delivered || {}).histogram || {})) hist[k] = (hist[k] || 0) + v;
    digest = j.window.digest;
    if (j.window.nextOffset === null || j.window.nextOffset === undefined) return { ...t, activeNotSendable: t.read - t.converted, deliveredHistogram: hist, indexSize: j.window.indexSize };
    offset = j.window.nextOffset;
  }
  throw new Error('active_scan_too_many_windows');
}

/** ⑤ 除外済み（反応済み＋抑止）を全件、reconcile の**下見**で list と突き合わせる */
async function excludedResidue(c, listIdToName) {
  let offset = 0; const tot = {}; const perList = {}; let windows = 0; let total = null; let unresolved = 0; let contAdd = 0;
  for (let guard = 0; guard < 2000; guard += 1) {
    // eslint-disable-next-line no-await-in-loop -- 窓を順に読む（25 件＝既定の安全な窓）
    const j = await c.admin('admin-sendgrid-migration', { action: 'reconcile', scope: 'excluded', offset, limit: 25 });
    if (j.dryRun !== true) throw new Error('reconcile_not_dry_run');
    windows += 1; total = j.window.total; unresolved += j['引けなかった宛先'] || 0;
    contAdd += Number((j['継続導線'] || {})['追加予定']) || 0;
    for (const [k, v] of Object.entries(j.summary || {})) {
      if (typeof v === 'number') tot[k] = (tot[k] || 0) + v;
      else if (k === 'list別_外す' && v) for (const [id, n] of Object.entries(v)) { const nm = listIdToName[id] || id; perList[nm] = (perList[nm] || 0) + n; }
    }
    if (windows % 40 === 0) log('excluded', offset, '/', total);
    if (j.window.nextOffset === null || j.window.nextOffset === undefined) break;
    offset = j.window.nextOffset;
  }
  return { excludedTotal: total, windows, residue: tot['退出させる'] || 0, perList, unresolved, continuationAddPlanned: contAdd, summary: tot };
}

/** ⑥ list の中身を export → ハッシュ → prospectIndexAudit（どこにも居ない・反応済みのまま list に居る 等）*/
async function listMembership(c, lists) {
  const out = {};
  for (const name of SELECTION_LISTS) {
    const l = lists[name];
    if (!l) { out[name] = { error: 'list_not_found' }; continue; }
    if (l.count === 0) { out[name] = { exported: 0, counts: { active: 0, engaged: 0, blocked: 0, nowhere: 0 }, detailStates: {} }; continue; }
    // eslint-disable-next-line no-await-in-loop -- list ごとに順に
    const e = await c.sgPostExport('/v3/marketing/contacts/exports', { list_ids: [l.id], file_type: 'json' });
    let st = null;
    for (let i = 0; i < 90; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- export の完了を待つ
      await new Promise((z) => setTimeout(z, 5000));
      // eslint-disable-next-line no-await-in-loop -- 同上
      st = await c.sgGet(`/v3/marketing/contacts/exports/${encodeURIComponent(e.id)}`);
      if (st.status === 'ready' || st.status === 'failure') break;
    }
    if (!st || st.status !== 'ready') { out[name] = { error: `export_${st && st.status}` }; continue; }
    const emails = new Set();
    for (const u of st.urls || []) {
      // eslint-disable-next-line no-await-in-loop -- export のファイルを順に
      const b = Buffer.from(await (await fetch(u)).arrayBuffer());
      let txt; try { txt = gunzipSync(b).toString('utf8'); } catch { txt = b.toString('utf8'); }
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const em = String(o.email || o.EMAIL || '').trim().toLowerCase();
        if (em) emails.add(em);
      }
    }
    const hashes = [...emails].map((x) => createHash('sha256').update(x, 'utf8').digest('hex'));
    emails.clear();   // アドレスはここで捨てる
    // eslint-disable-next-line no-await-in-loop -- 同上
    const a = await c.admin('admin-marketing', { action: 'prospectIndexAudit', hashes });
    const detailStates = {};
    for (const d of a.details || []) {
      const k = `${d.place}/${(d.record && d.record.state) || 'no_record'}/${(d.blocked && d.blocked.kind) || '-'}`;
      detailStates[k] = (detailStates[k] || 0) + 1;
    }
    out[name] = { exported: hashes.length, counts: a.counts, notActive: a.notActiveCount, nowhere: a.nowhereCount, truncated: a.truncated, detailStates };
  }
  return out;
}

/**
 * ⑦ 2026-09-27 20:20 JST の通知の原因を、**点検と同じ判定式**で再構成する。
 * 入力: 09-26 20:20 JST に控えた list 人数（実測の記録）と、09-27 19:00 の各通の実送信数。
 * 09-27 の点検は #596 反映後（14:57 JST）のコードで動いた＝「前回点検より後に送った最新の通だけ」を比べる。
 */
export function reconstructWatch0927(sendRows) {
  const toSend = (r) => {
    const m = /\ss(\d)\s/.exec(` ${r.name} `);
    const listName = m ? `ak-prospect-select-start-${m[1]}` : null;
    return {
      name: r.name, status: 'triggered', sendAtMs: Date.parse(r.sendAt), requests: Number(r.requests) || 0,
      delivered: Number(r.delivered) || 0, bounces: Number(r.bounces) || 0, spam: Number(r.spamReports) || 0,
      listName, expectedRecipients: listName ? WATCH_0926_LIST_BY_NAME[listName] : null,
    };
  };
  const sends = sendRows.filter((r) => Date.parse(r.sendAt) <= WATCH_0927_CHECKED_AT).map(toSend);
  const res = evaluateSelectionWatch({
    nowMs: WATCH_0927_CHECKED_AT, previousCheckedAtMs: WATCH_0926_CHECKED_AT, sends, engine: 'sendgrid',
    akActive: 0, providerRejected: 0, listTotal: 0, previousMismatch: null,
  });
  const gaps = res.findings.filter((f) => f.id === WATCH_FINDING.RECIPIENT_GAP).map((f) => f.detail);
  return {
    method: '09-26 20:20 JST に控えた list 人数（実測記録）× 09-27 19:00 の実送信数を selectionWatch.js の判定式に通した再構成',
    recipientGap: gaps,
    otherFindings: res.findings.filter((f) => f.id !== WATCH_FINDING.RECIPIENT_GAP && f.id !== WATCH_FINDING.LIST_DRIFT).map((f) => f.id),
    conclusion: gaps.length > 0
      ? '09-27 12:09〜13:39 JST の手動除去（4,791 名）で list が前日の控えより大きく減り、RECIPIENT_GAP（送信数と前日の list 人数の食い違い）が出た'
      : 'RECIPIENT_GAP は再構成されなかった（原因は未特定）',
    caveat: '点検は finding を保存しないため、実際の通知本文ではなく同じ判定式での再構成',
  };
}

/** 異常の判定（**直さない**。記録して exit 1） */
export function judge(result) {
  const anomalies = [];
  const s = result.sends;
  if (s.count !== EXPECTED_SENDS) anomalies.push(`sends_count_${s.count}`);
  if (s.scheduled > 0) anomalies.push(`sends_not_triggered_${s.scheduled}`);
  if (result.excluded.residue > KNOWN_BASELINE.excludedResidue) anomalies.push(`excluded_residue_${result.excluded.residue}`);
  if (result.excluded.unresolved > 0) anomalies.push(`excluded_unresolved_${result.excluded.unresolved}`);
  const nowhere = Object.values(result.listMembership).reduce((a, v) => a + (Number(v && v.nowhere) || 0), 0);
  if (nowhere > KNOWN_BASELINE.nowhere) anomalies.push(`list_members_in_no_index_${nowhere}`);
  if (result.activeIndex.activeNotSendable > KNOWN_BASELINE.activeNotSendable) anomalies.push(`active_not_sendable_${result.activeIndex.activeNotSendable}`);
  if (result.activeIndex.missing > 0) anomalies.push(`active_missing_${result.activeIndex.missing}`);
  for (const [n, v] of Object.entries(result.listMembership)) if (v && v.error) anomalies.push(`list_audit_${n}_${v.error}`);
  if (result.env.migrationWriteGate !== 'unset') anomalies.push('migration_write_gate_set');
  if (result.overview.ok !== true) anomalies.push('mail_overview_unavailable');
  return anomalies;
}

export function renderSummary(r) {
  const t = r.sends.totals;
  const lines = [
    `# 選別配信 最終 read-only 監査（${r.at}）`, '',
    `判定: ${r.anomalies.length === 0 ? '✅ 異常なし' : `⚠️ 異常あり（${r.anomalies.join(', ')}）`}`, '',
    '| # | 項目 | 結果 |', '|---|---|---|',
    `| ① | 最終配信数 | Single Send ${r.sends.count} 通（送信済み ${r.sends.triggered} / 予約のまま ${r.sends.scheduled}）・requests ${t.requests} / delivered ${t.delivered} |`,
    `| ② | 反応者数 | AK 反応済み ${r.overview.akEngaged} / 継続 list ${r.lists[CONTINUATION_LIST] ? r.lists[CONTINUATION_LIST].count : 'n/a'}・unique open ${t.uniqueOpens} / unique click ${t.uniqueClicks} |`,
    `| ③ | 10 通無反応で除外 | ${r.exhaustedEstimate.value}（${r.exhaustedEstimate.method}）|`,
    `| ④ | bounce / 配信停止 / 苦情 | bounce ${t.bounces}（bounce_drops ${t.bounceDrops}・invalid ${t.invalidEmails}）/ unsubscribe ${t.unsubscribes} / spam report ${t.spamReports} |`,
    `| ⑤ | 除外済みなのに list に残存 | ${r.excluded.residue}（${JSON.stringify(r.excluded.perList)}）/ 除外済み ${r.excluded.excludedTotal} 名を確認・状態不明 ${r.excluded.unresolved} |`,
    `| ⑥ | record / 索引の不整合 | list 内の「どこにも居ない」${Object.values(r.listMembership).reduce((a, v) => a + (Number(v && v.nowhere) || 0), 0)}・送信候補索引に居るが送れない ${r.activeIndex.activeNotSendable}（既知 ${KNOWN_BASELINE.activeNotSendable}）|`,
    `| ⑦ | 09-27 の点検通知の原因 | ${r.watch0927.conclusion}（${r.watch0927.caveat}）|`, '',
    `- list: ${SELECTION_LISTS.map((n) => `${n} ${r.lists[n] ? r.lists[n].count : 'n/a'}`).join(' / ')}`,
    `- 自動点検の最終実行: ${r.overview.watch ? r.overview.watch['最終実行'] : 'n/a'}・最後に知らせた: ${r.overview.watch ? r.overview.watch['最後に知らせた'] : 'n/a'}・不整合 ${r.overview.watch ? r.overview.watch['不整合'] : 'n/a'}`,
    `- \`SENDGRID_MIGRATION_WRITE_ENABLED\`: ${r.env.migrationWriteGate}`,
    '- この監査は**読むだけ**（本番 write・list 変更・env 変更・メール送信・予約変更なし）。異常があっても直していない。',
  ];
  return lines.join('\n');
}

async function main() {
  const c = makeClients();
  const at = new Date().toISOString();
  log('start');
  const sends = await sendsAndStats(c);
  const lists = await listsByName(c);
  const listIdToName = Object.fromEntries(Object.entries(lists).map(([n, v]) => [v.id, n]));
  const ov = await c.admin('admin-marketing', { action: 'mailOverview' });
  const overview = {
    ok: ov.ok === true, akActive: ov['反応'] && ov['反応'].AK送信候補, akEngaged: ov['反応'] && ov['反応'].AK反応済み,
    akBlocked: ov['反応'] && ov['反応'].AK抑止, watch: ov['自動点検'] || null,
  };
  log('active scan'); const activeIndex = await activeIndexScan(c);
  log('list membership'); const listMembership = await listMembership(c, lists);
  log('excluded residue'); const excluded = await excludedResidue(c, listIdToName);
  const watch0927 = reconstructWatch0927(sends.rows);
  /**
   * ③ 打ち切り（EXHAUSTED）の人数は、抑止（EXHAUSTED ＋ SUPPRESSED）を分けて返す read-only の口が無い。
   * そこで「抑止の合計 − 配信で起きた抑止（bounce / 配信停止 / 苦情 / 既知の抑止済み drop）」で近似し、**近似と明記**する。
   */
  const t = sends.totals;
  const suppressedApprox = t.bounces + t.bounceDrops + t.invalidEmails + t.unsubscribes + t.spamReports;
  const exhaustedEstimate = {
    value: Number.isFinite(overview.akBlocked) ? Math.max(0, overview.akBlocked - suppressedApprox) : null,
    method: `近似: AK 抑止 ${overview.akBlocked} − 配信で起きた抑止の合計 ${suppressedApprox}（bounce・bounce_drops・invalid・配信停止・苦情）。移行前からの抑止も差し引かれていない上限寄りの値`,
  };
  const result = {
    at, sends, lists, overview, activeIndex, listMembership, excluded, watch0927, exhaustedEstimate,
    env: { migrationWriteGate: String(process.env.SENDGRID_MIGRATION_WRITE_ENABLED || '').trim() ? 'set' : 'unset' },
  };
  result.anomalies = judge(result);
  assertNoAddress(result);
  const summary = renderSummary(result);
  assertNoAddress(summary);
  const out = arg('--out'); const md = arg('--summary');
  if (out) writeFileSync(out, JSON.stringify(result, null, 1));
  if (md) writeFileSync(md, summary);
  console.log(summary);
  log('done', result.anomalies.length === 0 ? 'ok' : 'anomalies');
  process.exit(result.anomalies.length === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('final-selection-audit.mjs')) {
  main().catch((e) => { console.error('audit_failed:', String((e && e.message) || e).slice(0, 200)); process.exit(2); });
}

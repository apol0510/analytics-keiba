/**
 * cron-sendgrid-selection-watch.js — 選別配信を**毎日ひとりでに見張る**（read-only ＋ 通知だけ）
 *
 * ## なぜ要るか
 *
 * 27 通は SendGrid が予定どおり送る。だが「送れたか」「反応で外れたか」
 * 「同じ号が二度出ていないか」を **MK が毎日見に行く運用にはしない。**
 * ここが毎日 1 回だけ読みに行き、**おかしいときにだけ**知らせる。
 *
 * ## やること / やらないこと
 *
 * - やる: SendGrid の Single Send の状態・配信数、AK の送信候補数、list の人数を**読む**
 * - やる: 異常があればメールで知らせる（**同じ知らせは 12 時間に 1 回まで**）
 * - **やらない**: list を触る / 予約を取り消す / メールを配る / AK の状態を書き換える
 *
 * ⚠️ 判定は `selectionWatch.js`（純粋）に置く。ここは入出力だけ。
 * ⚠️ **反応が増えること自体は異常ではない**（旧メールへの反応は遅れて届く）。
 * ⚠️ 新しい配送基盤は作らない。配るのは SendGrid。
 */

import {
  evaluateSelectionWatch, describeWatch, shouldNotify, WATCH_SEVERITY,
} from '../../src/lib/marketing/selectionWatch.js';
import { ACTIVE_INDEX, ENGAGED_INDEX } from '../../src/lib/marketing/prospectStore.js';
import { listNameFor } from '../../src/lib/marketing/sendgridAutomationPlan.js';
import { resolveProspectEngine } from '../../src/lib/marketing/sendgridCutover.js';
import { OFFICIAL_FROM_EMAIL, OFFICIAL_FROM_NAME } from '../../src/lib/payments/senderIdentity.js';

/** 見張りの記録（**件数と時刻だけ**。アドレスは持たない） */
const WATCH_KEY = 'ak:mkt:selection-watch:v1';
/** 既知の provider rejected（`SENDGRID_MC_MIGRATION.md` §14）*/
const PROVIDER_REJECTED = 10;

const redis = (args) => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('upstash_not_configured'));
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`upstash_http_${r.status}`);
    return (await r.json()).result;
  });
};

const sg = async (path) => {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('sendgrid_key_missing');
  const r = await fetch(`https://api.sendgrid.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`sendgrid_http_${r.status}`);
  return r.json();
};

/** 知らせる（**本文に件数と理由コードだけ**。アドレスを入れない） */
async function notify({ subject, text }) {
  const key = process.env.SENDGRID_API_KEY;
  const to = process.env.ALERT_EMAIL || OFFICIAL_FROM_EMAIL;
  if (!key || !to) return { sent: false, reason: 'not_configured' };
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: OFFICIAL_FROM_EMAIL, name: OFFICIAL_FROM_NAME },
      subject,
      content: [{ type: 'text/plain', value: text }],
      /** ⚠️ 運用連絡なので配信停止グループに乗せない（マーケティング配信ではない） */
      mail_settings: { bypass_list_management: { enable: true } },
    }),
  });
  return { sent: r.status >= 200 && r.status < 300, status: r.status };
}

export default async function handler() {
  const now = Date.now();
  const log = (o) => console.log(JSON.stringify({ fn: 'sendgrid-selection-watch', ...o }));

  /**
   * ── **走り出したことを最初に残す**（2026-09-19 の取りこぼしを受けて追加）────
   *
   * 記録を最後に書くと、「動かなかった」と「動いたが途中で落ちた」を**外から区別できない**。
   * 実際 2026-09-19 の 11:20 UTC に記録が残らず、どちらなのか判らなかった。
   * 何より先に「走り出した時刻」を残せば、次からは必ず区別できる。
   */
  try {
    const prev = JSON.parse((await redis(['GET', WATCH_KEY])) || '{}');
    await redis(['SET', WATCH_KEY, JSON.stringify({ ...prev, lastStartedAtMs: now })]);
  } catch { /* 残せなくても点検は続ける（残せないこと自体は下の結果で分かる） */ }

  let state = {
    lastMismatch: null, lastNotifiedAtMs: null,
    lastEngaged: null, lastListTotal: null, lastListByName: null,
  };
  try {
    const raw = await redis(['GET', WATCH_KEY]);
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch { /* 読めなければ初回として扱う（判定は進める） */ }

  let akActive = 0;
  let engagedCount = 0;
  try {
    akActive = Number(await redis(['SCARD', ACTIVE_INDEX])) || 0;
    engagedCount = Number(await redis(['SCARD', ENGAGED_INDEX])) || 0;
  } catch (e) {
    log({ ok: false, reason: 'redis_unavailable' });
    return new Response(JSON.stringify({ ok: false, reason: 'redis_unavailable' }), { status: 200 });
  }

  let sends = [];
  let listTotal = 0;
  const listByName = {};
  try {
    const lists = (await sg('/v3/marketing/lists?page_size=100')).result || [];
    for (const n of [1, 2, 3]) {
      const hit = lists.find((l) => String(l.name) === listNameFor(n));
      if (hit) {
        listTotal += Number(hit.contact_count) || 0;
        listByName[listNameFor(n)] = Number(hit.contact_count) || 0;
      }
    }
    /** 前回控えた list 人数（**送るはずだった人数**）。初回は比べない */
    const prevByName = (state.lastListByName && typeof state.lastListByName === 'object')
      ? state.lastListByName : {};
    const all = (await sg('/v3/marketing/singlesends?page_size=100')).result || [];
    const mine = all.filter((s) => /^AK Prospect Selection /.test(String(s.name)));
    const stats = (await sg('/v3/marketing/stats/singlesends?page_size=100')).results || [];
    const statById = new Map(stats.map((s) => [String(s.id), s.stats || {}]));
    sends = mine.map((s) => {
      const st = statById.get(String(s.id)) || {};
      /** その通の宛先 list を前回控えた人数で見積もる（**送るはずだった人数**） */
      const startMatch = /\ss(\d)\s/.exec(` ${String(s.name)} `);
      const listName = startMatch ? listNameFor(Number(startMatch[1])) : null;
      return {
        name: String(s.name),
        status: String(s.status || ''),
        sendAtMs: s.send_at ? Date.parse(s.send_at) : null,
        requests: Number(st.requests) || 0,
        delivered: Number(st.delivered) || 0,
        bounces: Number(st.bounces) || 0,
        spam: Number(st.spam_reports) || 0,
        expectedRecipients: listName && Number.isFinite(prevByName[listName])
          ? prevByName[listName] : null,
      };
    });
  } catch (e) {
    log({ ok: false, reason: String((e && e.message) || 'sendgrid_unavailable') });
    return new Response(JSON.stringify({ ok: false, reason: 'sendgrid_unavailable' }), { status: 200 });
  }

  const result = evaluateSelectionWatch({
    nowMs: now,
    sends,
    engine: resolveProspectEngine(process.env),
    akActive,
    providerRejected: PROVIDER_REJECTED,
    listTotal,
    previousMismatch: state.lastMismatch,
    /** 「反応は増えたのに list が減っていない」＝ 除外が効いていない、を見る */
    engagedDelta: Number.isFinite(state.lastEngaged) ? engagedCount - state.lastEngaged : null,
    listDelta: Number.isFinite(state.lastListTotal) ? listTotal - state.lastListTotal : null,
  });

  const decide = shouldNotify({ result, lastNotifiedAtMs: state.lastNotifiedAtMs, nowMs: now });
  let notified = null;
  if (decide.notify) {
    const critical = result.findings.some((f) => f.severity === WATCH_SEVERITY.CRITICAL);
    notified = await notify({
      subject: `${critical ? '【要確認】' : '【注意】'}選別配信の自動点検で異常を検知しました`,
      text: [
        `検知時刻: ${new Date(now).toISOString()}`,
        `AK 送信候補: ${akActive} / ENGAGED: ${engagedCount} / list 合計: ${listTotal}`,
        `予定 ${result.counts.予定} 通・送信済み ${result.counts.送信済み} 通・delivered ${result.counts.delivered}`,
        '',
        describeWatch(result),
        '',
        '止めるときは SendGrid の Single Send を unschedule してください（このバッチは何も止めません）。',
      ].join('\n'),
    });
  }

  try {
    await redis(['SET', WATCH_KEY, JSON.stringify({
      lastMismatch: result.mismatch,
      lastNotifiedAtMs: decide.notify ? now : state.lastNotifiedAtMs,
      lastCheckedAtMs: now,
      lastStartedAtMs: now,
      lastEngaged: engagedCount,
      lastListTotal: listTotal,
      /** 次回「送るはずだった人数」を見積もるために控える（**人数だけ**） */
      lastListByName: listByName,
    })]);
  } catch { /* 記録できなくても判定結果は返す */ }

  const body = {
    ok: result.ok,
    halt: result.halt,
    findings: result.findings.map((f) => ({ id: f.id, severity: f.severity })),
    counts: result.counts,
    mismatch: result.mismatch,
    akActive,
    engagedCount,
    listTotal,
    notified,
    sideEffects: notified && notified.sent ? 'alert_email_only' : 'none',
  };
  log(body);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** **毎日 1 回**（20:20 JST = 11:20 UTC）。19:00 の配信が終わってから見る */
export const config = { schedule: '20 11 * * *' };

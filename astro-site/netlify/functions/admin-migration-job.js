/**
 * 配信履歴を Airtable の外へ移す chunk 実行ジョブ（**既定 OFF・本番 write は専用 gate**）。
 *
 * ── なぜ Function なのか ────────────────────────────────────
 * Redis / Blobs の認証情報は production env にしか無く、手元からは到達できない
 * （`netlify env:get` は secret をマスクする）。値を人に渡してもらう運用は
 * 漏洩面を増やすので採らない。env が揃っている Function 内で動かす。
 *
 * ── なぜ chunk なのか ──────────────────────────────────────
 * Netlify Function は最大 26 秒。14,415 件を 1 回では処理できないので
 * **1 step 数百件**に切って `step` を繰り返す。
 *
 * ── 安全側の性質 ────────────────────────────────────────────
 *  - `MIGRATION_WRITE_ENABLED` 未設定なら **403**（main へ入れても何も起きない）
 *  - 書き込みは冪等（Redis=SADD / Blob=内容ハッシュのキー）。retry で二重投入なし
 *  - Airtable の取得が壊れたら **fail closed**（0 件と扱わない）
 *  - `offset` 失効を検知したら**先頭から読み直す**（黙って途中再開して取りこぼさない）
 *  - 同時実行はロックで 1 本に絞る
 *  - **Airtable への書き込み・削除は 0 / メール送信 0 / Customers 変更 0**
 *  - 応答・ログに PII / secret / cursor 実値を出さない
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   POST { action:'start',  jobType:'delivery-keys', chunkSize:500 }
 *   POST { action:'step',   jobType:'delivery-keys' }        ← 完了まで繰り返す
 *   POST { action:'status', jobType:'delivery-keys' }
 *   POST { action:'reconcile', jobType:'delivery-keys', campaignId, version }
 */

import {
  JOB_TYPE, JOB_STATUS, JOB_NAMESPACE, isValidJobType, clampChunk, jobKey, lockKey,
  createJob, applyStep, completeJob, failJob, verifyBalance, canStep,
  isExpiredCursorError, toPublicJob,
} from '../../src/lib/migration/migrationJobModel.js';
import { createDeliveryKeyStore, makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import { createEmailEventBlobStore } from '../../src/lib/webhooks/emailEventBlobStore.js';
import { reconcileDeliveryKeys } from '../../src/lib/marketing/deliveryStoreReconcile.js';

const BRAND = 'analytics-keiba';
const AIRTABLE_PAGE = 100;
const LOCK_TTL_SEC = 120;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本番 write の専用 gate。**未設定なら何も書けない**。 */
function isMigrationWriteEnabled(env) {
  return !!env && env.MIGRATION_WRITE_ENABLED === 'true';
}

/** Airtable を 1 ページ読む。壊れた応答は **throw**（0 件と扱わない）。 */
async function fetchPage({ KEY, BASE, table, fields, filterByFormula, offset }) {
  const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
  u.searchParams.set('pageSize', String(AIRTABLE_PAGE));
  if (filterByFormula) u.searchParams.set('filterByFormula', filterByFormula);
  for (const f of fields || []) u.searchParams.append('fields[]', f);
  if (offset) u.searchParams.set('offset', offset);

  for (let a = 0; a < 5; a += 1) {
    const res = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
    if (res.status === 429) { await sleep(1200); continue; }
    const j = await res.json().catch(() => null);
    if (j && Array.isArray(j.records)) return { records: j.records, offset: j.offset || null };
    if (j && j.error) {
      const e = new Error(j.error.type || 'airtable_error');
      e.type = j.error.type;
      throw e; // offset 失効はここで拾って呼び出し側が判断する
    }
    await sleep(800);
  }
  throw new Error('airtable_page_failed');
}

// ── ジョブ状態（Redis）──────────────────────────────────────
async function loadJob(cmd, jobType) {
  const raw = await cmd(['GET', jobKey(jobType)]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function saveJob(cmd, job) {
  // ⚠️ TTL は付けない。途中状態が勝手に消えると進捗が分からなくなる
  await cmd(['SET', jobKey(job.jobType), JSON.stringify(job)]);
}
/** 同時実行を 1 本に絞る。**取れなければ動かさない**。 */
async function acquireLock(cmd, jobType, token) {
  const r = await cmd(['SET', lockKey(jobType), token, 'NX', 'EX', String(LOCK_TTL_SEC)]);
  return r === 'OK' || r === true;
}
async function releaseLock(cmd, jobType, token) {
  const cur = await cmd(['GET', lockKey(jobType)]);
  if (cur === token) await cmd(['DEL', lockKey(jobType)]);
}

// ── 各ジョブの 1 step ────────────────────────────────────────
async function stepDeliveryKeys({ KEY, BASE, cmd, job }) {
  const store = createDeliveryKeyStore({ redisCmd: cmd });
  let offset = job.cursor || null;
  let cursorReset = false;
  let read = 0; let written = 0; let skipped = 0; let pages = 0;
  const buckets = new Map();

  while (read < job.chunkSize) {
    let page;
    try {
      page = await fetchPage({
        KEY, BASE, table: 'CampaignDeliveries',
        fields: ['DeliveryKey', 'CampaignType', 'Status'],
        filterByFormula: "OR({Status}='sent', {Status}='queued')",
        offset,
      });
    } catch (e) {
      if (isExpiredCursorError(e) && offset) {
        // offset 失効。**先頭から読み直す**（冪等なので安全。取りこぼすよりやり直す）
        offset = null; cursorReset = true;
        continue;
      }
      throw e;
    }
    pages += 1;
    for (const row of page.records) {
      read += 1;
      const f = row.fields || {};
      const key = String(f.DeliveryKey || '');
      const m = String(f.CampaignType || '').match(/^([A-Za-z0-9_.-]+):v(\d+)$/);
      if (!/^[a-f0-9]{64}$/.test(key) || !m) { skipped += 1; continue; }
      const bk = `${m[1]}|${m[2]}`;
      if (!buckets.has(bk)) buckets.set(bk, { campaignId: m[1], version: Number(m[2]), keys: [] });
      buckets.get(bk).keys.push(key);
    }
    offset = page.offset;
    if (!offset) break;
  }

  for (const b of buckets.values()) {
    await store.markDelivered({ brand: BRAND, campaignId: b.campaignId, version: b.version, keys: b.keys });
    written += b.keys.length;
  }

  return {
    delta: { pagesRead: pages, recordsRead: read, recordsWritten: written, recordsSkipped: skipped, cursor: offset, cursorReset },
    done: !offset,
  };
}

async function stepEmailEvents({ KEY, BASE, cmd, job, event }) {
  const { getStore, connectLambda } = await import('@netlify/blobs');
  const { createHash } = await import('node:crypto');
  // ⚠️ Lambda 互換ランタイムでは Blobs が自動設定されず
  //    `MissingBlobsEnvironmentError` になる（Premium Plus 実績画像で踏んだのと同じ）。
  //    event を渡して明示的に接続する。
  connectLambda(event);
  const blobs = getStore('ak-email-events');
  const blobStore = createEmailEventBlobStore({
    setBlob: (k, body) => blobs.set(k, body),
    hashFn: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
  });

  let offset = job.cursor || null;
  let cursorReset = false;
  let read = 0; let skipped = 0; let pages = 0;
  const events = [];

  while (read < job.chunkSize) {
    let page;
    try {
      page = await fetchPage({
        KEY, BASE, table: 'EmailEvents',
        fields: [
          'EventKey', 'EventType', 'EventAt', 'CampaignId', 'CampaignVersion', 'DeliveryKey',
          'CampaignDeliveryRecordId', 'CustomerRecordId', 'EmailHash', 'BounceClass',
          'ReasonText', 'ProviderEventId', 'ProviderMessageId', 'ResolutionStatus',
        ],
        offset,
      });
    } catch (e) {
      if (isExpiredCursorError(e) && offset) { offset = null; cursorReset = true; continue; }
      throw e;
    }
    pages += 1;
    for (const row of page.records) {
      read += 1;
      const f = row.fields || {};
      if (!f.EventKey || !f.EventType) { skipped += 1; continue; }
      events.push({
        eventKey: f.EventKey,
        eventType: f.EventType,
        eventAtMs: f.EventAt ? Date.parse(f.EventAt) : undefined,
        campaignId: f.CampaignId,
        campaignVersion: f.CampaignVersion,
        deliveryKey: f.DeliveryKey,
        campaignDeliveryRecordId: f.CampaignDeliveryRecordId,
        customerRecordId: f.CustomerRecordId,
        emailHash: f.EmailHash,
        bounceClass: f.BounceClass,
        reasonText: f.ReasonText,
        providerEventId: f.ProviderEventId,
        providerMessageId: f.ProviderMessageId,
        resolutionStatus: f.ResolutionStatus,
      });
    }
    offset = page.offset;
    if (!offset) break;
  }

  const batchIds = [];
  let written = 0;
  if (events.length > 0) {
    // キーは内容ハッシュ由来。**同じバッチを再実行しても同じキー**（二重 blob にならない）
    const r = await blobStore.writeBatch({ events, receivedAtMs: Date.now() });
    if (r.key) batchIds.push(r.key);
    written = r.written;
  }

  return {
    delta: {
      pagesRead: pages, recordsRead: read, recordsWritten: written, recordsSkipped: skipped,
      batchesWritten: batchIds.length, batchIds, cursor: offset, cursorReset,
    },
    done: !offset,
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）', sideEffects: 'none' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden', sideEffects: 'none' });
  if (!KEY || !BASE) return json(503, { error: 'Airtable 未設定', sideEffects: 'none' });

  let req = {};
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid JSON' }); }

  const action = String(req.action || '').trim();
  const jobType = String(req.jobType || '').trim();
  if (!isValidJobType(jobType)) {
    return json(400, { error: '未知の jobType', supported: Object.values(JOB_TYPE), sideEffects: 'none' });
  }

  // 🛡️ 本番 write の専用 gate。**未設定なら 403**（main へ入れても何も起きない）
  const writeActions = new Set(['start', 'step']);
  if (writeActions.has(action) && !isMigrationWriteEnabled(process.env)) {
    return json(403, {
      error: '移行ジョブは無効です（MIGRATION_WRITE_ENABLED 未設定）',
      flag: 'MIGRATION_WRITE_ENABLED',
      reason: 'blocked_by_design',
      sideEffects: 'none',
    });
  }

  let cmd;
  try { cmd = makeRedisCmd(process.env); } catch {
    return json(503, { error: 'Redis 未設定', sideEffects: 'none' });
  }

  const nowIso = new Date().toISOString();

  try {
    if (action === 'status') {
      const job = await loadJob(cmd, jobType);
      // dual の実効性を確認するためのカウンタ（webhook が積む）。件数だけ。
      let sink = null;
      try {
        const raw = await cmd(['HGETALL', 'ak:mkt:events:sink']);
        if (Array.isArray(raw)) {
          sink = {};
          for (let i = 0; i < raw.length; i += 2) sink[raw[i]] = raw[i + 1];
        } else if (raw && typeof raw === 'object') {
          sink = raw;
        }
      } catch { sink = null; }
      return json(200, { job: toPublicJob(job), eventSink: sink, sideEffects: 'none' });
    }

    if (action === 'start') {
      const existing = await loadJob(cmd, jobType);
      if (existing && existing.status === JOB_STATUS.RUNNING && !req.restart) {
        return json(409, {
          error: '実行中のジョブがあります（やり直すなら restart:true）',
          job: toPublicJob(existing), sideEffects: 'none',
        });
      }
      const job = createJob({ jobType, chunkSize: clampChunk(req.chunkSize, jobType), nowIso });
      await saveJob(cmd, job);
      return json(200, { job: toPublicJob(job), sideEffects: 'ジョブ状態のみ' });
    }

    if (action === 'step') {
      const token = `${nowIso}:${Math.floor(Number(process.hrtime.bigint() % 1000000n))}`;
      if (!await acquireLock(cmd, jobType, token)) {
        return json(409, { error: '他の step が実行中です', sideEffects: 'none' });
      }
      try {
        const job = await loadJob(cmd, jobType);
        const gate = canStep(job);
        if (!gate.ok) return json(409, { error: gate.reason, job: toPublicJob(job), sideEffects: 'none' });

        const runner = jobType === JOB_TYPE.DELIVERY_KEYS ? stepDeliveryKeys : stepEmailEvents;
        let result;
        try {
          result = await runner({ KEY, BASE, cmd, job, event });
        } catch (e) {
          const failed = failJob(job, e.type || e.message || 'step_failed', nowIso);
          await saveJob(cmd, failed);
          // 理由コードだけ（値・鍵・アドレスは出さない）
          console.error('🚨 [migration] step failed:', failed.lastError);
          return json(502, { error: 'step failed', job: toPublicJob(failed), sideEffects: '部分適用あり（冪等なので再実行可）' });
        }

        let next = applyStep(job, result.delta, nowIso);
        if (result.done) {
          const bal = verifyBalance(next);
          if (!bal.balanced) {
            next = failJob(next, `unbalanced:${bal.missing}`, nowIso);
            await saveJob(cmd, next);
            return json(500, { error: '件数が合わないため完了にしません', job: toPublicJob(next), sideEffects: 'none' });
          }
          next = completeJob(next, nowIso);
        }
        await saveJob(cmd, next);
        console.log(`✅ [migration] step ${jobType}: read=${next.recordsRead} written=${next.recordsWritten} status=${next.status}`);
        return json(200, { job: toPublicJob(next), done: result.done === true, sideEffects: 'Redis / Blob のみ（Airtable 不変）' });
      } finally {
        await releaseLock(cmd, jobType, token);
      }
    }

    if (action === 'indexBlobEvents') {
      // Blob に入っている EventKey を Redis の集合へ索引化する（突合のため）。
      // **Blob は読むだけ**。書き戻さない（read-modify-write を作らない）。
      const { getStore, connectLambda } = await import('@netlify/blobs');
      connectLambda(event);
      const blobs = getStore('ak-email-events');
      // ⚠️ cursor は使わない。`list()` の cursor は paginate 指定と組み合わせが決まっており、
      //    誤用すると落ちる。blob 数は数十個なので**一覧は毎回取り直し、範囲で切る**。
      const listed = await blobs.list({ prefix: 'ak/email-events/' });
      const all = (listed.blobs || []).slice().sort((a, b) => (a.key < b.key ? -1 : 1));
      const from = Math.max(0, Number(req.from) || 0);
      const limit = Math.max(1, Math.min(20, Number(req.limit) || 10));
      const slice = all.slice(from, from + limit);
      const byType = {};
      let keys = 0;
      const setKey = `${JOB_NAMESPACE}:eventkeys`;
      for (const b of slice) {
        const body = await blobs.get(b.key);
        if (!body) continue;
        const found = [];
        for (const line of String(body).split('\n')) {
          if (!line.trim()) continue;
          let o = null;
          try { o = JSON.parse(line); } catch { continue; }
          if (o.eventKey) found.push(String(o.eventKey));
          if (o.eventType) byType[o.eventType] = (byType[o.eventType] || 0) + 1;
        }
        for (let i = 0; i < found.length; i += 200) {
          await cmd(['SADD', setKey, ...found.slice(i, i + 200)]);
        }
        keys += found.length;
      }
      const total = await cmd(['SCARD', setKey]);
      const nextFrom = from + slice.length;
      return json(200, {
        totalBlobs: all.length,
        blobsRead: slice.length,
        keysIndexed: keys,
        uniqueInRedis: Number(total) || 0,
        byType,
        nextFrom: nextFrom < all.length ? nextFrom : null,
        sideEffects: 'Redis の索引集合のみ（Blob / Airtable 不変）',
      });
    }

    if (action === 'verifyEvents') {
      // Airtable の EventKey が Blob 索引に含まれるかを照合する。件数のみ返す。
      const keys = Array.isArray(req.keys) ? req.keys : [];
      if (keys.length === 0 || keys.length > 500) {
        return json(400, { error: 'keys は 1〜500 件', sideEffects: 'none' });
      }
      const setKey = `${JOB_NAMESPACE}:eventkeys`;
      let res;
      try {
        res = await cmd(['SMISMEMBER', setKey, ...keys]);
      } catch {
        return json(503, { error: 'redis_unavailable', sideEffects: 'none' });
      }
      if (!Array.isArray(res) || res.length !== keys.length) {
        return json(502, { error: 'unexpected_response', sideEffects: 'none' });
      }
      const present = res.filter((x) => Number(x) === 1).length;
      return json(200, { checked: keys.length, present, missing: keys.length - present, sideEffects: 'none' });
    }

    if (action === 'verify') {
      // 集合そのものを照合する。**件数一致では PASS にしない**ため。
      // 受け取るのは呼び出し側が Airtable から読んだ DeliveryKey（sha256 hex）で、
      // アドレスではない。**返すのは件数だけ**（どの鍵が欠けたかは返さない）。
      const campaignId = String(req.campaignId || '').trim();
      const version = Number(req.version);
      const keys = Array.isArray(req.keys) ? req.keys : [];
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(campaignId) || !Number.isInteger(version)) {
        return json(400, { error: 'campaignId / version が必要です', sideEffects: 'none' });
      }
      if (keys.length === 0 || keys.length > 500) {
        return json(400, { error: 'keys は 1〜500 件', sideEffects: 'none' });
      }
      const store = createDeliveryKeyStore({ redisCmd: cmd });
      let present;
      try {
        present = await store.filterDelivered({ brand: BRAND, campaignId, version, keys });
      } catch (e) {
        // 判定できないものを「一致」と扱わない
        return json(503, { error: 'redis_unavailable', sideEffects: 'none' });
      }
      return json(200, {
        checked: keys.length,
        present: present.length,
        missing: keys.length - present.length,
        sideEffects: 'none',
      });
    }

    if (action === 'reconcile') {
      if (jobType !== JOB_TYPE.DELIVERY_KEYS) {
        return json(400, { error: 'reconcile は delivery-keys のみ（EmailEvents は scripts/reconcile-email-events.mjs）', sideEffects: 'none' });
      }
      const campaignId = String(req.campaignId || '').trim();
      const version = Number(req.version);
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(campaignId) || !Number.isInteger(version)) {
        return json(400, { error: 'campaignId / version が必要です', sideEffects: 'none' });
      }
      const store = createDeliveryKeyStore({ redisCmd: cmd });
      let redisKeys = null;
      try { redisKeys = await store.members({ brand: BRAND, campaignId, version }); } catch { redisKeys = null; }

      // Airtable 側は 1 回では読み切れないので、**件数だけ**をここで返す。
      // 集合の完全突合は scripts/reconcile-delivery-stores.mjs（時間制限なし）で行う。
      return json(200, {
        note: '集合の完全突合は scripts/reconcile-delivery-stores.mjs で実施してください（Function では読み切れません）',
        redisCount: redisKeys ? redisKeys.size : null,
        redisAvailable: redisKeys !== null,
        sideEffects: 'none',
      });
    }

    return json(400, { error: `未知の action: ${action}`, sideEffects: 'none' });
  } catch (e) {
    // 理由コード（例外名）だけ返す。値・アドレス・鍵は出さない
    const name = String(e?.name || 'Error');
    console.error('🚨 [migration] unexpected:', name);
    return json(500, { error: 'unexpected error', errorName: name, sideEffects: 'none' });
  }
};

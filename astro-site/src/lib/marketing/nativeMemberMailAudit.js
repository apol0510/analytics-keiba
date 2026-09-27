/**
 * 元々の会員（native）へのマーケティングメール再開 A/B/C 比較用の **読み取り専用監査**。
 *
 * 正本: `docs/progress.md` の「📬 元々の会員へのメール再開 — A/B/C 比較用 read-only 監査」ブロック。
 *
 * ── 何を返すか（件数だけ）──────────────────────────────────────────
 *  - baseline  … 元々の会員の母数と集合 digest（窓ごと。クライアントが足し合わせる）
 *  - customers … プラン・契約の内訳 / 送信可否と除外理由 / 9/24 以降の旧 AK 経路の受信 / DRM との重複
 *  - deliveries… 旧 AK 経路（CampaignDeliveries / ScheduledEmails）の 9/24 以降の日別・campaign 別件数
 *  - sendgrid  … SendGrid Marketing の GET で見える状態（lists / segments / singlesends / 予約 / suppression）
 *  - policy    … 頻度上限の実効状況（静的な事実。**修正しない**）
 *
 * ── 絶対条件（テストで固定）──────────────────────────────────────
 *  - **書き込み経路を持たない**。外部 I/O は `createReadOnlyFetch`（GET 以外は例外）と
 *    `createReadOnlyRedis`（GET / SMEMBERS / SCARD 以外は例外）だけを通す。
 *  - **件数だけ**。メールアドレス・氏名・recordId・token・secret を返さない。
 *    Airtable の offset は recordId を含むので、そのまま返さず暗号化した cursor にする。
 *    返す直前に `findPii` で検査し、1 つでも見つかれば中身を捨てて fail closed。
 *  - **元々の会員の定義は `importCohort.resolveCohort(fields) === 'existing'` だけ**
 *    （＝ `Source` が `customer-import:` で始まらない）。formula はそこから組み立て、
 *    読んだ全レコードを `resolveCohort` で再確認する（食い違えば fail closed）。
 *  - **除外理由は `audienceSegments.resolveSegmentExclusion` の順序・コードをそのまま使う**。
 *  - 1 リクエストで全件を読まない。窓（最大 5 ページ = 500 件）＋ cursor で進め、
 *    上限に当たったら黙って打ち切らず fail closed。
 *  - 判断できないもの（SendGrid contacts に native が居るか）は測らず理由コードで返す。
 */

import crypto from 'node:crypto';
import { IMPORT_SOURCE_PREFIX, resolveCohort, COHORT } from './importCohort.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import { resolveSegmentExclusion, SEG_EXCLUDE } from '../crm/audienceSegments.js';
import { buildBlacklistEmailSet } from '../newsletter/airtable-fetch.js';
import { fetchProviderSuppression } from './providerSuppression.js';
import { createEngagementBlocklistStore } from './engagementBlocklistStore.js';
import { parseCampaignType } from './campaignCustomArgs.js';
import { FUNNEL_STAGES, resolveFunnelStage } from '../drm/drmFunnel.js';

export const NATIVE_AUDIT_ACTION = 'nativeMailAudit';

export const NATIVE_AUDIT_PHASE = Object.freeze({
  BASELINE: 'baseline',
  CUSTOMERS: 'customers',
  DELIVERIES: 'deliveries',
  SENDGRID: 'sendgrid',
  POLICY: 'policy',
});
export const NATIVE_AUDIT_PHASES = Object.freeze(Object.values(NATIVE_AUDIT_PHASE));

/** 受け付ける入力キー。これ以外が来たら中止する（`apply` 等を黙って無視しない） */
export const NATIVE_AUDIT_REQUEST_KEYS = Object.freeze(['action', 'phase', 'cursor', 'pages']);

/** 2026-09-24 00:00 JST（割引 campaign の期間終了＝旧 AK 経路の送信が止まった境目） */
export const NATIVE_AUDIT_SINCE_ISO = '2026-09-23T15:00:00.000Z';
const SINCE_MS = Date.parse(NATIVE_AUDIT_SINCE_ISO);

export const WINDOW_DEFAULT_PAGES = 3;
export const WINDOW_MAX_PAGES = 5;
/** 補助テーブル（ブラックリスト・配信台帳の絞り込み結果）の上限。超えたら fail closed */
export const AUX_MAX_PAGES = 20;
export const SENDGRID_MAX_PAGES = 5;

export const READ_ONLY_REDIS_COMMANDS = Object.freeze(['GET', 'SMEMBERS', 'SCARD']);

export const NATIVE_AUDIT_FAIL = Object.freeze({
  UNKNOWN_PHASE: 'unknown_phase',
  UNKNOWN_REQUEST_KEY: 'unknown_request_key',
  INVALID_PAGES: 'invalid_pages',
  INVALID_CURSOR: 'invalid_cursor',
  CURSOR_PHASE_MISMATCH: 'cursor_phase_mismatch',
  CURSOR_EXPIRED: 'cursor_expired',
  COHORT_MISMATCH: 'cohort_formula_mismatch',
  AUX_SCAN_LIMIT: 'aux_scan_limit',
  AIRTABLE_RATE_LIMITED: 'airtable_rate_limited',
  AIRTABLE_HTTP: 'airtable_http_error',
  PII_GUARD: 'pii_guard_tripped',
  WRITE_FORBIDDEN: 'write_method_forbidden',
  REDIS_COMMAND_FORBIDDEN: 'redis_command_forbidden',
  CONFIG_MISSING: 'config_missing',
});

/** 測らないもの（read-only 契約の外） */
export const UNAVAILABLE_BY_READ_ONLY_CONTRACT = 'unavailable_by_read_only_contract';

/**
 * 頻度上限の実効状況（**2026-09-27 コード確認の事実。この監査では直さない**）。
 * A/B/C の判断材料として毎回同じ文面で返す。
 */
export const FREQUENCY_POLICY_FACTS = Object.freeze({
  sevenDayTwoSendCap: Object.freeze({
    spec: '7 日で 2 通まで（sequencePolicy.checkFrequencyCap 既定 windowDays 7 / maxSends 2）',
    productionEffect: 'none',
    reason: 'checkFrequencyCap は recentSendAtMs を受け取るが、呼び出し側のどこからも recentSendAtMs が渡されていない（常に空配列で判定され、上限に達しない）',
  }),
  crossCampaign24hGuard: Object.freeze({
    spec: '別 campaign を含め 24 時間以内に marketing を受けた宛先へ送らない（marketingDispatchGate.verifyBeforeSend / isRecentMarketingContact）',
    scope: 'old_ak_dispatch_only',
    reason: '材料は CampaignDeliveries の EmailType=campaign の sent / queued 行だけ。SendGrid Marketing Campaigns の送信は CampaignDeliveries に行を作らないため、このガードは SendGrid MC 送信に効かない',
  }),
  note: '事実の記録のみ。修正は A/B/C の判断後に別作業で行う。',
});

// ─── 読み取り専用 I/O ─────────────────────────────────────────────

/**
 * GET 以外を**送る前に**例外にする fetch。`method` 未指定は GET 扱い。
 * body を持つ呼び出しも拒否する（GET に body を付ける経路を作らせない）。
 */
export function createReadOnlyFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error(NATIVE_AUDIT_FAIL.CONFIG_MISSING);
  return async (url, init = {}) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method !== 'GET' || (init && init.body !== undefined && init.body !== null)) {
      throw new Error(NATIVE_AUDIT_FAIL.WRITE_FORBIDDEN);
    }
    return fetchImpl(url, { ...init, method: 'GET' });
  };
}

/** 読み取りコマンドだけを通す Redis。書き込み系は送る前に例外 */
export function createReadOnlyRedis(redisCmd) {
  if (typeof redisCmd !== 'function') return null;
  return async (args) => {
    const cmd = String((Array.isArray(args) && args[0]) || '').toUpperCase();
    if (!READ_ONLY_REDIS_COMMANDS.includes(cmd)) throw new Error(NATIVE_AUDIT_FAIL.REDIS_COMMAND_FORBIDDEN);
    return redisCmd(args);
  };
}

// ─── 定義（単一源から組み立てる）─────────────────────────────────

/** 元々の会員を Airtable で絞る formula（`IMPORT_SOURCE_PREFIX` から組み立てる） */
export function buildNativeMemberFormula() {
  return `NOT(LEFT({Source}, ${IMPORT_SOURCE_PREFIX.length}) = '${IMPORT_SOURCE_PREFIX}')`;
}

/** DRM の campaign id（`drmFunnel.FUNNEL_STAGES` から導く。ここで列挙しない） */
export function drmCampaignIds() {
  const nurture = new Set();
  const offers = new Set();
  for (const s of FUNNEL_STAGES) {
    if (s.nurtureCampaignId) nurture.add(s.nurtureCampaignId);
    for (const o of s.offerCampaignIds || []) offers.add(o);
  }
  return { nurture: [...nurture].sort(), offers: [...offers].sort() };
}

/** 集合 digest の 1 件分（順序に依らず足せる。recordId そのものは返さない） */
export function digestPart(recordId) {
  const h = crypto.createHash('sha256').update(String(recordId)).digest('hex');
  return parseInt(h.slice(0, 8), 16);
}

const str = (v) => String(v ?? '').trim();
const em = (v) => str(v).toLowerCase();
const inc = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

/** JST の日付（YYYY-MM-DD） */
export function jstDay(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 画面・ログへ出す主区分（重なりは優先順で 1 つに畳む。全軸は `planContract` で別に返す）。
 * 退会 → 判定不能 → 期限切れ → premium → light → free。
 */
export function primaryBucket(mk) {
  if (mk.withdrawn === true) return 'withdrawn';
  if (mk.contract === MK_CONTRACT.UNKNOWN) return 'undeterminable';
  if (mk.contract === MK_CONTRACT.EXPIRED) return 'expired';
  if (mk.plan === MK_PLAN.PREMIUM || mk.plan === MK_PLAN.PREMIUM_SANRENPUKU) return 'premium';
  if (mk.plan === MK_PLAN.LIGHT) return 'light';
  if (mk.plan === MK_PLAN.FREE) return 'free';
  return 'undeterminable';
}

// ─── cursor（Airtable offset は recordId を含むので封をする）──────────

function cursorKey(secret) {
  return crypto.createHash('sha256').update(`native-mail-audit:v1:${String(secret)}`).digest();
}

export function sealCursor({ phase, offset, carry }, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ p: phase, o: offset, c: carry || null }), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openCursor(token, secret) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', cursorKey(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const v = JSON.parse(out);
    return v && typeof v === 'object' ? { phase: v.p, offset: v.o, carry: v.c } : null;
  } catch {
    return null;
  }
}

/** 境界の重複検出用（アドレスを出さない。secret 付き HMAC の先頭だけ） */
function carryOf(email, secret) {
  return crypto.createHmac('sha256', String(secret)).update(email).digest('hex').slice(0, 24);
}

// ─── PII 検査 ────────────────────────────────────────────────────

const PII_PATTERNS = Object.freeze([
  /[^\s"'<>@]+@[^\s"'<>@]+\.[a-z]{2,}/i, // メールアドレス
  /\brec[A-Za-z0-9]{14}\b/,               // Airtable recordId
  /\bitr[A-Za-z0-9]{14}\b/,               // Airtable offset
  /\bSG\.[A-Za-z0-9_-]{10,}/,             // SendGrid key
  /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{20,}/,  // Airtable PAT
]);

/** 応答に PII / 秘密値らしき文字列が含まれていれば、その種類の番号を返す（無ければ null） */
export function findPii(body, extraSecrets = []) {
  const s = JSON.stringify(body);
  for (let i = 0; i < PII_PATTERNS.length; i += 1) if (PII_PATTERNS[i].test(s)) return `pattern_${i}`;
  for (const sec of extraSecrets) if (sec && String(sec).length >= 8 && s.includes(String(sec))) return 'secret_value';
  return null;
}

/** 外部由来の名前（list 名等）にアドレスが紛れていたら伏せる */
function safeName(v) {
  const s = str(v).slice(0, 80);
  return /@/.test(s) || /\brec[A-Za-z0-9]{14}\b/.test(s) ? '[redacted]' : s;
}

// ─── Airtable GET ────────────────────────────────────────────────

class AuditError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || null; }
}

async function airtablePage({ rf, KEY, BASE, table, formula, fields, sort, offset }) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
  url.searchParams.set('pageSize', '100');
  if (formula) url.searchParams.set('filterByFormula', formula);
  for (const f of fields || []) url.searchParams.append('fields[]', f);
  if (sort) {
    url.searchParams.set('sort[0][field]', sort);
    url.searchParams.set('sort[0][direction]', 'asc');
  }
  if (offset) url.searchParams.set('offset', offset);
  const res = await rf(url.toString(), { headers: { Authorization: `Bearer ${KEY}` } });
  if (res.status === 429) throw new AuditError(NATIVE_AUDIT_FAIL.AIRTABLE_RATE_LIMITED);
  if (res.status === 422) {
    let type = '';
    try { type = str(((await res.json()) || {}).error?.type); } catch { /* ignore */ }
    if (type.includes('ITERATOR')) throw new AuditError(NATIVE_AUDIT_FAIL.CURSOR_EXPIRED);
    throw new AuditError(NATIVE_AUDIT_FAIL.AIRTABLE_HTTP, `${table}:422`);
  }
  if (!res.ok) throw new AuditError(NATIVE_AUDIT_FAIL.AIRTABLE_HTTP, `${table}:${res.status}`);
  const data = await res.json();
  return { records: Array.isArray(data.records) ? data.records : [], offset: data.offset || null };
}

/** 補助テーブルを上限つきで読み切る（上限に当たったら **fail closed**。黙って短くしない） */
async function airtableAllBounded(args) {
  const out = [];
  let offset = null;
  let pages = 0;
  do {
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const page = await airtablePage({ ...args, offset });
    out.push(...page.records);
    offset = page.offset;
    pages += 1;
    if (offset && pages >= AUX_MAX_PAGES) throw new AuditError(NATIVE_AUDIT_FAIL.AUX_SCAN_LIMIT, args.table);
  } while (offset);
  return out;
}

/** 元々の会員を窓 1 つぶん読む（Email 昇順 / cursor 継続） */
async function readNativeWindow({ rf, KEY, BASE, offset, pages, fields }) {
  const records = [];
  let next = offset || null;
  let read = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await airtablePage({
      rf, KEY, BASE, table: 'Customers', formula: buildNativeMemberFormula(), fields, sort: 'Email', offset: next,
    });
    records.push(...page.records);
    next = page.offset;
    read += 1;
  } while (next && read < pages);
  return { records, next, pagesRead: read };
}

function assertAllNative(records) {
  const bad = records.filter((r) => resolveCohort((r && r.fields) || {}) !== COHORT.EXISTING).length;
  if (bad > 0) throw new AuditError(NATIVE_AUDIT_FAIL.COHORT_MISMATCH, String(bad));
}

function digestOf(records) {
  let sum = 0;
  for (const r of records) sum += digestPart(r.id);
  return { count: records.length, sum };
}

const DELIVERY_FIELDS = Object.freeze(['RecipientEmail', 'Status', 'EmailType', 'CampaignType', 'SentAt', 'QueuedAt']);

function deliveryAtMs(rec) {
  const f = rec.fields || {};
  const t = Date.parse(f.SentAt || f.QueuedAt || rec.createdTime || '');
  return Number.isFinite(t) ? t : null;
}

function sinceFormula() {
  const cut = new Date(SINCE_MS - 1000).toISOString();
  return `OR(IS_AFTER({SentAt}, '${cut}'), IS_AFTER({QueuedAt}, '${cut}'), IS_AFTER(CREATED_TIME(), '${cut}'))`;
}

/**
 * DRM 育成（nurture）campaign の配信行だけ。
 * オファー（割引等）は旧 AK 経路の期間つき配信で、9/24 以降の件数（deliveries）側で数える。
 * 全期間の割引行は数千行になり得るので、ここへ混ぜない（窓ごとに読むため）。
 */
function drmFormula() {
  const ids = drmCampaignIds().nurture;
  return `OR(${ids.map((id) => `LEFT({CampaignType}, ${id.length + 2}) = '${id}:v'`).join(', ')})`;
}

async function loadSinceDeliveries(ctx) {
  const rows = await airtableAllBounded({
    ...ctx, table: 'CampaignDeliveries', formula: sinceFormula(), fields: DELIVERY_FIELDS,
  });
  // formula は日時列の欠損に寛容なので、JS 側でも境目を確かめる
  return rows.filter((r) => { const t = deliveryAtMs(r); return t !== null && t >= SINCE_MS; });
}

async function loadDrmDeliveries(ctx) {
  return airtableAllBounded({ ...ctx, table: 'CampaignDeliveries', formula: drmFormula(), fields: DELIVERY_FIELDS });
}

// ─── phase: baseline ─────────────────────────────────────────────

async function phaseBaseline({ ctx, pages, cursor, secret }) {
  const w = await readNativeWindow({ ...ctx, offset: cursor && cursor.offset, pages, fields: ['Source'] });
  assertAllNative(w.records);
  return {
    window: { records: w.records.length, pagesRead: w.pagesRead },
    digest: digestOf(w.records),
    next: w.next ? sealCursor({ phase: NATIVE_AUDIT_PHASE.BASELINE, offset: w.next }, secret) : null,
    done: !w.next,
  };
}

// ─── phase: customers ────────────────────────────────────────────

const CUSTOMER_FIELDS = null; // 判定に使う列が多いので全列（出力は件数だけ）

async function loadExclusionInputs({ ctx, rf, redis, sendgridKey, nowMs }) {
  const blRows = await airtableAllBounded({ ...ctx, table: 'EmailBlacklist', fields: ['Email', 'Status'] });
  const hard = buildBlacklistEmailSet(blRows);
  const soft = new Set(blRows.map((r) => em((r.fields || {}).Email)).filter(Boolean));
  const provider = sendgridKey
    ? await fetchProviderSuppression({ apiKey: sendgridKey, fetchImpl: rf, now: nowMs })
    : { ok: false, error: 'provider_key_missing' };
  let engagement = { usable: false, reason: 'redis_not_configured', emails: new Set() };
  if (redis) {
    try {
      engagement = await createEngagementBlocklistStore({ redisCmd: redis }).read({ nowMs });
    } catch { engagement = { usable: false, reason: 'unavailable', emails: new Set() }; }
  }
  return { hard, soft, provider, engagement };
}

export function summarizeNativeWindow({
  records, nowMs, hard, soft, providerSuppressed, engagementBlocked, sinceRows, drmRows, carryIn, secret,
}) {
  const breakdown = {};
  const planContract = {};
  const withdrawn = { total: 0, sendable: 0 };
  const byReason = {};
  let sendable = 0;
  let paidMember = 0;
  let noEmail = 0;
  let duplicateInWindow = 0;
  let boundaryDuplicate = false;
  const drmStage = {};

  const sinceBy = new Map();
  for (const r of sinceRows || []) {
    const e = em((r.fields || {}).RecipientEmail);
    if (!e) continue;
    if (!sinceBy.has(e)) sinceBy.set(e, []);
    sinceBy.get(e).push(r);
  }
  const drmBy = new Map();
  for (const r of drmRows || []) {
    const e = em((r.fields || {}).RecipientEmail);
    if (!e) continue;
    if (!drmBy.has(e)) drmBy.set(e, []);
    drmBy.get(e).push(r);
  }
  const { nurture } = drmCampaignIds();
  const since = { recipients: 0, rowsByStatus: {}, recipientsByCampaign: {} };
  const drm = { stage: drmStage, withNurtureDelivery: 0, recipientsByCampaign: {} };

  const counts = new Map();
  for (const r of records) {
    const e = em((r.fields || {}).Email);
    if (e) counts.set(e, (counts.get(e) || 0) + 1);
  }
  const seen = new Set();
  let lastEmail = null;
  let first = true;

  for (const r of records) {
    const f = r.fields || {};
    const e = em(f.Email);
    if (!e) { noEmail += 1; continue; }
    if (first) {
      first = false;
      if (carryIn && carryOf(e, secret) === carryIn) boundaryDuplicate = true;
    }
    lastEmail = e;
    if (seen.has(e)) { duplicateInWindow += 1; continue; }
    seen.add(e);

    const mk = resolveCustomerMarketing({ fields: f, nowMs, blacklistEmails: hard });
    inc(breakdown, primaryBucket(mk));
    inc(planContract, `${mk.plan}|${mk.contract}`);

    const reason = resolveSegmentExclusion({
      fields: f, email: e, marketing: mk, duplicate: counts.get(e) > 1,
      blacklistHard: hard, blacklistSoft: soft, providerSuppressed,
      engagementBlockedEmails: engagementBlocked, nowMs,
    });
    if (reason) inc(byReason, reason);
    else sendable += 1;
    if (reason === SEG_EXCLUDE.PAID_MEMBER) paidMember += 1;
    if (mk.withdrawn === true) {
      withdrawn.total += 1;
      if (!reason || reason === SEG_EXCLUDE.PAID_MEMBER) withdrawn.sendable += 1;
    }

    const stage = resolveFunnelStage(mk) || 'undeterminable';
    inc(drmStage, stage);

    const sr = sinceBy.get(e);
    if (sr) {
      since.recipients += 1;
      const camps = new Set();
      for (const row of sr) {
        const rf = row.fields || {};
        inc(since.rowsByStatus, str(rf.Status) || 'unknown');
        camps.add((parseCampaignType(rf.CampaignType) || {}).campaignId || 'unknown');
      }
      for (const c of camps) inc(since.recipientsByCampaign, c);
    }
    const dr = drmBy.get(e);
    if (dr) {
      const camps = new Set(dr.map((row) => (parseCampaignType((row.fields || {}).CampaignType) || {}).campaignId || 'unknown'));
      if ([...camps].some((c) => nurture.includes(c))) drm.withNurtureDelivery += 1;
      for (const c of camps) inc(drm.recipientsByCampaign, c);
    }
  }

  const unique = seen.size;
  const excluded = Object.values(byReason).reduce((a, b) => a + b, 0);
  return {
    records: records.length,
    uniqueMembers: unique,
    noEmail,
    duplicateInWindow,
    boundaryDuplicate,
    carryOut: lastEmail ? carryOf(lastEmail, secret) : (carryIn || null),
    breakdown,
    planContract,
    withdrawn,
    sendability: {
      sendable,
      excluded,
      byReason,
      /** 有料会員は割引・カムバック系の除外に当たるだけで、配信拒否ではない（B 案の対象になり得る） */
      paidMember,
      sendableIncludingPaid: sendable + paidMember,
      balanced: unique === sendable + excluded,
    },
    since,
    drm,
  };
}

async function phaseCustomers({ ctx, rf, redis, sendgridKey, nowMs, pages, cursor, secret }) {
  const inputs = await loadExclusionInputs({ ctx, rf, redis, sendgridKey, nowMs });
  const [sinceRows, drmRows] = [await loadSinceDeliveries(ctx), await loadDrmDeliveries(ctx)];
  const w = await readNativeWindow({ ...ctx, offset: cursor && cursor.offset, pages, fields: CUSTOMER_FIELDS });
  assertAllNative(w.records);
  const summary = summarizeNativeWindow({
    records: w.records,
    nowMs,
    hard: inputs.hard,
    soft: inputs.soft,
    providerSuppressed: inputs.provider.ok ? inputs.provider.emails : null,
    engagementBlocked: inputs.engagement.usable ? inputs.engagement.emails : null,
    sinceRows,
    drmRows,
    carryIn: cursor && cursor.carry,
    secret,
  });
  const { carryOut, ...rest } = summary;
  return {
    window: { pagesRead: w.pagesRead },
    digest: digestOf(w.records),
    ...rest,
    inputs: {
      blacklistRows: inputs.soft.size,
      providerSuppression: inputs.provider.ok
        ? { available: true, total: inputs.provider.total }
        : { available: false, reason: str(inputs.provider.error) || 'unavailable', effect: 'all_counted_as_provider_unknown' },
      engagementBlocklist: inputs.engagement.usable
        ? { applied: true, size: inputs.engagement.count }
        : { applied: false, reason: str(inputs.engagement.reason) || 'unavailable' },
      recentContactAndAlreadyDelivered: 'not_evaluated_campaign_specific',
    },
    next: w.next ? sealCursor({ phase: NATIVE_AUDIT_PHASE.CUSTOMERS, offset: w.next, carry: carryOut }, secret) : null,
    done: !w.next,
  };
}

// ─── phase: deliveries ───────────────────────────────────────────

export function summarizeSinceDeliveries(rows) {
  const byDay = {};
  const byCampaign = {};
  const byStatus = {};
  const byEmailType = {};
  for (const r of rows) {
    const f = r.fields || {};
    const t = deliveryAtMs(r);
    const day = t === null ? 'unknown' : jstDay(t);
    const camp = (parseCampaignType(f.CampaignType) || {}).campaignId || 'unknown';
    const status = str(f.Status) || 'unknown';
    byDay[day] = byDay[day] || {};
    inc(byDay[day], status);
    byCampaign[camp] = byCampaign[camp] || {};
    inc(byCampaign[camp], status);
    inc(byStatus, status);
    inc(byEmailType, str(f.EmailType) || 'unknown');
  }
  return { rows: rows.length, byDay, byCampaign, byStatus, byEmailType };
}

async function phaseDeliveries({ ctx }) {
  const rows = await loadSinceDeliveries(ctx);
  const cut = new Date(SINCE_MS - 1000).toISOString();
  const jobs = await airtableAllBounded({
    ...ctx, table: 'ScheduledEmails', formula: `IS_AFTER(CREATED_TIME(), '${cut}')`,
    fields: ['Status', 'RecipientCount', 'SentCount', 'FailedCount'],
  });
  const jobsByStatus = {};
  let recipients = 0;
  let sent = 0;
  let failed = 0;
  for (const j of jobs) {
    const f = j.fields || {};
    inc(jobsByStatus, str(f.Status) || 'unknown');
    recipients += Number(f.RecipientCount) || 0;
    sent += Number(f.SentCount) || 0;
    failed += Number(f.FailedCount) || 0;
  }
  return {
    since: NATIVE_AUDIT_SINCE_ISO,
    campaignDeliveries: summarizeSinceDeliveries(rows),
    scheduledEmails: { jobs: jobs.length, byStatus: jobsByStatus, recipientCount: recipients, sentCount: sent, failedCount: failed },
    ledgerCoverage: 'SendGrid Marketing Campaigns と prospect 送信は CampaignDeliveries に行を作らないため、ここには含まれない',
    done: true,
  };
}

// ─── phase: sendgrid ─────────────────────────────────────────────

async function sgGetAll(rf, apiKey, path) {
  const out = [];
  let url = `https://api.sendgrid.com${path}`;
  for (let i = 0; i < SENDGRID_MAX_PAGES && url; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rf(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) throw new AuditError('sendgrid_http_error', `${r.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await r.json();
    out.push(...(Array.isArray(data.result) ? data.result : []));
    const next = data._metadata && data._metadata.next;
    url = next && String(next).startsWith('https://api.sendgrid.com/') ? String(next) : null;
    if (url && i + 1 >= SENDGRID_MAX_PAGES) throw new AuditError('sendgrid_scan_limit', path);
  }
  return out;
}

async function phaseSendgrid({ rf, sendgridKey, nowMs }) {
  if (!sendgridKey) return { available: false, reason: 'provider_key_missing', done: true };
  const unavailable = [];
  const safe = async (name, fn) => {
    try { return await fn(); } catch (e) { unavailable.push({ name, reason: str(e && e.code) || 'error' }); return null; }
  };
  const [lists, segments, sends, suppression] = await Promise.all([
    safe('lists', () => sgGetAll(rf, sendgridKey, '/v3/marketing/lists?page_size=100')),
    safe('segments', () => sgGetAll(rf, sendgridKey, '/v3/marketing/segments/2.0')),
    safe('singleSends', () => sgGetAll(rf, sendgridKey, '/v3/marketing/singlesends?page_size=100')),
    safe('suppression', async () => {
      const p = await fetchProviderSuppression({ apiKey: sendgridKey, fetchImpl: rf, now: nowMs, useCache: false });
      if (!p.ok) throw new AuditError(str(p.error) || 'unavailable');
      return p;
    }),
  ]);
  const byStatus = {};
  const scheduled = [];
  for (const s of sends || []) {
    inc(byStatus, str(s.status) || 'unknown');
    if (str(s.status) === 'scheduled') scheduled.push({ name: safeName(s.name), sendAt: str(s.send_at) || null });
  }
  return {
    available: true,
    lists: lists && lists.map((l) => ({ name: safeName(l.name), contactCount: Number(l.contact_count) || 0 })),
    segments: segments && segments.map((s) => ({ name: safeName(s.name), contactsCount: Number(s.contacts_count) || 0 })),
    singleSends: sends && { total: sends.length, byStatus, scheduled },
    suppression: suppression && { total: suppression.total, byType: suppression.counts },
    nativeInSendgridContacts: {
      status: UNAVAILABLE_BY_READ_ONLY_CONTRACT,
      reason: 'contacts の照合は POST /v3/marketing/contacts/search が必要で、この監査は GET だけに限っている',
    },
    unavailable,
    done: true,
  };
}

// ─── 入口 ────────────────────────────────────────────────────────

function fail(status, code, extra = {}) {
  return { status, body: { mode: 'native-mail-audit', ok: false, sideEffects: 'none', code, ...extra } };
}

/**
 * @param {{
 *   req: object,
 *   deps: { fetchImpl: Function, redisCmd?: Function|null, airtableKey: string, baseId: string,
 *           sendgridKey?: string, cursorSecret: string, nowMs?: number },
 * }} input
 * @returns {Promise<{status:number, body:object}>}
 */
export async function runNativeMailAudit({ req = {}, deps = {} } = {}) {
  for (const k of Object.keys(req || {})) {
    if (!NATIVE_AUDIT_REQUEST_KEYS.includes(k)) return fail(400, NATIVE_AUDIT_FAIL.UNKNOWN_REQUEST_KEY, { key: safeName(k) });
  }
  const phase = str(req.phase);
  if (!NATIVE_AUDIT_PHASES.includes(phase)) {
    return fail(400, NATIVE_AUDIT_FAIL.UNKNOWN_PHASE, { phases: NATIVE_AUDIT_PHASES });
  }
  const pages = req.pages === undefined ? WINDOW_DEFAULT_PAGES : req.pages;
  if (!Number.isInteger(pages) || pages < 1 || pages > WINDOW_MAX_PAGES) {
    return fail(400, NATIVE_AUDIT_FAIL.INVALID_PAGES, { maxPages: WINDOW_MAX_PAGES });
  }
  const secret = str(deps.cursorSecret);
  if (!deps.airtableKey || !deps.baseId || !secret || typeof deps.fetchImpl !== 'function') {
    return fail(503, NATIVE_AUDIT_FAIL.CONFIG_MISSING);
  }
  let cursor = null;
  if (req.cursor !== undefined && req.cursor !== null && req.cursor !== '') {
    cursor = openCursor(req.cursor, secret);
    if (!cursor) return fail(400, NATIVE_AUDIT_FAIL.INVALID_CURSOR);
    if (cursor.phase !== phase) return fail(400, NATIVE_AUDIT_FAIL.CURSOR_PHASE_MISMATCH);
  }

  const rf = createReadOnlyFetch(deps.fetchImpl);
  const redis = createReadOnlyRedis(deps.redisCmd);
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const ctx = { rf, KEY: deps.airtableKey, BASE: deps.baseId };

  let result;
  try {
    if (phase === NATIVE_AUDIT_PHASE.BASELINE) result = await phaseBaseline({ ctx, pages, cursor, secret });
    else if (phase === NATIVE_AUDIT_PHASE.CUSTOMERS) {
      result = await phaseCustomers({ ctx, rf, redis, sendgridKey: deps.sendgridKey, nowMs, pages, cursor, secret });
    } else if (phase === NATIVE_AUDIT_PHASE.DELIVERIES) result = await phaseDeliveries({ ctx });
    else if (phase === NATIVE_AUDIT_PHASE.SENDGRID) result = await phaseSendgrid({ rf, sendgridKey: deps.sendgridKey, nowMs });
    else result = { frequencyPolicy: FREQUENCY_POLICY_FACTS, done: true };
  } catch (e) {
    const code = (e && e.code) || (e && Object.values(NATIVE_AUDIT_FAIL).includes(e.message) ? e.message : 'internal_error');
    const retryable = code === NATIVE_AUDIT_FAIL.AIRTABLE_RATE_LIMITED;
    return fail(code === NATIVE_AUDIT_FAIL.WRITE_FORBIDDEN ? 500 : 502, code, {
      retryable, detail: e && e.detail ? safeName(e.detail) : null,
    });
  }

  const body = {
    mode: 'native-mail-audit',
    ok: true,
    sideEffects: 'none',
    phase,
    definition: {
      nativeMember: `importCohort.resolveCohort(fields) === '${COHORT.EXISTING}'（Source が '${IMPORT_SOURCE_PREFIX}' で始まらない）`,
    },
    evaluatedAt: new Date(nowMs).toISOString(),
    ...result,
    notice: '読み取りのみ・件数のみ。アドレス・氏名・recordId は含みません。',
  };
  // `next` は暗号化済みの cursor（中身は読めない）。乱数の base64 が recordId 形に
  // 偶然似ることがあるので、検査からは外す（それ以外は全部検査する）。
  const { next: _sealed, ...inspected } = body;
  const hit = findPii(inspected, [deps.airtableKey, deps.sendgridKey, secret]);
  if (hit) return fail(500, NATIVE_AUDIT_FAIL.PII_GUARD, { hit });
  return { status: 200, body };
}

export default runNativeMailAudit;

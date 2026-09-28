#!/usr/bin/env node
/**
 * 元々の会員（native）へのメール再開 A/B/C 比較用の **読み取り専用監査** クライアント。
 *
 * 本番の `admin-marketing` の `nativeMailAudit` を窓ごとに呼び、件数だけを合算して標準出力へ出す。
 * 判定・I/O 制限はサーバー側 `src/lib/marketing/nativeMemberMailAudit.js` にある。
 *
 * 使い方（秘密値を取り出さない）:
 *   netlify dev:exec --context production -- node astro-site/scripts/native-mail-audit.mjs
 *
 * - 呼ぶ action は `nativeMailAudit` だけ（それ以外を投げる経路を持たない）
 * - 秘密は `x-admin-secret`（`MARKETING_ADMIN_SECRET` か `PREMIUM_PLUS_ADMIN_SECRET`）を
 *   子プロセスの env から読むだけで、画面にもログにも出さない
 * - 結果はファイルへ書かない（repo 内に監査結果を残さない）
 * - 集合 digest を「前 → 本走査 → 後」で 3 回取り、1 つでも違えば **fail closed**
 *   （途中で Customers が増減したら数字を出さない）
 * - 窓の境目で同じアドレスが続いたら fail closed（二重に数えた可能性がある）
 */

const ADMIN_FN = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const ACTION = 'nativeMailAudit';
const PAGES = 3;
const MAX_WINDOWS = 200;

const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
if (!SECRET) {
  console.error('MARKETING_ADMIN_SECRET か PREMIUM_PLUS_ADMIN_SECRET が要ります（netlify dev:exec 経由で実行）');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function call(payload, tries = 4) {
  const body = { action: ACTION, ...payload };
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(ADMIN_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
      body: JSON.stringify(body),
    }).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    const json = res ? await res.json().catch(() => null) : null;
    if (res && res.status === 200 && json && json.ok === true) return json;
    const retryable = !res || res.status >= 500 || (json && json.retryable === true);
    if (!retryable || i + 1 >= tries) {
      throw new Error(`admin_failed:${payload.phase}:${res ? res.status : 'no_response'}:${(json && json.code) || ''}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(3000 * (i + 1));
  }
  throw new Error('unreachable');
}

async function walk(phase) {
  const windows = [];
  let cursor;
  for (let i = 0; i < MAX_WINDOWS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await call({ phase, pages: PAGES, ...(cursor ? { cursor } : {}) });
    windows.push(r);
    if (r.done) return windows;
    cursor = r.next;
    // eslint-disable-next-line no-await-in-loop
    await sleep(400); // Airtable 5 rps
  }
  throw new Error(`window_limit:${phase}`);
}

const addInto = (dst, src) => {
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v === 'number') dst[k] = (dst[k] || 0) + v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) addInto((dst[k] = dst[k] || {}), v);
  }
  return dst;
};
const digest = (ws) => ws.reduce((a, w) => ({ count: a.count + w.digest.count, sum: a.sum + w.digest.sum }), { count: 0, sum: 0 });

async function main() {
  const before = digest(await walk('baseline'));
  const cw = await walk('customers');
  const during = digest(cw);
  const after = digest(await walk('baseline'));
  const stable = before.count === during.count && before.sum === during.sum
    && after.count === during.count && after.sum === during.sum;
  if (!stable) {
    console.log(JSON.stringify({ ok: false, reason: 'set_changed_during_scan', counts: { before: before.count, during: during.count, after: after.count } }, null, 2));
    process.exit(3);
  }
  if (cw.some((w) => w.boundaryDuplicate === true)) {
    console.log(JSON.stringify({ ok: false, reason: 'boundary_duplicate_email' }, null, 2));
    process.exit(3);
  }

  const customers = {};
  for (const w of cw) {
    addInto(customers, {
      records: w.window ? w.digest.count : 0,
      uniqueMembers: w.uniqueMembers,
      noEmail: w.noEmail,
      duplicateInWindow: w.duplicateInWindow,
      breakdown: w.breakdown,
      planContract: w.planContract,
      withdrawn: w.withdrawn,
      baseSendability: w.baseSendability,
      policyRestrictions: w.policyRestrictions,
      since: w.since,
      drm: w.drm,
    });
  }
  customers.baseSendability.balanced = cw.every((w) => w.baseSendability && w.baseSendability.balanced === true);
  // 施策側の制約は「数えられたか」を最後の窓の状態で示す（数値以外は合算しない）
  const lastPolicy = cw[cw.length - 1].policyRestrictions || {};
  const appliedStates = new Set(cw.map((w) => Boolean(w.policyRestrictions?.engagementBlocked?.applied)));
  // 窓ごとに適用状態が割れたら（途中で除外リストが古くなった等）部分の合計を全体として出さない
  customers.policyRestrictions.engagementBlocked = appliedStates.size > 1
    ? { applied: 'inconsistent_across_windows', total: null, amongBaseSendable: null }
    : appliedStates.has(true)
      ? { applied: true, ...customers.policyRestrictions.engagementBlocked }
      : lastPolicy.engagementBlocked;
  customers.policyRestrictions.recentContact = lastPolicy.recentContact;
  customers.policyRestrictions.alreadyDelivered = lastPolicy.alreadyDelivered;
  customers.note = 'baseSendability は基本的な送信可否。policyRestrictions は施策ごとの制約で送信不可の意味ではない。案ごとの送信数は 1 つに潰さない。';
  customers.inputs = cw[cw.length - 1].inputs;

  const [deliveries, sendgrid, policy] = [await call({ phase: 'deliveries' }), await call({ phase: 'sendgrid' }), await call({ phase: 'policy' })];
  const strip = ({ mode, ok, sideEffects, phase, notice, done, next, ...rest }) => rest;

  console.log(JSON.stringify({
    ok: true,
    sideEffects: 'none',
    windows: cw.length,
    nativeMembers: during.count,
    digestStable: true,
    customers,
    deliveries: strip(deliveries),
    sendgrid: strip(sendgrid),
    policy: strip(policy),
  }, null, 2));
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});

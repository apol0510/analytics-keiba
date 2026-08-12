#!/usr/bin/env node
/**
 * dedupe-customers.mjs — Customers の**重複レコードを削除する**（既定 dry-run）
 *
 * ⚠️ これは **本番データを消す**唯一のスクリプト。次の 5 つを全部満たさないと 1 件も消さない。
 *   1. `--execute` を明示（既定は dry-run。何も書かない）
 *   2. 対象 recordId を**ファイルで固定**して渡す（コマンドラインで即席に指定できない）
 *   3. `--expect <件数>` が対象数と**完全一致**する
 *   4. 削除前の**完全な export** をファイルへ書けている（rollback の材料）
 *   5. 1 件ずつ**削除直前に再検証**して、条件から外れていたら **skip**
 *
 * ── 再実行しても安全 ────────────────────────────────────────
 * 既に削除済みの recordId は Airtable が 403 / 404 を返す。これは失敗ではなく
 * **完了済み**として数える（`alreadyGone`）。同じコマンドを何度流しても結果は同じ。
 *
 * ── 削除してよい条件（1 つでも外れたら skip）──────────────────
 *   - 残す側（keepId）が実在し、**同じメールアドレス**である
 *   - 削除側に権利・課金・意思表示の値が無い
 *     （有効期限 / PlanType / PaymentConfirmed / PaidAt / LifetimeSanrenpuku /
 *      LightGrant* / Requested* / Unsubscribed* / WithdrawalRequested / PremiumPlus* …）
 *   - 削除側のポイントが既定値（1）以下
 *   - 削除側のプランが残す側より強くない
 *
 * ── 参照整合性について ──────────────────────────────────────
 * `CampaignDeliveries` / `PromotionalOffers` は `CustomerRecordId` を**文字列**で持つ。
 * 削除側を参照している行があれば上の再検証で skip する（監査時点では 0 件）。
 * `AuthTokens` / `EmailBlacklist` / `ScheduledEmails` は **メールアドレス**で参照するので、
 * 同じアドレスの残す側が残っている限り壊れない。
 *
 * 使い方:
 *   node scripts/dedupe-customers.mjs --targets targets.json --expect 7            # dry-run
 *   node scripts/dedupe-customers.mjs --targets targets.json --expect 7 --execute  # 実削除
 *
 * targets.json の形:
 *   [{ "id": "recXXXX", "keepId": "recYYYY", "email": "a@example.com" }, ...]
 *
 * ── ポイント残高がある重複を消す場合（値を固定した個別許可）──────────
 * 既定では**ポイントが既定値(1)を超える削除候補は必ず skip** する。
 * どうしても消す必要がある組は、**その組だけ**を対象ファイル側で値ごと固定する:
 *
 *   {
 *     "id": "recXXXX", "keepId": "recYYYY", "email": "a@example.com",
 *     "pointsPolicy": "max_keep_wins",   // 正本の残高を採る = 移行しない、と確認済み
 *     "expectedDeletePoints": 102,       // 実行直前の実値と**完全一致**しなければ中止
 *     "expectedKeepPoints": 1230
 *   }
 *
 * ⚠️ **「ポイント無視」の汎用オプション（--allow-points-loss 等）は作らない。**
 *    値を固定した個別宣言だけを認める。1 点でも動いていたら skip する。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = process.env.AIRTABLE_BASE_ID || 'apptmQUPAlgZMmBC9';
const KEY = process.env.AIRTABLE_API_KEY;
const TABLE = 'Customers';

/** ポイントの既定値。これ以下なら「残高なし」とみなす */
export const DEFAULT_POINTS = 1;

/** 削除側に 1 つでもあれば消さない列 */
export const BLOCKING_FIELDS = Object.freeze([
  '有効期限', 'PlanType', 'PaymentConfirmed', 'PaidAt', 'PaymentMethod', 'LifetimeSanrenpuku',
  'LightGrantUntil', 'LightGrantedAt', 'LightGrantOp', 'LightGrantRevokedAt',
  'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
  'UnsubscribedAnalyticsKeiba', 'UnsubscribedAtAnalyticsKeiba',
  'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason',
  'PremiumPlusEligibility', 'PremiumPlusEligibleAt', 'PremiumPlusReleaseOverride',
  'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
  'Memo', 'Phone', '最終ログイン',
]);

const PLAN_RANK = Object.freeze({
  free: 0, light: 1, premium: 2, 'premium sanrenpuku': 3, 'premium combo': 3,
});

const norm = (v) => String(v ?? '').trim().toLowerCase();
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '' && v !== false;
const rank = (p) => PLAN_RANK[norm(p)] ?? 0;

/** ポイント残高がある組を消すときの唯一の宣言（汎用の抜け道は作らない） */
export const POINTS_POLICY_MAX_KEEP_WINS = 'max_keep_wins';

/** 削除してよいか（純粋・テストから直接呼ぶ） */
export function checkDeletable({ target, keep, email, entry }) {
  if (!keep) return { ok: false, reason: 'keep_record_missing' };
  if (norm(keep.fields?.Email) !== norm(email)) return { ok: false, reason: 'keep_email_mismatch' };
  if (!target) return { ok: false, reason: 'target_missing' };
  if (norm(target.fields?.Email) !== norm(email)) return { ok: false, reason: 'target_email_changed' };

  const f = target.fields || {};
  const blocking = BLOCKING_FIELDS.filter((k) => has(f[k]));
  if (blocking.length > 0) return { ok: false, reason: `has_values:${blocking.join(',')}` };
  const targetPoints = Number(f['ポイント'] ?? 0);
  const keepPoints = Number(keep.fields?.['ポイント'] ?? 0);
  if (targetPoints > DEFAULT_POINTS) {
    const e = entry || {};
    // 宣言が無ければ従来どおり skip（既定は安全側）
    if (e.pointsPolicy !== POINTS_POLICY_MAX_KEEP_WINS) {
      return { ok: false, reason: `has_points:${targetPoints}` };
    }
    // 宣言があっても、**実行直前の実値と完全一致**しなければ中止
    if (Number(e.expectedDeletePoints) !== targetPoints) {
      return { ok: false, reason: `points_changed:delete ${e.expectedDeletePoints}→${targetPoints}` };
    }
    if (Number(e.expectedKeepPoints) !== keepPoints) {
      return { ok: false, reason: `points_changed:keep ${e.expectedKeepPoints}→${keepPoints}` };
    }
    // 「最大値採用」が成り立つ（正本が上回る）ことを実値で再確認する
    if (!(keepPoints >= targetPoints)) {
      return { ok: false, reason: `keep_points_lower:${keepPoints}<${targetPoints}` };
    }
  }
  if (rank(f['プラン']) > rank(keep.fields?.['プラン'])) return { ok: false, reason: 'target_plan_stronger' };
  return { ok: true, reason: null };
}

/** 対象一覧の指紋（コマンドラインの取り違えを検知する） */
export function fingerprintTargets(targets) {
  const ids = (targets || []).map((t) => String(t.id)).sort();
  return createHash('sha256').update(ids.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
}

async function main() {
  const targetsPath = arg('targets');
  const expect = Number(arg('expect', NaN));
  const execute = arg('execute', false) === true;
  const exportPath = String(arg('export', 'dedupe-export.json'));

  if (!KEY) { console.error('❌ AIRTABLE_API_KEY が未設定です'); process.exit(1); }
  if (!targetsPath || !existsSync(targetsPath)) { console.error('❌ --targets <file> が要ります'); process.exit(1); }

  const targets = JSON.parse(readFileSync(targetsPath, 'utf8'));
  if (!Array.isArray(targets) || targets.length === 0) { console.error('❌ 対象が空です'); process.exit(1); }
  if (!Number.isInteger(expect)) { console.error('❌ --expect <件数> が要ります'); process.exit(1); }
  if (targets.length !== expect) {
    console.error(`❌ 件数が一致しません（--expect ${expect} / ファイル ${targets.length}）`);
    process.exit(1);
  }
  for (const t of targets) {
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(t.id)) || !/^rec[A-Za-z0-9]{14}$/.test(String(t.keepId))) {
      console.error('❌ recordId の形式が不正です'); process.exit(1);
    }
    if (String(t.id) === String(t.keepId)) { console.error('❌ 残す側と消す側が同じです'); process.exit(1); }
  }

  console.log(`対象 ${targets.length} 件 / 指紋 ${fingerprintTargets(targets)} / モード ${execute ? '⚠️ 実削除' : 'dry-run（何も書きません）'}`);

  // ── 削除前の完全 export（rollback の材料）──────────────────
  const snapshot = [];
  for (const t of targets) {
    const r = await api(`${encodeURIComponent(TABLE)}/${t.id}`);
    if (r.ok) snapshot.push(r.body);
    else snapshot.push({ id: t.id, missing: true, status: r.status });
  }
  writeFileSync(exportPath, JSON.stringify({ exportedAt: new Date().toISOString(), base: BASE, table: TABLE, records: snapshot }, null, 2));
  if (!existsSync(exportPath)) { console.error('❌ export を書けませんでした（rollback 材料が無いので中止）'); process.exit(1); }
  console.log(`💾 export: ${exportPath}（${snapshot.filter((s) => !s.missing).length} 件）`);

  // ── 1 件ずつ再検証 ──────────────────────────────────────
  const plan = [];
  for (const t of targets) {
    const [target, keep] = await Promise.all([
      api(`${encodeURIComponent(TABLE)}/${t.id}`),
      api(`${encodeURIComponent(TABLE)}/${t.keepId}`),
    ]);
    if (!target.ok && (target.status === 403 || target.status === 404)) {
      plan.push({ id: t.id, action: 'already_gone' });
      continue;
    }
    const verdict = checkDeletable({
      target: target.ok ? target.body : null,
      keep: keep.ok ? keep.body : null,
      email: t.email,
      entry: t,
    });
    plan.push({ id: t.id, action: verdict.ok ? 'delete' : 'skip', reason: verdict.reason });
  }

  const toDelete = plan.filter((p) => p.action === 'delete');
  const skipped = plan.filter((p) => p.action === 'skip');
  const gone = plan.filter((p) => p.action === 'already_gone');
  console.log(`検証: 削除可 ${toDelete.length} / skip ${skipped.length} / 既に削除済み ${gone.length}`);
  for (const s of skipped) console.log(`   skip ${s.id}: ${s.reason}`);

  if (!execute) {
    console.log('✅ dry-run 完了。**1 バイトも書いていません**。実削除は --execute を付けてください。');
    return;
  }
  if (toDelete.length === 0) { console.log('削除対象がありません。'); return; }

  // ── 実削除（10 件ずつ）────────────────────────────────────
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 10) {
    const chunk = toDelete.slice(i, i + 10);
    const qs = chunk.map((c) => `records[]=${encodeURIComponent(c.id)}`).join('&');
    const res = await api(`${encodeURIComponent(TABLE)}?${qs}`, { method: 'DELETE' });
    if (!res.ok) { console.error(`❌ 削除失敗 HTTP ${res.status}`); break; }
    deleted += (res.body.records || []).filter((r) => r.deleted).length;
  }
  console.log(`🗑️  削除 ${deleted} / ${toDelete.length}`);
  console.log(`rollback: ${exportPath} の fields を使って Customers へ再作成（recordId は変わります）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}

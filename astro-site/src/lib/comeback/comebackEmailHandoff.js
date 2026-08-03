/**
 * comebackEmailHandoff.js — 無料付与の**成功者だけ**をメール工程へ引き継ぐ（純粋・I/O なし）
 *
 * ── 解決する問題 ────────────────────────────────────────────────
 * カムバック特典タブで無料付与を実行したあと、案内メールを送るには
 * マーケティングタブで**同じ人をもう一度探して選び直す**必要があった。
 * 数十名を目視で再選択するのは現実的でなく、
 *
 *   - 付与に失敗した人をうっかり混ぜる
 *   - 付与できた人を取りこぼす
 *   - Email 文字列で突き合わせて別レコードに当てる
 *
 * が起きる。かといって「付与したら自動でメールも送る」に変えると、
 * メール失敗を理由に付与を巻き戻す/付与成功なのにメールだけ飛ぶ、という
 * **2 つの副作用を 1 トランザクション扱いする事故**を生む。
 *
 * ── 採った方式: operationId を鍵に、対象は毎回サーバーが再導出する ──────
 * 付与が成功すると Customers の `LightGrantOp` / `PremiumGrantOp` に
 * その操作の `operationId` が書かれる（`promotionalGrants.js`）。
 * つまり **「付与成功」そのものが既に台帳**であり、成功者リストを別に保存する必要がない。
 *
 *   引き継ぐもの … operationId と件数だけ（PII なし・recordId なし）
 *   対象者の確定 … 毎回 Customers を読み直して operationId が一致する行から導出
 *
 * これにより:
 *   - **失敗者は構造的に混ざらない**（grant フィールドが書かれていないため）
 *   - クライアントが recordId を注入しても無視される（サーバー導出が唯一の正）
 *   - Airtable のスキーマ変更も新しい保管場所も要らない
 *   - 取り消し済み（revoke 後）は対象から外れる
 *
 * ── 期限 ────────────────────────────────────────────────────
 * 引き継ぎは「いま付与した人へいま案内する」ための短期の導線であって、
 * 過去の操作を掘り起こす機能ではない。別の管理者の操作や、数日前の操作と
 * 混線させないため `HANDOFF_TTL_MS` を超えたら失効させる（fail closed）。
 * 期限は**付与時刻（GrantedAt）を基準**にする。クライアントの時計や保存値は信用しない。
 *
 * ── このモジュールがしないこと ──────────────────────────────────
 * メールを送らない。キャンペーンを選ばない。suppression / 配信停止 / バウンスの
 * 判定を持たない（それらは既存の `campaignSend.js` / `marketingDispatchGate.js` が単一源）。
 * ここは「誰が付与成功者か」を決めるだけ。
 */

import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';

/**
 * 引き継ぎの有効期間。**2 時間**。
 * 付与してすぐ案内する運用に足り、翌日の別操作と混ざるには短い。
 */
export const HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;

/** ブラウザ側の一時保存キー（sessionStorage）。タブを閉じれば消える */
export const HANDOFF_STORAGE_KEY = 'ak-comeback-email-handoff';

/** 引き継げない理由（固定コード） */
export const HANDOFF_BLOCK = Object.freeze({
  NONE: 'none',
  MALFORMED: 'malformed',
  EXPIRED: 'expired',
  NO_RECIPIENTS: 'no_recipients',
  ALREADY_QUEUED: 'already_queued',
});

/** 画面にそのまま出す文言 */
export const HANDOFF_BLOCK_LABEL = Object.freeze({
  [HANDOFF_BLOCK.NONE]: '引き継げる付与結果がありません。カムバック特典タブで無料付与を実行してください。',
  [HANDOFF_BLOCK.MALFORMED]: '引き継ぎ情報が壊れています。もう一度カムバック特典タブから引き継いでください。',
  [HANDOFF_BLOCK.EXPIRED]: '引き継ぎの有効期限が切れました。もう一度カムバック特典タブから引き継いでください。',
  [HANDOFF_BLOCK.NO_RECIPIENTS]: 'この操作で無料付与が成功した顧客が見つかりません（取り消し済み・未適用の可能性があります）。',
  [HANDOFF_BLOCK.ALREADY_QUEUED]: 'この引き継ぎからは既にキュー登録済みです。同じ相手へもう一度送る場合は、あらためて引き継ぎ直してください。',
});

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * この tier の grant が「この操作で実際に書き込まれ、いまも取り消されていない」か。
 *
 * `active`（期間内）ではなく **usable（値があり revoke されていない）** で見る。
 * 30 日付与の期限は数時間後の案内送信には影響しないが、**取り消し済みは対象外**にしたいため。
 */
function isGrantedByOperation(tierGrant, operationId) {
  if (!tierGrant || str(tierGrant.operationId) !== operationId) return false;
  if (tierGrant.inconsistent === true) return false;       // 値は残るが revoke 済み＝壊れた行
  return tierGrant.lifetime === true || Number.isFinite(tierGrant.untilMs);
}

/**
 * **付与成功者をサーバー側で再導出する**（このモジュールの中核）。
 *
 * クライアントが送ってきた recordId は一切見ない。Customers の行に
 * この operationId が刻まれているかどうかだけで決める。
 *
 * @param {{ records: Array<{recordId?: string, id?: string, fields?: object}>,
 *           operationId: string, nowMs?: number }} input
 * @returns {{ recordIds: string[], latestGrantedAtMs: number|null,
 *             byTier: {light: number, premium: number} }}
 */
export function collectGrantedRecipients({ records, operationId, nowMs } = {}) {
  const op = str(operationId);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const recordIds = [];
  const byTier = { light: 0, premium: 0 };
  let latestGrantedAtMs = null;

  if (!op) return { recordIds, latestGrantedAtMs, byTier };

  for (const rec of records || []) {
    const fields = (rec && rec.fields) || null;
    if (!fields) continue;
    const g = resolvePromotionalGrants(fields, now);
    const light = isGrantedByOperation(g.light, op);
    const premium = isGrantedByOperation(g.premium, op);
    if (!light && !premium) continue;

    const id = str(rec.recordId) || str(rec.id);
    if (!id) continue;                                  // 識別子が無い行は引き継がない
    recordIds.push(id);
    if (light) byTier.light += 1;
    if (premium) byTier.premium += 1;

    for (const t of [light ? g.light : null, premium ? g.premium : null]) {
      if (!t || !Number.isFinite(t.grantedAtMs)) continue;
      if (latestGrantedAtMs === null || t.grantedAtMs > latestGrantedAtMs) latestGrantedAtMs = t.grantedAtMs;
    }
  }
  return { recordIds, latestGrantedAtMs, byTier };
}

/**
 * 付与実行の応答へ載せる引き継ぎ票。**PII も recordId も含めない**。
 *
 * @param {{ operationId: string, grantedCount: number, selectedCount?: number,
 *           skippedCount?: number, skippedDetail?: Array<{reason:string,label:string,count:number}>,
 *           nowMs?: number }} input
 */
export function buildHandoffTicket({
  operationId, grantedCount, selectedCount, skippedCount, skippedDetail, nowMs,
} = {}) {
  const op = str(operationId);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const granted = num(grantedCount);
  return {
    operationId: op,
    grantedCount: granted,
    selectedCount: num(selectedCount),
    // 「引き継がれない人数」＝ 選択したのに付与できなかった人。理由は PII なしの集計だけ
    notGrantedCount: num(skippedCount),
    notGrantedReasons: (skippedDetail || [])
      .map((d) => ({ reason: str(d && d.reason), label: str(d && d.label), count: num(d && d.count) }))
      .filter((d) => d.reason && d.count > 0),
    issuedAtMs: now,
    expiresAtMs: now + HANDOFF_TTL_MS,
    // 1 件も付与できていないならメール工程へ進ませない
    canHandoff: granted > 0,
    blockReason: granted > 0 ? null : HANDOFF_BLOCK.NO_RECIPIENTS,
  };
}

/**
 * サーバー側の受け入れ判定。**付与時刻を基準に期限を測る**（保存値の issuedAt は信用しない）。
 *
 * @param {{ operationId: string, recordIds: string[], latestGrantedAtMs: number|null,
 *           nowMs?: number, ttlMs?: number }} input
 * @returns {{ ok: boolean, reason: string|null, recipientCount: number, expiresAtMs: number|null }}
 */
export function validateHandoffResolution({
  operationId, recordIds, latestGrantedAtMs, nowMs, ttlMs,
} = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : HANDOFF_TTL_MS;
  const ids = Array.isArray(recordIds) ? recordIds.filter((v) => str(v)) : [];
  const out = (ok, reason, expiresAtMs = null) => ({
    ok, reason: reason || null, recipientCount: ids.length, expiresAtMs,
  });

  if (!str(operationId)) return out(false, HANDOFF_BLOCK.MALFORMED);
  if (ids.length === 0) return out(false, HANDOFF_BLOCK.NO_RECIPIENTS);
  // 付与時刻が読めない＝いつの操作か確認できない。古い操作を掘り起こさないため拒否する
  if (!Number.isFinite(latestGrantedAtMs)) return out(false, HANDOFF_BLOCK.EXPIRED);

  const expiresAtMs = latestGrantedAtMs + ttl;
  if (now >= expiresAtMs) return out(false, HANDOFF_BLOCK.EXPIRED, expiresAtMs);
  return out(true, null, expiresAtMs);
}

// ── ブラウザ側の一時保存 ────────────────────────────────────────
// storage は sessionStorage 互換（getItem / setItem / removeItem）なら何でもよい。
// 直接 sessionStorage を参照しないのは、この判定を Node のテストで動かすため。

/** 保存する（recordId も氏名もメールアドレスも入れない） */
export function saveHandoff(storage, ticket) {
  if (!storage || !ticket || !str(ticket.operationId)) return false;
  try {
    storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify({
      operationId: str(ticket.operationId),
      grantedCount: num(ticket.grantedCount),
      notGrantedCount: num(ticket.notGrantedCount),
      notGrantedReasons: Array.isArray(ticket.notGrantedReasons) ? ticket.notGrantedReasons : [],
      issuedAtMs: num(ticket.issuedAtMs),
      expiresAtMs: num(ticket.expiresAtMs),
      queuedJobIds: [],
    }));
    return true;
  } catch { return false; }
}

/**
 * 読み出す。壊れていれば `malformed`、期限切れなら `expired`。
 * **再読み込み・別タブでの挙動はここで決まる**:
 *   - 同じタブの再読み込み … sessionStorage が残るので引き継ぎは維持される
 *   - 別タブ / 別ウィンドウ … sessionStorage は共有されないので `none`（＝引き継ぎ無し）
 *   - 期限切れ … `expired`。サーバー側でも同じ判定をするため、通っても最終的に弾かれる
 */
export function loadHandoff(storage, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!storage) return { ok: false, reason: HANDOFF_BLOCK.NONE, handoff: null };
  let raw = null;
  try { raw = storage.getItem(HANDOFF_STORAGE_KEY); } catch { return { ok: false, reason: HANDOFF_BLOCK.NONE, handoff: null }; }
  if (!raw) return { ok: false, reason: HANDOFF_BLOCK.NONE, handoff: null };

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: HANDOFF_BLOCK.MALFORMED, handoff: null }; }
  if (!parsed || typeof parsed !== 'object' || !str(parsed.operationId)) {
    return { ok: false, reason: HANDOFF_BLOCK.MALFORMED, handoff: null };
  }
  if (num(parsed.grantedCount) <= 0) {
    return { ok: false, reason: HANDOFF_BLOCK.NO_RECIPIENTS, handoff: parsed };
  }
  if (num(parsed.expiresAtMs) > 0 && now >= num(parsed.expiresAtMs)) {
    return { ok: false, reason: HANDOFF_BLOCK.EXPIRED, handoff: parsed };
  }
  // 一度キュー登録した引き継ぎは使い切り。同じ相手へ再送するには引き継ぎ直させる
  if (Array.isArray(parsed.queuedJobIds) && parsed.queuedJobIds.length > 0) {
    return { ok: false, reason: HANDOFF_BLOCK.ALREADY_QUEUED, handoff: parsed };
  }
  return { ok: true, reason: null, handoff: parsed };
}

/** キュー登録済みとして印を付ける（同じ引き継ぎからの二重登録を止める） */
export function markHandoffQueued(storage, jobIds) {
  if (!storage) return false;
  let raw = null;
  try { raw = storage.getItem(HANDOFF_STORAGE_KEY); } catch { return false; }
  if (!raw) return false;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const ids = (Array.isArray(jobIds) ? jobIds : []).map((v) => str(v)).filter(Boolean);
  parsed.queuedJobIds = [...new Set([...(parsed.queuedJobIds || []), ...ids])];
  try { storage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(parsed)); return true; } catch { return false; }
}

/** 捨てる（引き継ぎをやめる / 期限切れの掃除） */
export function clearHandoff(storage) {
  if (!storage) return false;
  try { storage.removeItem(HANDOFF_STORAGE_KEY); return true; } catch { return false; }
}

/**
 * 画面の見出し用の要約（人数と期限だけ。アドレスも recordId も出さない）。
 */
export function describeHandoff(handoff, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!handoff || !str(handoff.operationId)) return '引き継ぎなし';
  const left = num(handoff.expiresAtMs) - now;
  const mins = left > 0 ? Math.ceil(left / 60000) : 0;
  return `付与成功 ${num(handoff.grantedCount)} 名（操作 ${str(handoff.operationId)} / 残り約 ${mins} 分）`;
}

/**
 * ScheduledEmails の Notes へ残す監査用の印。
 * どのキュー登録がどの付与操作から来たのかを後から辿れるようにする。
 * **アドレスも氏名も入れない**（Notes は運用者が読む欄）。
 */
export function handoffNote(operationId) {
  const op = str(operationId);
  return op ? `handoff:${op}` : '';
}

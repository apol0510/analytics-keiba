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
 * 引き継ぎの有効期間。**24 時間**。
 *
 * 当初は 2 時間だったが、2026-08-03 の本番運用で足りないことが分かった。
 * 28 名へ付与したあと、案内文面を用意して確認する間に失効し、
 * **既存 operationId から引き継ぎ直す経路も無かった**ため作業が止まった。
 *
 * 24 時間なら「今日配って今日中に案内を出す」という実際の運用に収まり、
 * 翌日以降の別操作と混ざるほど長くもない。期限を延ばしても安全性は
 * 以下で担保しているので、混線・二重送信は増えない:
 *
 *   - 対象は毎回サーバーが Customers から再導出する（画面の申告を信用しない）
 *   - キュー登録した引き継ぎは**使い切り**（同じ相手へ再送するには取り直す）
 *   - 二重送信は `campaignId × version × 受信者`（DeliveryKey）で従来どおり防ぐ
 *   - `sessionStorage` はタブを閉じれば消え、別タブとは共有されない
 *
 * それでも期限切れになった場合は、管理画面から operationId を指定して
 * **read-only で引き継ぎ直せる**（`handoffLookup`）。再付与はしない。
 */
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

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
const DAY_MS = 86400000;

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
 *             byTier: {light: number, premium: number},
 *             kinds: {light: object|null, premium: object|null} }}
 */
export function collectGrantedRecipients({ records, operationId, nowMs } = {}) {
  const op = str(operationId);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const recordIds = [];
  const byTier = { light: 0, premium: 0 };
  // 「何を配ったか」を実データから読む。行ごとに違えば mixed（＝自動判定しない）
  const seen = { light: [], premium: [] };
  let latestGrantedAtMs = null;

  if (!op) return { recordIds, latestGrantedAtMs, byTier, kinds: { light: null, premium: null } };

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
    if (light) { byTier.light += 1; seen.light.push(g.light); }
    if (premium) { byTier.premium += 1; seen.premium.push(g.premium); }

    for (const t of [light ? g.light : null, premium ? g.premium : null]) {
      if (!t || !Number.isFinite(t.grantedAtMs)) continue;
      if (latestGrantedAtMs === null || t.grantedAtMs > latestGrantedAtMs) latestGrantedAtMs = t.grantedAtMs;
    }
  }
  return {
    recordIds, latestGrantedAtMs, byTier,
    kinds: { light: summarizeGrantKind(seen.light), premium: summarizeGrantKind(seen.premium) },
  };
}

/**
 * 同じ操作で配った grant の「種類」を 1 つにまとめる。
 *
 * **行ごとに食い違っていたら `mixed: true` を返して自動判定させない**。
 * 「だいたい 30 日」で案内文面を決めると、違う条件の人へ違う内容が届く。
 *
 * @param {Array<object>} grants 同一 tier・同一操作の grant 群
 * @returns {{ count: number, lifetime: boolean|null, durationDays: number|null,
 *             grantedAtMs: number|null, untilMs: number|null, mixed: boolean }|null}
 */
export function summarizeGrantKind(grants) {
  const list = Array.isArray(grants) ? grants.filter(Boolean) : [];
  if (list.length === 0) return null;

  const lifetimes = new Set(list.map((g) => g.lifetime === true));
  const grantedAt = list.map((g) => g.grantedAtMs).filter(Number.isFinite);
  const until = list.map((g) => g.untilMs).filter(Number.isFinite);

  // 付与日と終了日から日数を出す（同じ操作なら全員同じになるはず）
  const days = new Set(list.map((g) => {
    if (g.lifetime === true) return 'lifetime';
    if (!Number.isFinite(g.untilMs) || !Number.isFinite(g.grantedAtMs)) return 'unknown';
    return Math.round((g.untilMs - g.grantedAtMs) / DAY_MS);
  }));

  const mixed = lifetimes.size > 1 || days.size > 1 || days.has('unknown');
  const only = [...days][0];
  return {
    count: list.length,
    lifetime: mixed ? null : lifetimes.has(true),
    durationDays: mixed || only === 'lifetime' || only === 'unknown' ? null : Number(only),
    grantedAtMs: grantedAt.length ? Math.max(...grantedAt) : null,
    untilMs: until.length ? Math.max(...until) : null,
    mixed,
  };
}

/**
 * 付与実行の応答へ載せる引き継ぎ票。**PII も recordId も含めない**。
 *
 * @param {{ operationId: string, grantedCount: number, selectedCount?: number,
 *           skippedCount?: number, skippedDetail?: Array<{reason:string,label:string,count:number}>,
 *           nowMs?: number }} input
 */
export function buildHandoffTicket({
  operationId, grantedCount, selectedCount, skippedCount, skippedDetail, grantOffers, nowMs,
} = {}) {
  const op = str(operationId);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const granted = num(grantedCount);
  return {
    operationId: op,
    grantedCount: granted,
    // 何を配ったか（offerId だけ。案内文面の自動選択に使う）。PII は含まない
    grantOffers: {
      light: str(grantOffers && grantOffers.light) || null,
      premium: str(grantOffers && grantOffers.premium) || null,
    },
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
      grantOffers: {
        light: str(ticket.grantOffers && ticket.grantOffers.light) || null,
        premium: str(ticket.grantOffers && ticket.grantOffers.premium) || null,
      },
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
 * 引き継ぎの残り時間を**運用者が判断できる形**にする。
 *
 * ## なぜ分だけでは駄目か
 *
 * 旧実装は残りを常に「約 N 分」で出していた。付与直後は「約 1440 分」で
 * **緊急かどうか読み取れず**、失効後は「約 0 分」で**まだ使えるように見えた**。
 *
 * 期限を過ぎると引き継ぎは 410 になり、`handoffLatest`（復旧口）も**同じ TTL** で弾く。
 * つまり **24 時間を過ぎると、その付与操作は引き継ぎ経路から永久に届かなくなる**。
 * その一方で Light 無料体験の barrier は「Step1 が queue されるまで次の 100 名を止める」ので、
 * 失効すると **付与も案内も進まない**状態になる。だから残り時間は目立たせる必要がある。
 *
 * @returns {{level:'none'|'ok'|'soon'|'critical'|'expired',
 *            remainingMs:number|null, remainingText:string, note:string|null}}
 */
export function resolveHandoffUrgency(handoff, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!handoff || !str(handoff.operationId)) {
    return { level: 'none', remainingMs: null, remainingText: '引き継ぎなし', note: null };
  }
  const expiresAt = num(handoff.expiresAtMs);
  if (!(expiresAt > 0)) {
    // 期限が読めないものを「まだ使える」と見せない
    return {
      level: 'expired', remainingMs: null, remainingText: '期限不明',
      note: '引き継ぎの期限を確認できません。「操作 ID を指定して引き継ぎ直す」で取り直してください。',
    };
  }
  const left = expiresAt - now;
  if (left <= 0) {
    return {
      level: 'expired', remainingMs: 0, remainingText: '失効',
      note: '引き継ぎの期限が切れました。この経路では案内を作れません。'
        + 'カムバック特典タブから引き継ぎ直すか、対象を選び直してください。',
    };
  }
  const mins = Math.ceil(left / 60000);
  const remainingText = mins >= 60
    ? `残り 約${Math.floor(mins / 60)} 時間${mins % 60 ? ` ${mins % 60} 分` : ''}`
    : `残り 約${mins} 分`;
  if (left <= 30 * 60 * 1000) {
    return {
      level: 'critical', remainingMs: left, remainingText,
      note: 'まもなく失効します。先に Step1 のキュー登録を済ませてください。',
    };
  }
  if (left <= 3 * 60 * 60 * 1000) {
    return {
      level: 'soon', remainingMs: left, remainingText,
      note: '本日中に Step1 のキュー登録を済ませてください（失効すると引き継げません）。',
    };
  }
  return { level: 'ok', remainingMs: left, remainingText, note: null };
}

/**
 * 画面の見出し用の要約（人数と期限だけ）。
 *
 * ⚠️ **operationId は出さない。** 運用者が読む必要はなく、画面に出すと
 *    スクリーンショットやログへ内部 ID が残る。アドレス・recordId も当然出さない。
 */
export function describeHandoff(handoff, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!handoff || !str(handoff.operationId)) return '引き継ぎなし';
  const u = resolveHandoffUrgency(handoff, now);
  const head = `付与成功 ${num(handoff.grantedCount)} 名`;
  // 失効を「約 0 分」と書かない（まだ使えるように読める）
  if (u.level === 'expired') return `${head}（引き継ぎ ${u.remainingText}）`;
  return `${head}（引き継ぎ期限まで ${u.remainingText}）`;
}

/**
 * **直近の付与操作**を実データから 1 つ選ぶ（純粋・read-only）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 付与直後の自動引き継ぎは sessionStorage に載る。しかし
 *   ・別タブ / 別ウィンドウで開き直した
 *   ・ブラウザを閉じた
 *   ・付与だけ先に済ませてあとで案内を作る
 * といった場合、引き継ぎ票が手元に無い。そのとき運用者へ
 * **operationId を探して手入力させるのは現実的でない**（内部 ID を人が扱う理由がない）。
 *
 * そこで「直近の付与操作」をサーバーが実データから特定する。人が入力するものは何も無い。
 *
 * ── 安全側の決まり ────────────────────────────────────────────
 * - 選ぶのは **`*GrantedAt` が最も新しい 1 操作だけ**。過去の操作は掘り起こさない
 * - TTL（既定 24 時間）を過ぎた操作は候補にしない
 * - 取消済み・不整合の行はその操作の人数に数えない（`collectGrantedRecipients` と同じ基準）
 * - 戻り値に **アドレス・氏名・recordId を含めない**
 *
 * @param {{ records: Array<{recordId?: string, id?: string, fields?: object}>,
 *           nowMs?: number, ttlMs?: number }} input
 * @returns {{ ok: boolean, reason: string|null, operationId: string|null,
 *             grantedCount: number, latestGrantedAtMs: number|null, expiresAtMs: number|null }}
 */
export function pickLatestGrantOperation({ records, nowMs, ttlMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : HANDOFF_TTL_MS;
  const rows = Array.isArray(records) ? records : [];
  const no = (reason) => ({
    ok: false, reason, operationId: null, grantedCount: 0,
    latestGrantedAtMs: null, expiresAtMs: null,
  });

  // 操作 ID ごとに「最も新しい付与時刻」を集める（tier をまたいで 1 操作として見る）
  const latestByOp = new Map();
  for (const rec of rows) {
    const f = (rec && rec.fields) || {};
    const grants = resolvePromotionalGrants(f, now);
    for (const tier of ['light', 'premium']) {
      const g = grants[tier];
      if (!isGrantedByOperation(g, str(g && g.operationId))) continue;
      const op = str(g.operationId);
      if (!op) continue;
      const at = Number.isFinite(g.grantedAtMs) ? g.grantedAtMs : null;
      if (at === null) continue;                       // いつの操作か分からないものは選ばない
      const cur = latestByOp.get(op);
      if (cur === undefined || at > cur) latestByOp.set(op, at);
    }
  }
  if (latestByOp.size === 0) return no(HANDOFF_BLOCK.NONE);

  let bestOp = null;
  let bestAt = -Infinity;
  for (const [op, at] of latestByOp) {
    if (at > bestAt) { bestAt = at; bestOp = op; }
  }
  if (!bestOp) return no(HANDOFF_BLOCK.NONE);

  const expiresAtMs = bestAt + ttl;
  if (now >= expiresAtMs) return no(HANDOFF_BLOCK.EXPIRED);

  // 人数は既存の単一源で数え直す（ここで独自に数えない）
  const resolved = collectGrantedRecipients({ records: rows, operationId: bestOp, nowMs: now });
  if (resolved.recordIds.length === 0) return no(HANDOFF_BLOCK.NO_RECIPIENTS);

  return {
    ok: true,
    reason: null,
    operationId: bestOp,
    grantedCount: resolved.recordIds.length,
    latestGrantedAtMs: resolved.latestGrantedAtMs ?? bestAt,
    expiresAtMs,
  };
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

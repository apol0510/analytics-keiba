/**
 * prospectEventBatch.js — webhook のイベントを prospect へ**まとめて・原子的に・冪等に**反映する
 *
 * ## なぜ要るか（2026-09-26〜27 の本番事故）
 *
 * 09-26 19:00 の配信で約 5,900 名が一度に打ち切り（EXHAUSTED）になった。
 * webhook は 1 イベントずつ「重複防止の印（SET NX）→ GET → SET → SREM/SADD → 抑止台帳」を
 * **別々の往復**で書いていたので、1 バッチの往復数が膨らみ Function が途中で止まった。結果:
 *
 * - 「レコードは EXHAUSTED なのに送信候補索引に残る」5 名
 * - 「レコードは EXHAUSTED なのにどの索引にも居ない」18 名
 * - さらに、重複防止の印を**反映より先に**全イベントへ付けていたので、止まった後ろのイベントは
 *   SendGrid が再送しても「処理済み」として捨てられる（反映漏れが回復しない）
 *
 * Netlify の同期 Function の上限は **60 秒で変えられない**（公式 docs: configuration の既定値表）。
 * `maxDuration` を伸ばして逃げる道は無いので、**処理量を時間内に収める**。
 *
 * ## ここで守ること（テストで固定）
 *
 * 1. **原子性**: 相手ごとの「レコード・送信候補索引・反応済み索引・抑止台帳」を
 *    **1 回の transaction** で書く（`/multi-exec`）。途中で止まっても片方だけ残らない。
 *    transaction が使えなければ**書かない**（ばらばらに書いて不整合を作らない）。
 * 2. **処理済みの印だけが先に付かない**: 反映済みの印（`appliedEventIds`）は
 *    **レコードと同じ書き込み**の中に入れる。書けなければ印も付かない。
 * 3. **冪等**: 同じイベントが再送されても `appliedEventIds` にあれば数え直さない。
 *    そのときも**索引と抑止台帳だけは state に合わせて張り直す**（過去の部分書き込みを直す）。
 * 4. **時間内に収める**: 読みは `MGET`、書きは相手をまとめた transaction（既定 50 名）。
 *    1 塊 = 2 往復。締め切りを越えそうなら**新しい塊を始めず**、残りを `remaining` で返す。
 *    呼び出し側は `incomplete` なら 5xx を返して SendGrid に再送させる（反映済みは 3. で飛ばす）。
 *
 * ⚠️ アドレスは戻り値の `changes` にだけ入る（選別 list から外すため）。ログへ出さないこと。
 * ⚠️ 同じ相手を**別々の呼び出しが同時に**書き換えると後勝ちになる（WATCH が使えないため）。
 *    同じイベントの二重反映は 3. で防げるが、別イベントの同時反映は防げない（既知の限界）。
 */

import {
  PROSPECT_STATE, applyDelivered, applyEngagement, applySuppression,
} from './prospectPolicy.js';
import {
  emailHash, buildProspectWriteCommands, blockEntryFor, APPLIED_EVENT_IDS_CAP,
} from './prospectStore.js';

/** 1 回の transaction にまとめる相手の数（1 塊 = MGET 1 回 + transaction 1 回） */
export const PROSPECT_BATCH_CHUNK = 50;
/** 1 塊の所要見積り（Upstash 1 往復 ~45ms の実測に大きく余裕を取る） */
export const PROSPECT_CHUNK_ESTIMATE_MS = 1500;
/** 締め切りが渡されないときの既定（受信から数える前提の値ではない。呼び出し時点から） */
export const DEFAULT_PROSPECT_BUDGET_MS = 30_000;

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 1 人ぶんの更新を適用する（純粋）。
 *
 * @param {{prospect: object, update: object, nowMs: number, env?: object}} input
 * @returns {{next: object, changed: boolean, duplicate: boolean,
 *            deliveredCounted: boolean, newlyExhausted: boolean, engagedNow: boolean,
 *            suppressedNow: boolean}}
 */
export function applyProspectUpdate({ prospect, update, nowMs, env = process.env } = {}) {
  const cur = { ...(prospect || {}) };
  const ids = Array.isArray(update && update.eventIds) ? update.eventIds : [];
  const applied = Array.isArray(cur.appliedEventIds) ? cur.appliedEventIds : [];

  /** **全部**反映済みなら何も数えない（一部だけ新しいなら反映する＝同じバッチの再構成に備える） */
  if (ids.length > 0 && ids.every((id) => applied.includes(id))) {
    return {
      next: cur, changed: false, duplicate: true,
      deliveredCounted: false, newlyExhausted: false, engagedNow: false, suppressedNow: false,
    };
  }

  let next = cur;
  let deliveredCounted = false;
  let newlyExhausted = false;
  if (update.action === 'delivered' || update.alsoDelivered === true) {
    const r = applyDelivered({ prospect: next, nowMs, env });
    if (r.changed) {
      deliveredCounted = true;
      newlyExhausted = next.state !== PROSPECT_STATE.EXHAUSTED && r.prospect.state === PROSPECT_STATE.EXHAUSTED;
      next = r.prospect;
    }
  }
  let engagedNow = false;
  let suppressedNow = false;
  if (update.action === 'suppress') {
    const r = applySuppression({ prospect: next, nowMs, reason: update.reason });
    if (r.changed) { suppressedNow = true; next = r.prospect; }
  } else if (update.action === 'engage') {
    const r = applyEngagement({ prospect: next, nowMs, kind: update.kind });
    if (r.changed) { engagedNow = true; next = r.prospect; }
  }

  if (ids.length > 0) {
    const merged = [...applied];
    for (const id of ids) if (!merged.includes(id)) merged.push(id);
    next = { ...next, appliedEventIds: merged.slice(-APPLIED_EVENT_IDS_CAP) };
  }
  return {
    next, changed: !sameJson(next, cur), duplicate: false,
    deliveredCounted, newlyExhausted, engagedNow, suppressedNow,
  };
}

/**
 * 選別 list から外す相手として積むか（**従来の webhook と同じ条件**）。
 * - 反応・抑止の更新は、いまの state をそのまま積む（外す対象かは `planSelectionExit` が決める）
 * - delivered だけの更新は、打ち切り（EXHAUSTED）になっているときだけ積む
 * - 反映済み（再送）でも積む（前回 list から外し損ねていても、再送で外せるように）
 */
function exitChange(update, next) {
  if (update.action === 'delivered') {
    return next.state === PROSPECT_STATE.EXHAUSTED ? { email: update.email, state: next.state } : null;
  }
  return next.state ? { email: update.email, state: next.state } : null;
}

/**
 * まとめて反映する。
 *
 * @param {{updates: object[], store: object, nowMs: number, env?: object,
 *          deadlineAtMs?: number, nowFn?: () => number, chunkSize?: number}} input
 * @returns {Promise<object>} 件数・`changes`（アドレスを含む）・`remaining`・`incomplete`
 */
export async function applyProspectEventBatch({
  updates, store, nowMs, env = process.env, deadlineAtMs, nowFn = Date.now, chunkSize,
} = {}) {
  const list = (Array.isArray(updates) ? updates : []).filter((u) => u && u.email);
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : PROSPECT_BATCH_CHUNK;
  const out = {
    enabled: true, engaged: 0, suppressed: 0, delivered: 0, exhausted: 0,
    notFound: 0, duplicate: 0, healed: 0, errors: 0,
    chunks: 0, failedChunks: 0, remaining: 0, incomplete: false, reason: null,
    changes: [],
  };
  if (list.length === 0) return out;
  if (!store || store.hasTransaction !== true) {
    // ⚠️ ばらばらに書くと部分書き込みを作る。**1 件も書かず**に未完了として返す
    out.incomplete = true; out.remaining = list.length; out.reason = 'transaction_unavailable';
    return out;
  }
  const deadline = Number.isFinite(deadlineAtMs) ? deadlineAtMs : nowFn() + DEFAULT_PROSPECT_BUDGET_MS;

  for (let i = 0; i < list.length; i += size) {
    /** 最初の塊は必ず処理する。2 つ目以降は締め切りを越えそうなら始めない */
    if (i > 0 && nowFn() + PROSPECT_CHUNK_ESTIMATE_MS > deadline) {
      out.remaining = list.length - i;
      out.incomplete = true;
      out.reason = out.reason || 'time_budget_exhausted';
      break;
    }
    const chunk = list.slice(i, i + size);
    out.chunks += 1;
    const hashes = chunk.map((u) => emailHash(u.email));

    let byHash;
    try {
      // eslint-disable-next-line no-await-in-loop -- 塊を順に処理する
      const recs = await store.loadMany(hashes);
      byHash = new Map((recs || []).map((r) => [r.hash, r]));
    } catch {
      out.failedChunks += 1; out.errors += chunk.length;
      out.remaining = list.length - i; out.incomplete = true; out.reason = 'read_failed';
      break;
    }

    const cmds = [];
    const pending = { engaged: 0, suppressed: 0, delivered: 0, exhausted: 0, notFound: 0, duplicate: 0, healed: 0 };
    const pendingChanges = [];
    for (let k = 0; k < chunk.length; k += 1) {
      const u = chunk[k];
      const hash = hashes[k];
      const cur = byHash.get(hash);
      if (!cur) { pending.notFound += 1; continue; }
      const { hash: _h, ...record } = cur;
      const r = applyProspectUpdate({ prospect: record, update: u, nowMs, env });
      if (r.duplicate) {
        pending.duplicate += 1;
        // 再送: 数え直さない。**索引と抑止台帳だけ** state に合わせて張り直す（過去の部分書き込みを直す）
        cmds.push(...buildProspectWriteCommands(hash, null, record.state, {
          blockEntry: blockEntryFor(hash, record, nowMs),
        }));
        pending.healed += 1;
      } else {
        cmds.push(...buildProspectWriteCommands(hash, r.next, r.next.state, {
          blockEntry: blockEntryFor(hash, r.next, nowMs),
        }));
        if (r.deliveredCounted) pending.delivered += 1;
        if (r.newlyExhausted) pending.exhausted += 1;
        if (r.engagedNow) pending.engaged += 1;
        if (r.suppressedNow) pending.suppressed += 1;
      }
      const c = exitChange(u, r.next);
      if (c) pendingChanges.push(c);
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- 塊を順に処理する
      if (cmds.length > 0) await store.commitAtomic(cmds);
    } catch {
      // ⚠️ 何も書かれていない（transaction）。**数えず・外さず**、残りごと未完了にして再送で回復させる
      out.failedChunks += 1; out.errors += chunk.length;
      out.remaining = list.length - i; out.incomplete = true; out.reason = 'write_failed';
      break;
    }
    // 書けた塊だけを数える（書けていないものを反映済みとして扱わない）
    for (const [k, v] of Object.entries(pending)) out[k] += v;
    out.changes.push(...pendingChanges);
  }
  return out;
}

export default applyProspectEventBatch;

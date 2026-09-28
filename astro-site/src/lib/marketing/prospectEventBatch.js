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
 *    **1 回の Lua 実行**（`PROSPECT_CAS_LUA`）で書く。途中で止まっても片方だけ残らない。
 * 2. **後勝ちで消さない（lost update を起こさない）**: 読んだ値の SHA1 が今も同じときだけ書く。
 *    違えば（同じ相手へ別の webhook が先に書いた）その相手だけ**読み直して計算し直す**。
 *    同じ相手へ delivered と open が別々の呼び出しで同時に来ても、両方が残る。
 * 3. **処理済みの印だけが先に付かない**: 反映済みの印（`appliedEventIds`）は
 *    **レコードと同じ書き込み**の中に入れる。書けなければ印も付かない。
 * 4. **冪等**: 同じイベントが再送されても `appliedEventIds` にあれば数え直さない。
 *    そのときも**索引と抑止台帳だけは state に合わせて張り直す**（過去の部分書き込みを直す）。
 * 5. **時間内に収める**: 読みは `MGET`、書きは相手をまとめた 1 回の EVAL（既定 50 名）。
 *    衝突が無ければ 1 塊 = 2 往復。締め切りを越えそうなら**新しい塊を始めず**、残りを `remaining` で返す。
 *    呼び出し側は `incomplete` なら 5xx を返して SendGrid に再送させる（反映済みは 4. で飛ばす）。
 *
 * ⚠️ アドレスは戻り値の `changes` にだけ入る（選別 list から外すため）。ログへ出さないこと。
 */

import {
  PROSPECT_STATE, applyDelivered, applyEngagement, applySuppression,
} from './prospectPolicy.js';
import { emailHash, APPLIED_EVENT_IDS_CAP, CAS_ATTEMPTS } from './prospectStore.js';

/** 1 回の EVAL にまとめる相手の数（衝突が無ければ 1 塊 = MGET 1 回 + EVAL 1 回） */
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
    notFound: 0, duplicate: 0, healed: 0, errors: 0, conflictsRetried: 0,
    chunks: 0, failedChunks: 0, remaining: 0, incomplete: false, reason: null,
    changes: [],
  };
  if (list.length === 0) return out;
  if (!store || typeof store.casMany !== 'function' || typeof store.loadManyRaw !== 'function') {
    // ⚠️ 比較して書く手段が無ければ**1 件も書かない**（後勝ち・部分書き込みを作らない）
    out.incomplete = true; out.remaining = list.length; out.reason = 'cas_unavailable';
    return out;
  }
  const deadline = Number.isFinite(deadlineAtMs) ? deadlineAtMs : nowFn() + DEFAULT_PROSPECT_BUDGET_MS;
  const overBudget = () => nowFn() + PROSPECT_CHUNK_ESTIMATE_MS > deadline;

  for (let i = 0; i < list.length; i += size) {
    /** 最初の塊は必ず処理する。2 つ目以降は締め切りを越えそうなら始めない */
    if (i > 0 && overBudget()) {
      out.remaining = list.length - i;
      out.incomplete = true;
      out.reason = out.reason || 'time_budget_exhausted';
      break;
    }
    out.chunks += 1;
    /** この塊でまだ書けていない相手（衝突したら読み直して回す） */
    let pendingIdx = list.slice(i, i + size).map((u) => ({ u, hash: emailHash(u.email) }));
    let stop = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS && pendingIdx.length > 0; attempt += 1) {
      if (attempt > 0) {
        if (overBudget()) { stop = 'time_budget_exhausted'; break; }
        out.conflictsRetried += pendingIdx.length;
      }
      let rows;
      try {
        // eslint-disable-next-line no-await-in-loop -- 塊を順に処理する
        rows = await store.loadManyRaw(pendingIdx.map((p) => p.hash));
      } catch { stop = 'read_failed'; break; }

      const items = [];
      const plans = [];
      for (let k = 0; k < pendingIdx.length; k += 1) {
        const { u, hash } = pendingIdx[k];
        const row = rows[k];
        if (!row || !row.record) { out.notFound += 1; continue; }
        const r = applyProspectUpdate({ prospect: row.record, update: u, nowMs, env });
        // 反映済み（再送）: 数え直さず、索引と台帳だけ今の state に合わせる
        items.push(store.casItem({ hash, expectRaw: row.raw, next: r.duplicate ? null : r.next, nowMs }));
        plans.push({ u, hash, r });
      }
      if (items.length === 0) { pendingIdx = []; break; }

      let ok;
      try {
        // eslint-disable-next-line no-await-in-loop -- 同上
        ok = await store.casMany(items);
      } catch { stop = 'write_failed'; break; }

      const conflicted = [];
      ok.forEach((w, k) => {
        const { u, hash, r } = plans[k];
        if (!w.ok) { conflicted.push({ u, hash }); return; }   // 誰かが先に書いた → 読み直す
        // 書けた相手だけを数える（書けていないものを反映済みとして扱わない）
        if (r.duplicate) { out.duplicate += 1; out.healed += 1; } else {
          if (r.deliveredCounted) out.delivered += 1;
          if (r.newlyExhausted) out.exhausted += 1;
          if (r.engagedNow) out.engaged += 1;
          if (r.suppressedNow) out.suppressed += 1;
        }
        const c = exitChange(u, r.next);
        if (c) out.changes.push(c);
      });
      pendingIdx = conflicted;
    }
    if (!stop && pendingIdx.length > 0) stop = 'cas_conflict';
    if (stop) {
      // ⚠️ 書けていない相手と、まだ手を付けていない後ろの塊を**未完了**として返す（再送で回復させる）
      const untouched = list.length - Math.min(list.length, i + size);
      out.remaining = pendingIdx.length + untouched;
      out.incomplete = true;
      out.reason = stop;
      if (stop === 'read_failed' || stop === 'write_failed') { out.failedChunks += 1; out.errors += pendingIdx.length; }
      break;
    }
  }
  return out;
}

export default applyProspectEventBatch;

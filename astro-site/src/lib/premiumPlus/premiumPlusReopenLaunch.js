/**
 * premiumPlusReopenLaunch.js — 「この会員の再募集を開始する」＝**1 つの業務操作**の単一源
 *                              （純粋・I/O なし。ハッシュ計算のみ）
 *
 * ## 何が 1 操作になったか（2026-08-22 MK 仕様変更）
 *
 * 運営者に「販売を再開する」と「再募集を開始する」を**別々に押させる方式は廃止**した。
 * admin の会員詳細にある **「この会員の再募集を開始する」1 操作**で、同時に:
 *
 *   1. その会員の Premium Plus **販売一時停止を解除**する（`PremiumPlusSalePaused = false`）
 *   2. その会員の **`reopenStartsAt` を押下時のサーバー時刻で初回確定**する（first-write-wins）
 *   3. その時刻から **14 日間**のクーポン期限が開始する（導出は既存の単一源）
 *
 * ⚠️ **「販売を一時停止する」は独立した安全スイッチとして残す**（開始後の緊急停止用）。
 *    ただし**通常の再募集フローで「販売を再開する」を単独で押させない**。
 *
 * ## 2 つの保存先にまたがる（原子的にはできない）
 *
 * `reopenStartsAt` は Redis、`salePaused` は Airtable にある。
 * **分散トランザクションは無い**ので、順序と失敗時の意味を設計で固定する。
 *
 * ```
 * ① 前提をすべて確認（gate / 両方の read）── 1 つでも確認できなければ **何も書かない**
 * ② 排他を取る（取れなければ書かない）
 * ③ lock 後に**読み直して**判断し直す（TOCTOU を閉じる）
 * ④ Redis: HSETNX で開始日時（**冪等**。既にあれば書かない）
 * ⑤ lock 検証
 * ⑥ Airtable: 販売停止の解除（**必要なときだけ** PATCH）
 * ```
 *
 * ### なぜ Redis（④）が先か
 *
 * ⑥ が落ちたときに残るのは「**開始済み・販売は停止したまま**」で、
 * **お金の経路は閉じたまま**（fail closed）。逆順にすると
 * 「販売は開いたが再募集期間は始まっていない」＝**購入経路だけ開く**という悪い側に倒れる。
 * ④ は `HSETNX` なので**再送しても開始日時が変わらない**＝同じボタンをもう一度押せば復旧できる。
 *
 * ## 途中成功を曖昧にしない
 *
 * 応答は `startWritten` / `saleResumed` を**別々に**返し、⑥ だけ落ちた場合は
 * `state='incomplete'`（**販売再開が未完了**）として admin に復旧手順を出す。
 * 「たぶん成功」を success にしない。
 *
 * ## 「緊急停止」と「途中成功」を取り違えない（**この設計の要**）
 *
 * どちらも見た目は「開始済み ＋ 販売停止中」で同じ。区別は**停止の時刻**でつける:
 *
 * | 判定 | 意味 | 自動で再開してよいか |
 * |---|---|---|
 * | `pausedAt < startsAt` | 開始操作の⑥が未完了（**途中成功**）| **よい**（同じボタンの再送で復旧）|
 * | `pausedAt >= startsAt` | 開始後に運営者が**意図的に緊急停止**した | **絶対にだめ**（勝手に解除しない）|
 * | `pausedAt` が読めない | 判別できない | **だめ**（安全側。明示的な「販売を再開する」を使わせる）|
 */

import { createHash } from 'node:crypto';
import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';
import {
  REOPEN_UNAVAILABLE,
  normalizeReopenStartsAt,
  isSafeCustomerRecordId,
  describeReopenUnavailable,
} from './premiumPlusReopenStart.js';

/** 会員 1 人の「再募集 × 販売」の状態（**この 5 つしかない**） */
export const LAUNCH_STATE = Object.freeze({
  /** 未開始（販売中 / 停止中は `salePaused` が別に持つ） */
  NOT_STARTED: 'not_started',
  /** 開始済み・販売中（正常）*/
  LIVE: 'live',
  /** 開始済み・**運営者が後から止めた**（安全スイッチ）*/
  PAUSED_AFTER_START: 'paused_after_start',
  /** 開始済みだが**販売再開が未完了**（途中成功。同じボタンの再送で復旧できる）*/
  INCOMPLETE: 'incomplete',
  /** 確認できない（保存先を読めていない）*/
  UNKNOWN: 'unknown',
});

export const LAUNCH_STATE_LABEL = Object.freeze({
  not_started: '再募集 未開始',
  live: '再募集 開始済み / 販売中',
  paused_after_start: '再募集開始済み / 販売一時停止中',
  incomplete: '⚠️ 再募集開始済み / 販売再開が未完了',
  unknown: '確認できない',
});

/** 操作を断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const LAUNCH_REJECT = Object.freeze({
  /** 会員の指定が不正 */
  INVALID_MEMBER: 'reopen_invalid_member',
  /** 前提を確認できない（Redis / Airtable のどちらかが読めない）→ **何も書かない** */
  UNAVAILABLE: 'reopen_state_unavailable',
  /** Premium Plus フィールドが未有効 */
  FIELDS_NOT_READY: 'plus_fields_not_ready',
  /**
   * 販売停止の解除が本番で有効化されていない。
   * ⚠️ **開始日時だけ書いて販売を開けない状態を作らない**ため、書く前に断る。
   */
  SALE_PAUSE_NOT_READY: 'sale_pause_not_ready',
  /** 開始後に**意図的に**停止された会員。勝手に再開しない */
  DELIBERATELY_PAUSED: 'reopen_deliberately_paused',
});

export const LAUNCH_REJECT_TEXT = Object.freeze({
  reopen_invalid_member: '会員の指定が不正です。',
  reopen_state_unavailable: 'この会員の再募集の開始状態、または販売状態を確認できないため、'
    + '**何も変更していません**。時間をおいて再実行してください。',
  plus_fields_not_ready: 'Premium Plus のフィールドが本番で有効化されていないため実行できません。',
  sale_pause_not_ready: '販売の一時停止フィールドが本番で有効化されていないため、'
    + '**販売を再開できません**。再募集の開始日時だけを先に確定させないよう、'
    + '何も変更せずに中止しました。',
  reopen_deliberately_paused: 'この会員は再募集の開始後に販売を一時停止しています。'
    + '意図した緊急停止を勝手に解除しないため、この操作では再開しません。'
    + '再開する場合は「販売を再開する」を明示的に実行してください。',
});

export function describeLaunchReject(reason) {
  return LAUNCH_REJECT_TEXT[String(reason || '')] || 'この操作は実行できませんでした。';
}

/**
 * 排他の識別子（**クーポン実体の lock とは別空間**）。
 * `couponOperationLock.js` の primitive を再利用するため 16〜64 桁の hex にする。
 */
export function computeReopenLockId(recordId) {
  if (!isSafeCustomerRecordId(recordId)) return null;
  return createHash('sha256')
    .update(`ak-pp-reopen-launch|${recordId}`, 'utf8')
    .digest('hex').slice(0, 32);
}

/**
 * 操作の冪等キー。**現在時刻を材料にしない**（再送で同じ値になる）。
 * 監査（`PremiumPlusSalePausedBy` の後ろ）と復旧の突き合わせに使う。
 */
export function computeReopenOperationId(recordId) {
  if (!isSafeCustomerRecordId(recordId)) return null;
  return createHash('sha256')
    .update(`ak-pp-reopen-op|${recordId}`, 'utf8')
    .digest('hex').slice(0, 16);
}

const ms = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * 会員 1 人の状態を分類する（**表示と判断の両方がこれを使う**）。
 *
 * @param {{ reopen: {available?:boolean, startsAtIso?:unknown, reason?:string},
 *           fields: object|null }} input
 * @returns {{ state: string, label: string, started: boolean, salePaused: boolean,
 *             startsAtIso: string, pausedAtIso: string, pauseAnchorKnown: boolean,
 *             deliberatePause: boolean, needsRepair: boolean, note: string }}
 */
export function classifyLaunch({ reopen, fields } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const salePaused = f[PP_SALE_PAUSE_FIELDS.PAUSED] === true;
  const pausedAtIso = String(f[PP_SALE_PAUSE_FIELDS.UPDATED_AT] ?? '').trim();
  const r = reopen || {};
  const base = {
    salePaused,
    pausedAtIso,
    startsAtIso: '',
    started: false,
    pauseAnchorKnown: ms(pausedAtIso) !== null,
    deliberatePause: false,
    needsRepair: false,
  };

  // 開始状態を読めていない = 何も断定しない
  if (r.available !== true) {
    const why = String(r.reason || REOPEN_UNAVAILABLE.NOT_PROVIDED);
    return {
      ...base,
      state: LAUNCH_STATE.UNKNOWN,
      label: LAUNCH_STATE_LABEL.unknown,
      note: describeReopenUnavailable(why),
    };
  }

  const startsAtIso = normalizeReopenStartsAt(r.startsAtIso);
  if (!startsAtIso) {
    return {
      ...base,
      state: LAUNCH_STATE.NOT_STARTED,
      label: LAUNCH_STATE_LABEL.not_started,
      note: salePaused
        ? 'この会員はまだ再募集を開始していません（販売も一時停止中）。'
          + '「この会員の再募集を開始する」で、販売の再開と14日間の開始を同時に行います。'
        : 'この会員はまだ再募集を開始していません。'
          + '「この会員の再募集を開始する」で14日間が開始します（販売は既に停止していません）。',
    };
  }

  const started = { ...base, started: true, startsAtIso };
  if (!salePaused) {
    return {
      ...started,
      state: LAUNCH_STATE.LIVE,
      label: LAUNCH_STATE_LABEL.live,
      note: '再募集は開始済みで、販売も開いています。緊急時は「販売を一時停止する」で止められます'
        + '（停止しても開始日時と期限は変わりません）。',
    };
  }

  // ここから「開始済み ＋ 販売停止中」。**緊急停止**と**途中成功**を取り違えない
  const pausedMs = ms(pausedAtIso);
  const startMs = ms(startsAtIso);
  if (pausedMs !== null && startMs !== null && pausedMs < startMs) {
    return {
      ...started,
      state: LAUNCH_STATE.INCOMPLETE,
      label: LAUNCH_STATE_LABEL.incomplete,
      needsRepair: true,
      note: '再募集の開始日時は確定していますが、**販売の再開が完了していません**'
        + '（開始操作の途中で失敗した状態です）。'
        + 'もう一度「この会員の再募集を開始する」を実行すると、開始日時はそのままで販売だけ再開します。',
    };
  }
  return {
    ...started,
    state: LAUNCH_STATE.PAUSED_AFTER_START,
    label: LAUNCH_STATE_LABEL.paused_after_start,
    deliberatePause: true,
    note: pausedMs === null
      ? '再募集は開始済みですが、販売が一時停止しています。停止した時刻が記録されていないため、'
        + '**緊急停止か開始処理の未完了かを判別できません**。'
        + '再開する場合は「販売を再開する」を明示的に実行してください（開始日時は変わりません）。'
      : '再募集の開始後に販売を一時停止しています（緊急停止）。'
        + '再開する場合は「販売を再開する」を実行してください（開始日時と期限は変わりません）。',
  };
}

/**
 * 「この会員の再募集を開始する」を実行してよいか、**何を書くべきか**を決める。
 *
 * ⚠️ **前提が 1 つでも確認できなければ何も書かない**（fail closed）。
 * ⚠️ 販売を再開できない環境（gate off）では、**開始日時も書かない**
 *    （開始だけ確定して売れない、という片側状態を作らないため）。
 *
 * @param {{ reopen: object, fields: object|null, recordId: string,
 *           plusFieldsReady: boolean, salePauseWritable: boolean }} input
 * @returns {{ ok: true, state: string, writeStart: boolean, resumeSale: boolean,
 *             alreadyStarted: boolean, noop: boolean }
 *          |{ ok: false, reason: string, state: string, message: string }}
 */
export function planReopenLaunch({
  reopen, fields, recordId, plusFieldsReady, salePauseWritable,
} = {}) {
  const view = classifyLaunch({ reopen, fields });
  const deny = (reason) => ({
    ok: false, reason, state: view.state, message: describeLaunchReject(reason),
  });

  if (!isSafeCustomerRecordId(recordId)) return deny(LAUNCH_REJECT.INVALID_MEMBER);
  // 開始状態も販売状態も、読めていなければ何も書かない
  if (view.state === LAUNCH_STATE.UNKNOWN) return deny(LAUNCH_REJECT.UNAVAILABLE);
  if (plusFieldsReady !== true) return deny(LAUNCH_REJECT.FIELDS_NOT_READY);

  // 開始後に**意図的に**止めた会員は、この操作では再開しない
  if (view.state === LAUNCH_STATE.PAUSED_AFTER_START) return deny(LAUNCH_REJECT.DELIBERATELY_PAUSED);

  const resumeSale = view.salePaused === true;
  // 販売を再開できない環境なら、**開始日時も書かない**
  if (resumeSale && salePauseWritable !== true) return deny(LAUNCH_REJECT.SALE_PAUSE_NOT_READY);

  const writeStart = view.started !== true;
  return {
    ok: true,
    state: view.state,
    writeStart,
    resumeSale,
    alreadyStarted: view.started === true,
    /** 何も書く必要が無い（既に開始済みで販売中）*/
    noop: !writeStart && !resumeSale,
  };
}

/**
 * 確認ダイアログの文言（**単一源**）。
 * ⚠️ 対象会員と「同時に何が起きるか」を必ず入れる（取り違え・誤解が最悪の事故）。
 *
 * @param {{ memberLabel?: string, resumeSale?: boolean, repair?: boolean }} input
 */
export function buildLaunchConfirmText({ memberLabel, resumeSale, repair } = {}) {
  const who = String(memberLabel || '').trim() || 'この会員';
  if (repair === true) {
    return [
      `${who} の販売再開をやり直します（再募集の開始日時はすでに確定しています）。`,
      '',
      '・開始日時と有効期限は**変わりません**',
      '・この会員の販売一時停止だけを解除します',
      '・他の会員には影響しません',
      '',
      '実行しますか？',
    ].join('\n');
  }
  return [
    `${who} の Premium Plus 再募集を開始します。`,
    '',
    ...(resumeSale === true
      ? ['・この会員の**販売一時停止を解除**します（購入できるようになります）']
      : ['・この会員の販売は既に停止していません（販売状態は変わりません）']),
    '・開始日時は「いまのサーバー時刻」で確定します',
    '・この会員の優待クーポンの有効期限が「開始日時から14日間」で確定します',
    '・一度開始すると、開始日時は変更・取り消しできません',
    '・他の会員には影響しません（会員ごとの操作です）',
    '・販売資格・段階公開・会員権・決済は変更しません',
    '',
    '実行しますか？',
  ].join('\n');
}

/**
 * admin に出す**操作 1 つ**（迷わせないため、状態ごとに主操作は必ず 1 つだけ）。
 *
 * ⚠️ 「販売を再開する」と「再募集を開始する」を**並べない**。
 *    未開始の会員に「販売を再開する」を出さない（再募集の開始が主操作）。
 *
 * @param {{ view: object, memberLabel?: string, salePauseWritable?: boolean }} input
 * @returns {{ kind: string, label: string, confirmText: string, enabled: boolean,
 *             note: string, showPauseSwitch: boolean, showResumeSwitch: boolean }}
 */
export function describeLaunchAction({ view, memberLabel, salePauseWritable } = {}) {
  const v = view || {};
  const none = {
    kind: 'none', label: '', confirmText: '', enabled: false, note: '',
    showPauseSwitch: false, showResumeSwitch: false,
  };

  if (v.state === LAUNCH_STATE.UNKNOWN) {
    return { ...none, note: v.note || '状態を確認できないため、操作は表示していません。' };
  }

  if (v.state === LAUNCH_STATE.NOT_STARTED) {
    return {
      ...none,
      kind: 'start',
      label: '▶ この会員の再募集を開始する',
      confirmText: buildLaunchConfirmText({ memberLabel, resumeSale: v.salePaused === true }),
      // 停止中なのに解除できない環境では押させない（片側状態を作らない）
      enabled: v.salePaused !== true || salePauseWritable === true,
      note: v.salePaused === true
        ? '販売の再開と14日間の開始を、この 1 操作で同時に行います。'
        : '14日間の開始を確定します。',
      // ⚠️ 未開始の会員に「販売を再開する」を出さない（主操作と並べない）
      showPauseSwitch: v.salePaused !== true && salePauseWritable === true,
      showResumeSwitch: false,
    };
  }

  if (v.state === LAUNCH_STATE.INCOMPLETE) {
    return {
      ...none,
      kind: 'repair',
      label: '▶ 販売再開をやり直す',
      confirmText: buildLaunchConfirmText({ memberLabel, repair: true }),
      enabled: salePauseWritable === true,
      note: '開始日時は変わりません。販売の一時停止だけを解除します。',
      showPauseSwitch: false,
      showResumeSwitch: false,
    };
  }

  if (v.state === LAUNCH_STATE.PAUSED_AFTER_START) {
    return {
      ...none,
      // 緊急停止の解除は**明示的な独立スイッチ**でだけ行う
      note: v.note || '',
      showPauseSwitch: false,
      showResumeSwitch: salePauseWritable === true,
    };
  }

  // LIVE: 主操作は無い。安全スイッチ（停止）だけ残す
  return {
    ...none,
    note: v.note || '',
    showPauseSwitch: salePauseWritable === true,
    showResumeSwitch: false,
  };
}

/**
 * premiumPlusAdminStatusSummary.js
 *   管理画面の会員詳細の**先頭に出す「現在の状態」要約**の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-09 MK 指摘）
 *
 * > adminで見てもわからないのよ、なぜって？理由はこの会員の再募集を開始するボタンが
 * > 押せそうだからと、今すぐ販売可も押せそうで、矛盾しているからです
 *
 * 画面が**操作だけを並べていて、いまどういう状態かを先に書いていなかった**。
 * そのため「すでに 9/4 から購入できる会員」に対して
 *   「今すぐ販売可」（＝まだ売れていないように見える）
 *   「この会員の再募集を開始する」（＝まだ募集していないように見える）
 * が同時に押せる状態で並び、どちらが正しいのか読み取れなかった。
 *
 * ここは**判定を作らない**。サーバーが解決済みの行（`rows[]` の 1 件）を、
 * 運営判断に必要な順番で日本語 1 行ずつに直すだけ。
 *
 * ## 出す項目（この順番。運営判断の重要度順）
 *
 * | # | 項目 | 何を答えるか |
 * |---|---|---|
 * | 1 | 購入可否 | **いまこの会員は買えるのか** |
 * | 2 | 販売停止 | 止めているのか（止めていれば理由と時刻）|
 * | 3 | 段階公開の現在地 | PHASE いくつで、次はいつ何が起きるか |
 * | 4 | クーポン | 取得しているか（していれば取得日時）|
 * | 5 | 再募集の開始 | **クーポンの 14 日間**が始まっているか |
 *
 * ⚠️ 「再募集の開始」は**クーポン期間**の話で、販売の可否とは別軸。
 *    ラベルだけ見て「まだ売っていない」と読まれるので、必ず購入可否と並べて出す。
 *
 * ## 眼精疲労を抑える（2026-09-09 追加要件）
 *
 * **細かい文章を読まなくても運営できる**ことが完成条件。ここが返すのは
 *   `headline`  … 大きな 1 行（10〜20 文字程度で断定）
 *   `badge`     … 色分け用の短いラベル（10 文字前後）
 *   `tone`      … 色（ok / warn / stop / muted）
 *   `items`     … 上部に集約する最小限（購入可否・停止・段階・クーポン・期間）
 * 長文は `note` に置き、**主表示にしない**。詳細は画面側で折りたたみへ入れる。
 *
 * ## 矛盾を作らないための約束
 *
 * `describeActionConflicts()` が「状態と食い違う操作」を返す。画面はこれを見て
 * ボタンを押させない/理由を出す。**要約とボタンが逆のことを言う状態を作らない。**
 */

/** 段階公開の待機日数（表示用。判定は premiumPlusRelease.js が正本） */
import { PP_PHASE, PP_PHASE_START_DAY } from './premiumPlusRelease.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO → 「2026-09-04」（JST の暦日）。読めない値は空文字 */
export function jstDate(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO → 「2026-09-04 18:41」（JST）。読めない値は空文字 */
export function jstDateTime(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + JST_OFFSET_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

/** 販売資格の確定日（0 日目）から各段階に入る JST 暦日 */
export function phaseSchedule(eligibleAtIso) {
  const t = Date.parse(String(eligibleAtIso || ''));
  if (!Number.isFinite(t)) return null;
  const at = (days) => jstDate(new Date(t + days * 86400000).toISOString());
  return {
    day0: jstDate(eligibleAtIso),
    teaser: at(PP_PHASE_START_DAY.TEASER),
    preview: at(PP_PHASE_START_DAY.PREVIEW),
    sale: at(PP_PHASE_START_DAY.SALE),
  };
}

/**
 * 先頭に出す「現在の状態」。
 *
 * @param {object} row `/admin/premium-plus-eligibility` の `rows[]` の 1 件
 * @returns {{ headline: string, tone: 'ok'|'warn'|'stop'|'muted',
 *             items: Array<{ key: string, label: string, value: string, tone: string, note: string }> }}
 */
export function describeAdminStatusSummary(row) {
  const r = row || {};
  const items = [];
  const add = (key, label, value, tone = '', note = '') => items.push({ key, label, value, tone, note });

  const paused = r.salePaused === true;
  const canBuy = r.purchaseEnabled === true;
  const sched = phaseSchedule(r.eligibleAt);

  // ── 1. 購入可否（最初に答える）────────────────────────────
  if (canBuy) {
    add('purchase', '購入可否', '✅ いま購入できます', 'ok',
      sched && sched.sale ? `${sched.sale} から購入できる状態です` : '');
  } else if (paused) {
    add('purchase', '購入可否', '⛔ 購入できません（販売を一時停止中）', 'stop',
      '停止を解除すれば、元の段階公開の状態に戻ります');
  } else if (r.eligibility === 'blocked') {
    add('purchase', '購入可否', '⛔ 購入できません（販売対象外）', 'stop');
  } else if (r.eligibility !== 'eligible') {
    add('purchase', '購入可否', '⛔ 購入できません（販売資格が保留）', 'warn',
      '「段階公開で販売可」または「今すぐ販売可」を押すまで購入できません');
  } else if (r.showProductPage === true) {
    add('purchase', '購入可否', '⏳ まだ購入できません（商品ページは見えています）', 'warn',
      sched && sched.sale ? `${sched.sale} に購入解禁の予定です` : '');
  } else {
    add('purchase', '購入可否', '⏳ まだ購入できません（商品ページも非公開）', 'warn',
      sched && sched.sale ? `${sched.sale} に購入解禁の予定です` : '');
  }

  // ── 2. 販売停止 ──────────────────────────────────────────
  add('pause', '販売の一時停止', paused ? '⏸ 停止中' : '停止していません', paused ? 'stop' : 'muted',
    paused
      ? [r.salePauseReason ? `理由: ${r.salePauseReason}` : '',
        r.salePausedAt ? `${jstDateTime(r.salePausedAt)}${r.salePausedBy ? ` / ${r.salePausedBy}` : ''}` : '']
        .filter(Boolean).join(' ・ ')
      : '');

  // ── 3. 段階公開の現在地 ──────────────────────────────────
  const phase = Number(r.phase);
  const phaseName = {
    [PP_PHASE.LOCKED]: '非公開（商品ページも出しません）',
    [PP_PHASE.TEASER]: '予告のみ（金額・購入ボタンなし）',
    [PP_PHASE.PREVIEW]: '商品ページ閲覧可（購入ボタンはまだ）',
    [PP_PHASE.SALE]: '販売中（価格と申込ボタンを表示）',
  }[phase] || '不明';
  // ⚠️ 主表示に PHASE 番号を出さない（2026-09-09 確定仕様 §0）。
  //    番号は折りたたみ内の詳細セクションで確認できる。ここは人間向けの言葉だけ。
  add('phase', '公開の状況',
    r.overrideApplied === true ? '待機日数を飛ばして販売中' : phaseName,
    phase === PP_PHASE.SALE || r.overrideApplied === true ? 'ok' : 'warn',
    sched
      ? `資格確定 ${sched.day0} → 予告 ${sched.teaser} → ページ公開 ${sched.preview} → 購入解禁 ${sched.sale}`
      : '資格確定日が読めないため予定を計算できません');

  // ── 4. クーポン ─────────────────────────────────────────
  const claimed = r.reopenCouponClaimed === true;
  add('coupon', 'クーポン', claimed ? '取得済み' : '未取得', claimed ? 'ok' : 'muted',
    claimed && r.reopenCouponClaimedAt ? `取得 ${jstDateTime(r.reopenCouponClaimedAt)}` : '');

  // ── 5. 再募集の開始（= クーポンの 14 日間）────────────────
  const lc = r.reopenLaunch || null;
  const startedAt = (r.reopenStart && r.reopenStart.startsAtIso) || '';
  const launch = {
    live: { v: '開始済み', tone: 'ok' },
    not_started: { v: '未開始', tone: 'muted' },
    incomplete: { v: '⚠️ 途中まで（要復旧）', tone: 'warn' },
    paused_after_start: { v: '開始済み（そのあと緊急停止）', tone: 'stop' },
    unknown: { v: '確認できません', tone: 'warn' },
  }[(lc && lc.state) || 'unknown'] || { v: '確認できません', tone: 'warn' };
  add('reopen', 'クーポンの利用期間（14日）', launch.v, launch.tone,
    startedAt ? `開始 ${jstDateTime(startedAt)}` : 'これは購入可否とは別軸です。押すとクーポンの14日間が始まります');

  // ── 大きな 1 行（色分け用の短いバッジ付き）────────────────
  //    ⚠️ ここは**短く断定**する。長い説明は note へ回す（眼精疲労対策）
  const headline = canBuy
    ? (sched && sched.sale ? `${sched.sale} から購入できる状態です` : 'いま購入できる状態です')
    : (paused ? '販売を一時停止中です（購入できません）'
      : (r.eligibility === 'blocked' ? '販売対象外です'
        : (r.eligibility !== 'eligible' ? '販売資格が保留のため購入できません'
          : (sched && sched.sale ? `まだ購入できません（${sched.sale} に購入解禁の予定）` : 'まだ購入できません'))));

  const badge = paused ? '販売停止中'
    : (r.eligibility === 'blocked' ? '販売対象外'
      : (r.eligibility !== 'eligible' ? '資格保留'
        : (canBuy ? '購入可能' : '段階表示中')));

  return {
    headline,
    /** 色分け用の短いラベル（10 文字前後）。長文を読ませない */
    badge,
    tone: canBuy ? 'ok' : (paused || r.eligibility === 'blocked' ? 'stop' : 'warn'),
    /** 上部に集約する 1 行サマリ（残日数・何日目・購入可否） */
    stageLine: describeStageLine(r),
    items,
  };
}

/**
 * 段階表示の現在地を**人間向けの 1 行**にする。
 * `PHASE 3` だけを見せて判断させない（2026-09-09 確定仕様 §2）。
 *
 * ⚠️ 段階そのものは `premiumPlusRelease.js` の値を使う。ここで判定を作らない。
 *    残日数は**表示のためだけ**に資格確定日から数える。
 */
export function describeStageLine(row) {
  const r = row || {};
  if (r.salePaused === true) return '販売停止中（購入も閲覧もできません）';
  if (r.eligibility === 'blocked') return '販売対象外';
  if (r.eligibility !== 'eligible') return '販売資格が保留（段階表示は始まっていません）';
  if (r.overrideApplied === true) return '購入可能（待機日数を飛ばして販売中）';

  const sched = phaseSchedule(r.eligibleAt);
  const day = daysSinceJst(r.eligibleAt);
  const phase = Number(r.phase);
  if (phase === PP_PHASE.SALE) {
    return sched && sched.sale ? `購入可能（${sched.sale} から）` : '購入可能';
  }
  const left = (target) => {
    if (day === null || !Number.isFinite(target)) return null;
    const n = target - day;
    return n > 0 ? n : null;
  };
  const dayText = day === null ? '' : `段階表示 ${day + 1} 日目`;
  if (phase === PP_PHASE.PREVIEW) {
    const n = left(PP_PHASE_START_DAY.SALE);
    return [dayText, '商品ページ閲覧可・購入はまだ不可', n ? `あと ${n} 日で購入可能` : '']
      .filter(Boolean).join(' ・ ');
  }
  if (phase === PP_PHASE.TEASER) {
    const n = left(PP_PHASE_START_DAY.PREVIEW);
    return [dayText, '予告のみ表示中', n ? `あと ${n} 日で商品ページ表示` : '']
      .filter(Boolean).join(' ・ ');
  }
  const n = left(PP_PHASE_START_DAY.TEASER);
  return [dayText, '非公開（商品ページも出しません）', n ? `あと ${n} 日で予告開始` : '']
    .filter(Boolean).join(' ・ ');
}

/** 資格確定日から今日までの JST 暦日数（当日 = 0）。読めなければ null */
export function daysSinceJst(eligibleAtIso, nowMs = Date.now()) {
  const t = Date.parse(String(eligibleAtIso || ''));
  if (!Number.isFinite(t)) return null;
  const day = (ms) => Math.floor((ms + JST_OFFSET_MS) / 86400000);
  const n = day(nowMs) - day(t);
  return n < 0 ? null : n;
}

/**
 * その状態で**意味のある操作だけ**を返す（大きなボタンにする分）。
 *
 * ⚠️ 2026-09-09 確定仕様 §3 / §5。
 *    - 販売状態は**トグル 1 つ**（いまの状態を表すボタンを押すと切り替わる）
 *    - 結果が変わらない操作は**出さない**
 *    - 書込 gate が無ければ押させない（fail closed）
 *
 * @param {object} row
 * @param {{ salePauseWritable?: boolean, overrideEnabled?: boolean, couponWritable?: boolean }} caps
 *   書込可否（env gate）。**呼び出し側がサーバーの値をそのまま渡す**
 * @returns {Array<{ key: string, label: string, tone: string, kind: string,
 *                   enabled: boolean, reason: string }>}
 */
export function describeNextActions(row, caps = {}) {
  const r = row || {};
  const out = [];
  const paused = r.salePaused === true;
  const conflicts = describeActionConflicts(r);

  // 1. 販売状態のトグル（ボタン名は押すと起こること）
  const pauseWritable = caps.salePauseWritable === true;
  // ⚠️ 資格が無い会員（対象外）に「販売を停止」は意味がない（商品ページ自体が出ない）。
  //    ただし**停止中なら必ず再開を出す**（止めたまま戻せない状態を作らない）。
  const showToggle = paused || r.eligibility === 'eligible';
  // ⚠️ 2026-09-10 MK 指摘: 「販売停止中」は**状態表示であって操作名ではない**。
  //    ボタンには**押すと起こること**を書く（停止中 → 販売を再開 / 販売中 → 販売を停止）。
  //    いまの状態は上の要約（バッジ・1 行）が伝える。ボタンと状態表示の役割を混ぜない。
  if (showToggle) out.push({
    key: 'salePauseToggle',
    label: paused ? '販売を再開' : '販売を停止',
    sub: paused ? 'この会員だけ再開します（結果・商品内容も再び見えます）' : 'この会員だけ止めます（結果・商品内容も見えなくなります）',
    tone: paused ? 'ok' : 'stop',
    kind: paused ? 'resume' : 'pause',
    /** 危険な操作か（確認ダイアログを出すのは停止のときだけ） */
    danger: !paused,
    enabled: pauseWritable,
    reason: pauseWritable ? '' : '本番でまだ有効化されていないため実行できません',
  });

  // 2. 今すぐ販売可（意味があるときだけ）
  if (!conflicts.immediate && r.overrideApplied !== true) {
    const ok = caps.overrideEnabled === true;
    out.push({
      key: 'immediate',
      label: '今すぐ販売可にする',
      sub: '待機日数を飛ばして、この会員だけ購入できるようにします',
      tone: 'warn', kind: 'immediate',
      enabled: ok,
      reason: ok ? '' : '本番でまだ有効化されていないため実行できません',
    });
  }

  // 3. クーポンの利用期間（14日）を開始（未開始のときだけ）
  // ⚠️ 停止中は出さない。旧実装の「開始」は**販売再開も同時に行う**ため、
  //    上のトグルと合わせて「再開できる操作」が 2 つ並び、状態と食い違う。
  //    販売の再開はトグル 1 つに保つ（2026-09-09 確定仕様 §3）。
  const lc = r.reopenLaunch || null;
  const act = (lc && lc.action) || null;
  if (!paused && act && (act.kind === 'start' || act.kind === 'repair')) {
    out.push({
      key: 'couponPeriod',
      label: act.label,
      sub: act.note || '',
      tone: 'warn', kind: act.kind,
      enabled: act.enabled === true,
      reason: act.enabled === true ? '' : '実行できない状態です（下の詳細をご確認ください）',
    });
  }
  return out;
}

/**
 * 状態と食い違う操作（**押させてはいけないもの**）を返す。
 *
 * ⚠️ 2026-09-09 の指摘そのもの。すでに購入できる会員に
 *    「今すぐ販売可（＝購入可にする）」を押せる状態で見せていた。
 *    やることが無い操作を押せる形で出すと、運営が状態を誤読する。
 *
 * @param {object} row
 * @returns {Record<string, string>} 操作キー → 押させない理由（空 = 制限なし）
 */
export function describeActionConflicts(row) {
  const r = row || {};
  const out = {};
  // 「今すぐ販売可」= 待機日数を飛ばして購入可にする操作。すでに購入できるなら意味がない
  if (r.purchaseEnabled === true && r.overrideApplied !== true) {
    out.immediate = 'すでに購入できる状態です（段階公開で販売中）。飛ばす待機日数がありません';
  }
  // 停止中に「今すぐ販売可」を押しても購入可にはならない（停止の解除が先）
  if (r.salePaused === true) {
    out.immediate = '販売を一時停止中です。先に停止を解除してください';
  }
  return out;
}

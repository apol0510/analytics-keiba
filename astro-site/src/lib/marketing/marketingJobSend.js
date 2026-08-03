/**
 * marketingJobSend.js — 送信待ちジョブを**そのカードから**送るための判定（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 実送信は Step 5（顧客を選ぶ → キャンペーンを選ぶ → dry-run → キュー登録 → 送信）
 * の一本道にしか無かった。そのため、**すでにキュー登録済みのジョブ**を送るのに
 * 顧客の再選択と dry-run のやり直しが必要で、
 *
 *   - 選び直した母集団がキュー登録時と違えば、そもそも送れない
 *   - 画面の選択状態に依存するので、別の日・別の人が引き継げない
 *
 * という詰まり方をしていた。ジョブは `jobId` で一意に決まるのだから、
 * **カードから jobId を固定して送れる**ようにする。
 *
 * ── 安全側の約束 ──────────────────────────────────────────────
 *   - 送る対象は**カードの jobId だけ**。画面の顧客選択・絞り込み・キャンペーン選択を見ない
 *   - 確認（dispatcher の dryRun）を通していないと押せない
 *   - 確認した jobId と送る jobId が違えば送らない
 *   - 確認したときの送信予定人数と、直前に取り直した人数が違えば送らない
 *   - 人数の入力一致を必須にする（誤クリックで飛ばない）
 *   - 送信済み / 失敗 / 取消済みのジョブは送れない
 *
 * ⚠️ このモジュールは**押せるかどうかを決めるだけ**。
 *    誰に送ってよいか（suppression / 配信停止 / 退会 / 頻度）は
 *    `marketingDispatchGate.js` が送信直前に 1 通ずつ判定する。
 */

/** 送れない理由（固定コード） */
export const JOB_SEND_BLOCK = Object.freeze({
  BUSY: 'busy',
  NOT_PENDING: 'not_pending',
  NO_CHECK: 'no_check',
  CHECK_STALE: 'check_stale',
  JOB_MISMATCH: 'job_mismatch',
  NO_RECIPIENTS: 'no_recipients',
  BLOCKED: 'blocked',
  GATE_CLOSED: 'gate_closed',
  ALREADY_SENT: 'already_sent',
  CONFIRM_MISMATCH: 'confirm_mismatch',
});

export const JOB_SEND_BLOCK_LABEL = Object.freeze({
  [JOB_SEND_BLOCK.BUSY]: '実行中です。完了までお待ちください。',
  [JOB_SEND_BLOCK.NOT_PENDING]: 'このジョブは送信待ちではありません（送信済み・失敗・取消済みは送れません）。',
  [JOB_SEND_BLOCK.NO_CHECK]: '先に「配信内容を確認」を押してください。',
  [JOB_SEND_BLOCK.CHECK_STALE]: '確認後に状態が変わりました。もう一度「配信内容を確認」を押してください。',
  [JOB_SEND_BLOCK.JOB_MISMATCH]: '確認したジョブと送ろうとしているジョブが違います。',
  [JOB_SEND_BLOCK.NO_RECIPIENTS]: '送信対象が 0 名です（全員が除外されました）。',
  [JOB_SEND_BLOCK.BLOCKED]: 'このジョブは送れません（組み立て方の版が合いません）。確認結果の理由を見てください。',
  [JOB_SEND_BLOCK.GATE_CLOSED]: '実配信が無効です（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）。',
  [JOB_SEND_BLOCK.ALREADY_SENT]: 'このカードからは送信済みです。結果を確認してください。',
  [JOB_SEND_BLOCK.CONFIRM_MISMATCH]: '確認入力が一致しません。送信予定人数を正しく入力してください。',
});

/** 送信待ち（＝送れる可能性がある）状態か */
export const SENDABLE_STATUS = 'PENDING';

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * dispatcher の `dryRun:true` 応答から、**このジョブ 1 件**の確認結果を取り出す。
 *
 * `jobId` を指定して呼んだ前提なので 1 件に決まるはずだが、
 * 0 件・2 件以上・別 ID が返ってきたら**送らせない**（fail closed）。
 *
 * @param {object} result dispatcher の応答
 * @param {string} jobId カードの jobId
 */
export function buildJobPreflight(result, jobId) {
  const id = str(jobId);
  const rows = Array.isArray(result && result.jobResults) ? result.jobResults : [];
  const no = (reason, extra = {}) => ({ ok: false, reason, jobId: id, ...extra });

  if (!id) return no(JOB_SEND_BLOCK.JOB_MISMATCH);
  const mine = rows.filter((r) => str(r && r.jobId) === id);
  if (mine.length !== 1) return no(JOB_SEND_BLOCK.JOB_MISMATCH, { found: mine.length });

  const j = mine[0];
  if (j.blocked) {
    return no(JOB_SEND_BLOCK.BLOCKED, {
      blocked: str(j.blocked), note: str(j.note),
      jobShellVersion: j.jobShellVersion ?? null,
      expectedShellVersion: j.expectedShellVersion ?? null,
    });
  }
  const willSend = num(j.willSend);
  if (willSend === 0) return no(JOB_SEND_BLOCK.NO_RECIPIENTS, { willSend: 0, willSkip: num(j.willSkip) });

  return {
    ok: true,
    reason: null,
    jobId: id,
    campaignId: str(j.campaignId),
    version: str(j.version),
    shellVersion: j.shellVersion ?? null,
    contentHash: str(j.contentHash),
    queued: num(j.queued),
    willSend,
    willSkip: num(j.willSkip),
    total: num(j.total),
    skipByReason: (j.skipByReason && typeof j.skipByReason === 'object') ? j.skipByReason : {},
    providerSuppression: (result && result.providerSuppression) || null,
    // 確認した内容の指紋。送信直前に取り直した結果と突き合わせる
    fingerprint: `${id}|${willSend}|${num(j.willSkip)}|${num(j.total)}|${str(j.contentHash)}|${j.shellVersion ?? ''}`,
  };
}

/**
 * 「今すぐ送信」を押せるか。**すべての段を通っている場合だけ** true。
 *
 * @param {{ busy?: boolean, dispatchEnabled?: boolean, status?: string,
 *           preflight?: object|null, sent?: boolean }} state
 */
export function canSendJob(state = {}) {
  const no = (reason) => ({ allowed: false, reason, label: JOB_SEND_BLOCK_LABEL[reason] || '' });
  if (state.busy === true) return no(JOB_SEND_BLOCK.BUSY);
  if (state.sent === true) return no(JOB_SEND_BLOCK.ALREADY_SENT);
  if (str(state.status).toUpperCase() !== SENDABLE_STATUS) return no(JOB_SEND_BLOCK.NOT_PENDING);
  if (state.dispatchEnabled !== true) return no(JOB_SEND_BLOCK.GATE_CLOSED);
  const pf = state.preflight;
  if (!pf) return no(JOB_SEND_BLOCK.NO_CHECK);
  if (pf.ok !== true) return no(pf.reason || JOB_SEND_BLOCK.NO_CHECK);
  if (num(pf.willSend) === 0) return no(JOB_SEND_BLOCK.NO_RECIPIENTS);
  return { allowed: true, reason: null, label: '' };
}

/**
 * 実送信の直前に、**確認したときと同じジョブ・同じ内容か**を照合する。
 * 変わっていたら送らない（409 相当）。
 *
 * @param {{ preflight: object, latest: object, typedCount: string|number }} input
 */
export function verifyJobSendPrecondition({ preflight, latest, typedCount } = {}) {
  const no = (reason) => ({ ok: false, reason, label: JOB_SEND_BLOCK_LABEL[reason] || '' });
  if (!preflight || preflight.ok !== true) return no(JOB_SEND_BLOCK.NO_CHECK);

  // 人数の入力一致（誤クリックで飛ばないための最後の関門）
  if (str(typedCount) !== String(num(preflight.willSend))) return no(JOB_SEND_BLOCK.CONFIRM_MISMATCH);

  // 直前に取り直した確認結果と突き合わせる
  const now = buildJobPreflight(latest, preflight.jobId);
  if (!now.ok) return no(now.reason || JOB_SEND_BLOCK.CHECK_STALE);
  if (now.jobId !== preflight.jobId) return no(JOB_SEND_BLOCK.JOB_MISMATCH);
  if (now.fingerprint !== preflight.fingerprint) return no(JOB_SEND_BLOCK.CHECK_STALE);

  return { ok: true, reason: null, jobId: now.jobId, willSend: num(now.willSend) };
}

/**
 * 送信ボタンを押す前に読ませる内容。**何が起きるかを全部出す**。
 */
export function buildJobSendConfirmation({ preflight, operationId } = {}) {
  const p = preflight || {};
  return {
    jobId: str(p.jobId),
    campaign: `${str(p.campaignId)}${p.version ? ` v${str(p.version)}` : ''}`,
    queued: num(p.queued),
    willSend: num(p.willSend),
    willSkip: num(p.willSkip),
    contentHash: str(p.contentHash),
    shellVersion: p.shellVersion ?? null,
    operationId: str(operationId),
    effect: 'このジョブの送信対象へ**実際にメールを送ります**。送信は取り消せません。',
    reverify: '送信直前に 1 通ずつ、配信停止・バウンス・退会・頻度をもう一度判定します。',
    failClosed: '配信基盤の配信停止リストを確認できない場合は 1 通も送りません。',
    afterSend: '送信後はこのカードから再送できません（同じ相手へ送るには版を上げて作り直します）。',
  };
}

/**
 * 送信結果のまとめ（成功・部分失敗・失敗を読み違えないように）。
 */
export function summarizeJobSendResult(result, jobId) {
  const rows = Array.isArray(result && result.jobResults) ? result.jobResults : [];
  const mine = rows.find((r) => str(r && r.jobId) === str(jobId)) || {};
  const sent = num(result && result.sent);
  const failed = num(result && result.failed);
  const skipped = num(result && result.skipped);
  const outcome = failed > 0 ? (sent > 0 ? 'PARTIAL' : 'FAILED') : (sent > 0 ? 'SENT' : 'NONE');
  return {
    outcome,
    label: { SENT: '送信しました', PARTIAL: '一部失敗', FAILED: '送信できませんでした', NONE: '送信対象がありませんでした' }[outcome],
    sent, failed, skipped,
    skipByReason: (mine.skipByReason && typeof mine.skipByReason === 'object') ? mine.skipByReason : {},
    note: outcome === 'PARTIAL'
      ? '失敗した分は自動で再送しません。送信状況で理由を確認してください。'
      : '「送信済み」は配信基盤が受理した状態です。実際に届いたか（delivered）は別に確認します。',
  };
}

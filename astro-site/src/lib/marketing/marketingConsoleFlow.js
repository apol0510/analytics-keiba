/**
 * marketingConsoleFlow.js — 管理画面の**操作順を強制する**状態機械（純粋・DOM 非依存）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 機能は揃っていたが、画面のどこから手を付ければよいか分からず、
 * 「確認せずに送る」「対象を変えたのに古い確認結果のまま送る」ができてしまう構造だった。
 * **押せる／押せないの根拠**をここに集約し、画面はこの判定に従うだけにする。
 *
 * ── 操作の順序（これ以外の順で送信へ到達できない）────────────
 *   1. 対象を絞る（フィルター）
 *   2. 顧客を選ぶ
 *   3. キャンペーンを選ぶ
 *   4. 送信対象を確認（dry-run）
 *   5. キュー登録 → 送信直前の確認 → 最終送信
 *   6. 送信状況・取消・結果確認
 *
 * ── 確認結果の失効 ────────────────────────────────────────
 * 選択・フィルター・キャンペーンのどれかが変われば、**dry-run の結果は無効**になる。
 * 「確認した母集団」と「送る母集団」がズレたまま送らせないため、再確認を必須にする。
 */

/** 画面のステップ */
export const STEP = Object.freeze({
  FILTER: 1,
  SELECT: 2,
  CAMPAIGN: 3,
  DRY_RUN: 4,
  SEND: 5,
  RESULT: 6,
});

/** 押せない理由（固定コード。画面はこれを文言へ変換する） */
export const BLOCK = Object.freeze({
  GATE_ENQUEUE_CLOSED: 'gate_enqueue_closed',
  GATE_DISPATCH_CLOSED: 'gate_dispatch_closed',
  NO_SELECTION: 'no_selection',
  NO_CAMPAIGN: 'no_campaign',
  NO_DRY_RUN: 'no_dry_run',
  DRY_RUN_STALE: 'dry_run_stale',
  NO_RECIPIENTS: 'no_recipients',
  NOT_ENQUEUED: 'not_enqueued',
  NO_DISPATCH_CHECK: 'no_dispatch_check',
  BUSY: 'busy',
  TEST_ONLY_MIXED: 'test_only_mixed',
});

/** 理由コード → 画面に出す文言（「何をすべきか」まで書く） */
export const BLOCK_LABEL = Object.freeze({
  [BLOCK.GATE_ENQUEUE_CLOSED]: 'キュー登録が無効です（MARKETING_CAMPAIGN_ENABLED 未設定）。有効化には承認と env 設定が要ります。',
  [BLOCK.GATE_DISPATCH_CLOSED]: '実配信が無効です（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）。キュー登録まではできます。',
  [BLOCK.NO_SELECTION]: '顧客が 1 名も選択されていません。Step 2 で選んでください。',
  [BLOCK.NO_CAMPAIGN]: 'キャンペーンが選ばれていません。Step 3 で選んでください。',
  [BLOCK.NO_DRY_RUN]: '送信対象の確認（dry-run）がまだです。Step 4 を実行してください。',
  [BLOCK.DRY_RUN_STALE]: '選択・条件・キャンペーンが変わったため、確認結果は無効です。もう一度 dry-run してください。',
  [BLOCK.NO_RECIPIENTS]: '送信対象が 0 名です。除外理由を確認してください。',
  [BLOCK.NOT_ENQUEUED]: 'キュー登録がまだです。Step 5 で登録してください。',
  [BLOCK.NO_DISPATCH_CHECK]: '送信直前の確認がまだです。「配信内容を確認」を実行してください。',
  [BLOCK.BUSY]: '実行中です。完了までお待ちください。',
  [BLOCK.TEST_ONLY_MIXED]: '運用テスト専用キャンペーンです。テスト受信者以外へは送れません。',
});

const str = (v) => String(v ?? '').trim();

/**
 * 「確認した状態」を一意に表す指紋。
 * 選択顧客・フィルター・キャンペーンのどれかが変われば別の値になる。
 */
export function computeSelectionFingerprint({ selectedIds = [], filters = {}, campaignId = '', campaignVersion = '' } = {}) {
  const ids = [...selectedIds].map(str).filter(Boolean).sort();
  const keys = Object.keys(filters || {}).sort();
  const f = keys.map((k) => `${k}=${str(filters[k])}`).join('&');
  return `${str(campaignId)}:v${str(campaignVersion)}|${f}|${ids.join(',')}`;
}

/** dry-run の結果が古くなっていないか（**確認した母集団と今の母集団が同じか**） */
export function isDryRunStale({ dryRun, current } = {}) {
  if (!dryRun || !dryRun.fingerprint) return true;
  return dryRun.fingerprint !== computeSelectionFingerprint(current || {});
}

/** いまどのステップにいるか（画面の現在地表示に使う） */
export function resolveStep(state = {}) {
  const s = normalize(state);
  if (s.dispatch.sent) return STEP.RESULT;
  if (s.enqueued) return STEP.SEND;
  if (s.dryRunOk && !s.stale) return STEP.SEND;
  if (s.campaignId) return STEP.DRY_RUN;
  if (s.selectedCount > 0) return STEP.CAMPAIGN;
  if (s.loadedCount > 0) return STEP.SELECT;
  return STEP.FILTER;
}

function normalize(state) {
  const selectedIds = state.selectedIds || [];
  const dryRun = state.dryRun || null;
  const stale = dryRun ? isDryRunStale({ dryRun, current: state }) : true;
  return {
    selectedIds,
    selectedCount: selectedIds.length,
    loadedCount: Number(state.loadedCount) || 0,
    campaignId: str(state.campaignId),
    campaign: state.campaign || null,
    dryRun,
    dryRunOk: !!dryRun,
    stale,
    willSend: dryRun ? Number(dryRun.willSend) || 0 : 0,
    enqueued: !!state.enqueued,
    dispatch: state.dispatch || {},
    busy: !!state.busy,
    sendEnabled: state.sendEnabled === true,
    dispatchEnabled: state.dispatchEnabled === true,
  };
}

const ok = () => ({ allowed: true, reason: null });
const no = (reason) => ({ allowed: false, reason });

/** Step 4: dry-run を実行できるか */
export function canDryRun(state = {}) {
  const s = normalize(state);
  if (s.busy) return no(BLOCK.BUSY);
  if (s.selectedCount === 0) return no(BLOCK.NO_SELECTION);
  if (!s.campaignId) return no(BLOCK.NO_CAMPAIGN);
  return ok();
}

/** Step 5-a: キュー登録できるか（**確認済み・最新**でなければ不可） */
export function canEnqueue(state = {}) {
  const s = normalize(state);
  if (s.busy) return no(BLOCK.BUSY);
  if (!s.sendEnabled) return no(BLOCK.GATE_ENQUEUE_CLOSED);
  if (s.selectedCount === 0) return no(BLOCK.NO_SELECTION);
  if (!s.campaignId) return no(BLOCK.NO_CAMPAIGN);
  if (!s.dryRunOk) return no(BLOCK.NO_DRY_RUN);
  if (s.stale) return no(BLOCK.DRY_RUN_STALE);
  if (s.willSend === 0) return no(BLOCK.NO_RECIPIENTS);
  return ok();
}

/** Step 5-b: 送信直前の確認（dispatcher dryRun:true）を実行できるか */
export function canDispatchCheck(state = {}) {
  const s = normalize(state);
  if (s.busy) return no(BLOCK.BUSY);
  if (!s.enqueued) return no(BLOCK.NOT_ENQUEUED);
  return ok();
}

/**
 * Step 5-c: **実際に送る**（dispatcher dryRun:false）を実行できるか。
 * 直前の確認で送信対象が 1 通以上あることまで確かめてからでないと押せない。
 */
export function canDispatchSend(state = {}) {
  const s = normalize(state);
  if (s.busy) return no(BLOCK.BUSY);
  if (!s.dispatchEnabled) return no(BLOCK.GATE_DISPATCH_CLOSED);
  if (!s.enqueued) return no(BLOCK.NOT_ENQUEUED);
  const check = s.dispatch.check;
  if (!check) return no(BLOCK.NO_DISPATCH_CHECK);
  if ((Number(check.willSend) || 0) === 0) return no(BLOCK.NO_RECIPIENTS);
  return ok();
}

/**
 * キャンペーンを「通常運用」と「運用テスト専用」に分ける。
 * テスト用を通常一覧の先頭に出すと、**運用中に誤って選ぶ**。
 */
export function groupCampaigns(campaigns = []) {
  const normal = [];
  const testOnly = [];
  for (const c of campaigns || []) {
    if (!c) continue;
    (c.testOnly === true ? testOnly : normal).push(c);
  }
  return { normal, testOnly };
}

/** 最終確認モーダルに出す内容（**画面はこの形をそのまま表示する**） */
export function buildSendConfirmation({ campaign, dryRun, dispatchCheck, sendEnabled, dispatchEnabled, operationId } = {}) {
  const c = campaign || {};
  const d = dryRun || {};
  const chk = dispatchCheck || {};
  return {
    campaignName: str(c.name) || str(c.campaignId),
    campaignId: str(c.campaignId),
    version: str(c.version),
    testOnly: c.testOnly === true,
    audience: c.testOnly === true ? 'テスト受信者のみ（運用テスト専用）' : '一般顧客',
    selected: Number(d.selected) || 0,
    excluded: Number(d.excluded) || 0,
    willSend: Number(chk.willSend ?? d.willSend) || 0,
    gate: { enqueue: sendEnabled === true, dispatch: dispatchEnabled === true },
    operationId: str(operationId),
    /** 取消できる段階と、できなくなる境目を明示する */
    cancelable: 'キュー登録の後・実配信の前（PENDING）まで',
    afterSend: '送信後は取り消せません（メールは取り消せません）',
    duplicateGuard: '同一キャンペーン×version×宛先は DeliveryKey で 1 通に固定（再実行しても増えません）',
    effect: '実際にメールが届きます。配信基盤が受理した時点で「送信済み」になり、実配信（delivered）は台帳で確認します。',
  };
}

/** 送信状況のバッジ（状態を一目で分ける） */
export const JOB_BADGE = Object.freeze({
  PENDING: { label: '送信待ち', tone: 'warn' },
  SENDING: { label: '送信中', tone: 'info' },
  SENT: { label: '送信済み', tone: 'ok' },
  PARTIAL: { label: '一部失敗', tone: 'warn' },
  FAILED: { label: '失敗', tone: 'ng' },
  CANCELLED: { label: '取消済み', tone: 'muted' },
});

/**
 * ジョブの表示状態。**部分失敗を「成功」と読ませない**。
 * `counts` は配信行（1 通ごとの正本）由来。
 */
export function resolveJobBadge({ status, counts } = {}) {
  const s = str(status).toUpperCase();
  const c = counts || {};
  const failed = Number(c.failed) || 0;
  const sent = Number(c.sent) || 0;
  if (s === 'SENT' && failed > 0 && sent > 0) return { key: 'PARTIAL', ...JOB_BADGE.PARTIAL };
  if (JOB_BADGE[s]) return { key: s, ...JOB_BADGE[s] };
  return { key: 'PENDING', ...JOB_BADGE.PENDING };
}

/** 適用中フィルターの数と内訳（「今どれだけ絞っているか」を見せる） */
export function summarizeFilters(filters = {}, defaults = {}) {
  const applied = [];
  for (const [k, v] of Object.entries(filters || {})) {
    const value = str(v);
    const base = str(defaults[k] ?? 'all');
    if (value && value !== base) applied.push({ key: k, value });
  }
  return { count: applied.length, applied };
}

/** 除外理由の集計（**失敗理由と混同しない**ためラベルを分ける） */
export function summarizeExclusions(excludedDetail = []) {
  const rows = Array.isArray(excludedDetail) ? excludedDetail : Object.entries(excludedDetail || {}).map(([reason, count]) => ({ reason, count }));
  const out = [];
  for (const r of rows) {
    const reason = str(r.reason || r.key);
    const count = Number(r.count) || 0;
    if (!reason || count === 0) continue;
    out.push({ reason, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

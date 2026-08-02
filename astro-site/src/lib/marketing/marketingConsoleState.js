/**
 * marketingConsoleState.js — 管理画面の状態遷移（純粋・DOM 非依存）
 *
 * ── なぜ切り出すか ────────────────────────────────────────────
 * 2026-08-02、**「送信対象を確認（dry-run）」が押せない**不具合が本番で起きた。
 * 原因は「キャンペーンを選択欄へ**プログラムから**入れたのに、画面の状態へ反映していなかった」こと。
 * `change` イベントは自動選択では発火しないため、状態は空のままで、
 * 可否判定が「キャンペーン未選択」と判断してボタンを無効化し続けていた。
 *
 * 画面のイベント配線に判定を埋め込むと、この種の抜けは**実行しないと分からない**。
 * そこで状態遷移をここに集約し、DOM なしで検証できるようにする。
 *
 * ── 原則 ────────────────────────────────────────────────
 * - 状態を変える関数は**新しい状態を返す**（画面側は差し替えるだけ）
 * - 「押せる／押せない」と「画面に出す文言」は状態から**必ず**決まる
 * - 押しても何も起きない、を作らない（どの結果でも表示すべき文言を返す）
 */

/** dry-run の進行状態 */
export const DRY_STATE = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  OK: 'ok',
  EMPTY: 'empty',
  ERROR: 'error',
  STALE: 'stale',
});

/** 一覧の表示件数の選択肢 */
export const PAGE_SIZES = Object.freeze([25, 50, 100]);

const str = (v) => String(v ?? '').trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/** 初期状態 */
export function initialState() {
  return {
    campaigns: [],
    campaignId: '',
    campaign: null,
    rows: [],
    selectedIds: [],
    filters: {},
    page: 1,
    pageSize: PAGE_SIZES[0],
    view: 'all',            // all | selected | sendable
    dry: { state: DRY_STATE.IDLE, message: '未確認', result: null, fingerprint: '' },
    enqueued: false,
    busy: false,
    sendEnabled: false,
    dispatchEnabled: false,
  };
}

/**
 * キャンペーン一覧を受け取る。
 * **選択欄へ自動で入れる値を状態にも必ず入れる**（今回の不具合の再発防止）。
 */
export function applyCampaigns(state, { campaigns = [], sendEnabled = false, dispatchEnabled = false } = {}) {
  const list = arr(campaigns);
  const firstUsable = list.find((c) => c && c.usable !== false) || null;
  return {
    ...state,
    campaigns: list,
    campaignId: firstUsable ? str(firstUsable.campaignId) : '',
    campaign: firstUsable,
    sendEnabled: sendEnabled === true,
    dispatchEnabled: dispatchEnabled === true,
    dry: invalidate(state.dry, 'キャンペーン一覧を読み込みました。'),
  };
}

/** キャンペーンを選び直す（画面の change でも、プログラム選択でも同じ経路を通す） */
export function selectCampaign(state, campaignId) {
  const id = str(campaignId);
  const campaign = state.campaigns.find((c) => str(c.campaignId) === id) || null;
  if (id === state.campaignId) return state;
  return {
    ...state,
    campaignId: id,
    campaign,
    dry: invalidate(state.dry, 'キャンペーンが変わりました。'),
  };
}

/** 顧客一覧を受け取る（取得のたびに選択とページを初期化する） */
export function applyCustomers(state, { rows = [], filters = null } = {}) {
  return {
    ...state,
    rows: arr(rows),
    selectedIds: [],
    page: 1,
    filters: filters || state.filters,
    dry: invalidate(state.dry, '顧客一覧を取得し直しました。'),
  };
}

/** 選択の更新 */
export function applySelection(state, selectedIds) {
  const ids = arr(selectedIds).map(str).filter(Boolean);
  const same = ids.length === state.selectedIds.length
    && [...ids].sort().join(',') === [...state.selectedIds].sort().join(',');
  if (same) return state;
  return { ...state, selectedIds: ids, dry: invalidate(state.dry, '選択した顧客が変わりました。') };
}

/** 絞り込み条件の更新 */
export function applyFilters(state, filters) {
  return { ...state, filters: filters || {}, dry: invalidate(state.dry, '絞り込み条件が変わりました。') };
}

/** ページ・表示件数・表示種別の変更（**選択集合の見え方が変わるので確認結果は失効**） */
export function applyPaging(state, { page, pageSize, view } = {}) {
  const next = {
    ...state,
    page: Number.isFinite(Number(page)) && Number(page) > 0 ? Number(page) : state.page,
    pageSize: PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : state.pageSize,
    view: ['all', 'selected', 'sendable'].includes(view) ? view : state.view,
  };
  if (next.page === state.page && next.pageSize === state.pageSize && next.view === state.view) return state;
  return { ...next, dry: invalidate(state.dry, '一覧の表示が変わりました。') };
}

function invalidate(dry, why) {
  if (!dry || dry.state === DRY_STATE.IDLE) return { state: DRY_STATE.IDLE, message: '未確認', result: null, fingerprint: '' };
  return { state: DRY_STATE.STALE, message: '確認結果は無効です（' + why + '）もう一度 dry-run してください。', result: null, fingerprint: '' };
}

/** dry-run 開始（**押した瞬間に必ず表示が変わる**） */
export function startDryRun(state) {
  return { ...state, busy: true, dry: { state: DRY_STATE.LOADING, message: '確認中…', result: null, fingerprint: '' } };
}

/** dry-run 成功（0 名も「成功だが対象なし」として扱い、無反応にしない） */
export function dryRunSucceeded(state, plan, fingerprint) {
  const willSend = Number(plan && plan.willSend) || 0;
  const excluded = Number(plan && plan.excluded) || 0;
  const selected = Number(plan && plan.selected) || 0;
  const empty = willSend === 0;
  return {
    ...state,
    busy: false,
    dry: {
      state: empty ? DRY_STATE.EMPTY : DRY_STATE.OK,
      message: empty
        ? '対象者がいません（選択 ' + selected + ' 名 / 除外 ' + excluded + ' 名）。除外理由を確認してください。'
        : '対象 ' + willSend + ' 名 / 除外 ' + excluded + ' 名',
      result: { selected, excluded, willSend, excludedDetail: (plan && plan.excludedDetail) || [], planFingerprint: str(plan && plan.planFingerprint) },
      fingerprint: str(fingerprint),
    },
  };
}

/** dry-run 失敗（**必ず原因と次の操作を返す**。無反応を作らない） */
export function dryRunFailed(state, error) {
  const status = Number(error && error.status) || 0;
  const map = {
    400: { why: '送信対象またはキャンペーンの指定が不正です。', next: '顧客を選び直して、もう一度確認してください。' },
    403: { why: '管理シークレットが違うか、権限がありません。', next: '画面上部の管理シークレットを入れ直してください。' },
    409: { why: '対象が変わったため確認できません。', next: '顧客一覧を取得し直してから確認してください。' },
    500: { why: 'サーバー側でエラーが起きました。', next: '少し待ってからもう一度確認してください。続く場合はログを確認してください。' },
  };
  const known = map[status];
  const why = known ? known.why : (status ? 'HTTP ' + status + ' が返りました。' : '通信できませんでした（ネットワークまたは接続先の問題）。');
  const next = known ? known.next : 'ネットワークを確認して、もう一度確認してください。';
  return {
    ...state,
    busy: false,
    dry: { state: DRY_STATE.ERROR, message: '確認に失敗しました: ' + why + ' ' + next, result: null, fingerprint: '' },
  };
}

/** dry-run の結果が使える状態か */
export function hasUsableDryRun(state) {
  return !!state && state.dry && state.dry.state === DRY_STATE.OK && !!state.dry.result;
}

/**
 * 画面のボタン状態。**ここが唯一の根拠**で、画面はそのまま反映する。
 */
export function buttonState(state) {
  const s = state || initialState();
  const selected = s.selectedIds.length;
  const dryDisabled = s.busy || selected === 0 || !s.campaignId;
  return {
    dryRun: {
      disabled: dryDisabled,
      reason: s.busy ? '実行中です' : selected === 0 ? '顧客を 1 名以上選択してください'
        : !s.campaignId ? 'キャンペーンを選択してください' : '',
    },
    enqueue: {
      disabled: s.busy || !hasUsableDryRun(state) || !s.sendEnabled,
      reason: !s.sendEnabled ? 'キュー登録が無効です（MARKETING_CAMPAIGN_ENABLED 未設定）'
        : !hasUsableDryRun(state) ? '先に dry-run で対象を確認してください' : '',
    },
  };
}

/** 一覧の表示（ページング + 表示種別）。**現在ページの範囲も返す** */
export function paginate(state) {
  const s = state || initialState();
  const selected = new Set(s.selectedIds);
  const filtered = s.rows.filter((r) => {
    if (s.view === 'selected') return selected.has(str(r.recordId));
    if (s.view === 'sendable') return r.sendable === true;
    return true;
  });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / s.pageSize));
  const page = Math.min(Math.max(1, s.page), pages);
  const from = total === 0 ? 0 : (page - 1) * s.pageSize + 1;
  const to = Math.min(page * s.pageSize, total);
  return {
    rows: filtered.slice((page - 1) * s.pageSize, page * s.pageSize),
    page, pages, total, from, to,
    label: total === 0 ? '0 件' : total + ' 件中 ' + from + '〜' + to + ' 件',
  };
}

/** 取得結果の要約（該当 / 送信可能 / 送信不可 / 選択） */
export function summarizeRows(state) {
  const s = state || initialState();
  const sendable = s.rows.filter((r) => r.sendable === true).length;
  return {
    total: s.rows.length,
    sendable,
    unsendable: s.rows.length - sendable,
    selected: s.selectedIds.length,
    label: '該当 ' + s.rows.length + ' 名（送信可能 ' + sendable + ' 名 / 送信不可 '
      + (s.rows.length - sendable) + ' 名）　選択 ' + s.selectedIds.length + ' 名',
  };
}

/** 「表示中を全選択」は**現在ページの送信可能な行だけ**を対象にする */
export function selectVisible(state) {
  const view = paginate(state);
  const ids = view.rows.filter((r) => r.sendable === true).map((r) => str(r.recordId));
  const merged = [...new Set([...state.selectedIds, ...ids])];
  return applySelection(state, merged);
}

/** 一覧に出すメールアドレスの表示（**既定は部分マスク**。完全表示は詳細でのみ） */
export function maskEmail(email) {
  const e = str(email);
  const at = e.indexOf('@');
  if (at <= 0) return e ? '***' : '';
  const name = e.slice(0, at);
  const domain = e.slice(at + 1);
  const head = name.slice(0, Math.min(2, name.length));
  return head + '***@' + domain;
}

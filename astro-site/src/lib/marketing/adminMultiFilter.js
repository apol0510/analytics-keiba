/**
 * adminMultiFilter.js — 管理画面の**複数選択フィルター**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * これまでの絞り込みは「すべて」か「1 項目」しか選べず、
 * 「期限切れ＋退会済み＋休眠」「Premium＋Light」のような**実際に使う条件**が作れなかった。
 * 運用者は仕方なく条件を分けて何度も取得し、そのたびに選択と確認をやり直していた。
 *
 * ── 条件の意味（画面にも明示する）──────────────────────────
 * - **同じ項目の中は OR**（プラン: Premium **または** Light）
 * - **異なる項目の間は AND**（対象区分が該当し、**かつ** プランも該当）
 * - **未選択（空配列）は「条件なし」**＝その項目では絞らない
 *
 * 「すべて」というチェック項目は作らない。0 件選択が「指定なし」を意味する。
 */

const str = (v) => String(v ?? '').trim();

/** 1 項目に指定できる値の上限（暴発防止） */
export const MAX_SELECTION = 20;

/** 同項目 OR / 項目間 AND を画面へ出す文言 */
export const FILTER_LOGIC_NOTE =
  '同じ項目内は「いずれか」、異なる項目間は「すべて一致」で検索します。';

/**
 * 旧形式（単一文字列）との互換を保ちながら配列へ正規化する。
 *
 * - `undefined` / `''` / `'all'` → `[]`（条件なし）
 * - `'expired'` → `['expired']`（旧 API 呼び出しをそのまま受ける）
 * - `['a','a',' b ']` → `['a','b']`（重複と空白を落とす）
 */
export function normalizeSelection(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of raw) {
    const s = str(v);
    if (!s || s === 'all') continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 許可値だけを通す。**未知の値は無視せずエラーにする**
 * （こちらの想定外の条件で顧客を抽出させない）。
 */
export function validateSelection(value, allowed = [], { max = MAX_SELECTION, key = 'filter' } = {}) {
  const values = normalizeSelection(value);
  if (values.length > max) {
    return { ok: false, error: `${key}: 指定できるのは ${max} 件までです（${values.length} 件）` };
  }
  const allow = new Set(allowed.map(str));
  const bad = values.filter((v) => !allow.has(v));
  if (bad.length) return { ok: false, error: `${key}: 未知の値が含まれています` };
  return { ok: true, values };
}

/** 同じ項目内は OR。未選択なら「条件なし」で必ず true */
export function matchesAny(value, selection) {
  const sel = normalizeSelection(selection);
  if (sel.length === 0) return true;
  return sel.includes(str(value));
}

/** 複数項目を AND で判定する。`spec` は { key: { value, selection } } */
export function matchesAll(spec = {}) {
  for (const entry of Object.values(spec)) {
    if (!entry) continue;
    if (!matchesAny(entry.value, entry.selection)) return false;
  }
  return true;
}

/** 適用中の条件数（項目ではなく**選んだ値**の数を数える） */
export function countApplied(selections = {}) {
  let n = 0;
  for (const v of Object.values(selections)) n += normalizeSelection(v).length;
  return n;
}

/** 選択中の値をチップにする（1 件ずつ外せるようにするため） */
export function buildChips(selections = {}, labels = {}) {
  const chips = [];
  for (const [key, value] of Object.entries(selections)) {
    for (const v of normalizeSelection(value)) {
      chips.push({ key, value: v, label: (labels[key] && labels[key][v]) || v });
    }
  }
  return chips;
}

/** チップの × で 1 条件だけ外す */
export function removeChip(selections = {}, key, value) {
  const next = { ...selections };
  next[key] = normalizeSelection(next[key]).filter((v) => v !== str(value));
  return next;
}

/** 条件を自然文で要約する（何を検索するのかを読ませる） */
export function describeConditions(selections = {}, labels = {}, order = []) {
  const keys = order.length ? order : Object.keys(selections);
  const parts = [];
  for (const key of keys) {
    const values = normalizeSelection(selections[key]);
    if (values.length === 0) continue;
    const names = values.map((v) => (labels[key] && labels[key][v]) || v);
    parts.push(names.join('・'));
  }
  if (parts.length === 0) return '条件を指定していません（すべての顧客が対象になります）。';
  return parts.join('で、') + 'の顧客を検索します。';
}

/** 全項目が選ばれているときは「全〜」と短く言う */
export function summarizeSelection(values, allowed = [], allLabel = 'すべて') {
  const sel = normalizeSelection(values);
  if (sel.length === 0) return '指定なし';
  if (allowed.length && sel.length === allowed.length) return allLabel;
  return `${sel.length}件選択`;
}

/* ══════════════════════════════════════════════════════════════
   カムバック特典の対象区分（現有効会員は**通常候補に混ぜない**）
   ══════════════════════════════════════════════════════════════ */

/** 通常候補として選べる区分 */
export const CB_SEGMENT_VALUES = Object.freeze(['expired', 'withdrawn', 'dormant', 'none', 'unknown']);

export const CB_SEGMENT_LABELS = Object.freeze({
  expired: '期限切れ',
  withdrawn: '退会・課金停止',
  dormant: '休眠・長期未ログイン',
  none: '無料会員・契約なし',
  unknown: '状態不明',
});

/** 初期状態（期限切れ・退会済み・休眠が ON） */
export const CB_SEGMENT_DEFAULT = Object.freeze(['expired', 'withdrawn', 'dormant']);

/**
 * プリセット。「カムバック候補すべて」は**単独の選択肢ではなく**、
 * 安全な候補を一括で ON にするボタンとして持つ。
 */
export const CB_SEGMENT_PRESETS = Object.freeze({
  standard: { label: '標準候補', values: ['expired', 'withdrawn', 'dormant'] },
  expired: { label: '期限切れ中心', values: ['expired'] },
  withdrawn: { label: '退会・課金停止 中心', values: ['withdrawn'] },
  dormant: { label: '休眠中心', values: ['dormant'] },
  all: { label: '全候補', values: [...CB_SEGMENT_VALUES] },
  clear: { label: 'クリア', values: [] },
});

/** 現有効会員は**この一覧に含めない**（別枠の危険設定で扱う） */
export function isActiveMemberIncluded(selection) {
  return normalizeSelection(selection).includes('active');
}

/** プランの選択肢（「すべて」は作らない。0 件＝指定なし） */
export const PLAN_VALUES = Object.freeze(['premium_sanrenpuku', 'premium', 'light', 'free', 'unknown']);
export const PLAN_LABELS = Object.freeze({
  premium_sanrenpuku: 'Premium Sanrenpuku',
  premium: 'Premium',
  light: 'Light',
  free: 'Free',
  unknown: 'プラン不明',
});

/**
 * 条件が変わったかどうか（変わったら一覧とデータの確認結果を失効させる）。
 * 値の並び順の違いは「変わった」と見なさない。
 */
export function selectionsChanged(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const x = normalizeSelection(a[k]).slice().sort().join(',');
    const y = normalizeSelection(b[k]).slice().sort().join(',');
    if (x !== y) return true;
  }
  return false;
}

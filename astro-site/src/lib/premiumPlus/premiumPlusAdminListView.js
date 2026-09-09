/**
 * premiumPlusAdminListView.js
 *   管理画面**一覧**の「主状態」「次の操作」「運営サマリー」の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-09 MK 指摘）
 *
 * > 「即時販売」「販売可」「購入可能」「販売中」が混在しており意味が分かれすぎています
 * > odamoto のように現在購入可能な会員が「購入可能な会員を探す操作」で漏れないこと
 *
 * 旧一覧の分類は**内部の軸をそのまま並べていた**。
 *   - `即時販売` … override を当てたかどうか（**操作の名前**であって状態ではない）
 *   - `販売可`   … 資格が eligible（＝**まだ買えない**段階公開中も含む）
 *   - `販売中`   … PHASE 4（**停止中でも同じ表示になっていた**）
 * その結果、「いま買える会員」を探す入口が無く、override 無しで PHASE 4 に達した会員
 * （odamoto）が「即時販売」で拾えなかった。停止中の会員も「販売中」と出ていた。
 *
 * ## 主状態は 4 つだけ（運営者が理解できる言葉）
 *
 * | key | 表示 | 意味 |
 * |---|---|---|
 * | `sale`   | 購入可能 | **いま買える**（override でも段階公開でも同じ扱い）|
 * | `staged` | 段階表示中 | 資格はあるが、まだ買えない |
 * | `paused` | 販売停止中 | その会員だけ止めている |
 * | `out`    | 対象外 | 販売対象外 / 資格保留 |
 *
 * ⚠️ **`purchaseEnabled`（サーバーが解決した値）だけで「購入可能」を決める。**
 *    override / PHASE を見て分岐すると、また片方が漏れる。
 * ⚠️ 停止は最優先。停止中を「購入可能」や「段階表示中」に混ぜない。
 * ⚠️ `即時販売` / `override` / `PHASE` は**主表示・主フィルタに出さない**
 *    （2026-09-09 確定仕様。詳細パネルの折りたたみ内でのみ確認する）。
 */

/** 主状態（この 4 つだけ。増やすときは仕様と表示とフィルタを必ず同時に直す） */
export const LIST_STATE = Object.freeze({
  SALE: 'sale',
  STAGED: 'staged',
  PAUSED: 'paused',
  OUT: 'out',
});

/** 主状態の表示名（画面で組み立てない） */
export const LIST_STATE_LABEL = Object.freeze({
  sale: '購入可能',
  staged: '段階表示中',
  paused: '販売停止中',
  out: '対象外',
});

/** 主状態の色（badge / 行の枠に使う） */
export const LIST_STATE_TONE = Object.freeze({
  sale: 'ok',
  staged: 'warn',
  paused: 'stop',
  out: 'muted',
});

/** 一覧に出す順番（運営が見たい順。購入可能 → 停止 → 段階 → 対象外） */
export const LIST_STATE_ORDER = Object.freeze(['sale', 'paused', 'staged', 'out']);

/**
 * 会員 1 件の主状態を 4 分類に決める。
 * @param {object} row `rows[]` の 1 件
 * @returns {string} LIST_STATE の値
 */
export function classifyListState(row) {
  const r = row || {};
  // 停止は最優先（停止中を「購入可能」「段階表示中」に混ぜない）
  if (r.salePaused === true) return LIST_STATE.PAUSED;
  if (r.eligibility === 'blocked') return LIST_STATE.OUT;
  if (r.eligibility !== 'eligible') return LIST_STATE.OUT;
  // ⚠️ ここが本件の要点。**サーバーが解決した購入可否だけ**を見る。
  //    override / PHASE で分岐しないので、どちらの経路でも漏れない。
  if (r.purchaseEnabled === true) return LIST_STATE.SALE;
  return LIST_STATE.STAGED;
}

/** 主状態のラベル */
export const listStateLabel = (row) => LIST_STATE_LABEL[classifyListState(row)];
/** 主状態の色 */
export const listStateTone = (row) => LIST_STATE_TONE[classifyListState(row)];

/**
 * 上部の運営サマリー（「購入可能 5 名 / 停止 0 名 / 段階表示 13 名」）。
 * @param {object[]} rows
 * @returns {{ counts: Record<string, number>, total: number,
 *             items: Array<{key:string,label:string,count:number,tone:string}> }}
 */
export function summarizeListStates(rows) {
  const counts = { sale: 0, paused: 0, staged: 0, out: 0 };
  for (const r of Array.isArray(rows) ? rows : []) counts[classifyListState(r)] += 1;
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    items: LIST_STATE_ORDER.map((k) => ({
      key: k, label: LIST_STATE_LABEL[k], count: counts[k], tone: LIST_STATE_TONE[k],
    })),
  };
}

/** 状態フィルタの選択肢（`all` + 4 分類。内部用語を出さない） */
export function listStateFilterOptions() {
  return [{ value: 'all', label: 'すべての状態' }]
    .concat(LIST_STATE_ORDER.map((k) => ({ value: k, label: LIST_STATE_LABEL[k] })));
}

/** 状態フィルタに合致するか */
export function matchesListState(row, filter) {
  const f = String(filter || 'all');
  return f === 'all' ? true : classifyListState(row) === f;
}

/**
 * メールアドレス**完全一致**で 1 件だけ見つかったか。
 *
 * ⚠️ 一致したら一覧から探させない（そのまま詳細・操作パネルへ入れる）。
 *    2 件以上・0 件なら null（勝手に 1 件へ飛ばさない）。
 */
export function findExactEmailMatch(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !q.includes('@')) return null;
  const hit = (Array.isArray(rows) ? rows : [])
    .filter((r) => String(r.email || '').trim().toLowerCase() === q);
  return hit.length === 1 ? hit[0] : null;
}

/**
 * **異常・矛盾がある会員だけ**警告を返す。正常な会員に注意文を並べない。
 * @returns {string[]} 空配列 = 正常
 */
export function describeAttention(row) {
  const r = row || {};
  const out = [];
  const lc = r.reopenLaunch || null;
  if (lc && lc.state === 'incomplete') out.push('クーポン期間の開始が途中で止まっています（復旧が必要）');
  if (lc && lc.state === 'unknown') out.push('クーポン期間の状態を確認できません');
  if (r.reopenCouponClaimed === true && r.reopenCouponWritable === false) {
    out.push('クーポンを保有していますが、いま操作を受け付けられません');
  }
  // 停止中なのに購入できると解決されている＝判定のズレ（起きてはいけない）
  if (r.salePaused === true && r.purchaseEnabled === true) {
    out.push('停止中なのに購入可能と解決されています（要調査）');
  }
  return out;
}

/**
 * 「最後に何をしたか / いつ変わったか」を 1 行で。
 * @returns {{ label: string, at: string, by: string } | null}
 */
export function describeLastChange(row) {
  const r = row || {};
  const cands = [
    { label: '販売の停止/再開', at: r.salePausedAt, by: r.salePausedBy },
    { label: 'クーポン取得', at: r.reopenCouponClaimedAt, by: '' },
    { label: '販売資格の変更', at: r.updatedAt, by: r.updatedBy },
  ].filter((c) => Date.parse(String(c.at || '')) > 0);
  if (!cands.length) return null;
  cands.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { label: cands[0].label, at: cands[0].at, by: cands[0].by || '' };
}

/**
 * 一覧の 1 行に出す「次にできる操作」（**1〜2 個まで**）。
 *
 * ⚠️ ボタン名だけで**次に起こる結果**が分かるようにする
 *    （販売中なら「販売を停止」、停止中なら「販売を再開」）。
 * ⚠️ それ以外の操作は詳細パネルへ（一覧に全部並べない）。
 *
 * @param {object} row
 * @param {{ salePauseWritable?: boolean }} caps
 */
export function describeRowActions(row, caps = {}) {
  const r = row || {};
  const paused = r.salePaused === true;
  const writable = caps.salePauseWritable === true && r.salePauseWritable !== false;
  return [{
    key: 'salePauseToggle',
    // 押すと起こる結果をそのまま名前にする
    label: paused ? '販売を再開' : '販売を停止',
    hint: paused ? 'この会員だけ再開します' : 'この会員だけ止めます',
    tone: paused ? 'ok' : 'stop',
    /** 危険な操作か（確認ダイアログを出すのはこれだけ） */
    danger: !paused,
    enabled: writable,
    reason: writable ? '' : '本番でまだ有効化されていないため実行できません',
  }];
}

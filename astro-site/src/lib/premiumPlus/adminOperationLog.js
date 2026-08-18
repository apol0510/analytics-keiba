/**
 * adminOperationLog.js — 管理画面の**操作履歴**（純粋・保存先は注入）
 *
 * ## なぜ要るか
 *
 * Airtable の Customers に残るのは **最後の 1 回だけ**
 * （`PremiumPlusEligibilityUpdatedAt` / `UpdatedBy` / `Reason`）。
 * 「さっき何をしたか」「保留に戻したのはどの操作だったか」を後から追えない。
 * 特に**失敗したのか成功したのか分からない操作**が残らないのが困る。
 *
 * 恒久台帳（履歴テーブル）は Airtable のスキーマ変更が要るので別作業。
 * ここでは **このタブの中だけ**で操作を記録し、
 * 「いま自分が何をしたか」「どれが失敗したか」を必ず見られるようにする。
 *
 * ## 何を記録するか
 *
 * 操作の**前後**を必ず持つ（`from` → `to`）。結果は 3 値:
 *
 *   - `ok`      … サーバーが成功を返した
 *   - `failed`  … サーバーが失敗を返した（**書かれていない**）
 *   - `unknown` … 通信が途中で切れた（**書かれたかどうか分からない**）
 *
 * ⚠️ `unknown` を `failed` に丸めないこと。丸めると
 * 「失敗したと思って二重に操作する」事故になる。再読込で確認させる。
 *
 * ## 保存先
 *
 * `sessionStorage`（**タブを閉じれば消える**）。恒久保存ではないので、
 * これを監査記録として扱ってはいけない。正本は Airtable の最終更新。
 */

/** 保存キー（版を上げると古い履歴と混ざらない） */
export const OP_LOG_KEY = 'pp-admin-oplog-v1';

/** 保持する件数（古いものから捨てる） */
export const OP_LOG_MAX = 100;

/** 操作の結果 */
export const OP_RESULT = Object.freeze({
  OK: 'ok',
  FAILED: 'failed',
  /** 通信断など。**書けたか分からない**（失敗と言い切らない） */
  UNKNOWN: 'unknown',
});

export const OP_RESULT_LABEL = Object.freeze({
  ok: '成功',
  failed: '失敗（保存されていません）',
  unknown: '不明（保存されたか確認してください）',
});

/** 操作の種類 */
export const OP_KIND = Object.freeze({
  ELIGIBILITY: 'eligibility',
  UPSELL: 'upsell',
  /** 会員単位の「販売中 ⇔ 一時停止」。資格（ELIGIBILITY）とは別の軸なので別種別にする */
  SALE_PAUSE: 'salePause',
});

export const OP_KIND_LABEL = Object.freeze({
  eligibility: '販売資格',
  upsell: '販売CTA',
  salePause: '販売の一時停止',
});

const str = (v) => String(v ?? '').trim();

/** 1 件を正規化する。**結果が不正なものは記録しない**（嘘の履歴を作らない） */
export function normalizeEntry(raw) {
  const e = raw || {};
  const result = str(e.result);
  if (!Object.values(OP_RESULT).includes(result)) return null;
  if (!Object.values(OP_KIND).includes(str(e.kind))) return null;
  const at = Number(e.at);
  if (!Number.isFinite(at)) return null;
  return {
    at,
    kind: str(e.kind),
    result,
    actor: str(e.actor).slice(0, 32),
    recordId: str(e.recordId),
    email: str(e.email),
    /** 操作の前後。**片方でも欠けたら「何が変わったか」を書かない** */
    from: e.from === undefined || e.from === null ? null : str(e.from),
    to: e.to === undefined || e.to === null ? null : str(e.to),
    detail: str(e.detail).slice(0, 200),
  };
}

/**
 * 履歴の入れ物。**保存先は注入**（テストで sessionStorage を使わない）。
 *
 * @param {{storage?: {getItem:Function, setItem:Function}, max?: number}} io
 */
export function createOperationLog({ storage, max = OP_LOG_MAX } = {}) {
  const read = () => {
    if (!storage) return [];
    try {
      const raw = storage.getItem(OP_LOG_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.map(normalizeEntry).filter(Boolean) : [];
    } catch {
      return []; // 壊れていたら捨てる（壊れた履歴を見せない）
    }
  };
  const write = (list) => {
    if (!storage) return;
    try { storage.setItem(OP_LOG_KEY, JSON.stringify(list)); } catch { /* 容量超過は諦める */ }
  };

  return {
    /** 1 件足す。**新しい順**で返す */
    add(raw) {
      const entry = normalizeEntry(raw);
      if (!entry) return null;
      const next = [entry, ...read()].slice(0, max);
      write(next);
      return entry;
    },
    /** 全件（新しい順） */
    all() {
      return read().sort((a, b) => b.at - a.at);
    },
    /** その会員の分だけ（新しい順） */
    forRecord(recordId) {
      const id = str(recordId);
      if (!id) return [];
      return this.all().filter((e) => e.recordId === id);
    },
    /** **確認が必要な操作**（通信断で結果が分からなかったもの） */
    unresolved() {
      return this.all().filter((e) => e.result === OP_RESULT.UNKNOWN);
    },
    clear() { write([]); },
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** ミリ秒 → 'MM/DD HH:MM:SS'（JST） */
export function opTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * 1 件を日本語 1 行にする（画面はこの文字列をそのまま出す）。
 * **前後が分からないときは矢印を書かない**（変わっていないのに変わったように見せない）。
 */
export function describeEntry(e) {
  if (!e) return '';
  const who = e.actor || '(操作者名なし)';
  const what = OP_KIND_LABEL[e.kind] || e.kind;
  const change = e.from !== null && e.to !== null && e.from !== e.to
    ? `${e.from} → ${e.to}`
    : (e.to !== null ? String(e.to) : '(変更内容不明)');
  const result = OP_RESULT_LABEL[e.result] || e.result;
  return `${opTime(e.at)}  ${who}  ${what}: ${change}  — ${result}${e.detail ? `（${e.detail}）` : ''}`;
}

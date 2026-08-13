/**
 * customerEmailLookup.js — 「この**アドレスたち**は AK に居るか」を名指しで引く（純粋・I/O なし）
 *
 * ## なぜ向きを変えたか
 *
 * CSV 取り込みの重複突合は Customers を**全件**読んで、`MAX_PAGES=60`（先頭 6,000 件）で
 * 黙って打ち切っていた。Customers は 15,962 件なので、**約 10,000 人が「AK に居ない」
 * と判定される**。その状態で取り込むと、既存会員のレコードが二重に作られる
 * （＝同一アドレスが 2 件 → `auth/customerLookup` が CONFLICT で fail closed になり、
 * 本人がログインできなくなる）。下見の件数も丸ごと嘘になる。
 *
 * 直し方は「上限を上げる」ではない。Airtable は 1 ページ 100 件・**base あたり毎秒 5 リクエスト**
 * なので、15,962 件の走査は最短 32 秒。同期 Function の実行時間に入らない。
 *
 * **問いを逆向きにする**: 知りたいのは「AK の全員」ではなく
 * 「**CSV に載っているアドレスが AK に居るか**」だけ。
 * それなら CSV のアドレスを名指しで問い合わせればよく、コストは
 * **顧客数ではなく CSV の行数**に比例する。判定に必要な事実
 * （存在 / 重複 / 有料 / 配信停止 / 停止・テスト）は、すべて
 * **CSV に載っているアドレスの分だけ**あれば足りる（`buildAkFacts` の出力は
 * CSV 行との突き合わせにしか使われない）。
 *
 * ## 打ち切らない
 *
 * chunk を 1 つでも取り落としたら、その分の人が「AK に居ない」に化ける。
 * **途中で諦めるくらいなら例外**にする（少ない結果を正しい結果として返さない）。
 */

import { normalizeEmail } from './customerImport.js';

/**
 * 1 リクエストにまとめるアドレス数。
 * 1 件あたり式は約 45 文字なので、200 件で約 9KB。Airtable の式長に収まり、
 * 15,779 件でも 79 リクエスト（走査の 160 リクエストより少ない）。
 */
export const EMAIL_CHUNK = 200;

/**
 * chunk 数の上限。**超えたら打ち切らずに例外**（取り込み元が想定より桁違いに大きい）。
 * 200 chunk = 40,000 アドレスまで。
 */
export const MAX_EMAIL_CHUNKS = 200;

export class EmailLookupError extends Error {
  constructor(code, detail) {
    super(`customer_email_lookup:${code}`);
    this.name = 'EmailLookupError';
    this.code = code;
    this.detail = detail || null;
  }
}

/** Airtable の文字列リテラルへ安全に埋める */
export function escapeFormulaValue(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 正規化・重複除去したアドレス一覧（空は落とす） */
export function normalizeEmailList(emails) {
  const out = new Set();
  for (const e of emails || []) {
    const n = normalizeEmail(e);
    if (n) out.add(n);
  }
  return [...out];
}

/** アドレスを chunk へ割る。**上限を超えたら例外**（黙って切り捨てない） */
export function chunkEmails(emails, size = EMAIL_CHUNK) {
  const list = normalizeEmailList(emails);
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  if (chunks.length > MAX_EMAIL_CHUNKS) {
    throw new EmailLookupError('too_many_emails', { emails: list.length, chunks: chunks.length });
  }
  return chunks;
}

/**
 * 「このアドレスのどれかに一致する」formula。
 *
 * ⚠️ `{Email}` が空のレコードに当たらないよう `& ''` を付けて文字列化してから比較する。
 */
export function buildEmailLookupFormula(emails) {
  const list = normalizeEmailList(emails);
  if (list.length === 0) return null;
  const terms = list.map((e) => `LOWER(TRIM({Email} & '')) = '${escapeFormulaValue(e)}'`);
  return terms.length === 1 ? terms[0] : `OR(${terms.join(', ')})`;
}

/**
 * CSV のアドレスに一致する Customers を**すべて**引く。
 *
 * @param {{
 *   emails: Iterable<string>,
 *   fetchPage: (input: {formula: string, offset?: string}) => Promise<{records: object[], offset?: string}>,
 *   maxPagesPerChunk?: number,
 * }} input
 * @returns {Promise<{records: object[], chunks: number, requests: number}>}
 * @throws {EmailLookupError} 取り落としが起きるくらいなら投げる
 */
export async function lookupCustomersByEmails({ emails, fetchPage, maxPagesPerChunk = 20 }) {
  if (typeof fetchPage !== 'function') throw new EmailLookupError('fetch_page_required');
  const chunks = chunkEmails(emails);
  const records = [];
  let requests = 0;

  for (const chunk of chunks) {
    const formula = buildEmailLookupFormula(chunk);
    if (!formula) continue;
    let offset;
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
      const page = await fetchPage({ formula, offset });
      records.push(...((page && page.records) || []));
      offset = page && page.offset;
      pages += 1;
      requests += 1;
      // 同じアドレスが 2,000 件も重複することはない。ここに当たるのは異常
      if (offset && pages >= maxPagesPerChunk) {
        throw new EmailLookupError('chunk_page_limit', { pages, chunkSize: chunk.length });
      }
    } while (offset);
  }

  return { records, chunks: chunks.length, requests };
}

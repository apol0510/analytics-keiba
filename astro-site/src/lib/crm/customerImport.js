/**
 * customerImport.js — 外部保有リストを AK へ取り込む**前**の検査（純粋・I/O なし）
 *
 * ── 何のためのモジュールか ────────────────────────────────────
 * AK が持つ顧客（現在 1,464 件）とは別に、**外部で保有している約 13,000 件**の
 * 無料ユーザーリストがある。これを将来 AK へ取り込み、
 * `/admin/premium-plus-eligibility/` からキャンペーン対象として扱えるようにする。
 *
 * 取り込みは一度やると戻しにくい。だから**書き込む前に全部わかる**ようにする:
 *   何件が新規で、何件が既存の更新で、何件を除外し、何件が要確認か。
 *
 * ⚠️ このモジュールは**数えるだけ**。Airtable へ 1 バイトも書かない。
 *    実 CSV の取り込み・顧客レコード作成は**別承認**まで行わない。
 *
 * ── 個人情報を出さない ────────────────────────────────────────
 * 戻り値は**件数と分類だけ**。アドレス・氏名・行の中身を含めない。
 * 照合に使うアドレスは関数の中だけで扱い、外へは出さない。
 * ログにも出さない（この モジュールは console を一切使わない）。
 */

import { createHash } from 'node:crypto';

/** 取り込みに必須の列（これが無いファイルは受け付けない） */
export const REQUIRED_COLUMNS = Object.freeze(['email']);

/**
 * 使ってよい列と、AK 側の意味。**ここに無い列は取り込まない**
 * （知らない列を勝手に顧客レコードへ書かない）。
 */
export const KNOWN_COLUMNS = Object.freeze({
  email: 'メールアドレス（必須）',
  name: '氏名',
  registered_at: '登録日',
  source: '取得元（どの名簿か）',
  note: '備考',
});

/** 列名のゆらぎを吸収する（日本語ヘッダ・大文字・空白）*/
const COLUMN_ALIASES = Object.freeze({
  email: ['email', 'mail', 'mailaddress', 'mail_address', 'メールアドレス', 'メール', 'アドレス', 'eメール'],
  name: ['name', 'fullname', '氏名', '名前', 'お名前'],
  registered_at: ['registered_at', 'created_at', 'registerdate', '登録日', '登録日時', '作成日'],
  source: ['source', 'list', '取得元', '名簿', 'リスト名'],
  note: ['note', 'memo', '備考', 'メモ'],
});

/** 1 行の判定結果 */
export const ROW_VERDICT = Object.freeze({
  NEW: 'new',                 // AK に無い → 新規追加の候補
  UPDATE: 'update',           // AK にある → 更新の候補（既存の値は壊さない）
  EXCLUDE: 'exclude',         // 取り込まない
  REVIEW: 'review',           // 人が見て決める
});

/**
 * 判定の**正式名**（画面・API・監査ログで使う）。内部値（new/update/…）は
 * #229 から使っている短い綴りで、既存の呼び出しを壊さないために残す。
 * 外向きの表記はこちらに統一する。
 */
export const VERDICT_CANONICAL = Object.freeze({
  new: 'CREATE_CANDIDATE',
  update: 'UPDATE_CANDIDATE',
  exclude: 'EXCLUDED',
  review: 'REVIEW_REQUIRED',
});

/**
 * 除外・要確認の理由（固定コード）。
 *
 * ⚠️ **コードの綴りは変えない**。画面・監査ログ・突合に使うため、増やすことはあっても
 *    既存の値を書き換えない（過去の記録が読めなくなる）。
 */
export const IMPORT_REASON = Object.freeze({
  NO_EMAIL: 'no_email',
  INVALID_EMAIL: 'invalid_email',
  DUPLICATE_IN_FILE: 'duplicate_in_file',
  UNSUBSCRIBED: 'unsubscribed',
  /** hard/soft を区別できないとき用（後方互換）。区別できるなら下 2 つを使う */
  BLACKLISTED: 'blacklisted',
  HARD_BOUNCE: 'hard_bounce',
  SOFT_BOUNCE: 'soft_bounce',
  SPAM_REPORTED: 'spam_reported',
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  PAID_MEMBER: 'paid_member',
  DUPLICATE_IN_AK: 'duplicate_in_ak',
  ROLE_ADDRESS: 'role_address',
  ENCODING_BROKEN: 'encoding_broken',
  /** AK 側が意図的に止めた相手（suspended / banned / inactive） */
  SUSPENDED: 'suspended',
  /** テスト用アカウント（Status=test / プラン=test / 配信テスト受信者） */
  TEST_ACCOUNT: 'test_account',
  /** どの既存レコードに当てるか決められない（同一アドレスが複数など） */
  AMBIGUOUS_MATCH: 'ambiguous_match',
  /** 見出しと列数が合わない等、行として扱えない */
  UNSUPPORTED_ROW: 'unsupported_row',
});

export const IMPORT_REASON_LABEL = Object.freeze({
  no_email: 'メールアドレスが空',
  invalid_email: 'メールアドレスの形式が不正',
  duplicate_in_file: 'ファイル内で重複',
  unsubscribed: '配信停止済み（AK 側）',
  blacklisted: 'バウンス・苦情リストに該当',
  spam_reported: '迷惑メール報告あり',
  provider_suppressed: '配信基盤の停止リストに該当',
  paid_member: '現役の有料会員（無料リストとして取り込まない）',
  duplicate_in_ak: 'AK 側に同一アドレスの重複レコードがある',
  role_address: '共用・自動応答用のアドレス（info@ など）',
  encoding_broken: '文字化けの疑い',
  hard_bounce: '届かないアドレス（hard bounce）',
  soft_bounce: '一時的に届かなかったアドレス（soft bounce）',
  suspended: 'AK 側で停止したアカウント',
  test_account: 'テスト用アカウント',
  ambiguous_match: 'どの既存レコードに当てるか決められない',
  unsupported_row: '行として扱えない（列数が見出しと合わない等）',
});

/** 共用アドレスの接頭辞。個人ではないので無料リストに入れない */
const ROLE_LOCALPARTS = new Set([
  'info', 'support', 'contact', 'admin', 'sales', 'help', 'office',
  'noreply', 'no-reply', 'postmaster', 'webmaster', 'abuse',
]);

const str = (v) => String(v ?? '').trim();

// ── 文字コード ────────────────────────────────────────────────

/** UTF-8 BOM。付いたままだと最初の列名が読めない */
export const UTF8_BOM = '﻿';

export function stripBom(text) {
  const t = String(text ?? '');
  return t.startsWith(UTF8_BOM) ? t.slice(1) : t;
}

/**
 * 文字コードの問題を見つける（**直さない。気づかせる**）。
 *
 * 実ファイルの復号（Shift_JIS / CP932 → UTF-8）は取り込み層の仕事。
 * ここは復号後の文字列を見て、失敗の痕跡を検出する。
 *   - 置換文字 U+FFFD が入っている＝復号に失敗している
 *   - 「譁?蟄怜喧縺?」のような CP932→UTF-8 取り違えの並び
 */
export function detectEncodingIssues(text) {
  const t = String(text ?? '');
  const replacement = (t.match(/�/g) || []).length;
  // CP932 のバイト列を UTF-8 として読んだときに出やすい範囲
  const mojibake = (t.match(/[À-ÿ][-¿]{1,2}/g) || []).length;
  return {
    hasBom: String(text ?? '').startsWith(UTF8_BOM),
    replacementChars: replacement,
    suspectedMojibake: mojibake,
    ok: replacement === 0 && mojibake < 5,
    note: replacement > 0
      ? '復号に失敗しています。元ファイルの文字コード（Shift_JIS / CP932 など）を指定して読み直してください。'
      : (mojibake >= 5 ? '文字化けの疑いがあります。文字コードを確認してください。' : ''),
  };
}

// ── メールアドレスの正規化 ────────────────────────────────────

/**
 * 突合できる形へそろえる。**表記ゆれで「別人」にしないため**。
 *   - 前後の空白・引用符・`mailto:` を落とす
 *   - 全角英数・全角＠を半角へ（NFKC）
 *   - ゼロ幅文字を除去
 *   - 小文字化（AK 側の突合も小文字）
 *
 * ⚠️ Gmail の `+alias` やドットは**正規化しない**。別アドレスとして扱う人がいるため、
 *    こちらで同一視すると本人の意図と食い違う。
 */
export function normalizeEmail(raw) {
  let s = String(raw ?? '');
  s = s.replace(/[​-‍﻿]/g, '');
  s = s.normalize('NFKC').trim();
  s = s.replace(/^mailto:/i, '').replace(/^["'<]+|["'>]+$/g, '').trim();
  return s.toLowerCase();
}

/** 形として成立しているか（厳しすぎず、明らかな壊れだけを弾く） */
export function isValidEmail(email) {
  const e = str(email);
  if (!e || e.length > 254) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return false;
  if (/\.\./.test(e) || e.startsWith('.') || e.includes('@.')) return false;
  return true;
}

/** 共用アドレスか（個人宛でないもの） */
export function isRoleAddress(email) {
  const local = str(email).split('@')[0];
  return ROLE_LOCALPARTS.has(local);
}

// ── 列の対応づけ ──────────────────────────────────────────────

/**
 * CSV のヘッダ行 → AK の列名。**知らない列は捨てる**。
 * @param {string[]} header
 */
export function mapColumns(header) {
  const cols = Array.isArray(header) ? header : [];
  const mapped = {};
  const unknown = [];
  cols.forEach((raw, i) => {
    const key = normalizeHeader(raw);
    const hit = Object.entries(COLUMN_ALIASES)
      .find(([, aliases]) => aliases.includes(key));
    if (hit) {
      if (mapped[hit[0]] === undefined) mapped[hit[0]] = i;
    } else if (key) {
      unknown.push(raw);
    }
  });
  const missing = REQUIRED_COLUMNS.filter((c) => mapped[c] === undefined);
  return {
    ok: missing.length === 0,
    mapped,
    missing,
    unknown,
    error: missing.length ? `必須列が見つかりません: ${missing.join(', ')}` : null,
  };
}

function normalizeHeader(raw) {
  return String(raw ?? '')
    .replace(/[​-‍﻿]/g, '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
    .replace(/[（）()]/g, '');
}

// ── 取り込みの下見 ────────────────────────────────────────────

/**
 * 取り込み前の検査。**書き込みは一切しない。**
 *
 * @param {{
 *   rows: Array<Record<string, unknown>>,   // 復号・パース済みの行（email 列を含む）
 *   existingEmails?: Set<string>,           // AK に既にあるアドレス
 *   duplicateInAk?: Set<string>,            // AK 側で重複しているアドレス
 *   paidEmails?: Set<string>,               // 現役有料会員
 *   unsubscribedEmails?: Set<string>,
 *   blacklistEmails?: Set<string>,          // hard/soft を区別しない場合（後方互換）
 *   hardBounceEmails?: Set<string>,         // 区別できる場合はこちら
 *   softBounceEmails?: Set<string>,
 *   spamEmails?: Set<string>,
 *   testEmails?: Set<string>,               // テスト用アカウント・配信テスト受信者
 *   suspendedEmails?: Set<string>,          // AK 側が意図的に止めた相手
 *   ambiguousEmails?: Set<string>,          // 既存レコードを一意に決められない
 *   providerSuppressed?: Set<string>|null,  // null = 確認できない → fail closed
 *   batchId: string,
 *   nowMs?: number,
 * }} input
 */
export function buildImportPreview(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const existing = setOf(input.existingEmails);
  const dupAk = setOf(input.duplicateInAk);
  const paid = setOf(input.paidEmails);
  const unsub = setOf(input.unsubscribedEmails);
  const black = setOf(input.blacklistEmails);
  const hardBounce = setOf(input.hardBounceEmails);
  const softBounce = setOf(input.softBounceEmails);
  const spam = setOf(input.spamEmails);
  const testAccounts = setOf(input.testEmails);
  const suspended = setOf(input.suspendedEmails);
  const ambiguous = setOf(input.ambiguousEmails);
  const provider = input.providerSuppressed instanceof Set ? input.providerSuppressed : null;
  const batchId = str(input.batchId);
  const now = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  const counts = { [ROW_VERDICT.NEW]: 0, [ROW_VERDICT.UPDATE]: 0, [ROW_VERDICT.EXCLUDE]: 0, [ROW_VERDICT.REVIEW]: 0 };
  const byReason = {};
  const seen = new Set();
  const rowKeys = [];
  let normalizedOk = 0;

  const mark = (verdict, reason) => {
    counts[verdict] += 1;
    if (reason) byReason[reason] = (byReason[reason] || 0) + 1;
  };

  for (const row of rows) {
    // 見出しと列数が合わない行は**黙って捨てない**。人が見る側へ回す
    if (row && row.__unsupported === true) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.UNSUPPORTED_ROW); continue; }
    const email = normalizeEmail(row && (row.email ?? row.Email));
    if (!email) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.NO_EMAIL); continue; }
    if (!isValidEmail(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.INVALID_EMAIL); continue; }
    if (/�/.test(String(row.name ?? '')) ) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.ENCODING_BROKEN); continue; }
    if (seen.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.DUPLICATE_IN_FILE); continue; }
    seen.add(email);
    normalizedOk += 1;
    // 冪等性の鍵（アドレスそのものは残さず、batch と併せたハッシュだけ持つ）
    rowKeys.push(computeRowKey({ batchId, email }));

    if (isRoleAddress(email)) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.ROLE_ADDRESS); continue; }
    // 送ってはいけない相手は取り込まない（取り込んでから除外するより安全）
    if (unsub.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.UNSUBSCRIBED); continue; }
    if (black.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.BLACKLISTED); continue; }
    // hard / soft を分けて渡せるなら理由も分ける（どちらも取り込まない）
    if (hardBounce.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.HARD_BOUNCE); continue; }
    if (softBounce.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.SOFT_BOUNCE); continue; }
    if (spam.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.SPAM_REPORTED); continue; }
    // AK 側が意図的に止めた相手・テスト用アカウントは無料リストとして足さない
    if (suspended.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.SUSPENDED); continue; }
    if (testAccounts.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.TEST_ACCOUNT); continue; }
    if (provider === null) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.PROVIDER_SUPPRESSED); continue; }
    if (provider.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.PROVIDER_SUPPRESSED); continue; }
    // 有料会員を「無料リスト」として取り込まない（プランを壊す事故のもと）
    if (paid.has(email)) { mark(ROW_VERDICT.EXCLUDE, IMPORT_REASON.PAID_MEMBER); continue; }
    // AK 側が既に重複している人は、統合してからでないと足せない。**自動統合はしない**
    if (dupAk.has(email)) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.DUPLICATE_IN_AK); continue; }
    // どの既存レコードに当てるか決められない（共用アドレス扱い等）も人が見る
    if (ambiguous.has(email)) { mark(ROW_VERDICT.REVIEW, IMPORT_REASON.AMBIGUOUS_MATCH); continue; }

    if (existing.has(email)) mark(ROW_VERDICT.UPDATE, null);
    else mark(ROW_VERDICT.NEW, null);
  }

  const total = rows.length;
  const decided = counts.new + counts.update + counts.exclude + counts.review;
  return {
    batchId,
    evaluatedAtMs: now,
    総行数: total,
    正規化できた一意アドレス: normalizedOk,
    新規追加: counts[ROW_VERDICT.NEW],
    既存更新: counts[ROW_VERDICT.UPDATE],
    除外: counts[ROW_VERDICT.EXCLUDE],
    要確認: counts[ROW_VERDICT.REVIEW],
    理由別: byReason,
    理由別ラベル: Object.fromEntries(
      Object.entries(byReason).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [IMPORT_REASON_LABEL[k] || k, v]),
    ),
    /** 総行数 = 新規 + 更新 + 除外 + 要確認。崩れていたら数え方が壊れている */
    balanced: total === decided,
    /**
     * 外向きの正式名での集計（画面・API・監査ログはこちらを使う）。
     * 内部の短い綴り（new/update/…）と**同じ数**であることをテストで固定する。
     */
    classificationCounts: {
      [VERDICT_CANONICAL.new]: counts[ROW_VERDICT.NEW],
      [VERDICT_CANONICAL.update]: counts[ROW_VERDICT.UPDATE],
      [VERDICT_CANONICAL.exclude]: counts[ROW_VERDICT.EXCLUDE],
      [VERDICT_CANONICAL.review]: counts[ROW_VERDICT.REVIEW],
    },
    /** 理由コード別（ラベルではなくコード。監査・突合に使う） */
    reasonCounts: { ...byReason },
    /** 冪等性の鍵。同じ batchId × 同じアドレスなら常に同じ値（アドレスは復元できない） */
    rowKeyCount: rowKeys.length,
    rowKeySample: rowKeys.slice(0, 3),
    /** この下見の指紋。実行時に一致しなければ中止する */
    previewFingerprint: computePreviewFingerprint({ batchId, counts, byReason, total }),
    書き込み: 'なし（下見のみ）',
  };
}

function setOf(v) { return v instanceof Set ? v : new Set(); }

/**
 * 1 行の冪等キー。**アドレスを保存せずに「同じ人か」を判定する**ため、
 * batchId と一緒にハッシュ化する（レインボー対策に batchId を塩として使う）。
 */
export function computeRowKey({ batchId, email }) {
  const b = str(batchId);
  const e = normalizeEmail(email);
  if (!b || !e) return '';
  return createHash('sha256').update(`import:${b}:${e}`, 'utf8').digest('hex').slice(0, 32);
}

/** 下見の指紋。実行直前に取り直して一致しなければ中止する（TOCTOU 防止） */
export function computePreviewFingerprint({ batchId, counts, byReason, total }) {
  const seed = [
    str(batchId), Number(total) || 0,
    JSON.stringify(counts || {}), JSON.stringify(byReason || {}),
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 取り込みバッチ ID。**日付と連番だけ**（個人情報も推測できる値も入れない）。
 * @param {{ dateIso: string, seq: number }} input
 */
export function buildBatchId({ dateIso, seq } = {}) {
  const d = str(dateIso).slice(0, 10);
  const n = Number.isInteger(seq) && seq > 0 ? seq : 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  return `imp-${d}-${String(n).padStart(3, '0')}`;
}

/**
 * 実行してよいか。**下見を通っていない取り込みを認めない。**
 *
 * @param {{ preview: object, fingerprint: string, typedCount: string|number,
 *           approved: boolean, writeEnabled: boolean }} input
 */
export function canRunImport(input = {}) {
  const p = input.preview || {};
  const no = (reason, label) => ({ allowed: false, reason, label });
  if (input.writeEnabled !== true) {
    return no('write_disabled', '取り込みの実行が有効化されていません（設定が必要です）。');
  }
  if (input.approved !== true) {
    return no('not_approved', '本番への取り込みは明示的な承認が必要です。');
  }
  if (!p.previewFingerprint) return no('no_preview', '先に下見を実行してください。');
  if (str(input.fingerprint) !== str(p.previewFingerprint)) {
    return no('preview_stale', '下見のあとに内容が変わりました。もう一度下見を取り直してください。');
  }
  const willWrite = Number(p.新規追加 || 0) + Number(p.既存更新 || 0);
  if (willWrite <= 0) return no('nothing_to_write', '取り込む行がありません。');
  if (str(input.typedCount) !== String(willWrite)) {
    return no('count_mismatch', '確認入力が一致しません。書き込む件数を正しく入力してください。');
  }
  return { allowed: true, reason: null, willWrite };
}

/**
 * 取り消し方（実行前に必ず画面へ出す）。
 * **取り込みは「消す」より「印を外す」で戻す**のが安全。
 */
export function describeRollback(batchId) {
  const b = str(batchId);
  return {
    batchId: b,
    steps: [
      `この取り込みで作った顧客には ImportBatchId=${b || '(未採番)'} が入ります。`,
      '取り消しは「そのバッチで新規作成した行だけ」を対象にします。',
      '既存顧客の更新は、更新前の値を同じバッチ記録に残してから書きます。',
      '削除ではなく Status を戻す / 取り込み印を外す方向で復元します（履歴を消さない）。',
      '配信済みのメールは取り消せません。取り込み直後の配信は段階配信の最小単位から始めます。',
    ],
    warning: '取り込みと配信を同じ操作にしない（取り込んだ直後に自動送信しない）。',
  };
}

export default buildImportPreview;

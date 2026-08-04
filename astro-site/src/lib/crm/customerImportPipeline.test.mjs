/**
 * customerImportPipeline.test.mjs — 外部リスト取り込みの下見（CSV → 分類 → 下見の固定）
 *   node --test src/lib/crm/customerImportPipeline.test.mjs
 *
 * 実 CSV は未受領。**fixture で 13,000 件規模まで通す**ことで、
 * 実ファイルを受け取る前に「読める形・数え方・出さない情報」を固定する。
 *
 * ⚠️ このテストに実在のアドレス・氏名は入れない（すべて example.com の合成データ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildImportRows, decodeCsv, parseCsvText, hashBytes, normalizedHeaderHash,
  cleanCell, PARSER_VERSION, MAX_ROWS, CSV_ERROR, ENCODING,
} from './csvParse.js';
import {
  buildImportPreview, mapColumns, normalizeEmail, buildBatchId,
  IMPORT_REASON, ROW_VERDICT, VERDICT_CANONICAL,
} from './customerImport.js';
import {
  buildPreviewRecord, buildPreviewId, verifyPreviewRecord, computeSummaryHash,
  describePreview, PREVIEW_REJECT, PREVIEW_TTL_MS, RULE_VERSION,
} from './importPreview.js';

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const utf8 = (s) => new TextEncoder().encode(s);
const withBom = (s) => utf8('﻿' + s);

/** CP932（Shift_JIS）へ符号化する簡易テーブル。テストに必要な文字だけ */
function toShiftJis(text) {
  // よく使う日本語だけを CP932 のバイト列へ。ASCII はそのまま
  const table = new Map([
    ['メ', [0x83, 0x81]], ['ー', [0x81, 0x5B]], ['ル', [0x83, 0x8B]],
    ['ア', [0x83, 0x41]], ['ド', [0x83, 0x68]], ['レ', [0x83, 0x8C]], ['ス', [0x83, 0x58]],
    ['氏', [0x8E, 0x81]], ['名', [0x96, 0xBC]],
    ['山', [0x8E, 0x52]], ['田', [0x93, 0x63]],
    ['太', [0x91, 0xBE]], ['郎', [0x98, 0x59]],
  ]);
  const out = [];
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0));
    else if (table.has(ch)) out.push(...table.get(ch));
    else throw new Error(`テスト用 CP932 テーブルに無い文字: ${ch}`);
  }
  return new Uint8Array(out);
}

const parse = (bytes) => buildImportRows({ bytes, mapColumnsFn: mapColumns });

// ── 文字コード ────────────────────────────────────────────────

test('UTF-8 / BOM 付き / Shift_JIS のいずれも読める', () => {
  const body = 'email,name\na@example.com,山田\n';
  const u = parse(utf8(body));
  assert.equal(u.ok, true);
  assert.equal(u.encoding, ENCODING.UTF8);
  assert.equal(u.rowCount, 1);

  const b = parse(withBom(body));
  assert.equal(b.ok, true, 'BOM 付きが読めない');
  assert.equal(b.encoding, ENCODING.UTF8_BOM);
  assert.equal(b.hasBom, true);
  // BOM が列名に混ざると email 列を見失う
  assert.deepEqual(b.detectedColumns.includes('email'), true);
  assert.equal(b.rows[0].email, 'a@example.com');

  const sjisBody = 'メールアドレス,氏名\na@example.com,山田太郎\n';
  const s = parse(toShiftJis(sjisBody));
  assert.equal(s.ok, true, 'Shift_JIS が読めない');
  assert.equal(s.encoding, ENCODING.SHIFT_JIS);
  assert.equal(s.rows[0].name, '山田太郎', '日本語が壊れている');
});

test('UTF-16 は受け付けない（推測で読まない）', () => {
  const utf16 = new Uint8Array([0xFF, 0xFE, 0x61, 0x00]);
  const r = decodeCsv(utf16);
  assert.equal(r.ok, false);
  assert.equal(r.error, CSV_ERROR.UNSUPPORTED_ENCODING);
});

test('復号に失敗したら止める（文字化けのまま取り込まない）', () => {
  // UTF-8 としても Shift_JIS としても成立しないバイト列
  const broken = new Uint8Array([0x81, 0x20, 0xFF, 0xFE, 0x41]);
  const r = decodeCsv(broken);
  assert.equal(r.ok, false);
  assert.ok([CSV_ERROR.DECODE_FAILED, CSV_ERROR.UNSUPPORTED_ENCODING].includes(r.error));
});

// ── CSV の形 ──────────────────────────────────────────────────

test('改行コードが CRLF / LF / CR のどれでも同じ結果になる', () => {
  const rows = (nl) => parse(utf8(`email${nl}a@example.com${nl}b@example.com${nl}`)).rows;
  const lf = rows('\n');
  assert.deepEqual(rows('\r\n'), lf, 'CRLF が違う結果になる');
  assert.deepEqual(rows('\r'), lf, 'CR が違う結果になる');
  assert.equal(lf.length, 2);
});

test('引用符の中のカンマ・改行・"" を正しく読む', () => {
  const csv = 'email,note\n'
    + '"a@example.com","カンマ, を含む"\n'
    + '"b@example.com","改行\nを含む"\n'
    + '"c@example.com","引用符 "" を含む"\n';
  const r = parse(utf8(csv));
  assert.equal(r.rowCount, 3, '引用符内の改行で行が割れている');
  assert.equal(r.rows[0].note, 'カンマ, を含む');
  assert.equal(r.rows[1].note, '改行\nを含む');
  assert.equal(r.rows[2].note, '引用符 " を含む');
});

test('空行は行数に数えない', () => {
  const r = parse(utf8('email\n\na@example.com\n\n\nb@example.com\n\n'));
  assert.equal(r.rowCount, 2);
});

test('列の順番が違っても同じ結果（列名で対応づける）', () => {
  const a = parse(utf8('email,name\nx@example.com,山田\n'));
  const b = parse(utf8('name,email\n山田,x@example.com\n'));
  assert.deepEqual(b.rows, a.rows, '列順で結果が変わる');
  // 見出しハッシュも順番に依存しない（同じファイル扱いにする）
  assert.equal(normalizedHeaderHash(['email', 'name']), normalizedHeaderHash(['name', 'email']));
});

test('列名のゆらぎ・大文字小文字・前後空白・全角空白を吸収する', () => {
  const variants = [
    'Email,Name', ' EMAIL , NAME ', 'メールアドレス,お名前',
    'mail_address,氏名', 'E-Mail,fullname', '　email　,　name　',
  ];
  for (const header of variants) {
    const r = parse(utf8(`${header}\nq@example.com,佐藤\n`));
    assert.equal(r.ok, true, `${header} で必須列を見失った`);
    assert.equal(r.rows[0].email, 'q@example.com', `${header} で値がずれた`);
  }
});

test('知らない列は取り込まず、名前だけ報告する', () => {
  const r = parse(utf8('email,好きな馬,内部ID\na@example.com,ディープ,999\n'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.detectedColumns, ['email']);
  assert.deepEqual(r.ignoredColumns, ['好きな馬', '内部ID']);
  assert.equal(Object.keys(r.rows[0]).length, 1, '知らない列を行へ取り込んでいる');
});

test('必須列（メールアドレス）が無ければ受け付けない', () => {
  const r = parse(utf8('name,note\n山田,メモ\n'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['email']);
});

test('列数が見出しより多い行は捨てずに「要確認」へ回す', () => {
  const r = parse(utf8('email,name\na@example.com,山田,余計な値\nb@example.com,佐藤\n'));
  assert.equal(r.unsupportedRows, 1);
  assert.equal(r.rows[0].__unsupported, true);
  const p = buildImportPreview({ rows: r.rows, batchId: 'imp-2026-08-04-001', providerSuppressed: new Set(), nowMs: NOW });
  assert.equal(p.理由別[IMPORT_REASON.UNSUPPORTED_ROW], 1);
  assert.equal(p.balanced, true);
});

test('上限を超える行数・サイズは受け付けない', () => {
  const big = new Uint8Array(9 * 1024 * 1024);
  big[0] = 0x61;
  assert.equal(decodeCsv(big).error, CSV_ERROR.TOO_LARGE);
  assert.ok(MAX_ROWS >= 13000, '13,000 行を受け付けられない上限になっている');
});

test('全角空白・ゼロ幅文字を落として突合する', () => {
  assert.equal(cleanCell('　a@example.com　'), 'a@example.com');
  assert.equal(normalizeEmail('　Ａ@ＥＸＡＭＰＬＥ.com '), 'a@example.com');
  assert.equal(normalizeEmail('mailto:<B@Example.com>'), 'b@example.com');
});

// ── 分類 ──────────────────────────────────────────────────────

const rowsOf = (...emails) => emails.map((email) => ({ email }));

test('理由コードごとに分類され、母数と合計が一致する', () => {
  const p = buildImportPreview({
    rows: rowsOf(
      'new1@example.com', 'new2@example.com',
      'exists@example.com',
      'paid@example.com',
      'unsub@example.com',
      'hard@example.com',
      'soft@example.com',
      'spam@example.com',
      'suspended@example.com',
      'test@example.com',
      'dup@example.com', 'dup@example.com',
      'akdup@example.com',
      'ambiguous@example.com',
      'info@example.com',
      'bad-email',
      '',
    ),
    existingEmails: new Set(['exists@example.com', 'akdup@example.com']),
    duplicateInAk: new Set(['akdup@example.com']),
    paidEmails: new Set(['paid@example.com']),
    unsubscribedEmails: new Set(['unsub@example.com']),
    hardBounceEmails: new Set(['hard@example.com']),
    softBounceEmails: new Set(['soft@example.com']),
    spamEmails: new Set(['spam@example.com']),
    suspendedEmails: new Set(['suspended@example.com']),
    testEmails: new Set(['test@example.com']),
    ambiguousEmails: new Set(['ambiguous@example.com']),
    providerSuppressed: new Set(),
    batchId: 'imp-2026-08-04-001',
    nowMs: NOW,
  });

  assert.equal(p.balanced, true, '母数と分類合計が一致しない');
  assert.equal(p.新規追加, 3, 'new1/new2/ambiguous 以外の新規数が想定外');   // new1, new2, dup(初出)
  assert.equal(p.既存更新, 1);                                              // exists
  assert.equal(p.理由別[IMPORT_REASON.PAID_MEMBER], 1);
  assert.equal(p.理由別[IMPORT_REASON.UNSUBSCRIBED], 1);
  assert.equal(p.理由別[IMPORT_REASON.HARD_BOUNCE], 1);
  assert.equal(p.理由別[IMPORT_REASON.SOFT_BOUNCE], 1);
  assert.equal(p.理由別[IMPORT_REASON.SPAM_REPORTED], 1);
  assert.equal(p.理由別[IMPORT_REASON.SUSPENDED], 1);
  assert.equal(p.理由別[IMPORT_REASON.TEST_ACCOUNT], 1);
  assert.equal(p.理由別[IMPORT_REASON.DUPLICATE_IN_FILE], 1);
  assert.equal(p.理由別[IMPORT_REASON.DUPLICATE_IN_AK], 1);
  assert.equal(p.理由別[IMPORT_REASON.AMBIGUOUS_MATCH], 1);
  assert.equal(p.理由別[IMPORT_REASON.ROLE_ADDRESS], 1);
  assert.equal(p.理由別[IMPORT_REASON.INVALID_EMAIL], 1);
  assert.equal(p.理由別[IMPORT_REASON.NO_EMAIL], 1);
});

test('正式名の集計は内部の分類と同じ数になる', () => {
  const p = buildImportPreview({
    rows: rowsOf('a@example.com', 'b@example.com', 'bad'),
    providerSuppressed: new Set(), batchId: 'imp-2026-08-04-001', nowMs: NOW,
  });
  assert.equal(p.classificationCounts[VERDICT_CANONICAL[ROW_VERDICT.NEW]], p.新規追加);
  assert.equal(p.classificationCounts[VERDICT_CANONICAL[ROW_VERDICT.UPDATE]], p.既存更新);
  assert.equal(p.classificationCounts[VERDICT_CANONICAL[ROW_VERDICT.EXCLUDE]], p.除外);
  assert.equal(p.classificationCounts[VERDICT_CANONICAL[ROW_VERDICT.REVIEW]], p.要確認);
  assert.deepEqual(p.reasonCounts, p.理由別);
});

test('配信基盤の停止リストを確認できなければ全員「要確認」（fail closed）', () => {
  const p = buildImportPreview({
    rows: rowsOf('a@example.com', 'b@example.com'),
    providerSuppressed: null, batchId: 'imp-2026-08-04-001', nowMs: NOW,
  });
  assert.equal(p.要確認, 2);
  assert.equal(p.新規追加, 0, '確認できないのに取り込もうとしている');
  assert.equal(p.理由別[IMPORT_REASON.PROVIDER_SUPPRESSED], 2);
});

test('AK 側の重複は自動統合せず「要確認」へ隔離する', () => {
  const p = buildImportPreview({
    rows: rowsOf('dupe@example.com'),
    existingEmails: new Set(['dupe@example.com']),
    duplicateInAk: new Set(['dupe@example.com']),
    providerSuppressed: new Set(), batchId: 'imp-2026-08-04-001', nowMs: NOW,
  });
  assert.equal(p.要確認, 1);
  assert.equal(p.既存更新, 0, '重複レコードへ自動で当てている');
});

// ── 13,000 行 fixture ─────────────────────────────────────────

/** 13,000 行の合成 CSV（実在アドレスを含まない） */
function buildLargeFixture() {
  const lines = ['email,name,登録日,source'];
  const existing = new Set();
  const paid = new Set();
  const unsub = new Set();
  const hard = new Set();
  let invalid = 0; let empty = 0; let dupInFile = 0;

  for (let i = 0; i < 13000; i += 1) {
    const addr = `user${String(i).padStart(5, '0')}@example.com`;
    // 1% は AK に既存 / 0.5% は有料 / 0.5% は配信停止 / 0.2% は hard bounce
    if (i % 100 === 0) existing.add(addr);
    if (i % 200 === 7) { existing.add(addr); paid.add(addr); }
    if (i % 200 === 11) unsub.add(addr);
    if (i % 500 === 13) hard.add(addr);

    if (i % 700 === 17) { lines.push(`not-an-email-${i},名前${i},2024-01-01,list-a`); invalid += 1; continue; }
    if (i % 900 === 23) { lines.push(`,名前${i},2024-01-01,list-a`); empty += 1; continue; }
    if (i % 1100 === 29) { lines.push(`${addr},名前${i},2024-01-01,list-a`); lines.push(`${addr},名前${i},2024-01-01,list-b`); dupInFile += 1; continue; }
    lines.push(`"${addr}","名前, ${i}",2024-01-01,list-a`);
  }
  return { csv: lines.join('\r\n') + '\r\n', existing, paid, unsub, hard, invalid, empty, dupInFile };
}

test('13,000 行の CSV を読み、母数と分類合計が一致する', () => {
  const fx = buildLargeFixture();
  const bytes = utf8(fx.csv);
  const parsed = parse(bytes);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.rowCount >= 13000, `行数が足りない: ${parsed.rowCount}`);

  const p = buildImportPreview({
    rows: parsed.rows,
    existingEmails: fx.existing,
    paidEmails: fx.paid,
    unsubscribedEmails: fx.unsub,
    hardBounceEmails: fx.hard,
    providerSuppressed: new Set(),
    batchId: buildBatchId({ dateIso: '2026-08-04', seq: 1 }),
    nowMs: NOW,
  });

  assert.equal(p.balanced, true, `母数 ${p.総行数} と分類合計が一致しない`);
  assert.equal(p.総行数, parsed.rowCount);
  assert.equal(p.理由別[IMPORT_REASON.INVALID_EMAIL], fx.invalid);
  assert.equal(p.理由別[IMPORT_REASON.NO_EMAIL], fx.empty);
  assert.equal(p.理由別[IMPORT_REASON.DUPLICATE_IN_FILE], fx.dupInFile);
  assert.equal(p.理由別[IMPORT_REASON.PAID_MEMBER], fx.paid.size);
  assert.equal(p.理由別[IMPORT_REASON.UNSUBSCRIBED], fx.unsub.size);
  assert.equal(p.理由別[IMPORT_REASON.HARD_BOUNCE], fx.hard.size);
  assert.ok(p.新規追加 > 12000, `新規候補が少なすぎる: ${p.新規追加}`);
});

test('13,000 行でも応答に載せる情報は件数だけ（PII を含まない）', () => {
  const fx = buildLargeFixture();
  const parsed = parse(utf8(fx.csv));
  const p = buildImportPreview({
    rows: parsed.rows, providerSuppressed: new Set(),
    batchId: 'imp-2026-08-04-001', nowMs: NOW,
  });
  const record = buildPreviewRecord({
    importPreviewId: buildPreviewId({ fileHash: hashBytes(utf8(fx.csv)), createdAtMs: NOW }),
    fileHash: hashBytes(utf8(fx.csv)),
    normalizedHeaderHash: parsed.headerHash,
    rowCount: p.総行数,
    classificationCounts: p.classificationCounts,
    reasonCounts: p.reasonCounts,
    parserVersion: parsed.parserVersion,
    encoding: parsed.encoding,
    detectedColumns: parsed.detectedColumns,
    ignoredColumns: parsed.ignoredColumns,
    createdAtMs: NOW,
  });
  const dumped = JSON.stringify(describePreview(record));
  assert.equal(dumped.includes('@example.com'), false, '応答にアドレスが含まれている');
  assert.equal(/名前\d/.test(dumped), false, '応答に氏名が含まれている');
  assert.equal(/\brec[A-Za-z0-9]{14}\b/.test(dumped), false, '応答に recordId が含まれている');
});

// ── 下見の固定 ────────────────────────────────────────────────

const makeRecord = (over = {}) => buildPreviewRecord({
  importPreviewId: 'prev-abcdef0123456789',
  fileHash: 'f'.repeat(64),
  normalizedHeaderHash: 'aaaa1111bbbb2222',
  rowCount: 13000,
  classificationCounts: { CREATE_CANDIDATE: 12800, UPDATE_CANDIDATE: 100, EXCLUDED: 80, REVIEW_REQUIRED: 20 },
  reasonCounts: { invalid_email: 18, unsubscribed: 62 },
  parserVersion: PARSER_VERSION,
  encoding: 'utf-8',
  createdAtMs: NOW,
  ...over,
});

test('fileHash は同じ内容なら安定し、1 バイト違えば変わる', () => {
  const a = utf8('email\na@example.com\n');
  const b = utf8('email\na@example.com\n');
  const c = utf8('email\nb@example.com\n');
  assert.equal(hashBytes(a), hashBytes(b), '同じ内容で違うハッシュになる');
  assert.notEqual(hashBytes(a), hashBytes(c));
});

test('同じファイル・同じ列・期限内なら実行できる', () => {
  const r = makeRecord();
  const v = verifyPreviewRecord({
    record: r, importPreviewId: r.importPreviewId, fileHash: r.fileHash,
    normalizedHeaderHash: r.normalizedHeaderHash, parserVersion: PARSER_VERSION, nowMs: NOW + 60000,
  });
  assert.equal(v.ok, true, v.reason);
});

test('ファイルを差し替えたら拒否する', () => {
  const r = makeRecord();
  const v = verifyPreviewRecord({ record: r, fileHash: 'e'.repeat(64), nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PREVIEW_REJECT.FILE_CHANGED);
});

test('列構成が変わったら拒否する', () => {
  const r = makeRecord();
  const v = verifyPreviewRecord({ record: r, normalizedHeaderHash: 'ffff0000ffff0000', nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PREVIEW_REJECT.HEADER_CHANGED);
});

test('件数を書き換えたら拒否する（改ざん検知）', () => {
  const r = makeRecord();
  const tampered = { ...r, classificationCounts: { ...r.classificationCounts, EXCLUDED: 0 } };
  const v = verifyPreviewRecord({ record: tampered, nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PREVIEW_REJECT.TAMPERED);
});

test('期限切れの下見は使えない', () => {
  const r = makeRecord();
  const v = verifyPreviewRecord({ record: r, nowMs: NOW + PREVIEW_TTL_MS + 1 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PREVIEW_REJECT.EXPIRED);
});

test('規則・パーサーの版が変わったら拒否する', () => {
  const r = makeRecord();
  assert.equal(verifyPreviewRecord({ record: { ...r, ruleVersion: 'old', summaryHash: computeSummaryHash({ ...r, ruleVersion: 'old' }) }, nowMs: NOW }).reason,
    PREVIEW_REJECT.RULE_CHANGED);
  assert.equal(verifyPreviewRecord({ record: r, parserVersion: 'csv-0', nowMs: NOW }).reason,
    PREVIEW_REJECT.PARSER_CHANGED);
});

test('別の下見 ID では実行できない', () => {
  const r = makeRecord();
  const v = verifyPreviewRecord({ record: r, importPreviewId: 'prev-0000000000000000', nowMs: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.reason, PREVIEW_REJECT.ID_MISMATCH);
});

test('下見が無ければ実行できない', () => {
  assert.equal(verifyPreviewRecord({ record: null, nowMs: NOW }).reason, PREVIEW_REJECT.NO_PREVIEW);
  assert.equal(verifyPreviewRecord({ record: {}, nowMs: NOW }).reason, PREVIEW_REJECT.NO_PREVIEW);
});

test('下見の記録に規則の版が入る（あとから読める）', () => {
  const r = makeRecord();
  assert.equal(r.ruleVersion, RULE_VERSION);
  assert.equal(r.parserVersion, PARSER_VERSION);
  assert.ok(r.createdAt && r.expiresAt);
  assert.ok(new Date(r.expiresAt).getTime() > new Date(r.createdAt).getTime());
});

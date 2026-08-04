/**
 * customerImport.test.mjs — 外部リスト取り込みの事前検査
 *   node --test src/lib/crm/customerImport.test.mjs
 *
 * 取り込みは戻しにくい。**書き込む前に全部わかる**ことと、
 * **送ってはいけない相手を取り込まない**ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_COLUMNS, KNOWN_COLUMNS, ROW_VERDICT, IMPORT_REASON, IMPORT_REASON_LABEL,
  UTF8_BOM, stripBom, detectEncodingIssues,
  normalizeEmail, isValidEmail, isRoleAddress, mapColumns,
  buildImportPreview, computeRowKey, computePreviewFingerprint,
  buildBatchId, canRunImport, describeRollback,
} from './customerImport.js';

const BATCH = 'imp-2026-08-04-001';
const NOW = Date.UTC(2026, 7, 4, 5, 0, 0);
const row = (email, over = {}) => ({ email, ...over });

// ── 列 ──────────────────────────────────────────────────────────

test('必須列が無ければ受け付けない', () => {
  const r = mapColumns(['名前', '登録日']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, REQUIRED_COLUMNS);
  assert.match(r.error, /必須列/);
});

test('列名のゆらぎを吸収する（日本語・大文字・空白）', () => {
  for (const h of ['email', 'Email', 'メールアドレス', ' MAIL ADDRESS ', 'ｅメール']) {
    const r = mapColumns([h]);
    assert.equal(r.ok, true, `${h} を認識できない`);
    assert.equal(r.mapped.email, 0);
  }
});

test('知らない列は取り込まない（勝手に顧客へ書かない）', () => {
  const r = mapColumns(['email', '年収', '内部メモ2']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unknown, ['年収', '内部メモ2']);
  for (const k of Object.keys(r.mapped)) {
    assert.ok(KNOWN_COLUMNS[k], `${k} は既知の列ではない`);
  }
});

// ── 文字コード ──────────────────────────────────────────────────

test('BOM を落とせる（先頭の列名が読めなくなるため）', () => {
  assert.equal(stripBom(UTF8_BOM + 'email'), 'email');
  assert.equal(stripBom('email'), 'email');
  assert.equal(detectEncodingIssues(UTF8_BOM + 'email').hasBom, true);
});

test('復号に失敗したファイルを検出する', () => {
  const broken = detectEncodingIssues('氏名,���,email');
  assert.equal(broken.ok, false);
  assert.ok(broken.replacementChars > 0);
  assert.match(broken.note, /文字コード/);
});

test('正常な UTF-8 は問題なしと判定する', () => {
  const r = detectEncodingIssues('email,氏名\na@example.com,山田');
  assert.equal(r.ok, true);
  assert.equal(r.note, '');
});

// ── メールアドレスの正規化 ──────────────────────────────────────

test('表記ゆれをそろえる（全角・空白・引用符・mailto）', () => {
  const want = 'user@example.com';
  for (const raw of [
    ' User@Example.com ', 'ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ',
    '<user@example.com>', '"user@example.com"', 'mailto:USER@example.com',
  ]) {
    assert.equal(normalizeEmail(raw), want, `${raw} を正規化できない`);
  }
});

test('ゼロ幅文字を除去する（見えない差で別人にしない）', () => {
  assert.equal(normalizeEmail('user​@example.com'), 'user@example.com');
});

test('+alias とドットは正規化しない（本人の意図と食い違わせない）', () => {
  assert.notEqual(normalizeEmail('a+x@example.com'), normalizeEmail('a@example.com'));
  assert.notEqual(normalizeEmail('a.b@example.com'), normalizeEmail('ab@example.com'));
});

test('明らかに壊れたアドレスを弾く', () => {
  for (const bad of ['', 'no-at', 'a@b', 'a@@b.com', 'a..b@example.com', '.a@example.com', `${'x'.repeat(250)}@example.com`]) {
    assert.equal(isValidEmail(normalizeEmail(bad)), false, `${bad} が通ってしまう`);
  }
  assert.equal(isValidEmail('a@example.com'), true);
});

test('共用アドレスを見分ける', () => {
  assert.equal(isRoleAddress('info@example.com'), true);
  assert.equal(isRoleAddress('noreply@example.com'), true);
  assert.equal(isRoleAddress('taro@example.com'), false);
});

// ── 下見の集計 ──────────────────────────────────────────────────

const preview = (rows, over = {}) => buildImportPreview({
  rows, batchId: BATCH, nowMs: NOW,
  providerSuppressed: new Set(), ...over,
});

test('総行数 = 新規 + 更新 + 除外 + 要確認 が常に成り立つ', () => {
  const rows = [
    row('a@example.com'), row('b@example.com'), row('a@example.com'),
    row('bad'), row(''), row('info@example.com'),
    row('paid@example.com'), row('stop@example.com'),
  ];
  const p = preview(rows, {
    existingEmails: new Set(['b@example.com']),
    paidEmails: new Set(['paid@example.com']),
    unsubscribedEmails: new Set(['stop@example.com']),
  });
  assert.equal(p.balanced, true, `${p.総行数} != 内訳の合計`);
  assert.equal(p.総行数, rows.length);
});

test('AK に無い人は新規、いる人は更新に分ける', () => {
  const p = preview([row('new@example.com'), row('old@example.com')], {
    existingEmails: new Set(['old@example.com']),
  });
  assert.equal(p.新規追加, 1);
  assert.equal(p.既存更新, 1);
  assert.equal(p.除外, 0);
});

test('送ってはいけない相手は取り込まない', () => {
  const p = preview([
    row('u1@example.com'), row('u2@example.com'), row('u3@example.com'), row('u4@example.com'),
  ], {
    unsubscribedEmails: new Set(['u1@example.com']),
    blacklistEmails: new Set(['u2@example.com']),
    spamEmails: new Set(['u3@example.com']),
    providerSuppressed: new Set(['u4@example.com']),
  });
  assert.equal(p.新規追加, 0, '送れない相手を取り込もうとしている');
  assert.equal(p.除外, 4);
  assert.equal(p.理由別[IMPORT_REASON.UNSUBSCRIBED], 1);
  assert.equal(p.理由別[IMPORT_REASON.BLACKLISTED], 1);
  assert.equal(p.理由別[IMPORT_REASON.SPAM_REPORTED], 1);
  assert.equal(p.理由別[IMPORT_REASON.PROVIDER_SUPPRESSED], 1);
});

test('現役の有料会員を無料リストとして取り込まない', () => {
  const p = preview([row('paid@example.com')], { paidEmails: new Set(['paid@example.com']) });
  assert.equal(p.除外, 1);
  assert.equal(p.理由別[IMPORT_REASON.PAID_MEMBER], 1);
});

test('ファイル内の重複は 1 件だけ扱う', () => {
  const p = preview([row('a@example.com'), row('A@Example.com '), row('a@example.com')]);
  assert.equal(p.新規追加, 1);
  assert.equal(p.理由別[IMPORT_REASON.DUPLICATE_IN_FILE], 2);
  assert.equal(p.正規化できた一意アドレス, 1);
});

test('AK 側で重複している人は要確認（統合が先）', () => {
  const p = preview([row('dup@example.com')], { duplicateInAk: new Set(['dup@example.com']) });
  assert.equal(p.要確認, 1);
  assert.equal(p.理由別[IMPORT_REASON.DUPLICATE_IN_AK], 1);
  assert.equal(p.新規追加, 0);
});

test('共用アドレス・文字化けは要確認（勝手に捨てない）', () => {
  const p = preview([row('info@example.com'), row('x@example.com', { name: '��' })]);
  assert.equal(p.要確認, 2);
  assert.equal(p.理由別[IMPORT_REASON.ROLE_ADDRESS], 1);
  assert.equal(p.理由別[IMPORT_REASON.ENCODING_BROKEN], 1);
});

test('配信基盤の停止リストを確認できないときは要確認へ倒す', () => {
  const p = preview([row('a@example.com'), row('b@example.com')], { providerSuppressed: null });
  assert.equal(p.新規追加, 0, '確認できないのに取り込もうとしている');
  assert.equal(p.要確認, 2);
  assert.equal(p.理由別[IMPORT_REASON.PROVIDER_SUPPRESSED], 2);
});

test('すべての理由に表示名がある', () => {
  for (const code of Object.values(IMPORT_REASON)) {
    assert.ok(IMPORT_REASON_LABEL[code], `${code} の文言が無い`);
  }
});

// ── 個人情報を出さない ──────────────────────────────────────────

test('下見の戻り値にアドレス・氏名を含めない', () => {
  const p = preview([row('secret@example.com', { name: '山田太郎', note: '重要顧客' })]);
  const json = JSON.stringify(p);
  for (const b of ['secret@example.com', 'example.com', '山田太郎', '重要顧客']) {
    assert.equal(json.includes(b), false, `${b} を返している`);
  }
});

test('行キーからアドレスを復元できない（batchId を塩に使う）', () => {
  const k1 = computeRowKey({ batchId: BATCH, email: 'a@example.com' });
  const k2 = computeRowKey({ batchId: 'imp-2026-08-05-001', email: 'a@example.com' });
  assert.equal(k1.length, 32);
  assert.equal(k1.includes('@'), false);
  assert.notEqual(k1, k2, 'batch が違えば鍵も違うべき');
  // 同じ batch × 同じ相手なら安定（冪等性の鍵として使える）
  assert.equal(k1, computeRowKey({ batchId: BATCH, email: ' A@Example.com ' }));
});

// ── 冪等性・実行境界 ────────────────────────────────────────────

test('バッチ ID は日付と連番だけ', () => {
  assert.equal(buildBatchId({ dateIso: '2026-08-04', seq: 1 }), 'imp-2026-08-04-001');
  assert.equal(buildBatchId({ dateIso: '2026-08-04T12:00:00Z', seq: 12 }), 'imp-2026-08-04-012');
  assert.equal(buildBatchId({ dateIso: 'bad' }), '');
});

test('下見の指紋は内容が変われば変わる', () => {
  const a = computePreviewFingerprint({ batchId: BATCH, counts: { new: 1 }, byReason: {}, total: 1 });
  const b = computePreviewFingerprint({ batchId: BATCH, counts: { new: 2 }, byReason: {}, total: 2 });
  assert.notEqual(a, b);
  assert.equal(a, computePreviewFingerprint({ batchId: BATCH, counts: { new: 1 }, byReason: {}, total: 1 }));
});

test('下見・承認・人数入力がそろわないと実行できない', () => {
  const p = preview([row('a@example.com'), row('b@example.com')]);
  const base = { preview: p, fingerprint: p.previewFingerprint, typedCount: '2', approved: true, writeEnabled: true };
  assert.equal(canRunImport(base).allowed, true);

  assert.equal(canRunImport({ ...base, writeEnabled: false }).reason, 'write_disabled');
  assert.equal(canRunImport({ ...base, approved: false }).reason, 'not_approved');
  assert.equal(canRunImport({ ...base, fingerprint: 'xxxx' }).reason, 'preview_stale');
  assert.equal(canRunImport({ ...base, typedCount: '1' }).reason, 'count_mismatch');
  assert.equal(canRunImport({ ...base, preview: {} }).reason, 'no_preview');
});

test('書き込む行が無ければ実行できない', () => {
  const p = preview([row('stop@example.com')], { unsubscribedEmails: new Set(['stop@example.com']) });
  const r = canRunImport({
    preview: p, fingerprint: p.previewFingerprint, typedCount: '0', approved: true, writeEnabled: true,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'nothing_to_write');
});

test('取り消し方を必ず説明できる', () => {
  const r = describeRollback(BATCH);
  assert.equal(r.batchId, BATCH);
  assert.ok(r.steps.length >= 4);
  assert.ok(r.steps.some((s) => /削除ではなく/.test(s)), '削除で戻す説明になっている');
  assert.match(r.warning, /取り込みと配信を同じ操作にしない/);
});

// ── 規模 ────────────────────────────────────────────────────────

test('13,000 行でも件数だけを返す（明細を持たない）', () => {
  const rows = [];
  for (let i = 0; i < 13000; i += 1) {
    if (i % 500 === 0) rows.push(row(`dup${i % 100}@example.com`));
    else if (i % 997 === 0) rows.push(row('bad-row'));
    else rows.push(row(`user${i}@example.com`, { name: `氏名${i}` }));
  }
  const p = buildImportPreview({
    rows, batchId: BATCH, nowMs: NOW,
    providerSuppressed: new Set(),
    existingEmails: new Set(['user1@example.com', 'user2@example.com']),
  });
  assert.equal(p.総行数, 13000);
  assert.equal(p.balanced, true);
  assert.equal(p.既存更新, 2);
  assert.ok(p.新規追加 > 12000);
  // 明細の配列を返していない（サンプルは 3 件まで）
  for (const [k, v] of Object.entries(p)) {
    if (Array.isArray(v)) assert.ok(v.length <= 3, `${k} に明細が入っている`);
  }
  assert.equal(JSON.stringify(p).includes('@'), false);
});

/**
 * sendgridWebhook.guard.test.mjs — `netlify/functions/sendgrid-webhook.js` の**配線**を実ファイル検査で固定する。
 *
 * ロジック（署名検証）が正しくても、Function 側で
 * 「鍵が無ければ検証を省略」「検証前に body を parse」「検証前に Airtable を叩く」
 * のいずれかに戻ったら公開エンドポイントの無認証書込みが復活する。
 * よってソースを直接検査して固定する（paymentEmailSender.guard.test.mjs と同じ方式）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url)),
  'utf8'
);

/** コメント / JSDoc を除いた実コード（禁止語検査の誤検知を避ける）。 */
const CODE = FN.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

/** 台帳書き込みの単一源（バッチ化・bounded retry・失敗集計）。 */
const WRITER = readFileSync(
  fileURLToPath(new URL('./emailEventLedgerWriter.js', import.meta.url)),
  'utf8'
);

test('guard: 署名検証は単一源 sendgridSignature.js を import して使う（再実装しない）', () => {
  assert.ok(/from '[^']*lib\/webhooks\/sendgridSignature\.js'/.test(FN),
    '署名検証の単一源を import していない');
  assert.ok(/verifySendgridEventWebhookSignature\(/.test(CODE),
    '署名検証を呼んでいない');
  assert.ok(!/createVerify\(/.test(CODE),
    'Function 内に署名検証を再実装している（単一源に集約すること）');
});

test('guard: 検証鍵が無いときに検証を省略する分岐を持たない（素通り禁止）', () => {
  // 「鍵が未設定なら検証しない / 素通りする」典型パターンを禁止する
  assert.ok(!/if\s*\(\s*!\s*(process\.env\.)?SENDGRID_WEBHOOK_VERIFICATION_KEY/.test(CODE),
    '検証鍵の有無で処理を分岐している（鍵未設定は verify 側で fail closed にすること）');
  assert.ok(!/VERIFICATION_KEY[^\n]*\|\|/.test(CODE),
    '検証鍵に fallback を与えている');
  // 鍵は verify 関数へ渡すだけ
  assert.ok(/publicKeyBase64:\s*process\.env\.SENDGRID_WEBHOOK_VERIFICATION_KEY/.test(CODE),
    '検証鍵を verify 関数へ渡していない');
});

test('guard: 検証前に body を parse しない（未検証入力を構文解析しない）', () => {
  assert.ok(!/req\.json\(\)/.test(CODE), 'req.json() を使っている（raw body で検証できない）');
  assert.ok(/await req\.text\(\)/.test(CODE), 'raw body を text() で取得していない');

  const textIdx = CODE.indexOf('await req.text()');
  // import 行ではなく**呼出**の位置を見る
  const verifyIdx = CODE.indexOf('verifySendgridEventWebhookSignature({');
  const parseIdx = CODE.indexOf('JSON.parse(rawBody)');
  assert.ok(textIdx > -1 && verifyIdx > -1 && parseIdx > -1, '想定の呼出が見つからない');
  assert.ok(textIdx < verifyIdx, 'raw body 取得より前に検証している');
  assert.ok(verifyIdx < parseIdx, '署名検証より前に JSON.parse している（順序違反）');
});

test('guard: 検証失敗時は 403 を返し、その後の処理へ進まない', () => {
  assert.ok(/if\s*\(!verification\.ok\)\s*\{[\s\S]*?return jsonResponse\(signatureFailureStatus\(\)/.test(CODE),
    '検証失敗で即 return していない（fail closed になっていない）');
});

test('guard: Airtable 書込みは署名検証より後にしか現れない', () => {
  const verifyIdx = CODE.indexOf('if (!verification.ok)');
  assert.ok(verifyIdx > -1, '検証失敗ガードが見つからない');

  for (const marker of ['recordWebhookBounce(', 'processFailureEvent(']) {
    const callIdx = CODE.indexOf(marker);
    assert.ok(callIdx > verifyIdx,
      `${marker} が署名検証ガードより前に現れる（未検証で Airtable へ到達しうる）`);
  }
  // fetch（Airtable / 外部 API）が検証ガードより前に無いこと
  const firstFetch = CODE.indexOf('fetch(');
  assert.ok(firstFetch === -1 || firstFetch > verifyIdx,
    '署名検証より前に fetch がある（未検証で外部 API を叩いている）');
});

test('guard: filterByFormula へ外部入力を直挿ししない（injection 遮断）', () => {
  assert.ok(/emailMatchFormula\(/.test(CODE), 'formula 組立を単一源経由にしていない');
  assert.ok(!/\{Email\}=/.test(CODE), '正規化なしの素の完全一致を使っている（重複レコードの原因）');
  assert.ok(!/SEARCH\(/.test(CODE), 'SEARCH（部分一致 + 直挿し）が復活している');
  // 外部入力（email）を URL / formula へ直挿ししていないこと
  assert.ok(!/\$\{\s*email\s*\}/.test(CODE), 'email を URL / formula へ直挿ししている');
  assert.ok(/encodeURIComponent\(formula\)/.test(CODE), 'formula を URL エンコードしていない');
});

test('guard: ログにメールアドレスを出さない', () => {
  const logLines = CODE.split('\n').filter((l) => /console\.(log|warn|error)/.test(l));
  for (const line of logLines) {
    assert.ok(!/\bemail\b/.test(line), `ログにメールアドレスを出している: ${line.trim()}`);
    assert.ok(!/\$\{email/.test(line), `ログにメールアドレスを埋め込んでいる: ${line.trim()}`);
  }
});

test('guard: 応答・ログに Airtable 応答本文や例外本文を出さない', () => {
  assert.ok(!/await\s+\w*[Rr]esponse\.text\(\)/.test(CODE),
    'Airtable 応答本文を読み出してログ/応答へ流している');
  assert.ok(!/console\.(log|warn|error)\([^)]*error\.message/.test(CODE),
    '例外メッセージをログへ出している（PII/secret 混入の恐れ）');
});

test('guard: 失敗イベント種別の判定は従来どおり維持されている（機能後退させない）', () => {
  for (const ev of ['bounce', 'blocked', 'dropped', 'spamreport', 'unsubscribe']) {
    assert.ok(new RegExp(`'${ev}'`).test(CODE), `失敗イベント ${ev} の判定が失われている`);
  }
});

test('guard: 既存レコード検索の失敗を「未登録」と混同しない（重複作成の防止）', () => {
  const code = CODE;
  assert.ok(/if \(!lookup\.ok\)/.test(code),
    '検索失敗を判定していない（Airtable 一時障害のたびに重複レコードが増える）');
  const failIdx = code.indexOf('if (!lookup.ok)');
  const createIdx = code.indexOf('createNewRecord(email');
  assert.ok(failIdx > -1 && createIdx > failIdx,
    '検索失敗ガードより前に新規作成へ到達しうる');
});

test('guard: 許容ずれは env 上書き可能な単一源から取る', () => {
  const code = CODE;
  assert.ok(/maxSkewSec:\s*resolveMaxSkewSec\(process\.env\)/.test(code),
    '許容ずれをハードコードしている（リトライ取りこぼしの調整余地が無い）');
});

// ── S9 本体（Payment Email v2 の配信結果反映）の配線固定 ──────────────

test('guard: Payment Email 反映は単一源を import する（Function に再実装しない）', () => {
  assert.ok(/import\s*\{[^}]*applyPaymentEmailEvents[^}]*\}\s*from\s*'[^']*paymentEmailWebhook\.js'/.test(CODE),
    'applyPaymentEmailEvents を単一源から import していない');
  assert.ok(!/decideWebhookEvent|decideWebhookTransition/.test(CODE),
    'Function 内で状態遷移判定を直接呼んでいる（判定は paymentEmailWebhook.js 経由に限る）');
  assert.ok(!/PaymentEmailStatus\s*:/.test(CODE),
    'Function が PaymentEmailStatus を直接組み立てている（状態機械の外で書いている）');
});

test('guard: Payment Email 反映は署名検証を通過した後にだけ実行される', () => {
  const verifyIdx = CODE.indexOf('if (!verification.ok)');
  const applyIdx = CODE.indexOf('applyPaymentEmailEvents(');
  assert.ok(verifyIdx > -1, '署名検証の失敗ガードが見つからない');
  assert.ok(applyIdx > verifyIdx, '署名検証より前に Payment Email 反映へ到達しうる');
});

test('guard: Payment Email 反映は本番 Customers の deps を単一源から受け取る', () => {
  assert.ok(/import\s*\{[^}]*getRecord[^}]*patchRecord[^}]*\}\s*from\s*'[^']*paymentEmailDeps\.js'/.test(CODE),
    'Airtable アクセスを paymentEmailDeps.js 経由で受け取っていない（接続先が二重定義になる）');
  assert.ok(!/AIRTABLE_CUSTOMERS_TABLE|['"]Customers['"]/.test(CODE),
    'Function が Customers テーブル名を直接持っている');
});

test('guard: Payment Email 反映の失敗で suppression 側を巻き添えにしない', () => {
  const m = CODE.match(/let paymentEmail[\s\S]*?applyPaymentEmailEvents\([\s\S]*?\n    \} catch \{/);
  assert.ok(m, 'Payment Email 反映が try/catch で隔離されていない');
});

test('guard: 応答・ログに識別子を出さない（集計のみ）', () => {
  // 応答に載せてよいのは **集計オブジェクトだけ**（識別子・アドレスを載せない）
  assert.match(CODE, /return jsonResponse\(200, \{[^}]*paymentEmail/, 'paymentEmail の集計を返していない');
  assert.match(CODE, /return jsonResponse\(200, \{[^}]*ledger/, '台帳の集計を返していない');
  assert.ok(!/console\.log\([^)]*record_id/.test(CODE), 'ログに record_id を出している');
  assert.ok(!/console\.log\([^)]*idempotency_key/.test(CODE), 'ログに冪等キーを出している');
});

// ── 配信反応の恒久台帳（2026-08-01 / 既定 OFF）────────────────────
test('guard: 台帳書き込みは env が true のときだけ（既定 OFF）', () => {
  assert.match(CODE, /isLedgerWriteEnabled\(process\.env\)/, 'env gate を通していない');
  // gate を通らない経路で書き込み経路へ到達しないこと
  const fn = CODE.slice(CODE.indexOf('async function applyEmailEventLedger'));
  const gateAt = fn.indexOf('const enabled =');
  const returnAt = fn.indexOf('if (!enabled)');
  const writeAt = fn.indexOf('writeLedgerRows(');
  assert.ok(gateAt > 0, 'gate が見つからない');
  assert.ok(returnAt > gateAt, 'gate 直後に早期 return していない');
  assert.ok(writeAt > returnAt, 'gate の早期 return より前に書き込みへ到達しうる');
});

test('guard: 台帳の判定・列組み立てを Function 側に再実装しない', () => {
  assert.match(CODE, /emailEventLedger\.js/, '単一源を経由していない');
  assert.match(CODE, /buildLedgerBatch/);
  assert.match(CODE, /assertOnlyLedgerFields/, '書き込み列を検証していない');
  // 列名を Function に直書きしない
  for (const col of ['EventType:', 'EmailHash:', 'UrlCategory:']) {
    assert.equal(CODE.includes(col), false, `列 ${col} を Function 側で組み立てている`);
  }
});

test('guard: 台帳は EventKey をマージキーに upsert する（再受信で増えない）', () => {
  // upsert の組み立ては書き込みの単一源（emailEventLedgerWriter.js）に集約されている
  assert.match(WRITER, /fieldsToMergeOn: \['EventKey'\]/, '冪等な upsert になっていない');
  assert.ok(!/fieldsToMergeOn/.test(CODE),
    'Function 側で upsert 本文を組み立てている（書き込みは単一源に集約すること）');
});

test('guard: 台帳の書き込みは単一源 emailEventLedgerWriter.js に委譲する（Function に再実装しない）', () => {
  assert.match(CODE, /emailEventLedgerWriter\.js/, '書き込みの単一源を経由していない');
  assert.match(CODE, /writeLedgerRows\(/, '単一源の書き込み関数を呼んでいない');
  // 台帳用の Airtable URL / リクエスト本文を Function 側で組み立てない
  assert.ok(!/EMAIL_EVENTS_TABLE\}`/.test(CODE), 'Function が台帳の Airtable URL を組み立てている');
  assert.ok(!/performUpsert/.test(CODE), 'Function が upsert 本文を組み立てている');
});

test('guard: 台帳の失敗を沈黙させない（集計を応答へ返す）', () => {
  const fn = CODE.slice(CODE.indexOf('async function applyEmailEventLedger'));
  for (const key of ['attempted', 'written', 'failed', 'failureReasons']) {
    assert.ok(fn.includes(key), `台帳の集計 ${key} を返していない（失敗が観測できない）`);
  }
});

// ── 書き込み単一源（emailEventLedgerWriter.js）の耐障害契約 ──────────
test('guard(writer): 再試行は上限つきで、無限ループを持たない', () => {
  assert.match(WRITER, /LEDGER_MAX_ATTEMPTS\s*=\s*\d+/, '試行回数の上限が定数化されていない');
  assert.match(WRITER, /LEDGER_MAX_BACKOFF_MS\s*=\s*\d+/, 'backoff の上限が定数化されていない');
  assert.ok(!/while\s*\(\s*true\s*\)/.test(WRITER), '無限ループがある');
  assert.match(WRITER, /attempt <= LEDGER_MAX_ATTEMPTS/, '試行回数で打ち切っていない');
});

test('guard(writer): 恒久エラー（403 / 404 / 422 / 400）を再試行しない', () => {
  for (const status of ['403', '404', '422', '400']) {
    const re = new RegExp(`status === ${status}\\) return \\{[^}]*retryable: false`);
    assert.match(WRITER, re, `${status} を再試行対象にしている`);
  }
  assert.match(WRITER, /status === 429\) return \{[^}]*retryable: true/, '429 を再試行していない');
  assert.match(WRITER, /status >= 500\) return \{[^}]*retryable: true/, '5xx を再試行していない');
});

test('guard(writer): Airtable の応答本文・例外本文を読まない（PII / secret 混入の遮断）', () => {
  const code = WRITER.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.text\(\)/.test(code), '応答本文を読んでいる');
  assert.ok(!/\.json\(\)/.test(code), '応答本文を読んでいる');
  assert.ok(!/err\.message|error\.message/.test(code), '例外メッセージを扱っている');
  assert.ok(!/console\.(log|warn|error)/.test(code), '書き込み層でログを出している（集計は呼び出し側で出す）');
});

test('guard(writer): バッチ上限は Airtable の 10 件を超えない', () => {
  assert.match(WRITER, /LEDGER_BATCH_SIZE\s*=\s*10/, 'バッチ上限が 10 件ではない');
  assert.match(WRITER, /Math\.min\(Number\(size\)[^)]*LEDGER_BATCH_SIZE\)/, 'バッチサイズの上限を強制していない');
});

test('guard: 台帳へ IP / User-Agent / 生 URL / 生アドレスを渡さない', () => {
  // 台帳関数の**本体だけ**を見る（後続の processFailureEvent を巻き込まない）
  const from = CODE.indexOf('async function applyEmailEventLedger');
  const to = CODE.indexOf('function shouldProcessEvent', from);
  const fn = CODE.slice(from, to > from ? to : undefined);
  for (const banned of ['event.ip', 'useragent', 'event.url', 'event.email']) {
    assert.equal(fn.includes(banned), false, `${banned} を台帳経路で扱っている`);
  }
});

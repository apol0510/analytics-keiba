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
  assert.ok(/equalsFormula\(/.test(CODE), 'formula 組立を単一源経由にしていない');
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

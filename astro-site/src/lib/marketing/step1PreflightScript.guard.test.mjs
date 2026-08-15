/**
 * step1PreflightScript.guard.test.mjs — preflight スクリプトが read-only のままであることの監視
 *   node --test src/lib/marketing/step1PreflightScript.guard.test.mjs
 *
 * ソースを文字列として検査する。**「読むだけ」の道具に後から書き込みが混ざる**のが
 * いちばん危ないため（承認前に走らせる想定なので、混ざったら承認なしで書いてしまう）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, '../../../scripts/light-trial-step1-preflight.mjs');
const SRC = readFileSync(SCRIPT_PATH, 'utf8');

test('【重要】書き込みを伴うアクションを呼ばない', () => {
  for (const bad of ["'dryRun'", "'send'", "'cancelJob'", '"dryRun"', '"send"', '"cancelJob"']) {
    assert.equal(SRC.includes(bad), false, `書き込み系アクション ${bad} が入っている`);
  }
});

test('【重要】呼べるアクションが許可リストで固定されている', () => {
  assert.match(SRC, /READ_ONLY_ACTIONS\s*=\s*Object\.freeze\(\[/, '許可リストが凍結されていない');
  assert.match(SRC, /READ_ONLY_ACTIONS\.includes\(action\)/, '許可リストの検査が無い');
  // 許可されているのは 3 つだけ
  const list = SRC.match(/READ_ONLY_ACTIONS = Object\.freeze\(\[(.*?)\]\)/s);
  assert.ok(list, '許可リストを読めない');
  const items = list[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(items.sort(), ['duplicateCheck', 'jobs', 'sequence', 'trialGrant'].sort());
});

test('【重要】Airtable / SendGrid を直接叩かない', () => {
  for (const bad of ['api.airtable.com', 'api.sendgrid.com', 'AIRTABLE_API_KEY', 'SENDGRID_API_KEY']) {
    assert.equal(SRC.includes(bad), false, `${bad} を直接参照している`);
  }
});

test('【重要】HTTP メソッドは POST（read-only アクション）だけで、書き込み動詞を使わない', () => {
  for (const bad of ["method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'", 'performUpsert']) {
    assert.equal(SRC.includes(bad), false, `${bad} が入っている`);
  }
});

test('【重要】secret の「値」を出力しない', () => {
  // 禁止するのは **値**（変数 SECRET）の出力。
  // 「MARKETING_ADMIN_SECRET が未設定です」のような **env 名の言及は必要**なので通す
  //（未設定のとき何を入れればよいか分からなくなる）。
  // lookbehind で `_SECRET` / `ADMIN_SECRET` のような名前の一部を除外する。
  assert.equal(/console\.\w+\([^)]*(?<![A-Z_])SECRET\b/.test(SRC), false, 'secret の値を出力している');
  assert.equal(SRC.includes('${SECRET}'), false, 'secret を文字列へ埋め込んでいる');
  // 送信先ヘッダ以外で secret を使っていないこと
  const uses = SRC.match(/(?<![A-Z_])SECRET\b/g) || [];
  assert.ok(uses.length <= 4, `secret の参照が多すぎる（${uses.length} 箇所）`);
});

test('判定に失敗したら非ゼロで終わる（沈黙して通さない）', () => {
  assert.match(SRC, /process\.exit\(result\.ok \? 0 : 1\)/);
  // 取得に失敗しても「成功」で抜けない
  assert.equal(/catch[\s\S]{0,200}process\.exit\(0\)/.test(SRC), false, '失敗時に 0 で抜ける経路がある');
});

test('取得に失敗しても評価をスキップしない（null のまま fail closed へ渡す）', () => {
  assert.match(SRC, /evaluateStep1Preflight\(\{[\s\S]*?sequence, trialGrant, jobs, duplicateCheck/);
});

test('【重要】重複確認は sequence が確定した候補にだけ掛ける（campaign 全履歴を見ない）', () => {
  assert.match(SRC, /callReadOnly\('duplicateCheck', \{ step: next\.step, recordIds: next\.recordIds \}\)/,
    '候補を渡していない');
  // 候補が無いときは呼ばない（呼んでも判定できない）
  assert.match(SRC, /Array\.isArray\(next\.recordIds\) && next\.recordIds\.length > 0/);
});

test('CI（check:safety）に組み込まれていない（本番へ通信する道具のため）', async () => {
  const pkg = JSON.parse(readFileSync(resolve(HERE, '../../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:safety'].includes('light-trial-step1'), false,
    'CI から本番の管理エンドポイントを叩くことになっている');
  assert.ok(pkg.scripts['preflight:light-trial-step1'], '手動実行のエントリが無い');
});

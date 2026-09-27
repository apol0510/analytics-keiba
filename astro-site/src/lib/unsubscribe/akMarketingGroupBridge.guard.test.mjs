/**
 * 配信停止の橋渡しの**配線**を固定する（`sendgrid-webhook.js` / `unsubscribe.js`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CUSTOMER_UNSUBSCRIBE_FIELDS, AK_MARKETING_GROUP } from './akMarketingGroupBridge.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const WEBHOOK = read('../../../netlify/functions/sendgrid-webhook.js');
const UNSUB = read('../../../netlify/functions/unsubscribe.js');
const BRIDGE = read('./akMarketingGroupBridge.js');

test('webhook: 署名検証を通ってから橋渡しへ進む（迂回しない）', () => {
  const verify = WEBHOOK.indexOf('if (!verification.ok)');
  const bridge = WEBHOOK.indexOf('applyGroupEventsToCustomers({');
  assert.ok(verify > 0 && bridge > 0);
  assert.ok(bridge > verify, '署名検証より前で Customers を触っている');
  // 署名不一致は Customers に触る前に 401/403 で返っている
  const reject = WEBHOOK.indexOf("return jsonResponse(signatureFailureStatus(), { error: 'Forbidden', reason: verification.reason });");
  assert.ok(reject > verify && reject < bridge);
});

test('webhook: 橋渡しは独立した try/catch（既存の段を止めない）・再送を要求しない', () => {
  const start = WEBHOOK.indexOf('── 8. AK Marketing group');
  const end = WEBHOOK.indexOf('\n    }\n', WEBHOOK.indexOf('} catch {', start)) + 6;
  const block = WEBHOOK.slice(start, end);
  assert.match(block, /try \{[\s\S]*applyGroupEventsToCustomers[\s\S]*\} catch \{/);
  assert.ok(!/retry/.test(block.replace(/再送は要求しない/g, '')), '橋渡しの失敗で再送を要求しない');
  // 既存の suppression（EmailBlacklist）処理は従来どおり
  assert.match(WEBHOOK, /'unsubscribe'\s+\/\/ 配信停止/);
  assert.ok(!/group_unsubscribe/.test(WEBHOOK.slice(WEBHOOK.indexOf('function shouldProcessEvent'), WEBHOOK.indexOf('async function processFailureEvent'))),
    'group_unsubscribe を EmailBlacklist 経路へ混ぜない');
});

test('webhook: ログへ出すのは件数の要約だけ', () => {
  assert.match(WEBHOOK, /akMarketingGroup,\n\s+\}\);/);
  assert.ok(!/console\.[a-z]+\([^)]*event\.email/.test(WEBHOOK));
});

test('unsubscribe: SendGrid の同期は planAkGroupSync の判定どおり・署名検証の後だけ', () => {
  const start = UNSUB.indexOf('── AK → SendGrid');
  assert.ok(start > 0);
  const block = UNSUB.slice(start, UNSUB.indexOf('console.log(`✅ unsubscribe ok', start));
  assert.match(block, /planAkGroupSync\(\{ brand, action: requestedAction, customerSink: sinkResults\[SINK\.CUSTOMER\] \}\)/);
  assert.match(block, /if \(syncPlan === 'add'\) \{\s*const r = await addToAkMarketingGroupSuppression/);
  assert.match(block, /else if \(syncPlan === 'remove'\) \{\s*const r = await removeFromAkMarketingGroupSuppression/);
  // 同期の結果で応答や AK 側の状態を変えない（状態コードを残すだけ）
  assert.ok(!/return new Response/.test(block), '同期の結果で応答を分岐している');
  assert.ok(!/updateUnsubscribeStatus/.test(block), '同期の結果で AK 側を書き戻している');
  // 署名検証の後
  assert.ok(UNSUB.indexOf('verifyUnsubscribeSignature({') < start);
  // 呼び出しはこの 1 箇所だけ
  assert.equal((UNSUB.match(/removeFromAkMarketingGroupSuppression\(/g) || []).length, 1);
  assert.equal((UNSUB.match(/addToAkMarketingGroupSuppression\(/g) || []).length, 1);
});

test('Customers の列名は unsubscribe.js の analytics-keiba 設定と同じ', () => {
  const m = /'analytics-keiba': \{\s*flag: '([^']+)',\s*at: '([^']+)',\s*baseEnv: '([^']+)'/.exec(UNSUB);
  assert.ok(m);
  assert.deepEqual([m[1], m[2], m[3]], [CUSTOMER_UNSUBSCRIBE_FIELDS.flag, CUSTOMER_UNSUBSCRIBE_FIELDS.at, CUSTOMER_UNSUBSCRIBE_FIELDS.baseEnv]);
});

test('橋渡しモジュールは AK Marketing 以外の group id・全体停止 API を持たない', () => {
  const ids = (BRIDGE.match(/\b\d{5}\b/g) || []).filter((n) => n !== String(AK_MARKETING_GROUP.id));
  assert.deepEqual(ids, [], `AK Marketing 以外の group id: ${ids}`);
  for (const banned of ['/v3/asm/suppressions/global', '/v3/suppression/unsubscribes', "'/contacts/search", '`/contacts/search', '/v3/marketing/contacts']) {
    assert.ok(!BRIDGE.includes(banned), banned);
  }
  // DELETE は 1 箇所だけで、宛先は AK Marketing の group suppression（id は単一源から）
  const deletes = BRIDGE.match(/method: 'DELETE'/g) || [];
  assert.equal(deletes.length, 1);
  const delAt = BRIDGE.indexOf("method: 'DELETE'");
  const delCall = BRIDGE.slice(BRIDGE.lastIndexOf('fetchImpl(', delAt), delAt);
  assert.match(delCall, /`https:\/\/api\.sendgrid\.com\/v3\/asm\/groups\/\$\{AK_MARKETING_GROUP\.id\}\/suppressions\/\$\{encodeURIComponent\(e\)\}`/);
  // DELETE の前に、所属の確認で 34108 に停止中であることを見ている
  const fn = BRIDGE.slice(BRIDGE.indexOf('export async function removeFromAkMarketingGroupSuppression'), delAt);
  assert.match(fn, /verifyAkGroup\(/);
  assert.match(fn, /Number\(x\.id\) === AK_MARKETING_GROUP\.id/);
  assert.match(fn, /ak\.suppressed !== true/);
  assert.ok(!/console\./.test(BRIDGE), 'モジュール内でログを出さない（呼び出し側が件数だけ出す）');
});

test('AK Marketing の id・名前は akMarketingGroup.js だけに書く（直書きしない）', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap((n) => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : (/\.(m?js|ts|astro)$/.test(n) && !/\.test\.|\.guard\./.test(n) ? [p] : []);
  });
  const hits = [];
  for (const dir of ['src', 'netlify', 'scripts']) {
    for (const f of walk(join(root, dir))) {
      if (f.endsWith('src/lib/unsubscribe/akMarketingGroup.js')) continue;
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/\b34108\b|['"`]AK Marketing['"`]/.test(code)) hits.push(f.slice(root.length));
    }
  }
  assert.deepEqual(hits, []);
});

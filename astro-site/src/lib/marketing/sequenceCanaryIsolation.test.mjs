/**
 * sequenceCanaryIsolation.test.mjs — **canary の設定を他 campaign へ漏らさない**
 *   node --test src/lib/marketing/sequenceCanaryIsolation.test.mjs
 *
 * ## なぜ要るか（2026-09-14 の本番事故）
 *
 * canary のために `MARKETING_SEQUENCE_SOURCE_FILTER=prospect` を **production env** へ置いた。
 * ところが `cron-drm-autostart` は
 *
 *     const tickEnv = { ...env, MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true', ... };
 *     await runSequenceTick({ env: tickEnv, campaignId });
 *
 * と **process env をまるごと引き継ぐ**。つまり
 *
 *   - DRM の入口（Customers が対象）にも `sourceFilter=prospect` が効き、
 *     **対象が黙って 0 人になる**
 *   - しかも DRM は `SCHEDULER_ENABLED: 'true'` を自分で合成するので、
 *     **`scheduler=false` にしても止まらない**
 *
 * 「scheduler を閉じてあるから無害」ではなかった。
 *
 * ## 固定すること
 *
 *   1. 絞り込みは **呼び出しの引数**でだけ決まる（**env から読まない**）
 *   2. したがって env に何が入っていても **他 campaign へ漏れない**
 *   3. canary は **campaign を明示**し、既定値で他 campaign を巻き込まない
 *   4. `expectedCount` と一致しなければ **1 件も積まない**（count drift は fail closed）
 *   5. `sourceFilter` を指定したのに別の出所が混ざったら **fail closed**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const DRM = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-drm-autostart.js', import.meta.url)),
  'utf8',
);
const ADMIN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)),
  'utf8',
);
const BG = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/sequence-canary-background.js', import.meta.url)),
  'utf8',
);
/** 入口（受け付けだけ）の本体 */
const adminBody = () => {
  const i = ADMIN.indexOf('async function handleSequenceCanaryRun');
  assert.ok(i > 0, 'canary の入口が無い');
  return ADMIN.slice(i, i + 5000);
};

test('【重要】絞り込みは env から読まない（他 campaign へ漏らさない）', () => {
  /**
   * ⚠️ ここが `resolveAudienceFilter(env)` に戻ると、DRM の `tickEnv = { ...env }` を
   *    通じて DRM の対象が黙って 0 人になる（2026-09-14 に本番で踏んだ）。
   */
  assert.doesNotMatch(CRON, /resolveAudienceFilter\(env\)/, 'env から絞り込みを読んでいる');
  assert.doesNotMatch(CRON, /MARKETING_SEQUENCE_SOURCE_FILTER/,
    'cron が絞り込みの env 名を参照している');
  // 引数で受け取る形になっていること
  assert.match(CRON, /sourceFilter = null,/, '絞り込みを引数で受け取っていない');
});

test('【重要】DRM は env をまるごと引き継ぐので、env 経由の設定は必ず漏れる', () => {
  // この事実自体は DRM 側の設計。だからこそ marketing 側が env を読まないことが要る
  assert.match(DRM, /const tickEnv = \{\s*\n?\s*\.\.\.env,/, 'DRM の env 引き継ぎが変わった');
  assert.match(DRM, /MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true'/,
    'DRM が scheduler を合成しなくなった（前提が変わったので読み直すこと）');
});

test('【重要】canary は campaign を明示する（既定で他 campaign を巻き込まない）', async () => {
  assert.match(ADMIN, /action === 'sequenceCanaryRun'/, 'canary の入口が無い');
  const policy = await import('./sequenceCanaryPolicy.js');
  // 許可リストに DRM は入っていない
  assert.deepEqual([...policy.CANARY_CAMPAIGNS], ['campaign-discount-free']);
  assert.equal(policy.CANARY_CAMPAIGNS.includes('free-signup-onboarding'), false, 'DRM が許可されている');
  // campaignId 未指定・別 campaign は不合格（既定値へ倒れない）
  const base = {
    sourceFilter: 'prospect', maxPerTick: 50, expectedCount: 50,
    confirm: policy.CANARY_CONFIRM, apply: true,
  };
  assert.equal(policy.checkCanaryRequest({ ...base }).ok, false, 'campaignId 無しで通る');
  assert.equal(policy.checkCanaryRequest({ ...base, campaignId: 'free-signup-onboarding' }).ok, false,
    'DRM の campaign で通る');
  assert.equal(policy.checkCanaryRequest({ ...base, campaignId: 'campaign-discount-free' }).ok, true);
});

test('【重要】count drift は fail closed（expectedCount と違えば 1 件も積まない）', () => {
  assert.match(CRON, /expectedCount = null,/, 'expectedCount を受け取っていない');
  assert.match(CRON, /abort: 'expected_count_mismatch'/, 'count drift で止めていない');
  // 予約より手前で止まること
  const iCheck = CRON.indexOf("abort: 'expected_count_mismatch'");
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iCheck > 0 && iCheck < iClaim, 'count drift の判定が予約より後ろにある');
});

test('【重要】出所が混ざったら fail closed', () => {
  assert.match(CRON, /abort: 'audience_source_mixed'/, '出所混入で止めていない');
  const iCheck = CRON.indexOf("abort: 'audience_source_mixed'");
  const iClaim = CRON.indexOf('claimDelivered(');
  assert.ok(iCheck > 0 && iCheck < iClaim, '出所混入の判定が予約より後ろにある');
});

test('【重要】canary は通常経路を迂回しない', () => {
  // 送信・キュー登録は runSequenceTick に委譲する（自前で作らない）
  assert.match(BG, /runSequenceTick\(\{/, 'canary が tick を通っていない');
  for (const banned of ['sendgrid', 'SENDGRID_API_KEY', 'claimDelivered(', 'buildCampaignPlan(', 'performUpsert']) {
    assert.equal(BG.includes(banned), false, `canary が経路を作り直している: ${banned}`);
    assert.equal(adminBody().includes(banned), false, `入口が経路を作り直している: ${banned}`);
  }
});

/**
 * ## 【重要】重い処理は同期 Function で走らせない（2026-09-15 本番実測）
 *
 * 入口から直接 `runSequenceTick` を呼んだら **HTTP 504（31 秒）**で打ち切られた。
 * 関数の完了ログすら出ていない。書き込みは 1 件も起きなかったが、**完走できない**。
 * `runSequenceTick` は配信台帳の走査と prospect 索引 11,971 件の読み込みを行うため、
 * 同期 Function の制限時間には収まらない。
 * #529 が DRM の入口で解決済みの問題と同型なので、同じ形（Background）に揃える。
 */
test('【重要】入口は tick を直接回さない（504 になる）', () => {
  const body = adminBody();
  assert.equal(body.includes('runSequenceTick('), false,
    '入口が同期で tick を回している（504 になる）');
  assert.match(body, /sequence-canary-background/, 'Background へ委譲していない');
  assert.match(body, /return json\(202,/, '202 即返しになっていない');
});

test('【重要】Background は「誰に送るか」を受け取らない', async () => {
  const policy = await import('./sequenceCanaryPolicy.js');
  // payload の鍵は宣言したものだけ。アドレスも recordId も入らない
  assert.deepEqual([...policy.CANARY_PAYLOAD_KEYS].sort(),
    ['apply', 'campaignId', 'confirm', 'expectedCount', 'maxPerTick', 'runId', 'sourceFilter'].sort());
  const built = policy.buildCanaryPayload(
    { campaignId: 'campaign-discount-free', sourceFilter: 'prospect', maxPerTick: 50, expectedCount: 50 },
    'canary-test',
  );
  for (const k of Object.keys(built)) {
    assert.ok(policy.CANARY_PAYLOAD_KEYS.includes(k), `宣言外の鍵が混ざっている: ${k}`);
  }
  for (const banned of ['emails', 'recipients', 'recordIds', 'targets']) {
    assert.equal(k_in(built, banned), false, `payload に宛先が混ざっている: ${banned}`);
  }
  function k_in(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
});

test('【重要】Background は入口を信用せず、同じ単一源でもう一度確かめる', () => {
  assert.match(BG, /checkCanaryRequest\(body\)/, 'Background が受け付け判定をやり直していない');
  assert.match(BG, /x-admin-secret/, 'Background が secret を確認していない');
  assert.match(BG, /if \(!checked\.ok\)/, '不合格でも走ってしまう');
  // 判定の実体は 1 か所（両側が同じ関数を import している）
  assert.match(ADMIN, /sequenceCanaryPolicy\.js/, '入口が単一源を使っていない');
  assert.match(BG, /sequenceCanaryPolicy\.js/, 'Background が単一源を使っていない');
});

test('【重要】canary は 1 回限り（繰り返し送る作りにしない）', async () => {
  assert.equal(/for \(|while \(/.test(adminBody()), false, '入口に繰り返しがある');
  const bgBody = BG.slice(BG.indexOf('export default async function handler'));
  assert.equal(/for \(|while \(/.test(bgBody), false, 'Background に繰り返しがある');
  // confirm と apply が無ければ不合格
  const policy = await import('./sequenceCanaryPolicy.js');
  const ok = {
    campaignId: 'campaign-discount-free', sourceFilter: 'prospect',
    maxPerTick: 50, expectedCount: 50, confirm: policy.CANARY_CONFIRM, apply: true,
  };
  assert.equal(policy.checkCanaryRequest({ ...ok, confirm: 'RUN' }).ok, false, 'confirm 無しで通る');
  assert.equal(policy.checkCanaryRequest({ ...ok, apply: false }).ok, false, 'apply=false で通る');
  assert.equal(policy.checkCanaryRequest({ ...ok, apply: 'true' }).ok, false, '文字列の apply で通る');
  assert.equal(policy.checkCanaryRequest(ok).ok, true);
});

test('【重要】上限と期待件数は必ず縛る（上限超え・件数不一致は受け付けない）', async () => {
  const policy = await import('./sequenceCanaryPolicy.js');
  const ok = {
    campaignId: 'campaign-discount-free', sourceFilter: 'prospect',
    maxPerTick: 50, expectedCount: 50, confirm: policy.CANARY_CONFIRM, apply: true,
  };
  for (const bad of [0, -1, 51, 1000, 1.5, 'abc', '', null, undefined, NaN, Infinity]) {
    assert.equal(policy.checkCanaryRequest({ ...ok, maxPerTick: bad }).ok, false, `maxPerTick=${bad}`);
  }
  for (const bad of [0, -1, 51, 1.5, 'abc', '', null, undefined, NaN, Infinity]) {
    assert.equal(policy.checkCanaryRequest({ ...ok, expectedCount: bad }).ok, false, `expectedCount=${bad}`);
  }
  // 数字そのものの文字列は受け付ける（値が一意に決まるので曖昧さが無い）
  assert.equal(policy.checkCanaryRequest({ ...ok, maxPerTick: '50', expectedCount: '50' }).ok, true);
  // expectedCount は maxPerTick を超えられない
  assert.equal(policy.checkCanaryRequest({ ...ok, maxPerTick: 10, expectedCount: 50 }).ok, false);
  // 出所は prospect 固定
  for (const bad of ['customer', 'all', '', 'PROSPECTS', null]) {
    assert.equal(policy.checkCanaryRequest({ ...ok, sourceFilter: bad }).ok, false, `sourceFilter=${bad}`);
  }
});

test('【重要】canary は env を書き換えない（他 campaign へ影響させない）', () => {
  for (const [name, src] of [['入口', adminBody()], ['Background', BG]]) {
    assert.equal(/process\.env\.[A-Z_]+\s*=/.test(src), false, `${name} が env を書き換えている`);
    assert.doesNotMatch(src, /MARKETING_SEQUENCE_SOURCE_FILTER/, `${name} が env 名に依存している`);
  }
  /**
   * 開けるのは**スケジューラ判定 1 つだけ**。
   * `runSequenceTick` へ渡す env の上書きが 1 行だけであることを、
   * オブジェクトリテラルそのものを取り出して確かめる（コメントの言及では落ちない）。
   */
  const envArg = BG.match(/env: \{ \.\.\.process\.env,([^}]*)\}/);
  assert.ok(envArg, 'tick へ渡す env の形が変わっている');
  const overrides = envArg[1].split(',').map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(overrides, ["[SEQUENCE_ENV.SCHEDULER]: 'true'"],
    `スケジューラ判定以外も開けている: ${overrides.join(' / ')}`);
});

// ══════════════════════════════════════════════════════════════════
//  鍵の配線（2026-09-15 の本番 500）
// ══════════════════════════════════════════════════════════════════

/**
 * ## 何が起きたか
 *
 * canary を本番で 1 回叩いたら **500（606ms）** で即死した。
 * 原因は `createDispatchLock({ redisCmd: ... })` — 正しい引数名は **`cmd`**。
 * `createDispatchLock` は `cmd` が関数でなければ即 throw する。
 *
 * 字面だけを見る guard では**引数名の取り違え**を捕まえられなかったので、
 * ここでは **本物の `createDispatchLock` を呼んで**契約を固定する。
 *
 * ⚠️ 実害は無かった（予約・queue・送信はいずれも 0 のまま fail closed した）が、
 *    「動かない canary を本番へ出した」こと自体を再発させない。
 */
test('【重要】鍵の引数名は cmd（redisCmd では作れない）', async () => {
  const { createDispatchLock } = await import('./dispatchLock.js');
  const cmd = async () => null;
  // 正しい形は作れる
  assert.ok(createDispatchLock({ cmd, root: 'ak:test-lock:' }));
  // 間違った名前は**黙って通らない**（通ると本番で 500 になる）
  assert.throws(() => createDispatchLock({ redisCmd: cmd, root: 'ak:test-lock:' }),
    /cmd/, 'redisCmd でも鍵が作れてしまう');
});

test('【重要】鍵を作る箇所は全部 cmd: を渡している', () => {
  /**
   * `createDispatchLock({` を呼ぶ場所は、どのファイルでも `cmd:` でなければならない。
   * 1 か所でも `redisCmd:` に戻ると、その経路は実行時まで気付けずに 500 になる。
   */
  const files = {
    'admin-marketing.js': ADMIN,
    'cron-campaign-sequence.js': CRON,
    'cron-marketing-dispatch.js': readFileSync(
      fileURLToPath(new URL('../../../netlify/functions/cron-marketing-dispatch.js', import.meta.url)), 'utf8'),
    'sequence-canary-background.js': BG,
  };
  for (const [name, src] of Object.entries(files)) {
    const calls = src.match(/createDispatchLock\(\{[^}]*\}/g) || [];
    for (const call of calls) {
      assert.match(call, /\bcmd:/, `${name}: 鍵の引数名が cmd ではない → ${call}`);
      assert.equal(/\bredisCmd:/.test(call), false, `${name}: redisCmd を渡している → ${call}`);
    }
  }
});

/**
 * `acquire` は **`{ ok, token }`** を返す。生のトークンではない。
 *
 * ⚠️ ここを `const token = await lock.acquire(...)` と書くと
 *   - 取れなかったとき（`{ok:false}`）も**真値なので通ってしまう**＝鍵無しで走る
 *   - 取れたときも `release` に渡す token が違うので**鍵を返せない**（TTL 切れまで居座る）
 *   どちらも「二重起動を防ぐ」という鍵の目的を壊す。
 */
test('【重要】acquire の戻り値は { ok, token }（生のトークンではない）', async () => {
  const { createDispatchLock } = await import('./dispatchLock.js');
  const busy = createDispatchLock({ root: 'ak:test-lock:', cmd: async (a) => (a[0] === 'INCR' ? 1 : null) });
  const got = await busy.acquire({ jobId: 'tick:test', ttlSec: 10 });
  assert.equal(got.ok, false, '取れなかったのに ok:true');
  assert.ok(got, '戻り値そのものは真値 → `if (!token)` では弾けない（だから ok を見る）');

  const free = createDispatchLock({ root: 'ak:test-lock:', cmd: async (a) => (a[0] === 'INCR' ? 7 : 'OK') });
  const ok = await free.acquire({ jobId: 'tick:test', ttlSec: 10 });
  assert.deepEqual(ok, { ok: true, token: '7' });
});

test('【重要】canary は鍵の戻り値を ok で判定し、取れなければ走らない', () => {
  const body = BG;
  assert.match(body, /const got = await lock\.acquire\(\{/, '鍵の取得が定期 tick と違う形');
  assert.match(body, /if \(!got\.ok\)/, 'ok を見ずに判定している');
  assert.match(body, /token = got\.token/, 'token を取り出していない');
  // 取れなかったら tick を回さない
  const iAcq = body.indexOf('lock.acquire({');
  const iRun = body.indexOf('runSequenceTick({');
  assert.ok(iAcq > 0 && iRun > iAcq, '鍵より前に tick が走る');
  // 鍵を持っているときだけ返す
  assert.match(body, /if \(lock && token\)/, '鍵を持っていなくても release しようとしている');
});

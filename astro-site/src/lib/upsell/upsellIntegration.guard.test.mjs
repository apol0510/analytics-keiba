/**
 * upsellIntegration.guard.test.mjs — 販売導線の配線をソースで固定する
 *   node --test src/lib/upsell/upsellIntegration.guard.test.mjs
 *
 * 「実装を後から書き換えても壊せない」性質:
 *   1. 顧客側の表示判断は単一源（upsellTarget.js）を通る。ページに条件を再実装しない
 *   2. 三連複の段階表示（既存 sanrenpukuCtaStage.js）を迂回・改変しない
 *   3. 管理 API が書くのは `UpsellTarget` 1 列だけ。権限・課金フィールドを書かない
 *   4. 書き込みは env gate（UPSELL_TARGET_FIELD_READY）で閉じている
 *   5. Premium Plus の存在秘匿を保つ（plus 以外へ phase / 受付状況を返さない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const upsellApi = read('../../pages/api/upsell.json.js');
const stageApi = read('../../pages/api/premium-plus-stage.json.js');
const adminFn = read('../../../netlify/functions/premium-plus-eligibility.js');
const adminPage = read('../../pages/admin/premium-plus-eligibility.astro');
const dashboard = read('../../pages/dashboard.astro');
const jra = read('../../pages/premium-prediction/jra.astro');
const nankan = read('../../pages/premium-prediction/nankan.astro');
const plusV2 = read('../../pages/premium-plus-v2.astro');
const plusV1 = read('../../pages/premium-plus.astro');
const stageLib = read('../sanrenpuku/sanrenpukuCtaStage.js');

// ── 1. 単一源を通る ───────────────────────────────────────────

test('1. 販売導線を出すページは単一源 resolver を経由する', () => {
  for (const [name, src] of [['/api/upsell.json', upsellApi], ['/api/premium-plus-stage.json', stageApi],
    ['premium-plus-v2', plusV2], ['premium-plus', plusV1], ['admin function', adminFn]]) {
    assert.ok(/resolveUpsellForCustomer/.test(src), `${name}: 単一源を経由していない`);
  }
  // クライアント側は共有ヘルパ経由（ページごとに fetch を書かない）
  for (const [name, src] of [['dashboard', dashboard], ['premium-prediction/jra', jra],
    ['premium-prediction/nankan', nankan]]) {
    assert.ok(/upsell\/upsellClient\.js/.test(src), `${name}: 共有クライアントを使っていない`);
    assert.equal(/fetch\(['"]\/api\/upsell\.json/.test(src), false, `${name}: ページで直接 fetch している`);
  }
});

test('1-b. 商品ページ / 予告 API は channel が plus でなければ 404（2 商品を並べない）', () => {
  for (const [name, src] of [['premium-plus-v2', plusV2], ['premium-plus', plusV1]]) {
    assert.ok(/ppUpsell\.channel !== UPSELL_CHANNEL\.PLUS/.test(src), `${name}: channel を見ていない`);
  }
  assert.ok(/upsell\.channel !== UPSELL_CHANNEL\.PLUS\) return notFound\(\)/.test(stageApi),
    'stage API が channel を見ていない');
});

// ── 2. 既存の段階表示を壊さない ─────────────────────────────────

test('2. 三連複の段階表示ロジック（既存の単一源）を迂回しない', () => {
  for (const [name, src] of [['premium-prediction/jra', jra], ['premium-prediction/nankan', nankan]]) {
    // 既存の段階判定を引き続き使っている
    assert.ok(/planSanrenpukuDisplay/.test(src), `${name}: 既存の段階判定を外している`);
    assert.ok(/isFunnelTarget/.test(src), `${name}: 既存の対象判定を外している`);
    // 販売導線ゲートは「出してよいか」を足すだけで、段階そのものを書き換えない
    assert.ok(/canShowSanrenpukuUpsell/.test(src), `${name}: 導線ゲートが無い`);
  }
  // 段階表示の単一源そのものは変更していない（日数境界の定義が残っている）
  assert.ok(/SRP_STAGE/.test(stageLib));
  assert.ok(/computeSanrenpukuStage/.test(stageLib));
});

test('2-b. dashboard は三連複と Plus のブロックを排他で出す', () => {
  assert.ok(/plus-upsell-section/.test(dashboard), 'Plus 用ブロックが無い');
  assert.ok(/applyUpsellSections/.test(dashboard), '出し分け関数が無い');
  // plus のときは三連複ブロックを閉じる
  assert.ok(/channel === 'plus'[\s\S]{0,220}planChangeSection\.style\.display = 'none'/.test(dashboard),
    'plus のときに三連複ブロックを閉じていない');
  // none のときは両方閉じる
  assert.ok(/channel === 'none'[\s\S]{0,200}planChangeSection\.style\.display = 'none'/.test(dashboard),
    'none のときに販売導線を閉じていない');
});

// ── 3. 管理 API が書く範囲 ──────────────────────────────────────

test('3. setUpsell が書くのは UpsellTarget 1 列だけ', () => {
  const code = strip(adminFn);
  const m = code.match(/const fields = \{ \[UPSELL_TARGET_FIELD\]: next \};/);
  assert.ok(m, 'UpsellTarget 以外を書ける形になっている');
  // 権限・課金フィールドが setUpsell の実装に現れない
  const start = code.indexOf('async function handleSetUpsell');
  const end = code.indexOf('async function handlePreview');
  assert.ok(start > 0 && end > start);
  const body = code.slice(start, end);
  for (const banned of ['プラン', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'PaymentEmailSent', 'LifetimeSanrenpuku', 'PremiumPlusEligibility', 'RequestedPlan']) {
    assert.equal(body.includes(`'${banned}'`), false, `setUpsell が ${banned} を書いている`);
  }
});

test('4. 書き込みは env gate で閉じている（既定 OFF）', () => {
  const code = strip(adminFn);
  assert.ok(/isUpsellFieldEnabled\(process\.env\)/.test(code), 'gate を見ていない');
  assert.ok(/UPSELL_TARGET_FIELD_READY/.test(code), 'gate の env 名が無い');
  // gate が閉じているときは 503 で、Airtable へ到達しない
  const start = code.indexOf('async function handleSetUpsell');
  const end = code.indexOf('async function handlePreview');
  const body = code.slice(start, end);
  assert.ok(/isUpsellFieldEnabled[\s\S]{0,200}503/.test(body), 'gate 閉時に 503 を返していない');
  // gate の 503 は Airtable へ触れるより前にある（未作成フィールドへ PATCH しない）
  const gateAt = body.indexOf('isUpsellFieldEnabled');
  const airtableAt = body.indexOf('api.airtable.com');
  assert.ok(gateAt >= 0, 'gate が無い');
  assert.ok(airtableAt < 0 || gateAt < airtableAt, 'gate より先に Airtable を呼んでいる');
  // gate 応答は副作用ゼロを明示する
  assert.ok(/sideEffects: 'none'/.test(body), 'gate 応答が副作用ゼロを明示していない');
});

// ── 5. 存在秘匿 ────────────────────────────────────────────────

test('5. /api/upsell.json は plus 以外へ phase / 受付状況を返さない', () => {
  const code = strip(upsellApi);
  // plus 以外の分岐は allowed:false のみ
  assert.ok(/: \{ allowed: false \}/.test(code), 'plus 以外で詳細を返している');
  assert.equal(/phase: view\.plus\.phase/.test(code), false, 'phase を無条件に返している');
  assert.ok(/UPSELL_CHANNEL\.PLUS/.test(code), 'channel を見ていない');
  // 未ログインは 404（401/403 は存在を漏らす）
  assert.ok(/if \(!access\.ok\) return notFound\(\);/.test(code));
});

// ── 6. 管理画面の表示 ──────────────────────────────────────────

test('6. 管理画面は「設定値」と「実表示」を分けて出し、単一選択で操作する', () => {
  assert.ok(/販売CTA/.test(adminPage), '販売CTA の列/操作が無い');
  assert.ok(/実表示/.test(adminPage), '実表示の列が無い');
  assert.ok(/radio\.type = 'radio'/.test(adminPage), 'チェックボックスになっている（単一選択でない）');
  assert.ok(/action: 'setUpsell'/.test(adminPage), '専用アクションを呼んでいない');
  assert.ok(/fUpsell/.test(adminPage), '販売CTA フィルタが無い');
  // 三連複保有済みには「三連複」を選ばせない
  assert.ok(/value === 'sanrenpuku' && r\.hasSanrenpuku/.test(adminPage), '保有済みへの三連複指定を止めていない');
  // 既存の販売資格 UI を消していない
  assert.ok(/plusAction/.test(adminPage), '既存の販売資格操作が消えている');
  assert.ok(/今すぐ販売可/.test(adminPage));
});

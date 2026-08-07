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

// ── 7. 「今なぜこの CTA が出ているのか」を管理画面で読み切れる ──────
test('7. 管理画面の詳細に 自動判定CTA / 理由 / 判断材料 / 実表示 が揃っている', () => {
  for (const label of [
    '三連複保有', 'ROUTE', 'Premium加入からの経過',
    '自動判定CTA', '自動判定の理由',
    '現在の設定', '顧客に表示されるCTA', '実表示の理由',
  ]) {
    assert.ok(adminPage.includes(label), `詳細パネルに「${label}」が無い`);
  }
  // 「自動」の意味を明記する（文言の正本は upsellExplain.js）
  assert.ok(/upsellAutoRules/.test(adminPage), '「自動」の判定ルールを表示していない');
  assert.ok(/「自動」の判定ルール/.test(adminPage));
});

test('7-b. 一覧 API が 自動判定と実表示の両方を返す', () => {
  const code = strip(adminFn);
  assert.ok(/explainUpsell\(/.test(code), '説明生成の単一源を通していない');
  for (const key of [
    'upsellAutoChannel', 'upsellAutoReasonText', 'upsellReasonText',
    'upsellIsManual', 'upsellDiffersFromAuto', 'daysSincePremiumText', 'routeLabel',
  ]) {
    assert.ok(code.includes(key), `一覧 API が ${key} を返していない`);
  }
  assert.ok(/upsellAutoRules:\s*UPSELL_AUTO_RULE_TEXT/.test(code), '「自動」の説明文言を配っていない');
  // 説明は判定を再実装しない（しきい値をここに書かない）
  assert.ok(!/PREMIUM_30D_DAYS\s*=/.test(code), '管理 Function がしきい値を再定義している');
});

test('7-c. 説明モジュールは判定を再実装しない（純粋・read-only）', () => {
  const explain = strip(read('./upsellExplain.js'));
  // しきい値・優先順位を持たない（既存 resolver から受け取るだけ）
  assert.ok(!/PREMIUM_30D_DAYS\s*=\s*\d/.test(explain), 'しきい値を再定義している');
  assert.ok(!/>=\s*30\b/.test(explain), '30 日判定を複製している');
  assert.ok(!/canPurchaseSanrenpuku|canViewSanrenpuku|paidPremiumActive/.test(explain),
    '会員判定を再実装している');
  // 書き込み・I/O を持たない
  assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/i.test(explain), '書き込みを行っている');
  assert.ok(!/fetch\(|api\.airtable\.com/.test(explain), 'I/O を持っている');
  // 判定は単一源へ委譲する
  assert.ok(/resolveUpsellForCustomer/.test(explain), '単一源を経由していない');
});

test('7-c-2. 管理画面は経過日数の文言を自前で決めない（未記録の決め打ちを禁止）', () => {
  // ROUTE A は daysSincePremium が常に null。ページ側で null == 未記録 と決め打ちすると
  // PaidAt を持つ三連複会員に「データ欠損」と誤表示される（2026-08-07 の表示不備）。
  const code = strip(adminPage);
  assert.ok(!/daysSincePremium == null \?\s*'[^']*未記録/.test(code),
    'null を「未記録」と決め打ちしている');
  assert.ok(!/未記録/.test(code), '経過日数の文言をページに直書きしている');
  // 文言は単一源から受け取る
  assert.ok(/daysSincePremiumText/.test(code), '単一源の文言を使っていない');
});

test('7-d. targetOverride は管理経路だけ。顧客向けページ/API では使わない', () => {
  for (const [name, src] of [
    ['upsell.json', upsellApi], ['stage API', stageApi],
    ['premium-plus-v2', plusV2], ['premium-plus', plusV1],
    ['dashboard', dashboard], ['premium-prediction/jra', jra], ['premium-prediction/nankan', nankan],
  ]) {
    assert.ok(!/targetOverride/.test(strip(src)), `${name}: 顧客向け経路で targetOverride を使っている`);
  }
  // 既定（未指定）では従来どおり fields の UpsellTarget を読む
  const lib = strip(read('./upsellTarget.js'));
  assert.ok(/targetOverride === undefined\s*\n?\s*\?\s*readUpsellTarget\(fields\)/.test(lib),
    '未指定時に fields を読むフォールバックが無い');
});

// ── 8. 三連複保有が一覧・詳細から一目で分かる ─────────────────────
test('8. 一覧のプラン列に三連複バッジを添える（プラン名は書き換えない）', () => {
  const code = strip(adminPage);
  assert.ok(/r\.sanrenpukuBadge/.test(code), '一覧にバッジを出していない');
  assert.ok(/srp-badge/.test(code), 'バッジのクラスが無い');
  // プラン名そのものを差し替えていない（列の意味を変えない）
  assert.ok(/pn\.textContent = r\.plan \|\| '—'/.test(code), 'プラン名を書き換えている');
  // 文言はサーバー由来。バッジ/ラベルの値をページで組み立てない
  //（項目名としての '三連複保有' は kvRow のラベルなので対象外）
  assert.ok(/sb\.textContent = r\.sanrenpukuBadge/.test(code), 'バッジ文言をページで作っている');
  assert.ok(!/textContent\s*=\s*'(三連複保有|永久保有|保有（旧プラン）)'/.test(code),
    'バッジ/ラベルの値をページに直書きしている');
});

test('8-b. 詳細は「プラン」と「三連複」を別項目で出す', () => {
  const code = strip(adminPage);
  assert.ok(/kvRow\(dl, 'プラン'/.test(code), '「プラン」項目が無い');
  assert.ok(/kvRow\(dl, '三連複'/.test(code), '「三連複」項目が無い');
  assert.ok(/r\.sanrenpukuLabel/.test(code), '三連複の意味が分かるラベルを使っていない');
  assert.ok(/r\.sanrenpukuNote/.test(code), '根拠・寿命の説明を出していない');
  // 旧実装の「あり/なし」だけに戻っていない
  assert.ok(!/kvRow\(dl, '三連複', r\.hasSanrenpuku \? 'あり' : 'なし'\)/.test(code),
    '「あり/なし」だけの表示に戻っている');
});

test('8-c. 一覧 API が表示用の値を返し、判定は権限正本に委ねる', () => {
  const code = strip(adminFn);
  assert.ok(/describeSanrenpukuHolding\(/.test(code), '表示の単一源を通していない');
  assert.ok(/resolveEntitlements\(fromAirtableFields\(fields\), now\)/.test(code),
    '権限正本を通していない');
  for (const key of ['sanrenpukuBadge', 'sanrenpukuLabel', 'sanrenpukuNote', 'sanrenpukuBasis']) {
    assert.ok(code.includes(key), `一覧 API が ${key} を返していない`);
  }
  // 管理 Function 側で三連複の保有条件を書き直していない
  assert.ok(!/LifetimeSanrenpuku\s*===\s*true/.test(code), '保有判定を再実装している');
});

/**
 * funnelWiring.guard.test.mjs — 有料化ファネル計測が**どのページでも外れない**
 *
 * ## なぜ読むだけの検査を置くか
 *
 * 申込導線（`openBankModal` と振込申込フォーム）は **13 ページにコピペで散在**
 * している。過去に「16 ページのうち 15 ページが直し漏れ、申込が全部 400 で
 * 失敗していた」事故が起きている（docs/progress.md）。計測も同じ壊れ方をする。
 *
 * そこで計測本体は `public/js/funnel-analytics.js` の **1 か所**に置き、
 * ここでは「その 1 か所が全ページに効く形になっているか」を機械で確かめる。
 *
 * ## 効く仕組み（これが崩れたら検知する）
 *
 * | 段 | 拾い方 |
 * |---|---|
 * | 申込開始 | 各ページの **global** `openBankModal` を包む |
 * | 申込成功 | `SubmissionResult.showSuccessScreen` を包む（12 ページ）＋ `dashboard.astro` の 1 行 |
 *
 * `openBankModal` は `onclick="openBankModal(...)"` から呼ばれている。
 * インライン `onclick` は **global しか見ない**ので、この呼び方が残っている限り
 * 包み込みは必ず効く。よって「`is:inline` の script で定義されていること」を
 * 崩さないことが条件になる（Astro の既定の `<script>` は ES module にされ、
 * global にならない ＝ onclick ごと壊れる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PAGES_DIR = fileURLToPath(new URL('../../pages', import.meta.url));
const read = (p) => readFileSync(p, 'utf8');

/** src/pages 配下の .astro を全部（サブディレクトリ含む）*/
function allPages(dir = PAGES_DIR, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allPages(p, out);
    else if (name.endsWith('.astro')) out.push(p);
  }
  return out;
}

const PAGES = allPages().map((path) => ({
  path,
  rel: path.slice(PAGES_DIR.length + 1),
  src: read(path),
}));

const APPLICATION_ENDPOINT = 'functions/bank-transfer-application';

test('検査対象が 0 件で素通りしない', () => {
  assert.ok(PAGES.length > 50, `ページが少なすぎる: ${PAGES.length}`);
  const withEndpoint = PAGES.filter((p) => p.src.includes(APPLICATION_ENDPOINT));
  // 2026-10-02: Light 新規募集停止で /light-campaign/ を削除（13 → 12）
  assert.ok(withEndpoint.length >= 12, `申込ページが少なすぎる: ${withEndpoint.length}`);
});

test('計測スクリプトが BaseLayout で全ページに読み込まれる', () => {
  const layout = read(fileURLToPath(new URL('../../layouts/BaseLayout.astro', import.meta.url)));
  // 2026-10-22: 1 年キャッシュ対策で ?v=<hash> 付き（publicJsSrc）で読み込む
  assert.ok(layout.includes("publicJsSrc('funnel-analytics')"),
    'BaseLayout が /js/funnel-analytics.js を読み込んでいない＝どのページでも計測が出ない');
});

test('申込フォームを持つページは、必ず申込成功を出せる形になっている', () => {
  const missing = [];
  for (const p of PAGES) {
    if (!p.src.includes(APPLICATION_ENDPOINT)) continue;
    // 経路 A: 共通の成功画面を通る（`funnel-analytics.js` が包んで拾う）
    const viaSuccessScreen = p.src.includes('showSuccessScreen')
      && /type:\s*'bank-transfer'/.test(p.src);
    // 経路 B: 自前の成功表示なので、そのページが直接呼ぶ
    const viaDirectCall = p.src.includes('AkFunnel.applicationSubmitted');
    if (!viaSuccessScreen && !viaDirectCall) missing.push(p.rel);
  }
  assert.deepEqual(missing, [],
    '申込を受け付けるのに申込成功が出ないページがある。'
    + " 共通の成功画面 (showSuccessScreen + type:'bank-transfer') を通すか、"
    + ' window.AkFunnel.applicationSubmitted(...) を成功分岐で呼ぶこと');
});

test('申込成功はサーバーの受理を確かめた分岐からしか呼ばない', () => {
  // ⚠️ 「ボタンを押した」を申込成功にしない。直接呼んでいるページは
  //    `result.success` / `response.ok` を確かめた**後**であること。
  for (const p of PAGES) {
    if (!p.src.includes('AkFunnel.applicationSubmitted')) continue;
    const idx = p.src.indexOf('AkFunnel.applicationSubmitted');
    const before = p.src.slice(Math.max(0, idx - 1200), idx);
    assert.ok(/if\s*\(\s*result\.success\s*\)|response\.ok/.test(before),
      `${p.rel}: 申込成功がサーバー受理の確認なしに呼ばれている`);
    assert.ok(before.includes(APPLICATION_ENDPOINT),
      `${p.rel}: 申込成功が申込 API の応答と結び付いていない`);
  }
});

test('モーダルを開く関数は global のまま（包み込みが効く形）', () => {
  const pagesWithModal = PAGES.filter((p) => /function openBankModal/.test(p.src));
  assert.ok(pagesWithModal.length >= 12, `申込モーダルのページが少なすぎる: ${pagesWithModal.length}`);
  for (const p of pagesWithModal) {
    const idx = p.src.indexOf('function openBankModal');
    const before = p.src.slice(0, idx);
    const lastScript = before.lastIndexOf('<script');
    assert.ok(lastScript !== -1, `${p.rel}: script の外に openBankModal がある`);
    const tag = before.slice(lastScript, before.indexOf('>', lastScript) + 1);
    assert.ok(tag.includes('is:inline'),
      `${p.rel}: openBankModal が is:inline でない script にある。`
      + ' ES module にされると global でなくなり、onclick も計測の包み込みも壊れる');
  }
});

test('計測コードをページへ書き足していない（単一源を保つ）', () => {
  // ⚠️ ページごとに gtag を呼び始めると、13 ページの直し漏れが再発する。
  //    GA4 へ送るのは public/js/funnel-analytics.js だけ。
  const offenders = PAGES.filter((p) => /\bgtag\s*\(/.test(p.src)).map((p) => p.rel);
  assert.deepEqual(offenders, [],
    'ページから直接 gtag を呼んでいる。計測は funnel-analytics.js に集約すること');
});

test('ページから計測へ個人情報を渡していない', () => {
  const PII = ['email', 'fullName', 'transferName', 'recordId', 'userId', 'transferAmount'];
  for (const p of PAGES) {
    const re = /AkFunnel\.application(?:Start|Submitted)\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(p.src)) !== null) {
      for (const key of PII) {
        assert.ok(!m[1].includes(key),
          `${p.rel}: 計測へ ${key} を渡している（GA4 に個人情報を送らない）`);
      }
    }
  }
});

test('計測本体は GA4 の測定 ID を持たない（読み込みは BaseLayout の 1 か所）', () => {
  const js = read(fileURLToPath(new URL('../../../public/js/funnel-analytics.js', import.meta.url)));
  assert.ok(!/G-[A-Z0-9]{8,}/.test(js),
    '測定 ID が 2 か所に増えている。ID は BaseLayout の gtag 設定だけが持つ');
  const layout = read(fileURLToPath(new URL('../../layouts/BaseLayout.astro', import.meta.url)));
  // 2026-10-22: ローカルでの送信停止（window['ga-disable-<ID>']・本番へテストの purchase を送らない）で 3 か所
  assert.equal((layout.match(/G-BTDCZE1B13/g) || []).length, 3,
    'BaseLayout の測定 ID は gtag/js の src・ローカルでの送信停止・gtag(\'config\') の 3 か所');
  assert.match(layout, /if \(\/\^\(localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)\$\/\.test\(location\.hostname\)\) window\['ga-disable-G-BTDCZE1B13'\] = true;/,
    'ローカルだけ止める（本番・Deploy Preview は送る）');
});

// ---- カード決済（PayPal 定期課金）の begin_checkout（2026-10-21）: 決済画面の URL を受け取った後だけ・遷移の前
test('pricing: begin_checkout fires after the checkout URL is returned, before leaving', () => {
  const src = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  const i = src.indexOf("if (res.ok && data.url) {");
  assert.ok(i > 0, 'checkout success branch');
  const branch = src.slice(i, src.indexOf('return;', i));
  // 決済会社はサーバーが返した provider（閉じた語彙 paypal / paddle・それ以外は stripe）。Paddle は 2026-11-02〜
  assert.match(branch, /AkFunnel\.checkoutStart\(planId, data\.provider === 'paypal' \|\| data\.provider === 'paddle' \? data\.provider : 'stripe'\)/);
  assert.ok(branch.indexOf('checkoutStart') < branch.indexOf('location.href = data.url'));
});

// ---- 料金ページのカード決済の途中の段（2026-10-22・docs/measurements/PRICING_CONV_2026_10.md）
test('pricing: each card checkout step is wired (click / email_form / blocked|error / network error / section link)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  assert.match(src, /window\.AkFunnel\.cardCheckoutStep\(planId, name\)/);
  const clickStep = src.indexOf("btn.addEventListener('click', function () { step(");
  const clickStart = src.indexOf("btn.addEventListener('click', function () { startMonthly(");
  assert.ok(clickStep > 0 && clickStep < clickStart, 'button press is measured, registered before the server call');
  assert.match(src, /err === 'email_required'\) step\(planId, 'email_form'\);\s*if \(err === 'email_required'\) return askEmail/);
  assert.match(src, /\? 'blocked' : 'error'\);/);
  assert.match(src, /catch \(_\) \{\s*step\(planId, 'error'\);/);
  // 計測へメールアドレスを渡さない
  assert.equal(/cardCheckoutStep\([^)]*email/.test(src), false);
  assert.equal(/step\([^)]*email\b/.test(src.replace(/'email_form'/g, '')), false);
});

test('pricing: monthly card plans come first; bank-transfer plans are below and closed by default (2026-11-02 MK)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  const monthly = src.indexOf('<section class="monthly-section" id="credit-payment"');
  const bank = src.indexOf('<details class="bank-plans" id="bank-plans" open={!showMonthly}>');
  assert.ok(monthly > 0 && bank > 0);
  assert.ok(monthly < bank, '月額（クレジット）が銀行振込のプランより上');
  assert.ok(bank < src.indexOf('data-bank-plan="annual"') && bank < src.indexOf('data-bank-plan="lifetime"'), '年払い・買い切りは閉じた枠の中');
  assert.ok(src.indexOf('</details>') > src.indexOf('data-bank-plan="lifetime"'));
  assert.match(src, /<summary class="bank-plans-summary">🏦 銀行振込のプラン（年払い・買い切り）<\/summary>/);
  // Light 会員（乗り換え特典は年払い）と #bank-plans で来た方には開く
  assert.match(src, /getAttribute\('data-plan-tier'\) === '1' \|\| location\.hash === '#bank-plans'\) d\.open = true/);
  // 閉じた枠と無料プランの間の余白: 後ろの .plans-container { margin: … } に負けない 2 クラス指定（#855 は 1 クラスで上書きされ効いていなかった）
  assert.match(src, /\.plans-container\.plans-container--free \{ margin-top: 3rem; \}/);
  // 先頭に置いたので枠へのリンクは撤去
  assert.equal(/data-card-link/.test(src), false);
  // 現在 Premium をご契約中の方には月額の枠を出さない
  assert.match(src, /data-premium-active="1"\]\) \.monthly-section/);
});

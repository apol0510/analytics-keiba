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
  assert.ok(withEndpoint.length >= 13, `申込ページが少なすぎる: ${withEndpoint.length}`);
});

test('計測スクリプトが BaseLayout で全ページに読み込まれる', () => {
  const layout = read(fileURLToPath(new URL('../../layouts/BaseLayout.astro', import.meta.url)));
  assert.ok(layout.includes('/js/funnel-analytics.js'),
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
  assert.ok(pagesWithModal.length >= 13, `申込モーダルのページが少なすぎる: ${pagesWithModal.length}`);
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
  assert.equal((layout.match(/G-BTDCZE1B13/g) || []).length, 2,
    'BaseLayout の測定 ID は gtag/js の src と gtag(\'config\') の 2 か所');
});

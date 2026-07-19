/**
 * contact-forms.guard.test.js
 *
 * 問い合わせフォーム自動入力の「配信される複製コード」の退行を静的に検知する guard。
 *
 * 背景: is:inline スクリプト（および component）は src/lib/contact-autofill.js を直接
 *       import できないため、各フォームに同一ロジックを複製している。正本の
 *       contact-autofill.test.js は src/lib しか検証しないので、複製側が壊れても気づけない。
 *       本 guard は対象フォームすべてに以下が存在することをソース上で固定する:
 *         1. user-plan の安全な parse（JSON.parse + 型ガード / Array.isArray 除外）
 *         2. 空欄のときだけ代入（!el.value ガード）
 *         3. autocomplete="name" / autocomplete="email"
 *
 * 実行: node src/lib/contact-forms.guard.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const read = (rel) => readFileSync(join(process.cwd(), rel), 'utf-8');

// 対象フォーム実体（PremiumContactModal は dashboard + JRA の 2 フォームを兼ねる → 計 6 フォーム）
const FORM_FILES = [
  { file: 'src/components/PremiumContactModal.astro', covers: 'dashboard + JRA(premium)' },
  { file: 'src/pages/premium-plus.astro', covers: 'premium-plus' },
  { file: 'src/pages/premium-prediction/nankan.astro', covers: '南関(premium)' },
  { file: 'src/pages/premium-predictions-funabashi.astro', covers: '船橋(premium)' },
  { file: 'src/pages/premium-predictions-urawa.astro', covers: '浦和(premium)' },
];

for (const { file, covers } of FORM_FILES) {
  t(`${covers}: 安全な user-plan parse がある`, () => {
    const src = read(file);
    assert.ok(/getLoggedInContact\s*\(\)/.test(src), `${file}: getLoggedInContact() が無い`);
    assert.ok(/getItem\(['"]user-plan['"]\)/.test(src), `${file}: user-plan 読み取りが無い`);
    assert.ok(/JSON\.parse\(/.test(src), `${file}: JSON.parse が無い`);
    assert.ok(/Array\.isArray\(/.test(src), `${file}: 配列ガード(Array.isArray)が無い`);
    assert.ok(/typeof\s+data\.name\s*===\s*['"]string['"]/.test(src), `${file}: name の string 型ガードが無い`);
    assert.ok(/typeof\s+data\.email\s*===\s*['"]string['"]/.test(src), `${file}: email の string 型ガードが無い`);
  });

  t(`${covers}: 空欄のときだけ代入する（既入力を上書きしない）`, () => {
    const src = read(file);
    assert.ok(/prefillContactFields\s*\(\)/.test(src), `${file}: prefillContactFields 呼び出しが無い`);
    assert.ok(/!\s*nameEl\.value/.test(src), `${file}: name の空欄ガード(!nameEl.value)が無い`);
    assert.ok(/!\s*emailEl\.value/.test(src), `${file}: email の空欄ガード(!emailEl.value)が無い`);
  });

  // 2026-07-18: dashboard が user-plan に書いていたプレースホルダ 'お客様' を自動入力すると、
  // 管理者宛メールが「お名前: お客様」で届き返信相手を特定できない。複製側でも必ず除外する。
  t(`${covers}: プレースホルダ 'お客様' を氏名として入力しない`, () => {
    const src = read(file);
    assert.ok(
      /===\s*['"]お客様['"]\s*\?\s*['"]{2}\s*:/.test(src),
      `${file}: 'お客様' を空にする正規化が無い（正本 contact-autofill.js の normalizeContactName と揃える）`,
    );
  });

  t(`${covers}: autocomplete 属性がある`, () => {
    const src = read(file);
    assert.ok(/autocomplete=["']name["']/.test(src), `${file}: autocomplete="name" が無い`);
    assert.ok(/autocomplete=["']email["']/.test(src), `${file}: autocomplete="email" が無い`);
  });
}

console.log(`\ncontact-forms.guard.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

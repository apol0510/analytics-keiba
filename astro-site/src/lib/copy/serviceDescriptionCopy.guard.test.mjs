// /service-description/ の文面の回帰防止（共通 行動原則 A-3・2026-11-25 MK）
// - MK が求めていない注意書き（的中の非保証・自己責任・依存症・「予告なく変更」）を置かない。年齢は競馬法の 1 文だけ。
// - 月額カード決済の決済会社名は料金ページと同じ単一源（subscriptionProviderCopy）から出し、固定の社名を書かない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const page = readFileSync(fileURLToPath(new URL('../../pages/service-description.astro', import.meta.url)), 'utf8');

test('注意書き・免責を置かない（年齢は競馬法の 1 文だけ）', () => {
  for (const phrase of ['保証するものではありません', '自己責任', '依存症', '予告なく変更', '重要な注意事項']) {
    assert.ok(!page.includes(phrase), `service-description.astro に「${phrase}」が残っている`);
  }
  assert.equal(page.match(/20 歳未満の方は勝馬投票券を購入できません（競馬法）/g)?.length, 1);
});

test('月額カード決済の決済会社名は subscriptionProviderCopy から出す', () => {
  assert.match(page, /import \{ subscriptionProviderCopy \} from '\.\.\/lib\/billing\/subscriptionProviderCopy\.js';/);
  assert.ok(!page.includes('クレジット決済（PayPal'), '月額の決済会社名を固定で書かない');
  assert.ok(!page.includes('決済代行は PayPal'), '月額の決済会社名を固定で書かない');
});

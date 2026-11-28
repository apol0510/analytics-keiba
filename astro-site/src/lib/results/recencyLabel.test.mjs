import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { recencyWord, applyRecencyLabels } from './recencyLabel.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const jst = (iso) => Date.parse(`${iso}+09:00`);

test('前日の開催は「昨日」・当日は「本日」・2 日以上前は「最新」', () => {
  assert.equal(recencyWord('2026-11-23', jst('2026-11-24T16:43:00')), '昨日');
  assert.equal(recencyWord('2026-11-24', jst('2026-11-24T21:45:00')), '本日');
  // 2026-11-24 の本番: 11-20 大井を「昨日」と出していた
  assert.equal(recencyWord('2026-11-20', jst('2026-11-24T16:43:00')), '最新');
});

test('日付の境目は JST（UTC 前日の JST 0 時台・JST 23 時台）', () => {
  assert.equal(recencyWord('2026-11-23', jst('2026-11-24T00:10:00')), '昨日');
  assert.equal(recencyWord('2026-11-23', jst('2026-11-24T23:59:00')), '昨日');
  assert.equal(recencyWord('2026-11-23', jst('2026-11-25T00:00:00')), '最新');
  assert.equal(recencyWord('2026-02-28', jst('2026-03-01T08:00:00')), '昨日');
});

test('日付が読めないときは「最新」（昨日と言い切らない）', () => {
  for (const d of [undefined, null, '', '11月20日', '2026-11-2']) {
    assert.equal(recencyWord(d, jst('2026-11-24T12:00:00')), '最新');
  }
  assert.equal(recencyWord('2026-11-23', NaN), '最新');
});

test('applyRecencyLabels は見出しの語だけを置き換える', () => {
  const word = { textContent: '最新' };
  const card = { getAttribute: () => '2026-11-23', querySelectorAll: () => [word] };
  applyRecencyLabels({ querySelectorAll: () => [card] }, jst('2026-11-24T10:00:00'));
  assert.equal(word.textContent, '昨日');
  applyRecencyLabels(null, 0); // 落ちない
});

test('guard: 最新開催を出す見出し・ナビに「昨日の」を固定で書かない', () => {
  for (const p of ['src/pages/index.astro', 'src/pages/light-predictions.astro', 'src/pages/light-predictions-jra.astro', 'src/layouts/BaseLayout.astro']) {
    const src = read(p);
    assert.doesNotMatch(src, /🏆 昨日の的中結果/, `${p}: 固定の「昨日の的中結果」`);
    assert.doesNotMatch(src, /💎 昨日の買い目/, `${p}: 固定の「昨日の買い目」`);
  }
  const index = read('src/pages/index.astro');
  assert.match(index, /data-recency-date=\{latestResult\.date\}/);
  assert.match(index, /data-recency-date=\{latestJraResult\.date\}/);
  for (const p of ['src/pages/light-predictions.astro', 'src/pages/light-predictions-jra.astro']) {
    assert.match(read(p), /data-recency-date=\{latestResult\?\.date\}/, p);
  }
  assert.match(read('src/layouts/BaseLayout.astro'), /applyRecencyLabels\(document/);
});

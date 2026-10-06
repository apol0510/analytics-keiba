// 取得済み予想（/predictions/view/）の出走表の基本情報（2026-10-07）
// リニューアル前の Premium ページと同じ項目（性齢・斤量・騎手・調教師・父）を全馬に出す。Preview（無料）には出さない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { horseProfile, buildPredictionContent } from './predictionContent.js';
import { buildPreviewContent } from './previewContent.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

test('horseProfile: 旧 Premium ページと同じ書き方（性齢「2歳牡」・斤量「56kg」）', () => {
  assert.deepEqual(
    horseProfile({ age: '牡2', weight: '56', jockey: '騎手A', trainer: '調教師B', sire: '父C' }),
    { sexAge: '2歳牡', weight: '56kg', jockey: '騎手A', trainer: '調教師B', sire: '父C' },
  );
  assert.deepEqual(horseProfile({ age: '牝3', weight: 54.5 }), { sexAge: '3歳牝', weight: '54.5kg' });
  // 解釈できない性齢は元の値のまま・数値でない斤量は出さない
  assert.deepEqual(horseProfile({ age: '不明', weight: 'abc' }), { sexAge: '不明' });
  // 騎手未定（出走表の確定前）は空欄の項目を入れない
  assert.deepEqual(horseProfile({ age: '牡4', weight: '', jockey: '' }), { sexAge: '4歳牡' });
  assert.equal(horseProfile({}), null);
});

const race = {
  raceInfo: { raceNumber: 11, raceName: 'テスト', distance: '1600' },
  horses: [
    { horseNumber: 1, horseName: '馬1', role: '本命', age: '牡3', weight: '57', jockey: 'J1', trainer: 'T1', sire: 'S1', pt: 90 },
    { horseNumber: 2, horseName: '馬2', role: '対抗', age: '牝3', weight: '55', jockey: 'J2', trainer: 'T2', sire: 'S2', pt: 80 },
    { horseNumber: 3, horseName: '馬3', role: '単穴', age: '牡4', weight: '57', jockey: 'J3', trainer: 'T3', sire: 'S3', pt: 70 },
    { horseNumber: 4, horseName: '馬4', role: '連下', age: '騸5', weight: '57', jockey: 'J4', trainer: 'T4', sire: 'S4', pt: 60 },
  ],
  bettingLines: { umatan: ['1→2.3.4'] },
};

test('取得時のスナップショット: 全馬に profile が入る（印・役割に関係なく）', () => {
  const c = buildPredictionContent({ product: 'premium', cat: 'jra', venueName: '東京', race, venueTotalRaces: 12 });
  assert.equal(c.horses.length, 4);
  for (const h of c.horses) {
    assert.ok(h.profile, `${h.number}: profile なし`);
    assert.deepEqual(Object.keys(h.profile).sort(), ['jockey', 'sexAge', 'sire', 'trainer', 'weight']);
  }
  assert.equal(c.horses.find((h) => h.number === 4).profile.sexAge, '5歳騸');
});

test('Preview（無料）には出走表の基本情報を入れない', () => {
  const p = buildPreviewContent({ cat: 'jra', venueName: '東京', race, venueTotalRaces: 12 });
  for (const h of p.horses) assert.equal(h.profile, undefined);
  const comp = read('src/components/acquisition/AcquiredPredictionBody.astro');
  assert.match(comp, /const profileCols = isPreview \? \[\] :/);
});

test('画面: 出走表（性齢・斤量・騎手・調教師・父）を全馬ぶん出し、印の横に性齢・斤量・騎手', () => {
  const comp = read('src/components/acquisition/AcquiredPredictionBody.astro');
  for (const label of ['性齢', '斤量', '騎手', '調教師', '父']) assert.match(comp, new RegExp(`label: '${label}'`));
  assert.match(comp, /aria-label="出走表"/);
  assert.match(comp, /byNumber\.map\(\(h\) =>/);
  assert.match(comp, /<small>\{markSub\(h\)\}<\/small>/);
});

test('取得済みの古い保存データ（profile なし）は閲覧時に予想データから補う（買い目・印・指数は変えない）', () => {
  const view = read('src/pages/predictions/view.astro');
  assert.match(view, /const needProfile = !!\(c && c\.horses\.some\(\(h\) => h\.profile === undefined\)\)/);
  assert.match(view, /\.\.\.\(h\.profile === undefined \? \{ profile: l\?\.profile \|\| null \} : \{\}\)/);
});

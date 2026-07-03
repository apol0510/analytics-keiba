#!/usr/bin/env node
/**
 * verify-free-mask.mjs — 無料ページ(SSG)の漏洩検査。
 * ビルド後の dist HTML に、有料買い目の再現に使える AK 独自評価
 *   （実 pt / 実 AI総合指数(CI) / 実 特徴量% / ▲単穴・△連下・抑え・不要馬の役割テキスト）
 * が焼き込まれていないことを検証する。公開事実（◎○印・馬名・騎手・過去走）は残ることも確認。
 *
 *   node scripts/verify-free-mask.mjs        # 既存 dist を検査
 * dist が無ければ先に `npm run build:skip-validation` を実行すること。
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = [
  { name: 'nankan', file: 'dist/free-prediction/nankan/index.html' },
  { name: 'jra', file: 'dist/free-prediction/jra/index.html' },
];
const count = (h, re) => (h.match(re) || []).length;

let failed = 0;
for (const p of pages) {
  const path = join(root, p.file);
  if (!existsSync(path)) { console.error(`❌ ${p.name}: ${p.file} が無い（先に build して）`); failed++; continue; }
  const h = readFileSync(path, 'utf-8');

  // 漏洩（0であるべき）
  const leaks = [];
  const realCi = count(h, /指数<\/span>[0-9]+/g); if (realCi) leaks.push(`実CI(指数)×${realCi}`);
  const ptLeak = (h.match(/stat-score[^0-9<]*<span[^>]*>([0-9]+)/g) || []).map(s => s.match(/([0-9]+)$/)[1]).filter(n => n !== '88'); if (ptLeak.length) leaks.push(`実pt×${ptLeak.length}`);
  const ciLeak = (h.match(/stat-index[^0-9<]*<span[^>]*>([0-9]+)/g) || []).map(s => s.match(/([0-9]+)$/)[1]).filter(n => n !== '88'); if (ciLeak.length) leaks.push(`実CI(stat)×${ciLeak.length}`);
  const featLeak = (h.match(/importance-percent[^>]*>([0-9]+)%/g) || []).filter(s => !s.includes('>88%')); if (featLeak.length) leaks.push(`実特徴量%×${featLeak.length}`);
  for (const w of ['単穴', '連下最上位', '連下候補馬', '抑え候補馬']) if (count(h, new RegExp(w, 'g'))) leaks.push(`役割テキスト「${w}」`);
  if (count(h, /minor-horse-score/g)) leaks.push('旧minor-horse-score');

  // 維持（>0であるべき）
  const keep = [];
  if (!count(h, /free-flat-card/g)) keep.push('free-flat-card');
  if (!count(h, /masked-eval/g)) keep.push('masked-eval');
  if (!count(h, /◎/g)) keep.push('◎(本命)');
  if (!count(h, /騎手/g)) keep.push('騎手');
  if (!count(h, /過去[0-9]走/g)) keep.push('過去N走');
  // masked-num はダミー"88"のみであること
  const nums = [...new Set((h.match(/masked-num[^>]*>([0-9]+)/g) || []).map(s => s.match(/([0-9]+)$/)[1]))];
  if (nums.some(n => n !== '88')) keep.push(`masked-num非ダミー(${nums.join(',')})`);

  if (leaks.length || keep.length) {
    console.error(`❌ ${p.name}: 漏洩[${leaks.join(', ') || 'なし'}] 欠落[${keep.join(', ') || 'なし'}]`);
    failed++;
  } else {
    console.log(`✅ ${p.name}: 漏洩0 / 公開事実維持 / モザイクはダミー88のみ（cards=${count(h, /free-flat-card/g)}, masked=${count(h, /masked-eval/g)}）`);
  }
}
if (failed) { console.error(`\n検査失敗: ${failed} ページ`); process.exit(1); }
console.log('\n✅ 無料マスク漏洩検査 合格');

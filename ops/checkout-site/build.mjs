// 使い方: node ops/checkout-site/build.mjs <outDir>  （repo 外の出力先へ書く。repo には生成物を置かない）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildFiles } from './site.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: node ops/checkout-site/build.mjs <outDir>'); process.exit(1); }
for (const [rel, body] of Object.entries(buildFiles())) {
  const file = join(resolve(out), rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}
console.log(`built ${Object.keys(buildFiles()).length} files -> ${resolve(out)}`);

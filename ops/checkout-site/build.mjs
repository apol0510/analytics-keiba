// 使い方: [PADDLE_LIVE_CLIENT_TOKEN=live_…] node ops/checkout-site/build.mjs <outDir>  （repo 外の出力先へ書く。repo には生成物を置かない）
// PADDLE_LIVE_CLIENT_TOKEN は公開してよい client token（/pay/ の Paddle.js 用）。無ければ /pay/ は案内だけ。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildFiles } from './site.mjs';

const out = process.argv[2];
if (!out) { console.error('usage: node ops/checkout-site/build.mjs <outDir>'); process.exit(1); }
const built = buildFiles({ paddleClientToken: process.env.PADDLE_LIVE_CLIENT_TOKEN || '' });
for (const [rel, body] of Object.entries(built)) {
  const file = join(resolve(out), rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}
console.log(`built ${Object.keys(built).length} files -> ${resolve(out)}`);

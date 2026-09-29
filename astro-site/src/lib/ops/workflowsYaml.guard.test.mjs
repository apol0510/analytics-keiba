/**
 * .github/workflows/*.yml がすべて YAML として読めること。
 *
 * 2026-09-29: premium-plus-order-monitor.yml の `run:` に引用なしの「注文: …」があり YAML として不正、
 * GitHub は workflow を登録できず（schedule も workflow_dispatch も動かない）、push のたびに失敗 run だけが出た。
 * 未来の確認・監視が「動いているつもりで止まっている」事故を防ぐ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const dir = new URL('../../../../.github/workflows/', import.meta.url);

test('全 workflow が YAML として読め、on と jobs を持つ', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 10);
  const bad = [];
  for (const f of files) {
    try {
      const d = yaml.load(readFileSync(new URL(f, dir), 'utf8'));
      if (!d || !d.jobs || !(d.on || d[true])) bad.push(`${f}: on/jobs がない`);
    } catch (e) {
      bad.push(`${f}: ${String(e.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(bad, []);
});

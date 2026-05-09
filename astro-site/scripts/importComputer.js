#!/usr/bin/env node

/**
 * importComputer.js
 *
 * keiba-data-shared から JRA・南関の computer JSON（コンピ指数）を取り込み、
 * /dark-horse-picks/ で表示するため src/data/computer/{category}/YYYY/MM/ に保存する。
 *
 * 使い方:
 *   node scripts/importComputer.js                         # 今日(JST)
 *   node scripts/importComputer.js --date 2026-05-08       # 特定日
 *   node scripts/importComputer.js --days 7                # 直近7日分
 *
 * 環境変数:
 *   GITHUB_TOKEN: GitHub API レート制限緩和のため推奨
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const OWNER = 'apol0510';
const REPO = 'keiba-data-shared';

function getTodayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return [
    jst.getUTCFullYear(),
    String(jst.getUTCMonth() + 1).padStart(2, '0'),
    String(jst.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function shiftDate(yyyymmdd, deltaDays) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0')
  ].join('-');
}

async function fetchComputerForDate(category, date) {
  const [year, month] = date.split('-');
  const dirPath = `${category}/predictions/computer/${year}/${month}`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${dirPath}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'analytics-keiba-import-computer'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;

  const dirRes = await fetch(apiUrl, { headers });
  if (!dirRes.ok) {
    if (dirRes.status === 404) return [];
    throw new Error(`GitHub API ${dirRes.status} for ${dirPath}`);
  }
  const files = await dirRes.json();
  const targets = files.filter(f => f.name.startsWith(`${date}-`) && f.name.endsWith('.json'));
  if (targets.length === 0) return [];

  const results = [];
  for (const f of targets) {
    const rawUrl = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${dirPath}/${f.name}`;
    const res = await fetch(rawUrl, { headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {} });
    if (!res.ok) continue;
    const content = await res.text();
    results.push({ name: f.name, content, year, month });
  }
  return results;
}

function saveLocal(category, year, month, name, content) {
  const dir = join(projectRoot, 'src', 'data', 'computer', category, year, month);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  // 同一内容ならスキップ
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === content) return { saved: false, reason: 'same' };
  }
  writeFileSync(filePath, content);
  return { saved: true };
}

async function importDate(date) {
  const summary = { jra: 0, nankan: 0, skipped: 0 };
  for (const category of ['jra', 'nankan']) {
    try {
      const files = await fetchComputerForDate(category, date);
      for (const f of files) {
        const r = saveLocal(category, f.year, f.month, f.name, f.content);
        if (r.saved) {
          summary[category]++;
          console.log(`✅ ${category}/${f.year}/${f.month}/${f.name}`);
        } else {
          summary.skipped++;
        }
      }
    } catch (e) {
      console.warn(`⚠️ ${category} ${date}: ${e.message}`);
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  let date = null;
  let days = 1;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) { date = args[i + 1]; i++; }
    else if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
  }
  const baseDate = date || getTodayJST();
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(shiftDate(baseDate, -i));

  console.log(`📡 Importing computer JSONs for: ${dates.join(', ')}`);
  const total = { jra: 0, nankan: 0, skipped: 0 };
  for (const d of dates) {
    const s = await importDate(d);
    total.jra += s.jra;
    total.nankan += s.nankan;
    total.skipped += s.skipped;
  }
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ JRA: ${total.jra} files / Nankan: ${total.nankan} files / Skipped(same): ${total.skipped}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

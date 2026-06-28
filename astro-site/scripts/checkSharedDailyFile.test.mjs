/**
 * checkSharedDailyFile.test.mjs — 認証付き 統合 daily ファイル確認 script の単体テスト
 * （node:test / 新規依存なし / 全 mock fetch・実 GitHub 通信なし）
 *   node --test scripts/checkSharedDailyFile.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSharedDailyFile } from './checkSharedDailyFile.mjs';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const ARGV = ['--date', '2026-05-08'];

function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, init, calls.length - 1); };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
const silentLogger = { log() {}, warn() {}, error() {} };

function clientWith(responder, { retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env: ENV_OK, sleepImpl: noSleep, retries });
}
function run(overrides = {}) {
  return checkSharedDailyFile({ argv: ARGV, env: ENV_OK, logger: silentLogger, ...overrides });
}

// 200 → 存在・会場数（race.venue ユニーク）・race数
test('1. 200 → FOUND=true / venue 数（ユニーク）/ race 数', async () => {
  const client = clientWith(() =>
    mkRes(200, {
      races: [
        { venue: '東京', raceNumber: 1 },
        { venue: '東京', raceNumber: 2 },
        { venue: '京都', raceNumber: 1 },
        { venue: '阪神', raceNumber: 1 },
      ],
    }),
  );
  const { found, expectedVenues, expectedRaces } = await run({ client });
  assert.equal(found, true);
  assert.equal(expectedVenues, 3); // 東京/京都/阪神
  assert.equal(expectedRaces, 4);
});

// 404 → 未投入（throw しない・found:false）
test('2. 404 → FOUND=false（未投入・throw しない / exit0 相当）', async () => {
  const client = clientWith(() => mkRes(404, 'Not Found'));
  const { found, expectedVenues, expectedRaces } = await run({ client });
  assert.equal(found, false);
  assert.equal(expectedVenues, 0);
  assert.equal(expectedRaces, 0);
});

// 401 → fatal
test('3. 401 は fatal（throw）', async () => {
  const client = clientWith(() => mkRes(401, 'Bad credentials'));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 403（非rate）→ fatal
test('4. 403（非 rate）は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'Forbidden', { 'x-ratelimit-remaining': '50' }));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// rate limit（403 remaining:0）→ retry 後 fatal
test('5. rate limit(403 remaining:0) は retry 後 fatal', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0' }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep, retries: 2 });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
  assert.equal(fetchImpl.calls.length, 3); // 初回 + retry 2
});

// 429 → retry 後 fatal
test('6. 429 は retry 後 fatal', async () => {
  const fetchImpl = mkFetch(() => mkRes(429, 'too many requests'));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep, retries: 2 });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
});

// 500 → retry 後 fatal
test('7. 500 は retry 後 fatal', async () => {
  const client = clientWith(() => mkRes(500, 'err'));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

// timeout → retry 後 fatal
test('8. timeout は retry 後 fatal', async () => {
  const fetchImpl = mkFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep, retries: 2 });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

// token 未設定 → 取得前に fatal（fetch を呼ばない）
test('9. token 未設定は取得前に TOKEN_MISSING（fetch 呼ばない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(run({ env: {}, client }), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// token / Authorization / Bearer 非露出
test('10. token / Authorization / Bearer がログ・エラーへ漏れない', async () => {
  const logs = [];
  const logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  let thrown;
  const client = clientWith(() => mkRes(401, 'Bad credentials'));
  await run({ client, logger }).catch((e) => { thrown = e; });
  const hay = `${logs.join('\n')}\n${thrown?.message}\n${thrown?.stack}`;
  assert.ok(!hay.includes(SECRET));
  assert.ok(!/Bearer\s/i.test(hay));
  assert.ok(!/Authorization/i.test(hay));
});

// 既定は jra/results/YYYY/MM/YYYY-MM-DD.json を叩く（contract 経路）
test('11. 既定 path は jra/results の統合ファイル', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [{ venue: '東京' }] }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await run({ client });
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /\/contents\/jra\/results\/2026\/05\/2026-05-08\.json/);
});

// 予想存在確認（--kind predictions）でも FOUND を返す（verify-archive-sync 流用）
test('12. --kind predictions: 200 → FOUND=true（予想存在確認に流用）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { ok: true }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const { found } = await checkSharedDailyFile({
    argv: ['--date', '2026-05-08', '--category', 'nankan', '--kind', 'predictions'],
    env: ENV_OK, logger: silentLogger, client,
  });
  assert.equal(found, true);
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /\/contents\/nankan\/predictions\/2026\/05\/2026-05-08\.json/);
});

// 南関 results unified path / race数（per-venue ではなく unified daily を読む）
test('13. --category nankan --kind results: unified daily path & race数', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [{ venue: '大井' }, { venue: '大井' }] }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const { found, expectedRaces } = await checkSharedDailyFile({
    argv: ['--date', '2026-05-08', '--category', 'nankan', '--kind', 'results'],
    env: ENV_OK, logger: silentLogger, client,
  });
  assert.equal(found, true);
  assert.equal(expectedRaces, 2);
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /\/contents\/nankan\/results\/2026\/05\/2026-05-08\.json/);
});

// JRA results unified path
test('14. --category jra --kind results: unified daily path', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [{ venue: '東京' }] }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await checkSharedDailyFile({ argv: ['--date', '2026-05-08', '--category', 'jra', '--kind', 'results'], env: ENV_OK, logger: silentLogger, client });
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /\/contents\/jra\/results\/2026\/05\/2026-05-08\.json/);
});

// JRA predictions unified path
test('15. --category jra --kind predictions: unified daily path', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { ok: true }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await checkSharedDailyFile({ argv: ['--date', '2026-05-08', '--category', 'jra', '--kind', 'predictions'], env: ENV_OK, logger: silentLogger, client });
  assert.match(decodeURIComponent(fetchImpl.calls[0].url), /\/contents\/jra\/predictions\/2026\/05\/2026-05-08\.json/);
});

// malformed JSON → fatal（INVALID_JSON、未投入扱いしない）
test('16. malformed JSON は fatal（INVALID_JSON）', async () => {
  const client = clientWith(() => mkRes(200, '{ not json'));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.INVALID_JSON);
});

// 不正 category → 取得前に reject（fetch しない）
test('17. 不正 category は拒否（fetch しない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await assert.rejects(
    checkSharedDailyFile({ argv: ['--date', '2026-05-08', '--category', 'keirin', '--kind', 'results'], env: ENV_OK, logger: silentLogger, client }),
    /Invalid --category/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// 不正 kind → 取得前に reject（fetch しない）
test('18. 不正 kind は拒否（fetch しない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await assert.rejects(
    checkSharedDailyFile({ argv: ['--date', '2026-05-08', '--category', 'jra', '--kind', 'entries'], env: ENV_OK, logger: silentLogger, client }),
    /Invalid --kind/,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 静的 workflow 監査（PR-AK-4）: 3 workflow から匿名 shared curl 撤去 + token 供給。
// ─────────────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const wfDir = join(__dirname, '..', '..', '.github', 'workflows');
const readWf = (name) => readFileSync(join(wfDir, name), 'utf-8');

/** 指定 workflow 文字列から step 名 → 次の "- name:" 直前までを抽出（区間限定で誤検出を防ぐ） */
function extractStep(wf, stepName) {
  const lines = wf.split('\n');
  const startIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(startIdx >= 0, `step が見つからない: ${stepName}`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

const SHARED_RAW = /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/;
const TOKEN_RE = /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/;

// 対象 workflow と「変換した存在確認 step 名」
const TARGETS = [
  { file: 'verify-archive-sync.yml', steps: ['Check JRA archive sync', 'Check Nankan archive sync'] },
  { file: 'auto-sync-check.yml', steps: ['Detect missing dates'] },
  { file: 'import-results-jra-daily.yml', steps: ['Check for missing results'] },
];

for (const { file, steps } of TARGETS) {
  test(`workflow ${file}: 匿名 raw.githubusercontent shared がゼロ`, () => {
    assert.doesNotMatch(readWf(file), SHARED_RAW);
  });

  test(`workflow ${file}: KEIBA_DATA_SHARED_TOKEN が供給される`, () => {
    assert.match(readWf(file), TOKEN_RE);
  });

  for (const stepName of steps) {
    test(`workflow ${file} / "${stepName}": 認証付き Node script へ委譲・匿名 curl/raw 無し`, () => {
      const step = extractStep(readWf(file), stepName);
      assert.match(step, /node (?:astro-site\/)?scripts\/checkShared(?:DailyFile|NankanResults)\.mjs/);
      assert.doesNotMatch(step, /\bcheckSharedResultsJra\b/); // 旧名は残らない
      assert.doesNotMatch(step, /curl\s+-sf/);
      assert.doesNotMatch(step, /curl\s+-s\s/);
      assert.doesNotMatch(step, SHARED_RAW);
    });

    test(`workflow ${file} / "${stepName}": fatal を握りつぶさない（continue-on-error / || echo を追加していない）`, () => {
      const step = extractStep(readWf(file), stepName);
      assert.doesNotMatch(step, /continue-on-error:\s*true/);
      assert.doesNotMatch(step, /checkShared\w*\.mjs[^\n]*\|\|\s*echo/);
      // fatal 経路は `|| { ... exit 1; }` で step を失敗させる
      assert.match(step, /checkShared\w*\.mjs[\s\S]*?\|\|\s*\{[\s\S]*?exit 1/);
    });

    test(`workflow ${file} / "${stepName}": secrets.GITHUB_TOKEN を shared 読取に流用していない`, () => {
      const step = extractStep(readWf(file), stepName);
      assert.doesNotMatch(step, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
      // secret 値を echo していない
      assert.doesNotMatch(step, /echo[^\n]*\$\{\{\s*secrets\./);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧契約再現の静的監査（方針A）: 南関結果の判定を unified ベースへ厳密再現。
// ─────────────────────────────────────────────────────────────────────────────

// auto-sync-check.yml「Detect missing dates」: unified 確認 → 正規404時のみ per-venue 合算 fallback
test('auto-sync(南関): unified を checkSharedDailyFile で先に確認する', () => {
  const step = extractStep(readWf('auto-sync-check.yml'), 'Detect missing dates');
  assert.match(step, /checkSharedDailyFile\.mjs --category nankan --kind results/);
});
test('auto-sync(南関): per-venue fallback は unified FOUND=false のときだけ（else 分岐内）', () => {
  const step = extractStep(readWf('auto-sync-check.yml'), 'Detect missing dates');
  // UNIFIED_FOUND=true 分岐の後、else 内で checkSharedNankanResults を呼ぶ構造
  assert.match(step, /UNIFIED_FOUND[\s\S]*?if \[ "\$UNIFIED_FOUND" = "true" \][\s\S]*?else[\s\S]*?checkSharedNankanResults\.mjs[\s\S]*?TOTAL_RACES[\s\S]*?-ge 12/);
});
test('auto-sync(南関): unified 存在は race数不問で FOUND（旧契約: 200なら数不問）', () => {
  const step = extractStep(readWf('auto-sync-check.yml'), 'Detect missing dates');
  // unified FOUND=true → FOUND=true（race数 gate を挟まない）
  assert.match(step, /if \[ "\$UNIFIED_FOUND" = "true" \]; then\s*\n\s*FOUND=true/);
});
test('auto-sync(南関): unified/per-venue とも auth/通信 fatal は `|| { exit 1 }`', () => {
  const step = extractStep(readWf('auto-sync-check.yml'), 'Detect missing dates');
  const calls = step.match(/checkShared\w+\.mjs[\s\S]*?\|\|\s*\{[\s\S]*?exit 1/g) || [];
  assert.ok(calls.length >= 2, 'unified と per-venue の両呼び出しが fatal-guard 付き');
});
test('auto-sync: output 名は has_missing / missing_dates のまま', () => {
  const step = extractStep(readWf('auto-sync-check.yml'), 'Detect missing dates');
  assert.match(step, /has_missing=true/);
  assert.match(step, /has_missing=false/);
  assert.match(step, /missing_dates=/);
});

// verify-archive-sync.yml「Check Nankan archive sync」: unified のみ（per-venue へ fallback しない）
test('verify(南関): 結果は unified checkSharedDailyFile のみ・per-venue 不使用', () => {
  const step = extractStep(readWf('verify-archive-sync.yml'), 'Check Nankan archive sync');
  assert.match(step, /checkSharedDailyFile\.mjs --date "\$DATE" --category nankan --kind results/);
  assert.doesNotMatch(step, /checkSharedNankanResults/); // per-venue fallback しない
});
test('verify(南関): FOUND=false（unified 404）→ 結果なし側（no_results へ）', () => {
  const step = extractStep(readWf('verify-archive-sync.yml'), 'Check Nankan archive sync');
  // RES_FOUND!=true の else で no_results 判定
  assert.match(step, /if \[ "\$RES_FOUND" = "true" \][\s\S]*?else[\s\S]*?NO_RESULTS_ALERT=true/);
});
test('verify(南関): 12R 未満は skipped（未完成）/ 12R以上で archive 比較', () => {
  const step = extractStep(readWf('verify-archive-sync.yml'), 'Check Nankan archive sync');
  assert.match(step, /RACE_COUNT" -ge 12/);
  assert.match(step, /< 12/);
});
test('verify(南関): output 名は alert_needed/missing_dates/no_results_alert/no_results_dates のまま', () => {
  const wf = readWf('verify-archive-sync.yml');
  for (const k of ['alert_needed=', 'missing_dates=', 'no_results_alert=', 'no_results_dates=']) {
    assert.ok(wf.includes(k), `output ${k} が維持されている`);
  }
});
test('verify(JRA): unified checkSharedDailyFile・≥10 gate・output 名維持（変更なし）', () => {
  const step = extractStep(readWf('verify-archive-sync.yml'), 'Check JRA archive sync');
  assert.match(step, /checkSharedDailyFile\.mjs --date "\$DATE" --category jra --kind results/);
  assert.match(step, /checkSharedDailyFile\.mjs --date "\$DATE" --category jra --kind predictions/);
  assert.match(step, /RACE_COUNT" -ge 10/);
});

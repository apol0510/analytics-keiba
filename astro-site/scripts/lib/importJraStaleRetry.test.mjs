/**
 * importJraStaleRetry.test.mjs — JRA import の突合ゲートにおける stale read bounded retry の統合テスト。
 *
 * 実行: node scripts/lib/importJraStaleRetry.test.mjs
 * AK のテスト規約（node + assert、CI は check:safety 集約）に従う。
 *
 * 固定する事故条件（2026-07-31 run 30617261216）:
 *   会場ごとの dispatch が連続した際、racebook 一覧に札幌しか現れないのに computer には
 *   中京/新潟が既に存在し、真コンピ指数>=45 の 266 頭が uncoveredHighCi となって FAIL した。
 *   実データは 3 会場とも正常で、後続 run では同じ入力が整合していた（＝一過性の stale read）。
 *
 * 本テストは fake client でその可視タイミングのズレを再現し、
 *   - stale read は bounded retry で吸収されること
 *   - 真の不整合は従来どおり fail-closed であること
 *   - retry 回数 / 待機時間が上限を超えないこと
 * を固定する。
 */
import assert from 'node:assert';
import { resolveSharedJsonWithComputerIndex, STALE_JOIN_RETRY } from '../importPredictionJra.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

const DATE = '2026-08-01';
const PRED_PATH = 'jra/predictions/2026/08/2026-08-01.json';
const RACEBOOK_DIR = 'jra/racebook/2026/08';
const COMPUTER_DIR = 'jra/predictions/computer/2026/08';

/** 会場定義: { code, track, races:[{rn, horses:[[number, name, ci]]}] } */
function venue(code, track, races) {
  return { code, track, races };
}
/** 12頭立て1レースの単純な会場（馬番 1..n / ci は 46 以上＝ゲート対象） */
function simpleVenue(code, track, count = 3) {
  const horses = Array.from({ length: count }, (_, i) => [i + 1, `${track}馬${i + 1}`, 50 + i]);
  return venue(code, track, [{ rn: 1, horses }]);
}

function racebookBody(v) {
  return {
    date: DATE,
    track: v.track,
    races: v.races.map(r => ({
      raceNumber: r.rn,
      horses: r.horses.map(([number, name]) => ({ number, name, totalScore: 0, assignment: '補欠' })),
    })),
  };
}
function computerBody(v) {
  return {
    date: DATE,
    venue: v.track,
    races: v.races.map(r => ({
      raceNumber: r.rn,
      horses: r.horses.map(([number, name, computerIndex]) => ({ number, name, computerIndex })),
    })),
  };
}

/**
 * 取得ごとに「見え方」が変わる fake client。
 * states[i] = { racebook: Venue[], computer: Venue[] } を i 回目の取得で返す。
 * states を超えた回は最後の state を繰り返す（＝解消しないケースの再現）。
 */
function makeFakeClient(states) {
  let attempt = -1;
  const calls = { attempts: 0, racebookList: 0, computerList: 0 };
  const current = () => states[Math.min(attempt, states.length - 1)];
  const listing = (venues) => venues.map(v => ({
    name: `${DATE}-${v.code}.json`,
    path: `${v.dir}/${DATE}-${v.code}.json`,
    sha: `sha-${v.code}`,
    size: 100,
    type: 'file',
  }));

  const client = {
    async fetchJson(path, { required = true } = {}) {
      if (path === PRED_PATH) {
        // 各 attempt の最初に必ず 1 回だけ呼ばれる（統合 predictions は未投入 = null）
        attempt++;
        calls.attempts++;
        assert.strictEqual(required, false, '統合 predictions は required:false で読むこと');
        return null;
      }
      const st = current();
      const name = path.split('/').pop();
      const pool = path.startsWith(`${RACEBOOK_DIR}/`) ? st.racebook : st.computer;
      const v = pool.find(x => `${DATE}-${x.code}.json` === name);
      if (!v) return null;
      return path.startsWith(`${RACEBOOK_DIR}/`) ? racebookBody(v) : computerBody(v);
    },
    async listDirectory(path) {
      const st = current();
      if (path === RACEBOOK_DIR) {
        calls.racebookList++;
        if (st.racebook === null) return null;
        return listing(st.racebook.map(v => ({ ...v, dir: RACEBOOK_DIR })));
      }
      if (path === COMPUTER_DIR) {
        calls.computerList++;
        if (st.computer === null) return null;
        return listing(st.computer.map(v => ({ ...v, dir: COMPUTER_DIR })));
      }
      return null;
    },
  };
  return { client, calls };
}

/** sleep を実行せず待機量だけ記録する（テストは即時完了させる） */
function makeSleepRecorder() {
  const waits = [];
  return { waits, sleepImpl: async (ms) => { waits.push(ms); } };
}

const CHU = simpleVenue('CHU', '中京');
const NII = simpleVenue('NII', '新潟');
const SAP = simpleVenue('SAP', '札幌');
const ALL3 = [CHU, NII, SAP];

console.log('━━━ JRA import stale-read bounded retry 統合テスト ━━━');

// 1. 2026-07-31 事故条件: 初回 racebook=札幌のみ / computer=3会場 → 再取得で 3 会場 → PASS
await t('1. 初回 racebook=札幌のみ・computer=3会場 → retry 後 3 会場で PASS', async () => {
  const { client, calls } = makeFakeClient([
    { racebook: [SAP], computer: ALL3 },   // 1 回目: 中京/新潟の racebook がまだ見えない
    { racebook: ALL3, computer: ALL3 },    // 2 回目: 伝播完了
  ]);
  const { waits, sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });

  assert.ok(res, 'retry 後は取得できること');
  assert.strictEqual(res.sharedJSON.venues.length, 3, '3 会場すべてが取り込まれる');
  assert.strictEqual(res.stats.uncoveredHighCi.length, 0, '未対応ci≥45 は 0 件');
  assert.strictEqual(res.stats.injected, 9, '3 会場 × 3 頭に sourceComputerIndex が注入される');
  assert.strictEqual(calls.attempts, 2, '再取得は 1 回で足りる');
  assert.deepStrictEqual(waits, [STALE_JOIN_RETRY.backoffMs[0]], '待機は 1 回目の backoff のみ');
});

// 2. retry 後も racebook が不足したまま → 従来どおり FAIL（fail-closed）
await t('2. retry 後も racebook 不足 → FAIL（未対応ci≥45 を報告）', async () => {
  const { client, calls } = makeFakeClient([{ racebook: [SAP], computer: ALL3 }]); // 永続的に不足
  const { waits, sleepImpl } = makeSleepRecorder();
  await assert.rejects(
    () => resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl }),
    /真コンピ指数>=45 の racebook 未対応 6 件/,
    '解消しない不足は FAIL させる',
  );
  assert.strictEqual(calls.attempts, STALE_JOIN_RETRY.maxRetries + 1, '初回 + maxRetries 回で打ち切る');
  assert.strictEqual(waits.length, STALE_JOIN_RETRY.maxRetries);
});

// 3. racebook は 3 会場そろっているが馬番が join しない → 真の不整合として FAIL
await t('3. racebook は存在するが馬番 join 不一致 → FAIL', async () => {
  const shiftedCHU = venue('CHU', '中京', [{ rn: 1, horses: [[7, '中京馬7', 50], [8, '中京馬8', 51], [9, '中京馬9', 52]] }]);
  const { client } = makeFakeClient([{ racebook: [shiftedCHU, NII, SAP], computer: ALL3 }]);
  const { sleepImpl } = makeSleepRecorder();
  await assert.rejects(
    () => resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl }),
    /真コンピ指数>=45 の racebook 未対応 3 件/,
    '馬番が対応しない馬を黙って不要馬化しない',
  );
});

// 4. computer 側が丸ごと欠落 → 既存挙動維持（注入せず PASS。FAIL させない）
await t('4. computer ディレクトリなし → 既存挙動どおり注入なしで通過', async () => {
  const { client, calls } = makeFakeClient([{ racebook: ALL3, computer: null }]);
  const { waits, sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.ok(res);
  assert.strictEqual(res.stats, null, 'computer が無い日は注入も検証もしない');
  assert.strictEqual(res.sharedJSON.venues.length, 3);
  assert.strictEqual(calls.attempts, 1, 'retry しない');
  assert.deepStrictEqual(waits, []);
});

// 4b. computer に 1 会場だけ存在（racebook は 3 会場）→ 未対応は発生しないので PASS
await t('4b. computer が 1 会場のみ → 未対応 0 件で通過（racebook 側の余剰は FAIL 条件ではない）', async () => {
  const { client, calls } = makeFakeClient([{ racebook: ALL3, computer: [SAP] }]);
  const { sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.ok(res);
  assert.strictEqual(res.stats.uncoveredHighCi.length, 0);
  assert.strictEqual(res.stats.injected, 3, '札幌の 3 頭だけ注入される');
  assert.strictEqual(calls.attempts, 1, 'retry しない');
});

// 5. 正常な 3 会場 → retry 不要で PASS
await t('5. 正常 3 会場 → retry 0 回で PASS', async () => {
  const { client, calls } = makeFakeClient([{ racebook: ALL3, computer: ALL3 }]);
  const { waits, sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.ok(res);
  assert.strictEqual(res.stats.uncoveredHighCi.length, 0);
  assert.strictEqual(calls.attempts, 1);
  assert.deepStrictEqual(waits, [], '正常時は 1ms も待たない');
});

// 6. retry 回数 / 待機時間が上限を超えない
await t('6. retry 回数・累計待機が上限を超えない', async () => {
  assert.ok(STALE_JOIN_RETRY.maxRetries >= 1 && STALE_JOIN_RETRY.maxRetries <= 3, 'maxRetries は 1..3');
  const sum = STALE_JOIN_RETRY.backoffMs.reduce((a, b) => a + b, 0);
  assert.ok(sum <= STALE_JOIN_RETRY.maxTotalWaitMs, 'backoff 合計は maxTotalWaitMs 以内');

  const { client, calls } = makeFakeClient([{ racebook: [SAP], computer: ALL3 }]);
  const { waits, sleepImpl } = makeSleepRecorder();
  await assert.rejects(() => resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl }));
  assert.strictEqual(calls.attempts, STALE_JOIN_RETRY.maxRetries + 1, '取得回数は初回 + maxRetries が上限');
  assert.strictEqual(calls.racebookList, STALE_JOIN_RETRY.maxRetries + 1, '毎回 racebook を再取得している（sleep だけの空回りではない）');
  assert.strictEqual(calls.computerList, STALE_JOIN_RETRY.maxRetries + 1, '毎回 computer も再取得している');
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= STALE_JOIN_RETRY.maxTotalWaitMs, `累計待機 ${total}ms が上限 ${STALE_JOIN_RETRY.maxTotalWaitMs}ms 以内`);
});

// 7. computer 側の馬番重複（ambiguous）は stale read で説明できない → retry せず即 FAIL
await t('7. computer 馬番重複 → retry せず即 FAIL', async () => {
  const dup = venue('CHU', '中京', [{ rn: 1, horses: [[1, 'A', 60], [1, 'B', 55]] }]);
  const rb = venue('CHU', '中京', [{ rn: 1, horses: [[1, 'A', 60]] }]);
  const { client, calls } = makeFakeClient([{ racebook: [rb], computer: [dup] }]);
  const { waits, sleepImpl } = makeSleepRecorder();
  await assert.rejects(
    () => resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl }),
    /馬番重複/,
  );
  assert.strictEqual(calls.attempts, 1, '単一ファイル内の欠陥は再取得しても変わらないため retry しない');
  assert.deepStrictEqual(waits, []);
});

// 8. computer だけ見えて racebook が 0 件 → retry するが、最終挙動は従来どおり skip（契約変更なし）
await t('8. racebook 0 件 + computer あり → retry 後も無ければ従来どおり skip(null)', async () => {
  const { client, calls } = makeFakeClient([{ racebook: null, computer: ALL3 }]);
  const { sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.strictEqual(res, null, '未投入日の成功終了という既存契約は変えない');
  assert.strictEqual(calls.attempts, STALE_JOIN_RETRY.maxRetries + 1, '上限までは再取得を試みる');
});

// 8b. racebook 0 件が retry 中に解消 → PASS
await t('8b. racebook 0 件 → retry 中に出現すれば PASS', async () => {
  const { client, calls } = makeFakeClient([
    { racebook: null, computer: ALL3 },
    { racebook: ALL3, computer: ALL3 },
  ]);
  const { sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.ok(res);
  assert.strictEqual(res.sharedJSON.venues.length, 3);
  assert.strictEqual(calls.attempts, 2);
});

// 9. racebook も computer も無い通常の未投入日 → retry せず skip
await t('9. racebook / computer とも無し → retry せず skip(null)', async () => {
  const { client, calls } = makeFakeClient([{ racebook: null, computer: null }]);
  const { waits, sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.strictEqual(res, null);
  assert.strictEqual(calls.attempts, 1, '待つ理由がないので retry しない');
  assert.deepStrictEqual(waits, []);
});

// 10. racebook ファイル内容が古い版（頭数不足）→ 再取得で完全版になれば PASS（2026-07-18 型）
await t('10. racebook 内容が古い版（頭数不足）→ 再取得で完全版になれば PASS', async () => {
  const full = simpleVenue('KOK', '小倉', 3);
  // 同一レース内で末尾の馬番だけ欠けた版（2026-07-18 の 小倉R9 #9-#18 欠落と同型）
  const truncated = venue('KOK', '小倉', [{ rn: 1, horses: full.races[0].horses.slice(0, 2) }]);
  const { client, calls } = makeFakeClient([
    { racebook: [truncated], computer: [full] },
    { racebook: [full], computer: [full] },
  ]);
  const { sleepImpl } = makeSleepRecorder();
  const res = await resolveSharedJsonWithComputerIndex(DATE, 'jra', client, { sleepImpl });
  assert.ok(res);
  assert.strictEqual(res.stats.uncoveredHighCi.length, 0);
  assert.strictEqual(res.stats.injected, 3);
  assert.strictEqual(calls.attempts, 2);
});

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

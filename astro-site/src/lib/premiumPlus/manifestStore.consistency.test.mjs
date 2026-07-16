/**
 * manifestStore.consistency.test.mjs — eventual consistency 下の lost-update 否定（決定的検証）
 *   node --test src/lib/premiumPlus/manifestStore.consistency.test.mjs
 *
 * 目的（canary #10/#11/#13/#18 の timing 失敗に対する構造的保証）:
 *   - 正当性の hard guarantee は atomic pointer CAS（stale etag では絶対に上書きできない）。
 *   - 鮮度は readCurrentStable の収束読取（有限 retry + backoff で max logicalVersion を採用）。
 *     収束は best-effort（read-your-writes 近似）だが、収束に失敗しても CAS が破損を止める＝fail-closed。
 *
 * staleness 模擬: manifest-current の read だけを K 回 stale スナップショットで返す薄いラッパ。
 *   書込（CAS / create-only）は実ストアの atomic セマンティクスをそのまま通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, mediaKeys } from './mediaKeys.js';
import { applyUpload, applyVisibility, readCurrent, readCurrentStable } from './manifestStore.js';
import { validateImage } from './imageValidation.js';
import { validateUploadMeta } from './uploadValidation.js';
import { makePng } from './testHelpers.mjs';

const NOW = 1000;
const instant = () => Promise.resolve();
async function img(w = 200) { return validateImage(makePng(w)); }
function meta(date, over = {}) {
  return validateUploadMeta({ date, venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000, ...over }).meta;
}
const manifestKeys = (store) => [...store._json.keys()].filter((k) => k.startsWith('manifests/'));

/** manifest-current の read を count 回だけ stale スナップショットで返す（書込は素通し）。 */
function withStalePointer(store, { staleValue, staleEtag, count }) {
  let left = count;
  const reads = { pointer: 0 };
  return {
    reads,
    getJSONWithEtag: async (key) => {
      if (key === mediaKeys.current()) {
        reads.pointer += 1;
        if (left > 0) { left -= 1; return { value: staleValue ?? null, etag: staleEtag ?? null }; }
      }
      return store.getJSONWithEtag(key);
    },
    getBytes: (k) => store.getBytes(k),
    setJSON: (k, o) => store.setJSON(k, o),
    setJSONIfNew: (k, o) => store.setJSONIfNew(k, o),
    setJSONIfMatch: (k, o, e) => store.setJSONIfMatch(k, o, e),
    setBytesIfNew: (k, b, m) => store.setBytesIfNew(k, b, m),
  };
}

async function seedV1(store) {
  const r = await applyUpload({ store, image: await img(), meta: meta('2099-12-31'), operationId: 'seed-op', expectedVersion: 0, now: NOW, newId: () => 'm-seed' });
  assert.equal(r.version, 1);
  return r;
}

// ── 1. 同一 base version からの並行 2 更新で成功は最大 1 件・敗者は 409 ──
test('C1 同一 base の並行 2 writer → 成功 1 件・敗者 pointer_conflict・current は 1 回だけ前進', async () => {
  const store = createMemoryStore();
  await seedV1(store);
  const snap = await readCurrent(store); // 両 writer が読む同一 base（v1 / etag E1）
  const a = await applyVisibility({ store, date: '2099-12-31', visible: false, operationId: 'opA', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-A' });
  const b = await applyUpload({ store, image: await img(220), meta: meta('2099-12-30'), operationId: 'opB', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-B' });
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1); // ちょうど 1 件成功
  const loser = a.ok ? b : a;
  assert.equal(loser.conflict, true);
  assert.equal(loser.reason, 'pointer_conflict');
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 2); // current は 1→2 の 1 段だけ（lost-update で 2 段進まない）
});

// ── 2. stale manifest-current 読取でも既存勝者を上書きしない ──
test('C2 stale snap を preread した敗者の CAS は失敗し、勝者の状態が保持される', async () => {
  const store = createMemoryStore();
  await seedV1(store);
  const staleSnap = await readCurrent(store); // v1 / etag E1（後で stale になる）
  // 勝者 A: hide で v2 へ（pointer は E1→E2 へ atomic 前進）
  const a = await applyVisibility({ store, date: '2099-12-31', visible: false, operationId: 'opA', expectedVersion: 1, now: NOW, newId: () => 'm-A' });
  assert.equal(a.ok, true);
  assert.equal(a.version, 2);
  // 敗者 B: stale な v1 snap を掴んだまま show を試みる（現実の eventual read 遅延を模擬）
  const b = await applyVisibility({ store, date: '2099-12-31', visible: true, operationId: 'opB', expectedVersion: 1, now: NOW, preread: staleSnap, newId: () => 'm-B' });
  assert.equal(b.ok, false); // stale etag の CAS は通らない
  assert.equal(b.reason, 'pointer_conflict');
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 2); // 勝者のまま
  const entry = cur.manifest.entries.find((e) => e.date === '2099-12-31');
  assert.equal(entry.visible, false); // 勝者 A の hide が保持され、敗者 B の show で上書きされない
});

// ── 3. 書込直後の eventual read 遅延を模擬しても収束読取が最新 version に収束（#10/#18 系）──
test('C3 readCurrentStable は stale read を乗り越えて最新 version へ収束する', async () => {
  const base = createMemoryStore();
  await seedV1(base);
  const staleRaw = await base.getJSONWithEtag(mediaKeys.current()); // v1 スナップ
  // v2 へ前進させる（この後 pointer read が暫く v1 を返す状況を作る）
  await applyVisibility({ store: base, date: '2099-12-31', visible: false, operationId: 'adv', expectedVersion: 1, now: NOW, newId: () => 'm-adv' });
  // 最初の 2 read は stale v1、その後は実 v2
  const wrapped = withStalePointer(base, { staleValue: staleRaw.value, staleEtag: staleRaw.etag, count: 2 });
  const converged = await readCurrentStable(wrapped, { waiter: instant, minVersion: 2 });
  assert.equal(converged.logicalVersion, 2); // stale を越えて最新へ収束
  assert.ok(wrapped.reads.pointer >= 3); // 有限回だが複数 read で収束（1 発読みではない）
});

// ── 4. status 相当（minVersion 無し）でも max 採用で書込直後 version を拾う（#10）──
test('C4 minVersion 無しの収束読取でも、単発 stale の直後に最新 version を採用する', async () => {
  const base = createMemoryStore();
  await seedV1(base);
  // pointer 未初期化相当の stale（v0 空）を 1 回だけ返す → その後実 v1
  const wrapped = withStalePointer(base, { staleValue: null, staleEtag: null, count: 1 });
  const r = await readCurrentStable(wrapped, { waiter: instant }); // status は minVersion を渡さない
  assert.equal(r.logicalVersion, 1); // max 採用で v0 に潰れない
});

// ── 5. 同一 operationId の並行実行で副作用は 1 回（冪等）──
test('C5 同一 operationId の並行 upload → 公開 manifest は 1 つ・version は 1・再送は idempotent', async () => {
  const store = createMemoryStore();
  const p = { store, image: await img(), meta: meta('2099-12-31'), operationId: 'dup-op', expectedVersion: 0, now: NOW };
  // Promise.all で interleave 実行（両者とも空 base を読む）
  const [r1, r2] = await Promise.all([
    applyUpload({ ...p, image: await img(), newId: () => 'm-1' }),
    applyUpload({ ...p, image: await img(), newId: () => 'm-2' }),
  ]);
  const oks = [r1, r2].filter((r) => r.ok);
  assert.ok(oks.length >= 1); // 少なくとも 1 件成功
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 1); // 副作用 1 回（version は 2 に増えない）
  assert.equal(cur.manifest.entries.filter((e) => e.date === '2099-12-31').length, 1);
  // 再送は必ず idempotent（新 manifest を作らない）
  const before = manifestKeys(store).length;
  const again = await applyUpload({ store, image: await img(), meta: meta('2099-12-31'), operationId: 'dup-op', expectedVersion: 1, now: NOW });
  assert.equal(again.idempotent, true);
  assert.equal(again.version, 1);
  assert.equal(manifestKeys(store).length, before); // 総数不変
});

// ── 6. retry 上限超過は fail-closed（収束できなくても破損しない）──
test('C6 収束できないほど stale が続いても、書込は VERSION_CONFLICT で fail-closed（勝者不変）', async () => {
  const base = createMemoryStore();
  await seedV1(base);
  const staleRaw = await base.getJSONWithEtag(mediaKeys.current()); // v1 スナップ
  await applyVisibility({ store: base, date: '2099-12-31', visible: false, operationId: 'adv', expectedVersion: 1, now: NOW, newId: () => 'm-adv' }); // 実は v2
  // pointer read が「常に」v1 stale を返す（伝播が retry 予算を超えて続く状況）
  const wrapped = withStalePointer(base, { staleValue: staleRaw.value, staleEtag: staleRaw.etag, count: 999 });
  const preread = await readCurrentStable(wrapped, { waiter: instant, minVersion: 2, attempts: 5 });
  assert.equal(preread.logicalVersion, 1); // 収束できず best（=見えている最大）を返す（無制限 retry しない）
  // この stale preread で v2 相当の書込を試みる → CAS/version が破損を止める
  const w = await applyVisibility({ store: wrapped, date: '2099-12-31', visible: true, operationId: 'late', expectedVersion: 2, now: NOW, preread, newId: () => 'm-late' });
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'version_conflict'); // expectedVersion(2) !== stale currentVersion(1) → fail-closed
  const cur = await readCurrent(base); // 実ストアの真実
  assert.equal(cur.logicalVersion, 2); // 勝者不変
  assert.equal(cur.manifest.entries.find((e) => e.date === '2099-12-31').visible, false);
});

// ── 7. 敗者は有限 retry 後に新 version として正しく再適用される ──
test('C7 別 operation の敗者は re-read → expectedVersion 更新で v3 として正しく再適用される', async () => {
  const store = createMemoryStore();
  await seedV1(store);
  const snap = await readCurrent(store); // v1
  const a = await applyVisibility({ store, date: '2099-12-31', visible: false, operationId: 'opA', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-A' });
  const b = await applyUpload({ store, image: await img(220), meta: meta('2099-12-30'), operationId: 'opB', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-B' });
  const winner = a.ok ? a : b;
  const loser = a.ok ? b : a;
  assert.equal(winner.ok, true);
  assert.equal(loser.ok, false); // pointer_conflict
  // 敗者が re-read して正しい expectedVersion で再適用
  const fresh = await readCurrent(store); // v2
  assert.equal(fresh.logicalVersion, 2);
  const retry = loser === b
    ? await applyUpload({ store, image: await img(220), meta: meta('2099-12-30'), operationId: 'opB', expectedVersion: 2, now: NOW, newId: () => 'm-B2' })
    : await applyVisibility({ store, date: '2099-12-31', visible: false, operationId: 'opA', expectedVersion: 2, now: NOW, newId: () => 'm-A2' });
  assert.equal(retry.ok, true);
  assert.equal(retry.version, 3); // 敗者データは失われず v3 として反映
});

// ── 8. versioned manifest は immutable（過去 version を上書きしない）──
test('C8 過去 manifest は create-only で不変・pointer 前進後も内容が変わらない', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2099-12-31'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' });
  const snapshotV1 = JSON.stringify((await store.getJSONWithEtag(mediaKeys.manifest('m-1'))).value);
  await applyVisibility({ store, date: '2099-12-31', visible: false, operationId: 'op2', expectedVersion: 1, now: NOW, newId: () => 'm-2' }); // v2
  await applyUpload({ store, image: await img(240), meta: meta('2099-12-29'), operationId: 'op3', expectedVersion: 2, now: NOW, newId: () => 'm-3' }); // v3
  // 過去 manifest m-1 の中身は不変
  assert.equal(JSON.stringify((await store.getJSONWithEtag(mediaKeys.manifest('m-1'))).value), snapshotV1);
  // create-only は既存 manifest を上書きしない
  assert.equal((await store.setJSONIfNew(mediaKeys.manifest('m-1'), { tampered: true })).modified, false);
  assert.equal(JSON.stringify((await store.getJSONWithEtag(mediaKeys.manifest('m-1'))).value), snapshotV1);
});

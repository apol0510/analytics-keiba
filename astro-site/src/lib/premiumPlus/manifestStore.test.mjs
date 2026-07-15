/**
 * manifestStore.test.mjs — UUID manifest の atomic 更新（CAS / 冪等 / 競合 / orphan 非阻害）
 *   node --test src/lib/premiumPlus/manifestStore.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, mediaKeys } from './mediaKeys.js';
import { applyUpload, applyVisibility, applyRollback, applySeedStage, applySeedCommit, readCurrent } from './manifestStore.js';
import { validateImage } from './imageValidation.js';
import { validateUploadMeta } from './uploadValidation.js';
import { makePng } from './testHelpers.mjs';

const NOW = 1000;
async function img(w = 200) { return validateImage(makePng(w)); }
function meta(date, over = {}) {
  return validateUploadMeta({ date, venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000, ...over }).meta;
}
function legacyMeta(date) {
  return validateUploadMeta({ date, venue: '大井', raceNumber: 11, stake: 16000, isHit: true, payout: 300000, legacy: true }, { allowLegacy: true }).meta;
}
const val = async (store, key) => (await store.getJSONWithEtag(key)).value;
const manifestKeys = (store) => [...store._json.keys()].filter((k) => k.startsWith('manifests/'));
function idGen(prefix) { let n = 0; return () => `${prefix}-${++n}`; }

// ---- 低レベル CAS プリミティブ ----
test('create-only: 既存キーは modified:false', async () => {
  const store = createMemoryStore();
  assert.equal((await store.setJSONIfNew('k', { a: 1 })).modified, true);
  assert.equal((await store.setJSONIfNew('k', { a: 2 })).modified, false);
  assert.deepEqual(await val(store, 'k'), { a: 1 }); // 上書きされない
});

test('CAS: stale etag は modified:false', async () => {
  const store = createMemoryStore();
  const w1 = await store.setJSONIfNew('p', { v: 1 });
  const w2 = await store.setJSONIfMatch('p', { v: 2 }, w1.etag); // 一致 → 成功
  const w3 = await store.setJSONIfMatch('p', { v: 3 }, w1.etag); // stale → 失敗
  assert.equal(w2.modified, true);
  assert.equal(w3.modified, false);
  assert.deepEqual(await val(store, 'p'), { v: 2 });
});

// #20 operationId 再送が冪等
test('#20 同一 operationId + 同一 payload 再送は冪等（新 manifest を作らない）', async () => {
  const store = createMemoryStore();
  const first = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  assert.equal(first.version, 1);
  const before = manifestKeys(store).length;
  const again = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 1, now: NOW });
  assert.equal(again.idempotent, true);
  assert.equal(again.version, 1);
  assert.equal(manifestKeys(store).length, before); // manifest 総数が増えない
});

// 同一 operationId + 異なる payload → 409 mismatch
test('同一 operationId + 異なる payload → OPERATION_MISMATCH', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15', { payout: 277000 }), operationId: 'op1', expectedVersion: 0, now: NOW });
  const diff = await applyUpload({ store, image: await img(), meta: meta('2026-07-15', { payout: 555000 }), operationId: 'op1', expectedVersion: 1, now: NOW });
  assert.equal(diff.ok, false);
  assert.equal(diff.conflict, true);
  assert.equal(diff.reason, 'operation_mismatch');
});

// #21 expectedVersion 不一致 → 409
test('#21 expectedVersion 不一致 → conflict', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  const r = await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'op2', expectedVersion: 0, now: NOW });
  assert.equal(r.conflict, true);
  assert.equal(r.currentVersion, 1);
});

// ---- #7-8: 同時 writer は pointer CAS で片方だけ成功・敗者の orphan は後続を阻害しない ----
test('#7/#8 同一 current を読む 2 writer → 片方だけ pointer CAS 成功・敗者 orphan は後続を阻害しない', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' }); // v1
  const snap = await readCurrent(store); // v1 / etag E
  const a = await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'A', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-A' });
  const b = await applyUpload({ store, image: await img(240), meta: meta('2026-07-17'), operationId: 'B', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'm-B' });
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1); // #7 ちょうど 1 つ成功
  const loser = a.ok ? b : a;
  assert.equal(loser.conflict, true);
  assert.equal(loser.reason, 'pointer_conflict');
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 2);
  // 敗者・勝者の manifest は両方書かれている（敗者側が current 非参照の orphan）
  assert.ok(manifestKeys(store).includes('manifests/m-A') && manifestKeys(store).includes('manifests/m-B'));
  const winnerId = a.ok ? 'm-A' : 'm-B';
  const orphanId = a.ok ? 'm-B' : 'm-A';
  assert.equal(cur.manifestId, winnerId);
  assert.notEqual(cur.manifestId, orphanId); // 敗者 orphan は参照されない
  // #8 orphan があっても次回更新は別 manifestId で成功
  const next = await applyUpload({ store, image: await img(260), meta: meta('2026-07-18'), operationId: 'op4', expectedVersion: 2, now: NOW, newId: () => 'm-4' });
  assert.equal(next.ok, true);
  assert.equal(next.version, 3);
  assert.equal((await readCurrent(store)).manifestId, 'm-4');
});

// ---- #1-6: pointer CAS が throw → orphan 残・current 不変・次更新は別 manifestId で成功 ----
test('#1-6 pointer CAS throw → orphan 残・current 不変・次回別 operationId が別 manifestId で成功', async () => {
  let throwPointer = false;
  const store = createMemoryStore({ shouldFail: (op, key) => throwPointer && key === mediaKeys.current() && op === 'setJSONIfMatch' });
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' }); // v1

  // #1 manifest 保存成功後に pointer CAS を throw させる
  throwPointer = true;
  const failed = await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'op2', expectedVersion: 1, now: NOW, newId: () => 'm-2' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'pointer_switch_failed');

  const cur = await readCurrent(store);
  assert.equal(cur.manifestId, 'm-1'); // #2 current は旧状態のまま
  assert.equal(cur.logicalVersion, 1);
  // #3 orphan manifest が 1 件残る（m-2 は書かれたが current 非参照）
  assert.deepEqual(manifestKeys(store).sort(), ['manifests/m-1', 'manifests/m-2']);
  // #6 orphan は公開 current として参照されない
  assert.notEqual(cur.manifestId, 'm-2');
  assert.equal(cur.manifest.entries.some((e) => e.date === '2026-07-16'), false);

  // #4 次回別 operationId の更新は別 manifestId を使って正常成功
  throwPointer = false;
  const ok = await applyUpload({ store, image: await img(240), meta: meta('2026-07-17'), operationId: 'op3', expectedVersion: 1, now: NOW, newId: () => 'm-3' });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifestId, 'm-3');
  const cur2 = await readCurrent(store);
  assert.equal(cur2.manifestId, 'm-3');
  assert.equal(cur2.logicalVersion, 2); // #5 logicalVersion は 1 だけ進む
});

// hide も同一 commit()（CAS）を通る
test('hide も同一 CAS（同時実行で片方だけ成功）', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'seed', expectedVersion: 0, now: NOW }); // v1
  const snap = await readCurrent(store);
  const a = await applyVisibility({ store, date: '2026-07-15', visible: false, operationId: 'A', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'h-A' });
  const b = await applyVisibility({ store, date: '2026-07-15', visible: true, operationId: 'B', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'h-B' });
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal((await readCurrent(store)).logicalVersion, 2);
});

// #23 画像保存失敗 → current 不変
test('#23 画像保存失敗 → current 不変・manifest 未作成', async () => {
  const store = createMemoryStore({ shouldFail: (op) => op === 'setBytesIfNew' });
  const r = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(await val(store, mediaKeys.current()), null);
  assert.equal(manifestKeys(store).length, 0);
});

// #24 manifest 保存失敗 → current 不変
test('#24 manifest 保存失敗 → current 不変', async () => {
  const store = createMemoryStore({ shouldFail: (op, key) => op === 'setJSONIfNew' && key.startsWith('manifests/') });
  const r = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  assert.equal(r.ok, false);
  assert.equal((await readCurrent(store)).logicalVersion, 0);
});

// current 切替後に audit 保存だけ失敗しても公開は成立し、再送で冪等回収
test('audit(best-effort) 失敗後の再送は冪等（二重更新しない）', async () => {
  const store = createMemoryStore({ shouldFail: (op) => op === 'setJSON' }); // op/audit の無条件書き込みだけ失敗
  const a = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  assert.equal(a.ok, true); // best-effort 失敗でも公開成立
  assert.equal(a.version, 1);
  const before = manifestKeys(store).length;
  const b = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 1, now: NOW });
  assert.equal(b.idempotent, true); // manifest.operationId で回収
  assert.equal(manifestKeys(store).length, before); // 二重更新なし
});

// #26 / #9 rollback は過去 manifest を新 manifestId としてコピー発行（UUID 経路）
test('#9/#26 rollback は previousManifestId チェーンを辿り新 manifestId でコピー発行', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' }); // v1
  await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'op2', expectedVersion: 1, now: NOW, newId: () => 'm-2' }); // v2
  const r = await applyRollback({ store, targetVersion: 1, operationId: 'opR', expectedVersion: 2, now: NOW, newId: () => 'm-3' });
  assert.equal(r.ok, true);
  assert.equal(r.version, 3);
  assert.equal(r.rolledBackFrom, 1);
  assert.equal(r.manifestId, 'm-3'); // 新 UUID
  const cur = await readCurrent(store);
  assert.equal(cur.manifestId, 'm-3');
  assert.deepEqual(cur.manifest.entries.map((e) => e.date), ['2026-07-15']); // v1 の内容へ
  assert.equal((await val(store, mediaKeys.manifest('m-1'))).entries.length, 1); // 過去 manifest immutable
  assert.equal((await val(store, mediaKeys.manifest('m-2'))).entries.length, 2);
});

// 復元: rollback も同一 commit()（CAS）を通る＝同時 rollback で片方だけ成功（旧「#12 rollback も同一 CAS」）
test('rollback も同一 CAS（同時実行で片方だけ成功・敗者は pointer_conflict）', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' }); // v1
  await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'op2', expectedVersion: 1, now: NOW, newId: () => 'm-2' }); // v2
  const snap = await readCurrent(store); // v2 を 2 writer が同時に起点にする
  const a = await applyRollback({ store, targetVersion: 1, operationId: 'A', expectedVersion: 2, now: NOW, preread: snap, newId: () => 'r-A' });
  const b = await applyRollback({ store, targetVersion: 1, operationId: 'B', expectedVersion: 2, now: NOW, preread: snap, newId: () => 'r-B' });
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal((a.ok ? b : a).reason, 'pointer_conflict');
  assert.equal((await readCurrent(store)).logicalVersion, 3);
});

// #2 真の同時開始（Promise.all）— 両 writer が同一 pointer snapshot を起点にする
test('#2 Promise.all 同時開始 → 異なる manifestId・pointer 成功は 1 件・敗者 orphan・後続成功', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' }); // v1
  const snap = await readCurrent(store); // 同一 pointer snapshot（同一 etag）を確実に共有
  const imgA = await img(220); const imgB = await img(240);
  const [a, b] = await Promise.all([
    applyUpload({ store, image: imgA, meta: meta('2026-07-16'), operationId: 'A', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'pa' }),
    applyUpload({ store, image: imgB, meta: meta('2026-07-17'), operationId: 'B', expectedVersion: 1, now: NOW, preread: snap, newId: () => 'pb' }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1); // pointer 成功はちょうど 1 件
  assert.equal((a.ok ? b : a).reason, 'pointer_conflict'); // 敗者は pointer_conflict
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 2); // 1 だけ進む
  // 両 writer は異なる manifestId（pa / pb）を使用し、両方が durable に書かれている
  assert.ok(manifestKeys(store).includes('manifests/pa') && manifestKeys(store).includes('manifests/pb'));
  assert.ok(cur.manifestId === 'pa' || cur.manifestId === 'pb');
  assert.notEqual(cur.manifestId, a.ok ? 'pb' : 'pa'); // 敗者 orphan は非参照
  const next = await applyUpload({ store, image: await img(260), meta: meta('2026-07-18'), operationId: 'C', expectedVersion: 2, now: NOW, newId: () => 'm-next' });
  assert.equal(next.ok, true); // その後の別 writer は正常成功
  assert.equal(next.version, 3);
});

// #3(item3) 冪等 fast-path は version/manifestId/entry が同一時点（後続更新の混入なし）
test('#3 冪等再送は version/manifestId/entry が全て操作時点で一貫する', async () => {
  const store = createMemoryStore();
  // 1. upload op1（date D / payout X）
  const up1 = await applyUpload({ store, image: await img(200), meta: meta('2026-07-15', { payout: 111111 }), operationId: 'op1', expectedVersion: 0, now: NOW, newId: () => 'm-1' });
  assert.equal(up1.version, 1);
  // 2. 別 operation op2 で同じ日付 D の entry を変更（payout Y）
  await applyUpload({ store, image: await img(220), meta: meta('2026-07-15', { payout: 999999 }), operationId: 'op2', expectedVersion: 1, now: NOW, newId: () => 'm-2' });
  const curNow = await readCurrent(store);
  assert.equal(curNow.logicalVersion, 2);
  assert.equal(curNow.manifest.entries.find((e) => e.date === '2026-07-15').payout, 999999); // 現在は Y
  // 3. 最初の operationId を同一 payload で再送
  const replay = await applyUpload({ store, image: await img(200), meta: meta('2026-07-15', { payout: 111111 }), operationId: 'op1', expectedVersion: 2, now: NOW, newId: () => 'must-not-be-used' });
  // 4. 返却 version / manifestId / entry が op1 時点（v1 / m-1 / payout X）で一致
  assert.equal(replay.idempotent, true);
  assert.equal(replay.version, 1);
  assert.equal(replay.manifestId, 'm-1');
  assert.equal(replay.entry.date, '2026-07-15');
  assert.equal(replay.entry.payout, 111111); // 現在(Y=999999)ではなく操作時点(X)
  assert.equal(manifestKeys(store).length, 2); // 新 manifest を作らない
});

// #27 物理削除を呼ばない
test('#27 delete を一切呼ばない・store に delete が無い', async () => {
  const store = createMemoryStore();
  await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  await applyRollback({ store, targetVersion: 1, operationId: 'opR', expectedVersion: 1, now: NOW });
  assert.equal(store.calls.some((c) => c[0] === 'delete'), false);
  assert.equal(typeof store.delete, 'undefined');
});

// #28 同日でも immutable image key
test('#28 同日でも別画像は別 immutable キー（旧画像を消さない）', async () => {
  const store = createMemoryStore();
  const a = await img(200);
  const b = await img(220);
  await applyUpload({ store, image: a, meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  await applyUpload({ store, image: b, meta: meta('2026-07-15'), operationId: 'op2', expectedVersion: 1, now: NOW });
  assert.notEqual(a.checksum, b.checksum);
  assert.ok(await store.getBytes(mediaKeys.image('2026-07-15', a.checksum)));
  assert.ok(await store.getBytes(mediaKeys.image('2026-07-15', b.checksum)));
  assert.equal((await readCurrent(store)).manifest.entries.find((e) => e.date === '2026-07-15').checksum, b.checksum);
});

// #29 checksum 不一致で公開しない
test('#29 保存画像の checksum 不一致 → 公開しない（current 不変）', async () => {
  const base = createMemoryStore();
  const store = {
    ...base,
    async getBytes(key) {
      const v = await base.getBytes(key);
      if (v && key.startsWith('images/')) { const b = v.bytes.slice(); b[0] ^= 0xff; return { ...v, bytes: b }; }
      return v;
    },
  };
  const r = await applyUpload({ store, image: await img(), meta: meta('2026-07-15'), operationId: 'op1', expectedVersion: 0, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'checksum_mismatch');
  assert.equal((await readCurrent(base)).logicalVersion, 0);
});

// #10 manifestId は operationId / ユーザー入力から直接作られない（実生成器＝UUID を使用）
test('#10 manifestId は operationId・入力から作られない（UUID）', async () => {
  const store = createMemoryStore();
  const operationId = 'my-operation-id-12345678';
  const date = '2026-07-15';
  const r = await applyUpload({ store, image: await img(), meta: meta(date), operationId, expectedVersion: 0, now: NOW }); // newId 注入なし＝実 UUID
  assert.equal(r.ok, true);
  assert.match(r.manifestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i); // UUID 形式
  assert.notEqual(r.manifestId, operationId);
  assert.equal(r.manifestId.includes(operationId), false);
  assert.equal(r.manifestId.includes(date), false); // 日付からも作られない
  // 2 回目（別 op）は別 UUID
  const r2 = await applyUpload({ store, image: await img(220), meta: meta('2026-07-16'), operationId: 'another-operation-id-000', expectedVersion: 1, now: NOW });
  assert.notEqual(r2.manifestId, r.manifestId);
});

// seed: ステージ → コミットで current は最後まで変わらない
test('seed stage は current を変えず、commit で一度だけ切替', async () => {
  const store = createMemoryStore();
  const a = await img(200); const b = await img(220);
  const s1 = await applySeedStage({ store, items: [{ meta: legacyMeta('2026-06-01'), image: a }] });
  const s2 = await applySeedStage({ store, items: [{ meta: legacyMeta('2026-06-02'), image: b }] });
  assert.equal(s1.ok, true); assert.equal(s2.ok, true);
  assert.equal((await readCurrent(store)).logicalVersion, 0); // ステージ中は current 不変
  const commit = await applySeedCommit({
    store, operationId: 'seedOp', expectedVersion: 0, now: NOW,
    items: [{ meta: legacyMeta('2026-06-01'), checksum: a.checksum }, { meta: legacyMeta('2026-06-02'), checksum: b.checksum }],
  });
  assert.equal(commit.ok, true);
  assert.equal(commit.count, 2);
  const cur = await readCurrent(store);
  assert.equal(cur.logicalVersion, 1);
  assert.equal(cur.manifest.entries.every((e) => e.legacy === true), true);
});

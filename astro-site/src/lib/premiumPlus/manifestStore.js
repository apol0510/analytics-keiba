/**
 * manifestStore.js — UUID キー manifest の atomic トランザクション（純粋・store 注入）
 *
 * 競合制御（Netlify Blobs の atomic conditional write を利用。外部ロック不要）:
 *   1. manifests/{manifestId} を create-only（onlyIfNew）で書く
 *        manifestId は UUID なので衝突しない → 各 writer は必ず自分の manifest を durable に書ける。
 *   2. manifest-current を preread した etag に対して CAS（onlyIfMatch）で切替える
 *        同じ current を読んだ 2 writer のうち pointer を進められるのは 1 人だけ（他は 409）。
 *   この 2 段が atomic なので read-then-write の TOCTOU にならない。
 *
 * ── orphan manifest（pointer CAS 失敗時）──
 *   pointer CAS が「throw（transient error）」または「modified:false（同時 writer の敗者）」でも、
 *   直前に書いた manifests/{manifestId} は current から参照されない orphan として残るだけ。
 *     - orphan は公開されない（GET は manifest-current が指す manifestId しか読まない）。
 *     - orphan は後続更新を阻害しない（次 writer は別 UUID を生成する。連番スロットを焼かない）。
 *     - 自動削除しない（削除は破壊的で in-flight の別 writer を消す危険がある）。
 *     - 将来の監査対象にはできる（previousManifestId チェーンから外れた manifestId を棚卸し可能）。
 *   pointer CAS 失敗時、current は不変・過去 manifest は immutable・敗者は勝者を削除しない。
 *
 * 冪等性（operationId ↔ payload 束縛）:
 *   - 各 manifest に operationId と operationFingerprint（payload の SHA-256）を刻む。
 *   - current が既にこの operationId で作られていれば:
 *       fingerprint 一致 → 冪等成功（再送・audit 保存失敗後の再送を回収し、新 manifest を作らない）
 *       fingerprint 不一致 → 409（同じ operationId に別 payload）
 *
 * 不変条件: 画像 immutable / 過去 manifest 不変 / 途中失敗で current 維持 / 物理削除なし /
 *   logicalVersion = current.logicalVersion + 1 / manifestId は UUID（operationId・入力から作らない）。
 */

import { mediaKeys, sha256hex } from './mediaKeys.js';
import { sortEntries } from '../premiumPlusShowcase.js';

export const TX_REJECT = Object.freeze({
  VERSION_CONFLICT: 'version_conflict', // expectedVersion 不一致（stale client）
  MANIFEST_ID_COLLISION: 'manifest_id_collision', // create-only 負け（UUID 衝突・天文学的に稀）
  POINTER_CONFLICT: 'pointer_conflict', // pointer CAS 負け（同時 writer の敗者・自 manifest は orphan 化）
  POINTER_SWITCH_FAILED: 'pointer_switch_failed', // pointer 切替が throw（current 不変・自 manifest は orphan 化）
  OPERATION_MISMATCH: 'operation_mismatch', // 同一 operationId・別 payload
  IMAGE_PERSIST_FAILED: 'image_persist_failed',
  CHECKSUM_MISMATCH: 'checksum_mismatch',
  MANIFEST_INVALID: 'manifest_invalid',
  MANIFEST_PERSIST_FAILED: 'manifest_persist_failed',
  TARGET_NOT_FOUND: 'target_not_found',
  ENTRY_NOT_FOUND: 'entry_not_found',
  EMPTY_ITEMS: 'empty_items',
  IMAGE_NOT_STAGED: 'image_not_staged',
});

/**
 * manifestId 生成器の境界:
 *   本番経路（handlers / Function アダプタ）は `newId` を一切渡さない → 必ず defaultNewId()
 *   ＝ crypto.randomUUID() が使われ、UUID 以外は保存され得ない。
 *   `newId` 注入はテスト専用（決定的な manifestId 'm-1' 等）。
 * さらに commit() 側で「非空・キー区切り文字を含まない文字列」を防御的に検証する（下記）。
 */
function defaultNewId() {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID unavailable');
  }
  return globalThis.crypto.randomUUID();
}

/** 現行 pointer / manifest / etag を読む。未初期化は logicalVersion 0 / manifestId null。 */
export async function readCurrent(store) {
  const { value: pointer, etag: pointerEtag } = await store.getJSONWithEtag(mediaKeys.current());
  const logicalVersion = Number.isInteger(pointer?.logicalVersion) ? pointer.logicalVersion : 0;
  const manifestId = typeof pointer?.manifestId === 'string' && pointer.manifestId.length > 0 ? pointer.manifestId : null;
  const empty = { logicalVersion: 0, manifestId: null, manifest: { logicalVersion: 0, entries: [] }, pointerEtag };
  if (logicalVersion <= 0 || !manifestId) return empty;
  const { value: manifest } = await store.getJSONWithEtag(mediaKeys.manifest(manifestId));
  if (!manifest || !Array.isArray(manifest.entries)) {
    return { logicalVersion, manifestId, manifest: { logicalVersion, entries: [] }, pointerEtag };
  }
  return { logicalVersion, manifestId, manifest, pointerEtag };
}

async function fingerprintOf(parts, subtle) {
  return sha256hex(new TextEncoder().encode(parts.join('')), subtle);
}

function buildEntry({ meta, image, imageKey, operationId, now, visible }) {
  return {
    date: meta.date, venue: meta.venue, raceNumber: meta.raceNumber, betType: meta.betType,
    stake: meta.stake, payout: meta.payout, isHit: meta.isHit, legacy: meta.legacy === true,
    visible: visible !== false, imageKey, checksum: image.checksum, contentType: image.contentType,
    byteSize: image.byteSize, width: image.width, height: image.height, operationId, uploadedAt: now,
  };
}

function upsertByDate(entries, entry) {
  const rest = (entries || []).filter((e) => e && e.date !== entry.date);
  return sortEntries([...rest, entry]);
}

function isManifestValid(manifest) {
  if (!manifest || typeof manifest.manifestId !== 'string' || manifest.manifestId.length === 0) return false;
  if (!Number.isInteger(manifest.logicalVersion) || manifest.logicalVersion < 1) return false;
  if (!Array.isArray(manifest.entries)) return false;
  return manifest.entries.every(
    (e) => e && typeof e.date === 'string' && e.date.length > 0 && typeof e.imageKey === 'string' && e.imageKey.length > 0,
  );
}

async function readOperation(store, operationId) {
  return (await store.getJSONWithEtag(mediaKeys.operation(operationId))).value;
}

/** previousManifestId チェーンを current から辿り、logicalVersion 一致の manifest を返す。 */
async function findByLogicalVersion(store, startManifestId, targetVersion) {
  let id = startManifestId;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const { value: m } = await store.getJSONWithEtag(mediaKeys.manifest(id));
    if (!m) return null;
    if (m.logicalVersion === targetVersion) return m;
    id = m.previousManifestId;
  }
  return null;
}

/**
 * create-only UUID manifest + CAS pointer 切替。auditRecord は best-effort。
 * manifestId は newId()（UUID）で生成する。operationId・ユーザー入力からは作らない。
 */
async function commit({ store, snap, newManifest, operationId, fingerprint, auditRecord, now, newId }) {
  const genId = typeof newId === 'function' ? newId : defaultNewId;
  const newLogicalVersion = snap.logicalVersion + 1;
  const manifestId = genId();
  // 防御: 生成器が壊れても keyspace（manifests/{id}）を破壊させない。UUID もテスト id も通る。
  if (typeof manifestId !== 'string' || manifestId.length === 0 || /[/\s]/.test(manifestId)) {
    return { ok: false, reason: TX_REJECT.MANIFEST_INVALID };
  }
  newManifest.manifestId = manifestId;
  newManifest.logicalVersion = newLogicalVersion;
  newManifest.previousManifestId = snap.manifestId || null;
  newManifest.operationId = operationId;
  newManifest.operationFingerprint = fingerprint;
  newManifest.updatedAt = now;
  if (!isManifestValid(newManifest)) return { ok: false, reason: TX_REJECT.MANIFEST_INVALID };

  // 1. create-only: UUID なので衝突しない（modified:false は UUID 衝突＝天文学的に稀）。
  //    既存 manifest は絶対に上書きしない（過去 manifest は immutable）。
  let vw;
  try { vw = await store.setJSONIfNew(mediaKeys.manifest(manifestId), newManifest); }
  catch { return { ok: false, reason: TX_REJECT.MANIFEST_PERSIST_FAILED }; } // current 不変
  if (!vw.modified) return { ok: false, reason: TX_REJECT.MANIFEST_ID_COLLISION };

  // 2. CAS: preread した etag と一致する 1 writer だけが pointer を進められる。
  //    throw / modified:false のどちらでも current は不変。書いた manifest は orphan として残るだけで、
  //    公開されず・後続更新も阻害しない（次 writer は別 UUID を生成する）。
  let pw;
  try {
    pw = snap.pointerEtag
      ? await store.setJSONIfMatch(mediaKeys.current(), { manifestId, logicalVersion: newLogicalVersion, updatedAt: now }, snap.pointerEtag)
      : await store.setJSONIfNew(mediaKeys.current(), { manifestId, logicalVersion: newLogicalVersion, updatedAt: now });
  } catch { return { ok: false, reason: TX_REJECT.POINTER_SWITCH_FAILED }; }
  if (!pw.modified) return { ok: false, conflict: true, reason: TX_REJECT.POINTER_CONFLICT };

  // best-effort（失敗しても公開は成立済み。再送は manifest.operationId で冪等回収される）
  try {
    await store.setJSON(mediaKeys.operation(operationId), { operationId, manifestId, logicalVersion: newLogicalVersion, fingerprint, status: 'done', at: now, ...auditRecord.op });
    await store.setJSON(mediaKeys.audit(operationId), { operationId, manifestId, logicalVersion: newLogicalVersion, at: now, ...auditRecord.audit });
  } catch { /* noop */ }
  return { ok: true, logicalVersion: newLogicalVersion, manifestId };
}

/** operationId が既に current を作っているか（reconcile）＋ 完了 op レコード fast-path。 */
async function idempotencyGuard({ store, operationId, fingerprint, snap }) {
  const { manifest } = snap;
  if (manifest.operationId === operationId) {
    return manifest.operationFingerprint === fingerprint
      ? { done: true, logicalVersion: snap.logicalVersion, manifestId: snap.manifestId }
      : { mismatch: true };
  }
  const opRec = await readOperation(store, operationId);
  if (opRec) {
    if (opRec.fingerprint !== fingerprint) return { mismatch: true };
    if (opRec.status === 'done') return { done: true, logicalVersion: opRec.logicalVersion, manifestId: opRec.manifestId };
  }
  return {};
}

export async function applyUpload({ store, image, meta, operationId, expectedVersion, now, visible = true, subtle, preread, newId }) {
  const snap = preread || await readCurrent(store);
  const { logicalVersion: currentVersion, manifest } = snap;
  const fingerprint = await fingerprintOf(
    ['upload', meta.date, image.checksum, String(meta.isHit), String(meta.payout), String(meta.stake), meta.venue || '', String(meta.raceNumber), String(visible !== false)],
    subtle,
  );

  const guard = await idempotencyGuard({ store, operationId, fingerprint, snap });
  if (guard.mismatch) return { ok: false, conflict: true, reason: TX_REJECT.OPERATION_MISMATCH };
  if (guard.done) {
    // 冪等再送は「その operation が作った manifest」から entry を取る（現在 manifest ではない）。
    // 現在 manifest はその後別 operation で更新され得るため、entry を現在から取ると
    // version/manifestId（過去 op 時点）と entry（現在時点）が別時点を指してしまう。方式 B。
    let entry = null;
    if (guard.manifestId) {
      const { value: m } = await store.getJSONWithEtag(mediaKeys.manifest(guard.manifestId));
      if (m && Array.isArray(m.entries)) entry = m.entries.find((e) => e.date === meta.date) || null;
    }
    return { ok: true, idempotent: true, version: guard.logicalVersion, manifestId: guard.manifestId, operationId, entry };
  }

  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { ok: false, conflict: true, currentVersion, reason: TX_REJECT.VERSION_CONFLICT };
  }

  const imageKey = mediaKeys.image(meta.date, image.checksum);
  try { await store.setBytesIfNew(imageKey, image.bytes, { contentType: image.contentType, checksum: image.checksum, byteSize: image.byteSize }); }
  catch { return { ok: false, reason: TX_REJECT.IMAGE_PERSIST_FAILED }; }
  const saved = await store.getBytes(imageKey);
  if (!saved || saved.bytes.length !== image.byteSize) return { ok: false, reason: TX_REJECT.IMAGE_PERSIST_FAILED };
  if (await sha256hex(saved.bytes, subtle) !== image.checksum) return { ok: false, reason: TX_REJECT.CHECKSUM_MISMATCH };

  const entry = buildEntry({ meta, image, imageKey, operationId, now, visible });
  const res = await commit({
    store, snap, operationId, fingerprint, now, newId,
    newManifest: { entries: upsertByDate(manifest.entries, entry) },
    auditRecord: { op: { action: 'upload', date: meta.date, checksum: image.checksum }, audit: { action: 'upload', date: meta.date } },
  });
  if (!res.ok) return res;
  return { ok: true, version: res.logicalVersion, manifestId: res.manifestId, operationId, entry };
}

export async function applyVisibility({ store, date, visible, operationId, expectedVersion, now, subtle, preread, newId }) {
  const snap = preread || await readCurrent(store);
  const { logicalVersion: currentVersion, manifest } = snap;
  const fingerprint = await fingerprintOf(['visibility', date, String(visible !== false)], subtle);

  const guard = await idempotencyGuard({ store, operationId, fingerprint, snap });
  if (guard.mismatch) return { ok: false, conflict: true, reason: TX_REJECT.OPERATION_MISMATCH };
  if (guard.done) return { ok: true, idempotent: true, version: guard.logicalVersion, manifestId: guard.manifestId, operationId };

  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { ok: false, conflict: true, currentVersion, reason: TX_REJECT.VERSION_CONFLICT };
  }
  const target = (manifest.entries || []).find((e) => e && e.date === date);
  if (!target) return { ok: false, reason: TX_REJECT.ENTRY_NOT_FOUND };

  const res = await commit({
    store, snap, operationId, fingerprint, now, newId,
    newManifest: { entries: sortEntries((manifest.entries || []).map((e) => (e.date === date ? { ...e, visible: visible !== false } : e))) },
    auditRecord: { op: { action: 'visibility', date, visible: visible !== false }, audit: { action: 'visibility', date } },
  });
  if (!res.ok) return res;
  return { ok: true, version: res.logicalVersion, manifestId: res.manifestId, operationId, date, visible: visible !== false };
}

export async function applyRollback({ store, targetVersion, operationId, expectedVersion, now, subtle, preread, newId }) {
  const snap = preread || await readCurrent(store);
  const { logicalVersion: currentVersion, manifestId } = snap;
  const fingerprint = await fingerprintOf(['rollback', String(targetVersion)], subtle);

  const guard = await idempotencyGuard({ store, operationId, fingerprint, snap });
  if (guard.mismatch) return { ok: false, conflict: true, reason: TX_REJECT.OPERATION_MISMATCH };
  if (guard.done) return { ok: true, idempotent: true, version: guard.logicalVersion, manifestId: guard.manifestId, operationId };

  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { ok: false, conflict: true, currentVersion, reason: TX_REJECT.VERSION_CONFLICT };
  }
  // 連番キーではなく previousManifestId チェーンを辿って対象 manifest を特定する（UUID 経路）。
  const target = await findByLogicalVersion(store, manifestId, targetVersion);
  if (!target || !Array.isArray(target.entries)) return { ok: false, reason: TX_REJECT.TARGET_NOT_FOUND };

  const res = await commit({
    store, snap, operationId, fingerprint, now, newId,
    newManifest: { entries: sortEntries(target.entries), rolledBackFromVersion: targetVersion, rolledBackFromManifestId: target.manifestId },
    auditRecord: { op: { action: 'rollback', rolledBackFrom: targetVersion }, audit: { action: 'rollback', rolledBackFrom: targetVersion } },
  });
  if (!res.ok) return res;
  return { ok: true, version: res.logicalVersion, manifestId: res.manifestId, rolledBackFrom: targetVersion, operationId };
}

/**
 * seed ステージ: 画像だけを immutable キーへ create-only 保存する（current は変えない）。
 * 複数リクエストに分割してよい（各リクエストが小さくなり body 上限を超えない）。
 * items[i] = { meta(validated,legacy), image(validateImage結果) }
 * @returns { ok, staged:[{date, checksum}] }
 */
export async function applySeedStage({ store, items, subtle }) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: TX_REJECT.EMPTY_ITEMS };
  const staged = [];
  for (const it of items) {
    const imageKey = mediaKeys.image(it.meta.date, it.image.checksum);
    try { await store.setBytesIfNew(imageKey, it.image.bytes, { contentType: it.image.contentType, checksum: it.image.checksum, byteSize: it.image.byteSize }); }
    catch { return { ok: false, reason: TX_REJECT.IMAGE_PERSIST_FAILED }; }
    const saved = await store.getBytes(imageKey);
    if (!saved || saved.bytes.length !== it.image.byteSize) return { ok: false, reason: TX_REJECT.IMAGE_PERSIST_FAILED };
    if (await sha256hex(saved.bytes, subtle) !== it.image.checksum) return { ok: false, reason: TX_REJECT.CHECKSUM_MISMATCH };
    staged.push({ date: it.meta.date, checksum: it.image.checksum });
  }
  return { ok: true, staged };
}

/**
 * seed コミット: ステージ済み画像を参照する manifest を 1 回だけ発行し、current を一度だけ切替。
 * items[i] = { meta(validated,legacy), checksum }
 */
export async function applySeedCommit({ store, items, operationId, expectedVersion, now, subtle, preread, newId }) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: TX_REJECT.EMPTY_ITEMS };
  const snap = preread || await readCurrent(store);
  const { logicalVersion: currentVersion, manifest } = snap;
  const fingerprint = await fingerprintOf(['seed', ...items.map((i) => `${i.meta.date}:${i.checksum}`).sort()], subtle);

  const guard = await idempotencyGuard({ store, operationId, fingerprint, snap });
  if (guard.mismatch) return { ok: false, conflict: true, reason: TX_REJECT.OPERATION_MISMATCH };
  if (guard.done) return { ok: true, idempotent: true, version: guard.logicalVersion, manifestId: guard.manifestId, operationId };

  if (expectedVersion != null && expectedVersion !== currentVersion) {
    return { ok: false, conflict: true, currentVersion, reason: TX_REJECT.VERSION_CONFLICT };
  }

  let entries = manifest.entries || [];
  for (const it of items) {
    const imageKey = mediaKeys.image(it.meta.date, it.checksum);
    const saved = await store.getBytes(imageKey);
    if (!saved) return { ok: false, reason: TX_REJECT.IMAGE_NOT_STAGED }; // ステージ未完了で公開しない
    const entry = buildEntry({
      meta: it.meta,
      image: { checksum: it.checksum, contentType: saved.metadata?.contentType || 'image/png', byteSize: saved.bytes.length, width: 0, height: 0 },
      imageKey, operationId, now, visible: true,
    });
    entries = upsertByDate(entries, entry);
  }

  const res = await commit({
    store, snap, operationId, fingerprint, now, newId,
    newManifest: { entries, seed: true },
    auditRecord: { op: { action: 'seed', count: items.length }, audit: { action: 'seed', count: items.length } },
  });
  if (!res.ok) return res;
  return { ok: true, version: res.logicalVersion, manifestId: res.manifestId, count: items.length, operationId };
}

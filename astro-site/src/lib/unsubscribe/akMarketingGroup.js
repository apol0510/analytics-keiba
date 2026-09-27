/**
 * akMarketingGroup.js — SendGrid unsubscribe group `AK Marketing` の**単一源**（依存なし）。
 *
 * AK と KI は同じ SendGrid アカウントを使うため、配信停止の group で分離する。
 * 「このイベントは AK の配信停止か」は**ここだけ**で判定する（直書きしない）。
 *
 * 2026-09-27 本番 read-only 実測: 34108 = `AK Marketing` / 28368 = `テストグループ` /
 * 29174 = `KEIBA Intelligence メルマガ`。
 * ⚠️ SendGrid へ書く前は id だけで信用せず、GET で名前も照合する（`akMarketingGroupBridge.js`）。
 */

export const AK_MARKETING_GROUP = Object.freeze({ id: 34108, name: 'AK Marketing' });

/** `asm_group_id` を整数へ。数値として読めなければ null（**推測しない**） */
export function parseAsmGroupId(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** AK Marketing の group か。**不明・欠落は false**（fail closed） */
export function isAkMarketingGroupId(raw) {
  return parseAsmGroupId(raw) === AK_MARKETING_GROUP.id;
}

export default AK_MARKETING_GROUP;

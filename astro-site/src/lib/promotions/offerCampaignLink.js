/**
 * offerCampaignLink.js — 割引オファーと案内メールを安全に結び付ける（純粋・Airtable 非依存）
 *
 * カムバックの割引案内は「その顧客だけが使える URL」を本文の CTA に入れる必要がある。
 * ここが崩れると **他人のオファーで買える / 誰も買えない URL を配る**という事故になるため、
 * 結合条件をこのモジュール 1 か所に閉じ込める。
 *
 * ── 設計の芯: 送信できるのは「既に issued のオファーを持つ人」だけ ──────
 * URL は台帳から**決定的に再生成**する（`signOfferToken` は offerKey と email と鍵だけの
 * HMAC で、乱数も時刻も含まない）。したがって:
 *
 *   1. オファーが無い / 期限切れ / 申込済み → **メールを送らない**（除外理由を返す）
 *   2. 生トークンをどこにも保存・中継しない（発行応答にしか出さない原則を維持）
 *   3. 「オファー発行 → URL 確定 → 送信」という順序が**構造的に**保証される
 *      （発行が失敗していれば issued の行が無く、対象にならない）
 *
 * ── このモジュールは何も書かない ────────────────────────────────
 * 台帳の状態遷移（redeemed / revoked）には一切関与しない。
 * メール送信が失敗してもオファーは無傷のまま残る。
 */

import { OFFER_STATUS, signOfferToken } from './promotionalOffer.js';

/** 台帳・顧客の Email 比較は必ずこの正規化を通す（`promotionalOffer.js` と同じ規則） */
const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();

const SITE = 'https://analytics.keiba.link';
const OFFER_PATH = '/offer/';

/** キャンペーン本文へ差し込む、送信直前まで解決を遅らせるプレースホルダ */
export const OFFER_URL_PLACEHOLDER = '{{offerUrl}}';

/** オファーが結び付けられない理由（すべて「送らない」に倒す） */
export const OFFER_LINK_SKIP = Object.freeze({
  /** 有効な（issued・期限内）オファーが 1 件も無い */
  MISSING: 'offer_missing',
  /** 有効なオファーが複数あり、どれを案内すべきか決められない */
  AMBIGUOUS: 'offer_ambiguous',
  /** 本文に書いた条件（オファー種別・価格）と、その人のオファーが違う */
  MISMATCH: 'offer_mismatch',
  /** 署名鍵が無く URL を生成できない（PROMO_OFFER_SECRET 未設定） */
  NO_SECRET: 'offer_secret_unavailable',
});

export const OFFER_LINK_SKIP_LABEL = Object.freeze({
  offer_missing: '有効な割引オファーが発行されていない',
  offer_ambiguous: '有効な割引オファーが複数あり特定できない',
  offer_mismatch: '発行済みオファーの内容が案内文面と一致しない',
  offer_secret_unavailable: 'オファー URL の署名鍵が未設定',
});

const str = (v) => String(v ?? '').trim();

/**
 * 台帳の 1 行が「いま案内してよいオファー」か。
 * `expired` は Status 列に書き戻されないため、**時刻でも判定する**。
 */
export function isLiveOffer({ record, nowMs }) {
  const f = (record && record.fields) || null;
  if (!f) return false;
  if (str(f.Status).toLowerCase() !== OFFER_STATUS.ISSUED) return false;
  const exp = Date.parse(str(f.ExpiresAt));
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  const price = Number(f.OfferPrice);
  return Number.isInteger(price) && price > 0;
}

/**
 * 受信者 1 人に対応する有効なオファーを 1 件だけ選ぶ。
 *
 * **複数あったら選ばない**（fail closed）。「新しい方を採る」等の推測をすると、
 * 本文に書いた価格と違うオファーを案内しうる。
 *
 * @param {{ records: object[], customerRecordId: string, email: string, nowMs: number }} input
 * @returns {{ ok: true, record: object }|{ ok: false, reason: string }}
 */
export function resolveRecipientOffer({ records, customerRecordId, email, nowMs }) {
  const rid = str(customerRecordId);
  const mail = normalizeEmail(email);
  const hits = [];
  for (const rec of records || []) {
    if (!isLiveOffer({ record: rec, nowMs })) continue;
    const f = rec.fields || {};
    // recordId と email の**両方**が一致するものだけ（レコード差し替え時の取り違え防止）
    if (rid && str(f.CustomerRecordId) !== rid) continue;
    if (mail && normalizeEmail(f.Email) !== mail) continue;
    if (!rid && !mail) continue;
    hits.push(rec);
  }
  if (hits.length === 0) return { ok: false, reason: OFFER_LINK_SKIP.MISSING };
  if (hits.length > 1) return { ok: false, reason: OFFER_LINK_SKIP.AMBIGUOUS };
  return { ok: true, record: hits[0] };
}

/**
 * 本文に書いた条件と、その人のオファーが一致するか。
 *
 * 一斉送信の本文は 1 種類なので、**価格や種別が違う人に同じ文面を送ると嘘になる**。
 * キャンペーン定義の `offerId` / `offerPrice` / `regularPrice` と突き合わせる。
 */
export function matchesCampaignOffer({ record, campaign }) {
  const f = (record && record.fields) || {};
  const want = campaign || {};
  if (want.offerId && str(f.OfferId) !== str(want.offerId)) return false;
  if (Number.isFinite(Number(want.offerPrice)) && Number(f.OfferPrice) !== Number(want.offerPrice)) return false;
  if (Number.isFinite(Number(want.regularPrice)) && Number(f.RegularPrice) !== Number(want.regularPrice)) return false;
  return true;
}

/**
 * 台帳の 1 行から申込 URL を**再生成**する。
 *
 * 生トークンは保存されていないが、`signOfferToken` は決定的なので鍵があれば再現できる。
 * これにより、トークンを ScheduledEmails や CampaignDeliveries に置かずに済む。
 */
export function buildOfferUrl({ record, secret }) {
  const f = (record && record.fields) || {};
  const token = signOfferToken({
    offerKey: str(f.OfferKey),
    email: str(f.Email),
    secret,
  });
  return token ? `${SITE}${OFFER_PATH}?t=${token}` : null;
}

/**
 * 受信者 1 人ぶんの結合を確定する（一覧の判定・送信直前の判定の**共通の入口**）。
 *
 * dry-run と実送信で同じ関数を使うので、「dry-run では対象なのに送信時に落ちる」が起きない。
 *
 * @returns {{ ok: true, url: string, offer: object }|{ ok: false, reason: string }}
 */
export function linkOfferForRecipient({ records, customerRecordId, email, campaign, secret, nowMs }) {
  const found = resolveRecipientOffer({ records, customerRecordId, email, nowMs });
  if (!found.ok) return found;
  if (!matchesCampaignOffer({ record: found.record, campaign })) {
    return { ok: false, reason: OFFER_LINK_SKIP.MISMATCH };
  }
  const url = buildOfferUrl({ record: found.record, secret });
  if (!url) return { ok: false, reason: OFFER_LINK_SKIP.NO_SECRET };
  return { ok: true, url, offer: found.record };
}

/** キャンペーンが受信者ごとの URL を必要とするか（必要なら URL 無しでは送らない） */
export function requiresOfferUrl(campaign) {
  return !!(campaign && campaign.requiresOfferUrl === true);
}

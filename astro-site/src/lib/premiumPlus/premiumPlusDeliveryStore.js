/**
 * premiumPlusDeliveryStore.js — 提供レース台帳とサンクスメール送信記録の I/O（Redis・依存は注入）
 *
 * | キー | 型 | 中身 |
 * |---|---|---|
 * | `ak:pp:delivery:v1` | HASH | 対象日 → 提供レース JSON（**HSETNX で 1 回だけ**。上書きしない）|
 * | `ak:pp:thanks:v1:{orderId}` | STRING | サンクスメール送信記録（`sending:<ms>` → `sent:<ms>`）|
 *
 * ⚠️ 買い目はここ（Redis）にしか置かない。git（公開 repo）・ビルド成果物・ログには出さない。
 */

export const PP_DELIVERY_KEY = 'ak:pp:delivery:v1';
export const PP_THANKS_PREFIX = 'ak:pp:thanks:v1:';

function parse(v) {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(typeof v === 'string' ? v : String(v)); } catch { return null; }
}

export function createDeliveryStore({ redisCmd }) {
  if (typeof redisCmd !== 'function') throw new Error('premiumPlusDeliveryStore: redisCmd が必要です');
  const cmd = (args) => redisCmd(args.map(String));
  return {
    async get(saleDate) { return parse(await cmd(['HGET', PP_DELIVERY_KEY, saleDate])); },
    async getMany(saleDates) {
      const out = {};
      for (const d of saleDates) out[d] = parse(await cmd(['HGET', PP_DELIVERY_KEY, d]));
      return out;
    },
    /** 既にあれば書かない（公開後に買い目が変わらない） */
    async createIfAbsent(delivery) {
      return Number(await cmd(['HSETNX', PP_DELIVERY_KEY, delivery.saleDate, JSON.stringify(delivery)])) === 1;
    },
    async thanksState(orderId) { return (await cmd(['GET', `${PP_THANKS_PREFIX}${orderId}`])) || null; },
    /** 送信の予約（同時実行・再実行で 2 通にならない） */
    async reserveThanks(orderId, nowMs) {
      const r = await cmd(['SET', `${PP_THANKS_PREFIX}${orderId}`, `sending:${nowMs}`, 'NX']);
      return r === 'OK' || r === true;
    },
    async markThanksSent(orderId, nowMs) { await cmd(['SET', `${PP_THANKS_PREFIX}${orderId}`, `sent:${nowMs}`]); },
    /** 送れなかったと**確定**したときだけ解除（次の実行で再送できる）。通信不明では解除しない */
    async releaseThanks(orderId) { await cmd(['DEL', `${PP_THANKS_PREFIX}${orderId}`]); },
  };
}

/** 予想 JSON の取得元（公開 repo の main。予想データ自体は既に公開されている） */
export const PREDICTION_RAW_BASE = 'https://raw.githubusercontent.com/apol0510/analytics-keiba/main/astro-site/src/data/predictions';
const NANKAN_VENUES = ['ooi', 'kawasaki', 'funabashi', 'urawa'];

export function predictionUrls(saleDate) {
  const [y, m] = saleDate.split('-');
  return {
    jra: [`${PREDICTION_RAW_BASE}/jra/${y}/${m}/${saleDate}.json`],
    nankan: NANKAN_VENUES.map((v) => `${PREDICTION_RAW_BASE}/${saleDate}-${v}.json`),
  };
}

/** 対象日の予想 JSON を集める。404 は「開催なし」、それ以外の失敗は例外（fail closed で生成しない） */
export async function fetchPredictionFiles(saleDate, { fetchImpl = fetch } = {}) {
  const urls = predictionUrls(saleDate);
  const out = { jra: [], nankan: [] };
  for (const circuit of ['jra', 'nankan']) {
    for (const url of urls[circuit]) {
      const res = await fetchImpl(url, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`prediction_fetch_${res.status}`);
      out[circuit].push(await res.json());
    }
  }
  return out;
}

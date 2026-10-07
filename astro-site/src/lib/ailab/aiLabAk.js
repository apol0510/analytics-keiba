/**
 * aiLabAk.js — AI ラボに AK の予想（馬名・印の上位 5 頭）を添える（サーバー専用）。正本 docs/AI_LAB.md
 *
 * 2026-10-07 MK 確定（追記）: 各馬の期待値の横に AK の印の上位 5 頭（◎本命 ○対抗 ▲単穴 △連下最上位 △連下）を出す。
 * 上位 5 頭の選び方は既存の単一源（本命 ＋ getTop5Challengers＝対抗→単穴→連下最上位→連下・同役割は pt 降順）。
 * 印の記号は公開ページ（freePublicView）と同じ。
 * ⚠️ 取込時（KAP からの受信ごと）に AK の予想データ（loadDay の venues）から作る。AK の予想が無いレースは印なし。
 */
import { getTop5Challengers } from '../../utils/mainRaceBetting.js';

export const AK_MARK = Object.freeze({ '本命': '◎', '対抗': '○', '単穴': '▲', '連下最上位': '△', '連下': '△' });

/** AK の予想の馬一覧 → 馬番 → 印（上位 5 頭だけ） */
export function akTop5Marks(horses) {
  const list = Array.isArray(horses) ? horses : [];
  const num = (h) => Number(h?.horseNumber ?? h?.number);
  const honmei = list.find((h) => h?.role === '本命');
  const top = [honmei, ...getTop5Challengers(list.filter((h) => h !== honmei)).slice(0, honmei ? 4 : 5)].filter(Boolean);
  const out = new Map();
  for (const h of top) {
    const n = num(h);
    const mark = AK_MARK[h.role];
    if (Number.isInteger(n) && mark && !out.has(n)) out.set(n, mark);
  }
  return out;
}

/** 馬名と AK の印を添える（突き合わせは 場名 + R + 馬番）。無ければ添えない */
export function attachAk(day, akVenues) {
  const byRace = new Map();
  for (const v of akVenues || []) {
    for (const r of v.races || []) {
      const names = new Map();
      for (const h of r.horses || []) {
        const n = Number(h?.horseNumber ?? h?.number);
        const name = String(h?.horseName || h?.name || '').trim();
        if (Number.isInteger(n) && name) names.set(n, name.slice(0, 40));
      }
      byRace.set(`${v.venueName}|${Number(r.raceInfo?.raceNumber)}`, { names, marks: akTop5Marks(r.horses) });
    }
  }
  return {
    ...day,
    races: day.races.map((r) => {
      const ak = byRace.get(`${r.venueName}|${r.raceNumber}`);
      if (!ak) return r;
      return {
        ...r,
        field: r.field.map((h) => {
          const name = ak.names.get(h.n);
          const mark = ak.marks.get(h.n);
          return { ...h, ...(name ? { name } : {}), ...(mark ? { mark } : {}) };
        }),
      };
    }),
  };
}

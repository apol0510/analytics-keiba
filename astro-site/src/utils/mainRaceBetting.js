// メインレース専用 馬単買い目ロジック（最大10点・本命軸双方向）
//
// 仕様:
//   - メインレース判定は getMainRaceNumber() で統一
//     12R開催 → R11、10R開催 → R9、8R開催 → R7、それ以外は最終レース
//   - 本命を軸に、相手は本命を除く役割優先で上位5頭まで
//     (役割優先: 対抗 → 単穴 → 連下最上位 → 連下、同役割内は pt 降順)
//   - 5頭未満なら拾えた分だけ生成
//   - 表示・的中判定・archive保存は同じ1行コンパクト形式
//     (例: "3-5.7.8.10.12") を共有する。
//   - 既存の checkUmatanHit が双方向判定するため、
//     この1行で 本命→相手 / 相手→本命 の合計10点が成立する。

const ROLE_PRIORITY = { '対抗': 1, '単穴': 2, '連下最上位': 3, '連下': 4 };

export function getMainRaceNumber(totalRaces) {
  if (totalRaces === 8) return 7;
  if (totalRaces === 10) return 9;
  if (totalRaces === 12) return 11;
  return totalRaces;
}

export function isMainRace(raceNumber, totalRaces) {
  const num = Number(raceNumber);
  const total = Number(totalRaces);
  if (!Number.isFinite(num) || !Number.isFinite(total) || total <= 0) return false;
  return num === getMainRaceNumber(total);
}

function horseNumber(h) {
  return h?.number ?? h?.horseNumber ?? null;
}

function horsePt(h) {
  const v = Number(h?.pt ?? h?.displayScore ?? h?.rawScore);
  return Number.isFinite(v) ? v : 0;
}

export function getTop5Challengers(horses) {
  if (!Array.isArray(horses)) return [];
  return horses
    .filter(h => h && ROLE_PRIORITY[h.role] != null)
    .sort((a, b) => {
      const ra = ROLE_PRIORITY[a.role];
      const rb = ROLE_PRIORITY[b.role];
      if (ra !== rb) return ra - rb;
      return horsePt(b) - horsePt(a);
    })
    .slice(0, 5);
}

export function generateMainRaceUmatanLines(horses) {
  if (!Array.isArray(horses)) return [];
  const honmei = horses.find(h => h && h.role === '本命');
  const honmeiNum = horseNumber(honmei);
  if (honmeiNum == null) return [];
  const partners = getTop5Challengers(horses)
    .map(horseNumber)
    .filter(n => n != null && n !== honmeiNum);
  if (partners.length === 0) return [];
  return [`${honmeiNum}-${partners.join('.')}`];
}

export function countMainRaceBetPoints(horses) {
  const lines = generateMainRaceUmatanLines(horses);
  if (lines.length === 0) return 0;
  const partners = getTop5Challengers(horses);
  const honmei = horses.find(h => h && h.role === '本命');
  const honmeiNum = horseNumber(honmei);
  const filtered = partners.filter(p => horseNumber(p) !== honmeiNum);
  return filtered.length * 2;
}

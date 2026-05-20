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
//
// 通常レース（メイン以外）は generateNormalRaceUmatanLines() で
// 本命軸 + 対抗軸の2行を生成する（importPrediction 系で従来使用していたロジックを集約）。
// プレミアム表示・インポート両方が同じロジックを参照するための単一源として運用する。

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
  // 選出は getTop5Challengers（役割優先＋pt 降順）。
  // 表示順は通常レースと揃えて馬番昇順に並び替える（選出対象は変更しない）。
  const partners = getTop5Challengers(horses)
    .map(horseNumber)
    .filter(n => n != null && n !== honmeiNum)
    .sort((a, b) => Number(a) - Number(b));
  if (partners.length === 0) return [];
  return [`${honmeiNum}↔${partners.join('.')}`];
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

// 通常レース（メイン以外）の馬単買い目を生成する。本命軸 + 対抗軸の 2 段構成:
//   1段目（本命軸）: 本命 ↔ {対抗, 単穴, 連下最上位, 連下} 役割優先で上位5頭
//   2段目（対抗軸）: 対抗 ↔ {本命, 単穴, 連下最上位, 連下} 役割優先で上位5頭
//     ※ 2段目は本命を相手に入れる（対抗は軸なので相手から除外）
//   抑え（補欠・抑え役割の馬）は各行末尾に "(抑え...)" として共通付与（informational）。
// 例（本命9 / 対抗12 / 単穴1,2 / 連下3,6 / 抑え5,8,11）:
//   "9↔1.2.3.6.12(抑え5.8.11)"
//   "12↔1.2.3.6.9(抑え5.8.11)"
// 相手の選出順: 役割優先 → 同役割内は pt 降順で上位5頭。表示順は **馬番昇順**。
// 対抗が存在しない場合は本命軸の 1 行のみ。メインレースは別関数（1段）で現状維持。
export function generateNormalRaceUmatanLines(horses) {
  if (!Array.isArray(horses)) return [];
  const honmei = horses.find(h => h && h.role === '本命');
  if (!honmei) return [];
  const honmeiNum = horseNumber(honmei);
  if (honmeiNum == null) return [];
  const taikou = horses.find(h => h && h.role === '対抗');
  const taikouNum = horseNumber(taikou);

  // 軸を除く、役割優先 + pt 降順で相手上位5頭を「選出」→ 表示用に馬番昇順へ並び替える。
  const selectPartners = (axisNum, priority) => horses
    .filter(h => h && priority[h.role] != null)
    .filter(h => {
      const n = horseNumber(h);
      return n != null && n !== axisNum;
    })
    .sort((a, b) => {
      const ra = priority[a.role];
      const rb = priority[b.role];
      if (ra !== rb) return ra - rb;
      return horsePt(b) - horsePt(a);
    })
    .slice(0, 5)
    .map(horseNumber)
    .sort((a, b) => Number(a) - Number(b));

  // 1段目（本命軸）相手プール: 対抗 → 単穴 → 連下最上位 → 連下
  const honmeiPartners = selectPartners(honmeiNum, { '対抗': 1, '単穴': 2, '連下最上位': 3, '連下': 4 });
  // 2段目（対抗軸）相手プール: 本命 → 単穴 → 連下最上位 → 連下（本命を相手に入れる）
  const taikouPartners = taikouNum != null
    ? selectPartners(taikouNum, { '本命': 1, '単穴': 2, '連下最上位': 3, '連下': 4 })
    : [];

  if (honmeiPartners.length === 0) return [];

  // 抑え候補の抽出条件 (2026-05-16 更新):
  //   - role が '抑え' の馬（データに該当 role が来た場合の正規ルート）
  //     または role が '補欠' で racebook 系コンピ指数 ≥ MIN_OSAE_CI (= 45) の馬
  //   - racebook 系コンピ指数 = sourceComputerIndex (JRA) || computerIndex (南関)、10 未満は無効
  //   - 旧仕様 (pt > 70) は JRA の totalScore 由来 pt (71〜114) を誤って抑えに入れていたため
  //     COMPI_MIN ベースに変更。shared-prediction-logic.js の isOsaeCandidate と同期。
  //   - 本命・対抗・選出済み相手（両軸分）も除外
  //   - 並び順は **馬番昇順**（評価順ではなく視認性優先）
  // 結果が 0 件なら "(抑え...)" 自体を付与しない（無理に補欠で埋めない）。
  const MIN_OSAE_CI = 45;
  const getOsaeCi = (h) => {
    const sci = Number(h?.sourceComputerIndex || 0);
    const ci = Number(h?.computerIndex || 0);
    if (sci >= 10) return sci;
    if (ci >= 10) return ci;
    return 0;
  };
  const isOsae = (h) => {
    if (!h) return false;
    if (h.role === '抑え') return true;
    if (h.role !== '補欠') return false;
    return getOsaeCi(h) >= MIN_OSAE_CI;
  };
  // 両軸・両相手リストに含まれる馬は抑えから除外（相手と重複させない）
  const usedSet = new Set([honmeiNum, taikouNum, ...honmeiPartners, ...taikouPartners]);
  const osaeNumbers = horses
    .filter(isOsae)
    .filter(h => {
      const n = horseNumber(h);
      return n != null && !usedSet.has(n);
    })
    .map(horseNumber)
    .sort((a, b) => Number(a) - Number(b));
  const osaeSuffix = osaeNumbers.length > 0 ? `(抑え${osaeNumbers.join('.')})` : '';

  // 1段目（本命軸）は常に出力。2段目（対抗軸）は対抗が居て相手が拾えた時のみ。
  const lines = [`${honmeiNum}↔${honmeiPartners.join('.')}${osaeSuffix}`];
  if (taikouNum != null && taikouPartners.length > 0) {
    lines.push(`${taikouNum}↔${taikouPartners.join('.')}${osaeSuffix}`);
  }
  return lines;
}

// 1レース分の馬単買い目を生成する dispatcher。
// メインレースは10点ロジック、通常レースは本命軸＋対抗軸ロジックを呼び分ける。
export function generateRaceUmatanLines(horses, isMainRaceFlag) {
  return isMainRaceFlag
    ? generateMainRaceUmatanLines(horses)
    : generateNormalRaceUmatanLines(horses);
}

// 1本の馬単買い目文字列から実点数を算出する。
//   - 双方向形式   例 "3↔5.7.8.10.12" / "4↔1.11.2(抑え10.8)"
//                  → partners × 2（軸 ↔ 相手の双方向馬単）
//   - 旧ダッシュ形式 例 "3-5.7.8.10.12" / "4-1.11.2(抑え10.8.6)"
//                  後方互換: メイン(抑え無し)は ×2、通常(抑え有り)は片方向。
//                  新規生成はすべて ↔ を出力するため、↔ ブランチが正規。
//   - 既存ヒューリスティック ⇔ / → / "N点" にも後方互換で対応
export function countPointsFromUmatanLine(line) {
  if (typeof line !== 'string' || line.length === 0) return 0;
  const explicit = line.match(/(\d+)点/);
  if (explicit) return parseInt(explicit[1], 10) || 0;
  // ↔ 形式（新規・正規）: 双方向馬単 partners × 2
  if (line.includes('↔')) {
    const beforeParen = line.split('(')[0];
    const idx = beforeParen.indexOf('↔');
    const partnersPart = beforeParen.slice(idx + 1);
    const partners = partnersPart.split('.').filter(Boolean).length;
    return partners * 2;
  }
  if (line.includes('⇔')) {
    const right = line.split('⇔')[1] || '';
    return (right.split(',').filter(Boolean).length || 0) * 2;
  }
  if (line.includes('→')) {
    // 通常レース 10点ロジックの片方向「軸→A.B.C.D.E」（. 区切り）
    // 後方互換: 旧表記「軸→A,B,C」（, 区切り）も処理
    const beforeParen = line.split('(')[0];
    const idx = beforeParen.indexOf('→');
    const partnersPart = beforeParen.slice(idx + 1);
    if (partnersPart.includes('.')) {
      return partnersPart.split('.').filter(Boolean).length || 0;
    }
    return partnersPart.split(',').filter(Boolean).length || 0;
  }
  // 旧ダッシュ形式の後方互換
  const beforeParen = line.split('(')[0];
  const dashIdx = beforeParen.indexOf('-');
  if (dashIdx < 0) return 0;
  const partnersPart = beforeParen.slice(dashIdx + 1);
  const partners = partnersPart.split('.').filter(Boolean).length;
  if (partners === 0) return 0;
  const hasOsae = line.includes('(抑え');
  return hasOsae ? partners : partners * 2;
}

// 馬単買い目（文字列配列）を、プレミアム表示で期待される
// {safe, balance, aggressive} 3戦略カードの形に変換する。
// 10点ロジックでは買い目は1セットに統一されるため、3枚のカードは
// 同じ bets を共有し、信頼度・期待回収率のラベルだけ変える。
// （CLAUDE.md「メインレース10点ロジック」方針に準拠）
export function buildStrategiesFromUmatanLines(umatanLines) {
  if (!Array.isArray(umatanLines) || umatanLines.length === 0) return null;
  const bets = umatanLines.map((line) => ({
    type: '馬単',
    numbers: line,
    points: countPointsFromUmatanLine(line),
  }));
  return {
    safe: {
      title: '🎯 少点数的中型モデル',
      bets,
      hitRate: 65,
      confidence: 80,
      returnRate: 130,
      riskLevel: '低リスク',
      recommendation: 2,
    },
    balance: {
      title: '⚖️ バランス型モデル',
      bets,
      hitRate: 50,
      confidence: 70,
      returnRate: 160,
      riskLevel: '中リスク',
      recommendation: 3,
    },
    aggressive: {
      title: '🚀 高配当追求型モデル',
      bets,
      hitRate: 35,
      confidence: 55,
      returnRate: 200,
      riskLevel: '高リスク',
      recommendation: 2,
    },
  };
}

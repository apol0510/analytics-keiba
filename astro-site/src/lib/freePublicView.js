/**
 * freePublicView.js — 無料ページ（無登録 / 無料登録）へ渡してよい「公開DTO」の単一源。
 *
 * 目的（有料買い目の無料再現を防ぐ）:
 *   無料の HTML/JSON へは「公開事実（馬番・馬名・騎手・厩舎・斤量・過去走）」と
 *   「上位4頭の印（◎本命 / ○対抗 / ▲単穴 / △連下最上位）」を出す。買い目再現の入力になる
 *     - pt（累積スコア）
 *     - AI総合指数（computerIndex / sourceComputerIndex 由来）
 *     - 特徴量重要度
 *     - ▲単穴 / △連下 / 抑え / 不要馬 などの役割・印
 *   は **DTO に一切含めない**（＝無料の静的HTMLに実値が焼き込まれない）。有料のみ解放。
 *
 * 表示は役割別セクションをやめ「全馬・馬番順のフラット」。抑え・不要馬も同列に扱う。
 * pt/CI/特徴量/役割の位置は呼び出し側でダミーのモザイク（うっすら見えそう）を描画する。
 */

// 上位4頭だけ実印を出す（◎本命 / ○対抗 / ▲単穴 / △連下最上位）。
// 連下(残り) / 押さえ / 不要馬 の役割、および pt/CI/特徴量 は伏せる（有料限定）。
const HEADLINE = {
  '本命': { mark: '◎', kind: 'main', markClass: 'horse-mark horse-mark-main' },
  '対抗': { mark: '○', kind: 'sub', markClass: 'horse-mark horse-mark-sub' },
  '単穴': { mark: '▲', kind: 'tana', markClass: 'horse-mark horse-mark-tana' },
  '連下最上位': { mark: '△', kind: 'ren', markClass: 'horse-mark horse-mark-minor' },
};

const num = (h) => Number(h?.number ?? h?.horseNumber);

/**
 * レースの全馬から、無料公開してよい行だけを馬番順で返す。
 * @param {object[]} horses 正規化済み horse 配列（role/pt/CI などを含む生データ）
 * @param {object} [opts]
 * @param {(h:object)=>any[]} [opts.resolveRecent] 過去走（公開事実）を解決する関数
 * @returns {Array<object>} 公開DTO行（pt/CI/特徴量/役割は含まない）
 */
export function buildFreePublicRows(horses, opts = {}) {
  const resolveRecent = typeof opts.resolveRecent === 'function' ? opts.resolveRecent : () => [];
  // 並び順: 本命→対抗→単穴→連下最上位 を先頭（役割順）、以降は馬番順。
  const ORDER = { '本命': 0, '対抗': 1, '単穴': 2, '連下最上位': 3 };
  const rank = (h) => (ORDER[h?.role] ?? 99);
  return (Array.isArray(horses) ? horses : [])
    .filter((h) => h && Number.isFinite(num(h)))
    .slice()
    .sort((a, b) => (rank(a) - rank(b)) || (num(a) - num(b)))
    .map((h) => {
      const head = HEADLINE[h.role] || null;
      return {
        number: num(h),
        name: h.name ?? h.horseName ?? '',
        jockey: h.jockey ?? null,
        trainer: h.trainer ?? null,
        weight: (h.weight != null && h.weight !== '' && Number.isFinite(Number(h.weight))) ? `${h.weight}kg` : null,
        frame: h.frame ?? null,
        sire: h.sire ?? null,
        ageGender: (h.ageNum != null && h.gender) ? `${h.ageNum}歳${h.gender}` : (h.age || null),
        recent: resolveRecent(h) || [],
        isHeadline: !!head,
        headlineMark: head ? head.mark : null,
        headlineKind: head ? head.kind : null,
        markClass: head ? head.markClass : null,
        // 公開DTOには pt / aiIndex / role / importance / evalPoints を **入れない**（有料限定）。
        // _horse は「過去走由来の集計のみを出す検証済みコンポーネント」専用の生データ参照。
        // pt/CI/役割/特徴量を描画してはならない（描画は過去走・通算成績など公開事実に限る）。
        _horse: h,
      };
    });
}

export default { buildFreePublicRows };

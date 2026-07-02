/**
 * freePublicView.js — 無料ページ（無登録 / 無料登録）へ渡してよい「公開DTO」の単一源。
 *
 * 目的（有料買い目の無料再現を防ぐ）:
 *   無料の HTML/JSON へは「公開事実（馬番・馬名・騎手・厩舎・斤量・過去走）」と
 *   「本命◎ / 対抗○ の印」だけを出す。買い目再現の入力になる
 *     - pt（累積スコア）
 *     - AI総合指数（computerIndex / sourceComputerIndex 由来）
 *     - 特徴量重要度
 *     - ▲単穴 / △連下 / 抑え / 不要馬 などの役割・印
 *   は **DTO に一切含めない**（＝無料の静的HTMLに実値が焼き込まれない）。有料のみ解放。
 *
 * 表示は役割別セクションをやめ「全馬・馬番順のフラット」。抑え・不要馬も同列に扱う。
 * pt/CI/特徴量/役割の位置は呼び出し側でダミーのモザイク（うっすら見えそう）を描画する。
 */

// 本命/対抗だけが「見せ場」= 実印を出す。単穴以下は役割自体を伏せる。
const HEADLINE = {
  '本命': { mark: '◎', kind: 'main', markClass: 'horse-mark horse-mark-main' },
  '対抗': { mark: '○', kind: 'sub', markClass: 'horse-mark horse-mark-sub' },
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
  return (Array.isArray(horses) ? horses : [])
    .filter((h) => h && Number.isFinite(num(h)))
    .slice()
    .sort((a, b) => num(a) - num(b))
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
      };
    });
}

export default { buildFreePublicRows };

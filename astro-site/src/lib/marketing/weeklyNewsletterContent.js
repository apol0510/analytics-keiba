/**
 * weeklyNewsletterContent.js — 週 2 回の一斉配信の**文面を組む**（I/O なし・データは注入）
 *
 * ## なぜ自動で組めるのか
 *
 * 毎週の「何を書くか」は既に production にある。**前日の実績**（`archiveResults`）を
 * そのまま素材にすれば、人が毎回書き下ろさなくても**中身のある**案内になる。
 * 数値は**渡されたものだけ**を使い、ここで作らない（作れば嘘になる）。
 *
 * ## 守ること
 *
 * - **数字を作らない。** 渡された実績が足りなければ**組まない**（`ok:false`）
 * - CTA は**公開ページだけ**（会員限定ページへ誘導しない）
 * - 品質基準（`emailCopyStandard`）を通らない文面は**送らない**（呼び出し側が検査）
 * - 送信停止リンクは SendGrid の `<%asm_group_unsubscribe_raw_url%>` に任せる
 */

export const WEEKLY_CTA = Object.freeze({
  url: 'https://analytics.keiba.link/results-showcase/nankan/',
  label: '昨日の買い目と結果を見る',
  note: '有料版で実際に配信したメインレースの買い目と、的中の払戻を公開しています。',
});

export const CONTENT_FAIL = Object.freeze({
  NO_RESULTS: 'no_results',
  NO_MAIN_RACE: 'no_main_race',
});

/**
 * @param {{ dateKey?: string|null, showcase: object|null }} input
 *   `showcase` は `buildLatestShowcase()` の戻り値をそのまま渡す。
 *   ⚠️ **形を推測しない。** `venues` は**会場名の配列**で、明細は `venueGroups` に入る
 *   （2026-09-19 に取り違えて `no_main_race` で止まった）。
 * @returns {{ok:boolean, reason?:string, step?:object}}
 */
export function buildWeeklyContent({ dateKey, showcase } = {}) {
  const groups = (showcase && Array.isArray(showcase.venueGroups)) ? showcase.venueGroups : [];
  if (groups.length === 0) return { ok: false, reason: CONTENT_FAIL.NO_RESULTS };

  const mains = groups.map((g) => g && g.mainRace).filter(Boolean);
  if (mains.length === 0) return { ok: false, reason: CONTENT_FAIL.NO_MAIN_RACE };

  const total = Number(showcase.totalRaces) || groups.reduce((a, g) => a + (Number(g.totalRaces) || 0), 0);
  const hits = Number(showcase.hitRaces) || 0;
  if (total <= 0) return { ok: false, reason: CONTENT_FAIL.NO_RESULTS };
  const mainHits = mains.filter((m) => m && m.isHit === true);
  const venueLabel = String(showcase.venueLabel || groups.map((g) => g.venue).filter(Boolean).join('・'));
  const day = String(showcase.date || dateKey || '');
  if (!day || !venueLabel) return { ok: false, reason: CONTENT_FAIL.NO_RESULTS };

  // 2026-11-25 MK 決定（共通 A-2）: 的中を主役にする。分母（◯レース中・◯鞍中）・的中率・0 件は書かない。
  //   全件の結果は着地先の実績ページ（/results-showcase/）にある。数字は渡された実績だけを使う。
  const mainPayout = mainHits.map((m) => Number(m.payout)).find((v) => Number.isFinite(v) && v > 0) || null;
  const headline = hits > 0 ? `${day} の有料版：${hits} レース的中` : `${day} の有料版の買い目`;
  const body = [
    'いつも KEIBA Analytics の無料予想をご覧いただきありがとうございます。',
    '前回ご覧いただいた無料予想の続きとして、有料版で実際に配信した買い目の結果をお届けします。',
    '',
    hits > 0
      ? `${day} は ${venueLabel} で、有料版の ${hits} レースが的中しました。`
      : `${day} は ${venueLabel} のレースで有料版の買い目を配信しました。`,
    ...(mainPayout ? [`メインレースでは ${mainPayout.toLocaleString('ja-JP')} 円の払戻が出ています。`] : []),
    '',
    '買い目は「本命 → 相手 5 頭」の一方向馬単 5 点。軸を決めて絞った買い目です。',
    '実際に配信した買い目と払戻は、下のページで公開しています。「買っていたらいくらになったか」をご覧ください。',
  ].join('\n');

  const step = {
    subject: `【KEIBA Analytics】${day} 有料版の買い目、どのレースで的中したか`,
    preheader: hits > 0
      ? `有料版の ${hits} レースが的中。実際の買い目と払戻を公開しています。`
      : '有料版で配信した買い目と払戻を公開しています。',
    headline,
    body,
    /**
     * ⚠️ **着地先にある物だけを書く。** ここで有料版の中身（AI 総合指数・全頭の役割分け）を
     *    約束すると、CTA 先（実績ページ）には無いので嘘になる。
     *    品質判定（`promise_not_on_landing_page`）もそれを弾く。
     */
    benefitTitle: 'このページで確認できること',
    benefitItems: [
      '有料版で実際に配信したメインレースの買い目（本命 → 相手 5 頭）',
      '有料版が的中したレース',
      '的中したレースの払戻',
    ],
    ctaUrl: WEEKLY_CTA.url,
    ctaLabel: WEEKLY_CTA.label,
    ctaNote: WEEKLY_CTA.note,
  };
  return { ok: true, step };
}

/** 文面 → SendGrid へ渡す形（本文はそのまま・停止リンクは SendGrid に任せる） */
export function renderWeekly(step) {
  const text = [
    step.headline, '', step.body, '',
    `■ ${step.benefitTitle}`,
    ...step.benefitItems.map((i) => `・${i}`),
    '',
    `▼ ${step.ctaLabel}`,
    step.ctaUrl,
    step.ctaNote,
    '',
    '配信停止はこちら: <%asm_group_unsubscribe_raw_url%>',
  ].join('\n');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = [
    `<p>${esc(step.headline)}</p>`,
    ...step.body.split('\n').map((l) => (l ? `<p>${esc(l)}</p>` : '')),
    `<p><strong>${esc(step.benefitTitle)}</strong></p>`,
    '<ul>', ...step.benefitItems.map((i) => `<li>${esc(i)}</li>`), '</ul>',
    `<p><a href="${esc(step.ctaUrl)}">${esc(step.ctaLabel)}</a></p>`,
    `<p>${esc(step.ctaNote)}</p>`,
    '<p><a href="<%asm_group_unsubscribe_raw_url%>">配信停止</a></p>',
  ].filter(Boolean).join('\n');
  return { subject: step.subject, text, html };
}

export default buildWeeklyContent;

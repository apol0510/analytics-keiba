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
  note: '有料版で実際に配信したメインレースの買い目と、その結果をそのまま公開しています。',
});

export const CONTENT_FAIL = Object.freeze({
  NO_RESULTS: 'no_results',
  NO_MAIN_RACE: 'no_main_race',
});

const pct = (n) => `${Math.round(n * 1000) / 10}%`;

/**
 * @param {{
 *   dateKey: string,
 *   showcase: {date?:string, venues?: Array<{venue:string, mainRace?:object, races?:Array}>}|null,
 * }} input
 * @returns {{ok:boolean, reason?:string, step?:object}}
 */
export function buildWeeklyContent({ dateKey, showcase } = {}) {
  const venues = (showcase && Array.isArray(showcase.venues)) ? showcase.venues : [];
  if (venues.length === 0) return { ok: false, reason: CONTENT_FAIL.NO_RESULTS };

  const mains = venues.map((v) => v && v.mainRace).filter(Boolean);
  if (mains.length === 0) return { ok: false, reason: CONTENT_FAIL.NO_MAIN_RACE };

  const allRaces = venues.flatMap((v) => (Array.isArray(v.races) ? v.races : []));
  const hits = allRaces.filter((r) => r && r.isHit === true).length;
  const total = allRaces.length;
  const hitRate = total > 0 ? hits / total : 0;
  const mainHits = mains.filter((m) => m && m.isHit === true).length;
  const day = String((showcase && showcase.date) || dateKey || '');

  const headline = `${day} の結果：メイン ${mainHits}/${mains.length} 的中`;
  const body = [
    'いつも KEIBA Analytics の無料予想をご覧いただきありがとうございます。',
    '前回ご覧いただいた無料予想の続きとして、有料版で実際に配信した買い目の結果をお届けします。',
    '',
    `${day} は ${venues.map((v) => v.venue).join('・')} の ${total} レースを配信し、${hits} レースが的中しました（的中率 ${pct(hitRate)}）。`,
    `メインレースは ${mains.length} 鞍中 ${mainHits} 鞍が的中しています。`,
    '',
    '買い目は「本命 → 相手 5 頭」の一方向馬単 5 点だけです。点数を増やして当てにいく作りにはしていません。',
    '実際に配信した買い目と払戻は、下のページでそのまま公開しています。当たった日も外した日も同じ形で出しています。',
  ].join('\n');

  const step = {
    subject: `【KEIBA Analytics】${day} メインレースの結果と買い目`,
    preheader: `${total} レース中 ${hits} レース的中。買い目は 5 点のまま公開しています。`,
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
      '全レースの的中・不的中（外した日も同じ形で出しています）',
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

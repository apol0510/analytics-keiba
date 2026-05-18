// analytics-keiba デイリーメルマガ（メインレース中心）の subject / bodyHtml 生成。
// 副作用ゼロの純粋関数。Airtable / SendGrid / fs に触れない。
// 全レース羅列ではなく、メインレース・注目レース1点に絞った文面にする。
//
// 2026-05-19 Phase 2.5: featuredHorse + 有料予想 CTA + links optional 引数を追加。
//   - featuredHorse が未指定なら注目馬セクションを出さない（仮データで埋めない）。
//   - links.free / links.premium で URL を上書き可能（将来 JRA / KI 拡張用）。

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatJpDate(isoDate) {
  // 'YYYY-MM-DD' → '5/14(水)' 形式
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate;
  }
  const [y, m, d] = isoDate.split('-').map(Number);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const wd = weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}

const DEFAULT_LINKS = Object.freeze({
  free: 'https://analytics.keiba.link/free-prediction/nankan',
  premium: 'https://analytics.keiba.link/premium-prediction/nankan',
});

// href に javascript: / data: 等の不正スキームを差し込まれないよう、http(s) のみ受け入れる。
// 不正な値は default にフォールバック（defense in depth、caller 側でも検証する想定）。
function isSafeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

export function renderDailyMainRace({
  campaignDate,
  targetRace,
  brand = 'analytics-keiba',
  featuredHorse = null,
  links = null,
}) {
  if (!targetRace || typeof targetRace !== 'object') {
    throw new Error('targetRace is required');
  }
  const {
    venue = '',
    raceNumber = '',
    raceName = '',
    grade = '',
    postTime = '',
  } = targetRace;

  const dateLabel = formatJpDate(campaignDate);
  const venueLabel = escapeHtml(venue);
  const raceNumLabel = raceNumber ? `${raceNumber}R` : '';
  const gradeLabel = grade ? `（${escapeHtml(grade)}）` : '';
  const raceNameLabel = raceName ? escapeHtml(raceName) : 'メインレース';
  const postTimeLabel = postTime ? `発走 ${escapeHtml(postTime)}` : '';

  const brandLabel = brand === 'keiba-intelligence' ? '競馬インテリジェンス' : 'KEIBA Analytics';

  const resolvedLinks = {
    free: isSafeUrl(links?.free) ? links.free : DEFAULT_LINKS.free,
    premium: isSafeUrl(links?.premium) ? links.premium : DEFAULT_LINKS.premium,
  };
  const freeUrl = escapeHtml(resolvedLinks.free);
  const premiumUrl = escapeHtml(resolvedLinks.premium);

  const subject = `【${brandLabel}】${dateLabel} ${venueLabel}${raceNumLabel} ${raceNameLabel}${gradeLabel} の予想を公開`;

  // 注目馬セクション（featuredHorse が未指定なら何も出さない）
  let featuredHorseBlock = '';
  if (featuredHorse && typeof featuredHorse === 'object') {
    const fhName = escapeHtml(featuredHorse.name || '');
    const fhNumber = featuredHorse.number != null && featuredHorse.number !== '' ? escapeHtml(String(featuredHorse.number)) : '';
    const fhRole = escapeHtml(featuredHorse.role || '本命');
    if (fhName) {
      const numTag = fhNumber ? `<span style="display:inline-block; min-width:28px; padding:2px 8px; margin-right:8px; background:#1f2937; color:#fff; border-radius:4px; font-weight:700; text-align:center;">${fhNumber}</span>` : '';
      featuredHorseBlock = [
        '<div style="background:#fef3c7; border-left:4px solid #f59e0b; border-radius:6px; padding:16px; margin:20px 0;">',
        `<p style="margin:0 0 8px; font-weight:600; color:#92400e;">本日の${fhRole}</p>`,
        `<p style="margin:0; font-size:18px;">${numTag}<strong>${fhName}</strong></p>`,
        '</div>',
      ].join('\n');
    }
  }

  const bodyHtml = [
    '<!doctype html>',
    '<html lang="ja"><body style="font-family: \'Helvetica Neue\', Arial, sans-serif; line-height: 1.7; color: #1f2937;">',
    '<div style="max-width: 600px; margin: 0 auto; padding: 24px;">',
    `<h1 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(dateLabel)} の注目レース</h1>`,
    `<p>本日の${brandLabel}は <strong>${venueLabel}${raceNumLabel}</strong> ${raceNameLabel}${gradeLabel} に注目しています。</p>`,
    postTimeLabel ? `<p style="color:#4b5563; font-size: 14px;">${postTimeLabel}</p>` : '',
    '<div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 24px 0;">',
    `<p style="margin: 0 0 8px; font-weight: 600;">本日のメイン</p>`,
    `<p style="margin: 0;">${venueLabel} ${raceNumLabel} ${raceNameLabel}${gradeLabel}</p>`,
    '</div>',
    featuredHorseBlock,
    '<p>無料予想・有料予想ともに公開しています。本日の本命・買い目をぜひご確認ください。</p>',
    `<p style="margin: 24px 0 12px;"><a href="${freeUrl}" style="display:inline-block; background:#059669; color:#fff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:700;">無料予想を見る</a></p>`,
    `<p style="margin: 12px 0 28px;"><a href="${premiumUrl}" style="display:inline-block; background:#dc2626; color:#fff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:700;">有料予想を見る</a></p>`,
    '<hr style="border:none; border-top:1px solid #e5e7eb; margin: 32px 0;">',
    `<p style="color:#6b7280; font-size:12px;">このメールは ${brandLabel} からお送りしています。</p>`,
    '</div></body></html>',
  ].filter(Boolean).join('\n');

  return { subject, bodyHtml };
}

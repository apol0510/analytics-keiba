// analytics-keiba デイリーメルマガ（メインレース中心）の subject / bodyHtml 生成。
// 副作用ゼロの純粋関数。Airtable / SendGrid / fs に触れない。
// 全レース羅列ではなく、メインレース・注目レース1点に絞った文面にする。

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

export function renderDailyMainRace({
  campaignDate,
  targetRace,
  brand = 'analytics-keiba',
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

  const subject = `【${brandLabel}】${dateLabel} ${venueLabel}${raceNumLabel} ${raceNameLabel}${gradeLabel} の予想を公開`;

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
    '<p>無料予想・有料予想ともに公開しています。本日の本命・買い目をぜひご確認ください。</p>',
    '<p style="margin: 28px 0;"><a href="https://analytics.keiba.link/free-prediction/" style="display:inline-block; background:#059669; color:#fff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:700;">無料予想を見る</a></p>',
    '<hr style="border:none; border-top:1px solid #e5e7eb; margin: 32px 0;">',
    '<p style="color:#6b7280; font-size:12px;">このメールは KEIBA Analytics からお送りしています。</p>',
    '</div></body></html>',
  ].filter(Boolean).join('\n');

  return { subject, bodyHtml };
}

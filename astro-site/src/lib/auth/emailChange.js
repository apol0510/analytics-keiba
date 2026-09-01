/**
 * emailChange.js — マイページからのメールアドレス変更の**判定と文面の単一源**（純粋・IO なし）。
 *
 * ## なぜ要るか（2026-09-01 MK 確定）
 *
 * 入金完了報告は**ログイン中のアドレスでしか申し込めない**ようにした
 * （`applicationIdentity.js`）。別のアドレスで申し込みたい人の逃げ道が要るため、
 * マイページでメールアドレスを変更できるようにする。
 *
 * ## 本人確認（確認リンク方式）
 *
 * 1. マイページで新しいアドレスを入力 → **この時点では何も変えない**
 * 2. **新しいアドレス宛**に確認リンクを送る
 * 3. リンクを開いて確定操作をして初めて Customers の Email を書き換える
 *
 * これで「他人のアドレスを勝手に自分のアカウントに付ける」ことができない
 * （受け取れる人しか確定できない）。旧アドレスにも通知を送り、身に覚えのない変更に
 * 気づけるようにする。
 *
 * ## 変更を断る条件
 *
 * | 条件 | 理由 |
 * |---|---|
 * | 形式が不正 | 届かないアドレスに変更するとログインできなくなる |
 * | 現在と同じ | 何も起きない操作でメールだけ飛ぶ |
 * | **既に他レコードで使われている** | 重複レコードができ、どちらでログインするか壊れる |
 * | 使用状況を**確認できない** | fail closed。壊すより断る |
 */

/** 確認リンクの有効時間（分）。マジックリンクと揃える。 */
export const EMAIL_CHANGE_TTL_MIN = 60;

/** 断る理由コード。 */
export const EMAIL_CHANGE_REJECT = Object.freeze({
  INVALID_FORMAT: 'invalid_format',
  SAME_AS_CURRENT: 'same_as_current',
  ALREADY_REGISTERED: 'already_registered',
  LOOKUP_UNAVAILABLE: 'lookup_unavailable',
});

/** 画面に出す文言（**画面ごとに書き分けない**）。 */
export const EMAIL_CHANGE_MESSAGE = Object.freeze({
  [EMAIL_CHANGE_REJECT.INVALID_FORMAT]: 'メールアドレスの形式が正しくありません。',
  [EMAIL_CHANGE_REJECT.SAME_AS_CURRENT]: '現在ご登録のメールアドレスと同じです。',
  [EMAIL_CHANGE_REJECT.ALREADY_REGISTERED]: 'このメールアドレスは既に登録されています。別のアドレスをご指定いただくか、サポートへお問い合わせください。',
  [EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE]: 'ただいま確認ができません。時間をおいて再度お試しください。',
});

/** 正規化（trim + lowercase）。Airtable 検索と同じ規則。 */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * ごく基本的な形式チェック。厳密な RFC 準拠はしない（実在確認は確認リンクが行う）。
 * 空白・カンマ・複数 @・ドット無しドメインを弾ければ十分。
 */
export function isPlausibleEmail(value) {
  const v = normalizeEmail(value);
  if (!v || v.length > 254) return false;
  return /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+\.[a-z0-9-]{2,}$/i.test(v);
}

/**
 * 変更してよいかを決める。
 *
 * @param {{ currentEmail?: string, newEmail?: string, newEmailTaken?: (boolean|null) }} input
 *   `newEmailTaken` は **`null` = 確認できなかった**。true / false 以外は fail closed。
 * @returns {{ ok: boolean, reason: string, currentEmail: string, newEmail: string }}
 */
export function decideEmailChange({ currentEmail, newEmail, newEmailTaken } = {}) {
  const cur = normalizeEmail(currentEmail);
  const next = normalizeEmail(newEmail);
  const base = { currentEmail: cur, newEmail: next };

  if (!isPlausibleEmail(next)) return { ok: false, reason: EMAIL_CHANGE_REJECT.INVALID_FORMAT, ...base };
  if (cur && cur === next) return { ok: false, reason: EMAIL_CHANGE_REJECT.SAME_AS_CURRENT, ...base };
  if (newEmailTaken === true) return { ok: false, reason: EMAIL_CHANGE_REJECT.ALREADY_REGISTERED, ...base };
  if (newEmailTaken !== false) return { ok: false, reason: EMAIL_CHANGE_REJECT.LOOKUP_UNAVAILABLE, ...base };
  return { ok: true, reason: '', ...base };
}

/** HTML エスケープ（差し込み値は必ず通す）。 */
export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 送る 2 通を組み立てる。
 * - `toNew`: 新アドレス宛。**確認リンクを含む**（これを開かないと変わらない）
 * - `toOld`: 旧アドレス宛。**リンクは含めない**。身に覚えがない場合の連絡先だけ書く
 */
export function buildEmailChangeEmails({ currentEmail, newEmail, confirmUrl, supportEmail } = {}) {
  const cur = escapeHtml(normalizeEmail(currentEmail));
  const next = escapeHtml(normalizeEmail(newEmail));
  const url = escapeHtml(String(confirmUrl || ''));
  const support = escapeHtml(String(supportEmail || ''));

  const toNew = {
    subject: '【KEIBA Analytics】メールアドレス変更の確認',
    text: [
      'メールアドレスの変更をお受けしました。',
      '',
      `変更前: ${normalizeEmail(currentEmail)}`,
      `変更後: ${normalizeEmail(newEmail)}`,
      '',
      '下記のページを開き、変更を確定してください。',
      `　${confirmUrl}`,
      '',
      `　※ このリンクは${EMAIL_CHANGE_TTL_MIN}分間のみ有効です。`,
      '　※ 確定するまでメールアドレスは変わりません。',
      '　※ お心当たりが無い場合は、このメールを破棄してください。何も変わりません。',
      '',
      `お問い合わせ: ${supportEmail || ''}`,
    ].join('\n'),
    html: `<div style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#1e293b;color:#e2e8f0;border-radius:12px;">
  <h1 style="margin:0 0 16px;font-size:20px;color:#f8fafc;">メールアドレス変更の確認</h1>
  <p style="line-height:1.9;font-size:15px;">メールアドレスの変更をお受けしました。下のボタンから変更を確定してください。</p>
  <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;margin:16px 0;">
    <tr><td style="padding:10px 14px;color:#94a3b8;font-size:14px;">変更前</td><td style="padding:10px 14px;color:#f1f5f9;font-size:14px;text-align:right;">${cur}</td></tr>
    <tr><td style="padding:10px 14px;color:#94a3b8;font-size:14px;">変更後</td><td style="padding:10px 14px;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600;">${next}</td></tr>
  </table>
  <div style="text-align:center;margin:20px 0 8px;">
    <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 32px;border-radius:10px;">変更を確定する</a>
  </div>
  <p style="text-align:center;font-size:12px;color:#64748b;">ボタンが開かない場合はこちら<br><a href="${url}" style="color:#38bdf8;word-break:break-all;">${url}</a></p>
  <p style="font-size:12px;color:#fca5a5;line-height:1.8;">
    ⚠️ このリンクは${EMAIL_CHANGE_TTL_MIN}分間のみ有効です。<br>
    ⚠️ 確定するまでメールアドレスは変わりません。<br>
    ⚠️ お心当たりが無い場合は、このメールを破棄してください。何も変わりません。
  </p>
  <p style="font-size:13px;color:#94a3b8;">お問い合わせ: <a href="mailto:${support}" style="color:#38bdf8;">${support}</a></p>
</div>`,
  };

  const toOld = {
    subject: '【KEIBA Analytics】メールアドレス変更のお申し出について',
    text: [
      'ご登録のメールアドレスを変更するお申し出をお受けしました。',
      '',
      `変更前: ${normalizeEmail(currentEmail)}`,
      `変更後: ${normalizeEmail(newEmail)}`,
      '',
      '確認のご連絡を新しいアドレス宛にお送りしています。',
      'そちらで確定されるまで、現在のメールアドレスのままご利用いただけます。',
      '',
      `お心当たりが無い場合は、お手数ですが ${supportEmail || ''} までご連絡ください。`,
    ].join('\n'),
    html: `<div style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#1e293b;color:#e2e8f0;border-radius:12px;">
  <h1 style="margin:0 0 16px;font-size:20px;color:#f8fafc;">メールアドレス変更のお申し出について</h1>
  <p style="line-height:1.9;font-size:15px;">ご登録のメールアドレスを変更するお申し出をお受けしました。</p>
  <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:8px;margin:16px 0;">
    <tr><td style="padding:10px 14px;color:#94a3b8;font-size:14px;">変更前</td><td style="padding:10px 14px;color:#f1f5f9;font-size:14px;text-align:right;">${cur}</td></tr>
    <tr><td style="padding:10px 14px;color:#94a3b8;font-size:14px;">変更後</td><td style="padding:10px 14px;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600;">${next}</td></tr>
  </table>
  <p style="line-height:1.9;font-size:14px;color:#cbd5e1;">確認のご連絡を新しいアドレス宛にお送りしています。そちらで確定されるまで、現在のメールアドレスのままご利用いただけます。</p>
  <p style="line-height:1.9;font-size:14px;color:#fca5a5;">お心当たりが無い場合は、お手数ですが <a href="mailto:${support}" style="color:#38bdf8;">${support}</a> までご連絡ください。</p>
</div>`,
  };

  return { toNew, toOld };
}

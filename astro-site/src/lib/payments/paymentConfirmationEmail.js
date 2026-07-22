/**
 * paymentConfirmationEmail.js — 入金確認メール（v2）の**本文の単一源**（純粋関数・IO なし）。
 *
 * 経緯（2026-07-22）:
 * v2 の本文は `<p>ご入金を確認いたしました。ご利用を開始いただけます。</p>` の 1 行だけで、
 * **ログインへの導線が無かった**。実顧客が「利用開始できます」と案内されながら入口が分からず、
 * 15 分で失効するログインリンクを **9 回連続で発行**して迷う事故が発生した
 * （2 回はログイン成功。残りは未使用のまま失効）。
 *
 * 恒久ルール:
 * - **入金確認メールには必ずログイン導線を含める**（ボタン + 生 URL の両方）。
 * - **マジックリンク方式であることを本文で説明する**（別便で届く / 件名 / 15 分で失効 / 迷惑メール確認）。
 *   これを書かないと「入金確認メールの中にログインリンクがあるはず」と探して詰まる。
 * - 差し込み値（氏名 / プラン等）は **必ず HTML エスケープ**する（Airtable 由来の外部入力）。
 * - 氏名は 600 件中 51 件しか埋まっていない。**空でも自然に読める文面**にする
 *   （'お客様' を機械的に埋めない）。
 * - 本文の URL は `analytics.keiba.link` のみ。`analytics.keiba.jp`（存在しない）や
 *   Netlify サブドメインを絶対に書かない。
 */

/** 既定のサイト URL（env 未設定時のフォールバック。本番 URL 以外を書かない）。 */
export const DEFAULT_SITE_BASE = 'https://analytics.keiba.link';

/** サポート窓口（返信先として本文にも記載する）。 */
export const SUPPORT_ADDRESS = 'support@keiba.link';

/** ログインリンクメールの件名（本文で「これを探してください」と案内するため単一源にする）。 */
export const MAGIC_LINK_SUBJECT = '【KEIBA Analytics】ログインリンク';

/** マジックリンクの有効時間（分）。send-magic-link.js と一致させること。 */
export const MAGIC_LINK_TTL_MIN = 15;

/** HTML エスケープ（差し込み値は必ずこれを通す）。 */
export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 前後空白を落として文字列化（空なら ''）。 */
function clean(v) {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

/**
 * 宛名。氏名があれば「〇〇 様」、無ければ挨拶のみ（'お客様' で埋めない）。
 */
export function buildGreeting(fullName) {
  const name = clean(fullName);
  return name ? `${escapeHtml(name)} 様` : 'この度はありがとうございます';
}

/** プラン表示。空なら「ご購入のプラン」。 */
function planLabel(plan) {
  const p = clean(plan);
  return p ? escapeHtml(p) : 'ご購入のプラン';
}

/** 期間表示。Lifetime は永久、期限があれば「〜まで」、無ければ空文字。 */
export function buildPeriodLabel({ planType, expiration }) {
  const t = clean(planType).toLowerCase();
  if (t === 'lifetime') return '永久アクセス';
  const exp = clean(expiration);
  return exp ? `${escapeHtml(exp)} まで` : '';
}

/**
 * 入金確認メールを組み立てる。
 *
 * @param {object} p
 * @param {string} [p.fullName]   Airtable `氏名`（空が多数）
 * @param {string} [p.plan]       Airtable `プラン`
 * @param {string} [p.planType]   'Monthly' | 'Annual' | 'Lifetime'
 * @param {string} [p.expiration] 'YYYY-MM-DD'
 * @param {string} [p.siteBase]   既定 DEFAULT_SITE_BASE
 * @returns {{subject: string, html: string, text: string, loginUrl: string}}
 */
export function buildPaymentConfirmationEmail({ fullName, plan, planType, expiration, siteBase } = {}) {
  const base = (clean(siteBase) || DEFAULT_SITE_BASE).replace(/\/$/, '');
  const loginUrl = `${base}/login`;
  const safeLoginUrl = escapeHtml(loginUrl);

  const greeting = buildGreeting(fullName);
  const planText = planLabel(plan);
  const period = buildPeriodLabel({ planType, expiration });

  const subject = '【KEIBA Analytics】ご入金を確認しました｜ご利用の開始方法';

  const periodRow = period
    ? `<tr><td style="padding:6px 0;color:#94a3b8;font-size:14px;">ご利用期間</td>
         <td style="padding:6px 0;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600;">${period}</td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ja">
<body style="margin:0;padding:24px 12px;background:#0f172a;font-family:'Hiragino Sans','Yu Gothic',sans-serif;">
  <div style="max-width:560px;margin:0 auto;">

    <div style="text-align:center;padding:8px 0 20px;">
      <div style="font-size:13px;letter-spacing:.18em;color:#38bdf8;font-weight:700;">KEIBA ANALYTICS</div>
    </div>

    <div style="background:linear-gradient(135deg,#1e293b,#172554);border-radius:16px 16px 0 0;padding:32px 28px 24px;text-align:center;">
      <div style="font-size:40px;line-height:1;margin-bottom:12px;">🎉</div>
      <h1 style="margin:0 0 8px;font-size:22px;color:#f8fafc;font-weight:700;">ようこそ、KEIBA Analytics へ！</h1>
      <p style="margin:0;color:#7dd3fc;font-size:14px;font-weight:600;">ご入金を確認いたしました</p>
    </div>

    <div style="background:#1e293b;padding:28px;">
      <p style="margin:0 0 16px;color:#e2e8f0;font-size:15px;line-height:1.9;">
        ${greeting}<br>
        この度は <strong style="color:#f8fafc;">${planText}</strong> をお申し込みいただき、誠にありがとうございます。<br>
        ご入金の確認が取れましたので、<strong style="color:#7dd3fc;">ただいまより全ての機能をご利用いただけます。</strong>
      </p>

      <table style="width:100%;border-collapse:collapse;background:#0f172a;border-radius:10px;padding:4px;margin:0 0 24px;">
        <tr><td colspan="2" style="padding:14px 16px 4px;color:#64748b;font-size:12px;letter-spacing:.08em;">ご契約内容</td></tr>
        <tr><td style="padding:6px 16px;color:#94a3b8;font-size:14px;">プラン</td>
            <td style="padding:6px 16px;color:#f1f5f9;font-size:14px;text-align:right;font-weight:600;">${planText}</td></tr>
        ${periodRow}
        <tr><td colspan="2" style="padding:0 16px 14px;"></td></tr>
      </table>

      <div style="text-align:center;margin:0 0 8px;">
        <a href="${safeLoginUrl}"
           style="display:inline-block;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#ffffff;
                  text-decoration:none;font-size:17px;font-weight:700;padding:16px 40px;border-radius:10px;">
          ログインして予想を見る
        </a>
      </div>
      <p style="margin:0 0 24px;text-align:center;color:#64748b;font-size:12px;">
        ボタンが開かない場合はこちら<br>
        <a href="${safeLoginUrl}" style="color:#38bdf8;word-break:break-all;">${safeLoginUrl}</a>
      </p>

      <div style="background:#0f172a;border-left:3px solid #38bdf8;border-radius:6px;padding:16px 18px;margin:0 0 20px;">
        <p style="margin:0 0 10px;color:#7dd3fc;font-size:14px;font-weight:700;">🔐 ログイン方法（かんたん2ステップ）</p>
        <p style="margin:0 0 8px;color:#cbd5e1;font-size:13px;line-height:1.9;">
          有料会員様は、セキュリティのため<strong style="color:#f1f5f9;">パスワード不要のログインリンク方式</strong>です。
        </p>
        <p style="margin:0 0 8px;color:#cbd5e1;font-size:13px;line-height:1.9;">
          <strong style="color:#f1f5f9;">1.</strong> 上のボタンからログイン画面を開き、メールアドレスを入力
        </p>
        <p style="margin:0 0 12px;color:#cbd5e1;font-size:13px;line-height:1.9;">
          <strong style="color:#f1f5f9;">2.</strong> 件名「<strong style="color:#f1f5f9;">${escapeHtml(MAGIC_LINK_SUBJECT)}</strong>」の
          メールが<strong style="color:#f1f5f9;">別便で届く</strong>ので、そのリンクを開く
        </p>
        <p style="margin:0;color:#fca5a5;font-size:12px;line-height:1.8;">
          ⚠️ ログインリンクは <strong>${MAGIC_LINK_TTL_MIN}分間</strong>のみ有効です。
          必ず<strong>最新の1通</strong>をお使いください。<br>
          ⚠️ このメール（入金確認）にはログインリンクは含まれていません。別便をご確認ください。<br>
          ⚠️ 見当たらない場合は<strong>迷惑メールフォルダ</strong>もご確認ください。
        </p>
      </div>

      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.9;">
        ご不明な点がございましたら、このメールにそのままご返信いただくか
        <a href="mailto:${SUPPORT_ADDRESS}" style="color:#38bdf8;">${SUPPORT_ADDRESS}</a> までお気軽にお問い合わせください。<br>
        これからのレースが、より楽しいものになりますように。
      </p>
    </div>

    <div style="background:#172033;border-radius:0 0 16px 16px;padding:18px 28px;text-align:center;">
      <p style="margin:0;color:#64748b;font-size:11px;line-height:1.8;">
        KEIBA Analytics｜<a href="${escapeHtml(base)}" style="color:#475569;">${escapeHtml(base)}</a><br>
        本メールは自動送信です。お問い合わせは ${SUPPORT_ADDRESS} へ。
      </p>
    </div>

  </div>
</body>
</html>`;

  const text = [
    'ようこそ、KEIBA Analytics へ！',
    '',
    clean(fullName) ? `${clean(fullName)} 様` : 'この度はありがとうございます。',
    `この度は ${clean(plan) || 'ご購入のプラン'} をお申し込みいただき、誠にありがとうございます。`,
    'ご入金の確認が取れましたので、ただいまより全ての機能をご利用いただけます。',
    '',
    '■ ご契約内容',
    `　プラン: ${clean(plan) || 'ご購入のプラン'}`,
    period ? `　ご利用期間: ${clean(planType).toLowerCase() === 'lifetime' ? '永久アクセス' : `${clean(expiration)} まで`}` : '',
    '',
    '■ ログイン',
    `　${loginUrl}`,
    '',
    '■ ログイン方法（かんたん2ステップ）',
    '　有料会員様は、セキュリティのためパスワード不要のログインリンク方式です。',
    '　1. 上記URLからログイン画面を開き、メールアドレスを入力',
    `　2. 件名「${MAGIC_LINK_SUBJECT}」のメールが別便で届くので、そのリンクを開く`,
    '',
    `　※ ログインリンクは${MAGIC_LINK_TTL_MIN}分間のみ有効です。必ず最新の1通をお使いください。`,
    '　※ このメール（入金確認）にログインリンクは含まれていません。別便をご確認ください。',
    '　※ 見当たらない場合は迷惑メールフォルダもご確認ください。',
    '',
    `お問い合わせ: ${SUPPORT_ADDRESS}`,
    `KEIBA Analytics ${base}`,
  ].filter((line) => line !== '').join('\n');

  return { subject, html, text, loginUrl };
}

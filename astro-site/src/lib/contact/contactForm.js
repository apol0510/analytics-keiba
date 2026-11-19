/**
 * contactForm.js — /contact/ のお問い合わせを受け付ける前の整形（純粋・単一源）
 *
 * 2026-11-09 リニューアル（docs/CONTACT_RENEWAL.md）:
 *   - 種類は閉じた語彙（CONTACT_TOPICS）。GA4 へ送るのはこの key だけ（本文・メールは送らない）。
 *   - 旧ページ（キャッシュ）の日本語ラベルも受け付ける（LEGACY_SUBJECT_TO_TOPIC）。
 *   - お名前は任意。空なら「お客様」。
 *   - 管理者宛・自動返信の HTML へ入れる値は必ず escapeHtml を通す
 *     （自動返信は入力されたアドレスへ届くため、HTML を差し込めると
 *      support@keiba.link 名義の偽メールを第三者へ送れてしまう）。
 *   - honeypot（website 欄）が埋まっていたら送信しない（機械投稿）。
 */

/** 種類の正本。key は GA4 の contact_topic にもそのまま使う。 */
export const CONTACT_TOPICS = Object.freeze({
  usage: '予想の見方・使い方',
  plan: 'プラン・料金',
  payment: 'お支払い・ご入金',
  login: 'ログイン・メールが届かない',
  cancel: '退会・解約',
  bug: '不具合の報告',
  request: 'ご要望・ご意見',
  other: 'その他',
});

/** 2026-11-09 以前のページが送っていた件名 → 新しい key。 */
export const LEGACY_SUBJECT_TO_TOPIC = Object.freeze({
  'サービスについて': 'other',
  '料金プランについて': 'plan',
  '使い方について': 'usage',
  'アカウントについて': 'login',
  '不具合報告': 'bug',
  'ご要望・ご意見': 'request',
  'その他': 'other',
});

export const MAX_NAME_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 5000;
export const DEFAULT_CONTACT_NAME = 'お客様';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** HTML へ差し込む文字列を無害化する。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** topic（新 key）または旧件名を key へ。わからなければ other。 */
export function resolveTopic({ topic, subject } = {}) {
  if (typeof topic === 'string' && Object.prototype.hasOwnProperty.call(CONTACT_TOPICS, topic)) return topic;
  if (typeof subject === 'string') {
    const s = subject.trim();
    if (Object.prototype.hasOwnProperty.call(LEGACY_SUBJECT_TO_TOPIC, s)) return LEGACY_SUBJECT_TO_TOPIC[s];
    const byLabel = Object.keys(CONTACT_TOPICS).find((k) => CONTACT_TOPICS[k] === s);
    if (byLabel) return byLabel;
  }
  return 'other';
}

/**
 * フォームの入力を検査・整形する。
 * @returns {{ok:true, spam:boolean, value:{name:string,email:string,topic:string,topicLabel:string,message:string}}
 *          | {ok:false, error:string}}
 */
export function normalizeContactInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  // 機械投稿: 人には見えない欄が埋まっている → 成功に見せて送らない
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return { ok: true, spam: true, value: null };
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';

  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: '返信先のメールアドレスを正しく入力してください' };
  }
  if (!message) {
    return { ok: false, error: 'お問い合わせ内容を入力してください' };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `お問い合わせ内容は ${MAX_MESSAGE_LENGTH} 文字以内でお願いします` };
  }
  const name = (rawName || DEFAULT_CONTACT_NAME).slice(0, MAX_NAME_LENGTH);
  const topic = resolveTopic({ topic: body.topic, subject: body.subject });
  return {
    ok: true,
    spam: false,
    value: { name, email, topic, topicLabel: CONTACT_TOPICS[topic], message },
  };
}

export const MAX_SUBJECT_LENGTH = 200;
export const MAX_FORM_TYPE_LENGTH = 64;

/**
 * 有料会員のお問い合わせ（premium-plus-contact）の入力を検査・整形する。
 * 必須はお名前・メール・件名・本文（従来どおり）。長さとメール形式を検査し、
 * HTML へ入れる前の無害化は Function 側で escapeHtml を通す。
 * @returns {{ok:true, value:{name:string,email:string,subject:string,message:string,formType:string|null,timestamp:unknown}}
 *          | {ok:false, error:string}}
 */
export function normalizePremiumContactInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body.name);
  const email = str(body.email);
  const subject = str(body.subject);
  const message = str(body.message);
  if (!name || !email || !subject || !message) {
    return { ok: false, error: '必須項目が入力されていません' };
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, error: '返信先のメールアドレスを正しく入力してください' };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `お問い合わせ内容は ${MAX_MESSAGE_LENGTH} 文字以内でお願いします` };
  }
  const formType = str(body.formType).slice(0, MAX_FORM_TYPE_LENGTH) || null;
  return {
    ok: true,
    value: {
      name: name.slice(0, MAX_NAME_LENGTH),
      email,
      subject: subject.slice(0, MAX_SUBJECT_LENGTH),
      message,
      formType,
      timestamp: body.timestamp,
    },
  };
}

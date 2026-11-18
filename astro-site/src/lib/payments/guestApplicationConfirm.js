/**
 * guestApplicationConfirm.js — 未ログインの入金完了報告が「既存のお客様のレコード」を書き換えないための単一源。
 *
 * ## なぜ要るか（2026-11-05 監査で発見・KAO registry 339e0bd2）
 *
 * `bank-transfer-application` は公開 Function で、未ログインでも申し込める（新規のお客様の購入導線）。
 * 旧実装は body の `email` で Customers を引き、**見つかればそのレコードをそのまま PATCH** していた。
 * そのため、他人のメールアドレスを入れるだけで、その方の
 *   - 氏名（`氏名`）
 *   - 申込内容（`RequestedPlan` / `RequestedPlanType` / `RequestedAmount`）
 *   - 入金確認済みフラグ（`PaymentConfirmed` を false に戻す）
 *   - `Status`（active 以外は pending へ）
 * を、ログインもせずに上書きできた。本物の申込の内容を差し替えられると、
 * 管理者が入金確認したときに**別の内容で昇格する**。
 *
 * ## 決めたこと
 *
 * | 申込者 | レコード | 扱い |
 * |---|---|---|
 * | ログイン中（セッションのアドレス＝申込アドレス） | あり | 従来どおり本人のレコードを更新 |
 * | 未ログイン | なし | 従来どおり新規作成 |
 * | 未ログイン | **あり** | **レコードに触れない**。申込内容をサーバー側に一時保存し、
 *   そのアドレス宛てに推測できない確定リンクを送る。リンクを開いて「確定」した時点で初めて反映する |
 *
 * - 申込者への応答は「レコードがある / ない」で**変えない**（アドレスの登録有無を明かさない）。
 * - 確定リンクのトークンは 32 バイトの乱数。Redis には**トークンの SHA-256 だけ**を鍵として保存する。
 * - リンクは URL の `#` 以降に載せる（サーバーのログ・GA4 の page_location に残さない）。
 * - リンクを開くだけでは確定しない（メールのリンク先読みで自動確定させない）。画面のボタンで POST する。
 * - 1 回限り（GETDEL）。反映に失敗したときだけ元に戻す。
 */
import { randomBytes, createHash } from 'node:crypto';

/** 書き込み経路の判定結果 */
export const APPLICATION_WRITE = Object.freeze({
  /** ログイン中の本人 → 本人のレコードを更新 */
  OWNER_UPDATE: 'owner_update',
  /** レコードなし → 新規作成 */
  CREATE: 'create',
  /** 未ログインでレコードあり → レコードに触れず、本人の確定を待つ */
  OWNER_CONFIRMATION: 'owner_confirmation',
});

/** 確定リンクの有効期間（秒）。振込後の報告なので 7 日あれば足りる */
export const PENDING_APPLICATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Redis の鍵の接頭辞（トークン本体ではなく SHA-256 を続ける） */
export const PENDING_APPLICATION_KEY_PREFIX = 'ak:bank-app-pending:v1:';

/** 確定画面のパス */
export const CONFIRM_PAGE_PATH = '/bank-transfer/confirm/';

/** 確定画面が送る action */
export const OWNER_ACTION = Object.freeze({
  PREVIEW: 'preview_application',
  CONFIRM: 'confirm_application',
  CANCEL: 'cancel_application',
});

/** 申込者（未ログイン）に返す、Light / Premium Plus の「ログインが必要」応答。アドレスの有無で変えない */
export const LOGIN_REQUIRED = Object.freeze({
  code: 'login_required',
  lightMessage: 'Light プランのご更新は、ログインのうえお申し込みください。'
    + '（Light プランの新規のお申し込みは終了しました。料金ページの Premium をご覧ください。）'
    + '既にお振込み済みの場合はお問い合わせください。',
  plusMessage: 'Premium Plus は、ログインのうえ会員ページからお申し込みください。'
    + '既にお振込み済みの場合はお問い合わせください。',
});

/**
 * どの経路で書くかを決める（純粋）。
 * @param {{ authenticated: boolean, existingRecord: boolean }} input
 *   `authenticated` は**検証済みセッションのアドレスが申込アドレスと一致した**ときだけ true。
 */
export function decideApplicationWrite({ authenticated, existingRecord } = {}) {
  if (!existingRecord) return APPLICATION_WRITE.CREATE;
  if (authenticated === true) return APPLICATION_WRITE.OWNER_UPDATE;
  return APPLICATION_WRITE.OWNER_CONFIRMATION;
}

/** 推測できない確定トークン（base64url 43 文字） */
export function generateApplicationToken(randomBytesImpl = randomBytes) {
  return Buffer.from(randomBytesImpl(32)).toString('base64url');
}

/** 形式だけの確認（長さ・文字種）。合わなければ Redis を引かない */
export function isWellFormedToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Redis の鍵。**トークン本体は保存しない** */
export function pendingApplicationKey(token) {
  return PENDING_APPLICATION_KEY_PREFIX + createHash('sha256').update(String(token)).digest('hex');
}

/** 確定リンク（トークンは # 以降。サーバー・計測に送られない） */
export function buildConfirmUrl(siteUrl, token) {
  const base = String(siteUrl || 'https://analytics.keiba.link').replace(/\/+$/, '');
  return `${base}${CONFIRM_PAGE_PATH}#t=${token}`;
}

/** HTML メールへ差し込む利用者入力のエスケープ */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 一時保存する申込内容（反映に必要な値だけ）。
 * @returns {object}
 */
export function buildPendingApplication({
  recordId, email, fullName, planName, planType, amount,
  productName, transferDate, transferAmount, transferName, nowMs,
}) {
  return {
    v: 1,
    recordId: String(recordId || ''),
    email: String(email || '').trim().toLowerCase(),
    fullName: String(fullName || ''),
    planName: planName || null,
    planType: planType || null,
    amount: Number.isFinite(amount) ? amount : null,
    productName: String(productName || ''),
    transferDate: String(transferDate || ''),
    transferAmount: String(transferAmount ?? ''),
    transferName: String(transferName || ''),
    createdAt: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
  };
}

/** 確定画面に見せる内容（本人が自分の申込か判断できる範囲だけ） */
export function describePendingForOwner(p) {
  return {
    productName: p.productName,
    fullName: p.fullName,
    transferDate: p.transferDate,
    transferAmount: Number.parseInt(p.transferAmount, 10) || null,
    transferName: p.transferName,
  };
}

function parsePending(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || p.v !== 1 || !p.recordId || !p.email) return null;
    return p;
  } catch {
    return null;
  }
}

/** 保存（同じ鍵があれば上書きしない）。成功で true */
export async function savePendingApplication({ redisCmd, token, payload }) {
  const r = await redisCmd([
    'SET', pendingApplicationKey(token), JSON.stringify(payload),
    'EX', String(PENDING_APPLICATION_TTL_SECONDS), 'NX',
  ]);
  return r === 'OK';
}

/** 読むだけ（確定画面の表示用） */
export async function readPendingApplication({ redisCmd, token }) {
  return parsePending(await redisCmd(['GET', pendingApplicationKey(token)]));
}

/** 取り出して消す（1 回限り）。無ければ null */
export async function takePendingApplication({ redisCmd, token }) {
  return parsePending(await redisCmd(['GETDEL', pendingApplicationKey(token)]));
}

/** 反映に失敗したときだけ戻す（本人がもう一度押せるように） */
export async function restorePendingApplication({ redisCmd, token, payload }) {
  await redisCmd([
    'SET', pendingApplicationKey(token), JSON.stringify(payload),
    'EX', String(PENDING_APPLICATION_TTL_SECONDS),
  ]);
}

/** 本人が「心当たりがない」を押したとき */
export async function deletePendingApplication({ redisCmd, token }) {
  await redisCmd(['DEL', pendingApplicationKey(token)]);
}

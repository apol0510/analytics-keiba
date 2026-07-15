/**
 * contactSubject.js — 有料会員お問い合わせの「会員種別ラベル」と管理メール件名を組み立てる（純粋）
 *
 * 背景: premium-plus-contact.js は全送信の件名/見出しを「Premium Plus お問い合わせ」固定にしており、
 *   一般プレミアム会員（PremiumContactModal / dashboard・premium 予想ページ）の問い合わせまで
 *   Premium Plus 扱いになっていた（Premium 会員が Premium Plus として届く事故）。
 *   会員種別（Airtable プラン）に応じたラベルへ正す。plan 不明時は formType で穏当にフォールバックし、
 *   決して「Premium Plus 固定」にはしない。
 */

import { normalizePlan } from '../auth/planNormalization.js';

/** 正規プラン → 管理メール用の会員種別ラベル。 */
export const PLAN_CONTACT_LABEL = Object.freeze({
  'free': '無料会員',
  'light': 'Light 会員',
  'premium': 'Premium 会員',
  'premium-predictions': 'Premium 予想会員',
  'premium-sanrenpuku': 'Premium Sanrenpuku 会員',
  'premium-sanrentan': 'Premium 三連単会員',
  'premium-combo': 'Premium Combo 会員',
  'premium-plus': 'Premium Plus 会員',
});

/**
 * plan を Airtable から取得できないときの穏当なフォールバック（フォーム由来で判定）。
 * ※ 一般モーダル(premium-predictions-contact) を Premium Plus にしないことが目的。
 */
export const FORM_TYPE_FALLBACK_LABEL = Object.freeze({
  'premium-plus-contact': 'Premium Plus',
  'premium-predictions-contact': 'プレミアム会員',
});

export const UNKNOWN_MEMBER_LABEL = '会員種別不明';

/**
 * 会員種別ラベルを決める。Airtable プラン（生値/正規値どちらでも可）を最優先、
 * 取得不可なら formType、いずれも不明なら「会員種別不明」。
 * @param {{plan?:unknown, formType?:unknown}} input
 * @returns {string}
 */
export function resolveMemberLabel({ plan, formType } = {}) {
  const normalized = normalizePlan(plan);
  if (normalized && PLAN_CONTACT_LABEL[normalized]) return PLAN_CONTACT_LABEL[normalized];
  if (typeof formType === 'string' && FORM_TYPE_FALLBACK_LABEL[formType]) {
    return FORM_TYPE_FALLBACK_LABEL[formType];
  }
  return UNKNOWN_MEMBER_LABEL;
}

/**
 * 管理者メールの件名・見出しラベルを会員種別に応じて組み立てる。
 * @param {{plan?:unknown, formType?:unknown, subject?:unknown, email?:unknown}} input
 * @returns {{memberLabel:string, heading:string, adminSubject:string}}
 */
export function buildAdminContactSubject({ plan, formType, subject, email } = {}) {
  const label = resolveMemberLabel({ plan, formType });
  const cleanSubject = typeof subject === 'string' && subject.trim() ? subject.trim() : '（件名なし）';
  const cleanEmail = typeof email === 'string' && email.trim() ? email.trim() : '(no-email)';
  return {
    memberLabel: label,
    heading: `${label} お問い合わせ`,
    adminSubject: `【${label} お問い合わせ】${cleanSubject} - ${cleanEmail}`,
  };
}

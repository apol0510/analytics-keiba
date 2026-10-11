/**
 * fincodeNotify.js — fincode 決済の管理者通知。本体は決済会社共通の cardNotify.js（顧客には送らない）。
 */
import { makeCardNotifier } from '../cardNotify.js';

export function makeFincodeNotifier(env, { mode = 'test', send } = {}) {
  return makeCardNotifier(env, { mode, provider: 'fincode', send });
}

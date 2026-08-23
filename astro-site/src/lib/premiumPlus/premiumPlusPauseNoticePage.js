/**
 * premiumPlusPauseNoticePage.js — 受付休止ページ / クーポンページの HTML を組み立てる（純粋）
 *
 * ## なぜ .astro ではなくここで組むのか
 *
 * 商品ページ（`premium-plus.astro` / `premium-plus-v2.astro`）は 2,000 行を超える。
 * その中に休止時の分岐を差し込むと、**購入 CTA・価格・口座情報が休止表示へ漏れる**
 * 事故が起きやすい。休止ページは商品ページと**別の HTML**として組み立て、
 * 「購入導線が 1 つも入っていない」ことを文字列として検査できるようにする。
 *
 * ## 出してはいけないもの（guard テストで固定）
 *
 *   - 購入 CTA / 申込ボタン / 申込フォーム / 決済・振込先の情報
 *   - 価格（¥68,000 / ¥98,000 等）
 *   - 「好評につき」「残りわずか」のような**購入を煽る希少性の演出**
 *     （※「お申し込みが殺到しており」は**ご案内できない理由**そのものなので使う。
 *       2026-08-22 MK 確定文言。販促文脈で使わないことを guard で固定している）
 *
 * ## 出すもの
 *
 *   - 受付を一時休止していることのお詫びと感謝
 *   - 募集再開時に使える優待クーポンの案内（**条件は未確定**であることを含む）
 *   - 未取得なら取得 CTA / 取得済みなら取得日時と「二重取得させない」表示
 */

import { describeCouponDiscount, describeCouponPrice } from './premiumPlusReopenCoupon.js';

/** クーポン取得 API のパス（画面とサーバーで 1 か所に固定する） */
export const COUPON_API_PATH = '/api/premium-plus-coupon.json';
/** クーポンページのパス */
export const COUPON_PAGE_PATH = '/premium-plus-coupon/';

/** 受付休止ページの文言（正本）。断定できない表現を足さないこと。 */
export const PAUSE_NOTICE_COPY = Object.freeze({
  title: 'お申し込みが殺到しており、ただいまご案内できません',
  lead: 'Premium Plus にご関心をお寄せいただき、ありがとうございます。',
  body: '現在お申し込みが集中しており、新規のご案内を一時的に止めております。'
    + 'せっかくご検討いただいたにもかかわらず、すぐにご案内できず申し訳ございません。',
  couponLead: '次回ご案内の際にお使いいただける優待クーポンをご用意しております。',
  couponAsk: '今のうちにクーポンを受け取っておきますか？',
});

/**
 * 取得する具体的なメリットを**一目で**伝える見出しと CTA。
 * ⚠️ 金額は書き写さず、必ず単一源（describeCouponDiscount / describeCouponPrice）から作る。
 */
export function benefitHeadline() {
  return `再募集時に使える ${describeCouponDiscount()} クーポン`;
}
export function benefitPriceLine() {
  return describeCouponPrice();
}
export function claimCtaLabel() {
  return `${describeCouponDiscount()} クーポンを取得する`;
}

/** クーポンページの文言 */
export const COUPON_PAGE_COPY = Object.freeze({
  title: 'ご登録のクーポン',
  lead: 'お客様が取得されているクーポンの状況です。',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 取得日時の表示（JST・分まで）。値が無ければ空文字。
 * ⚠️ `toISOString()` の UTC 基準で日付を作らない（JST 深夜に 1 日ズレる）。
 */
export function formatClaimedAtJst(iso) {
  if (!iso) return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:0;background:#0b1120;color:#e2e8f0;
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
  line-height:1.9;-webkit-text-size-adjust:100%}
.wrap{max-width:640px;margin:0 auto;padding:48px 20px 72px}
.card{background:#111c33;border:1px solid #1e293b;border-radius:16px;padding:28px 24px}
h1{font-size:1.28rem;margin:0 0 20px;color:#f8fafc;line-height:1.6}
p{margin:0 0 16px;font-size:0.98rem;color:#cbd5e1}
.lead{color:#e2e8f0}
.coupon{margin:28px 0 0;padding:20px;border-radius:14px;
  border:1px solid #334155;background:#0f1a2e}
.coupon-name{font-size:1.05rem;font-weight:700;color:#f8fafc;margin:0 0 6px}
.coupon-desc{font-size:0.9rem;color:#94a3b8;margin:0 0 14px}
.benefit-head{font-size:1.02rem;font-weight:700;color:#f8fafc;margin:0 0 16px}
.coupon-benefit{font-size:1.32rem;font-weight:800;color:#6ee7b7;margin:0 0 4px;letter-spacing:.01em}
.coupon-price{font-size:1rem;color:#e2e8f0;margin:0 0 14px}
.state{display:inline-block;font-size:0.84rem;font-weight:700;padding:5px 12px;
  border-radius:999px;margin:0 0 12px}
.state.held{background:#064e3b;color:#6ee7b7;border:1px solid #10b981}
.state.none{background:#1e293b;color:#cbd5e1;border:1px solid #475569}
dl{margin:0;font-size:0.9rem}
dt{color:#94a3b8;font-size:0.82rem;margin:10px 0 2px}
dd{margin:0;color:#e2e8f0}
.note{font-size:0.84rem;color:#94a3b8;margin:14px 0 0}
a.order-cta{display:block;text-align:center;margin:20px 0 0;padding:15px 18px;border-radius:12px;
  background:#2563eb;color:#fff;font-size:0.98rem;font-weight:700;text-decoration:none}
a.order-cta:hover{background:#1d4ed8}
.order-wait{margin:20px 0 0;padding:14px 16px;border-radius:12px;background:#1e293b;
  border:1px solid #475569;color:#cbd5e1;font-size:0.94rem;font-weight:700;text-align:center}
button.claim{display:block;width:100%;margin:20px 0 0;padding:15px 18px;border:0;
  border-radius:12px;background:#2563eb;color:#fff;font-size:0.98rem;font-weight:700;
  cursor:pointer;font-family:inherit}
button.claim:hover{background:#1d4ed8}
button.claim:disabled{background:#334155;color:#94a3b8;cursor:not-allowed}
.msg{margin:14px 0 0;font-size:0.9rem;min-height:1.2em}
.msg.ok{color:#6ee7b7}
.msg.err{color:#fca5a5}
.links{margin:26px 0 0;font-size:0.88rem}
.links a{color:#93c5fd}
.blocker{margin:14px 0 0;font-size:0.84rem;color:#fca5a5}
`;

function shell({ title, inner }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap"><div class="card">
${inner}
</div></div>
</body>
</html>`;
}

/**
 * クーポンのブロック（休止ページとクーポンページで共用）。
 * 取得済みなら CTA を出さない＝**二重取得させない**（サーバー側でも冪等に弾く）。
 */
function couponBlock(view) {
  const v = view || {};
  const rows = [];
  rows.push(`<p class="coupon-name">${escapeHtml(v.name)}</p>`);
  rows.push(`<p class="coupon-desc">${escapeHtml(v.description)}</p>`);
  // 割引の中身を**最初に**出す（何が得なのかが一目で分かるように）
  if (v.discountText) rows.push(`<p class="coupon-benefit">${escapeHtml(v.discountText)}</p>`);
  if (v.priceText) rows.push(`<p class="coupon-price">${escapeHtml(v.priceText)}</p>`);
  rows.push(v.claimed ? '<span class="state held">取得済み</span>' : '<span class="state none">未取得</span>');
  rows.push('<dl>');
  if (v.claimed) {
    const at = formatClaimedAtJst(v.claimedAtIso);
    if (at) rows.push(`<dt>取得日時</dt><dd>${escapeHtml(at)}</dd>`);
  }
  rows.push(`<dt>ご利用時期</dt><dd>${escapeHtml(v.usableNote)}</dd>`);
  // 有効期限は**未確定**。日付を作らずそう伝える
  rows.push(`<dt>有効期限</dt><dd>${escapeHtml(v.expiryText)}</dd>`);
  if (v.paused) rows.push('<dt>現在の受付状況</dt><dd>新規受付を休止しております</dd>');
  rows.push('</dl>');
  if (v.claimed) {
    rows.push('<p class="note">既に取得済みのため、あらためてお手続きいただく必要はございません。</p>');
  }
  return `<div class="coupon">${rows.join('\n')}</div>`;
}

/** 取得ボタン + 送信スクリプト（取得できるときだけ描画する） */
function claimForm({ source, storageReady }) {
  const disabled = storageReady === false ? ' disabled' : '';
  const blocker = storageReady === false
    ? '<p class="blocker">ただいま取得のお手続きを承れません。'
      + 'お手数ですが、時間をおいて再度お試しください。</p>'
    : '';
  return `<button type="button" class="claim" id="claimBtn"${disabled}>${escapeHtml(claimCtaLabel())}</button>
${blocker}
<p class="msg" id="claimMsg" role="status" aria-live="polite"></p>
<script>
(function(){
  var btn=document.getElementById('claimBtn');
  var msg=document.getElementById('claimMsg');
  if(!btn) return;
  btn.addEventListener('click', function(){
    btn.disabled=true; msg.className='msg'; msg.textContent='お手続き中です…';
    fetch(${JSON.stringify(COUPON_API_PATH)},{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'same-origin',
      body:JSON.stringify({source:${JSON.stringify(source)}})
    }).then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {s:r.status,j:j};});})
      .then(function(o){
        if(o.s===200&&o.j&&o.j.claimed===true){
          msg.className='msg ok';
          msg.textContent=${JSON.stringify(`${describeCouponDiscount()} クーポンを取得しました。募集再開時にご利用いただけます。`)};
          setTimeout(function(){location.href=${JSON.stringify(COUPON_PAGE_PATH)};},1200);
          return;
        }
        btn.disabled=false; msg.className='msg err';
        msg.textContent='ただいま取得できませんでした。お手数ですが時間をおいてお試しください。';
      })
      .catch(function(){
        btn.disabled=false; msg.className='msg err';
        msg.textContent='通信に失敗しました。お手数ですが時間をおいてお試しください。';
      });
  });
})();
</script>`;
}

/**
 * 受付休止ページ（`/premium-plus/` / `/premium-plus-v2/` の直 URL で返す本体）。
 *
 * @param {{ coupon: object, source?: string }} input `coupon` は describeCouponForMember の戻り値
 */
export function renderPauseNoticeHtml({ coupon, source = 'pause-notice' } = {}) {
  const v = coupon || {};
  const parts = [];
  parts.push(`<h1>${escapeHtml(PAUSE_NOTICE_COPY.title)}</h1>`);
  parts.push(`<p class="lead">${escapeHtml(PAUSE_NOTICE_COPY.lead)}</p>`);
  parts.push(`<p>${escapeHtml(PAUSE_NOTICE_COPY.body)}</p>`);
  parts.push(`<p>${escapeHtml(PAUSE_NOTICE_COPY.couponLead)}</p>`);
  parts.push(`<p class="benefit-head">${escapeHtml(benefitHeadline())}</p>`);
  if (!v.claimed) parts.push(`<p>${escapeHtml(PAUSE_NOTICE_COPY.couponAsk)}</p>`);
  parts.push(couponBlock(v));
  if (v.showClaimCta) {
    parts.push(claimForm({ source, storageReady: v.storageReady }));
  }
  parts.push(orderCtaBlock(v.orderCta));
  parts.push(`<p class="links"><a href="${escapeHtml(COUPON_PAGE_PATH)}">取得済みクーポンを確認する</a></p>`);
  return shell({ title: PAUSE_NOTICE_COPY.title, inner: parts.join('\n') });
}

/**
 * クーポンページ（`/premium-plus-coupon/`）。**本人の状態しか描画しない**。
 *
 * @param {{ coupon: object, source?: string }} input
 */
export function renderCouponPageHtml({ coupon, source = 'coupon-page' } = {}) {
  const v = coupon || {};
  const parts = [];
  parts.push(`<h1>${escapeHtml(COUPON_PAGE_COPY.title)}</h1>`);
  parts.push(`<p class="lead">${escapeHtml(COUPON_PAGE_COPY.lead)}</p>`);
  parts.push(couponBlock(v));
  // ⚠️ 使ったかどうかは保有（Customers 3 列）では分からない。呼び出し側が
  //    予約台帳から解いた `usage` を渡す。使用済みなら**取得も申込も出さない**。
  const usage = v.usage || {};
  if (usage.note) parts.push(`<p class="usage-note">${escapeHtml(usage.note)}</p>`);
  if (v.showClaimCta && usage.blocksOrder !== true) {
    parts.push(claimForm({ source, storageReady: v.storageReady }));
  }
  if (usage.blocksOrder !== true) parts.push(orderCtaBlock(v.orderCta));
  return shell({ title: COUPON_PAGE_COPY.title, inner: parts.join('\n') });
}

/**
 * 申込導線（主 CTA）。
 * ⚠️ **購入できないときはリンクにしない**（押せる購入 CTA を偽装しない）。
 */
function orderCtaBlock(cta) {
  const c = cta || {};
  if (c.show !== true) return '';
  if (c.purchasable === true) {
    return `<a class="order-cta" href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`;
  }
  return `<p class="order-wait">${escapeHtml(c.label)}</p>`
    + (c.note ? `<p class="note">${escapeHtml(c.note)}</p>` : '');
}

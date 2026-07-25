/**
 * premiumPlusReceiptCardView.js — 投票内容照会そっくりカードの HTML 生成（純粋・Node/SSR/ブラウザ安全）
 *
 * 本番カード `PremiumPlusReceiptCardV2.astro` の frontmatter 正規化 + マークアップを **1:1 で移植**した
 * 純関数。管理画面 /admin/premium-plus-results/ のライブプレビューが本番と同じ DOM/CSS で描画されるよう
 * 共有する（CSS は src/styles/premiumPlusReceiptCard.css）。
 *
 * ドリフト検知: premiumPlusReceiptCardView.guard.test.mjs が、本レンダラ出力に本番コンポーネントと
 * 同じ主要クラス/文言（pp-evi / vref spat / vref jra / 受付番号 / 投票金額 …）が含まれることを検査する。
 *
 * 入力は deriveCard() 形状（premiumPlusResults.js）。中央=jra / 南関=spat4 の両方を描画する。
 * 文字列フィールド（会場・レース名・受付番号・受付日時）は esc() で HTML エスケープ。
 */

const PP_WD = ['日', '月', '火', '水', '木', '金', '土'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { full: '', spat: '', short: '', wd: '' };
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const wd = PP_WD[new Date(Date.UTC(y, mo - 1, day)).getUTCDay()];
  return {
    full: `${y}年 ${mo}月${day}日(${wd})`,
    spat: `${y}年${String(mo).padStart(2, '0')}月${String(day).padStart(2, '0')}日`,
    short: `${mo}/${day}`,
    wd,
  };
}

// 手入力由来（"20260723 15:11" / "YYYY-MM-DD HH:MM" 等）も年月日へ正規化。空なら開催日にフォールバック。
function fmtReceiptAt(raw, fallbackSpat) {
  const s = String(raw || '').trim();
  if (!s) return fallbackSpat;
  if (/年.*月.*日/.test(s)) return s;
  const m = s.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})(?:[ T]+(\d{1,2}:\d{2}))?/);
  return m ? `${m[1]}年${m[2]}月${m[3]}日${m[4] ? ' ' + m[4] : ''}` : s;
}

const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');
const jyen = (n) => Number(n || 0).toLocaleString('ja-JP') + '円';
const toInts = (a) => (Array.isArray(a) ? a : []).map((x) => Number(x)).filter(Number.isFinite);
const pad2 = (n) => { const v = Number(n) || 0; return v < 10 ? `0${v}` : `${v}`; };

/**
 * card（deriveCard 形状）を投票内容照会そっくりカードの HTML 文字列にする。
 * PremiumPlusReceiptCardV2.astro と同一の正規化・分岐・マークアップ。
 */
export function renderReceiptCardHtml(card) {
  const c = card || {};

  // --- 防御的正規化（コンポーネントと同一） ---
  const unitStake = Number(c.unitStake) > 0 ? Number(c.unitStake) : 1000;
  const service = c.service === 'jra' ? 'jra' : 'spat4';
  const isHit = !!c.isHit;
  const first = toInts(c.first);
  const second = toInts(c.second);
  const third = toInts(c.third);
  const points = Number.isFinite(Number(c.points)) ? Number(c.points)
    : first.length * second.length * third.length;
  const stake = Number(c.stake) >= 0 ? Number(c.stake) : points * unitStake;
  const payout = isHit && Number(c.payout) >= 0 ? Number(c.payout) : 0;
  const firstPad = Array.isArray(c.firstPad) && c.firstPad.length ? c.firstPad : first.map(pad2);
  const secondPad = Array.isArray(c.secondPad) && c.secondPad.length ? c.secondPad : second.map(pad2);
  const thirdPad = Array.isArray(c.thirdPad) && c.thirdPad.length ? c.thirdPad : third.map(pad2);
  const jd = fmtDate(c.date);
  const venue = typeof c.venue === 'string' ? c.venue : '';
  const raceNumber = c.raceNumber != null ? c.raceNumber : '';
  const raceLabel = (typeof c.raceLabel === 'string' && c.raceLabel) ? c.raceLabel : `${venue}${raceNumber ? `${raceNumber}R` : ''}`.trim();
  const raceName = typeof c.raceName === 'string' ? c.raceName : '';
  const receiptNo = typeof c.receiptNo === 'string' ? c.receiptNo.trim() : '';
  const receiptAtDisplay = fmtReceiptAt(c.receiptAt, jd.spat);
  const unitPayout = Number(c.unitPayout) > 0 ? Number(c.unitPayout) : payout;

  const winner = String(c.winnerCombo || c.hitCombo || '');
  const wArr = winner.split(/[^0-9]+/).map((x) => parseInt(x, 10)).filter(Number.isFinite);
  const w1 = wArr[0], w2 = wArr[1], w3 = wArr[2];
  const circuitCls = service === 'jra' ? 'ch' : 'nk';
  const circuitLabel = service === 'jra' ? '中央' : '南関';

  const headBadge = isHit
    ? `<span class="pp-badge hit">✅ 的中 ${esc(yen(payout))}</span>`
    : `<span class="pp-badge miss">× 不的中</span>`;

  const firstChip = `<span class="${isHit && first[0] === w1 ? 'pp-num axis win' : 'pp-num axis'}">${first[0] != null ? first[0] : ''}</span>`;
  const secondChips = second.map((n) => `<span class="${isHit && n === w2 ? 'pp-num win' : 'pp-num'}">${n}</span>`).join('');
  const thirdChips = third.map((n) => `<span class="${isHit && n === w3 ? 'pp-num win' : 'pp-num'}">${n}</span>`).join('');

  const right = service === 'spat4'
    ? `<div class="vref spat">
        <div class="chrome"></div>
        <table class="recv"><tbody>
          ${receiptNo ? `<tr><td>受付番号</td><td>${esc(receiptNo)}</td></tr>` : ''}
          <tr><td>受付日時</td><td>${esc(receiptAtDisplay)}</td></tr>
          <tr><td>購入件数</td><td>1件</td></tr>
        </tbody></table>
        <table class="bet"><tbody>
          <tr><th>レース/式別</th><th>馬/組番</th><th>投票金額</th></tr>
          <tr>
            <td class="c1">${esc(jd.spat)}<br><span class="race">${esc(raceLabel)}</span><br>三連単<br>フォーメーション</td>
            <td class="c2"><b>1着:</b>${first.join(', ')}<br><b>2着:</b>${second.join(', ')}<br><b>3着:</b>${third.join(', ')}</td>
            <td class="c3">(各${unitStake.toLocaleString()}円)<br>${stake.toLocaleString()}円<br>${isHit ? `<span class="hit">的中 ${payout.toLocaleString()}円</span>` : `<span class="miss">不的中</span>`}</td>
          </tr>
        </tbody></table>
        <div class="notes"><p>※前日発売で投票した結果は、レース開催日の投票内容照会にてご確認ください。</p></div>
      </div>`
    : `<div class="vref jra">
        <div class="chrome"></div>
        <div class="r2"><span class="nav">◀</span><div class="c"><div class="d">${esc(jd.full)}</div>${receiptNo ? `<div class="n">受付番号：${esc(receiptNo)}</div>` : ''}</div><span class="nav">▶</span></div>
        <div class="hl"><div class="hlcard">
          <div class="hlrow"><span>合計購入金額</span><span>${esc(jyen(stake))}</span></div>
          <div class="hlrow back"><span>合計払戻金額</span><span>${esc(jyen(isHit ? payout : 0))}</span></div>
        </div></div>
        <div class="close">すべて閉じる<span class="acc">▲</span></div>
        <div class="vh">001）${esc(venue)}（${esc(jd.wd)}）${esc(raceNumber)}R 3連単フォーメーション
          <div class="l2">${isHit ? `<span class="hit">的中</span>` : ''}<span>購入金額:${esc(jyen(stake))}</span><span class="${isHit ? 'pay' : ''}">払戻金額:${esc(jyen(isHit ? payout : 0))}</span></div>
        </div>
        <div class="dt">
          <div class="row"><div class="lc">購入馬/組番</div><div class="rc"><div class="uma">
            <div><span class="pf">1着：</span><span>${esc(firstPad.join(','))}</span></div>
            <div><span class="pf">2着：</span><span>${esc(secondPad.join(','))}</span></div>
            <div><span class="pf">3着：</span><span>${esc(thirdPad.join(','))}</span></div>
          </div></div></div>
          <div class="row"><div class="lc">購入金額</div><div class="rc"><div>各:${unitStake.toLocaleString()}円</div><div>計:${stake.toLocaleString()}円</div></div></div>
          ${isHit && winner ? `<div class="row"><div class="lc">払戻単価</div><div class="rc split"><span>${esc(winner)}</span><span>${unitPayout.toLocaleString()}円</span></div></div>` : ''}
          <div class="row"><div class="lc">払戻/返還金額</div><div class="${isHit ? 'rc red' : 'rc'}">${esc(jyen(isHit ? payout : 0))}</div></div>
        </div>
      </div>`;

  return `<div class="pp-evi">
    <div class="pp-evi-head">
      <span class="pp-date">${esc(jd.short)}（${esc(jd.wd)}）</span>
      <span class="pp-circuit ${circuitCls}">${circuitLabel}</span>
      <span class="pp-race">${esc(raceLabel)}</span>
      ${raceName ? `<span class="pp-rname">${esc(raceName)}</span>` : ''}
      <span class="pp-spacer"></span>
      <span class="pp-badge bet">三連単F・${points}点</span>
      ${headBadge}
    </div>
    <div class="pp-evi-body">
      <div class="pp-left">
        <div>
          <div class="pp-flabel">配信した買い目</div>
          <div class="pp-form">
            <div class="pp-fcol"><div class="pp-ch">1着</div><div class="pp-chips">${firstChip}</div></div>
            <div class="pp-arrow">→</div>
            <div class="pp-fcol">
              <div class="pp-ch">2着</div>
              <div class="pp-chips">${secondChips}</div>
              <div class="pp-ch" style="margin-top:.5rem">3着</div>
              <div class="pp-chips">${thirdChips}</div>
            </div>
          </div>
        </div>
        <div class="pp-meta">
          <div class="pp-mi"><span>投票額</span><b>${esc(yen(stake))}</b></div>
          <div class="pp-mi"><span>結果</span><b>${isHit ? esc(winner) : '—'}</b></div>
          <div class="pp-mi"><span>払戻</span><b class="${isHit ? 'pay' : ''}">${isHit ? esc(yen(payout)) : '—'}</b></div>
        </div>
      </div>
      <div class="pp-right">${right}</div>
    </div>
  </div>`;
}

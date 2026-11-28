import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEmailUtmToHtml, NEWSLETTER_UTM_CAMPAIGN } from './emailHtmlUtm.js';

const UTM = 'utm_source=ak_mail&amp;utm_medium=email&amp;utm_campaign=ak_newsletter';

test('AK へのリンクに newsletter の utm を付ける', () => {
  const out = addEmailUtmToHtml('<a href="https://analytics.keiba.link/free/">無料予想</a>');
  assert.equal(out, `<a href="https://analytics.keiba.link/free/?${UTM}">無料予想</a>`);
  assert.equal(NEWSLETTER_UTM_CAMPAIGN, 'ak_newsletter');
});

test('既存の query は保ち、&amp; で書かれた href も扱う', () => {
  const out = addEmailUtmToHtml("<a href='https://analytics.keiba.link/pricing/?a=1&amp;b=2'>x</a>");
  assert.equal(out, `<a href='https://analytics.keiba.link/pricing/?a=1&amp;b=2&amp;${UTM}'>x</a>`);
});

test('既に utm がある・外部・配信停止・差し替え印・mailto は変えない', () => {
  const html = [
    '<a href="https://analytics.keiba.link/x?utm_source=other">a</a>',
    '<a href="https://example.com/">b</a>',
    '<a href="https://analytics.keiba.link/unsubscribe?token=t">c</a>',
    '<a href="{{offerUrl}}">d</a>',
    '<a href="mailto:info@example.com">e</a>',
    '<img src="https://analytics.keiba.link/img.png">',
  ].join('\n');
  assert.equal(addEmailUtmToHtml(html), html);
});

test('本文の文字はリンク以外変えない・複数リンクをすべて処理', () => {
  const html = '<p>本文 https://analytics.keiba.link/ そのまま</p><a href="https://analytics.keiba.link/">1</a><a href="https://analytics.keiba.link/archive/">2</a>';
  const out = addEmailUtmToHtml(html, 'ak_newsletter');
  assert.ok(out.startsWith('<p>本文 https://analytics.keiba.link/ そのまま</p>'));
  assert.equal((out.match(/utm_campaign=ak_newsletter/g) || []).length, 2);
});

test('文字列以外・空はそのまま', () => {
  assert.equal(addEmailUtmToHtml(''), '');
  assert.equal(addEmailUtmToHtml(undefined), undefined);
});

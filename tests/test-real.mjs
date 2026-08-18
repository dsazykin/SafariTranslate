import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { run } from './harness.mjs';

// Real-world markup, fetched once and cached rather than committed.
const FIXTURE = new URL('./fixtures/page.html', import.meta.url);
if (!fs.existsSync(FIXTURE)) {
  fs.mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
  console.log('fetching fixture: fr.wikipedia.org/wiki/Chat');
  const res = await fetch('https://fr.wikipedia.org/wiki/Chat', {
    headers: { 'User-Agent': 'SafariTranslate-tests/1.0' }
  });
  if (!res.ok) throw new Error(`fixture fetch failed: HTTP ${res.status}`);
  fs.writeFileSync(FIXTURE, await res.text());
}

// Take a realistic slice of the article: intro plus a few sections.
const raw = fs.readFileSync(FIXTURE, 'utf8');
const doc = new JSDOM(raw).window.document;
const content = doc.querySelector('#mw-content-text');
const kept = [];
let chars = 0;
for (const el of content.querySelectorAll('p, h2, h3, ul, table')) {
  if (chars > 3000) break;
  if (el.closest('table') && el.tagName !== 'TABLE') continue;  // avoid duplicating table innards
  const text = el.textContent.trim();
  if (text.length < 20) continue;
  kept.push(el.outerHTML);
  chars += text.length;
}
const html = `<body><div id="root">${kept.join('\n')}</div></body>`;

const { window, dispatch, calls, errors, body } = await run(html, { target: 'en' });
const d = window.document;

const linksBefore = [...d.querySelectorAll('a')].map(a => a.getAttribute('href'));
const imgsBefore  = d.querySelectorAll('img').length;
const textBefore  = d.getElementById('root').textContent;
const htmlBefore  = body();

const t0 = Date.now();
await dispatch({ type: 'translatePage', target: 'en' });
await new Promise(r => setTimeout(r, 12000));
const elapsed = Date.now() - t0;

const linksAfter = [...d.querySelectorAll('a')].map(a => a.getAttribute('href'));
const textAfter  = d.getElementById('root').textContent;

console.log(`source chars      : ${textBefore.length}`);
console.log(`batches sent      : ${calls.length} (${calls.flat().length} segments)`);
console.log(`transient errors  : ${errors.length}`);
console.log(`elapsed           : ${(elapsed / 1000).toFixed(1)}s`);
console.log(`state             : ${JSON.stringify(await dispatch({ type: 'getState' }))}`);
console.log('');
console.log('SAMPLE BEFORE:', textBefore.slice(0, 220).replace(/\s+/g, ' '));
console.log('SAMPLE AFTER :', textAfter.slice(0, 220).replace(/\s+/g, ' '));
console.log('');

const checks = [
  ['text actually changed',      textBefore !== textAfter],
  ['no links lost',              linksAfter.length === linksBefore.length],
  ['link targets identical',     JSON.stringify(linksAfter) === JSON.stringify(linksBefore)],
  ['no images lost',             d.querySelectorAll('img').length === imgsBefore],
  ['text length within 40%',     Math.abs(textAfter.length - textBefore.length) / textBefore.length < 0.4],
  ['no stray <x markers',        !/<\s*\/?\s*x\d+\s*\/?\s*>/.test(body()) && !/&lt;x\d/.test(body())],
];
await dispatch({ type: 'showOriginal' });
checks.push(['restore is exact', body() === htmlBefore]);

let bad = 0;
for (const [label, ok] of checks) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); }
console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');

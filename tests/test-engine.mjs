import { run } from './harness.mjs';

const CASES = [
  { name: 'inline reorder (de)', target: 'de',
    html: `<p id=t>You have <b>3 new messages</b> waiting in your <a href="/inbox" id=lnk>inbox</a>.</p>` },
  { name: 'nested inline (ja)', target: 'ja',
    html: `<p id=t>Click <a href="/x"><b>here</b></a> to read our <em>privacy policy</em> now.</p>` },
  { name: 'block siblings keep order', target: 'es',
    html: `<div id=t>Intro text here.<div>Nested block content.</div>Trailing text follows.</div>` },
  { name: 'skips code/pre', target: 'es',
    html: `<div><p>Run this command now.</p><pre id=keep>const x = "hello world";</pre><code id=keep2>npm install</code></div>` },
  { name: 'br self-closing', target: 'ru',
    html: `<p id=t>First line here<br>Second line with <b>bold text</b> inside</p>` },
  { name: 'notranslate respected', target: 'fr',
    html: `<div><p>Translate this sentence.</p><p class="notranslate" id=keep>Do not touch this.</p><p translate="no" id=keep3>Leave me alone.</p></div>` },
  { name: 'attributes + entities', target: 'es',
    html: `<p id=t title="Hover for details">It's a &quot;quoted&quot; word &amp; more</p>` },
];

let failures = 0;
for (const c of CASES) {
  const { window, dispatch, body, errors } = await run(`<body>${c.html}</body>`, { target: c.target });
  const doc = window.document;

  // Hold references to nodes that must survive translation by identity.
  const link = doc.getElementById('lnk');
  const before = body();

  await dispatch({ type: 'translatePage', target: c.target });
  await new Promise(r => setTimeout(r, 2500));
  const after = body();

  console.log(`\n=== ${c.name} (-> ${c.target}) ===`);
  console.log('  before:', before.replace(/\s+/g, ' ').trim().slice(0, 160));
  console.log('  after :', after.replace(/\s+/g, ' ').trim().slice(0, 160));

  // Invariants
  const checks = [];
  if (link) checks.push(['link node identity preserved', doc.getElementById('lnk') === link]);
  if (link) checks.push(['href intact', link.getAttribute('href') === '/inbox']);
  for (const id of ['keep', 'keep2', 'keep3']) {
    const el = doc.getElementById(id);
    if (el) checks.push([`#${id} untouched`, before.includes(el.textContent) && after.includes(el.textContent)]);
  }
  checks.push(['changed', before !== after]);

  // Restore must return the DOM byte-for-byte.
  await dispatch({ type: 'showOriginal' });
  checks.push(['restore is exact', body() === before]);

  if (errors.length) console.log("  (transient API errors, retried):", errors.join("; "));
  for (const [label, ok] of checks) {
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);

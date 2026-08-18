import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import { PROVIDERS } from '../extension/src/providers.js';

const SRC = new URL('../extension/src/content.js', import.meta.url);
const provider = PROVIDERS.googleFree;

export async function run(html, { target = 'de' } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const listeners = [];
  const calls = [];
  const errors = [];

  const api = {
    runtime: {
      lastError: null,
      onMessage: { addListener: fn => listeners.push(fn) },
      async sendMessage(msg, cb) {
        const reply = async () => {
          if (msg.type === 'pageConfig') {
            return { target, autoTranslate: false, showBanner: false, neverLangs: [], policy: null, names: {} };
          }
          if (msg.type === 'limits') return { maxChars: provider.maxChars, maxItems: provider.maxItems };
          if (msg.type === 'translate') {
            calls.push(msg.texts);
            let lastErr;
            for (let i = 0; i < 4; i++) {
              try {
                return await provider.translate({ texts: msg.texts, source: msg.source, target: msg.target });
              } catch (e) {
                lastErr = e;
                errors.push(e.message);
                await new Promise(r => setTimeout(r, 600 * 2 ** i));
              }
            }
            throw lastErr;
          }
          if (msg.type === 'detect') return { lang: await provider.detect({ text: msg.text }) };
          if (msg.type === 'progress') return { ok: true };
          return { ok: true };
        };
        const p = reply();
        if (cb) p.then(cb, e => cb({ error: e.message }));
        return p;
      }
    }
  };
  window.browser = api;
  window.chrome = api;

  // jsdom has no layout engine; give every element a plausible box so the
  // viewport-ordering pass behaves like it does in a real browser.
  window.Element.prototype.getBoundingClientRect = function () {
    return { top: 100, left: 0, width: 600, height: 40, bottom: 140, right: 600 };
  };

  const script = fs.readFileSync(SRC, 'utf8');
  window.eval(script);

  const dispatch = (msg) => new Promise(res => {
    for (const fn of listeners) {
      const done = fn(msg, {}, res);
      if (!done) break;
    }
  });

  return { window, dom, dispatch, calls, errors, body: () => window.document.body.innerHTML };
}

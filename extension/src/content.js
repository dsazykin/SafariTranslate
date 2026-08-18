/*
 * SafariTranslate content script.
 *
 * Translation happens per "unit": the innermost block-level element containing
 * text. A unit is serialised into a single string with its inline children
 * replaced by <xN> markers, so the engine sees a whole sentence in context
 * rather than disconnected fragments:
 *
 *   <p>The <b>quick</b> fox <a href=#>jumps</a></p>
 *     -> "The <x0>quick</x0> fox <x1>jumps</x1>"
 *     -> "Der <x0>schnelle</x0> Fuchs <x1>springt</x1>"
 *
 * Engines reorder those markers freely (German and Japanese routinely move them),
 * so reconstruction rebuilds the unit's child list in the translated order,
 * *moving* the original element nodes rather than cloning them. Event listeners,
 * hrefs and attributes therefore survive translation intact.
 */
(() => {
  'use strict';
  if (window.__safariTranslateLoaded) return;
  window.__safariTranslateLoaded = true;

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const IS_TOP = window.top === window;

  const INLINE = new Set(['A','ABBR','B','BDI','BDO','BIG','CITE','DATA','DEL','DFN','EM','FONT',
    'I','INS','LABEL','MARK','NOBR','Q','RP','RT','RUBY','S','SMALL','SPAN','STRIKE','STRONG',
    'SUB','SUP','TIME','TT','U','WBR']);
  // Never descend into these: content is code, markup-sensitive, or not prose.
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','SELECT','OPTION','CODE',
    'PRE','KBD','SAMP','VAR','SVG','MATH','CANVAS','TEMPLATE','IFRAME','OBJECT','EMBED','AUDIO',
    'VIDEO','MAP','AREA','TRACK','SOURCE','PARAM','META','LINK','HEAD','TITLE']);
  const HAS_LETTER = /\p{L}/u;
  const ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];

  const UI_ATTR = 'data-safari-translate-ui';

  // ---- state -------------------------------------------------------------
  const state = {
    status: 'idle',        // idle | translating | translated | error
    source: null,
    target: null,
    error: null,
    pending: 0,
    done: 0
  };
  const snapshots = new Map();       // unit element -> snapshot tree
  const translatedUnits = new WeakSet();
  const attrOriginals = new Map();   // element -> { attr: originalValue }
  let originalTitle = null;
  let suppress = 0;                  // >0 while we are the one mutating the DOM
  let mutationObserver = null;
  let mutationTimer = null;
  let generation = 0;                // bumped on restore, to drop in-flight work

  // ---- escaping ----------------------------------------------------------
  const escapeText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function unescapeText(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const key = ent.toLowerCase();
      return key in NAMED ? NAMED[key] : m;
    });
  }

  // ---- eligibility -------------------------------------------------------
  function isSkipped(el) {
    if (SKIP.has(el.tagName)) return true;
    if (el.hasAttribute(UI_ATTR)) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    const ce = el.getAttribute('contenteditable');
    if (ce !== null && ce !== 'false') return true;
    return false;
  }

  const isInline = el => INLINE.has(el.tagName);
  const isTranslatableText = node =>
    node.nodeType === Node.TEXT_NODE && HAS_LETTER.test(node.nodeValue);

  // True if this subtree holds any text worth sending.
  function hasText(el) {
    for (const child of el.childNodes) {
      if (isTranslatableText(child)) return true;
      if (child.nodeType === Node.ELEMENT_NODE && !isSkipped(child) && isInline(child) && hasText(child)) {
        return true;
      }
    }
    return false;
  }

  // ---- collection --------------------------------------------------------
  // Walk `root` and return the innermost block elements that directly contain text.
  function collectUnits(root) {
    const units = [];
    const seen = new Set();
    const roots = [root];

    // Pick up open shadow roots too - common on modern component-based sites.
    const collectShadow = node => {
      const all = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of all) if (el.shadowRoot) roots.push(el.shadowRoot);
    };
    collectShadow(root);

    for (let r = 0; r < roots.length; r++) {
      const walker = document.createTreeWalker(roots[r], NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!isTranslatableText(node)) return NodeFilter.FILTER_REJECT;
          for (let p = node.parentElement; p; p = p.parentElement) {
            if (isSkipped(p)) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        let unit = node.parentElement;
        while (unit && isInline(unit) && unit.parentElement) unit = unit.parentElement;
        if (!unit || unit === document.documentElement) continue;
        if (translatedUnits.has(unit) || seen.has(unit)) continue;
        seen.add(unit);
        units.push(unit);
      }
      if (r > 0) collectShadow(roots[r]);
    }
    return units;
  }

  // ---- serialisation -----------------------------------------------------
  // Turn a unit into "text with <xN> markers" plus the element list the markers
  // refer to. `recursed` records which of those we descended into, so restore
  // knows which children were rearranged.
  function serialize(unit) {
    const elements = [];
    const recursed = new Set();
    let out = '';

    const walk = el => {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += escapeText(child.nodeValue);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const idx = elements.length;
          elements.push(child);
          // Descend only into inline elements that actually carry text; anything
          // else becomes an opaque self-closing marker that keeps its position.
          if (!isSkipped(child) && isInline(child) && hasText(child)) {
            recursed.add(child);
            out += `<x${idx}>`;
            walk(child);
            out += `</x${idx}>`;
          } else {
            out += `<x${idx}/>`;
          }
        }
      }
    };
    walk(unit);
    return { text: out.trim(), elements, recursed };
  }

  // ---- marker parsing ----------------------------------------------------
  function parseMarkers(str) {
    const root = { children: [] };
    const stack = [root];
    const re = /<\s*(\/?)\s*x\s*(\d+)\s*(\/?)\s*>/g;
    let last = 0, m;

    const pushText = value => {
      if (value) stack[stack.length - 1].children.push({ type: 'text', value });
    };

    while ((m = re.exec(str))) {
      const [full, closing, idxStr, selfClosing] = m;
      if (m.index > last) pushText(str.slice(last, m.index));
      last = m.index + full.length;
      const idx = Number(idxStr);

      if (closing) {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].idx === idx) { stack.length = i; break; }
        }
      } else if (selfClosing) {
        stack[stack.length - 1].children.push({ type: 'el', idx, children: null });
      } else {
        const node = { type: 'el', idx, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      }
    }
    if (last < str.length) pushText(str.slice(last));
    return root.children;
  }

  // ---- snapshot / restore ------------------------------------------------
  function snapshot(unit, recursed) {
    const take = el => ({
      node: el,
      children: Array.from(el.childNodes).map(child =>
        child.nodeType === Node.ELEMENT_NODE && recursed.has(child)
          ? take(child)
          : { node: child, text: child.nodeType === Node.TEXT_NODE ? child.nodeValue : null }
      )
    });
    return take(unit);
  }

  function restoreSnapshot(snap) {
    const put = entry => {
      const el = entry.node;
      if (!entry.children) {
        if (entry.text !== null && entry.text !== undefined) el.nodeValue = entry.text;
        return el;
      }
      const frag = document.createDocumentFragment();
      for (const child of entry.children) frag.appendChild(put(child));
      el.replaceChildren(frag);
      return el;
    };
    put(snap);
  }

  // ---- applying a translation -------------------------------------------
  function applyTranslation(unit, translated, { elements, recursed }) {
    const tokens = parseMarkers(translated);
    const used = new Set();

    const build = (nodes) => {
      const frag = document.createDocumentFragment();
      for (const token of nodes) {
        if (token.type === 'text') {
          frag.appendChild(document.createTextNode(unescapeText(token.value)));
          continue;
        }
        const el = elements[token.idx];
        // Engine invented a marker index we never sent - drop it rather than throw.
        if (!el || used.has(el)) continue;
        used.add(el);
        if (token.children && recursed.has(el)) {
          el.replaceChildren(build(token.children));
        }
        frag.appendChild(el);
      }
      return frag;
    };

    const frag = build(tokens);
    // Anything the engine dropped gets re-appended so no content disappears.
    for (const el of elements) {
      if (!used.has(el) && el.parentNode) frag.appendChild(el);
    }
    unit.replaceChildren(frag);
  }

  // ---- attribute + title translation ------------------------------------
  function collectAttrJobs(root) {
    const jobs = [];
    const scope = root.querySelectorAll ? root : document;
    for (const el of scope.querySelectorAll('*')) {
      if (isSkipped(el) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
      for (const attr of ATTRS) {
        const value = el.getAttribute(attr);
        if (!value || !HAS_LETTER.test(value)) continue;
        const saved = attrOriginals.get(el);
        if (saved && attr in saved) continue;   // already translated
        jobs.push({ el, attr, text: value });
      }
    }
    return jobs;
  }

  // ---- background messaging ---------------------------------------------
  function send(message) {
    return new Promise((resolve, reject) => {
      api.runtime.sendMessage(message, response => {
        const err = api.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (response && response.error) return reject(new Error(response.error));
        resolve(response);
      });
    });
  }

  // Order units by distance from the viewport so what the reader is looking at
  // lands first; the rest streams in behind it.
  function byViewportDistance(units) {
    const vh = window.innerHeight || 800;
    return units
      .map(unit => {
        let top = Infinity;
        try {
          const rect = unit.getBoundingClientRect();
          if (rect.width || rect.height) top = rect.top;
        } catch { /* detached */ }
        const distance = top >= 0 && top <= vh ? 0 : Math.abs(top);
        return { unit, distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .map(entry => entry.unit);
  }

  function makeBatches(items, maxChars, maxItems) {
    const batches = [];
    let batch = [], chars = 0;
    for (const item of items) {
      const len = item.text.length;
      if (batch.length && (batch.length >= maxItems || chars + len > maxChars)) {
        batches.push(batch);
        batch = []; chars = 0;
      }
      batch.push(item);
      chars += len;
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  // ---- main translate pass ----------------------------------------------
  async function translateRoot(root, { target, source }) {
    const myGeneration = generation;
    const units = byViewportDistance(collectUnits(root));

    const jobs = [];
    // The tab label is the single most visible string on the page, so translate
    // it first rather than letting it trail a few hundred paragraphs.
    if (IS_TOP && originalTitle === null && document.title && HAS_LETTER.test(document.title)) {
      originalTitle = document.title;
      jobs.push({ kind: 'title', text: document.title });
    }
    for (const unit of units) {
      const serialized = serialize(unit);
      if (!serialized.text || !HAS_LETTER.test(serialized.text)) continue;
      jobs.push({ kind: 'unit', unit, text: serialized.text, serialized });
    }
    for (const job of collectAttrJobs(root)) jobs.push({ kind: 'attr', ...job });
    if (!jobs.length) return { detected: null, count: 0 };

    const limits = await send({ type: 'limits' });
    const batches = makeBatches(jobs, limits.maxChars, limits.maxItems);
    state.pending += jobs.length;
    let detected = null;

    // A few batches in flight at once; enough to feel instant, not enough to
    // trip the free endpoint's rate limiting.
    const CONCURRENCY = 4;
    let cursor = 0;
    const runner = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        if (generation !== myGeneration) return;
        try {
          const res = await send({
            type: 'translate',
            texts: batch.map(j => j.text),
            source: source || 'auto',
            target
          });
          if (generation !== myGeneration) return;
          if (res.detected && !detected) detected = res.detected;

          suppress++;
          try {
            batch.forEach((job, i) => {
              const out = res.texts[i];
              if (typeof out !== 'string' || !out) return;
              if (job.kind === 'unit') {
                if (!job.unit.isConnected) return;
                snapshots.set(job.unit, snapshot(job.unit, job.serialized.recursed));
                applyTranslation(job.unit, out, job.serialized);
                translatedUnits.add(job.unit);
              } else if (job.kind === 'attr') {
                const saved = attrOriginals.get(job.el) || {};
                saved[job.attr] = job.text;
                attrOriginals.set(job.el, saved);
                job.el.setAttribute(job.attr, unescapeText(out));
              } else if (job.kind === 'title') {
                document.title = unescapeText(out);
              }
            });
          } finally {
            suppress--;
          }
        } catch (err) {
          if (generation !== myGeneration) return;
          state.error = err.message;
        } finally {
          state.done += batch.length;
          state.pending -= batch.length;
          notifyProgress();
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runner));
    return { detected, count: jobs.length };
  }

  // ---- dynamic content ---------------------------------------------------
  function startObserving() {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver(records => {
      if (suppress > 0 || state.status !== 'translated') return;
      let relevant = false;
      for (const record of records) {
        if (record.type === 'characterData') { relevant = true; }
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute?.(UI_ATTR)) continue;
          relevant = true;
        }
        // A re-render inside a unit we already translated invalidates its snapshot.
        const target = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target : record.target.parentElement;
        for (let p = target; p; p = p.parentElement) {
          if (translatedUnits.has(p)) { translatedUnits.delete(p); snapshots.delete(p); break; }
        }
      }
      if (!relevant) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        translateRoot(document.body, { target: state.target, source: state.source })
          .catch(err => { state.error = err.message; });
      }, 400);
    });
    mutationObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  }

  function stopObserving() {
    mutationObserver?.disconnect();
    mutationObserver = null;
    clearTimeout(mutationTimer);
  }

  // ---- public actions ----------------------------------------------------
  async function translatePage({ target, source }) {
    if (state.status === 'translating') return;
    state.status = 'translating';
    state.error = null;
    state.target = target;
    state.source = source || null;
    state.done = 0;
    state.pending = 0;
    notifyProgress();
    hideBanner();

    if (IS_TOP) {
      // Reaches every frame in the tab; this frame's own copy is a no-op because
      // status is already 'translating'.
      send({ type: 'broadcastFrames', target, source: state.source }).catch(() => {});
    }

    try {
      const { detected } = await translateRoot(document.body, { target, source });
      if (detected && !state.source) state.source = detected;
      state.status = state.error ? 'error' : 'translated';
      if (state.status === 'translated') startObserving();
    } catch (err) {
      state.status = 'error';
      state.error = err.message;
    }
    notifyProgress();
  }

  function showOriginal() {
    generation++;                 // invalidate anything still in flight
    stopObserving();
    suppress++;
    try {
      for (const snap of snapshots.values()) {
        if (snap.node.isConnected) restoreSnapshot(snap);
      }
      for (const [el, attrs] of attrOriginals) {
        for (const [attr, value] of Object.entries(attrs)) el.setAttribute(attr, value);
      }
      if (originalTitle !== null) document.title = originalTitle;
    } finally {
      suppress--;
    }
    snapshots.clear();
    attrOriginals.clear();
    originalTitle = null;
    state.status = 'idle';
    state.done = 0;
    state.pending = 0;
    notifyProgress();
  }

  // ---- page language sniffing -------------------------------------------
  function sampleText(limit = 800) {
    const parts = [];
    let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!isTranslatableText(node)) return NodeFilter.FILTER_REJECT;
        for (let p = node.parentElement; p; p = p.parentElement) {
          if (isSkipped(p)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode()) && total < limit) {
      const text = node.nodeValue.trim();
      if (text.length < 12) continue;   // skip nav chrome and labels
      parts.push(text);
      total += text.length;
    }
    return parts.join(' ').slice(0, limit);
  }

  async function detectPageLanguage() {
    const text = sampleText();
    if (text.length < 24) return null;
    try {
      const res = await send({ type: 'detect', text });
      return res.lang || null;
    } catch {
      // Fall back to the document's own declaration.
      const declared = document.documentElement.lang;
      return declared ? declared.split('-')[0] : null;
    }
  }

  // ---- banner ------------------------------------------------------------
  let banner = null;
  function hideBanner() { banner?.remove(); banner = null; }

  function showBanner({ detectedName, targetName, target, source }) {
    if (!IS_TOP || banner) return;
    hideBanner();
    banner = document.createElement('div');
    banner.setAttribute(UI_ATTR, '');
    banner.className = 'st-banner';
    banner.innerHTML = `
      <span class="st-banner__text">Translate this page from <b></b> to <b></b>?</span>
      <button class="st-banner__btn st-banner__btn--primary" data-act="translate">Translate</button>
      <button class="st-banner__btn" data-act="always">Always</button>
      <button class="st-banner__btn" data-act="never">Never for this site</button>
      <button class="st-banner__close" data-act="dismiss" aria-label="Dismiss">&times;</button>`;
    const bolds = banner.querySelectorAll('.st-banner__text b');
    bolds[0].textContent = detectedName;
    bolds[1].textContent = targetName;

    banner.addEventListener('click', async event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'translate') { hideBanner(); translatePage({ target, source }); }
      else if (act === 'always') {
        await send({ type: 'setSitePolicy', policy: 'always' });
        hideBanner(); translatePage({ target, source });
      } else if (act === 'never') {
        await send({ type: 'setSitePolicy', policy: 'never' });
        hideBanner();
      } else hideBanner();
    });
    document.documentElement.appendChild(banner);
  }

  // ---- popup plumbing ----------------------------------------------------
  function notifyProgress() {
    try {
      const p = api.runtime.sendMessage({ type: 'progress', state: publicState() });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* worker asleep; the popup polls getState anyway */ }
  }
  const publicState = () => ({
    status: state.status,
    source: state.source,
    target: state.target,
    error: state.error,
    done: state.done,
    pending: state.pending
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'getState':
        sendResponse(publicState());
        return false;
      case 'translatePage':
        translatePage({ target: message.target, source: message.source });
        sendResponse({ ok: true });
        return false;
      case 'showOriginal':
        showOriginal();
        sendResponse({ ok: true });
        return false;
      case 'detectLanguage':
        detectPageLanguage().then(lang => sendResponse({ lang }));
        return true;
      default:
        return false;
    }
  });

  // ---- boot --------------------------------------------------------------
  async function boot() {
    // Subframes stay passive: one detection call per page, not one per ad iframe.
    // The top frame broadcasts to them once it decides to translate.
    if (!IS_TOP) return;

    let settings;
    try {
      settings = await send({ type: 'pageConfig' });
    } catch {
      return;    // background not ready; the popup can still drive us manually
    }
    if (!settings || settings.policy === 'never') return;

    const detected = await detectPageLanguage();
    if (!detected) return;
    state.source = detected;

    const target = settings.target;
    if (detected === target || settings.neverLangs.includes(detected)) return;

    if (settings.policy === 'always' || settings.autoTranslate) {
      translatePage({ target, source: detected });
    } else if (settings.showBanner && IS_TOP) {
      showBanner({
        detectedName: settings.names[detected] || detected,
        targetName: settings.names[target] || target,
        target,
        source: detected
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

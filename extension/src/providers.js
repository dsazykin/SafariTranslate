// Translation backends. Each provider takes an array of segments and returns an
// array of the same length, in the same order. Segments may contain <xN> markers
// standing in for inline elements; every provider must preserve them verbatim.

import { DEEPL_CODE, normalizeLang } from './langs.js';

class TranslateError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function httpError(res, body) {
  const snippet = String(body || '').slice(0, 200).replace(/\s+/g, ' ').trim();
  return new TranslateError(`HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`, {
    retryable: RETRYABLE_STATUS.has(res.status),
    status: res.status
  });
}

// ---------------------------------------------------------------------------
// Google (free, unofficial endpoint) - the same service Chrome's translator uses.
// No key. Responses come back either as ["text"] or [["text","detectedLang"]]
// depending on whether the source language was explicit, so parse tolerantly.
// ---------------------------------------------------------------------------
const googleFree = {
  id: 'googleFree',
  label: 'Google (free, no key)',
  needsKey: false,
  // GET request, so batches are bounded by URL length rather than by a quota.
  maxChars: 1500,
  maxItems: 40,

  async translate({ texts, source, target, signal }) {
    const url = new URL('https://translate.googleapis.com/translate_a/t');
    url.searchParams.set('client', 'dict-chrome-ex');
    url.searchParams.set('sl', source || 'auto');
    url.searchParams.set('tl', target);
    for (const t of texts) url.searchParams.append('q', t);

    const res = await fetch(url, { signal, headers: { Accept: '*/*' } });
    if (!res.ok) throw httpError(res, await res.text().catch(() => ''));

    const data = await res.json();
    if (!Array.isArray(data)) throw new TranslateError('Unexpected response shape');

    const out = data.map(item => (Array.isArray(item) ? item[0] : item));
    const detected = data.map(item => (Array.isArray(item) ? item[1] : null)).find(Boolean);

    if (out.length !== texts.length || out.some(t => typeof t !== 'string')) {
      throw new TranslateError(`Expected ${texts.length} segments, got ${out.length}`);
    }
    return { texts: out, detected: normalizeLang(detected) };
  },

  async detect({ text, signal }) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', 'en');
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text.slice(0, 900));

    const res = await fetch(url, { signal });
    if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
    const data = await res.json();
    return normalizeLang(Array.isArray(data) ? data[2] : null);
  }
};

// ---------------------------------------------------------------------------
// Google Cloud Translation API v2 - official, key + billing required.
// `format: html` makes the API treat our <xN> markers as markup to carry across.
// ---------------------------------------------------------------------------
const googleCloud = {
  id: 'googleCloud',
  label: 'Google Cloud Translation (API key)',
  needsKey: true,
  keyHint: 'AIza… - from a Google Cloud project with the Translation API enabled',
  maxChars: 20000,
  maxItems: 100,

  async translate({ texts, source, target, key, signal }) {
    if (!key) throw new TranslateError('No Google Cloud API key set');
    const body = { q: texts, target, format: 'html' };
    if (source && source !== 'auto') body.source = source;

    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
      { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) throw httpError(res, await res.text().catch(() => ''));

    const data = await res.json();
    const list = data?.data?.translations;
    if (!Array.isArray(list) || list.length !== texts.length) {
      throw new TranslateError(`Expected ${texts.length} segments, got ${list?.length ?? 0}`);
    }
    return {
      texts: list.map(t => t.translatedText),
      detected: normalizeLang(list.find(t => t.detectedSourceLanguage)?.detectedSourceLanguage)
    };
  },

  async detect({ text, key, signal }) {
    if (!key) throw new TranslateError('No Google Cloud API key set');
    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2/detect?key=${encodeURIComponent(key)}`,
      { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text.slice(0, 900) }) }
    );
    if (!res.ok) throw httpError(res, await res.text().catch(() => ''));
    const data = await res.json();
    return normalizeLang(data?.data?.detections?.[0]?.[0]?.language);
  }
};

// ---------------------------------------------------------------------------
// DeepL - free tier is 500k chars/month. `tag_handling: xml` is a better fit for
// our <xN> markers than DeepL's html mode, which tries to sanitise unknown tags.
// ---------------------------------------------------------------------------
const deepl = {
  id: 'deepl',
  label: 'DeepL (API key)',
  needsKey: true,
  keyHint: 'ends in ":fx" for a free-tier key',
  maxChars: 25000,
  maxItems: 50,

  endpoint(key) {
    return key.trim().endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
  },

  async translate({ texts, source, target, key, signal }) {
    if (!key) throw new TranslateError('No DeepL API key set');
    const targetCode = DEEPL_CODE[target];
    if (!targetCode) throw new TranslateError(`DeepL does not support ${target} as a target language`);

    const body = { text: texts, target_lang: targetCode, tag_handling: 'xml' };
    // DeepL wants a bare source code ("EN", not "EN-US").
    const src = source && source !== 'auto' ? DEEPL_CODE[source] : null;
    if (src) body.source_lang = src.split('-')[0];

    const res = await fetch(this.endpoint(key), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key.trim()}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw httpError(res, await res.text().catch(() => ''));

    const data = await res.json();
    const list = data?.translations;
    if (!Array.isArray(list) || list.length !== texts.length) {
      throw new TranslateError(`Expected ${texts.length} segments, got ${list?.length ?? 0}`);
    }
    return {
      texts: list.map(t => t.text),
      detected: normalizeLang(list.find(t => t.detected_source_language)?.detected_source_language)
    };
  },

  async detect({ text, key, signal }) {
    // DeepL has no standalone detect call; translate a sample and read the
    // language it reports back.
    const { detected } = await this.translate({
      texts: [text.slice(0, 400)], source: 'auto', target: 'en', key, signal
    });
    return detected;
  }
};

export const PROVIDERS = { googleFree, googleCloud, deepl };
export const DEFAULT_PROVIDER = 'googleFree';
export { TranslateError };

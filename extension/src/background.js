// Service worker: settings, translation cache, request scheduling, provider dispatch.

import { PROVIDERS, DEFAULT_PROVIDER } from './providers.js';
import { LANG_NAME, normalizeLang } from './langs.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

// ---- settings ------------------------------------------------------------
function defaultTarget() {
  return normalizeLang(api.i18n?.getUILanguage?.() || 'en') || 'en';
}

const DEFAULTS = {
  provider: DEFAULT_PROVIDER,
  keys: { googleCloud: '', deepl: '' },
  target: defaultTarget(),
  autoTranslate: false,     // translate without asking
  showBanner: true,         // offer a "Translate this page?" bar
  neverLangs: [],           // languages to never offer translation for
  sitePolicies: {},         // hostname -> 'always' | 'never'
  cacheEnabled: true
};

async function getSettings() {
  const stored = await api.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}), keys: { ...DEFAULTS.keys, ...(stored.settings?.keys || {}) } };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await api.storage.local.set({ settings: next });
  return next;
}

function activeProvider(settings) {
  return PROVIDERS[settings.provider] || PROVIDERS[DEFAULT_PROVIDER];
}

function providerKey(settings) {
  return settings.keys?.[settings.provider] || '';
}

// ---- cache ---------------------------------------------------------------
// Hot entries live in the worker; everything is mirrored to storage so a
// re-visited page costs nothing. Keys are hashed to keep storage keys short.
const memCache = new Map();
const MEM_LIMIT = 5000;
const DISK_LIMIT = 20000;
let diskKeys = null;
let flushTimer = null;
const pendingWrites = new Map();

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const cacheKey = (provider, source, target, text) =>
  `tc:${provider}:${source}:${target}:${hash(text)}:${text.length}`;

function memSet(key, value) {
  if (memCache.size >= MEM_LIMIT) {
    // Cheap FIFO eviction - Map preserves insertion order.
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, value);
}

async function cacheGet(keys) {
  const out = new Map();
  const missing = [];
  for (const key of keys) {
    if (memCache.has(key)) out.set(key, memCache.get(key));
    else missing.push(key);
  }
  if (missing.length) {
    const stored = await api.storage.local.get(missing);
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === 'string') { out.set(key, value); memSet(key, value); }
    }
  }
  return out;
}

function cachePut(key, value) {
  memSet(key, value);
  pendingWrites.set(key, value);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushCache, 2000);
}

async function flushCache() {
  if (!pendingWrites.size) return;
  const batch = Object.fromEntries(pendingWrites);
  pendingWrites.clear();
  try {
    await api.storage.local.set(batch);
    if (!diskKeys) {
      const stored = await api.storage.local.get('tcKeys');
      diskKeys = stored.tcKeys || [];
    }
    diskKeys.push(...Object.keys(batch));
    if (diskKeys.length > DISK_LIMIT) {
      const drop = diskKeys.splice(0, diskKeys.length - DISK_LIMIT);
      await api.storage.local.remove(drop);
    }
    await api.storage.local.set({ tcKeys: diskKeys });
  } catch (err) {
    console.warn('[SafariTranslate] cache flush failed', err);
  }
}

// ---- request scheduling --------------------------------------------------
// Bounded concurrency plus backoff, so the free endpoint does not start
// answering with 429s on a heavy page.
const MAX_INFLIGHT = 6;
let inflight = 0;
const waiting = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  inflight--;
  const next = waiting.shift();
  if (next) { inflight++; next(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!err.retryable || i === attempts - 1) throw err;
      await sleep(400 * 2 ** i + Math.floor(Math.random() * 200));
    }
  }
  throw lastError;
}

// ---- translation ---------------------------------------------------------
async function translate({ texts, source, target }) {
  const settings = await getSettings();
  const provider = activeProvider(settings);
  const key = providerKey(settings);
  const src = source || 'auto';

  const results = new Array(texts.length);
  let detected = null;

  // Cache lookup first; only the misses go to the network.
  const keys = texts.map(t => cacheKey(provider.id, src, target, t));
  if (settings.cacheEnabled) {
    const hits = await cacheGet(keys);
    texts.forEach((text, i) => {
      const hit = hits.get(keys[i]);
      if (hit !== undefined) results[i] = hit;
    });
  }

  const missIdx = [];
  for (let i = 0; i < texts.length; i++) if (results[i] === undefined) missIdx.push(i);

  if (missIdx.length) {
    await acquire();
    try {
      const res = await withRetry(() =>
        provider.translate({ texts: missIdx.map(i => texts[i]), source: src, target, key })
      );
      detected = res.detected || null;
      missIdx.forEach((originalIdx, j) => {
        const value = res.texts[j];
        results[originalIdx] = value;
        if (settings.cacheEnabled && typeof value === 'string') {
          cachePut(keys[originalIdx], value);
        }
      });
    } finally {
      release();
    }
  }
  return { texts: results, detected };
}

async function detect({ text }) {
  const settings = await getSettings();
  const provider = activeProvider(settings);
  await acquire();
  try {
    const lang = await withRetry(() => provider.detect({ text, key: providerKey(settings) }));
    return { lang };
  } finally {
    release();
  }
}

// ---- badge ---------------------------------------------------------------
async function setBadge(tabId, status) {
  if (!api.action?.setBadgeText || tabId == null) return;
  const text = status === 'translated' ? '✓' : status === 'translating' ? '…' : status === 'error' ? '!' : '';
  try {
    await api.action.setBadgeText({ tabId, text });
    await api.action.setBadgeBackgroundColor({ tabId, color: status === 'error' ? '#c0392b' : '#1a73e8' });
  } catch { /* tab gone */ }
}

// ---- message router ------------------------------------------------------
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  const handle = async () => {
    switch (message.type) {
      case 'pageConfig': {
        const settings = await getSettings();
        const host = sender.tab?.url ? safeHost(sender.tab.url) : safeHost(sender.url);
        return {
          target: settings.target,
          autoTranslate: settings.autoTranslate,
          showBanner: settings.showBanner,
          neverLangs: settings.neverLangs,
          policy: host ? settings.sitePolicies[host] || null : null,
          names: LANG_NAME
        };
      }
      case 'limits': {
        const provider = activeProvider(await getSettings());
        return { maxChars: provider.maxChars, maxItems: provider.maxItems };
      }
      case 'translate':
        return translate(message);
      case 'detect':
        return detect(message);
      case 'setSitePolicy': {
        const settings = await getSettings();
        const host = safeHost(sender.tab?.url || sender.url);
        if (host) {
          const policies = { ...settings.sitePolicies, [host]: message.policy };
          if (!message.policy) delete policies[host];
          await setSettings({ sitePolicies: policies });
        }
        return { ok: true };
      }
      case 'broadcastFrames': {
        // Subframes do not run their own detection; the top frame drives them.
        if (tabId != null) {
          api.tabs.sendMessage(tabId, {
            type: 'translatePage', target: message.target, source: message.source
          }, () => void api.runtime.lastError);
        }
        return { ok: true };
      }
      case 'progress':
        setBadge(tabId, message.state?.status);
        return { ok: true };   // popup listens for this too
      case 'getSettings':
        return getSettings();
      case 'setSettings':
        return setSettings(message.patch);
      case 'testProvider': {
        const provider = PROVIDERS[message.provider];
        if (!provider) throw new Error('Unknown provider');
        const res = await provider.translate({
          texts: ['Hello, world'], source: 'en', target: message.target || 'es', key: message.key || ''
        });
        return { ok: true, sample: res.texts[0] };
      }
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  };

  handle().then(sendResponse, err => sendResponse({ error: err.message || String(err) }));
  return true;   // async response
});

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// ---- context menu --------------------------------------------------------
api.runtime.onInstalled.addListener(async () => {
  await getSettings().then(s => api.storage.local.set({ settings: s }));
  try {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: 'translate-page',
        title: 'Translate this page',
        contexts: ['page', 'selection']
      });
    });
  } catch { /* contextMenus unavailable */ }
});

api.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translate-page' || !tab?.id) return;
  const settings = await getSettings();
  api.tabs.sendMessage(tab.id, { type: 'translatePage', target: settings.target });
});

api.tabs?.onRemoved.addListener(tabId => setBadge(tabId, 'idle'));

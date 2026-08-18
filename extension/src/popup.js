import { LANGS, LANG_NAME } from './langs.js';

const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = id => document.getElementById(id);

let tab = null;
let host = null;
let settings = null;
let pageState = { status: 'idle' };

const send = (message) => new Promise((resolve, reject) => {
  api.runtime.sendMessage(message, res => {
    const err = api.runtime.lastError;
    if (err) return reject(new Error(err.message));
    if (res?.error) return reject(new Error(res.error));
    resolve(res);
  });
});

// Content scripts are absent on internal pages; treat a failure as "not available".
const toTab = (message, options) => new Promise(resolve => {
  api.tabs.sendMessage(tab.id, message, options ?? {}, res => {
    void api.runtime.lastError;
    resolve(res || null);
  });
});
const MAIN_FRAME = { frameId: 0 };

function fillSelect(select, { includeAuto }) {
  select.replaceChildren();
  for (const lang of LANGS) {
    if (lang.g === 'auto' && !includeAuto) continue;
    const option = document.createElement('option');
    option.value = lang.g;
    option.textContent = lang.name;
    select.appendChild(option);
  }
}

function render() {
  const { status, source, target, error, done, pending } = pageState;
  const translating = status === 'translating';
  const translated = status === 'translated';

  $('primary').disabled = translating || !tab;
  $('primary').textContent = translating ? 'Translating…' : 'Translate page';
  $('revert').hidden = !translated && status !== 'error';

  if (source) $('source').value = source;
  if (target) $('target').value = target;

  const statusEl = $('status');
  statusEl.classList.toggle('status--error', status === 'error');
  if (status === 'error') {
    statusEl.textContent = `Error: ${error}`;
  } else if (translating) {
    statusEl.textContent = `Translating… ${done} of ${done + pending} segments`;
  } else if (translated) {
    const from = LANG_NAME[source] || source || 'the page';
    statusEl.textContent = `Translated from ${from}.`;
  } else {
    statusEl.textContent = '';
  }
}

async function init() {
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  settings = await send({ type: 'getSettings' });

  fillSelect($('source'), { includeAuto: true });
  fillSelect($('target'), { includeAuto: false });
  $('target').value = settings.target;
  $('source').value = 'auto';

  try { host = new URL(tab.url).hostname; } catch { host = null; }
  $('host').textContent = host || '';
  const policy = host ? settings.sitePolicies[host] : null;
  $('always').checked = policy === 'always';
  $('never').checked = policy === 'never';
  $('provider').textContent = { googleFree: 'Google (free)', googleCloud: 'Google Cloud', deepl: 'DeepL' }[settings.provider] || settings.provider;

  const state = tab ? await toTab({ type: 'getState' }, MAIN_FRAME) : null;
  if (!state) {
    $('primary').disabled = true;
    $('status').textContent = 'Not available on this page.';
    return;
  }
  pageState = state;

  // Show the detected language up front, the way Chrome's bubble does.
  if (!state.source) {
    toTab({ type: 'detectLanguage' }, MAIN_FRAME).then(res => {
      if (res?.lang) { pageState.source = res.lang; render(); }
    });
  }
  render();
}

$('primary').addEventListener('click', async () => {
  const source = $('source').value;
  await toTab({
    type: 'translatePage',
    target: $('target').value,
    source: source === 'auto' ? null : source
  });
  pageState.status = 'translating';
  render();
});

$('revert').addEventListener('click', async () => {
  await toTab({ type: 'showOriginal' });
  pageState = { status: 'idle' };
  render();
});

$('target').addEventListener('change', () => send({ type: 'setSettings', patch: { target: $('target').value } }));

async function setPolicy(policy) {
  if (!host) return;
  const policies = { ...settings.sitePolicies };
  if (policy) policies[host] = policy; else delete policies[host];
  settings = await send({ type: 'setSettings', patch: { sitePolicies: policies } });
}

$('always').addEventListener('change', async () => {
  if ($('always').checked) $('never').checked = false;
  await setPolicy($('always').checked ? 'always' : null);
  if ($('always').checked) $('primary').click();
});

$('never').addEventListener('change', async () => {
  if ($('never').checked) $('always').checked = false;
  await setPolicy($('never').checked ? 'never' : null);
});

$('options').addEventListener('click', event => {
  event.preventDefault();
  api.runtime.openOptionsPage();
});

// Live progress while a page translates behind the popup.
api.runtime.onMessage.addListener(message => {
  if (message.type === 'progress' && message.state) {
    pageState = message.state;
    render();
  }
});

init();

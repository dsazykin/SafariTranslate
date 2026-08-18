import { LANGS, LANG_NAME } from './langs.js';

const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = id => document.getElementById(id);

const HINTS = {
  googleFree: 'Uses the same free endpoint Chrome’s translator calls. No key, no cost. ' +
              'It is undocumented and not covered by Google’s terms for third-party use, and very heavy use can be rate-limited.',
  googleCloud: 'Official API. Create a key in a Google Cloud project with the Cloud Translation API enabled. ' +
               'About $20 per million characters; the first 500k characters each month are free for the first year.',
  deepl: 'Often better prose for major European languages. The free tier allows 500,000 characters a month. ' +
         'Free-tier keys end in “:fx”. Supports around 30 languages rather than 100+.'
};

let settings = null;

const send = (message) => new Promise((resolve, reject) => {
  api.runtime.sendMessage(message, res => {
    const err = api.runtime.lastError;
    if (err) return reject(new Error(err.message));
    if (res?.error) return reject(new Error(res.error));
    resolve(res);
  });
});

const save = async (patch) => { settings = await send({ type: 'setSettings', patch }); };

function renderProvider() {
  const provider = $('provider').value;
  $('providerHint').textContent = HINTS[provider];
  const needsKey = provider !== 'googleFree';
  $('keyField').hidden = !needsKey;
  $('key').value = settings.keys[provider] || '';
  $('testResult').textContent = '';
}

function renderNeverLangs() {
  const container = $('neverLangs');
  container.replaceChildren();
  for (const lang of LANGS) {
    if (lang.g === 'auto') continue;
    const chip = document.createElement('span');
    chip.className = 'chip' + (settings.neverLangs.includes(lang.g) ? ' chip--on' : '');
    chip.textContent = lang.name;
    chip.addEventListener('click', async () => {
      const set = new Set(settings.neverLangs);
      set.has(lang.g) ? set.delete(lang.g) : set.add(lang.g);
      await save({ neverLangs: [...set] });
      renderNeverLangs();
    });
    container.appendChild(chip);
  }
}

function renderSites() {
  const list = $('sites');
  list.replaceChildren();
  const entries = Object.entries(settings.sitePolicies);
  $('noSites').hidden = entries.length > 0;

  for (const [host, policy] of entries) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;
    const label = document.createElement('span');
    label.className = 'policy';
    label.textContent = policy === 'always' ? 'always translate' : 'never translate';
    const remove = document.createElement('button');
    remove.className = 'btn';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const policies = { ...settings.sitePolicies };
      delete policies[host];
      await save({ sitePolicies: policies });
      renderSites();
    });
    li.append(name, label, remove);
    list.appendChild(li);
  }
}

async function init() {
  settings = await send({ type: 'getSettings' });

  const target = $('target');
  for (const lang of LANGS) {
    if (lang.g === 'auto') continue;
    const option = document.createElement('option');
    option.value = lang.g;
    option.textContent = lang.name;
    target.appendChild(option);
  }
  target.value = settings.target;
  $('provider').value = settings.provider;
  $('autoTranslate').checked = settings.autoTranslate;
  $('showBanner').checked = settings.showBanner;
  $('cacheEnabled').checked = settings.cacheEnabled;

  renderProvider();
  renderNeverLangs();
  renderSites();
}

$('provider').addEventListener('change', async () => {
  await save({ provider: $('provider').value });
  renderProvider();
});

$('key').addEventListener('change', async () => {
  const keys = { ...settings.keys, [$('provider').value]: $('key').value.trim() };
  await save({ keys });
});

for (const id of ['autoTranslate', 'showBanner', 'cacheEnabled']) {
  $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
}
$('target').addEventListener('change', () => save({ target: $('target').value }));

$('test').addEventListener('click', async () => {
  const result = $('testResult');
  result.className = 'hint';
  result.textContent = 'Testing…';
  // Save the key first so the test uses what is on screen.
  const keys = { ...settings.keys, [$('provider').value]: $('key').value.trim() };
  await save({ keys });
  try {
    const res = await send({
      type: 'testProvider',
      provider: $('provider').value,
      key: keys[$('provider').value],
      target: $('target').value === 'en' ? 'es' : $('target').value
    });
    result.className = 'hint hint--ok';
    result.textContent = `Working — "Hello, world" → "${res.sample}"`;
  } catch (err) {
    result.className = 'hint hint--err';
    result.textContent = err.message;
  }
});

$('clearCache').addEventListener('click', async () => {
  const stored = await api.storage.local.get(null);
  const keys = Object.keys(stored).filter(k => k.startsWith('tc:') || k === 'tcKeys');
  await api.storage.local.remove(keys);
  $('cacheResult').textContent = `Cleared ${keys.length} cached entries.`;
});

init();

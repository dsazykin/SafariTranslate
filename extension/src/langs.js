// Shared language table (ES module: imported by the background worker and by the UI pages). `g` = Google code, `d` = DeepL target code (null = unsupported).
export const LANGS = [
  { g: 'auto', name: 'Detect language', d: null },
  { g: 'ar', name: 'Arabic', d: 'AR' },
  { g: 'bg', name: 'Bulgarian', d: 'BG' },
  { g: 'bn', name: 'Bengali', d: null },
  { g: 'cs', name: 'Czech', d: 'CS' },
  { g: 'da', name: 'Danish', d: 'DA' },
  { g: 'de', name: 'German', d: 'DE' },
  { g: 'el', name: 'Greek', d: 'EL' },
  { g: 'en', name: 'English', d: 'EN-US' },
  { g: 'es', name: 'Spanish', d: 'ES' },
  { g: 'et', name: 'Estonian', d: 'ET' },
  { g: 'fa', name: 'Persian', d: null },
  { g: 'fi', name: 'Finnish', d: 'FI' },
  { g: 'fr', name: 'French', d: 'FR' },
  { g: 'he', name: 'Hebrew', d: 'HE' },
  { g: 'hi', name: 'Hindi', d: null },
  { g: 'hu', name: 'Hungarian', d: 'HU' },
  { g: 'id', name: 'Indonesian', d: 'ID' },
  { g: 'it', name: 'Italian', d: 'IT' },
  { g: 'ja', name: 'Japanese', d: 'JA' },
  { g: 'ko', name: 'Korean', d: 'KO' },
  { g: 'lt', name: 'Lithuanian', d: 'LT' },
  { g: 'lv', name: 'Latvian', d: 'LV' },
  { g: 'nl', name: 'Dutch', d: 'NL' },
  { g: 'no', name: 'Norwegian', d: 'NB' },
  { g: 'pl', name: 'Polish', d: 'PL' },
  { g: 'pt', name: 'Portuguese', d: 'PT-PT' },
  { g: 'ro', name: 'Romanian', d: 'RO' },
  { g: 'ru', name: 'Russian', d: 'RU' },
  { g: 'sk', name: 'Slovak', d: 'SK' },
  { g: 'sl', name: 'Slovenian', d: 'SL' },
  { g: 'sv', name: 'Swedish', d: 'SV' },
  { g: 'th', name: 'Thai', d: 'TH' },
  { g: 'tr', name: 'Turkish', d: 'TR' },
  { g: 'uk', name: 'Ukrainian', d: 'UK' },
  { g: 'vi', name: 'Vietnamese', d: 'VI' },
  { g: 'zh-CN', name: 'Chinese (Simplified)', d: 'ZH' },
  { g: 'zh-TW', name: 'Chinese (Traditional)', d: 'ZH-HANT' }
];
export const LANG_NAME = Object.fromEntries(LANGS.map(l => [l.g, l.name]));
export const DEEPL_CODE = Object.fromEntries(LANGS.filter(l => l.d).map(l => [l.g, l.d]));

// Normalise a BCP-47 / provider-returned tag onto our table ("en-GB" -> "en", "zh-Hans" -> "zh-CN").
export function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (LANG_NAME[c]) return c;
  const lower = c.toLowerCase();
  if (lower.startsWith('zh')) return /hant|tw|hk|mo/.test(lower) ? 'zh-TW' : 'zh-CN';
  const base = lower.split(/[-_]/)[0];
  const hit = LANGS.find(l => l.g.toLowerCase() === base);
  return hit ? hit.g : null;
}

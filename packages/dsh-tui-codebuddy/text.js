/**
 * Backend-owned bilingual dictionary (host-surface notes §8): the texts live in
 * the bundle's own package — never in the host's dict — and the language is
 * picked at call time from `host.locale()`, defaulting to zh when no host (or
 * no locale) has arrived. Same conventions as the in-tree backend dicts:
 * both languages present for every key, `{{name}}` placeholders when a param
 * shows up (none yet), no single-brace interpolation. T6 will consolidate the
 * dict shape across bundles; keep this minimal until then.
 */

export const codebuddyTexts = {
  'hint-cli-missing': {
    zh: '未找到 codebuddy CLI（PATH 上没有可执行文件）。请先安装：npm install -g @tencent-ai/codebuddy-code，或参考 https://www.codebuddy.ai/docs/cli/cli-reference',
    en: 'codebuddy CLI not found (nothing on PATH). Install it first: npm install -g @tencent-ai/codebuddy-code, or see https://www.codebuddy.ai/docs/cli/cli-reference',
  },
}

/** Pick a text by locale; an unknown locale or key falls back to zh / the key. */
export function codebuddyText(key, locale) {
  const entry = codebuddyTexts[key]
  if (entry === undefined) return key
  return entry[locale === 'en' ? 'en' : 'zh']
}

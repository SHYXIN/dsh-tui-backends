// The bilingual closure of the backend dictionary (ticket T6) — the bundle's
// own copy of the host's verify-i18n rules (host-surface notes §8: the rules
// are isomorphic for third-party bundles, the gate just doesn't see us):
//
//  1. 语言完整性 — every key carries BOTH zh and en.
//  2. 形状 — a language value is a non-empty string, or a plural object
//     `{one, other}` reserved for `{{count}}` keys.
//  3. 占位符 — no single-brace `{name}` anywhere (`t()`-style interpolation
//     does not exist here; `{name}` would land on screen verbatim — the host
//     regex `(?<!\{)\{(\w+)\}(?!\})`).
//  4. 占位符一致 — zh/en placeholder name sets must not disagree in BOTH
//     directions (neither set ⊆ the other = a typo'd name on one side); one
//     side deliberately omitting a placeholder stays legal.
//  5. count 复数 — every key whose templates use `{{count}}` shapes its en
//     value as `{one, other}`; zh (no grammatical number) stays `other`.
//  6. 访问器 — the plural selection follows pickLocalizedText: en picks
//     `one` exactly at count 1, anything else (including non-finite/absent)
//     picks `other`; zh always `other`; an unfilled `{{name}}` stays visible.
import test from 'node:test'
import assert from 'node:assert/strict'
import { codebuddyText, codebuddyTexts } from '../text.js'

const SINGLE_BRACE = /(?<!\{)\{(\w+)\}(?!\})/

/** All template strings of one language value (string or plural object). */
function variantsOf(value) {
  return typeof value === 'string' ? [value] : [value.one, value.other].filter(v => typeof v === 'string')
}

function placeholderNames(value) {
  const names = new Set()
  for (const template of variantsOf(value)) {
    for (const match of template.matchAll(/\{\{(\w+)\}\}/g)) names.add(match[1])
  }
  return names
}

test('rule 1 语言完整性: every key carries zh and en', () => {
  const keys = Object.keys(codebuddyTexts)
  assert.ok(keys.length >= 10, `the dictionary is non-trivial (${keys.length} keys)`)
  for (const key of keys) {
    const entry = codebuddyTexts[key]
    assert.ok(entry !== null && typeof entry === 'object', `${key} is an entry`)
    assert.ok(typeof entry.zh === 'string' || (entry.zh !== null && typeof entry.zh === 'object'), `${key} 缺 zh`)
    assert.ok(typeof entry.en === 'string' || (entry.en !== null && typeof entry.en === 'object'), `${key} 缺 en`)
    for (const locale of ['zh', 'en']) {
      const variants = variantsOf(entry[locale])
      assert.ok(variants.length > 0 && variants.every(v => v.trim() !== ''), `${key} ${locale} 非空`)
    }
  }
})

test('rule 2 形状: plural objects only on count keys, always with other', () => {
  for (const [key, entry] of Object.entries(codebuddyTexts)) {
    for (const locale of ['zh', 'en']) {
      const value = entry[locale]
      if (typeof value === 'string') continue
      assert.ok(typeof value.other === 'string' && value.other !== '', `${key}.${locale} plural object needs other`)
      if (value.one !== undefined) assert.ok(typeof value.one === 'string' && value.one !== '', `${key}.${locale} one is a string`)
      const names = placeholderNames(value)
      assert.ok(names.has('count'), `${key}.${locale} plural object is reserved for {{count}} keys`)
    }
  }
})

test('rule 3 无单花括号: no single-brace placeholder survives in any template', () => {
  for (const [key, entry] of Object.entries(codebuddyTexts)) {
    for (const locale of ['zh', 'en']) {
      for (const template of variantsOf(entry[locale])) {
        assert.ok(!SINGLE_BRACE.test(template), `${key}.${locale} has a single-brace placeholder: ${template}`)
      }
    }
  }
})

test('rule 4 占位符一致: zh/en placeholder sets never disagree in both directions', () => {
  for (const [key, entry] of Object.entries(codebuddyTexts)) {
    const zh = placeholderNames(entry.zh)
    const en = placeholderNames(entry.en)
    const zhSubsetOfEn = [...zh].every(name => en.has(name))
    const enSubsetOfZh = [...en].every(name => zh.has(name))
    assert.ok(zhSubsetOfEn || enSubsetOfZh, `${key}: zh ${[...zh]} vs en ${[...en]} disagree in both directions (a typo'd name)`)
  }
})

test('rule 5 count 复数: {{count}} keys shape en as {one, other}', () => {
  for (const [key, entry] of Object.entries(codebuddyTexts)) {
    const usesCount = variantsOf(entry.zh).some(t => t.includes('{{count}}'))
      || variantsOf(entry.en).some(t => t.includes('{{count}}'))
    if (!usesCount) continue
    assert.ok(typeof entry.en === 'object', `${key}.en must be a plural object for count`)
    assert.ok(typeof entry.en.one === 'string' && entry.en.one !== '', `${key}.en.one missing`)
    assert.ok(typeof entry.en.other === 'string' && entry.en.other !== '', `${key}.en.other missing`)
    // zh has no grammatical number — string or {other} both fine, one forbidden to diverge.
    if (typeof entry.zh === 'object') assert.ok(entry.zh.one === undefined || entry.zh.one === entry.zh.other, `${key}.zh carries a diverging one-form`)
  }
})

test('rule 6 访问器: plural selection, missing params stay visible, unknown keys echo', () => {
  // The en one/other split happens exactly at 1 (pickLocalizedText).
  const countKey = Object.keys(codebuddyTexts).find(key => variantsOf(codebuddyTexts[key].en).some(t => t.includes('{{count}}')))
  assert.ok(countKey !== undefined, 'a count key exists to test the accessor')
  const one = codebuddyText(countKey, 'en', { count: 1 })
  const other = codebuddyText(countKey, 'en', { count: 2 })
  assert.notEqual(one, other, 'en count=1 picks the one-form')
  assert.ok(one !== codebuddyTexts[countKey].en.other, 'one-form is the one variant')
  // zh has no grammatical number: any count renders from the SAME (other)
  // template — compare against the filled template itself.
  const zhTemplate = typeof codebuddyTexts[countKey].zh === 'string'
    ? codebuddyTexts[countKey].zh
    : codebuddyTexts[countKey].zh.other
  assert.equal(codebuddyText(countKey, 'zh', { count: 1 }), zhTemplate.replace('{{count}}', '1'))
  // Non-finite counts still pick the other-form (the fill then renders the
  // given value; absent counts keep the placeholder visible, never 'undefined').
  assert.equal(codebuddyText(countKey, 'en', {}), codebuddyTexts[countKey].en.other)
  assert.equal(codebuddyText(countKey, 'en', { count: Number.NaN }), codebuddyTexts[countKey].en.other.replace('{{count}}', 'NaN'))
  // A param the template names but the caller did not provide stays visible
  // (never swallowed into an empty string).
  assert.ok(codebuddyText('resume-failed', 'zh', {}).includes('{{detail}}'))
  // Unknown keys echo themselves; unknown locales fall back to zh.
  assert.equal(codebuddyText('no-such-key', 'zh'), 'no-such-key')
  assert.equal(codebuddyText('submit-empty', 'fr'), codebuddyTexts['submit-empty'].zh)
})

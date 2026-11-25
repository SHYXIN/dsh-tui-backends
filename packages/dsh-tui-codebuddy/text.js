/**
 * Backend-owned bilingual dictionary (host-surface notes §8): the texts live in
 * the bundle's own package — never in the host's dict — and the language is
 * picked at call time from `host.locale()`, defaulting to zh when no host (or
 * no locale) has arrived. Same conventions as the in-tree backend dicts, and
 * pinned by test/text.test.js (the bundle's copy of the host's verify-i18n
 * rules): both languages present for every key, `{{name}}` placeholders, no
 * single-brace interpolation, and `{one, other}` plural objects for every
 * `{{count}}` key (en picks `one` exactly at 1; zh always takes `other` —
 * 汉语无语法数).
 */

export const codebuddyTexts = {
  'hint-cli-missing': {
    zh: '未找到 codebuddy CLI（PATH 上没有可执行文件）。请先安装：npm install -g @tencent-ai/codebuddy-code，或参考 https://www.codebuddy.ai/docs/cli/cli-reference',
    en: 'codebuddy CLI not found (nothing on PATH). Install it first: npm install -g @tencent-ai/codebuddy-code, or see https://www.codebuddy.ai/docs/cli/cli-reference',
  },
  'resume-invalid-target': {
    zh: 'CodeBuddy 会话恢复需要有效的会话 id（--resume <id>）。',
    en: 'CodeBuddy session resume needs a valid session id (--resume <id>).',
  },
  'resume-failed': {
    zh: 'CodeBuddy 会话恢复失败：{{detail}}',
    en: 'CodeBuddy session resume failed: {{detail}}',
  },
  'submit-after-dispose': {
    zh: 'CodeBuddy 会话已结束，无法继续发送消息。',
    en: 'The CodeBuddy session has been disposed; sending further messages is not possible.',
  },
  'session-dead': {
    zh: 'codebuddy CLI 进程已退出，会话不再接收消息。请重新打开会话。',
    en: 'The codebuddy CLI process exited; this session no longer accepts messages. Please open a new session.',
  },
  'submit-empty': {
    zh: '消息内容为空，无法发送。',
    en: 'The message is empty; nothing to send.',
  },
  'cli-exited-notice': {
    zh: 'codebuddy CLI 连接中断：{{detail}}',
    en: 'codebuddy CLI connection lost: {{detail}}',
  },
  'internal-error-notice': {
    zh: 'CodeBuddy 后端内部错误：{{detail}}',
    en: 'CodeBuddy backend internal error: {{detail}}',
  },
  'interrupt-forced-notice': {
    zh: '中断后超过 {{seconds}} 秒仍未收到 CLI 的 result，该回合已强制收口。',
    en: 'No result arrived within {{seconds}}s of the interrupt; the turn was force-settled.',
  },
  'card-tail-dropped': {
    zh: '（前 {{count}} 行已省略）',
    en: { one: '({{count}} earlier line omitted)', other: '({{count}} earlier lines omitted)' },
  },
  // Approval panel option labels (permission.request options); baked at park
  // time in the live host locale.
  'permission-allow-once': {
    zh: '允许一次',
    en: 'Allow once',
  },
  'permission-allow-always': {
    zh: '始终允许',
    en: 'Always allow',
  },
  'permission-reject': {
    zh: '拒绝',
    en: 'Deny',
  },
  // ── T6: models capability ────────────────────────────────────────────────
  'models-list-unavailable': {
    zh: 'CodeBuddy 会话已不可用，无法获取模型列表。请重新打开会话。',
    en: 'The CodeBuddy session is no longer available; the model list cannot be fetched. Please open a new session.',
  },
  'model-refused': {
    zh: 'CodeBuddy 模型切换失败：{{detail}}',
    en: 'CodeBuddy model switch failed: {{detail}}',
  },
  'model-invalid-ref': {
    zh: '模型选择无效：需要一个带 model id 的模型引用。',
    en: 'The model selection is invalid: a model ref carrying a model id is required.',
  },
  // ── T6: images capability ────────────────────────────────────────────────
  'image-type-refused': {
    zh: '图片「{{name}}」的类型 {{type}} 不受支持（支持 PNG、JPEG、GIF、WebP）。',
    en: 'The image "{{name}}" has an unsupported type, {{type}} (supported: PNG, JPEG, GIF, WebP).',
  },
  'image-too-large': {
    zh: '图片「{{name}}」超过 {{mb}} MiB 单图上限。',
    en: 'The image "{{name}}" exceeds the {{mb}} MiB per-image limit.',
  },
  'images-too-many': {
    zh: '一条消息最多携带 {{count}} 张图片。',
    en: { one: 'A message carries at most {{count}} image.', other: 'A message carries at most {{count}} images.' },
  },
  'images-too-large': {
    zh: '一条消息的图片总大小超过 {{mb}} MiB 上限。',
    en: "The message's images exceed the {{mb}} MiB total limit.",
  },
  'image-unreadable': {
    zh: '图片「{{name}}」无法读取：{{detail}}',
    en: 'The image "{{name}}" could not be read: {{detail}}',
  },
}

/** Pick a text by locale and fill `{{name}}` params; an unknown locale/key
 *  falls back to zh / the key, and a param the template names but the caller
 *  did not provide stays visible (never swallowed into an empty string).
 *  Count keys select their plural form first (notes §8 pickLocalizedText:
 *  en takes `one` exactly at count 1; a non-finite or absent count — and any
 *  zh request — takes `other`), then `{{name}}` fills. */
export function codebuddyText(key, locale, params) {
  const entry = codebuddyTexts[key]
  if (entry === undefined) return key
  let template = entry[locale === 'en' ? 'en' : 'zh']
  if (template !== null && typeof template === 'object') {
    const count = params?.count
    const plural = locale === 'en' && count === 1 ? 'one' : 'other'
    template = typeof template[plural] === 'string' ? template[plural] : template.other
  }
  if (params === undefined) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

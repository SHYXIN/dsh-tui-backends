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
  'resume-not-implemented': {
    zh: 'CodeBuddy 会话恢复尚未实现（--resume 在后续版本接入），请新建会话。',
    en: 'CodeBuddy session resume is not implemented yet (--resume lands in a later iteration); please start a new session.',
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
}

/** Pick a text by locale and fill `{{name}}` params; an unknown locale/key
 *  falls back to zh / the key, and a param the template names but the caller
 *  did not provide stays visible (never swallowed into an empty string). */
export function codebuddyText(key, locale, params) {
  const entry = codebuddyTexts[key]
  if (entry === undefined) return key
  const template = entry[locale === 'en' ? 'en' : 'zh']
  if (params === undefined) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

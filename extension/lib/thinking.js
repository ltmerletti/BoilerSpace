// Only expose controls with a documented parameter mapping for the selected model.
export function thinkingLevels(model = '') {
  if (/qwen3[._-]?8/i.test(model)) return ['default', 'off', 'low', 'medium', 'xhigh'];
  if (/gpt-oss/i.test(model)) return ['default', 'low', 'medium', 'high'];
  return [];
}

export const thinkingLabel = level => ({ default: 'Default', off: 'Quick', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' })[level] ?? 'Default';

export function thinkingParams(model, level = 'default') {
  if (level === 'default' || !thinkingLevels(model).includes(level)) return {};
  if (level === 'off') return { chat_template_kwargs: { enable_thinking: false } };
  return { reasoning_effort: level };
}

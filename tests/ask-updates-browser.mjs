// Runs inside either browser's real extension page with synthetic saved data.
export async function updateAskMetadata(extra = {}) {
  window.updateAskMetadata = updateAskMetadata;
  const minute = window.askUpdateMinute = (window.askUpdateMinute ?? 1) + 1;
  const { syncMeta } = await chrome.storage.local.get('syncMeta');
  await chrome.storage.local.set({ ...extra, syncMeta: { ...syncMeta, lastSuccessAt: new Date(Date.now() - minute * 60_000).toISOString() } });
  const until = Date.now() + 15_000;
  while (!document.querySelector('#sync-status').textContent.includes(`${minute} min ago`)) {
    if (Date.now() > until) throw new Error('The background update did not reach the visible panel.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function checkAskBackgroundUpdates() {
  // Inject this helper separately because serialized browser functions cannot
  // close over imports from the test runner.
  const update = window.updateAskMetadata;
  const input = document.querySelector('.composer textarea');
  const list = document.querySelector('.messages');
  const saved = [...list.querySelectorAll('.message')];
  const results = [];
  const retained = () => input === document.querySelector('.composer textarea') && list === document.querySelector('.messages') && saved.every(node => node.isConnected);
  for (const key of ['syllabi', 'discussions', 'gradescope', 'changes']) {
    const stored = (await chrome.storage.local.get(key))[key];
    const next = key === 'syllabi' ? Object.fromEntries(Object.entries(stored ?? {}).map(([id, record]) => [id, { ...record, checkedAt: new Date().toISOString() }]))
      : key === 'discussions' ? { ...stored, sources: (stored?.sources ?? []).map(source => ({ ...source, lastSyncedAt: new Date().toISOString() })) }
      : key === 'gradescope' ? { ...stored, lastSyncedAt: new Date().toISOString(), courses: stored?.courses ?? [] }
      : [{ id: 'ask-background-change', type: 'announcement', courseId: 1600001, title: 'Synthetic change', detectedAt: new Date().toISOString() }];
    await update({ [key]: next });
    results.push({ name: `${key} updates retain the conversation, saved messages and composer`, pass: retained() });
  }
  const scope = document.querySelector('.scope-options');
  document.querySelector('.scope-button').click();
  await update();
  results.push({ name: 'an unrelated update leaves the course menu open', pass: scope.isConnected && scope.matches(':popover-open') });
  scope.hidePopover();
  const thinking = document.querySelector('.thinking-options');
  document.querySelector('.thinking-trigger').click();
  const slider = thinking.querySelector('input');
  slider.value = '1';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  await update();
  results.push({ name: 'an unrelated update preserves the open thinking menu and its chosen level', pass: thinking.isConnected && thinking.matches(':popover-open') && slider.value === '1' });
  thinking.hidePopover();
  const { chats } = await chrome.storage.local.get('chats');
  chats[0].title = 'Background title';
  await update({ chats });
  results.push({ name: 'a cross-panel title update changes the title without remounting messages', pass: retained() && document.querySelector('.chat-title').textContent === 'Background title' });
  return results;
}

// Exercise a full retained history rather than just the most recent question.
export async function checkAskHistoryUpdates() {
  const update = window.updateAskMetadata;
  const original = (await chrome.storage.local.get('chats')).chats;
  const chats = structuredClone(original), chat = chats[0], results = [];
  chat.messages = Array.from({ length: 20 }, (_, index) => [
    { id: `history-user-${index}`, role: 'user', content: `Explain topic ${index}.` },
    { id: `history-answer-${index}`, role: 'assistant', content: Array.from({ length: 8 }, (_, paragraph) => `Topic ${index}, paragraph ${paragraph}. These are the posted course objectives and the material to review. [1]`).join('\n\n'),
      citations: [{ id: 'S1', label: `Topic ${index} syllabus`, url: 'https://purdue.brightspace.com/d2l/home/1600001' }],
      trace: [{ type: 'thought', text: 'Reviewing the course evidence. '.repeat(50) }, { type: 'tool', name: 'read_course_file', args: { file_key: `content:${index}` }, label: `Read topic ${index}`, summary: '8 paragraphs', details: [{ label: 'Learning objective', text: 'Explain the topic from its posted source.' }] }] },
  ]).flat();
  await update({ chats });
  const list = document.querySelector('.messages'), input = document.querySelector('textarea');
  const nodes = new Map([...list.children].map(node => [node.dataset.messageKey, node]));
  const same = except => input === document.querySelector('textarea') && list === document.querySelector('.messages') && [...nodes].every(([key, node]) => key === except || node === list.querySelector(`[data-message-key="${key}"]`));
  results.push({ name: 'a full 40-message history renders with sources and tool logs', pass: nodes.size === 40 && list.querySelectorAll('.sources').length === 20 && list.querySelectorAll('.tool-step').length === 20 });
  list.scrollTop = list.scrollHeight / 3;
  await new Promise(requestAnimationFrame);
  const top = list.scrollTop;
  const target = nodes.get('history-answer-6').querySelector('p[data-selection-key]');
  const text = target.firstChild;
  getSelection().setBaseAndExtent(text, 24, text, 3);
  const selected = getSelection().toString();
  const trace = nodes.get('history-answer-6').querySelector('.trace');
  trace.open = true;
  // Let the browser finish the disclosure's layout before recording the reading position.
  await new Promise(requestAnimationFrame);
  const settledTop = list.scrollTop;
  const durations = [];
  for (let index = 0; index < 8; index++) {
    const before = performance.now();
    await update();
    durations.push(performance.now() - before);
  }
  results.push({ name: 'repeated updates retain every message and the composer at the history limit', pass: same() });
  results.push({ name: 'repeated updates preserve selected text, direction, reading position and an open work log', pass: getSelection().toString() === selected && getSelection().anchorOffset === 24 && trace.open && Math.abs(list.scrollTop - settledTop) < 2 && top > 0 });
  // Storage serialization may change property order without changing any message.
  chat.messages = chat.messages.map(message => Object.fromEntries(Object.entries(message).reverse()));
  await update({ chats });
  results.push({ name: 'storage key reordering leaves the entire history mounted', pass: same() });
  const changed = chat.messages.find(message => message.id === 'history-answer-12');
  changed.content = 'A corrected instructor explanation.';
  changed.citations = [{ id: 'S2', label: 'Corrected source', url: 'https://purdue.brightspace.com/d2l/home/1600002' }];
  await update({ chats });
  results.push({ name: 'an edited answer updates its text and citation without rebuilding other messages', pass: same(changed.id) && !nodes.get(changed.id).isConnected && list.querySelector(`[data-message-key="${changed.id}"]`).textContent.includes(changed.content) && list.querySelector(`[data-message-key="${changed.id}"] .sources a`).href.endsWith('/1600002') });
  nodes.set(changed.id, list.querySelector(`[data-message-key="${changed.id}"]`));
  chat.messages = [...chat.messages.slice(2), { id: 'history-user-new', role: 'user', content: 'A question from another panel.' }, { id: 'history-answer-new', role: 'assistant', content: 'The new answer.' }];
  await update({ chats });
  results.push({ name: 'history eviction removes only the oldest pair and moves answer controls to the latest reply', pass: list.children.length === 40 && !nodes.get('history-user-0').isConnected && !nodes.get('history-answer-0').isConnected && [...nodes].filter(([key]) => !['history-user-0', 'history-answer-0'].includes(key)).every(([key, node]) => node === list.querySelector(`[data-message-key="${key}"]`)) && list.querySelectorAll('.message-actions').length === 1 && !!list.querySelector('[data-message-key="history-answer-new"] .message-actions') });
  getSelection().removeAllRanges();
  await update({ chats: original });
  return { results, timings: { updates: durations.length, maximumMs: Math.round(Math.max(...durations)), medianMs: Math.round([...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)]) } };
}

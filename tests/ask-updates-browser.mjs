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

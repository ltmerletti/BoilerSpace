// Everything lives in chrome.storage.local, on this device only.

export const KEYS = {
  snapshot: 'snapshot',
  syncMeta: 'syncMeta',
  syncLock: 'syncLock',
  syncProgress: 'syncProgress',
  drawerOpen: 'drawerOpen',
  drawerWidth: 'drawerWidth',
  syllabusChoice: 'syllabusChoice',
  syllabusSources: 'syllabusSources',
  syllabusAccess: 'syllabusAccess',
  changes: 'changes',
  genai: 'genai',
  syllabi: 'syllabi',
  reviews: 'reviews',
  chat: 'chat',
  chats: 'chats',
  ui: 'ui',
  theme: 'theme',
  discussions: 'discussions',
};

export async function get(key, fallback = null) {
  const value = (await chrome.storage.local.get(key))[key];
  return value === undefined ? fallback : value;
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function remove(key) {
  await chrome.storage.local.remove(key);
}

export async function update(key, fn, fallback = null) {
  const next = await fn(await get(key, fallback));
  await set(key, next);
  return next;
}

export async function getAll() {
  return chrome.storage.local.get(null);
}

export function onChange(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') listener(changes);
  });
}

// Credentials and transient UI state never belong in a user data export.
export async function getExportData() {
  const data = await getAll();
  for (const key of ['genai', 'discussionAuth', 'syncLock', 'syncProgress', 'drawerOpen', 'drawerWidth', 'ui']) delete data[key];
  return data;
}

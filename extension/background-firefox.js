// Event-page listeners must register before loading asynchronous dependencies.
// Chrome uses background.js because service workers cannot use dynamic import.
let loading;
const handlers = () => loading ??= import('./lib/background-handlers.js');

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message?.type?.startsWith('boilerspace-')) return false;
  return handlers().then(({ handleMessage }) => new Promise(resolve => {
    if (!handleMessage(message, sender, resolve)) resolve(undefined);
  })).catch(error => ({ ok: false, error: error.message }));
});

chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
const onSiteAccessChanged = change => {
  handlers().then(module => module.onSiteAccessChanged(change)).catch(() => {});
};
chrome.permissions.onAdded?.addListener(onSiteAccessChanged);
chrome.permissions.onRemoved?.addListener(onSiteAccessChanged);

// Register wake-up listeners synchronously, before the event page imports modules.
const readerEvent = (method, ...args) => {
  import('./lib/discussion-readers.js').then(module => module[method](...args)).catch(() => {});
};
chrome.tabs?.onActivated?.addListener(({ tabId }) => readerEvent('checkDiscussionReaderTab', tabId, true));
chrome.tabs?.onUpdated?.addListener((tabId, change) => { if (change.url) readerEvent('checkDiscussionReaderTab', tabId); });
chrome.tabs?.onRemoved?.addListener(tabId => readerEvent('checkDiscussionReaderTab', tabId, true));
chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === 'boilerspace-discussion-readers') readerEvent('sweepDiscussionReaders'); });
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.discussions && (!changes.discussions.newValue
    || changes.discussions.oldValue?.generation !== changes.discussions.newValue.generation)) readerEvent('sweepDiscussionReaders');
});
readerEvent('sweepDiscussionReaders');

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

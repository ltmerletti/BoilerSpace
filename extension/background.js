import { readXsrf } from './lib/sync.js';

// Chrome opens the side panel from the toolbar button. Firefox and Zen use a sidebar instead.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (globalThis.browser?.sidebarAction) {
  chrome.action.onClicked.addListener(() => browser.sidebarAction.toggle());
}

// Content scripts cannot call the page's own XSRF helper, so they ask for it here.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'boilerspace-xsrf' || !sender.tab?.id) return false;
  readXsrf(sender.tab.id).then((token) => sendResponse({ token }));
  return true;
});

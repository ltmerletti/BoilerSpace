import { handleMessage, onSiteAccessChanged } from './lib/background-handlers.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onMessage.addListener(handleMessage);
chrome.permissions.onAdded?.addListener(onSiteAccessChanged);
chrome.permissions.onRemoved?.addListener(onSiteAccessChanged);

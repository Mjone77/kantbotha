if (typeof browser === 'undefined') globalThis.browser = chrome;

const contentScriptId = 'hide_private_messages';
const hosts = [
  "https://app.mavenlink.com/workspaces/*",
  "https://app.kantata.com/workspaces/*"
];
const excludeMatches = [
  "https://app.mavenlink.com/workspaces/*/gantt",
  "https://app.kantata.com/workspaces/*/gantt"
];

async function toggleHidePrivateMessages() {
  let hidden = (await browser.scripting.getRegisteredContentScripts({ ids: [contentScriptId] })).length > 0;
  if (hidden) {
    await browser.scripting.unregisterContentScripts({ ids: [contentScriptId] });
  } else {
    await browser.scripting.registerContentScripts([
      {
        id: contentScriptId,
        matches: hosts,
        excludeMatches,
        css: ["content_scripts/hide_private_messages.css"],
        runAt: "document_start",
        persistAcrossSessions: false,
        allFrames: true
      }
    ]);
  }
  hidden = !hidden;
  injectCss(hidden);
  return hidden;
}

async function injectCss(hidden) {
  const tabs = await browser.tabs.query({
    discarded: false,
    url: hosts
  });
  for (const tab of tabs) {
    if (hidden) {
      browser.scripting.insertCSS({
        files: ['content_scripts/hide_private_messages.css'],
        target: {
          allFrames: true,
          tabId: tab.id
        }
      });
    } else {
      browser.scripting.removeCSS({
        files: ['content_scripts/hide_private_messages.css'],
        target: {
          allFrames: true,
          tabId: tab.id
        }
      });
    }
  }
  return true;
}

/* Removed the toggle_hide_private_messages command in favor of a button
browser.commands.onCommand.addListener((command) => {
  if (command === 'toggle_hide_private_messages') {
    toggleHidePrivateMessages();
  }
});*/

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggle_hide_private_messages') {
    toggleHidePrivateMessages().then(hidden => { sendResponse(hidden); });
    return true;
  }
  return false;
});
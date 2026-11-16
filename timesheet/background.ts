// Timesheet copier, background part (imported by background/service_worker.js).
// Toolbar icon: open the copier in its own small window (or focus it if it's already open).
// A separate window keeps the Workday tab active and visible in the main window while the
// copy runs; browsers pause rendering in background tabs.

export const APP_PATH = "timesheet/app.html";

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL(APP_PATH);
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: "popup", width: 1000, height: 900 });
});

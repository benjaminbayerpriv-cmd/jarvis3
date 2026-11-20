async function updateBadge(enabled) {
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#136c5a" : "#515864" });
  await chrome.action.setBadgeText({ text: enabled ? "AN" : "AUS" });
  await chrome.action.setTitle({
    title: enabled ? "Markierungen ausschalten" : "Markierungen einschalten",
  });
}

async function showCurrentState() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await updateBadge(enabled);
}

chrome.runtime.onInstalled.addListener(showCurrentState);
chrome.runtime.onStartup.addListener(showCurrentState);

let pending = Promise.resolve();
chrome.action.onClicked.addListener(() => {
  pending = pending.catch(console.error).then(async () => {
    const { enabled } = await chrome.storage.local.get({ enabled: true });
    await chrome.storage.local.set({ enabled: !enabled });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) {
    void updateBadge(changes.enabled.newValue !== false);
  }
});

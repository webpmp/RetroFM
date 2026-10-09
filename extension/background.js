// Retro FM Extension Background Service Worker (v1.0.4)

let activeConnectedTabId = null;

// Query for available YouTube tabs
async function listYouTubeTabs() {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
  return tabs.map(tab => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active
  }));
}

// Ensure the content_youtube script is injected into the target tab
async function ensureYouTubeScriptInjected(tabId) {
  try {
    // Ping tab to see if content script is active
    await chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' });
    return true;
  } catch (err) {
    // If receiving end does not exist, inject it dynamically via chrome.scripting
    try {
      if (chrome.scripting) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content_youtube.js']
        });
        // Brief pause to allow content script listeners to initialize
        await new Promise(r => setTimeout(r, 150));
        return true;
      }
    } catch (injectErr) {
      console.warn('[Retro FM] Script injection failed for tab', tabId, injectErr);
    }
    return false;
  }
}

// Find best YouTube tab (connected tab, active tab, or first found)
async function resolveYouTubeTab(requestedTabId) {
  if (requestedTabId) {
    try {
      const tab = await chrome.tabs.get(requestedTabId);
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        await ensureYouTubeScriptInjected(tab.id);
        return tab.id;
      }
    } catch (e) {
      // Tab might have closed
    }
  }

  if (activeConnectedTabId) {
    try {
      const tab = await chrome.tabs.get(activeConnectedTabId);
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        await ensureYouTubeScriptInjected(tab.id);
        return tab.id;
      }
    } catch (e) {
      activeConnectedTabId = null;
    }
  }

  const tabs = await listYouTubeTabs();
  const activeTab = tabs.find(t => t.active) || tabs[0];
  if (activeTab) {
    activeConnectedTabId = activeTab.id;
    await ensureYouTubeScriptInjected(activeTab.id);
    return activeTab.id;
  }
  return null;
}

// Helper: Find existing tab group named "Retro FM" in window
async function findRetroFmTabGroup(windowId) {
  if (!chrome.tabGroups) return null;
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    return groups.find(g => (g.title || '').trim().toLowerCase() === 'retro fm') || null;
  } catch (e) {
    console.warn('[Retro FM] Could not query tab groups:', e);
    return null;
  }
}

// Central dispatcher for handling requests from webpage or content script
function handleIncomingRequest(request, sender, sendResponse) {
  const { type, payload } = request;

  (async () => {
    try {
      if (type === 'PING') {
        sendResponse({ success: true, type: 'PONG', version: '1.0.4' });
        return;
      }

      if (type === 'LIST_YOUTUBE_TABS') {
        const tabs = await listYouTubeTabs();
        sendResponse({ success: true, data: { tabs, connectedTabId: activeConnectedTabId } });
        return;
      }

      // Feature: LAUNCH_RETRO_FM - automatically open YouTube next to Retro FM, connect it, and group both tabs in "Retro FM"
      if (type === 'LAUNCH_RETRO_FM') {
        try {
          // 1. Identify the caller's Retro FM tab
          let retroFmTab = null;
          if (sender && sender.tab) {
            retroFmTab = sender.tab;
          } else {
            // Find active tab in current window or first matching Retro FM tab
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            retroFmTab = activeTab;
          }

          if (!retroFmTab) {
            const allTabs = await chrome.tabs.query({ currentWindow: true });
            retroFmTab = allTabs[0];
          }

          const windowId = retroFmTab ? retroFmTab.windowId : undefined;

          // 2. Check if a YouTube tab is already connected and valid
          let ytTabId = null;
          let ytTab = null;

          if (activeConnectedTabId) {
            try {
              const existingTab = await chrome.tabs.get(activeConnectedTabId);
              if (existingTab && existingTab.url && existingTab.url.includes('youtube.com')) {
                ytTabId = existingTab.id;
                ytTab = existingTab;
              }
            } catch (e) {
              activeConnectedTabId = null;
            }
          }

          // If no active connected tab, check if another YouTube tab already exists in this window
          if (!ytTabId) {
            const existingYtTabs = await chrome.tabs.query({
              windowId,
              url: '*://*.youtube.com/*'
            });
            if (existingYtTabs.length > 0) {
              ytTab = existingYtTabs[0];
              ytTabId = ytTab.id;
            }
          }

          // 3. If no YouTube tab exists or is connected, create one next to the Retro FM tab
          let createdNewTab = false;
          if (!ytTabId) {
            const createProps = {
              url: 'https://www.youtube.com',
              active: false
            };
            if (retroFmTab && typeof retroFmTab.index === 'number') {
              createProps.index = retroFmTab.index + 1;
              createProps.windowId = retroFmTab.windowId;
            }
            ytTab = await chrome.tabs.create(createProps);
            ytTabId = ytTab.id;
            createdNewTab = true;

            // Wait briefly for tab creation / loading
            await new Promise(r => setTimeout(r, 600));
          }

          // 4. Register as the active connected YouTube tab
          activeConnectedTabId = ytTabId;
          await ensureYouTubeScriptInjected(ytTabId);

          // 5. Manage Chrome Tab Group ("Retro FM" group with distinct color)
          let groupId = null;
          if (chrome.tabs.group && chrome.tabGroups) {
            try {
              // Check if Retro FM tab or YouTube tab is already in a group, or if a "Retro FM" group exists
              const existingRetroGroup = await findRetroFmTabGroup(windowId);

              const tabsToGroup = [];
              if (retroFmTab && retroFmTab.id) tabsToGroup.push(retroFmTab.id);
              if (ytTabId && !tabsToGroup.includes(ytTabId)) tabsToGroup.push(ytTabId);

              if (existingRetroGroup) {
                // Reuse existing group
                groupId = existingRetroGroup.id;
                await chrome.tabs.group({
                  groupId: existingRetroGroup.id,
                  tabIds: tabsToGroup
                });
              } else if (retroFmTab && retroFmTab.groupId && retroFmTab.groupId !== -1) {
                // Retro FM is already in a group; add YouTube tab to it and ensure title & color
                groupId = retroFmTab.groupId;
                await chrome.tabs.group({
                  groupId: retroFmTab.groupId,
                  tabIds: [ytTabId]
                });
                await chrome.tabGroups.update(groupId, {
                  title: 'Retro FM',
                  color: 'orange'
                });
              } else if (ytTab && ytTab.groupId && ytTab.groupId !== -1) {
                // YouTube is already in a group; add Retro FM to it and ensure title & color
                groupId = ytTab.groupId;
                if (retroFmTab && retroFmTab.id) {
                  await chrome.tabs.group({
                    groupId: ytTab.groupId,
                    tabIds: [retroFmTab.id]
                  });
                }
                await chrome.tabGroups.update(groupId, {
                  title: 'Retro FM',
                  color: 'orange'
                });
              } else {
                // Create a brand new tab group containing both tabs
                groupId = await chrome.tabs.group({
                  tabIds: tabsToGroup
                });
                await chrome.tabGroups.update(groupId, {
                  title: 'Retro FM',
                  color: 'orange'
                });
              }
            } catch (groupErr) {
              console.warn('[Retro FM] Tab grouping warning:', groupErr);
            }
          }

          // Query status of the YouTube tab
          let status = null;
          try {
            status = await chrome.tabs.sendMessage(ytTabId, { action: 'GET_STATUS' });
          } catch (e) {
            status = { available: true, title: 'YouTube' };
          }

          sendResponse({
            success: true,
            data: {
              connectedTabId: ytTabId,
              groupId,
              createdNewTab,
              status
            }
          });
        } catch (launchErr) {
          console.error('[Retro FM] Launch error:', launchErr);
          sendResponse({
            success: false,
            error: 'Failed to launch Retro FM group: ' + launchErr.message
          });
        }
        return;
      }

      if (type === 'CONNECT_YOUTUBE_TAB') {
        const targetId = payload?.tabId;
        const resolvedId = await resolveYouTubeTab(targetId);
        if (!resolvedId) {
          sendResponse({
            success: false,
            error: 'No YouTube tab found. Please make sure a tab with youtube.com is open.'
          });
          return;
        }
        activeConnectedTabId = resolvedId;

        // Query status of connected tab
        try {
          const status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
          sendResponse({ success: true, data: { tabId: resolvedId, status } });
        } catch (err) {
          // If first message failed, retry once after script injection
          await ensureYouTubeScriptInjected(resolvedId);
          try {
            const status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
            sendResponse({ success: true, data: { tabId: resolvedId, status } });
          } catch (retryErr) {
            sendResponse({ success: true, data: { tabId: resolvedId, status: { available: true } } });
          }
        }
        return;
      }

      if (type === 'COMMAND_YOUTUBE') {
        const tabId = await resolveYouTubeTab(payload?.tabId);
        if (!tabId) {
          sendResponse({ success: false, error: 'No YouTube tab connected.' });
          return;
        }

        try {
          const result = await chrome.tabs.sendMessage(tabId, payload.command);
          sendResponse({ success: true, data: result });
        } catch (err) {
          // Retry once after ensuring content script is injected
          await ensureYouTubeScriptInjected(tabId);
          try {
            const result = await chrome.tabs.sendMessage(tabId, payload.command);
            sendResponse({ success: true, data: result });
          } catch (retryErr) {
            sendResponse({ success: false, error: 'Failed communicating with YouTube tab: ' + retryErr.message });
          }
        }
        return;
      }

      if (type === 'NAVIGATE_YOUTUBE') {
        const tabId = await resolveYouTubeTab(payload?.tabId);
        if (!tabId) {
          sendResponse({ success: false, error: 'No YouTube tab connected. Please open youtube.com in another tab.' });
          return;
        }

        const videoId = payload?.videoId;
        const targetUrl = payload?.url || (videoId ? ('https://www.youtube.com/watch?v=' + videoId) : null);
        if (!targetUrl) {
          sendResponse({ success: false, error: 'No YouTube video ID or URL provided for navigation.' });
          return;
        }

        activeConnectedTabId = tabId;

        try {
          // 1. Navigate connected YouTube tab to the target video URL
          await chrome.tabs.update(tabId, { url: targetUrl });

          // 2. Wait for tab to complete navigation/loading
          await new Promise((resolve) => {
            let timer = null;
            const onUpdatedListener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdatedListener);
                if (timer) clearTimeout(timer);
                resolve(true);
              }
            };
            chrome.tabs.onUpdated.addListener(onUpdatedListener);
            timer = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(onUpdatedListener);
              resolve(false);
            }, 6000);
          });

          // Ensure content script is injected into the newly loaded page
          await ensureYouTubeScriptInjected(tabId);

          // 3. Start playback using the same message pattern as PLAY command
          let playResult = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise((r) => setTimeout(r, 400));
            try {
              playResult = await chrome.tabs.sendMessage(tabId, { action: 'PLAY' });
              if (playResult && playResult.success) {
                break;
              }
            } catch (msgErr) {
              await ensureYouTubeScriptInjected(tabId);
            }
          }

          if (playResult && playResult.success) {
            sendResponse({
              success: true,
              data: {
                tabId,
                url: targetUrl,
                status: playResult.status
              }
            });
          } else {
            // Retrieve current status if playback command completed or autoplay triggered
            try {
              const currentStatus = await chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' });
              sendResponse({
                success: true,
                data: {
                  tabId,
                  url: targetUrl,
                  status: currentStatus
                }
              });
            } catch (err) {
              sendResponse({
                success: true,
                data: {
                  tabId,
                  url: targetUrl
                }
              });
            }
          }
        } catch (navErr) {
          sendResponse({
            success: false,
            error: 'Failed to navigate YouTube tab: ' + navErr.message
          });
        }
        return;
      }

      sendResponse({ success: false, error: 'Unknown extension request type: ' + type });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep channel open for async response
}

// 1. Listen for external messages directly from web pages (via externally_connectable)
if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
    return handleIncomingRequest(request, sender, sendResponse);
  });
}

// 2. Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  return handleIncomingRequest(request, sender, sendResponse);
});

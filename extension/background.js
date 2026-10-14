// Retro FM Extension Background Service Worker
// Reads version dynamically via chrome.runtime.getManifest().version

let activeConnectedTabId = null;
let activeRetroFmTabId = null;
let activeBoomBoxTabId = null;
let lastKnownRadioState = null;
let latestYouTubeState = null;

// Unified Transport Trace Log (max 300 entries, stored in memory and persisted to chrome.storage.session)
const MAX_TRANSPORT_TRACE_ENTRIES = 300;
let transportTraceLog = [];

// Audio Diagnostics Snapshot & Events (keeps latest snapshot + last 40 events in memory & chrome.storage.session)
const MAX_AUDIO_DIAGNOSTICS_EVENTS = 40;
let latestAudioDiagnosticsSnapshot = null;
let audioDiagnosticsEvents = [];

function recordAudioDiagnosticsEvent(event, data) {
  try {
    const entry = {
      ts: Date.now(),
      timeIso: new Date().toISOString(),
      event: event || 'DIAGNOSTIC_EVENT',
      data: data || {}
    };
    audioDiagnosticsEvents.push(entry);
    if (audioDiagnosticsEvents.length > MAX_AUDIO_DIAGNOSTICS_EVENTS) {
      audioDiagnosticsEvents.splice(0, audioDiagnosticsEvents.length - MAX_AUDIO_DIAGNOSTICS_EVENTS);
    }
    if (chrome.storage?.session) {
      chrome.storage.session.set({
        latestAudioDiagnosticsSnapshot,
        audioDiagnosticsEvents
      }).catch(() => {});
    }
  } catch (e) {}
}

function recordTrace(source, event, data) {
  try {
    const entry = {
      ts: Date.now(),
      source: source || 'background',
      event: event || 'UNKNOWN',
      data: data || {}
    };
    transportTraceLog.push(entry);
    if (transportTraceLog.length > MAX_TRANSPORT_TRACE_ENTRIES) {
      transportTraceLog.splice(0, transportTraceLog.length - MAX_TRANSPORT_TRACE_ENTRIES);
    }
    if (chrome.storage?.session) {
      chrome.storage.session.set({ transportTraceLog }).catch(() => {});
    }
  } catch (e) {}
}

// Restore trace log and diagnostics from session storage on worker startup
try {
  if (chrome.storage?.session) {
    chrome.storage.session.get(['transportTraceLog', 'latestAudioDiagnosticsSnapshot', 'audioDiagnosticsEvents']).then((res) => {
      if (Array.isArray(res?.transportTraceLog)) {
        transportTraceLog = res.transportTraceLog.slice(-MAX_TRANSPORT_TRACE_ENTRIES);
      }
      if (res?.latestAudioDiagnosticsSnapshot) {
        latestAudioDiagnosticsSnapshot = res.latestAudioDiagnosticsSnapshot;
      }
      if (Array.isArray(res?.audioDiagnosticsEvents)) {
        audioDiagnosticsEvents = res.audioDiagnosticsEvents.slice(-MAX_AUDIO_DIAGNOSTICS_EVENTS);
      }
    }).catch(() => {});
  }
} catch (e) {}

// Re-inject content_retrofm.js into open RetroFM tabs on startup / reload so app can self-register
async function reinjectRetroFmPageBridge() {
  if (!chrome.scripting || !chrome.tabs) return;
  try {
    const candidateTabs = await chrome.tabs.query({
      url: ['*://localhost/*', '*://127.0.0.1/*', '*://*.run.app/*']
    });
    for (const tab of candidateTabs) {
      if (tab.id && !tab.url?.includes('player/index.html')) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content_retrofm.js']
          });
        } catch (e) {}
      }
    }
  } catch (e) {}
}

if (chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    reinjectRetroFmPageBridge().catch(() => {});
  });
}
if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    reinjectRetroFmPageBridge().catch(() => {});
  });
}

// Query for available Boom Box tabs
async function resolveBoomBoxTab() {
  if (activeBoomBoxTabId) {
    try {
      const tab = await chrome.tabs.get(activeBoomBoxTabId);
      if (tab && tab.url && tab.url.includes('player/index.html')) {
        return tab.id;
      }
    } catch (e) {
      activeBoomBoxTabId = null;
    }
  }
  try {
    const tabs = await chrome.tabs.query({});
    const found = tabs.find(t => t.url && t.url.includes('player/index.html'));
    if (found) {
      activeBoomBoxTabId = found.id;
      return found.id;
    }
  } catch (e) {}
  return null;
}

// Helpers to manage registered app tab ID with chrome.storage.session persistence
async function getStoredRegisteredAppTabId() {
  if (activeRetroFmTabId) return activeRetroFmTabId;
  try {
    if (chrome.storage?.session) {
      const data = await chrome.storage.session.get('registeredAppTabId');
      if (typeof data?.registeredAppTabId === 'number') {
        activeRetroFmTabId = data.registeredAppTabId;
        return activeRetroFmTabId;
      }
    }
  } catch (e) {}
  return null;
}

async function setStoredRegisteredAppTabId(tabId) {
  activeRetroFmTabId = tabId;
  try {
    if (chrome.storage?.session) {
      await chrome.storage.session.set({ registeredAppTabId: tabId });
    }
  } catch (e) {}
}

async function clearStoredRegisteredAppTabId() {
  activeRetroFmTabId = null;
  try {
    if (chrome.storage?.session) {
      await chrome.storage.session.remove('registeredAppTabId');
    }
  } catch (e) {}
}

// Find registered RetroFM web app tab (only a tab that has registered itself)
async function resolveRetroFmTab(requestedTabId) {
  if (requestedTabId) {
    try {
      const tab = await chrome.tabs.get(requestedTabId);
      if (tab) return tab.id;
    } catch (e) {}
  }

  const tabId = await getStoredRegisteredAppTabId();
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) return tab.id;
    } catch (e) {
      await clearStoredRegisteredAppTabId();
    }
  }
  return null;
}

// Query for available YouTube tabs
async function listYouTubeTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const ytTabs = tabs.filter(t => t.url && t.url.includes('youtube.com'));
    return ytTabs.map(tab => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active
    }));
  } catch (e) {
    return [];
  }
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
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            files: ['player/yt_main_world.js']
          });
        } catch (mainErr) {}
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

// One-time session activation state
let hasSessionActivation = false;
let sessionActivationPromptTabId = null;
let precedingTabBeforeActivation = null;
let userSwitchedTabDuringActivation = false;
let isActivationSwitchInProgress = false;

// Pending user play intent (60s expiry)
let pendingPlayIntent = null; // { tabId, timestamp, timer }

function clearPendingPlayIntent(reason = '') {
  if (pendingPlayIntent) {
    if (pendingPlayIntent.timer) {
      clearTimeout(pendingPlayIntent.timer);
    }
    recordTrace('background', 'PENDING_PLAY_INTENT_CLEARED', { reason });
    pendingPlayIntent = null;
  }
}

function storePendingPlayIntent(tabId) {
  clearPendingPlayIntent('superseded');
  const timer = setTimeout(() => {
    if (pendingPlayIntent && pendingPlayIntent.tabId === tabId) {
      recordTrace('background', 'PENDING_PLAY_INTENT_EXPIRED', { tabId });
      pendingPlayIntent = null;
    }
  }, 60000);
  pendingPlayIntent = { tabId, timestamp: Date.now(), timer };
  recordTrace('background', 'PENDING_PLAY_INTENT_STORED', { tabId, expiresMs: 60000 });
}

async function triggerOneTimeSessionActivation(ytTabId, askForOneTimeClick = true) {
  if (!ytTabId || hasSessionActivation || isActivationSwitchInProgress) return;

  // Check if player/tab already has activation
  try {
    const stat = await chrome.tabs.sendMessage(ytTabId, { action: 'GET_STATUS' });
    if (latestAudioDiagnosticsSnapshot?.userActivation?.hasBeenActive) {
      hasSessionActivation = true;
      return;
    }
  } catch (e) {}

  if (!askForOneTimeClick) {
    recordTrace('background', 'SESSION_ACTIVATION_SKIPPED_NEEDS_USER_CLICK', { ytTabId });
    const retroTabId = await resolveRetroFmTab();
    if (retroTabId) {
      try { await chrome.tabs.sendMessage(retroTabId, { type: 'NEEDS_USER_CLICK' }); } catch (e) {}
    }
    const bbTabId = await resolveBoomBoxTab();
    if (bbTabId) {
      try { await chrome.tabs.sendMessage(bbTabId, { type: 'NEEDS_USER_CLICK' }); } catch (e) {}
    }
    return;
  }

  let ytTab = null;
  try {
    ytTab = await chrome.tabs.get(ytTabId);
  } catch (e) {
    return;
  }

  if (ytTab.active) {
    // Already active, overlay in content_youtube.js is visible to user
    return;
  }

  // Find currently active tab in this window (normally the Boom Box)
  let activeTabId = null;
  try {
    const activeTabs = await chrome.tabs.query({ windowId: ytTab.windowId, active: true });
    if (activeTabs.length > 0) {
      activeTabId = activeTabs[0].id;
    }
  } catch (e) {}

  precedingTabBeforeActivation = activeTabId;
  sessionActivationPromptTabId = ytTabId;
  userSwitchedTabDuringActivation = false;
  isActivationSwitchInProgress = true;

  recordTrace('background', 'SESSION_ACTIVATION_SWITCH_TO_YT', {
    ytTabId,
    precedingTabId: precedingTabBeforeActivation
  });

  try {
    await chrome.tabs.update(ytTabId, { active: true });
  } catch (err) {
    recordTrace('background', 'SESSION_ACTIVATION_SWITCH_ERROR', { error: err.message });
  } finally {
    isActivationSwitchInProgress = false;
  }
}

// Track active tab changes to respect user tab switches
let userSwitchedTabDuringRecovery = false;
let isRecoveryInProgress = false;

if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (isRecoveryInProgress) {
      userSwitchedTabDuringRecovery = true;
    }
    if (sessionActivationPromptTabId && !isActivationSwitchInProgress) {
      // If user changed tabs themselves before clicking, do not switch back and do not bring tab forward again
      if (activeInfo.tabId !== sessionActivationPromptTabId) {
        userSwitchedTabDuringActivation = true;
        sessionActivationPromptTabId = null;
        recordTrace('background', 'USER_SWITCHED_TAB_BEFORE_ACTIVATION', { activeTabId: activeInfo.tabId });
      }
    }
  });
}

// Hidden-tab playback recovery helper
async function checkAndRecoverHiddenTabPlayback(ytTabId, revealSetting = false) {
  if (!ytTabId) return;

  // Once activation exists, later Play commands and song changes must never switch tabs
  if (hasSessionActivation || (latestAudioDiagnosticsSnapshot?.userActivation?.hasBeenActive)) {
    hasSessionActivation = true;
    return;
  }

  // Step 1: Wait up to 2.5s for player to reach state 1 (playing)
  const startTime = Date.now();
  let reachedStateOne = false;

  while (Date.now() - startTime < 2500) {
    if (latestYouTubeState && latestYouTubeState.state === 1) {
      reachedStateOne = true;
      break;
    }
    // Also check status from tab directly if state hasn't been pushed
    try {
      const stat = await chrome.tabs.sendMessage(ytTabId, { action: 'GET_STATUS' });
      if (stat && (stat.isPlaying || stat.playerState === 1)) {
        reachedStateOne = true;
        break;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }

  if (reachedStateOne) return;

  // Player has not reached playing state within 2.5s
  if (!revealSetting) {
    recordTrace('background', 'NEEDS_USER_CLICK_DISPATCHED', { ytTabId });
    const retroTabId = await resolveRetroFmTab();
    if (retroTabId) {
      try {
        await chrome.tabs.sendMessage(retroTabId, { type: 'NEEDS_USER_CLICK' });
      } catch (e) {}
    }
    const bbTabId = await resolveBoomBoxTab();
    if (bbTabId) {
      try {
        await chrome.tabs.sendMessage(bbTabId, { type: 'NEEDS_USER_CLICK' });
      } catch (e) {}
    }
    return;
  }

  // Step 2: revealSetting is true, recover by temporarily activating the YouTube tab
  let ytTab = null;
  try {
    ytTab = await chrome.tabs.get(ytTabId);
  } catch (e) {
    return;
  }

  // If the YouTube tab is already the active tab in its window, activation won't help
  if (ytTab.active) return;

  recordTrace('background', 'HIDDEN_TAB_RECOVERY_TRIGGERED', { ytTabId, active: ytTab.active });

  // Find currently active tab in the YouTube tab's window so we can switch back
  let originalActiveTabId = null;
  try {
    const activeTabs = await chrome.tabs.query({ windowId: ytTab.windowId, active: true });
    if (activeTabs.length > 0) {
      originalActiveTabId = activeTabs[0].id;
    }
  } catch (e) {}

  isRecoveryInProgress = true;
  userSwitchedTabDuringRecovery = false;

  try {
    // Briefly make the YouTube tab active
    await chrome.tabs.update(ytTabId, { active: true });
    recordTrace('background', 'HIDDEN_TAB_ACTIVATED', { ytTabId, originalActiveTabId });

    // Wait up to 4s for state 1
    const actStartTime = Date.now();
    while (Date.now() - actStartTime < 4000) {
      if (latestYouTubeState && latestYouTubeState.state === 1) {
        break;
      }
      try {
        const stat = await chrome.tabs.sendMessage(ytTabId, { action: 'GET_STATUS' });
        if (stat && (stat.isPlaying || stat.playerState === 1)) {
          break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 250));
    }

    // Re-activate the tab that was active before, UNLESS the user has switched tabs themselves
    if (!userSwitchedTabDuringRecovery && originalActiveTabId && originalActiveTabId !== ytTabId) {
      try {
        await chrome.tabs.update(originalActiveTabId, { active: true });
        recordTrace('background', 'HIDDEN_TAB_RESTORED_ORIGINAL', { originalActiveTabId });
      } catch (e) {}
    } else {
      recordTrace('background', 'HIDDEN_TAB_SKIPPED_RESTORE', {
        userSwitchedTabDuringRecovery,
        originalActiveTabId
      });
    }

    // Notify registered RetroFM app tab so it can log to Experimental Event Log
    const retroTabId = await resolveRetroFmTab();
    if (retroTabId) {
      try {
        await chrome.tabs.sendMessage(retroTabId, {
          type: 'YOUTUBE_REVEALED_TO_START'
        });
      } catch (e) {}
    }
  } catch (err) {
    recordTrace('background', 'HIDDEN_TAB_RECOVERY_ERROR', { error: err.message });
  } finally {
    isRecoveryInProgress = false;
  }
}

// Central dispatcher for handling requests from webpage or content script
function handleIncomingRequest(request, sender, sendResponse) {
  const { type, payload } = request;

  (async () => {
    try {
      if (type === 'PING') {
        const extVersion = chrome.runtime?.getManifest?.()?.version || '1.0.0';
        sendResponse({ success: true, type: 'PONG', version: extVersion });
        return;
      }

      if (type === 'LIST_YOUTUBE_TABS') {
        const tabs = await listYouTubeTabs();
        sendResponse({ success: true, data: { tabs, connectedTabId: activeConnectedTabId } });
        return;
      }

      // Feature: OPEN_BOOMBOX - opens or focuses existing Boom Box player tab
      if (type === 'OPEN_BOOMBOX') {
        try {
          const boomBoxUrl = chrome.runtime.getURL('player/index.html');
          const existingTabId = await resolveBoomBoxTab();
          let targetTab = null;
          let reused = false;

          if (existingTabId) {
            targetTab = await chrome.tabs.get(existingTabId);
            await chrome.tabs.update(existingTabId, { active: true });
            if (targetTab.windowId) {
              try {
                await chrome.windows.update(targetTab.windowId, { focused: true });
              } catch (e) {}
            }
            reused = true;
          } else {
            const createProps = { url: boomBoxUrl, active: true };
            if (sender?.tab?.windowId) {
              createProps.windowId = sender.tab.windowId;
              if (typeof sender.tab.index === 'number') {
                createProps.index = sender.tab.index + 1;
              }
            }
            targetTab = await chrome.tabs.create(createProps);
            activeBoomBoxTabId = targetTab.id;
          }

          // Add Boom Box tab to the RETRO FM tab group if available
          if (chrome.tabs.group && chrome.tabGroups && targetTab?.id) {
            try {
              const windowId = targetTab.windowId || sender?.tab?.windowId;
              const existingGroup = await findRetroFmTabGroup(windowId);
              if (existingGroup) {
                await chrome.tabs.group({
                  groupId: existingGroup.id,
                  tabIds: [targetTab.id]
                });
              } else if (sender?.tab?.groupId && sender.tab.groupId !== -1) {
                await chrome.tabs.group({
                  groupId: sender.tab.groupId,
                  tabIds: [targetTab.id]
                });
                await chrome.tabGroups.update(sender.tab.groupId, {
                  title: 'Retro FM',
                  color: 'orange'
                });
              }
            } catch (groupErr) {
              console.warn('[Retro FM] Boom Box tab grouping warning:', groupErr);
            }
          }

          sendResponse({
            success: true,
            data: { success: true, tabId: targetTab.id, reused }
          });
        } catch (openErr) {
          sendResponse({ success: false, error: openErr.message });
        }
        return;
      }

      // Feature: REGISTER_RETROFM_APP / APP_HELLO - RetroFM app registers itself with the extension
      if (type === 'REGISTER_RETROFM_APP' || type === 'APP_HELLO') {
        try {
          if (sender?.tab?.id) {
            await setStoredRegisteredAppTabId(sender.tab.id);
          }
          sendResponse({
            success: true,
            data: { registered: true, tabId: activeRetroFmTabId }
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        return;
      }

      // Feature: YT_STATE_CHANGED - Pushed YouTube player state update
      if (type === 'YT_STATE_CHANGED') {
        const statePayload = payload || {};
        latestYouTubeState = statePayload;
        const rawState = statePayload.state;
        const normalizedMode = (rawState === 1 || rawState === 3) ? 'playing' : (rawState === 2 ? 'paused' : 'stopped');
        recordTrace('background', 'YT_STATE_CHANGED_PUSHED', {
          rawState,
          normalizedMode,
          videoId: statePayload.videoId,
          currentTime: statePayload.currentTime,
          duration: statePayload.duration
        });

        // Forward to registered RetroFM app tab
        const retroTabId = await resolveRetroFmTab();
        if (retroTabId) {
          try {
            await chrome.tabs.sendMessage(retroTabId, {
              type: 'YT_STATE_CHANGED',
              payload: statePayload
            });
          } catch (e) {}
        }

        // Forward to Boom Box tab
        const bbTabId = await resolveBoomBoxTab();
        if (bbTabId) {
          try {
            await chrome.tabs.sendMessage(bbTabId, {
              type: 'YT_STATE_CHANGED',
              payload: statePayload
            });
          } catch (e) {}
        }

        sendResponse({ success: true });
        return;
      }

      // Feature: YT_TAB_ACTIVATED - User clicked anywhere in YouTube page to grant playback permission
      if (type === 'YT_TAB_ACTIVATED') {
        hasSessionActivation = true;
        recordTrace('background', 'YT_TAB_ACTIVATED_RELAYED', {
          precedingTabBeforeActivation,
          userSwitchedTabDuringActivation
        });

        // Immediately switch back to the remembered tab if user did not switch tabs themselves
        if (!userSwitchedTabDuringActivation && precedingTabBeforeActivation) {
          try {
            await chrome.tabs.update(precedingTabBeforeActivation, { active: true });
            recordTrace('background', 'SESSION_ACTIVATION_SWITCH_BACK_SUCCESS', {
              targetTabId: precedingTabBeforeActivation
            });
          } catch (e) {
            recordTrace('background', 'SESSION_ACTIVATION_SWITCH_BACK_ERROR', { error: e.message });
          }
        }
        precedingTabBeforeActivation = null;
        sessionActivationPromptTabId = null;

        // If a Play command was pending while waiting for activation, send PLAY once now and clear it
        if (pendingPlayIntent && pendingPlayIntent.tabId) {
          const targetTabId = pendingPlayIntent.tabId;
          clearPendingPlayIntent('executed_on_activation');
          recordTrace('background', 'PENDING_PLAY_INTENT_EXECUTING', { targetTabId });
          try {
            chrome.tabs.sendMessage(targetTabId, { action: 'PLAY' }).catch(() => {});
          } catch (e) {}
        }

        const retroTabId = await resolveRetroFmTab();
        if (retroTabId) {
          try {
            await chrome.tabs.sendMessage(retroTabId, { type: 'YT_TAB_ACTIVATED' });
          } catch (e) {}
        }
        const bbTabId = await resolveBoomBoxTab();
        if (bbTabId) {
          try {
            await chrome.tabs.sendMessage(bbTabId, { type: 'YT_TAB_ACTIVATED' });
          } catch (e) {}
        }
        sendResponse({ success: true });
        return;
      }

      // Feature: RECORD_TRACE - receives trace entry from any context and appends to unified log
      if (type === 'RECORD_TRACE') {
        const entry = payload || request.entry;
        if (entry && typeof entry === 'object') {
          recordTrace(entry.source, entry.event, entry.data);
        }
        sendResponse({ success: true });
        return;
      }

      // Feature: GET_TRANSPORT_TRACE - returns complete unified time-ordered trace log
      if (type === 'GET_TRANSPORT_TRACE') {
        sendResponse({ success: true, data: { traceLog: [...transportTraceLog] } });
        return;
      }

      // Feature: AUDIO_DIAGNOSTICS_SNAPSHOT - receives snapshot from content_youtube.js / yt_main_world.js
      if (type === 'AUDIO_DIAGNOSTICS_SNAPSHOT') {
        const snap = payload?.snapshot || payload;
        if (snap && typeof snap === 'object') {
          latestAudioDiagnosticsSnapshot = snap;
          recordAudioDiagnosticsEvent('SNAPSHOT_RECEIVED', {
            reason: payload?.reason || 'update',
            playerState: snap.playerState,
            videoPaused: snap.videoPaused,
            videoMuted: snap.videoMuted,
            videoVolume: snap.videoVolume,
            visibilityState: snap.visibilityState,
            hasBeenActive: snap.userActivation?.hasBeenActive,
            title: snap.title
          });
          if (chrome.storage?.session) {
            chrome.storage.session.set({
              latestAudioDiagnosticsSnapshot,
              audioDiagnosticsEvents
            }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        return;
      }

      // Feature: GET_AUDIO_DIAGNOSTICS - returns latest snapshot plus last 40 events with timestamps
      if (type === 'GET_AUDIO_DIAGNOSTICS') {
        // Request fresh snapshot on-demand if YouTube tab is connected
        if (activeConnectedTabId) {
          try {
            chrome.tabs.sendMessage(activeConnectedTabId, { action: 'GET_DIAGNOSTICS_SNAPSHOT' }).catch(() => {});
          } catch (e) {}
        }
        sendResponse({
          success: true,
          data: {
            snapshot: latestAudioDiagnosticsSnapshot,
            events: [...audioDiagnosticsEvents]
          }
        });
        return;
      }

      // Feature: BOOMBOX_ACTION - routes user command from Boom Box tab to RetroFM app
      if (type === 'BOOMBOX_ACTION') {
        try {
          if (sender?.tab?.id) activeBoomBoxTabId = sender.tab.id;
          const actionName = (payload?.action || '').toUpperCase();
          if (actionName === 'STOP' || actionName === 'PAUSE') {
            clearPendingPlayIntent(`boombox_${actionName.toLowerCase()}`);
          }
          const retroTabId = await resolveRetroFmTab();
          recordTrace('background', 'BOOMBOX_ACTION_ARRIVED', {
            action: payload?.action,
            payload,
            forwardTarget: retroTabId ? `tab:${retroTabId}` : 'none'
          });
          if (!retroTabId) {
            recordTrace('background', 'BOOMBOX_ACTION_ROUTING_FAILED', {
              action: payload?.action,
              reason: 'RetroFM app not connected'
            });
            sendResponse({ success: false, error: 'RetroFM app not connected' });
            return;
          }

          const res = await chrome.tabs.sendMessage(retroTabId, {
            type: 'BOOMBOX_ACTION',
            payload
          });
          recordTrace('background', 'BOOMBOX_ACTION_FORWARDED_SUCCESS', {
            action: payload?.action,
            targetTab: retroTabId
          });
          sendResponse({ success: true, data: res });
        } catch (err) {
          recordTrace('background', 'BOOMBOX_ACTION_FORWARDED_ERROR', {
            action: payload?.action,
            error: err.message
          });
          sendResponse({ success: false, error: err.message });
        }
        return;
      }

      // Feature: BROADCAST_RADIO_STATE - caches and relays live radio state from app to Boom Box
      if (type === 'BROADCAST_RADIO_STATE') {
        try {
          if (sender?.tab?.id) {
            await setStoredRegisteredAppTabId(sender.tab.id);
          }
          lastKnownRadioState = { ...payload, appConnected: true, timestamp: Date.now() };

          // Forward to Boom Box tab if open
          const bbTabId = await resolveBoomBoxTab();
          recordTrace('background', 'BROADCAST_RADIO_STATE_ARRIVED', {
            playbackStatus: payload?.playbackStatus,
            currentSong: payload?.currentSong?.title || null,
            forwardTarget: bbTabId ? `tab:${bbTabId}` : 'none'
          });
          if (bbTabId) {
            try {
              await chrome.tabs.sendMessage(bbTabId, {
                type: 'RADIO_STATE',
                payload: lastKnownRadioState
              });
              recordTrace('background', 'BROADCAST_RADIO_STATE_FORWARDED', {
                targetTab: bbTabId
              });
            } catch (sendErr) {
              // Tab might be busy or navigating
            }
          }

          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        return;
      }

      // Feature: GET_RADIO_STATE - Boom Box requests current state upon mount or reconnect
      if (type === 'GET_RADIO_STATE') {
        try {
          if (sender?.tab?.id) activeBoomBoxTabId = sender.tab.id;
          const retroTabId = await resolveRetroFmTab();
          if (!retroTabId) {
            sendResponse({
              success: false,
              error: 'RetroFM app not connected',
              data: { appConnected: false, playbackStatus: 'stopped' }
            });
            return;
          }

          let freshState = null;
          try {
            await chrome.tabs.sendMessage(retroTabId, {
              type: 'GET_RADIO_STATE_REQUEST'
            });
            if (lastKnownRadioState) {
              lastKnownRadioState.appConnected = true;
              freshState = lastKnownRadioState;
            }
          } catch (msgErr) {
            await clearStoredRegisteredAppTabId();
            sendResponse({
              success: false,
              error: 'RetroFM app not connected',
              data: { appConnected: false, playbackStatus: 'stopped' }
            });
            return;
          }

          if (!freshState && lastKnownRadioState) {
            freshState = { ...lastKnownRadioState, appConnected: true };
          }

          sendResponse({
            success: true,
            data: freshState || { appConnected: true, playbackStatus: 'stopped' }
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
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
        let status = null;
        try {
          status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
        } catch (err) {
          // If first message failed, retry once after script injection
          await ensureYouTubeScriptInjected(resolvedId);
          try {
            status = await chrome.tabs.sendMessage(resolvedId, { action: 'GET_STATUS' });
          } catch (retryErr) {
            status = { available: true };
          }
        }

        // Check if one-time session activation is needed
        const askForOneTimeClick = payload?.askForOneTimeClick !== false;
        const hasActiveClick = !!(latestAudioDiagnosticsSnapshot?.userActivation?.hasBeenActive);
        if (!hasActiveClick && !hasSessionActivation) {
          triggerOneTimeSessionActivation(resolvedId, askForOneTimeClick).catch(() => {});
        } else {
          hasSessionActivation = true;
        }

        sendResponse({ success: true, data: { tabId: resolvedId, status } });
        return;
      }

      if (type === 'COMMAND_YOUTUBE') {
        const tabId = await resolveYouTubeTab(payload?.tabId);
        if (!tabId) {
          sendResponse({ success: false, error: 'No YouTube tab connected.' });
          return;
        }

        const actionName = (payload?.command?.action || '').toUpperCase();
        if (actionName === 'STOP' || actionName === 'PAUSE') {
          clearPendingPlayIntent(`command_${actionName.toLowerCase()}`);
        } else if (actionName === 'PLAY') {
          const hasActiveClick = !!(latestAudioDiagnosticsSnapshot?.userActivation?.hasBeenActive);
          if (!hasActiveClick && !hasSessionActivation) {
            storePendingPlayIntent(tabId);
          } else {
            clearPendingPlayIntent('playback_with_activation');
          }
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

        if (payload?.command?.action === 'PLAY') {
          checkAndRecoverHiddenTabPlayback(tabId, payload?.revealYouTubeToStart !== false).catch(() => {});
        }
        return;
      }

      if (type === 'NAVIGATE_YOUTUBE') {
        const tabId = await resolveYouTubeTab(payload?.tabId);
        if (!tabId) {
          recordTrace('background', 'NAVIGATE_YOUTUBE_FAILED', { reason: 'No YouTube tab connected' });
          sendResponse({ success: false, error: 'No YouTube tab connected. Please open youtube.com in another tab.' });
          return;
        }

        const videoId = payload?.videoId;
        const targetUrl = payload?.url || (videoId ? ('https://www.youtube.com/watch?v=' + videoId) : null);
        if (!targetUrl) {
          recordTrace('background', 'NAVIGATE_YOUTUBE_FAILED', { reason: 'No video ID or URL' });
          sendResponse({ success: false, error: 'No YouTube video ID or URL provided for navigation.' });
          return;
        }

        activeConnectedTabId = tabId;
        recordTrace('background', 'NAVIGATE_YOUTUBE_START', {
          tabId,
          videoId: videoId || null,
          targetUrl,
          reason: payload?.reason || 'program_song'
        });

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

          // 2.5 Apply requested targetVolume BEFORE telling video to play
          const targetVol = typeof payload?.targetVolume === 'number' ? payload.targetVolume : null;
          if (targetVol !== null) {
            try {
              await chrome.tabs.sendMessage(tabId, { action: 'SET_VOLUME', volume: targetVol, rampId: Date.now() });
            } catch (volErr) {
              console.warn('[Retro FM] Pre-play setVolume notice:', volErr);
            }
          }

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
            checkAndRecoverHiddenTabPlayback(tabId, payload?.revealYouTubeToStart !== false).catch(() => {});
            sendResponse({
              success: true,
              data: {
                tabId,
                url: targetUrl,
                status: playResult.status
              }
            });
          } else {
            checkAndRecoverHiddenTabPlayback(tabId, payload?.revealYouTubeToStart !== false).catch(() => {});
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

// 3. Monitor tab closures for reliable connection recovery
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeConnectedTabId) {
    activeConnectedTabId = null;
  }
  if (tabId === activeBoomBoxTabId) {
    activeBoomBoxTabId = null;
  }
  const currentRegisteredId = await getStoredRegisteredAppTabId();
  if (tabId === activeRetroFmTabId || tabId === currentRegisteredId) {
    await clearStoredRegisteredAppTabId();
    if (lastKnownRadioState) {
      lastKnownRadioState.appConnected = false;
      const bbTabId = await resolveBoomBoxTab();
      if (bbTabId) {
        try {
          chrome.tabs.sendMessage(bbTabId, {
            type: 'RADIO_STATE',
            payload: { ...lastKnownRadioState, appConnected: false }
          });
        } catch (e) {}
      }
    }
  }
});


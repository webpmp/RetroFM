# Retro FM Chrome Extension Bridge (v1.0.4)

This extension provides the permitted communication bridge between the Retro FM Web App and your YouTube tab, including automatic tab group creation.

## Quick 3-Step Setup & Reload

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** (or click the **Reload icon ↻** on the existing card) and select the unzipped `extension` folder.

## Key Features in v1.0.4
- **Launch Retro FM (Chrome Tab Group)**: Opens `https://www.youtube.com` next to Retro FM and groups both tabs into a distinctive orange **"Retro FM"** Chrome Tab Group (`chrome.tabs.group` and `chrome.tabGroups`).
- **NAVIGATE_YOUTUBE Command**: Directly navigates the connected YouTube tab to a requested video ID or URL and starts playback.
- **Direct Web Messaging (`externally_connectable`)**: Communicates directly with Retro FM without depending on DOM content script injection.
- **Fixed Extension ID**: `hjphfmcilldbipolljlbjnnadeogocab`

## Permissions Used
- `tabs`: Allows the extension to find and manage your open tabs.
- `tabGroups`: Allows the extension to create and organize the "Retro FM" tab group.
- `scripting`: Allows dynamic injection into YouTube tabs.
- `host_permissions` (`*://*.youtube.com/*`, etc.): Allows permitted communication with the YouTube video element for reading title, playback state, and volume ducking.

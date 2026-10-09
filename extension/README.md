# Retro FM Chrome Extension Bridge

This extension provides the permitted communication bridge between the Retro FM Web App and your YouTube tab, including automatic tab group creation.

## Quick 3-Step Setup & Reload

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** (or click the **Reload icon ↻** on the existing card) and select the unzipped `extension` folder.

## Key Features
- **Launch Retro FM (Chrome Tab Group)**: Opens `https://www.youtube.com` next to Retro FM and groups both tabs into a distinctive orange **"Retro FM"** Chrome Tab Group (`chrome.tabs.group` and `chrome.tabGroups`).
- **NAVIGATE_YOUTUBE Command**: Directly navigates the connected YouTube tab to a requested video ID or URL and starts playback.
- **Direct Web Messaging (`externally_connectable`)**: Communicates directly with Retro FM without depending on DOM content script injection.
- **Fixed Extension ID**: `hjphfmcilldbipolljlbjnnadeogocab`

## Permissions Used
- `tabs`: Allows the extension to find and manage your open tabs.
- `tabGroups`: Allows the extension to create and organize the "Retro FM" tab group.
- `scripting`: Allows dynamic injection into YouTube tabs.
- `host_permissions` (`*://*.youtube.com/*`, etc.): Allows permitted communication with the YouTube video element for reading title, playback state, and volume ducking.

## Attribution
- **Author**: Chris Adkins
- **Repository**: [https://github.com/webpmp/RetroFM](https://github.com/webpmp/RetroFM)

## License
This extension and project are licensed under the MIT License. See the `LICENSE` file for details.

## Support / Contact
To report bugs, suggest features, or ask questions, please open an issue at:
[https://github.com/webpmp/RetroFM/issues](https://github.com/webpmp/RetroFM/issues)

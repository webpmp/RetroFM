# RetroFM Chrome Extension Bridge

This extension provides the permitted communication bridge between the RetroFM Web App and your YouTube tab, including automatic tab group creation.

## Installation & Updating

### First Time Setup
1. Download the extension ZIP and unzip it to a permanent folder you'll keep (for example, `Documents/retrofm-extension`).
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Toggle the **Developer mode** switch in the top-right corner to **ON**.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the unzipped `retrofm-extension` folder.
6. Return to RetroFM and click **Launch RetroFM** to connect!

### Updating to a New Version
1. Download the updated ZIP package.
2. Unzip the new files directly into your existing extension folder (`Documents/retrofm-extension`), replacing the previous files.
3. Open `chrome://extensions/`.
4. Click the **Reload icon ↻** on the RetroFM extension card (do not remove or uninstall the card).
5. Refresh your RetroFM and YouTube browser tabs.

## Key Features
- **Launch RetroFM (Chrome Tab Group)**: Opens `https://www.youtube.com` next to RetroFM and groups both tabs into a distinctive orange **"RetroFM"** Chrome Tab Group (`chrome.tabs.group` and `chrome.tabGroups`).
- **NAVIGATE_YOUTUBE Command**: Directly navigates the connected YouTube tab to a requested video ID or URL and starts playback.
- **Direct Web Messaging (`externally_connectable`)**: Communicates directly with RetroFM without depending on DOM content script injection.
- **Fixed Extension ID**: `hjphfmcilldbipolljlbjnnadeogocab`

## Permissions Used
- `tabs`: Allows the extension to find and manage your open tabs.
- `tabGroups`: Allows the extension to create and organize the "RetroFM" tab group.
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

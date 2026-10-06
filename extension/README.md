# Retro FM Chrome Extension Bridge

This extension provides the permitted communication bridge between the Retro FM Test Page and your YouTube tab.

## Quick 3-Step Setup

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** in the top-left and select the `extension` folder from this project (or download the zip package directly from the Retro FM test page!).

## Permissions Used
- `tabs`: Allows the extension to find your open YouTube tab so you don't have to copy-paste tab IDs or inspect the DOM.
- `host_permissions` (`*://*.youtube.com/*`, etc.): Allows permitted communication with the YouTube video element for reading title, playback state, and volume ducking.
- No ads are blocked, no audio is extracted or downloaded, and YouTube's terms of service and media pipelines are fully respected.

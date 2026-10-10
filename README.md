# RetroFM

RetroFM is an AI-powered historical radio simulator and broadcast mixer that recreates authentic, era-accurate radio broadcasts for any chosen historical date. By combining real historical news facts from the New York Times Archive API, music lookup and video playback via YouTube, automatic real-time audio ducking through a companion Chrome extension bridge, and customizable DJ personalities (Mike & Lisa) driven by Google Gemini Flash Text-to-Speech and native browser speech engines, RetroFM delivers an immersive, interactive recreation of listening to top-40 radio in decades past.

---

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- npm
- Google Chrome (to use the companion Chrome extension bridge)

### Installation
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Add your API keys to `.env` (see [Environment Variables](#environment-variables)).

3. Run the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in Google Chrome.

4. Build for production:
   ```bash
   npm run build
   npm run start
   ```

---

## Environment Variables

Configure the following variables in your local `.env` file (do not commit real values to version control):

| Variable | Description | Required / Optional |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Google Gemini API key for script generation and Flash Text-to-Speech audio synthesis. | **Required** |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key for searching songs and verifying music duration metadata. | **Required** |
| `NYT_API_KEY` | New York Times API key for querying historical articles from the NYT Archive API. | **Required** |
| `GEMINI_TEXT_MODEL` | Primary Gemini model for DJ break script writing (defaults to `gemini-3.8-flash`). | Optional |
| `GEMINI_TEXT_MODEL_FALLBACK` | Fallback Gemini model invoked if the primary model is busy or times out (e.g. `gemini-2.5-flash`). | Optional |

---

## Companion Chrome Extension Installation & Updating

RetroFM includes a companion Chrome extension that provides bidirectional tab communication, YouTube playback control, smooth audio ducking ramps, and tab grouping.

> **Tip**: Web browsers prevent pages from directly linking to `chrome://` URLs. RetroFM provides a convenient **"Copy chrome://extensions"** button right in the app header and modal.

### First Time Setup
1. Download the extension ZIP (click **Download Extension** in the RetroFM app or download from the repository).
2. Unzip the archive to a folder you will keep (for example, `Documents/retrofm-extension`).
3. In Google Chrome, navigate to `chrome://extensions/`.
4. Turn on the **Developer mode** toggle in the top-right corner.
5. Click **Load unpacked** in the top-left corner and select your `retrofm-extension` folder.
6. Return to RetroFM and click **Launch RetroFM** to automatically open YouTube and group both tabs into an orange "RetroFM" Chrome Tab Group.

### Updating to a New Version
1. Download the new version ZIP package from the RetroFM app.
2. Unzip into the **same folder** (`Documents/retrofm-extension`) and replace existing files.
3. Open `chrome://extensions/`.
4. Click the **Reload arrow ↻** on the RetroFM card (do not remove the card).
5. Refresh your RetroFM and YouTube tabs.

---

## Project Structure

- `src/` &ndash; React application source code, UI components, and state management.
  - `src/services/audio/` &ndash; Central `VolumeController` managing volume ducking, restoring, watchdog monitoring, and ramp IDs.
  - `src/services/music/` &ndash; YouTube music search, playlist timing models, and music provider abstraction.
  - `src/services/news/` &ndash; NYT Archive API provider, national focus filter, category normalizer, and interest scoring.
  - `src/services/djBreak/` &ndash; Two-step DJ break script generation, anachronism audit, and caching.
- `extension/` &ndash; Manifest V3 Chrome extension bridge source files and icons.
- `scripts/` &ndash; Utility scripts (`bump-extension.ts`, `test-music-search.ts`).
- `server.ts` &ndash; Express full-stack proxy server and Vite middleware integration.

---

## License & Third-Party Content Notice

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for the complete text.

**Important Notice**: The MIT License covers only the software code of this application and its companion extension. It does not cover or grant rights to any third-party music recordings, audio streams, YouTube video content, third-party trademarks, logos, or news articles retrieved from upstream APIs. All trademarks, music recordings, and news content belong exclusively to their respective copyright holders.

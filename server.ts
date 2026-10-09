import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GeminiTTSProvider } from './src/services/tts/GeminiTTSProvider.js';
import { createZipFromDirectory } from './src/server/zipUtil.js';
import {
  searchYouTubeForSong,
  clearSearchCache,
  getSessionQuota,
} from './src/services/music/songSearch.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Instantiate TTS Provider
  const ttsProvider = new GeminiTTSProvider();

  // API Route: Generate Gemini Flash TTS DJ speech
  app.post('/api/tts/generate', async (req, res) => {
    try {
      const { text, voice, style, model } = req.body;

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, error: 'A script text is required.' });
      }

      console.log(`[API /api/tts/generate] Received request for text: "${text.substring(0, 40)}..."`);
      const result = await ttsProvider.generate({ text, voice, style, model });

      return res.json({
        success: true,
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        modelUsed: result.modelUsed,
        durationSeconds: result.durationSeconds,
      });
    } catch (err: any) {
      const errMsg = err?.message || '';
      const isQuota = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota');
      if (isQuota) {
        console.warn('[API /api/tts/generate] Gemini Free Tier daily quota limit reached (10 requests/day). Suggesting Browser Speech engine.');
        return res.status(200).json({
          success: false,
          quotaExceeded: true,
          error: 'Gemini API Free Tier daily audio quota reached (10 requests/day). Auto-switching to Instant Browser Voice.',
        });
      }

      console.error('[API /api/tts/generate] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to generate speech with Gemini TTS',
      });
    }
  });

  // Canonical 5-Song Verification Suite
  const CANONICAL_TEST_CASES = [
    { artist: 'a-ha', song: 'Take on Me', year: '1985' },
    { artist: 'Michael Jackson', song: 'Billie Jean', year: '1983' },
    { artist: 'Prince', song: 'When Doves Cry', year: '1984' },
    { artist: 'U2', song: 'With or Without You', year: '1987' },
    { artist: 'Peter Gabriel', song: 'Sledgehammer', year: '1986' },
  ];

  // API Route: Program song search & selection
  app.post('/api/music/search', async (req, res) => {
    try {
      const { artist, song, year, forceFresh } = req.body;
      if (!artist || !song) {
        return res.status(400).json({
          success: false,
          error: 'Artist and song title are required.',
        });
      }

      console.log(`[API /api/music/search] Query: "${artist} - ${song}" (${year || 'any year'})${forceFresh ? ' [Force Fresh]' : ''}`);
      const result = await searchYouTubeForSong(artist, song, year, {
        forceFresh: Boolean(forceFresh),
      });
      return res.json({
        ...result,
        quota: getSessionQuota(),
      });
    } catch (err: any) {
      console.error('[API /api/music/search] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to search YouTube for song',
        quota: getSessionQuota(),
      });
    }
  });

  // API Route: Check music status, API key presence, and session quota
  app.get('/api/music/status', (req, res) => {
    const hasKey = Boolean(process.env.YOUTUBE_API_KEY);
    return res.json({
      success: true,
      hasYouTubeApiKey: hasKey,
      keyLength: hasKey ? (process.env.YOUTUBE_API_KEY as string).length : 0,
      quota: getSessionQuota(),
      timestamp: new Date().toISOString(),
    });
  });

  // API Route: Test one individual song
  app.post('/api/music/test-song', async (req, res) => {
    const hasKey = Boolean(process.env.YOUTUBE_API_KEY);
    if (!hasKey) {
      return res.status(400).json({
        success: false,
        hasYouTubeApiKey: false,
        error:
          'YouTube Data API key is missing (YOUTUBE_API_KEY environment variable is not set). Please provide a valid YouTube Data API v3 key to run searches.',
        quota: getSessionQuota(),
      });
    }

    try {
      const { songIndex, artist, song, year, forceFresh } = req.body;
      let targetItem = { artist: '', song: '', year: '' };

      if (typeof songIndex === 'number' && songIndex >= 0 && songIndex < CANONICAL_TEST_CASES.length) {
        targetItem = CANONICAL_TEST_CASES[songIndex];
      } else if (artist && song) {
        targetItem = { artist, song, year: year || '' };
      } else {
        return res.status(400).json({
          success: false,
          error: 'Valid songIndex (0-4) or artist & song are required.',
        });
      }

      console.log(
        `[API /api/music/test-song] Running single song test: ${targetItem.artist} - ${targetItem.song} (${targetItem.year || 'N/A'})${
          forceFresh ? ' [Force Fresh Search]' : ' [Cache Allowed]'
        }`
      );

      // Skip overrides to prove that the official search algorithm is being tested
      const searchResult = await searchYouTubeForSong(targetItem.artist, targetItem.song, targetItem.year, {
        skipOverrides: true,
        forceFresh: Boolean(forceFresh),
      });

      let allCandidates = searchResult.candidates && searchResult.candidates.length > 0 ? [...searchResult.candidates] : [];
      if (searchResult.rejectedCandidates && allCandidates.length < 5) {
        allCandidates = [...allCandidates, ...searchResult.rejectedCandidates];
      }

      const formattedResult = {
        song: targetItem,
        songIndex: typeof songIndex === 'number' ? songIndex : undefined,
        success: searchResult.success,
        status: searchResult.status || (searchResult.success ? 'ok' : 'not_found'),
        selected: searchResult.selected || null,
        candidates: allCandidates.slice(0, 5),
        canonicalInfo: searchResult.canonicalInfo || null,
        error: searchResult.error || null,
      };

      return res.json({
        success: true,
        hasYouTubeApiKey: true,
        result: formattedResult,
        quota: getSessionQuota(),
      });
    } catch (err: any) {
      console.error('[API /api/music/test-song] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Error occurred while testing song.',
        quota: getSessionQuota(),
      });
    }
  });

  // API Route: Run 5-song test suite through YouTube Data API v3 and ranking algorithm
  app.post('/api/music/test-suite', async (req, res) => {
    const hasKey = Boolean(process.env.YOUTUBE_API_KEY);
    if (!hasKey) {
      return res.status(400).json({
        success: false,
        hasYouTubeApiKey: false,
        error:
          'YouTube Data API key is missing (YOUTUBE_API_KEY environment variable is not set). Please provide a valid YouTube Data API v3 key to run live searches.',
        quota: getSessionQuota(),
      });
    }

    const forceFresh = Boolean(req.body?.forceFresh);

    try {
      console.log(
        `[API /api/music/test-suite] Starting 5-song verification suite${
          forceFresh ? ' (FORCE FRESH: bypassing disk cache)' : ' (USING CACHE BY DEFAULT)'
        }...`
      );

      if (forceFresh) {
        clearSearchCache(false);
      }

      const results = [];

      for (let i = 0; i < CANONICAL_TEST_CASES.length; i++) {
        const item = CANONICAL_TEST_CASES[i];
        console.log(`[API /api/music/test-suite] Processing #${i + 1}: ${item.artist} - ${item.song} (${item.year})`);

        // Skip overrides to prove that the official search algorithm is being tested
        const searchResult = await searchYouTubeForSong(item.artist, item.song, item.year, {
          skipOverrides: true,
          forceFresh,
        });

        let allCandidates = searchResult.candidates && searchResult.candidates.length > 0 ? [...searchResult.candidates] : [];
        if (searchResult.rejectedCandidates && allCandidates.length < 5) {
          allCandidates = [...allCandidates, ...searchResult.rejectedCandidates];
        }

        results.push({
          song: item,
          songIndex: i,
          success: searchResult.success,
          status: searchResult.status || (searchResult.success ? 'ok' : 'not_found'),
          selected: searchResult.selected || null,
          candidates: allCandidates.slice(0, 5),
          canonicalInfo: searchResult.canonicalInfo || null,
          error: searchResult.error || null,
        });

        // Respect MusicBrainz rate limit if doing fresh lookups
        if (i < CANONICAL_TEST_CASES.length - 1 && forceFresh) {
          await new Promise((r) => setTimeout(r, 1100));
        }
      }

      console.log('[API /api/music/test-suite] Completed all 5 tests.');
      return res.json({
        success: true,
        hasYouTubeApiKey: true,
        results,
        quota: getSessionQuota(),
      });
    } catch (err: any) {
      console.error('[API /api/music/test-suite] Error executing test suite:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Error occurred while executing test suite.',
        quota: getSessionQuota(),
      });
    }
  });

  // API Route: Download Extension ZIP package
  app.get('/api/extension/download', (req, res) => {
    try {
      const extensionDir = path.resolve(__dirname, 'extension');
      if (!fs.existsSync(extensionDir)) {
        return res.status(404).send('Extension folder not found');
      }

      const zipBuffer = createZipFromDirectory(extensionDir);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="retro-fm-extension.zip"');
      res.setHeader('Content-Length', zipBuffer.length.toString());
      return res.end(zipBuffer);
    } catch (err: any) {
      console.error('[API /api/extension/download] Error creating zip:', err);
      return res.status(500).send('Failed to package extension: ' + err.message);
    }
  });

  // API Route: Get extension files metadata and raw contents for easy UI inspection
  app.get('/api/extension/files', (req, res) => {
    try {
      const extensionDir = path.resolve(__dirname, 'extension');
      const fileNames = ['manifest.json', 'content_youtube.js', 'content_retrofm.js', 'background.js', 'popup.html', 'README.md'];
      const files: Record<string, string> = {};

      for (const name of fileNames) {
        const fullPath = path.join(extensionDir, name);
        if (fs.existsSync(fullPath)) {
          files[name] = fs.readFileSync(fullPath, 'utf8');
        }
      }

      return res.json({ success: true, files });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
      timestamp: new Date().toISOString(),
    });
  });

  // Serve Vite in dev or static dist in production
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve(__dirname, 'dist'))) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Retro FM Server] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Retro FM Server] Startup error:', err);
  process.exit(1);
});

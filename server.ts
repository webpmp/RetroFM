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
import {
  buildFactPacket,
  getProviderConfigStatus,
  getNewsSessionStats,
} from './src/services/news/factPacketService.js';
import {
  generateDJBreaksService,
  generateDJBreaksStep1Service,
  auditDJBreaksStep2Service,
  getDJBreakSessionStats,
} from './src/services/djBreak/djBreakService.js';

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

      const manifestPath = path.join(extensionDir, 'manifest.json');
      let version = '1.0.5';
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (m.version) version = m.version;
        } catch (e) {
          // fallback
        }
      }

      const folderName = `retro-fm-extension-v${version}`;
      const zipFilename = `retro-fm-extension-v${version}.zip`;
      const zipBuffer = createZipFromDirectory(extensionDir, folderName);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
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
      const fileNames = ['manifest.json', 'content_youtube.js', 'content_retrofm.js', 'background.js', 'popup.html', 'README.md', 'LICENSE'];
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

  // API Route: Get news providers configuration status & session call statistics
  app.get('/api/news/status', (req, res) => {
    try {
      const providers = getProviderConfigStatus();
      const stats = getNewsSessionStats();
      return res.json({
        success: true,
        providers,
        stats,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  });

  // API Route: Build Historical Fact Packet for targetDate
  app.post('/api/news/facts', async (req, res) => {
    try {
      const { targetDate, forceFresh, nationalFocus } = req.body;
      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate string (YYYY-MM-DD) is required.' });
      }

      const isNationalFocus = nationalFocus !== false;
      console.log(`[API /api/news/facts] Generating fact packet for date: ${targetDate} (forceFresh=${Boolean(forceFresh)}, nationalFocus=${isNationalFocus})`);
      const packet = await buildFactPacket(targetDate, Boolean(forceFresh), ['nyt'], isNationalFocus);
      const stats = getNewsSessionStats();

      return res.json({
        success: true,
        packet,
        stats,
      });
    } catch (err: any) {
      console.error('[API /api/news/facts] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed generating historical fact packet',
      });
    }
  });

  // API Route: Get DJ Break generator session metrics
  app.get('/api/dj-break/stats', (req, res) => {
    try {
      const stats = getDJBreakSessionStats();
      return res.json({ success: true, stats });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message });
    }
  });

  // API Route: Step 1 of 2 - Generate 3 DJ Breaks scripts (fast return, status "CHECKING")
  app.post('/api/dj-break/step1-write', async (req, res) => {
    try {
      const {
        targetDate,
        personality,
        timeOfDay,
        format,
        songPlayed,
        songNext,
        secondsAvailable,
        forceFresh,
        nationalFocus,
      } = req.body;

      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      const isNationalFocus = nationalFocus !== false;
      console.log(`[API /api/dj-break/step1-write] Writing breaks for ${targetDate}, personality: ${personality}, ${secondsAvailable}s (forceFresh=${Boolean(forceFresh)}, nationalFocus=${isNationalFocus})`);

      const result = await generateDJBreaksStep1Service({
        targetDate,
        personality: personality || 'mike',
        timeOfDay: timeOfDay || 'afternoon',
        format: format || 'Top 40',
        songPlayed: songPlayed || 'a-ha - Take on Me',
        songNext: songNext || 'Michael Jackson - Billie Jean',
        secondsAvailable: Number(secondsAvailable) || 12,
        forceFresh: Boolean(forceFresh),
        nationalFocus: isNationalFocus,
      });

      const stats = getDJBreakSessionStats();
      const statusCode = result.success ? 200 : result.quotaExceeded ? 429 : result.stepTimedOut ? 504 : result.isUnavailable ? 503 : 500;

      return res.status(statusCode).json({
        ...result,
        stats,
      });
    } catch (err: any) {
      console.error('[API /api/dj-break/step1-write] Error:', err);
      const isQuota =
        err?.message?.includes('429') ||
        err?.message?.includes('RESOURCE_EXHAUSTED') ||
        err?.message?.includes('quota');
      const isTimeout = (err?.message || '').toLowerCase().includes('timeout') || err?.isTimeout;

      return res.status(isQuota ? 429 : isTimeout ? 504 : 500).json({
        success: false,
        quotaExceeded: isQuota,
        stepTimedOut: isTimeout ? 'step1' : null,
        error: err?.message || 'Failed generating Step 1 DJ breaks',
        stats: getDJBreakSessionStats(),
      });
    }
  });

  // API Route: Step 2 of 2 - Run anachronism audit on the generated breaks
  app.post('/api/dj-break/step2-audit', async (req, res) => {
    try {
      const {
        breaks,
        targetDate,
        modelUsed,
        personality,
        timeOfDay,
        format,
        songPlayed,
        songNext,
        secondsAvailable,
        nationalFocus,
        providedFactItems,
      } = req.body;

      if (!Array.isArray(breaks) || breaks.length === 0) {
        return res.status(400).json({ success: false, error: 'breaks array is required.' });
      }
      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      console.log(`[API /api/dj-break/step2-audit] Auditing ${breaks.length} breaks for ${targetDate}`);

      const result = await auditDJBreaksStep2Service({
        breaks,
        targetDate,
        modelUsed,
        personality,
        timeOfDay,
        format,
        songPlayed,
        songNext,
        secondsAvailable: Number(secondsAvailable) || 12,
        nationalFocus: nationalFocus !== false,
        providedFactItems,
      });

      const stats = getDJBreakSessionStats();

      return res.json({
        ...result,
        stats,
      });
    } catch (err: any) {
      console.error('[API /api/dj-break/step2-audit] Error:', err);
      const isTimeout = (err?.message || '').toLowerCase().includes('timeout') || err?.isTimeout;

      return res.json({
        success: false,
        auditUnavailable: true,
        stepTimedOut: isTimeout ? 'step2' : null,
        error: err?.message || 'Failed auditing breaks for anachronisms',
        breaks: req.body?.breaks || [],
        stats: getDJBreakSessionStats(),
      });
    }
  });

  // API Route: Generate 3 DJ Breaks with anachronism check
  app.post('/api/dj-break/generate', async (req, res) => {
    try {
      const {
        targetDate,
        personality,
        timeOfDay,
        format,
        songPlayed,
        songNext,
        secondsAvailable,
        forceFresh,
        nationalFocus,
      } = req.body;

      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      const isNationalFocus = nationalFocus !== false;
      console.log(`[API /api/dj-break/generate] Generating breaks for ${targetDate}, personality: ${personality}, ${secondsAvailable}s (forceFresh=${Boolean(forceFresh)}, nationalFocus=${isNationalFocus})`);

      const result = await generateDJBreaksService({
        targetDate,
        personality: personality || 'mike',
        timeOfDay: timeOfDay || 'afternoon',
        format: format || 'Top 40',
        songPlayed: songPlayed || 'a-ha - Take on Me',
        songNext: songNext || 'Michael Jackson - Billie Jean',
        secondsAvailable: Number(secondsAvailable) || 12,
        forceFresh: Boolean(forceFresh),
        nationalFocus: isNationalFocus,
      });

      const stats = getDJBreakSessionStats();

      return res.json({
        ...result,
        stats,
      });
    } catch (err: any) {
      console.error('[API /api/dj-break/generate] Error:', err);
      const isQuota =
        err?.message?.includes('429') ||
        err?.message?.includes('RESOURCE_EXHAUSTED') ||
        err?.message?.includes('quota');

      return res.status(isQuota ? 429 : 500).json({
        success: false,
        quotaExceeded: isQuota,
        error: err?.message || 'Failed generating DJ breaks',
        stats: getDJBreakSessionStats(),
      });
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

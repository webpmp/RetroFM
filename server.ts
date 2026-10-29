import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GeminiTTSProvider } from './src/services/tts/GeminiTTSProvider.js';
import { KokoroTTSProvider } from './src/services/tts/KokoroTTSProvider.js';
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
import { LMStudioScriptWriterProvider } from './src/services/djBreak/LMStudioScriptWriterProvider.js';
import { GeminiScriptWriterProvider } from './src/services/djBreak/GeminiScriptWriterProvider.js';
import {
  decideAndSelectBreak,
  SongCreditRepository,
} from './src/services/djBreak/breakDecisionEngine.js';
import { ChartFactRepository, computeChartFacts, computeNationalNumberOneFact } from './src/services/djBreak/chartFacts.js';
import { BreakSelectionSessionState } from './src/services/djBreak/breakDecisionTypes.js';
import { getOrBuildAlmanac, resolveRelativeTimeWords } from './src/services/news/almanacService.js';
import { getOrBuildSongStoryCard } from './src/services/music/songStoryCardService.js';
import { validateSegmentBreakOutput } from './src/services/djBreak/breakValidator.js';
import { splitEntryIntoFacts } from './src/services/djBreak/segmentPlanner.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // Instantiate TTS Providers
  const geminiTtsProvider = new GeminiTTSProvider();
  const kokoroTtsProvider = new KokoroTTSProvider();

  // API Route: Get Kokoro status and supported voices
  app.get('/api/tts/kokoro/status', async (_req, res) => {
    try {
      const status = await kokoroTtsProvider.getServiceInfo();
      return res.json(status);
    } catch (err: any) {
      return res.status(500).json({
        isAvailable: false,
        error: err?.message || 'Failed to query Kokoro service status',
      });
    }
  });

  // API Route: Generate TTS DJ speech (Gemini or Kokoro)
  app.post('/api/tts/generate', async (req, res) => {
    try {
      const { text, engine, voice, style, model, speed } = req.body;

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, error: 'A script text is required.' });
      }

      console.log(`[API /api/tts/generate] Received request (engine: ${engine || 'GEMINI'}) for text: "${text.substring(0, 40)}..." (speed: ${speed ?? 1.0})`);

      const provider = (engine === 'KOKORO') ? kokoroTtsProvider : geminiTtsProvider;
      const result = await provider.generate({ text, engine, voice, style, model, speed });

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
        error: err?.message || 'Failed to generate speech with TTS engine',
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
      let version = '1.0.8';
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (m.version) version = m.version;
        } catch (e) {
          // fallback
        }
      }

      const folderName = 'retrofm-extension';
      const zipFilename = `retrofm-extension-v${version}.zip`;
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
      const files: Record<string, string> = {};

      function scanDir(dir: string, baseDir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            scanDir(fullPath, baseDir);
          } else if (entry.isFile()) {
            if (entry.name.endsWith('.png')) {
              files[relPath] = `data:image/png;base64,${fs.readFileSync(fullPath).toString('base64')}`;
            } else {
              files[relPath] = fs.readFileSync(fullPath, 'utf8');
            }
          }
        }
      }

      scanDir(extensionDir, extensionDir);
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

  // API Route: Trigger background prefetch for news (Cleaned up - old news writer removed)
  app.post('/api/news/prefetch', async (req, res) => {
    return res.json({ success: true, message: 'Legacy news prefetch removed. Segment pipeline active.' });
  });

  // API Route: Poll status of news prefetch (Cleaned up - old news writer removed)
  app.get('/api/news/prefetch/status', (req, res) => {
    return res.json({
      success: true,
      isPrefetching: false,
      readyCount: 0,
      totalPrefetched: 0,
      uiText: 'Segment pipeline active',
      readyLines: [],
    });
  });

  // API Route: Cancel active prefetch (Cleaned up - old news writer removed)
  app.post('/api/news/prefetch/cancel', (_req, res) => {
    return res.json({ success: true, message: 'Prefetch cancelled.' });
  });

  // API Route: Check LM Studio connection and discover available models
  app.post('/api/ai/lmstudio/status', async (req, res) => {
    try {
      const defaultEndpoint = process.env.LM_STUDIO_ENDPOINT || 'http://host.docker.internal:1234/v1';
      let endpoint = req.body?.endpoint || defaultEndpoint;
      // If user typed localhost inside browser, resolve appropriately for Docker container backend
      if (endpoint.includes('localhost:1234') || endpoint.includes('127.0.0.1:1234')) {
        endpoint = endpoint.replace('localhost:1234', 'host.docker.internal:1234').replace('127.0.0.1:1234', 'host.docker.internal:1234');
      }

      // Validate URL format for security
      try {
        const parsed = new URL(endpoint);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ success: false, error: 'Invalid URL protocol. Only http and https are allowed.' });
        }
      } catch {
        return res.status(400).json({ success: false, error: 'Malformed endpoint URL.' });
      }

      const models = await LMStudioScriptWriterProvider.discoverModels(endpoint);
      return res.json({
        success: true,
        endpoint,
        models,
        modelCount: models.length,
        defaultModel: models[0] || null,
      });
    } catch (err: any) {
      return res.status(200).json({
        success: false,
        error: err?.message || 'Could not connect to LM Studio at the specified endpoint.',
        models: [],
      });
    }
  });

  // API Route: Send a test prompt to LM Studio and verify chat-completions
  app.post('/api/ai/lmstudio/test', async (req, res) => {
    try {
      const defaultEndpoint = process.env.LM_STUDIO_ENDPOINT || 'http://host.docker.internal:1234/v1';
      let endpoint = req.body?.endpoint || defaultEndpoint;
      if (endpoint.includes('localhost:1234') || endpoint.includes('127.0.0.1:1234')) {
        endpoint = endpoint.replace('localhost:1234', 'host.docker.internal:1234').replace('127.0.0.1:1234', 'host.docker.internal:1234');
      }

      const model = req.body?.model;
      const provider = new LMStudioScriptWriterProvider({ endpoint, model, timeoutMs: 60000 });

      // Run sample DJ break test prompt
      const result = await provider.writeBreaksOnly({
        targetDate: '1985-07-13',
        personality: 'mike',
        timeOfDay: 'afternoon',
        format: 'Top 40',
        songPlayed: 'a-ha - Take on Me',
        songNext: 'Michael Jackson - Billie Jean',
        secondsAvailable: 12,
        factItems: [
          {
            headline: 'Live Aid concert rocks Wembley Stadium and JFK Stadium Philadelphia',
            publishedDate: '1985-07-13',
            category: 'music',
            summary: 'Global charity concert featuring top rock artists across two continents.',
            source: 'Test',
            url: 'https://example.com/liveaid',
            provider: 'nyt',
          },
        ],
      });

      return res.json({
        success: result.success,
        modelUsed: result.modelUsed,
        callDurationSec: result.callDurationSec,
        sampleBreak: result.breaks?.[0]?.scriptText || null,
        breaks: result.breaks,
        error: result.error,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed test request to LM Studio.',
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

  // Helper to map and sanitize provider endpoints
  function resolveProviderEndpoint(provider?: string, endpoint?: string) {
    if (provider !== 'lmstudio') return undefined;
    let ep = endpoint || process.env.LM_STUDIO_ENDPOINT || 'http://host.docker.internal:1234/v1';
    if (ep.includes('localhost:1234') || ep.includes('127.0.0.1:1234')) {
      ep = ep.replace('localhost:1234', 'host.docker.internal:1234').replace('127.0.0.1:1234', 'host.docker.internal:1234');
    }
    return ep;
  }

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
        provider,
        lmStudioEndpoint,
        model,
      } = req.body;

      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      const isNationalFocus = nationalFocus !== false;
      const resolvedEndpoint = resolveProviderEndpoint(provider, lmStudioEndpoint);
      console.log(`[API /api/dj-break/step1-write] Writing breaks for ${targetDate}, personality: ${personality}, ${secondsAvailable}s (provider=${provider || 'gemini'}, forceFresh=${Boolean(forceFresh)}, nationalFocus=${isNationalFocus})`);

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
        provider: provider === 'lmstudio' ? 'lmstudio' : 'gemini',
        lmStudioEndpoint: resolvedEndpoint,
        model,
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
        provider,
        lmStudioEndpoint,
      } = req.body;

      if (!Array.isArray(breaks) || breaks.length === 0) {
        return res.status(400).json({ success: false, error: 'breaks array is required.' });
      }
      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      const resolvedEndpoint = resolveProviderEndpoint(provider, lmStudioEndpoint);
      console.log(`[API /api/dj-break/step2-audit] Auditing ${breaks.length} breaks for ${targetDate} (provider=${provider || 'gemini'})`);

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
        provider: provider === 'lmstudio' ? 'lmstudio' : 'gemini',
        lmStudioEndpoint: resolvedEndpoint,
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
        provider,
        lmStudioEndpoint,
        model,
      } = req.body;

      if (!targetDate || typeof targetDate !== 'string') {
        return res.status(400).json({ success: false, error: 'targetDate is required.' });
      }

      const isNationalFocus = nationalFocus !== false;
      const resolvedEndpoint = resolveProviderEndpoint(provider, lmStudioEndpoint);
      console.log(`[API /api/dj-break/generate] Generating breaks for ${targetDate}, personality: ${personality}, ${secondsAvailable}s (provider=${provider || 'gemini'}, forceFresh=${Boolean(forceFresh)}, nationalFocus=${isNationalFocus})`);

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
        provider: provider === 'lmstudio' ? 'lmstudio' : 'gemini',
        lmStudioEndpoint: resolvedEndpoint,
        model,
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

  // Shared repository singletons for server-side chart and credit queries
  const chartFactRepo = new ChartFactRepository();
  const songCreditRepo = new SongCreditRepository();

  // Helper for natural extractive fallback monologue
  function buildNaturalExtractiveSegment(packet: any, broadcastDate: string): string {
    const sentences = (packet.facts || []).map((f: any) => {
      let t = (f.text || '').trim();
      const writtenMatch = t.match(/^Written by (.+)\.$/i);
      if (writtenMatch) t = `${writtenMatch[1]} wrote this one.`;
      const producedMatch = t.match(/^Produced by (.+)\.$/i);
      if (producedMatch) t = `${producedMatch[1]} produced this track.`;
      if (t.length > 4 && t === t.toUpperCase()) {
        t = t.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      }
      const resolved = resolveRelativeTimeWords(t, f.printDate || broadcastDate);
      return resolved.text;
    });
    if (sentences.length === 0) return '';
    const body = sentences.join(' ');
    if (packet.targetSongTitle && packet.targetSongArtist) {
      return `${body} Now on RetroFM, here is "${packet.targetSongTitle}" by ${packet.targetSongArtist}.`;
    }
    return body;
  }

  // API Route: Rich Segment Break Pipeline
  // Evaluates candidates in priority order: next_song_story, chart_story, credits, music_news, major_news.
  // Plain intro is allowed ONLY when every other candidate has failed.
  app.post('/api/dj/segment-break', async (req, res) => {
    const startTime = Date.now();
    try {
      const {
        selectedDate,
        prevSong,
        nextSong,
        frequencySetting,
        usedFactKeys,
        lastTopic,
        provider,
        endpoint,
        model,
      } = req.body;

      if (!selectedDate || typeof selectedDate !== 'string') {
        return res.status(400).json({ error: 'selectedDate is required.' });
      }

      const freqSetting = typeof frequencySetting === 'number' ? frequencySetting : 1.0;
      const roll = Math.random();
      const rollPassed = roll <= freqSetting;

      const usedKeysSet = new Set<string>(Array.isArray(usedFactKeys) ? usedFactKeys : []);

      // Load almanac and next song story card
      const almanac = await getOrBuildAlmanac(selectedDate);
      const songCard = nextSong
        ? await getOrBuildSongStoryCard(nextSong, selectedDate, undefined, { runLLMCheck: false })
        : null;

      // Setup ScriptWriterProvider
      const resolvedEndpoint = resolveProviderEndpoint(provider, endpoint);
      const writer = (provider === 'lmstudio' || (!process.env.GEMINI_API_KEY && resolvedEndpoint))
        ? new LMStudioScriptWriterProvider({ endpoint: resolvedEndpoint, model, timeoutMs: 35000 })
        : new GeminiScriptWriterProvider();

      // Collect candidates
      interface CandidateEval {
        type: string;
        score: number;
        ready: boolean;
        packet: any;
        failureReason?: string;
      }
      const candidates: CandidateEval[] = [];

      // 1. Next Song Story Candidate
      if (nextSong && songCard && songCard.facts) {
        const validSongFacts = songCard.facts.filter((f) => {
          const key = `song:${nextSong.id}:${f.factText.slice(0, 40)}`;
          return !usedKeysSet.has(key) && !/squidbillies|remaster|streaming|spotify|youtube/i.test(f.factText);
        });
        const ready = validSongFacts.length >= 2;
        const packetFacts = validSongFacts.slice(0, 4).map((f) => ({
          text: f.factText,
          source: f.source,
          printDate: f.publicDate || selectedDate,
          date: f.publicDate || selectedDate,
        }));
        candidates.push({
          type: 'next_song_story',
          score: 110,
          ready,
          packet: {
            topic: 'next_song_story',
            topicTitle: `Story Behind "${nextSong.title}" by ${nextSong.artist}`,
            targetSongTitle: nextSong.title,
            targetSongArtist: nextSong.artist,
            facts: packetFacts,
            factKeys: validSongFacts.slice(0, 4).map((f) => `song:${nextSong.id}:${f.factText.slice(0, 40)}`),
          },
          failureReason: ready ? undefined : `only ${validSongFacts.length} facts available (minimum 2 required)`,
        });
      } else {
        candidates.push({
          type: 'next_song_story',
          score: 110,
          ready: false,
          packet: null,
          failureReason: 'no nextSong or song card available',
        });
      }

      // 2. Chart Story Candidate
      let chartFactsForSong = nextSong ? computeChartFacts(nextSong, selectedDate, chartFactRepo) : [];
      let nationalNo1 = computeNationalNumberOneFact(selectedDate, chartFactRepo);
      const availableChartFacts = chartFactsForSong.filter((cf) => !usedKeysSet.has(`chart:${cf.kind}:${cf.date}:${cf.title}`));
      const chartReady = availableChartFacts.length > 0 || (nationalNo1 !== null && !usedKeysSet.has(`chart:national_no1:${nationalNo1.title}:${nationalNo1.date}`));
      if (chartReady) {
        const primaryFact = availableChartFacts[0] || nationalNo1!;
        const chartKey = availableChartFacts[0]
          ? `chart:${primaryFact.kind}:${primaryFact.date}:${primaryFact.title}`
          : `chart:national_no1:${primaryFact.title}:${primaryFact.date}`;
        candidates.push({
          type: 'chart_story',
          score: primaryFact.interestScore || 95,
          ready: true,
          packet: {
            topic: 'chart_story',
            topicTitle: `Billboard Chart Action: "${primaryFact.title}"`,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: [{
              text: primaryFact.factText,
              source: primaryFact.source,
              printDate: primaryFact.date,
              date: primaryFact.date,
            }],
            factKeys: [chartKey],
          },
        });
      } else {
        candidates.push({
          type: 'chart_story',
          score: 95,
          ready: false,
          packet: null,
          failureReason: 'no fresh chart facts on or before broadcast date',
        });
      }

      // 3. Credits Candidate
      if (nextSong) {
        const eligibleCredits = songCreditRepo.getEligibleCredits(nextSong.id, selectedDate)
          .filter((c) => !usedKeysSet.has(`credit:${nextSong.id}:${c.fact_text.slice(0, 40)}`));
        if (eligibleCredits.length > 0) {
          const cred = eligibleCredits[0];
          candidates.push({
            type: 'credits',
            score: 75,
            ready: true,
            packet: {
              topic: 'credits',
              topicTitle: `Credits for "${nextSong.title}"`,
              targetSongTitle: nextSong.title,
              targetSongArtist: nextSong.artist,
              facts: [{
                text: cred.fact_text,
                source: 'MusicBrainz',
                printDate: selectedDate,
                date: selectedDate,
              }],
              factKeys: [`credit:${nextSong.id}:${cred.fact_text.slice(0, 40)}`],
            },
          });
        } else {
          candidates.push({
            type: 'credits',
            score: 75,
            ready: false,
            packet: null,
            failureReason: 'no fresh song credits found',
          });
        }
      } else {
        candidates.push({
          type: 'credits',
          score: 75,
          ready: false,
          packet: null,
          failureReason: 'credit repository not available or no next song',
        });
      }

      // 4. Music News Candidate
      const musicAlmanacEntries = (almanac.entries || [])
        .filter((e) => e.category === 'music' && !usedKeysSet.has(`almanac:${e.id}`))
        .sort((a, b) => (b.interestScore || 50) - (a.interestScore || 50));
      if (musicAlmanacEntries.length > 0) {
        const entry = musicAlmanacEntries[0];
        const subFacts = splitEntryIntoFacts(entry);
        candidates.push({
          type: 'music_news',
          score: entry.interestScore || 80,
          ready: true,
          packet: {
            topic: 'music_news',
            topicTitle: entry.headline,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: subFacts,
            factKeys: [`almanac:${entry.id}`],
          },
        });
      } else {
        candidates.push({
          type: 'music_news',
          score: 80,
          ready: false,
          packet: null,
          failureReason: 'no fresh music news entries in almanac',
        });
      }

      // 5. Major News Candidate
      const majorNewsEntries = (almanac.entries || [])
        .filter((e) => e.category === 'major_news' && !usedKeysSet.has(`almanac:${e.id}`))
        .sort((a, b) => (b.interestScore || 50) - (a.interestScore || 50));
      if (majorNewsEntries.length > 0) {
        const entry = majorNewsEntries[0];
        const subFacts = splitEntryIntoFacts(entry);
        candidates.push({
          type: 'major_news',
          score: entry.interestScore || 70,
          ready: true,
          packet: {
            topic: 'major_news',
            topicTitle: entry.headline,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: subFacts,
            factKeys: [`almanac:${entry.id}`],
          },
        });
      } else {
        candidates.push({
          type: 'major_news',
          score: 70,
          ready: false,
          packet: null,
          failureReason: 'no fresh major news entries in almanac',
        });
      }

      // If roll did not pass frequency check, log and return silence
      if (!rollPassed) {
        const elapsedMs = Date.now() - startTime;
        const candidatesSummary = candidates.map((c) => `${c.type}:${c.score}(${c.ready ? 'ready' : 'unready'})`).join(' ');
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=silence facts=0 validator=N/A audit=N/A elapsed=${elapsedMs}ms reason="roll exceeded frequency threshold"`);
        return res.json({
          decision: 'silence',
          breakType: null,
          finalSpeech: '',
          targetSong: 'none',
          usedKeys: [],
        });
      }

      // Sort ready candidates by score descending, preferring types different from lastTopic
      const readyCandidates = candidates.filter((c) => c.ready && c.packet);
      readyCandidates.sort((a, b) => {
        if (a.type === lastTopic && b.type !== lastTopic) return 1;
        if (b.type === lastTopic && a.type !== lastTopic) return -1;
        return b.score - a.score;
      });

      let chosenCandidate: CandidateEval | null = null;
      let finalSpeech = '';
      let validatorResult = 'N/A';
      let auditResult = 'N/A';
      const fellThroughReasons: string[] = [];

      // Evaluate candidates in order
      for (const cand of readyCandidates) {
        const packet = cand.packet;
        try {
          let scriptText = '';
          let unsupportedClaims: string[] = [];

          if (writer.writeSegmentBreakScript && packet.facts.length >= 1) {
            const scriptRes = await writer.writeSegmentBreakScript({
              targetDate: selectedDate,
              personality: 'mike',
              topic: packet.topic,
              topicTitle: packet.topicTitle,
              targetSongTitle: packet.targetSongTitle,
              targetSongArtist: packet.targetSongArtist,
              facts: packet.facts,
            });
            if (scriptRes.success && scriptRes.scriptText) {
              scriptText = scriptRes.scriptText;
              unsupportedClaims = scriptRes.unsupportedClaims || [];
            }
          }

          // If writer failed or returned empty, attempt natural extractive fallback
          if (!scriptText) {
            scriptText = buildNaturalExtractiveSegment(packet, selectedDate);
          }

          if (scriptText) {
            const val = validateSegmentBreakOutput(scriptText, {
              selectedDate,
              factPacket: packet,
            });

            if (val.valid && unsupportedClaims.length === 0) {
              chosenCandidate = cand;
              finalSpeech = scriptText;
              validatorResult = 'PASS';
              auditResult = 'PASS(0 unsupported)';
              break;
            } else {
              const failReason = !val.valid
                ? `validator rejected: ${val.rejectedReason}`
                : `audit caught unsupported claims: ${unsupportedClaims.join('; ')}`;
              cand.failureReason = failReason;
              fellThroughReasons.push(`${cand.type}: ${failReason}`);
            }
          } else {
            const failReason = 'script generation returned empty';
            cand.failureReason = failReason;
            fellThroughReasons.push(`${cand.type}: ${failReason}`);
          }
        } catch (err: any) {
          const failReason = `generation error: ${err?.message}`;
          cand.failureReason = failReason;
          fellThroughReasons.push(`${cand.type}: ${failReason}`);
        }
      }

      // Plain intro fallback ONLY when every other candidate has failed
      if (!chosenCandidate) {
        if (nextSong) {
          chosenCandidate = {
            type: 'plain_intro',
            score: 25,
            ready: true,
            packet: {
              topic: 'plain_intro',
              topicTitle: `Intro for ${nextSong.title}`,
              targetSongTitle: nextSong.title,
              targetSongArtist: nextSong.artist,
              facts: [{
                text: `Spinning next on RetroFM is "${nextSong.title}" by ${nextSong.artist}.`,
                source: 'Station Playlist',
                printDate: selectedDate,
                date: selectedDate,
              }],
              factKeys: [`intro:${nextSong.title}:${nextSong.artist}`],
            },
          };
          finalSpeech = `Spinning next on RetroFM is "${nextSong.title}" by ${nextSong.artist}.`;
          validatorResult = 'PASS';
          auditResult = 'PASS(intro)';
        }
      }

      const elapsedMs = Date.now() - startTime;
      const candidatesSummary = candidates.map((c) => `${c.type}:${c.score}(${c.ready ? 'ready' : 'unready'})`).join(' ');
      const factCount = chosenCandidate?.packet?.facts?.length || 0;
      const failureReasonLog = fellThroughReasons.length > 0 ? ` failure_reasons=[${fellThroughReasons.join(' | ')}]` : '';

      if (chosenCandidate?.type === 'plain_intro') {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=plain_intro facts=${factCount} validator=${validatorResult} audit=${auditResult} elapsed=${elapsedMs}ms reason="every other candidate failed"${failureReasonLog}`);
      } else if (chosenCandidate) {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=${chosenCandidate.type} facts=${factCount} validator=${validatorResult} audit=${auditResult} elapsed=${elapsedMs}ms${failureReasonLog}`);
      } else {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=silence facts=0 validator=N/A audit=N/A elapsed=${elapsedMs}ms reason="all candidates failed and no next song"${failureReasonLog}`);
      }

      return res.json({
        decision: chosenCandidate ? 'speak' : 'silence',
        breakType: chosenCandidate?.type || null,
        candidate: chosenCandidate?.packet ? {
          type: chosenCandidate.type,
          topic: chosenCandidate.packet.topic,
          topicTitle: chosenCandidate.packet.topicTitle,
          factKey: chosenCandidate.packet.factKeys?.[0] || 'none',
          factText: chosenCandidate.packet.facts?.[0]?.text || '',
        } : null,
        finalSpeech,
        targetSong: 'next',
        usedKeys: chosenCandidate?.packet?.factKeys || [],
      });
    } catch (err: any) {
      const elapsedMs = Date.now() - startTime;
      console.error(`[Segment] error="${err?.message}" elapsed=${elapsedMs}ms`);
      return res.status(500).json({
        decision: 'silence',
        breakType: null,
        finalSpeech: '',
        targetSong: 'none',
        error: err?.message,
      });
    }
  });

  // API Route: Server-side DJ Break Decision (Spec A legacy compatibility)
  // Queries SQLite for era-accurate chart facts and verified song credits
  app.post('/api/dj/break-decision', (req, res) => {
    try {
      const {
        selectedDate,
        prevSong,
        nextSong,
        frequencySetting,
        usedFactKeys,
        lastBreakType,
        newsObservation,
      } = req.body;

      if (!selectedDate || typeof selectedDate !== 'string') {
        return res.status(400).json({ error: 'selectedDate is required.' });
      }

      // Reconstruct state from client session payload
      const state: BreakSelectionSessionState = {
        usedFactKeys: new Set<string>(Array.isArray(usedFactKeys) ? usedFactKeys : []),
        usedNewsTopics: new Set<string>(Array.isArray(req.body?.usedNewsTopics) ? req.body.usedNewsTopics : []),
        lastBreakType: lastBreakType || null,
        totalSongChanges: 0,
        totalBreaksSpoken: 0,
        recentRhetoricalOpeners: 0,
        breaksSinceLastNews: typeof req.body?.breaksSinceLastNews === 'number' ? req.body.breaksSinceLastNews : 4,
        lastIntroTemplateIndex: typeof req.body?.lastIntroTemplateIndex === 'number' ? req.body.lastIntroTemplateIndex : -1,
      };

      const result = decideAndSelectBreak(
        {
          prevSong: prevSong || null,
          nextSong: nextSong || null,
          selectedDate,
          frequencySetting: typeof frequencySetting === 'number' ? frequencySetting : 0.5,
          newsObservation: newsObservation || null,
          chartRepo: chartFactRepo,
          creditRepo: songCreditRepo,
        },
        state
      );

      return res.json({
        decision: result.decision,
        breakType: result.breakType,
        candidate: result.candidate,
        finalSpeech: result.finalSpeech,
        targetSong: result.targetSong,
      });
    } catch (err: any) {
      console.error('[API /api/dj/break-decision] Error:', err);
      return res.status(500).json({
        decision: 'silence',
        breakType: null,
        candidate: null,
        finalSpeech: '',
        targetSong: 'none',
        error: err?.message || 'Break decision failed',
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

  // Create shared HTTP server to host Express and attach Vite HMR WebSocket upgrades
  const server = http.createServer(app);

  // Serve Vite in dev or static dist in production
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve(__dirname, 'dist'))) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[RetroFM Server] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[RetroFM Server] Startup error:', err);
  process.exit(1);
});

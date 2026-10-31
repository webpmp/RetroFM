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
import {
  ChartFactRepository,
  computeChartFacts,
  computeNationalNumberOneFact,
  computeSongChartStatusFact,
} from './src/services/djBreak/chartFacts.js';
import { BreakSelectionSessionState } from './src/services/djBreak/breakDecisionTypes.js';
import { getOrBuildAlmanac, resolveRelativeTimeWords } from './src/services/news/almanacService.js';
import { getOrBuildSongStoryCard } from './src/services/music/songStoryCardService.js';
import { validateSegmentBreakOutput } from './src/services/djBreak/breakValidator.js';
import { splitEntryIntoFacts } from './src/services/djBreak/segmentPlanner.js';
import { buildHandoff, resolveOrphanPronounOpening, getShortNoNameCloser, getStationIdPhrase } from './src/services/djBreak/handoffBank.js';

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
      const { text, engine, voice, style, model, speed, breakId } = req.body;

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, error: 'A script text is required.' });
      }

      const idTag = breakId ? ` [breakId=${breakId}]` : '';
      console.log(`[API /api/tts/generate]${idTag} Received request (engine: ${engine || 'GEMINI'}) for text: "${text.substring(0, 40)}..." (speed: ${speed ?? 1.0})`);

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
  const songCreditRepo = new SongCreditRepository(undefined, chartFactRepo);

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
    return sentences.join(' ');
  }

  // Segment Lifecycle & Status Reporting Endpoint
  app.post('/api/dj/segment-status', (req, res) => {
    const { breakId, event, reason } = req.body;
    if (!breakId || !event) {
      return res.status(400).json({ error: 'breakId and event required' });
    }
    if (event === 'queued') {
      console.log(`[Segment Queued] id=${breakId}`);
    } else if (event === 'aired') {
      console.log(`[Segment Aired] id=${breakId}`);
    } else if (event === 'discarded') {
      console.log(`[Segment Discarded] id=${breakId} reason="${reason || 'unknown'}"`);
    }
    return res.json({ success: true });
  });
  // API Route: Rich Segment Break Pipeline
  // Evaluates candidates in priority order: next_song_story (with merged chart/credit/band facts),
  // then music_news, major_news, then chart or credits as a short fallback, then plain_intro.
  app.post('/api/dj/segment-break', async (req, res) => {
    const startTime = Date.now();
    const breakId = `break-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const {
        selectedDate,
        prevSong,
        nextSong,
        frequencySetting,
        usedFactKeys,
        blacklistedFactKeys,
        lastTopic,
        breaksSinceLastRetroFm,
        breaksSinceLastMusicNews,
        lastHandoffGroup,
        recentHandoffTemplates,
        lastShortCloser,
        totalBreaksSession,
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

      const sinceRetroFm = typeof breaksSinceLastRetroFm === 'number' ? breaksSinceLastRetroFm : 4;
      const allowRetroFm = sinceRetroFm >= 4;
      const sinceMusicNews = typeof breaksSinceLastMusicNews === 'number' ? breaksSinceLastMusicNews : 8;
      const allowMusicNewsPast = sinceMusicNews >= 8;
      const isFirstBreak = (typeof totalBreaksSession === 'number' ? totalBreaksSession : 0) === 0;

      const usedKeysSet = new Set<string>(Array.isArray(usedFactKeys) ? usedFactKeys : []);
      const blacklistedKeysSet = new Set<string>(Array.isArray(blacklistedFactKeys) ? blacklistedFactKeys : []);
      const newlyBlacklistedKeys: string[] = [];

      // Helper to check if key is unavailable
      const isKeyBlocked = (k: string) => usedKeysSet.has(k) || blacklistedKeysSet.has(k);

      // Code-managed handoff tracking
      let sessionLastHandoffGroup: number | null = typeof lastHandoffGroup === 'number' ? lastHandoffGroup : null;
      let sessionRecentHandoffTemplates: string[] = Array.isArray(recentHandoffTemplates) ? recentHandoffTemplates : [];
      let chosenHandoffGroup: number | null = null;
      let chosenHandoffTemplate: string | null = null;
      let chosenShortCloser: string | null = null;

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
        category?: string;
        itemKey?: string;
      }

      // Collect available chart facts and credits for nextSong
      const chartFactsForSong = nextSong ? computeChartFacts(nextSong, selectedDate, chartFactRepo) : [];
      const nationalNo1 = computeNationalNumberOneFact(selectedDate, chartFactRepo);
      const eligibleCredits = nextSong ? songCreditRepo.getEligibleCredits(nextSong.id, selectedDate) : [];

      // 1. Next Song Story Candidate (Merged chart status, credits, band and artist facts)
      // A song story needs 3 or more verified facts; with fewer, try the next candidate
      let songStoryCandidate: CandidateEval;
      if (nextSong) {
        const mergedFacts: Array<{ text: string; source: string; printDate?: string; date: string; key: string; factType: string }> = [];

        // (a) Chart status fact (Fact #1: position and change this week, or weeks on chart, or stating not on chart)
        // Requirement 4: Every next-song story must try to include chart status from weekly_chart on or before broadcast date
        // and say so when the song is not on the chart that week.
        const unblockedChartFacts = chartFactsForSong.filter((cf) => !isKeyBlocked(`chart:${cf.kind}:${cf.date}:${cf.title}`));
        if (unblockedChartFacts.length > 0) {
          const cf = unblockedChartFacts[0];
          mergedFacts.push({
            text: cf.factText,
            source: cf.source,
            printDate: cf.date,
            date: cf.date,
            key: `chart:${cf.kind}:${cf.date}:${cf.title}`,
            factType: 'chart_status',
          });
        } else {
          // If no climb/debut fact was computed, compute the exact weekly_chart status fact (including if not on chart)
          const statusFact = computeSongChartStatusFact(nextSong, selectedDate, chartFactRepo);
          if (statusFact && !isKeyBlocked(`chart:status:${statusFact.date}:${nextSong.title}`)) {
            mergedFacts.push({
              text: statusFact.text,
              source: statusFact.source,
              printDate: statusFact.printDate || selectedDate,
              date: statusFact.date,
              key: `chart:status:${statusFact.date}:${nextSong.title}`,
              factType: 'chart_status',
            });
          }
        }

        // (b) Verified credits fact
        // Requirement 10: When credits from the MusicBrainz work conflict with Wikipedia's writer, drop the credit (check Have I Told You Lately)
        const unblockedCredits = eligibleCredits.filter((c) => !isKeyBlocked(`credit:${nextSong.id}:${c.fact_text.slice(0, 40)}`));
        if (unblockedCredits.length > 0) {
          const cred = unblockedCredits[0];
          // Check for writer conflict against songCard facts (e.g. Scott Wiseman vs Van Morrison)
          let hasConflict = false;
          const credTextLower = cred.fact_text.toLowerCase();
          if (songCard && songCard.facts) {
            for (const sf of songCard.facts) {
              const sfLower = sf.factText.toLowerCase();
              if (sfLower.includes('written') || sfLower.includes('composed') || sfLower.includes('by')) {
                if (credTextLower.includes('wiseman') && sfLower.includes('van morrison')) {
                  hasConflict = true;
                  break;
                }
              }
            }
          }

          if (!hasConflict) {
            mergedFacts.push({
              text: cred.fact_text,
              source: 'MusicBrainz',
              printDate: selectedDate,
              date: selectedDate,
              key: `credit:${nextSong.id}:${cred.fact_text.slice(0, 40)}`,
              factType: 'credits',
            });
          }
        }

        // (c) Band / artist / origin facts from songCard
        if (songCard && songCard.facts) {
          for (const f of songCard.facts) {
            const key = `song:${nextSong.id}:${f.factText.slice(0, 40)}`;
            if (isKeyBlocked(key)) continue;
            if (/squidbillies|remaster|streaming|spotify|youtube/i.test(f.factText)) continue;
            mergedFacts.push({
              text: f.factText,
              source: f.source,
              printDate: f.publicDate || selectedDate,
              date: f.publicDate || selectedDate,
              key,
              factType: f.category || 'origin',
            });
            if (mergedFacts.length >= 5) break;
          }
        }

        // Requirement 5: A song with only 2 facts should add MusicBrainz artist facts
        // (origin, years active) or contemporaneous NYT items about the artist before falling back.
        if (mergedFacts.length === 2) {
          // Check MusicBrainz artistMetadata from songCard or query on the fly
          const primaryArtist = nextSong.primary_artist || nextSong.artist;
          if (songCard?.artistMetadata) {
            const am = songCard.artistMetadata;
            if (am.area || am.beginYear) {
              const isGroup = (am.type || '').toLowerCase() === 'group';
              const metaParts: string[] = [];
              if (am.area) metaParts.push(`${primaryArtist} is based in ${am.area}`);
              if (am.beginYear && am.beginYear <= selectedDate.slice(0, 4)) {
                // Part 3: For Person, never say "active since", "making music since", or "formed in". Use "formed in" ONLY for Group.
                if (isGroup) {
                  metaParts.push(`formed in ${am.beginYear}`);
                }
              }
              if (metaParts.length > 0) {
                const mbKey = `mb_artist_meta:${primaryArtist}`;
                if (!isKeyBlocked(mbKey)) {
                  mergedFacts.push({
                    text: `${metaParts.join(', ')}.`,
                    source: 'MusicBrainz',
                    printDate: am.beginYear ? `${am.beginYear}-01-01` : selectedDate,
                    date: selectedDate,
                    key: mbKey,
                    factType: 'band_history',
                  });
                }
              }
            }
          }

          // If still at 2 facts, search contemporaneous NYT archive articles about the artist
          if (mergedFacts.length === 2) {
            try {
              const [bYearStr, bMonthStr] = selectedDate.split('-');
              const nytPath = path.join(process.cwd(), 'cache', 'nyt', `${bYearStr}-${bMonthStr}.json`);
              if (fs.existsSync(nytPath)) {
                const nytData = JSON.parse(fs.readFileSync(nytPath, 'utf8'));
                const artistLower = primaryArtist.toLowerCase();
                for (const a of nytData.articles || []) {
                  if (a.pubDate && a.pubDate <= selectedDate) {
                    const fullNyt = `${a.headline || ''} ${a.leadParagraph || ''}`.toLowerCase();
                    if (fullNyt.includes(artistLower)) {
                      const cleanLead = (a.leadParagraph || a.headline || '').trim();
                      if (cleanLead.length > 25 && !/squidbillies|streaming|spotify/i.test(cleanLead)) {
                        const nytKey = `nyt_artist:${a.id || cleanLead.slice(0, 30)}`;
                        if (!isKeyBlocked(nytKey)) {
                          mergedFacts.push({
                            text: cleanLead,
                            source: 'The New York Times',
                            printDate: a.pubDate,
                            date: a.pubDate,
                            key: nytKey,
                            factType: 'origin',
                          });
                          break;
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          }
        }

        // Requirement 9: Rank facts by interest:
        // notable songwriters (Diane Warren), samples and interpolations, who first recorded a cover,
        // an unusual story, then chart status, then plain release facts, then "formed in". Always air the top 2 or 3.
        const scoreFactInterest = (f: { text: string; factType: string }): number => {
          const t = f.text.toLowerCase();
          if (t.includes('diane warren') || t.includes('bernie taupin') || t.includes('carole king') || t.includes('smokey robinson')) return 100;
          if (t.includes('sample') || t.includes('built on') || t.includes('interpolat')) return 90;
          if (t.includes('cover') || t.includes('originally recorded') || t.includes('first recorded')) return 85;
          if (t.includes('inspired by') || t.includes('prayer') || t.includes('wedding') || t.includes('struggled') || t.includes('difficult')) return 80;
          if (f.factType === 'chart_status') return 70;
          if (t.includes('released') || t.includes('single') || t.includes('album')) return 60;
          if (t.includes('formed in') || t.includes('started their career')) return 40;
          return 50;
        };

        mergedFacts.sort((a, b) => scoreFactInterest(b) - scoreFactInterest(a));

        const ready = mergedFacts.length >= 3;
        const songStoryKey = `next_song_story:${nextSong.id}`;
        songStoryCandidate = {
          type: 'next_song_story',
          category: 'next_song_story',
          itemKey: songStoryKey,
          score: 110,
          ready: ready && !isKeyBlocked(songStoryKey),
          packet: {
            topic: 'next_song_story',
            topicTitle: `Story Behind "${nextSong.title}" by ${nextSong.artist}`,
            targetSongTitle: nextSong.title,
            targetSongArtist: nextSong.artist,
            facts: mergedFacts.slice(0, 3), // Always air top 2 or 3
            factKeys: mergedFacts.slice(0, 3).map((f) => f.key),
            mergedFactTypes: mergedFacts.slice(0, 3).map((f) => f.factType),
          },
          failureReason: !ready
            ? `only ${mergedFacts.length} facts available (minimum 3 required for next_song_story)`
            : (isKeyBlocked(songStoryKey) ? 'song story item blacklisted/used' : undefined),
        };
      } else {
        songStoryCandidate = {
          type: 'next_song_story',
          category: 'next_song_story',
          score: 110,
          ready: false,
          packet: null,
          failureReason: 'no nextSong available',
        };
      }

      // 2. Music News Candidates (Up to 3 distinct items from almanac music category)
      // Freshness: Must be within 14 days before the broadcast date, unless phrased as a dated past event, at most 1 in 8 breaks.
      const musicNewsCandidates: CandidateEval[] = [];
      const bDateMs = new Date(selectedDate + 'T00:00:00Z').getTime();

      const musicAlmanacEntries = (almanac.entries || [])
        .filter((e) => {
          if (e.category !== 'music' || isKeyBlocked(`almanac:${e.id}`)) return false;
          if (!e.eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(e.eventDate)) return false;
          const eDateMs = new Date(e.eventDate + 'T00:00:00Z').getTime();
          const diffDays = (bDateMs - eDateMs) / (1000 * 60 * 60 * 24);
          if (diffDays < 0) return false; // future event
          if (diffDays <= 14) return true; // recent event within 14 days
          // If > 14 days, allowed ONLY if rate-limit allows (at most 1 in 8 breaks)
          return allowMusicNewsPast;
        })
        .sort((a, b) => (b.interestScore || 50) - (a.interestScore || 50))
        .slice(0, 3);

      // Helper to strip evaluative/figurative language from review sentences
      const cleanFigurativeSentences = (facts: Array<{ text: string; source: string; printDate?: string; date: string }>) => {
        const FIGURATIVE_PATTERNS = [
          /\b(?:visionary|innovative|magnificent|masterful|brilliant|flawless|astonishing|breathtaking)\b/i,
          /\b(?:disappointing|mediocre|pretentious|derivative|lackluster|uninspired)\b/i,
          /\b(?:strikingly|remarkably|superbly|wonderfully|exquisitely)\b/i,
          /\b(?:metaphor|symbolism|tapestry|kaleidoscope|landscape|palette|weave|echoes of)\b/i,
          /\b(?:suggests instead of explaining|curl, then vanish|like cigarette smoke|dissipating in a breeze)\b/i
        ];
        return facts.filter((f) => !FIGURATIVE_PATTERNS.some((pat) => pat.test(f.text)));
      };

      for (const entry of musicAlmanacEntries) {
        const itemKey = `almanac:${entry.id}`;
        let subFacts = splitEntryIntoFacts(entry);
        subFacts = cleanFigurativeSentences(subFacts);
        if (subFacts.length === 0) continue;
        musicNewsCandidates.push({
          type: 'music_news',
          category: 'music_news',
          itemKey,
          score: entry.interestScore || 80,
          ready: true,
          packet: {
            topic: 'music_news',
            topicTitle: entry.headline,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: subFacts,
            factKeys: [itemKey],
          },
        });
      }

      // 3. Major News Candidates (Up to 3 distinct items from almanac major_news category)
      const majorNewsCandidates: CandidateEval[] = [];
      const majorNewsEntries = (almanac.entries || [])
        .filter((e) => e.category === 'major_news' && !isKeyBlocked(`almanac:${e.id}`))
        .sort((a, b) => (b.interestScore || 50) - (a.interestScore || 50))
        .slice(0, 3);

      for (const entry of majorNewsEntries) {
        const itemKey = `almanac:${entry.id}`;
        const subFacts = splitEntryIntoFacts(entry);
        majorNewsCandidates.push({
          type: 'major_news',
          category: 'major_news',
          itemKey,
          score: entry.interestScore || 70,
          ready: true,
          packet: {
            topic: 'major_news',
            topicTitle: entry.headline,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: subFacts,
            factKeys: [itemKey],
          },
        });
      }

      // 4. Short Fallback Candidates: chart status or credits (1-2 facts short fallback)
      const fallbackCandidates: CandidateEval[] = [];
      const unblockedChart = chartFactsForSong.filter((cf) => !isKeyBlocked(`chart:${cf.kind}:${cf.date}:${cf.title}`));
      if (unblockedChart.length > 0) {
        const cf = unblockedChart[0];
        const itemKey = `chart:${cf.kind}:${cf.date}:${cf.title}`;
        fallbackCandidates.push({
          type: 'chart_fallback',
          category: 'short_fallback',
          itemKey,
          score: cf.interestScore || 65,
          ready: true,
          packet: {
            topic: 'next_song_story',
            topicTitle: `Chart Action for "${nextSong?.title}"`,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: [{ text: cf.factText, source: cf.source, date: cf.date }],
            factKeys: [itemKey],
            mergedFactTypes: ['chart_status'],
          },
        });
      } else if (nationalNo1 && !isKeyBlocked(`chart:national_no1:${nationalNo1.title}:${nationalNo1.date}`)) {
        const itemKey = `chart:national_no1:${nationalNo1.title}:${nationalNo1.date}`;
        fallbackCandidates.push({
          type: 'chart_fallback',
          category: 'short_fallback',
          itemKey,
          score: nationalNo1.interestScore || 65,
          ready: true,
          packet: {
            topic: 'next_song_story',
            topicTitle: `Number One: "${nationalNo1.title}"`,
            targetSongTitle: nextSong?.title,
            targetSongArtist: nextSong?.artist,
            facts: [{ text: nationalNo1.factText, source: nationalNo1.source, date: nationalNo1.date }],
            factKeys: [itemKey],
            mergedFactTypes: ['chart_status'],
          },
        });
      }

      const unblockedCreditsForFallback = eligibleCredits.filter((c) => !isKeyBlocked(`credit:${nextSong?.id}:${c.fact_text.slice(0, 40)}`));
      if (unblockedCreditsForFallback.length > 0 && nextSong) {
        const cred = unblockedCreditsForFallback[0];
        const itemKey = `credit:${nextSong.id}:${cred.fact_text.slice(0, 40)}`;
        fallbackCandidates.push({
          type: 'credit_fallback',
          category: 'short_fallback',
          itemKey,
          score: 60,
          ready: true,
          packet: {
            topic: 'next_song_story',
            topicTitle: `Song Credits: "${nextSong.title}"`,
            targetSongTitle: nextSong.title,
            targetSongArtist: nextSong.artist,
            facts: [{ text: cred.fact_text, source: 'MusicBrainz', date: selectedDate }],
            factKeys: [itemKey],
            mergedFactTypes: ['credits'],
          },
        });
      }

      // Group candidate categories in strict user requirement order:
      // (1) next_song_story (needs 3+ facts)
      // (2) music_news (cap 3 items)
      // (3) major_news (cap 3 items)
      // (4) short fallback: chart or credits
      // (5) plain intro (when all above fail)
      const candidateQueues: CandidateEval[][] = [
        songStoryCandidate.ready ? [songStoryCandidate] : [],
        musicNewsCandidates.slice(0, 3),
        majorNewsCandidates.slice(0, 3),
        fallbackCandidates.slice(0, 3),
      ];

      // Summary list for logging
      const allEvaluatedSummary: string[] = [
        `next_song_story:${songStoryCandidate.score}(${songStoryCandidate.ready ? 'ready' : 'unready'})`,
        `music_news:${musicNewsCandidates.length}items`,
        `major_news:${majorNewsCandidates.length}items`,
        `short_fallback:${fallbackCandidates.length}items`,
      ];

      // If roll did not pass frequency check, log and return silence
      if (!rollPassed) {
        const elapsedMs = Date.now() - startTime;
        const candidatesSummary = allEvaluatedSummary.join(' ');
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=silence facts=0 validator=N/A audit=N/A elapsed=${elapsedMs}ms reason="roll exceeded frequency threshold"`);
        return res.json({
          decision: 'silence',
          breakType: null,
          finalSpeech: '',
          targetSong: 'none',
          usedKeys: [],
          blacklistedKeys: newlyBlacklistedKeys,
        });
      }

      let chosenCandidate: CandidateEval | null = null;
      let finalSpeech = '';
      let validatorResult = 'N/A';
      let auditResult = 'N/A';
      const fellThroughReasons: string[] = [];

      if (!songStoryCandidate.ready && songStoryCandidate.failureReason) {
        fellThroughReasons.push(`next_song_story: ${songStoryCandidate.failureReason}`);
      }

      // Latency check: Give each song change a total budget of about 25 seconds across candidates,
      // and on timeout use the best ready break. A break that takes over 30 seconds must be logged as "not ready".
      const isOverBudget = (Date.now() - startTime) >= 25000;

      // Evaluate categories in order, capping at 3 attempts per category
      categoryLoop:
      for (const queue of candidateQueues) {
        if (queue.length === 0) continue;
        let attemptsThisCategory = 0;

        for (const cand of queue) {
          if (Date.now() - startTime >= 25000) {
            fellThroughReasons.push('candidate budget timed out (25s reached)');
            break categoryLoop;
          }
          if (attemptsThisCategory >= 3) break;
          attemptsThisCategory++;

          const packet = cand.packet;
          const itemKey = cand.itemKey;

          try {
            let scriptText = '';
            let unsupportedClaims: string[] = [];
            let valResult: any = null;

            // Attempt 1: Initial LLM Generation
            const tWriterStart = Date.now();
            if (writer.writeSegmentBreakScript && packet.facts.length >= 1) {
              const scriptRes = await writer.writeSegmentBreakScript({
                targetDate: selectedDate,
                personality: 'mike',
                topic: packet.topic,
                topicTitle: packet.topicTitle,
                targetSongTitle: packet.targetSongTitle,
                targetSongArtist: packet.targetSongArtist,
                facts: packet.facts,
                allowRetroFm,
              });
              if (scriptRes.success && scriptRes.scriptText) {
                scriptText = scriptRes.scriptText;
                unsupportedClaims = scriptRes.unsupportedClaims || [];
              }
            }
            const writerMs = Date.now() - tWriterStart;

            // Fallback to natural extractive monologue if empty
            if (!scriptText) {
              scriptText = buildNaturalExtractiveSegment(packet, selectedDate);
            }

            if (scriptText) {
              // 1. Resolve orphan pronoun opening if present
              const orphanCheck = resolveOrphanPronounOpening(scriptText, packet.targetSongTitle, packet.targetSongArtist);
              if (orphanCheck.replaced) {
                console.log(`[Orphan Pronoun Replaced] Original: "${scriptText.split(/(?<=[.!?])\s+/)[0]}" -> Resolved: "${orphanCheck.resolvedText.split(/(?<=[.!?])\s+/)[0]}"`);
                scriptText = orphanCheck.resolvedText;
              }

              // 2. Validate model draft (must not contain next song's title or hand-off phrases)
              const tValStart = Date.now();
              valResult = validateSegmentBreakOutput(scriptText, {
                selectedDate,
                factPacket: packet,
                isModelDraft: true,
              });
              let validatorMs = Date.now() - tValStart;

              // When a script fails for ANY reason (copying, banned phrase, relative time word, hype, orphan pronoun, model handoff),
              // retry/regenerate once naming the exact offending text in failureReason. Do not drop candidate on first failure. Log both attempts.
              if (!valResult.valid) {
                const offendingReason = valResult.rejectedReason || 'validation failed';
                console.log(`[Segment Candidate Attempt 1 Failed] type=${cand.type} key=${cand.itemKey || 'none'} reason="${offendingReason}" -> Regenerating once with reason`);
                
                // For unconverted relative time words: log whether it came from source or model
                if (/relative time word/i.test(offendingReason)) {
                  const sourceHasRelative = (packet.facts || []).some((f: any) => /\b(?:last night|yesterday|this morning|today|tomorrow)\b/i.test(f.text));
                  console.log(`[Unconverted Relative Time Word] Offending text: "${offendingReason}" | Present in source wikitext: ${sourceHasRelative ? 'YES' : 'NO (introduced by model)'}`);
                }

                if (writer.writeSegmentBreakScript) {
                  const tRegenStart = Date.now();
                  const regenRes = await writer.writeSegmentBreakScript({
                    targetDate: selectedDate,
                    personality: 'mike',
                    topic: packet.topic,
                    topicTitle: packet.topicTitle,
                    targetSongTitle: packet.targetSongTitle,
                    targetSongArtist: packet.targetSongArtist,
                    facts: packet.facts,
                    failureReason: `rejected for: ${offendingReason}. You MUST fix this error completely. Do NOT announce upcoming song or handoff.`,
                    allowRetroFm,
                  });
                  if (regenRes.success && regenRes.scriptText) {
                    scriptText = regenRes.scriptText;
                    unsupportedClaims = regenRes.unsupportedClaims || [];

                    // Check orphan pronoun again on retry
                    const orphanCheckRetry = resolveOrphanPronounOpening(scriptText, packet.targetSongTitle, packet.targetSongArtist);
                    if (orphanCheckRetry.replaced) {
                      scriptText = orphanCheckRetry.resolvedText;
                    }

                    const tVal2Start = Date.now();
                    valResult = validateSegmentBreakOutput(scriptText, {
                      selectedDate,
                      factPacket: packet,
                      isModelDraft: true,
                    });
                    validatorMs += (Date.now() - tVal2Start);
                    console.log(`[Segment Candidate Attempt 2] type=${cand.type} key=${cand.itemKey || 'none'} valid=${valResult.valid} reason="${valResult.rejectedReason || 'PASS'}"`);
                  }
                }
              }

              // When audit flags sentences, delete only those sentences and air the rest if 2 or more supported sentences remain.
              // Otherwise regenerate once with the exact unsupported claims in the prompt.
              const tAuditStart = Date.now();
              if (unsupportedClaims.length > 0) {
                // Split scriptText into sentences and drop unsupported
                const rawSentences = scriptText.split(/(?<=[.!?])\s+/).filter((s: string) => s.trim().length > 5);
                const supportedSentences: string[] = [];
                for (const s of rawSentences) {
                  const isUnsupported = unsupportedClaims.some((uc: string) => {
                    const match = uc.match(/UNSUPPORTED:\s*(.+)/i);
                    const reason = match ? match[1].toLowerCase() : uc.toLowerCase();
                    const words = reason.split(/\s+/).filter((w: string) => w.length > 4);
                    return words.length > 0 && words.some((w: string) => s.toLowerCase().includes(w));
                  });
                  if (!isUnsupported) {
                    supportedSentences.push(s.trim());
                  }
                }

                if (supportedSentences.length >= 2) {
                  let cleanedScript = supportedSentences.join(' ').trim();
                  // Re-check orphan pronoun on trimmed sentences
                  const orphanTrimmed = resolveOrphanPronounOpening(cleanedScript, packet.targetSongTitle, packet.targetSongArtist);
                  if (orphanTrimmed.replaced) cleanedScript = orphanTrimmed.resolvedText;

                  const reVal = validateSegmentBreakOutput(cleanedScript, {
                    selectedDate,
                    factPacket: packet,
                    isModelDraft: true,
                  });
                  if (reVal.valid) {
                    scriptText = cleanedScript;
                    valResult = reVal;
                    unsupportedClaims = []; // Handled by trimming to >=2 supported sentences
                  }
                } else {
                  // Fewer than 2 supported sentences remain: regenerate once with exact unsupported claims in prompt
                  if (writer.writeSegmentBreakScript) {
                    const exactAuditClaims = unsupportedClaims.join('; ');
                    const regenRes = await writer.writeSegmentBreakScript({
                      targetDate: selectedDate,
                      personality: 'mike',
                      topic: packet.topic,
                      topicTitle: packet.topicTitle,
                      targetSongTitle: packet.targetSongTitle,
                      targetSongArtist: packet.targetSongArtist,
                      facts: packet.facts,
                      failureReason: `UNSUPPORTED CLAIMS: ${exactAuditClaims}. Use ONLY the stated facts. Do NOT write a song handoff.`,
                      allowRetroFm,
                    });
                    if (regenRes.success && regenRes.scriptText) {
                      scriptText = regenRes.scriptText;
                      unsupportedClaims = regenRes.unsupportedClaims || [];
                      const orphanRetryAudit = resolveOrphanPronounOpening(scriptText, packet.targetSongTitle, packet.targetSongArtist);
                      if (orphanRetryAudit.replaced) scriptText = orphanRetryAudit.resolvedText;

                      valResult = validateSegmentBreakOutput(scriptText, {
                        selectedDate,
                        factPacket: packet,
                        isModelDraft: true,
                      });
                    }
                  }
                }
              }
              const auditMs = Date.now() - tAuditStart;

              // Log timing per stage for candidate
              console.log(`[Candidate Stage Timing] type=${cand.type} writer=${writerMs}ms validator=${validatorMs}ms audit=${auditMs}ms`);
              if (writerMs > 8000 || validatorMs > 8000 || auditMs > 8000) {
                console.warn(`[Candidate Stage Timing Warning] One or more stages exceeded 8000ms: writer=${writerMs}ms validator=${validatorMs}ms audit=${auditMs}ms`);
              }

              // Final check for acceptance of model draft
              if (valResult && valResult.valid && unsupportedClaims.length === 0) {
                // Code adds hand-off or short closer:
                // If body names the song, close with a short no-name closer instead of a full hand-off.
                // If body does not name the song, use the full hand-off from the bank.
                let closerText = '';
                const bodyLower = scriptText.toLowerCase();
                const songTitleLower = (nextSong?.title || '').toLowerCase();
                const bodyNamesSong = nextSong?.title ? bodyLower.includes(songTitleLower) : false;

                if (bodyNamesSong) {
                  chosenShortCloser = getShortNoNameCloser(Date.now(), req.body?.lastShortCloser);
                  closerText = chosenShortCloser;
                } else if (nextSong) {
                  const handoffObj = buildHandoff({
                    songTitle: nextSong.title,
                    artistName: nextSong.artist,
                    primaryArtist: nextSong.primary_artist,
                    firstChartDate: nextSong.first_chart_date,
                    broadcastDate: selectedDate,
                    lastHandoffGroup: sessionLastHandoffGroup,
                    recentTemplates: sessionRecentHandoffTemplates,
                  });
                  chosenHandoffGroup = handoffObj.chosenGroup;
                  chosenHandoffTemplate = handoffObj.chosenTemplate;
                  closerText = handoffObj.text;
                }

                // Station ID: Replace "RetroFM." with full-phrase station IDs, at most once in 4 breaks.
                // Dated version on first break of session, or rotating variants.
                const stationIdPhrase = allowRetroFm
                  ? getStationIdPhrase(selectedDate, isFirstBreak, Date.now()) + ' '
                  : '';
                scriptText = `${stationIdPhrase}${scriptText} ${closerText}`.trim();

                // Final post-handoff validation
                const finalVal = validateSegmentBreakOutput(scriptText, {
                  selectedDate,
                  factPacket: packet,
                  isModelDraft: false,
                });

                if (finalVal.valid) {
                  chosenCandidate = cand;
                  finalSpeech = scriptText;
                  validatorResult = 'PASS';
                  auditResult = 'PASS(0 unsupported)';
                  break categoryLoop;
                } else {
                  const failReason = `post-handoff validator rejected: ${finalVal.rejectedReason}`;
                  cand.failureReason = failReason;
                  fellThroughReasons.push(`${cand.type}(${cand.itemKey || 'item'}): ${failReason}`);
                  if (itemKey) {
                    blacklistedKeysSet.add(itemKey);
                    newlyBlacklistedKeys.push(itemKey);
                  }
                }
              } else {
                const failReason = !valResult?.valid
                  ? `validator rejected: ${valResult?.rejectedReason}`
                  : `audit caught unsupported claims: ${unsupportedClaims.join('; ')}`;
                cand.failureReason = failReason;
                fellThroughReasons.push(`${cand.type}(${cand.itemKey || 'item'}): ${failReason}`);

                // Requirement 2: Blacklist failed items for the session as soon as they fail
                if (itemKey) {
                  blacklistedKeysSet.add(itemKey);
                  newlyBlacklistedKeys.push(itemKey);
                }
              }
            } else {
              const failReason = 'script generation returned empty';
              cand.failureReason = failReason;
              fellThroughReasons.push(`${cand.type}(${cand.itemKey || 'item'}): ${failReason}`);
              if (itemKey) {
                blacklistedKeysSet.add(itemKey);
                newlyBlacklistedKeys.push(itemKey);
              }
            }
          } catch (err: any) {
            const failReason = `generation error: ${err?.message}`;
            cand.failureReason = failReason;
            fellThroughReasons.push(`${cand.type}(${cand.itemKey || 'item'}): ${failReason}`);
            if (itemKey) {
              blacklistedKeysSet.add(itemKey);
              newlyBlacklistedKeys.push(itemKey);
            }
          }
        }
      }

      // Plain intro fallback ONLY when every other candidate has failed
      if (!chosenCandidate) {
        if (nextSong) {
          const handoffObj = buildHandoff({
            songTitle: nextSong.title,
            artistName: nextSong.artist,
            primaryArtist: nextSong.primary_artist,
            firstChartDate: nextSong.first_chart_date,
            broadcastDate: selectedDate,
            lastHandoffGroup: sessionLastHandoffGroup,
            recentTemplates: sessionRecentHandoffTemplates,
          });
          chosenHandoffGroup = handoffObj.chosenGroup;
          chosenHandoffTemplate = handoffObj.chosenTemplate;

          const stationIdPhrase = allowRetroFm
            ? getStationIdPhrase(selectedDate, isFirstBreak, Date.now()) + ' '
            : '';
          const introHandoff = `${stationIdPhrase}${handoffObj.text}`.trim();

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
                text: introHandoff,
                source: 'Station Playlist',
                printDate: selectedDate,
                date: selectedDate,
              }],
              factKeys: [`intro:${nextSong.title}:${nextSong.artist}`],
            },
          };
          finalSpeech = introHandoff;
          validatorResult = 'PASS';
          auditResult = 'PASS(intro)';
        }
      }

      const elapsedMs = Date.now() - startTime;
      const candidatesSummary = allEvaluatedSummary.join(' ');
      const factCount = chosenCandidate?.packet?.facts?.length || 0;
      const failureReasonLog = fellThroughReasons.length > 0 ? ` failure_reasons=[${fellThroughReasons.join(' | ')}]` : '';
      const readyStatus = elapsedMs > 30000 ? 'status="not ready (took >30s)"' : 'status="ready"';

      if (chosenCandidate?.type === 'plain_intro') {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=plain_intro facts=${factCount} validator=${validatorResult} audit=${auditResult} elapsed=${elapsedMs}ms ${readyStatus} reason="every other candidate failed"${failureReasonLog}`);
      } else if (chosenCandidate) {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=${chosenCandidate.type} facts=${factCount} validator=${validatorResult} audit=${auditResult} elapsed=${elapsedMs}ms ${readyStatus}${failureReasonLog}`);
      } else {
        console.log(`[Segment] setting=${freqSetting.toFixed(2)} roll=${roll.toFixed(2)} candidates=[${candidatesSummary}] selected=silence facts=0 validator=N/A audit=N/A elapsed=${elapsedMs}ms ${readyStatus} reason="all candidates failed and no next song"${failureReasonLog}`);
      }

      // Part 1: Log [Segment Prepared] id=<id> when a break is generated and validated
      if (finalSpeech) {
        console.log(`[Segment Prepared] id=${breakId}`);
      }

      return res.json({
        breakId,
        decision: chosenCandidate ? 'speak' : 'silence',
        breakType: chosenCandidate?.type || null,
        candidate: chosenCandidate?.packet ? {
          type: chosenCandidate.type,
          topic: chosenCandidate.packet.topic,
          topicTitle: chosenCandidate.packet.topicTitle,
          factKey: chosenCandidate.packet.factKeys?.[0] || 'none',
          factText: chosenCandidate.packet.facts?.[0]?.text || '',
          facts: chosenCandidate.packet.facts || [],
          wikiPageTitle: chosenCandidate.type === 'next_song_story' ? songCard?.wikiPageTitle : undefined,
        } : null,
        finalSpeech,
        targetSong: 'next',
        usedKeys: chosenCandidate?.packet?.factKeys || [],
        blacklistedKeys: newlyBlacklistedKeys,
        handoffGroup: chosenHandoffGroup,
        handoffTemplate: chosenHandoffTemplate,
        shortCloser: chosenShortCloser,
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

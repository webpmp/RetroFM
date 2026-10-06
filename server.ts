import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GeminiTTSProvider } from './src/services/tts/GeminiTTSProvider.js';
import { createZipFromDirectory } from './src/server/zipUtil.js';
import { searchYouTubeForSong } from './src/services/music/songSearch.js';

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

  // API Route: Program song search & selection
  app.post('/api/music/search', async (req, res) => {
    try {
      const { artist, song, year } = req.body;
      if (!artist || !song) {
        return res.status(400).json({
          success: false,
          error: 'Artist and song title are required.',
        });
      }

      console.log(`[API /api/music/search] Query: "${artist} - ${song}" (${year || 'any year'})`);
      const result = await searchYouTubeForSong(artist, song, year);
      return res.json(result);
    } catch (err: any) {
      console.error('[API /api/music/search] Error:', err);
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to search YouTube for song',
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

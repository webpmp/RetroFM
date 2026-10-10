import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const manifestPath = path.join(rootDir, 'extension', 'manifest.json');
const bundlePath = path.join(rootDir, 'src', 'services', 'extensionBundle.ts');

if (!fs.existsSync(manifestPath)) {
  console.error('Error: extension/manifest.json not found');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const currentVersion = manifest.version || '1.0.0';

const isBump = process.argv.includes('--bump');

let newVersion = currentVersion;
if (isBump) {
  const parts = currentVersion.split('.').map((n: string) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  newVersion = parts.join('.');
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Bumped extension version: ${currentVersion} -> ${newVersion}`);
} else {
  console.log(`Synchronizing extension bundle for version: ${newVersion}`);
}

// Read all extension files recursively
const extensionDir = path.join(rootDir, 'extension');
const filesRecord: Record<string, string> = {};

function scanDirectory(dir: string, baseDir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      scanDirectory(fullPath, baseDir);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.png')) {
        const buf = fs.readFileSync(fullPath);
        filesRecord[relPath] = `data:image/png;base64,${buf.toString('base64')}`;
      } else {
        filesRecord[relPath] = fs.readFileSync(fullPath, 'utf8');
      }
    }
  }
}

scanDirectory(extensionDir, extensionDir);

// Generate src/services/extensionBundle.ts
const bundleCode = `// Generated automatically from extension/ directory.
// DO NOT EDIT MANUALLY. Run 'npm run bump-extension' or 'npm run sync-extension'.

import JSZip from 'jszip';
import manifest from '../../extension/manifest.json';

export const EXTENSION_VERSION = manifest.version;

export const EXTENSION_FILES: Record<string, string> = ${JSON.stringify(filesRecord, null, 2)};

export async function generateAndDownloadExtensionZip(): Promise<void> {
  const zip = new JSZip();
  const folderName = 'retrofm-extension';
  const folder = zip.folder(folderName) || zip;

  const now = new Date();
  for (const [filename, content] of Object.entries(EXTENSION_FILES)) {
    if (filename.endsWith('.png') || content.startsWith('data:image/png;base64,')) {
      const b64 = content.replace(/^data:image\\/png;base64,/, '');
      folder.file(filename, b64, {
        base64: true,
        date: now,
        unixPermissions: '644',
      });
    } else {
      folder.file(filename, content, {
        date: now,
        unixPermissions: '644',
      });
    }
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = \`retrofm-extension-v\${EXTENSION_VERSION}.zip\`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 5000);
}
`;

fs.writeFileSync(bundlePath, bundleCode, 'utf8');
console.log(`Successfully generated ${bundlePath}`);

// Verify zip output and verify PNG sizes
async function verifyZip() {
  const zip = new JSZip();
  const folderName = 'retrofm-extension';
  const folder = zip.folder(folderName) || zip;
  for (const [filename, content] of Object.entries(filesRecord)) {
    if (filename.endsWith('.png') || content.startsWith('data:image/png;base64,')) {
      const b64 = content.replace(/^data:image\/png;base64,/, '');
      folder.file(filename, b64, { base64: true });
    } else {
      folder.file(filename, content);
    }
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const reloaded = await JSZip.loadAsync(zipBuf);

  console.log('\\n--- Exported Zip File Manifest ---');
  let hasZeroBytePng = false;
  for (const [entryPath, entry] of Object.entries(reloaded.files)) {
    if (!entry.dir) {
      const entryBuf = await entry.async('nodebuffer');
      console.log(`  ${entryPath}: ${entryBuf.length} bytes`);
      if (entryPath.endsWith('.png') && entryBuf.length === 0) {
        hasZeroBytePng = true;
      }
    }
  }

  if (hasZeroBytePng) {
    console.error('ERROR: Detected 0-byte PNG file in generated ZIP archive!');
    process.exit(1);
  } else {
    console.log('Verification: All PNGs verified non-zero bytes in exported ZIP bundle.\\n');
  }
}

verifyZip().catch((err) => {
  console.error('Error during zip verification:', err);
  process.exit(1);
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Read all extension files
const extensionDir = path.join(rootDir, 'extension');
const fileNames = [
  'manifest.json',
  'background.js',
  'content_retrofm.js',
  'content_youtube.js',
  'popup.html',
  'README.md',
  'LICENSE'
];

const filesRecord: Record<string, string> = {};
for (const name of fileNames) {
  const filePath = path.join(extensionDir, name);
  if (fs.existsSync(filePath)) {
    filesRecord[name] = fs.readFileSync(filePath, 'utf8');
  }
}

// Generate src/services/extensionBundle.ts
const bundleCode = `// Generated automatically from extension/ directory.
// DO NOT EDIT MANUALLY. Run 'npm run bump-extension' or 'npm run sync-extension'.

import JSZip from 'jszip';
import manifest from '../../extension/manifest.json';

export const EXTENSION_VERSION = manifest.version;

export const EXTENSION_FILES: Record<string, string> = ${JSON.stringify(filesRecord, null, 2)};

export async function generateAndDownloadExtensionZip(): Promise<void> {
  const zip = new JSZip();
  const folderName = \`retro-fm-extension-v\${EXTENSION_VERSION}\`;
  const folder = zip.folder(folderName) || zip;

  const now = new Date();
  for (const [filename, content] of Object.entries(EXTENSION_FILES)) {
    folder.file(filename, content, {
      date: now,
      unixPermissions: '644',
    });
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
  anchor.download = \`retro-fm-extension-v\${EXTENSION_VERSION}.zip\`;
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

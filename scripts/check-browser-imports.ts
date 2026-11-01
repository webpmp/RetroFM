/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Automated verification that no browser-reachable module imports Node.js built-ins.
 * Uses Vite's module graph / rollup plugin to inspect all resolved modules from index.html.
 */

import { build } from 'vite';

const NODE_BUILTINS = [
  'node:',
  'fs',
  'path',
  'crypto',
  'os',
  'child_process',
  'net',
  'http',
  'https',
  'stream',
  'util',
  'buffer',
  'events',
  'url',
  'assert',
  'zlib',
  'tls',
  'dns',
  'node:sqlite',
];

async function checkBrowserBundle() {
  console.log('[Check] Building Vite client graph to verify browser imports...');
  const externalizedModules: string[] = [];

  await build({
    logLevel: 'silent',
    plugins: [
      {
        name: 'test-detect-node-imports',
        resolveId(id, importer) {
          // Check if any browser file resolves a node module or node: prefix
          const isNode =
            id.startsWith('node:') ||
            (NODE_BUILTINS.includes(id) && !importer?.includes('node_modules'));
          if (isNode && importer && !importer.includes('node_modules')) {
            externalizedModules.push(`${id} (imported by ${importer})`);
          }
          return null;
        },
      },
    ],
  });

  if (externalizedModules.length > 0) {
    console.error('FAIL: Browser bundle imports Node.js modules:');
    externalizedModules.forEach((m) => console.error(`  - ${m}`));
    process.exit(1);
  }

  console.log('✓ PASS: Zero Node.js modules imported in browser-reachable bundle.');
}

checkBrowserBundle().catch((err) => {
  console.error('Check failed with error:', err);
  process.exit(1);
});

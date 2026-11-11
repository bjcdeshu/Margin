/**
 * Deterministic Chrome MV3 extension build script for Margin.
 *
 * Step 1: Vite builds extension HTML UI apps (popup.html, options.html, pdf.html) + copies public/.
 * Step 2: esbuild bundles Service Worker (ESM background.js) + 4 self-contained IIFE content scripts.
 * Step 3: Copies lazy PDF.js worker (`pdf.worker.min.mjs`) into dist/ for offline PDF translation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const tsconfigPath = path.join(rootDir, 'tsconfig.json');

async function main() {
  const t0 = Date.now();

  // 1. Build HTML UI pages + copy public/ into dist/
  await viteBuild({
    configFile: path.join(rootDir, 'vite.config.ts'),
    logLevel: 'info',
  });

  // 2. Bundle Service Worker (ESM) and Content Scripts (self-contained IIFEs)
  const scriptTargets = [
    {
      entry: 'src/background/index.ts',
      outfile: 'dist/background.js',
      format: 'esm',
    },
    {
      entry: 'src/content/index.ts',
      outfile: 'dist/content.js',
      format: 'iife',
    },
    {
      entry: 'src/youtube/isolated-entry.ts',
      outfile: 'dist/subtitles.js',
      format: 'iife',
    },
    {
      entry: 'src/youtube/main-entry.ts',
      outfile: 'dist/youtube-main.js',
      format: 'iife',
    },
    {
      entry: 'src/media/image-entry.ts',
      outfile: 'dist/image-translate.js',
      format: 'iife',
    },
  ];

  await Promise.all(
    scriptTargets.map((target) =>
      esbuild.build({
        entryPoints: [path.join(rootDir, target.entry)],
        outfile: path.join(rootDir, target.outfile),
        bundle: true,
        format: target.format,
        platform: 'browser',
        target: 'es2022',
        charset: 'utf8',
        minify: true,
        legalComments: 'none',
        tsconfig: tsconfigPath,
        jsx: 'automatic',
        jsxImportSource: 'preact',
      }),
    ),
  );

  // 3. Copy PDF.js worker for lazy loading inside pdf.html
  const pdfWorkerSrc = path.join(
    rootDir,
    'node_modules',
    'pdfjs-dist',
    'build',
    'pdf.worker.min.mjs',
  );
  const pdfWorkerDest = path.join(distDir, 'pdf.worker.min.mjs');
  if (fs.existsSync(pdfWorkerSrc)) {
    fs.copyFileSync(pdfWorkerSrc, pdfWorkerDest);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[margin] MV3 extension built cleanly in ${elapsed}s -> dist/`);
}

main().catch((err) => {
  console.error('[margin] Build failed:', err);
  process.exit(1);
});

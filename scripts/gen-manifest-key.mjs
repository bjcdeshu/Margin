/**
 * One-time deterministic Chrome MV3 public manifest "key" generator.
 *
 * Generates an ephemeral RSA-2048 keypair in memory via node:crypto, writes ONLY
 * the public SPKI DER base64 string into public/manifest.json ("key") and the
 * derived 32-char Chrome Extension ID (a-p) into src/shared/brand.ts.
 *
 * SECURITY: The private key is immediately discarded in memory and NEVER written to disk.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'public', 'manifest.json');
const brandPath = path.join(rootDir, 'src', 'shared', 'brand.ts');

export function computeExtensionIdFromSpkiBase64(spkiBase64) {
  const der = Buffer.from(spkiBase64, 'base64');
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i];
    id += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let spkiBase64 = typeof manifest.key === 'string' ? manifest.key.trim() : '';
if (!spkiBase64) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  spkiBase64 = Buffer.from(spkiDer).toString('base64');
  manifest.key = spkiBase64;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const extensionId = computeExtensionIdFromSpkiBase64(spkiBase64);

if (fs.existsSync(brandPath)) {
  const brandSrc = fs.readFileSync(brandPath, 'utf8');
  const updated = brandSrc.replace(
    /pinnedExtensionId:\s*'[^']*'/,
    `pinnedExtensionId: '${extensionId}'`,
  );
  if (updated !== brandSrc) {
    fs.writeFileSync(brandPath, updated, 'utf8');
  }
}

console.log(`[margin] Pinned unpacked Extension ID: ${extensionId}`);

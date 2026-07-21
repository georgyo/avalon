import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';

const __dirname = dirname(fileURLToPath(import.meta.url));

// When the Firebase emulators are running, the Admin SDK talks to them over
// plain HTTP and never validates credentials, so there is no service account
// to load. The SDK picks the emulators up from these env vars on its own; all
// we have to do is skip the cert() path and name the project.
const usingEmulators = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST
);

if (usingEmulators) {
  initializeApp({
    projectId: process.env.GCLOUD_PROJECT || 'georgyo-avalon'
  });
} else {
  let serviceAccount: Record<string, unknown>;

  if (process.env.FIREBASE_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  } else {
    const keyFile = process.env.FIREBASE_KEY_FILE || path.join(__dirname, 'firebase-key.json');
    serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  }

  initializeApp({
    credential: cert(serviceAccount as Parameters<typeof cert>[0])
  });
}

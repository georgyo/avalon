import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export default serviceAccount;

const path = require('path');
const { readEnv } = require('read-env');

// Try FIREBASE_KEY as a JSON string first
if (process.env.FIREBASE_KEY) {
  module.exports = JSON.parse(process.env.FIREBASE_KEY);
} else {
  // Try FIREBASE_KEY_* env vars (read-env strips prefix and camelCases)
  const envConfig = readEnv('FIREBASE_KEY');
  if (envConfig && Object.keys(envConfig).length > 0) {
    module.exports = envConfig;
  } else {
    // Fall back to JSON file
    const keyFile = process.env.FIREBASE_KEY_FILE || path.join(__dirname, 'firebase-key.json');
    module.exports = require(keyFile);
  }
}

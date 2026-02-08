const path = require('path');
const { readEnv } = require('read-env');

const envKey = readEnv('FIREBASE_KEY')[''];
if (envKey) {
  module.exports = envKey;
} else {
  const keyFile = process.env.FIREBASE_KEY_FILE || path.join(__dirname, 'firebase-key.json');
  module.exports = require(keyFile);
}

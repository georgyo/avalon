const { readEnv } = require('read-env');
const firebaseKeyJson = process.env.FIREBASE_KEY_FILE || "./firebase-key.json"
const serviceAccount = readEnv('FIREBASE_KEY')[''] || require(firebaseKeyJson);

module.exports = serviceAccount;

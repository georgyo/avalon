const fs = require('fs');
const path = require('path');

// Try FIREBASE_KEY as a JSON string first
if (process.env.FIREBASE_KEY) {
  module.exports = JSON.parse(process.env.FIREBASE_KEY);
} else {
  // Fall back to JSON file
  const keyFile = process.env.FIREBASE_KEY_FILE || path.join(__dirname, 'firebase-key.json');
  module.exports = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
}

const fs = require('fs');
const path = require('path');

// Load a local .env file without overriding variables supplied by the host.
// Node's process.loadEnvFile() overwrites existing keys, which would let a
// developer's .env silently replace Render/CI settings. Snapshot the existing
// environment, load the file, then restore anything that was already set.
function loadLocalEnv(filePath = path.resolve(__dirname, '../../.env')) {
  if (typeof process.loadEnvFile !== 'function') return;
  if (!fs.existsSync(filePath)) return;

  const existing = { ...process.env };
  try {
    process.loadEnvFile(filePath);
  } catch (err) {
    console.warn('[Config] Could not load .env:', err.message);
  } finally {
    for (const key of Object.keys(existing)) {
      process.env[key] = existing[key];
    }
  }
}

module.exports = { loadLocalEnv };

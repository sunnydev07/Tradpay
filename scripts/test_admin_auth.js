const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adminAuth = require('../server/engine/adminAuth');

const STRONG_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef';
const originalAdminKey = process.env.ADMIN_KEY;
const originalAdminSecret = process.env.ADMIN_SECRET;

function restoreEnv() {
  if (originalAdminKey === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = originalAdminKey;
  if (originalAdminSecret === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = originalAdminSecret;
}

test.after(restoreEnv);

test('admin auth fails closed without a configured key', () => {
  delete process.env.ADMIN_KEY;
  delete process.env.ADMIN_SECRET;

  const validation = adminAuth.validateConfiguredKey();
  assert.equal(validation.ok, false);
  assert.equal(adminAuth.isConfigured(), false);
  assert.equal(adminAuth.verifyKey('dev780@$$'), false);
  assert.equal(adminAuth.createAdminSession(), null);
  assert.equal(adminAuth.verifySessionToken('v1.fake.signature'), null);
});

test('production startup refuses to run without ADMIN_KEY', () => {
  const dbFile = path.join(os.tmpdir(), `tradepay-admin-guard-${process.pid}.json`);
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ADMIN_KEY: '',
      ADMIN_SECRET: '',
      TRADEPAY_DB_FILE: dbFile,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_KEY: 'test-key',
      ALLOW_SIMULATION: 'false',
      PORT: '0'
    }
  });

  try {
    assert.equal(result.status, 1, 'server must exit instead of starting without an admin key');
    assert.match(String(result.stderr || ''), /ADMIN_KEY is not set/);
  } finally {
    try { fs.rmSync(dbFile, { force: true }); } catch (e) {}
  }
});

test('admin auth rejects the old public default and weak keys', () => {
  process.env.ADMIN_KEY = 'dev780@$$';
  assert.equal(adminAuth.validateConfiguredKey().ok, false);
  assert.equal(adminAuth.verifyKey('dev780@$$'), false);

  process.env.ADMIN_KEY = 'short-key';
  assert.equal(adminAuth.validateConfiguredKey().ok, false);
  assert.equal(adminAuth.verifyKey('short-key'), false);

  process.env.ADMIN_KEY = 'change-me';
  assert.equal(adminAuth.validateConfiguredKey().ok, false);
});

test('admin auth accepts a strong key and rejects the wrong value', () => {
  process.env.ADMIN_KEY = STRONG_KEY;

  assert.equal(adminAuth.isConfigured(), true);
  assert.equal(adminAuth.verifyKey(STRONG_KEY), true);
  assert.equal(adminAuth.verifyKey(` ${STRONG_KEY} `), true);
  assert.equal(adminAuth.verifyKey('not-the-key'), false);
  assert.equal(adminAuth.verifyKey(''), false);
  assert.equal(adminAuth.verifyKey(null), false);
});

test('admin sessions are signed, expire, and reject tampering', () => {
  process.env.ADMIN_KEY = STRONG_KEY;

  const session = adminAuth.createAdminSession({ subject: 'admin-user-1' });
  assert.ok(session.token);
  assert.ok(session.expiresAt);

  const payload = adminAuth.verifySessionToken(session.token);
  assert.equal(payload.sub, 'admin-user-1');

  const tampered = session.token.slice(0, -1) + (session.token.endsWith('a') ? 'b' : 'a');
  assert.equal(adminAuth.verifySessionToken(tampered), null);

  const expired = adminAuth.createAdminSession({ ttlMs: -1000 });
  assert.equal(adminAuth.verifySessionToken(expired.token), null);

  // Rotating the key invalidates every issued session.
  process.env.ADMIN_KEY = `${STRONG_KEY}-rotated`;
  assert.equal(adminAuth.verifySessionToken(session.token), null);
});

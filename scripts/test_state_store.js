const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'fixtures', 'state_store_child.js');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

// Minimal PostgREST stand-in for the two calls used by stateStore:
//   GET  /rest/v1/tradepay_state           (load one row)
//   POST /rest/v1/rpc/save_tradepay_state  (monotonic upsert)
async function startMockSupabase(options = {}) {
  const calls = [];
  let row = options.row
    ? { ...options.row, state: JSON.parse(JSON.stringify(options.row.state)) }
    : null;
  let failReads = Boolean(options.failReads);
  let failWrites = Boolean(options.failWrites);
  const failWritesAfter = Number.isFinite(options.failWritesAfter)
    ? options.failWritesAfter
    : null;
  let successfulWrites = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push({ method: req.method, path: url.pathname });

    if (req.method === 'GET' && url.pathname === '/rest/v1/tradepay_state') {
      if (failReads) {
        return sendJson(res, 500, {
          code: 'XX000',
          message: 'simulated read outage',
          details: null,
          hint: null
        });
      }
      if (!row) return sendJson(res, 200, []);
      return sendJson(res, 200, [{
        id: row.id,
        revision: row.revision,
        state: row.state,
        updated_at: row.updated_at
      }]);
    }

    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/save_tradepay_state') {
      const shouldFail = failWrites ||
        (failWritesAfter !== null && successfulWrites >= failWritesAfter);
      if (shouldFail) {
        return sendJson(res, 500, {
          code: 'XX000',
          message: 'simulated write outage',
          details: null,
          hint: null
        });
      }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return sendJson(res, 400, { message: 'invalid JSON' });
      }

      const revision = Number(body.p_revision);
      if (!row) {
        row = {
          id: body.p_id,
          revision,
          state: body.p_state,
          updated_at: new Date().toISOString()
        };
      } else if (revision > Number(row.revision)) {
        row = {
          ...row,
          revision,
          state: body.p_state,
          updated_at: new Date().toISOString()
        };
      }

      successfulWrites++;
      return sendJson(res, 200, Number(row.revision));
    }

    return sendJson(res, 404, { message: 'not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    get row() { return row; },
    setFailReads(value) { failReads = value; },
    setFailWrites(value) { failWrites = value; },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// Run asynchronously: the mock Supabase server lives in this process, so a
// synchronous spawn would block the event loop and the child could never get a
// response.
function runChild(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TRADEPAY_STATE_BACKEND: '',
        TRADEPAY_STATE_ID: 'primary',
        SUPABASE_URL: '',
        SUPABASE_KEY: '',
        SUPABASE_SERVICE_ROLE_KEY: '',
        ALLOW_SIMULATION: 'false',
        ...env
      }
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      stderr += '\n[test] child timed out after 30s';
    }, 30000);
    timer.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

function parseChild(result) {
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('CHILD_RESULT '));
  assert.ok(
    line,
    `child did not return a result.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return JSON.parse(line.slice('CHILD_RESULT '.length));
}

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradepay-state-'));
  return {
    dir,
    file: path.join(dir, 'db.json'),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('state store reports incomplete Supabase configuration', () => {
  const stateStore = require('../server/engine/stateStore');
  const saved = {
    backend: process.env.TRADEPAY_STATE_BACKEND,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY
  };

  try {
    process.env.TRADEPAY_STATE_BACKEND = 'supabase';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    assert.match(stateStore.getConfigError(), /SUPABASE_SERVICE_ROLE_KEY/);

    process.env.SUPABASE_URL = '';
    assert.match(stateStore.getConfigError(), /SUPABASE_URL/);

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_KEY = '';
    assert.match(stateStore.getConfigError(), /SUPABASE_KEY/);

    process.env.TRADEPAY_STATE_BACKEND = '';
    assert.equal(stateStore.getConfigError(), null);
  } finally {
    for (const [envKey, value] of Object.entries({
      TRADEPAY_STATE_BACKEND: saved.backend,
      SUPABASE_URL: saved.url,
      SUPABASE_KEY: saved.key,
      SUPABASE_SERVICE_ROLE_KEY: saved.service
    })) {
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test('Supabase backend survives a restart without the local cache', async (t) => {
  const mock = await startMockSupabase();
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const env = {
    TRADEPAY_STATE_BACKEND: 'supabase',
    SUPABASE_URL: mock.url,
    SUPABASE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRADEPAY_DB_FILE: temp.file
  };

  const first = await runChild({ ...env, TEST_BALANCE: '4321.10', TEST_FLUSH_REMOTE: '1' });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = parseChild(first);
  assert.equal(firstResult.info.backend, 'supabase');
  assert.equal(firstResult.info.durable, true);
  assert.equal(firstResult.info.initialized, true);
  assert.equal(firstResult.balance, 4321.1);
  assert.ok(mock.row, 'first boot must seed the Supabase state row');
  assert.equal(mock.row.state.users['10086'].balance, 4321.1);

  // Prove the second boot reads from Supabase, not the local cache.
  fs.rmSync(temp.file, { force: true });

  const second = await runChild(env);
  assert.equal(second.status, 0, second.stderr);
  const secondResult = parseChild(second);
  assert.equal(secondResult.balance, 4321.1);
  assert.equal(secondResult.totalBalance, 4321.1);
  assert.equal(secondResult.info.revision, Number(mock.row.revision));
});

test('Supabase read failure aborts startup instead of starting empty', async (t) => {
  const mock = await startMockSupabase({ failReads: true });
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const result = await runChild({
    TRADEPAY_STATE_BACKEND: 'supabase',
    SUPABASE_URL: mock.url,
    SUPABASE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRADEPAY_DB_FILE: temp.file
  });

  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /Supabase state load failed/);
  assert.match(String(result.stderr), /simulated read outage/);
});

test('Supabase write failure aborts first boot instead of running unsaved', async (t) => {
  const mock = await startMockSupabase({ failWrites: true });
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const result = await runChild({
    TRADEPAY_STATE_BACKEND: 'supabase',
    SUPABASE_URL: mock.url,
    SUPABASE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRADEPAY_DB_FILE: temp.file
  });

  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /Supabase state save failed/);
  assert.match(String(result.stderr), /simulated write outage/);
});

test('a failed mutation is not reported as durably saved', async (t) => {
  // The initial seed succeeds; every later write fails. The balance change must
  // not reach the row and the child must surface the failure to its caller.
  const mock = await startMockSupabase({ failWritesAfter: 1 });
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const result = await runChild({
    TRADEPAY_STATE_BACKEND: 'supabase',
    SUPABASE_URL: mock.url,
    SUPABASE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRADEPAY_DB_FILE: temp.file,
    TEST_BALANCE: '999.99',
    TEST_FLUSH_REMOTE: '1'
  });

  assert.equal(result.status, 2);
  assert.match(String(result.stderr), /Supabase state save failed/);
  assert.equal(mock.row.state.users['10086'].balance, 0);
});

test('file backend still persists locally and never calls Supabase', async (t) => {
  const mock = await startMockSupabase();
  const temp = makeTempDb();
  t.after(async () => {
    await mock.close();
    temp.cleanup();
  });

  const env = {
    TRADEPAY_STATE_BACKEND: '',
    SUPABASE_URL: mock.url,
    SUPABASE_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    TRADEPAY_DB_FILE: temp.file
  };

  const first = await runChild({ ...env, TEST_BALANCE: '250.25', TEST_FLUSH_REMOTE: '1' });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = parseChild(first);
  assert.equal(firstResult.info.backend, 'file');
  assert.equal(firstResult.balance, 250.25);

  const supabaseCalls = mock.calls.filter((call) => call.path.startsWith('/rest/v1'));
  assert.deepEqual(supabaseCalls, []);

  const second = await runChild(env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(parseChild(second).balance, 250.25);
});

test('production startup rejects a Supabase backend without a service key', () => {
  const temp = makeTempDb();
  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: '0',
        TRADEPAY_STATE_BACKEND: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_KEY: 'test-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: '',
        TRADEPAY_DB_FILE: temp.file,
        ADMIN_KEY: 'test-admin-key-0123456789abcdef0123456789abcdef',
        ALLOW_SIMULATION: 'false'
      }
    });

    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    temp.cleanup();
  }
});

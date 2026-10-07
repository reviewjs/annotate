const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFeedbackServer } = require('../../examples/feedback-server.cjs');

test('sample receiver accepts Annotate exports and rejects malformed requests', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'annotate-feedback-'));
  const server = createFeedbackServer({ directory, allowedOrigin: 'http://localhost:4200' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/feedback`;
  const headers = { 'Content-Type': 'application/json', Origin: 'http://localhost:4200' };
  const payload = { kind: 'annotate-export', page: '/test', comments: [{ id: 'a', text: 'Review this' }] };

  const accepted = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  const { id } = await accepted.json();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8')), payload);

  const invalid = await fetch(endpoint, { method: 'POST', headers, body: '{' });
  assert.equal(invalid.status, 400);
  const wrongShape = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(wrongShape.status, 400);
  const denied = await fetch(endpoint, {
    method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify(payload),
  });
  assert.equal(denied.status, 403);
  const preflight = await fetch(endpoint, {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:4200' },
  });
  assert.equal(preflight.status, 204);
  const oversized = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ ...payload, filler: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await fs.readdir(directory)).length, 1);
});

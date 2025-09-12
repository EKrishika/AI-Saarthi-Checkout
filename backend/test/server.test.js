'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';

const app = require('../src/server');

// Boots the app on an ephemeral port for one request, then closes it.
async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('/api/health reports mode, provider and which config is present', async () => {
  const body = await withServer(async (base) => (await fetch(`${base}/api/health`)).json());
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'test');
  assert.ok(body.model, 'health should report the configured model');

  // The UI reads this to decide whether to show the setup banner, and which
  // env var to name in it — so the provider block has to be self-describing.
  assert.ok(body.llm, 'health should describe the LLM provider');
  assert.ok(body.llm.provider, 'provider id');
  assert.ok(body.llm.label, 'human-readable provider name');
  assert.ok(body.llm.signupUrl, 'where to get a key');
  assert.equal(typeof body.llm.free, 'boolean');
  assert.equal(typeof body.config.llm, 'boolean');
  assert.equal(typeof body.config.razorpay, 'boolean');
  assert.ok(body.guardrails.maxItemQuantity > 0);
});

/**
 * .env.example ships placeholder values. A placeholder is a non-empty string,
 * so a plain truthiness check would report "configured", hide the setup banner,
 * and leave the first real message failing with an opaque 401.
 */
test('an untouched placeholder key counts as not configured', () => {
  const { isKeyPresent } = require('../src/agent/llm');
  for (const placeholder of [
    'PASTE_YOUR_GROQ_KEY_HERE',
    'paste_your_key_here',
    'your-api-key',
    '<your key>',
    'xxxxxxxx',
    'sk-ant-xxxxxxxx',
    'change-me',
    '',
    '   ',
    undefined,
  ]) {
    assert.equal(isKeyPresent(placeholder), false, `${placeholder} must not count as a key`);
  }
  for (const real of ['gsk_abc123def456', 'AIzaSyRealLookingKey', 'sk-ant-api03-real']) {
    assert.equal(isKeyPresent(real), true, `${real} must count as a key`);
  }
});

test('an unknown LLM_PROVIDER falls back to a known one instead of crashing', () => {
  const llm = require('../src/agent/llm');
  const previous = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = 'not-a-real-provider';
  try {
    assert.equal(llm.providerName(), llm.DEFAULT_PROVIDER);
    assert.ok(llm.describe().label);
  } finally {
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
  }
});

/**
 * Regression test for a bug that silently broke every chat request: the raw
 * body parser for the webhook route was mounted on all of '/api', so
 * body-parser marked req._body and express.json() skipped parsing. req.body
 * arrived at /api/chat as a Buffer, sessionId was undefined, and the route
 * 400'd on every single message. The parser must stay scoped to the webhook
 * path — this test fails if anyone widens it again.
 */
test('/api/chat parses a JSON body (raw parser stays scoped to the webhook)', async () => {
  const { status, body } = await withServer(async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-body-parsing', message: 'hello' }),
    });
    return { status: res.status, body: await res.json() };
  });

  assert.notEqual(status, 400, 'a well-formed body must not be rejected as missing fields');
  assert.equal(status, 200);
  // Without an API key the LLM call fails, but it must fail *gracefully* —
  // a plain-language reply, never a crash or a raw stack trace.
  assert.equal(typeof body.reply, 'string');
  assert.ok(body.reply.length > 0);
  assert.ok(Array.isArray(body.cart));
});

test('/api/chat still rejects a genuinely malformed body', async () => {
  const status = await withServer(async (base) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'no session id' }),
    });
    return res.status;
  });
  assert.equal(status, 400);
});

test('webhook route receives the raw bytes and verifies a real signature', async () => {
  const payload = JSON.stringify({ event: 'payment_link.paid', payload: {} });
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  const status = await withServer(async (base) => {
    const res = await fetch(`${base}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
      body: payload,
    });
    return res.status;
  });
  assert.equal(status, 200, 'a correctly signed webhook must be accepted');
});

test('webhook route rejects a bad signature', async () => {
  const status = await withServer(async (base) => {
    const res = await fetch(`${base}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      body: JSON.stringify({ event: 'payment_link.paid' }),
    });
    return res.status;
  });
  assert.equal(status, 400);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MANDATE_SIGNING_SECRET = 'test-mandate-secret';
process.env.MAX_ORDER_VALUE_INR = '50000';

const mandate = require('../src/agent/mandate');
const guardrails = require('../src/agent/guardrails');

function grant(overrides) {
  return mandate.issue(
    Object.assign(
      {
        subject: 'Aisha',
        maxTotalPaise: 800000, // ₹8,000
        maxPerOrderPaise: 500000, // ₹5,000
        allowedCategories: ['audio'],
        maxTransactions: 2,
        ttlMinutes: 60,
      },
      overrides
    )
  );
}

const NO_USAGE = { spentPaise: 0, transactions: 0 };

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
}

test('an issued mandate verifies against its own signature', () => {
  assert.equal(mandate.verifySignature(grant()), true);
});

/**
 * The core security property: the agent holds the mandate, so it must not be
 * able to widen its own authority by editing the object it was handed.
 */
test('widening any granted field invalidates the signature', () => {
  const original = grant();
  const fields = {
    maxTotalPaise: 99_00_00_000,
    maxPerOrderPaise: 99_00_00_000,
    maxTransactions: 999,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    allowedCategories: ['audio', 'storage'],
    subject: 'Someone Else',
  };
  for (const [field, value] of Object.entries(fields)) {
    const forged = Object.assign({}, original, { [field]: value });
    assert.equal(mandate.verifySignature(forged), false, `${field} must be covered by the signature`);
  }
});

test('a mandate signed with a different secret does not verify', () => {
  const original = grant();
  const previous = process.env.MANDATE_SIGNING_SECRET;
  process.env.MANDATE_SIGNING_SECRET = 'a-different-secret';
  try {
    assert.equal(mandate.verifySignature(original), false);
  } finally {
    process.env.MANDATE_SIGNING_SECRET = previous;
  }
});

test('a missing or malformed signature fails closed', () => {
  assert.equal(mandate.verifySignature(null), false);
  assert.equal(mandate.verifySignature({}), false);
  assert.equal(mandate.verifySignature(Object.assign({}, grant(), { signature: 'short' })), false);
});

test('unattended checkout inside the mandate is authorised by the mandate', () => {
  const result = guardrails.assertCheckoutAuthorized({
    mode: 'unattended',
    mandate: grant(),
    usage: NO_USAGE,
    totalPaise: 349900,
    categories: ['audio'],
  });
  assert.equal(result.authority, 'mandate');
});

test('each mandate limit rejects with its own specific code', () => {
  const g = grant();
  const cases = [
    ['MANDATE_PER_ORDER_EXCEEDED', { totalPaise: 600000, categories: ['audio'], usage: NO_USAGE }],
    ['MANDATE_BUDGET_EXCEEDED', { totalPaise: 200000, categories: ['audio'], usage: { spentPaise: 700000, transactions: 1 } }],
    ['MANDATE_CATEGORY_NOT_ALLOWED', { totalPaise: 100000, categories: ['storage'], usage: NO_USAGE }],
    ['MANDATE_TRANSACTIONS_EXHAUSTED', { totalPaise: 100000, categories: ['audio'], usage: { spentPaise: 0, transactions: 2 } }],
  ];
  for (const [expected, ctx] of cases) {
    const code = codeOf(() =>
      guardrails.assertCheckoutAuthorized(Object.assign({ mode: 'unattended', mandate: g }, ctx))
    );
    assert.equal(code, expected);
  }
});

test('issuing with a nonsensical lifetime is refused rather than defaulted', () => {
  for (const bad of [0, -1, 'soon', NaN]) {
    assert.throws(() => grant({ ttlMinutes: bad }), /positive number/, `ttlMinutes=${bad}`);
  }
});

test('an expired mandate cannot spend, however much budget is left', () => {
  // Properly signed, but time has passed — the real-world expiry case.
  const expired = grant();
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  expired.signature = mandate.sign(expired);
  const code = codeOf(() =>
    guardrails.assertCheckoutAuthorized({
      mode: 'unattended',
      mandate: expired,
      usage: NO_USAGE,
      totalPaise: 1000,
      categories: ['audio'],
    })
  );
  assert.equal(code, 'MANDATE_EXPIRED');
});

test('a forged mandate is rejected before any limit is even evaluated', () => {
  const forged = Object.assign({}, grant(), { maxTotalPaise: 99_00_00_000 });
  const code = codeOf(() =>
    guardrails.assertCheckoutAuthorized({
      mode: 'unattended',
      mandate: forged,
      usage: NO_USAGE,
      totalPaise: 1000,
      categories: ['audio'],
    })
  );
  assert.equal(code, 'MANDATE_SIGNATURE_INVALID');
});

test('unattended checkout with no mandate at all is refused', () => {
  const code = codeOf(() =>
    guardrails.assertCheckoutAuthorized({ mode: 'unattended', totalPaise: 1000, categories: ['audio'] })
  );
  assert.equal(code, 'NO_MANDATE');
});

/**
 * A mandate narrows authority; it can never widen it past what the merchant
 * configured. Effective authority is the intersection of the two.
 */
test('the merchant ceiling still applies to a mandate that exceeds it', () => {
  const oversized = grant({ maxTotalPaise: 900000000, maxPerOrderPaise: 900000000 });
  const code = codeOf(() =>
    guardrails.assertCheckoutAuthorized({
      mode: 'unattended',
      mandate: oversized,
      usage: NO_USAGE,
      totalPaise: 60000 * 100, // ₹60,000 — over the ₹50,000 merchant cap
      categories: ['audio'],
    })
  );
  assert.equal(code, 'ORDER_VALUE_CAP_EXCEEDED');
});

test('an unscoped category list authorises any category', () => {
  const anyCategory = grant({ allowedCategories: [] });
  assert.doesNotThrow(() =>
    guardrails.assertCheckoutAuthorized({
      mode: 'unattended',
      mandate: anyCategory,
      usage: NO_USAGE,
      totalPaise: 100000,
      categories: ['storage', 'bags'],
    })
  );
});

/**
 * Regression: maxTransactions === 0 was previously skipped as "unlimited",
 * which turned the most restrictive grant into the most permissive one. The
 * most locked-down mandate must never be the one that authorises everything.
 */
test('a mandate authorising zero transactions authorises nothing', () => {
  const code = codeOf(() =>
    guardrails.assertCheckoutAuthorized({
      mode: 'unattended',
      mandate: grant({ maxTransactions: 0 }),
      usage: NO_USAGE,
      totalPaise: 100000,
      categories: ['audio'],
    })
  );
  assert.equal(code, 'MANDATE_TRANSACTIONS_EXHAUSTED');
});

test('an unspecified transaction count defaults to a single transaction', () => {
  const g = mandate.issue({ maxTotalPaise: 800000, maxPerOrderPaise: 500000 });
  assert.equal(g.maxTransactions, 1);
});

test('remaining() reports budget and transactions left', () => {
  const g = grant();
  const left = mandate.remaining(g, { spentPaise: 300000, transactions: 1 });
  assert.equal(left.budgetPaise, 500000);
  assert.equal(left.transactions, 1);
  assert.equal(left.expired, false);
});

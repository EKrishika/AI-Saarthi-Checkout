'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const recovery = require('../src/growth/recovery');

function session(overrides) {
  return Object.assign(
    {
      id: 's1',
      cart: [{ productId: 'sku-001', quantity: 2 }], // ₹6,998
      hasSummarizedOrder: false,
      order: null,
      createdAt: new Date(Date.now() - 60 * 60000).toISOString(),
      lastActivityAt: new Date(Date.now() - 60 * 60000).toISOString(),
    },
    overrides
  );
}

test('a stale cart with no order is recoverable, and priced from the catalog', () => {
  const found = recovery.listAbandoned([session()], 15);
  assert.equal(found.length, 1);
  assert.equal(found[0].recoverableValuePaise, 349900 * 2);
  assert.equal(found[0].recoverableValue, '₹6,998');
  assert.equal(found[0].stage, 'abandoned_with_cart');
});

test('completed orders, empty carts and still-active sessions are excluded', () => {
  const sessions = [
    session({ id: 'paid', order: { referenceId: 'r1' } }),
    session({ id: 'empty', cart: [] }),
    session({ id: 'active', lastActivityAt: new Date().toISOString() }),
  ];
  assert.deepEqual(recovery.listAbandoned(sessions, 15), []);
});

/**
 * Someone who saw the order summary and didn't confirm is one tap from paying.
 * They must outrank a bigger cart that never reached confirmation, or the
 * recovery effort goes to the wrong buyer first.
 */
test('confirmation-stage drop-offs outrank larger earlier-stage carts', () => {
  const ranked = recovery.listAbandoned(
    [
      session({ id: 'big-early', cart: [{ productId: 'sku-006', quantity: 2 }] }), // ₹17,998
      session({ id: 'small-late', hasSummarizedOrder: true }), // ₹6,998
    ],
    15
  );
  assert.equal(ranked[0].sessionId, 'small-late');
  assert.equal(ranked[0].priority, 'high');
  assert.equal(ranked[0].stage, 'abandoned_at_confirmation');
});

test('the summary totals recoverable revenue across carts', () => {
  const summary = recovery.summarize(
    recovery.listAbandoned([session({ id: 'a' }), session({ id: 'b', hasSummarizedOrder: true })], 15)
  );
  assert.equal(summary.carts, 2);
  assert.equal(summary.highIntent, 1);
  assert.equal(summary.recoverableValuePaise, 349900 * 4);
});

test('the nudge names the actual items and adapts to the drop-off stage', () => {
  const [early] = recovery.listAbandoned([session()], 15);
  const [late] = recovery.listAbandoned([session({ hasSummarizedOrder: true })], 15);

  const earlyNudge = recovery.draftNudge(early);
  const lateNudge = recovery.draftNudge(late);

  assert.match(earlyNudge, /Aurora Wireless Earbuds/);
  assert.match(earlyNudge, /₹6,998/);
  assert.match(lateNudge, /one step from checking out/);
  assert.notEqual(earlyNudge, lateNudge);
});

test('dropOffStage distinguishes every point in the funnel', () => {
  assert.equal(recovery.dropOffStage(session({ order: { id: 'x' } })), 'completed');
  assert.equal(recovery.dropOffStage(session({ hasSummarizedOrder: true })), 'abandoned_at_confirmation');
  assert.equal(recovery.dropOffStage(session()), 'abandoned_with_cart');
  assert.equal(recovery.dropOffStage(session({ cart: [] })), 'abandoned_before_cart');
});

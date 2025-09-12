'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.MAX_ORDER_VALUE_INR = '50000';
process.env.MAX_ITEM_QUANTITY = '10';

const { executeTool } = require('../src/agent/tools');
const sessionStore = require('../src/agent/sessionStore');
const auditLog = require('../src/agent/auditLog');

function freshSession(id) {
  sessionStore.reset(id);
  return sessionStore.getOrCreate(id);
}

test('add_to_cart rejects an unknown product', async () => {
  const session = freshSession('t-unknown-product');
  const result = await executeTool('add_to_cart', { productId: 'nope', quantity: 1 }, session);
  assert.ok(result.error);
  assert.equal(session.cart.length, 0);
});

test('add_to_cart rejects a quantity over the cap before ever touching stock', async () => {
  const session = freshSession('t-over-cap');
  const result = await executeTool('add_to_cart', { productId: 'sku-001', quantity: 999 }, session);
  assert.ok(result.error);
  assert.equal(session.cart.length, 0);
});

test('add_to_cart succeeds for a valid product and quantity', async () => {
  const session = freshSession('t-valid-add');
  const result = await executeTool('add_to_cart', { productId: 'sku-003', quantity: 2 }, session);
  assert.ok(!result.error);
  assert.equal(session.cart.length, 1);
  assert.equal(session.cart[0].quantity, 2);
});

test('create_checkout is rejected without a prior summarize_order in this session', async () => {
  const session = freshSession('t-no-summary');
  await executeTool('add_to_cart', { productId: 'sku-003', quantity: 1 }, session);
  const result = await executeTool(
    'create_checkout',
    { customerName: 'Test', customerContact: '+919876543210', confirmed: true, reasoning: 'user agreed' },
    session
  );
  assert.ok(result.error);
  assert.equal(result.code, 'SUMMARY_NOT_SHOWN');
  assert.equal(session.order, null);
});

test('create_checkout is rejected without confirmed=true, even after a summary', async () => {
  const session = freshSession('t-no-confirm');
  await executeTool('add_to_cart', { productId: 'sku-003', quantity: 1 }, session);
  await executeTool('summarize_order', {}, session);
  const result = await executeTool(
    'create_checkout',
    { customerName: 'Test', customerContact: '+919876543210', confirmed: false, reasoning: 'user agreed' },
    session
  );
  assert.ok(result.error);
  assert.equal(result.code, 'CONFIRMATION_REQUIRED');
});

test('modifying the cart after summarizing invalidates the confirmation gate', async () => {
  const session = freshSession('t-stale-summary');
  await executeTool('add_to_cart', { productId: 'sku-003', quantity: 1 }, session);
  await executeTool('summarize_order', {}, session);
  assert.equal(session.hasSummarizedOrder, true);
  await executeTool('add_to_cart', { productId: 'sku-004', quantity: 1 }, session);
  assert.equal(session.hasSummarizedOrder, false);
});

test('an unwhitelisted tool name is rejected and logged, not executed', async () => {
  const session = freshSession('t-bad-tool');
  const result = await executeTool('wire_transfer_all_funds', {}, session);
  assert.ok(result.error);
  assert.equal(result.code, 'TOOL_NOT_WHITELISTED');
});

test('every tool call — success and rejection — is written to the audit trail', async () => {
  const session = freshSession('t-audit');
  await executeTool('add_to_cart', { productId: 'sku-003', quantity: 1 }, session);
  await executeTool('add_to_cart', { productId: 'sku-003', quantity: 999 }, session); // rejected
  const entries = auditLog.readForSession('t-audit');
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((e) => e.outcome === 'success'));
  assert.ok(entries.some((e) => e.outcome === 'rejected'));
});

test.after(() => {
  // Clean up the on-disk audit log written by this suite so repeated
  // test runs stay deterministic.
  const logPath = auditLog.LOG_PATH;
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
});

// The chat API hands this exact shape to the UI. session.cart is minimal
// ({productId, quantity}); names and prices are resolved from the catalog at
// read time. If cartDetail ever stops enriching, the sidebar silently renders
// "sku-001 — ₹0" mid-demo, which is exactly the kind of bug that only shows up
// on camera.
test('cartDetail enriches each line with a name and a real line total', () => {
  const { cartDetail, cartTotalPaise } = require('../src/agent/tools');
  const cart = [{ productId: 'sku-001', quantity: 2 }];
  const detail = cartDetail(cart);

  assert.equal(detail.length, 1);
  assert.equal(detail[0].name, 'Aurora Wireless Earbuds');
  assert.notEqual(detail[0].name, 'UNKNOWN');
  assert.equal(detail[0].quantity, 2);
  assert.equal(detail[0].lineTotalPaise, 349900 * 2);
  assert.equal(cartTotalPaise(cart), 349900 * 2);
});

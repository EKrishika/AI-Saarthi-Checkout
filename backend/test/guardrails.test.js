'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MAX_ORDER_VALUE_INR = '50000';
process.env.MAX_ITEM_QUANTITY = '10';

const guardrails = require('../src/agent/guardrails');

test('rejects a tool that is not on the whitelist', () => {
  assert.throws(() => guardrails.assertToolAllowed('delete_all_orders'), guardrails.GuardrailViolation);
});

test('allows every documented tool name', () => {
  for (const name of guardrails.ALLOWED_TOOLS) {
    assert.doesNotThrow(() => guardrails.assertToolAllowed(name));
  }
});

test('rejects zero, negative, and non-integer quantities', () => {
  assert.throws(() => guardrails.assertQuantityBounded(0));
  assert.throws(() => guardrails.assertQuantityBounded(-1));
  assert.throws(() => guardrails.assertQuantityBounded(2.5));
});

test('rejects quantity above the configured cap', () => {
  assert.throws(() => guardrails.assertQuantityBounded(11), guardrails.GuardrailViolation);
});

test('allows quantity at or under the cap', () => {
  assert.doesNotThrow(() => guardrails.assertQuantityBounded(10));
  assert.doesNotThrow(() => guardrails.assertQuantityBounded(1));
});

test('rejects an order total above the configured cap', () => {
  assert.throws(() => guardrails.assertOrderValueBounded(50001 * 100), guardrails.GuardrailViolation);
});

test('allows an order total at or under the cap', () => {
  assert.doesNotThrow(() => guardrails.assertOrderValueBounded(50000 * 100));
});

test('rejects checkout on an empty cart', () => {
  assert.throws(() => guardrails.assertCartNotEmpty([]), guardrails.GuardrailViolation);
  assert.throws(() => guardrails.assertCartNotEmpty(null), guardrails.GuardrailViolation);
});

test('allows checkout on a non-empty cart', () => {
  assert.doesNotThrow(() => guardrails.assertCartNotEmpty([{ productId: 'sku-001', quantity: 1 }]));
});

test('checkout requires an explicit confirmed=true, not truthy values', () => {
  assert.throws(() => guardrails.assertCheckoutConfirmed(undefined), guardrails.GuardrailViolation);
  assert.throws(() => guardrails.assertCheckoutConfirmed(false), guardrails.GuardrailViolation);
  assert.throws(() => guardrails.assertCheckoutConfirmed('true'), guardrails.GuardrailViolation);
  assert.throws(() => guardrails.assertCheckoutConfirmed(1), guardrails.GuardrailViolation);
  assert.doesNotThrow(() => guardrails.assertCheckoutConfirmed(true));
});

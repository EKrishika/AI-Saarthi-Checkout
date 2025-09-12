'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/catalog');

test('listAll returns every product with required fields', () => {
  const products = catalog.listAll();
  assert.ok(products.length > 0);
  for (const p of products) {
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.price_paise, 'number');
    assert.ok(p.price_paise > 0);
    assert.equal(typeof p.stock, 'number');
  }
});

test('getById finds an existing product and returns null for a missing one', () => {
  const all = catalog.listAll();
  const found = catalog.getById(all[0].id);
  assert.equal(found.id, all[0].id);
  assert.equal(catalog.getById('does-not-exist'), null);
});

test('search matches on name, description, category, and tags', () => {
  const byName = catalog.search('keyboard');
  assert.ok(byName.some((p) => p.name.toLowerCase().includes('keyboard')));

  const byTag = catalog.search('desk-setup');
  assert.ok(byTag.length > 0);

  const empty = catalog.search('zzz_nonexistent_zzz');
  assert.equal(empty.length, 0);
});

test('search with no query returns the full catalog', () => {
  assert.equal(catalog.search('').length, catalog.listAll().length);
});

test('formatPrice renders paise as a rupee string', () => {
  assert.equal(catalog.formatPrice(349900), '₹3,499');
});

/**
 * These cover the failure that broke a live run: the search did a whole-string
 * substring match, so a model that passed the user's full sentence as the
 * query got zero results and told the buyer the catalog was empty. Different
 * models phrase the call very differently, and the catalog must not care.
 */
test('a full natural-language sentence finds the right product', () => {
  const results = catalog.search('I need wireless earbuds under 5000');
  assert.ok(results.length > 0, 'a whole sentence must not return nothing');
  assert.equal(results[0].id, 'sku-001');
});

test('a bare keyword still works', () => {
  assert.equal(catalog.search('earbuds')[0].id, 'sku-001');
  // sku-007's description mentions a "keyboard tray", but a name match must
  // outrank a description match or the wrong product leads the results.
  assert.equal(catalog.search('keyboard')[0].id, 'sku-002');
});

test('"under X" filters by price instead of being searched as text', () => {
  const cheap = catalog.search('desk under 2000');
  assert.ok(cheap.length > 0);
  for (const p of cheap) assert.ok(p.price_paise <= 200000, `${p.name} must be under ₹2,000`);

  // The standing desk converter is a "desk" item but costs ₹6,499 — the price
  // filter has to exclude it even though the word matches.
  assert.ok(!cheap.some((p) => p.id === 'sku-007'));
});

test('a price-only query returns everything in range', () => {
  const results = catalog.search('anything under 2000');
  assert.ok(results.length > 0);
  for (const p of results) assert.ok(p.price_paise <= 200000);
});

test('plurals match singular product names', () => {
  assert.ok(catalog.search('desk lamps').some((p) => p.id === 'sku-003'));
});

test('results are ranked by how many query terms match', () => {
  const results = catalog.search('portable ssd storage');
  assert.equal(results[0].id, 'sku-006');
});

test('a genuinely absent product returns nothing rather than everything', () => {
  assert.deepEqual(catalog.search('helicopter'), []);
});

test('parseQuery separates terms from price constraints', () => {
  const parsed = catalog.parseQuery('wireless earbuds under 5000');
  assert.deepEqual(parsed.tokens, ['wireless', 'earbuds']);
  assert.equal(parsed.maxPaise, 500000);
  assert.equal(parsed.minPaise, null);
});

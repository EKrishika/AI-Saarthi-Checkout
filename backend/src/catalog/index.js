'use strict';

const catalog = require('./products.json');

/**
 * Read-only accessors over the product catalog. Deliberately has no
 * write/mutate methods — the agent can never alter price, stock, or
 * add products through a "search" tool. That's part of the bounded
 * operations guardrail: read paths and write paths are different
 * modules with different risk profiles.
 */

function listAll() {
  return catalog.products;
}

function getById(id) {
  return catalog.products.find((p) => p.id === id) || null;
}

/**
 * Words that carry no product meaning. Different models phrase a search very
 * differently — one sends "earbuds", another sends the user's whole sentence —
 * and the catalog must not care which.
 */
const STOPWORDS = new Set([
  'i', 'me', 'my', 'a', 'an', 'the', 'for', 'of', 'to', 'and', 'or', 'is', 'are', 'it',
  'that', 'those', 'this', 'these', 'with', 'in', 'on', 'at', 'any', 'some', 'please',
  'need', 'want', 'looking', 'look', 'buy', 'get', 'show', 'find', 'search', 'something',
  'under', 'below', 'less', 'than', 'over', 'above', 'upto', 'within', 'max', 'min',
  'around', 'about', 'rs', 'inr', 'rupees', 'rupee', 'price', 'priced', 'cost', 'costing',
  'cheap', 'budget', 'good', 'best', 'new',
  // Generic filler, so "anything under 2000" is treated as a pure price query
  // rather than a hunt for products literally named "anything".
  'anything', 'everything', 'thing', 'things', 'item', 'items', 'product',
  'products', 'stuff', 'option', 'options', 'recommend', 'recommendation',
]);

function parsePrice(text, words) {
  const pattern = new RegExp(
    '(?:' + words + ')\\s*(?:rs\\.?|inr|₹)?\\s*([\\d,]+)',
    'i'
  );
  const match = text.match(pattern);
  if (!match) return null;
  const rupees = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(rupees) ? rupees * 100 : null;
}

/**
 * Splits a free-text query into meaningful tokens plus any price constraint.
 * "wireless earbuds under 5000" -> tokens [wireless, earbuds], maxPaise 500000.
 */
function parseQuery(query) {
  const lower = query.toLowerCase();
  return {
    maxPaise: parsePrice(lower, 'under|below|less than|upto|up to|within|max|cheaper than'),
    minPaise: parsePrice(lower, 'over|above|more than|at least|min|starting at'),
    tokens: lower
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  };
}

function normalize(text) {
  return String(text).toLowerCase().replace(/-/g, ' '); // "under-5000" -> two words
}

/**
 * Where a term matches decides how much it counts. A search for "keyboard"
 * must return the keyboard, not the standing desk whose description happens to
 * mention a keyboard tray — so a name hit outweighs a description hit.
 */
const FIELD_WEIGHTS = [
  { get: (p) => p.name, weight: 3 },
  { get: (p) => [p.category, ...(p.tags || [])].join(' '), weight: 2 },
  { get: (p) => p.description, weight: 1 },
];

/** Naive plural handling: "lamps" should find "Lamp". */
function haystackHas(haystack, token) {
  if (haystack.includes(token)) return true;
  if (token.length > 3 && token.endsWith('s') && haystack.includes(token.slice(0, -1))) return true;
  return false;
}

/**
 * Free-text search, scored by how many query terms a product matches.
 *
 * The obvious implementation — `haystack.includes(wholeQuery)` — looks fine
 * until a model passes the user's entire sentence as the query, at which point
 * every search silently returns nothing and the agent tells the buyer the
 * catalog is empty. Matching per-token, and handling "under ₹X" as a price
 * filter rather than as search text, keeps results stable no matter how
 * verbosely the model phrases the call.
 */
function search(query) {
  if (!query || typeof query !== 'string') return listAll();

  const { tokens, maxPaise, minPaise } = parseQuery(query);

  let candidates = catalog.products;
  if (maxPaise != null) candidates = candidates.filter((p) => p.price_paise <= maxPaise);
  if (minPaise != null) candidates = candidates.filter((p) => p.price_paise >= minPaise);

  // A pure price query ("anything under 2000") is a valid search on its own.
  if (!tokens.length) return candidates;

  return candidates
    .map((product) => {
      let score = 0;
      for (const field of FIELD_WEIGHTS) {
        const haystack = normalize(field.get(product));
        for (const token of tokens) if (haystackHas(haystack, token)) score += field.weight;
      }
      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.product.price_paise - b.product.price_paise)
    .map((entry) => entry.product);
}

function formatPrice(pricePaise) {
  return `₹${(pricePaise / 100).toLocaleString('en-IN')}`;
}

module.exports = { listAll, getById, search, formatPrice, parseQuery, currency: catalog.currency };

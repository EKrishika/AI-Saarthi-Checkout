'use strict';

const crypto = require('crypto');

/**
 * Spend mandates — the delegated authority a human grants an agent.
 *
 * This is the primitive the whole project turns on. In an assisted checkout a
 * human types "yes" before every payment, so a spend cap is close to
 * decoration. The interesting case is the one that's actually coming: the
 * buyer isn't at the keyboard, their agent is transacting on their behalf, and
 * the *only* thing standing between an LLM and someone's bank account is the
 * authority they granted before walking away.
 *
 * A mandate is that grant, made explicit and verifiable:
 *
 *   - a total budget, and a per-order ceiling inside it
 *   - which product categories it covers
 *   - how many transactions it authorises
 *   - when it expires
 *
 * It's HMAC-signed at issue time, so the agent cannot widen its own authority:
 * changing any field invalidates the signature, and the signature is checked
 * again on every single spend, not just once at the start.
 *
 * Deliberately *not* claimed: this is a server-side HMAC, so it proves the
 * mandate wasn't altered after this server issued it. It is not a
 * user-held cryptographic credential — see docs/ARCHITECTURE.md for what a
 * production version (buyer-held keys, an RBI-style delegated payment mandate)
 * would need instead.
 */

const GRANT_KEYS = [
  'id',
  'subject',
  'issuedAt',
  'expiresAt',
  'maxTotalPaise',
  'maxPerOrderPaise',
  'allowedCategories',
  'maxTransactions',
];

function signingSecret() {
  const secret = process.env.MANDATE_SIGNING_SECRET;
  if (secret) return secret;
  // Dev fallback so the demo runs out of the box. Regenerated per process, so
  // mandates don't survive a restart — which is the safe direction to fail.
  if (!signingSecret._ephemeral) {
    signingSecret._ephemeral = crypto.randomBytes(32).toString('hex');
  }
  return signingSecret._ephemeral;
}

/** Stable serialization over exactly the granted fields — nothing else signs. */
function canonicalGrant(mandate) {
  const grant = {};
  for (const key of GRANT_KEYS) grant[key] = mandate[key];
  return JSON.stringify(grant, GRANT_KEYS.slice().sort());
}

function sign(mandate) {
  return crypto.createHmac('sha256', signingSecret()).update(canonicalGrant(mandate)).digest('hex');
}

/**
 * Issues a signed mandate. `ttlMinutes`, the caps and the category list are
 * the human's decision — this module never invents authority, it only records
 * and signs what was granted.
 */
function issue(options) {
  const opts = options || {};
  const now = Date.now();

  // An explicitly supplied lifetime must be a positive number. Quietly
  // substituting a default for a nonsensical one (0, -1, "soon") would widen
  // authority beyond what the caller asked for, which is the wrong direction
  // for this module to fail in.
  let ttlMinutes = 60;
  if (opts.ttlMinutes !== undefined && opts.ttlMinutes !== null && opts.ttlMinutes !== '') {
    ttlMinutes = Number(opts.ttlMinutes);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error(`Invalid mandate lifetime: ${opts.ttlMinutes}. ttlMinutes must be a positive number.`);
    }
  }

  const mandate = {
    id: 'mnd_' + crypto.randomBytes(6).toString('hex'),
    subject: opts.subject || 'Buyer',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMinutes * 60_000).toISOString(),
    maxTotalPaise: Math.max(0, Math.floor(Number(opts.maxTotalPaise) || 0)),
    maxPerOrderPaise: Math.max(0, Math.floor(Number(opts.maxPerOrderPaise) || 0)),
    allowedCategories: Array.isArray(opts.allowedCategories) ? opts.allowedCategories.slice().sort() : [],
    // Defaults to a single transaction when unspecified — the conservative
    // reading of "the human didn't say". An explicit 0 authorises nothing.
    maxTransactions:
      opts.maxTransactions === undefined || opts.maxTransactions === null || opts.maxTransactions === ''
        ? 1
        : Math.max(0, Math.floor(Number(opts.maxTransactions) || 0)),
  };
  mandate.signature = sign(mandate);
  return mandate;
}

/** Timing-safe signature check. Fails closed on anything malformed. */
function verifySignature(mandate) {
  if (!mandate || typeof mandate.signature !== 'string') return false;
  let expected;
  try {
    expected = sign(mandate);
  } catch (err) {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(mandate.signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isExpired(mandate, now) {
  const at = now == null ? Date.now() : now;
  return !mandate || !mandate.expiresAt || Date.parse(mandate.expiresAt) <= at;
}

/** What's left on a mandate given what's already been spent against it. */
function remaining(mandate, usage) {
  const used = usage || { spentPaise: 0, transactions: 0 };
  return {
    budgetPaise: Math.max(0, (mandate.maxTotalPaise || 0) - (used.spentPaise || 0)),
    transactions: Math.max(0, (mandate.maxTransactions || 0) - (used.transactions || 0)),
    expiresAt: mandate.expiresAt,
    expired: isExpired(mandate),
  };
}

module.exports = { issue, sign, verifySignature, isExpired, remaining, canonicalGrant, GRANT_KEYS };

'use strict';

/**
 * In-memory session store: cart contents + conversation history per
 * session id. Fine for a buildathon demo (single process, no
 * horizontal scaling); a production version would swap this for
 * Redis/Postgres without touching agent.js's interface.
 */

const sessions = new Map();

function getOrCreate(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      cart: [], // [{ productId, quantity }]
      history: [], // Anthropic-format message list
      hasSummarizedOrder: false, // gate for the confirmation guardrail
      order: null, // set once create_checkout succeeds

      // Where checkout authority comes from for this session.
      //   'attended'   — a human confirms each payment in the conversation
      //   'unattended' — nobody is watching; the signed mandate is the authority
      mode: 'attended',
      mandate: null, // signed grant, set when an unattended run is started
      mandateUsage: { spentPaise: 0, transactions: 0 }, // re-checked on every spend

      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(), // drives abandoned-cart detection
    });
  }
  return sessions.get(sessionId);
}

function touch(session) {
  session.lastActivityAt = new Date().toISOString();
  return session;
}

/** Every live session — the input to abandoned-cart recovery. */
function listAll() {
  return [...sessions.values()];
}

function reset(sessionId) {
  sessions.delete(sessionId);
}

module.exports = { getOrCreate, touch, listAll, reset };

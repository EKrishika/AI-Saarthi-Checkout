'use strict';

/**
 * Reasoning-effort setting for providers that support it (currently Anthropic).
 * Which model and provider actually serve a turn is decided in llm.js.
 *
 * "low" on purpose: routing a short shopping message to one of eight narrow
 * tools is not a reasoning-heavy task, and a checkout chat is judged on how
 * fast it answers. Raise it if the flow gains genuinely hard multi-step work.
 */
const DEFAULT_EFFORT = 'low';

function getEffort() {
  return process.env.ANTHROPIC_EFFORT || DEFAULT_EFFORT;
}

module.exports = { DEFAULT_EFFORT, getEffort };

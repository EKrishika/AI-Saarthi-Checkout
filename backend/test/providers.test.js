'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toolsToOpenAI, messagesToOpenAI, responseFromOpenAI } = require('../src/agent/providers/translate');
const { TOOL_SCHEMAS } = require('../src/agent/tools');

test('every tool schema survives translation to OpenAI function format', () => {
  const converted = toolsToOpenAI(TOOL_SCHEMAS);
  assert.equal(converted.length, TOOL_SCHEMAS.length);

  for (let i = 0; i < converted.length; i++) {
    const fn = converted[i].function;
    assert.equal(converted[i].type, 'function');
    assert.equal(fn.name, TOOL_SCHEMAS[i].name);
    assert.ok(fn.description, `${fn.name} must keep its description`);
    assert.equal(fn.parameters.type, 'object');
    // Providers reject a function schema with no `required` array, even when
    // nothing is actually required (view_cart, summarize_order).
    assert.ok(Array.isArray(fn.parameters.required), `${fn.name} must have a required array`);
  }
});

test('create_checkout keeps the fields the guardrails depend on', () => {
  const checkout = toolsToOpenAI(TOOL_SCHEMAS).find((t) => t.function.name === 'create_checkout');
  const props = checkout.function.parameters.properties;
  for (const field of ['customerName', 'customerContact', 'confirmed', 'reasoning']) {
    assert.ok(props[field], `${field} must survive translation`);
  }
  assert.ok(checkout.function.parameters.required.includes('confirmed'));
});

test('a plain user turn translates unchanged, with the system prompt first', () => {
  const out = messagesToOpenAI([{ role: 'user', content: 'hello' }], 'You are Signet.');
  assert.deepEqual(out, [
    { role: 'system', content: 'You are Signet.' },
    { role: 'user', content: 'hello' },
  ]);
});

test('an assistant turn with tool calls becomes content + tool_calls', () => {
  const out = messagesToOpenAI([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking that up.' },
        { type: 'tool_use', id: 'tu_1', name: 'search_catalog', input: { query: 'earbuds' } },
      ],
    },
  ]);

  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'Looking that up.');
  assert.equal(out[0].tool_calls.length, 1);
  assert.equal(out[0].tool_calls[0].id, 'tu_1');
  assert.equal(out[0].tool_calls[0].function.name, 'search_catalog');
  // Arguments must be a JSON *string*, not an object.
  assert.equal(typeof out[0].tool_calls[0].function.arguments, 'string');
  assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { query: 'earbuds' });
});

/**
 * The easiest thing to get wrong. Anthropic returns several tool_results
 * inside one user message; OpenAI expects one `role: "tool"` message each.
 * Merging them into a single message makes models quietly stop calling tools
 * in parallel, which is very hard to notice after the fact.
 */
test('several tool results become one tool message each, in order', () => {
  const out = messagesToOpenAI([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":1}' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: '{"ok":2}' },
      ],
    },
  ]);

  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'tool', tool_call_id: 'tu_1', content: '{"ok":1}' });
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'tu_2', content: '{"ok":2}' });
});

test('a full round trip preserves the conversation shape', () => {
  const history = [
    { role: 'user', content: 'earbuds please' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'search_catalog', input: { query: 'earbuds' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"products":[]}' }] },
  ];
  assert.deepEqual(
    messagesToOpenAI(history, 'sys').map((m) => m.role),
    ['system', 'user', 'assistant', 'tool']
  );
});

test('an assistant message with no text sends null content, not an empty string', () => {
  const out = messagesToOpenAI([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'view_cart', input: {} }] },
  ]);
  assert.equal(out[0].content, null);
});

test('a tool-calling response becomes tool_use blocks with parsed input', () => {
  const result = responseFromOpenAI({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            { id: 'call_1', function: { name: 'add_to_cart', arguments: '{"productId":"sku-001","quantity":2}' } },
          ],
        },
      },
    ],
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'tool_use');
  assert.equal(result.content[0].name, 'add_to_cart');
  // Parsed, not string-matched — providers vary in how they escape JSON.
  assert.deepEqual(result.content[0].input, { productId: 'sku-001', quantity: 2 });
});

test('a plain text response ends the turn', () => {
  const result = responseFromOpenAI({
    choices: [{ finish_reason: 'stop', message: { content: 'Added to your cart.' } }],
  });
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Added to your cart.' }]);
});

/**
 * Some OpenAI-compatible servers report finish_reason "stop" while still
 * returning tool calls. Trusting the label there would silently drop the call
 * and strand the agent mid-flow, so presence of tool calls wins.
 */
test('tool calls are honoured even when finish_reason says stop', () => {
  const result = responseFromOpenAI({
    choices: [
      {
        finish_reason: 'stop',
        message: { content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'view_cart', arguments: '{}' } }] },
      },
    ],
  });
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal(result.content.filter((b) => b.type === 'tool_use').length, 1);
});

test('malformed tool arguments degrade to an empty input, not a crash', () => {
  const result = responseFromOpenAI({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ id: 'c1', function: { name: 'add_to_cart', arguments: '{not json' } }] },
      },
    ],
  });
  // The guardrails then reject it cleanly, which beats throwing mid-turn.
  assert.deepEqual(result.content[0].input, {});
});

test('an empty response does not throw', () => {
  assert.deepEqual(responseFromOpenAI({}), { content: [], stop_reason: 'end_turn' });
  assert.deepEqual(responseFromOpenAI({ choices: [] }), { content: [], stop_reason: 'end_turn' });
});

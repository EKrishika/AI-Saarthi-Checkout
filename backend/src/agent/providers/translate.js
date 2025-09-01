'use strict';

/**
 * Translation between the project's internal message format and the
 * OpenAI-style `/chat/completions` shape.
 *
 * The codebase speaks Anthropic's format natively (content blocks, `tool_use`,
 * `tool_result`), and that stays the canonical internal representation — the
 * agent loop, session history and audit log are all written against it.
 * Providers that speak the OpenAI dialect are translated at the boundary only,
 * so adding one never touches agent.js, tools.js or guardrails.js.
 *
 * That covers a lot of ground for free: Groq, Google Gemini's compatibility
 * endpoint, OpenRouter, Cerebras and a local Ollama all speak this dialect.
 */

/** Anthropic tool schema -> OpenAI function schema. */
function toolsToOpenAI(tools) {
  return tools.map((tool) => {
    const parameters = Object.assign({ type: 'object', properties: {} }, tool.input_schema);
    // Several OpenAI-compatible servers reject a function schema with no
    // `required` array, even when nothing is genuinely required.
    if (!Array.isArray(parameters.required)) parameters.required = [];
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters },
    };
  });
}

/**
 * Internal (Anthropic-shaped) history -> OpenAI messages.
 *
 * The interesting case is a user turn whose content is an array of
 * `tool_result` blocks: OpenAI has no such thing, and expects one message with
 * `role: "tool"` per result instead. Emitting a single merged message there is
 * a common bug that makes models silently stop calling tools in parallel.
 */
function messagesToOpenAI(history, systemPrompt) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });

  for (const message of history) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];

    if (message.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));

      const assistantMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
      out.push(assistantMessage);
      continue;
    }

    // A user turn carrying tool results — one `tool` message per result.
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length) {
      for (const result of results) {
        out.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        });
      }
      continue;
    }

    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) out.push({ role: message.role, content: text });
  }

  return out;
}

/**
 * OpenAI response -> internal (Anthropic-shaped) response.
 *
 * Tool arguments arrive as a JSON *string* and are parsed here rather than
 * string-matched. A model that emits malformed JSON becomes an empty input
 * object, which the guardrails then reject cleanly — far better than throwing
 * mid-turn and losing the conversation.
 */
function responseFromOpenAI(payload) {
  const choice = (payload && payload.choices && payload.choices[0]) || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) content.push({ type: 'text', text: message.content });

  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse((call.function && call.function.arguments) || '{}');
    } catch (err) {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: call.id || 'call_' + Math.random().toString(36).slice(2, 10),
      name: call.function && call.function.name,
      input,
    });
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use');
  return {
    content,
    // Some providers report finish_reason "stop" even while returning tool
    // calls, so trust the presence of the calls over the label.
    stop_reason: hasToolUse ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
  };
}

module.exports = { toolsToOpenAI, messagesToOpenAI, responseFromOpenAI };

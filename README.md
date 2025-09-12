# Signet — Delegated-Authority Commerce

Built for the **Razorpay AI Buildathon**, Track 1: *AI Growth & Agentic Commerce*.

> Soon your customers won't visit your checkout page. Their agent will.
> Signet is what a merchant needs in order to safely take money from a machine.

The interesting problem in agentic commerce isn't a chatbot that can buy things.
It's this: **when the buyer isn't at the keyboard, what bounds what their agent
may spend — and how does anyone prove afterwards what it actually did?**

Signet answers both, on Razorpay's TEST-mode Payment Links API:

1. A human issues a **signed spend mandate** — a budget, a per-order ceiling,
   which categories, how many transactions, an expiry.
2. The agent then shops and pays **unattended**. Its only authority is that
   mandate, re-verified in code on every single spend. It cannot widen its own
   limits: any edit to the grant invalidates the signature.
3. Every step lands in a **hash-chained audit log** that is tamper-evident, not
   merely append-only — alter one historical record and `/api/audit/verify`
   names it.

An assisted mode (a human confirms each payment in chat) is still there — it's
the on-ramp, and it's what the recovery flow feeds on. But the mandate is the
point.

## Why this framing

In an assisted checkout a human types "yes" before every payment, so a spend cap
is close to decoration — the human *is* the guardrail. This track asks for
explainable transactions, bounded operations, audit trails and graceful failure,
and those four only become load-bearing when nobody is watching. So Signet is
built around the unattended case, and the caps are the only thing between an LLM
and someone's bank account.

| Requirement | How Signet meets it |
|---|---|
| **Explainable transactions** | `/api/chat` returns the tool calls it made, rendered inline as chips, product cards and rejection blocks. `create_checkout` must state, in the agent's own words, why checking out is correct right now — persisted with the record. |
| **Bounded operations** | One `guardrails.js` enforces a tool whitelist, a quantity cap, a merchant order ceiling, and — for unattended runs — every mandate limit, re-checked on each spend. Effective authority is the *intersection* of merchant policy and buyer grant: a mandate can only narrow, never widen. |
| **Audit trails** | Hash-chained append-only log covering successes, guardrail rejections and errors. `GET /api/audit/verify` recomputes the chain and reports the first record that doesn't hold. |
| **Graceful failure handling** | Razorpay calls, model calls, misconfiguration and unexpected bugs all become plain-language replies, never a crash or a stack trace. Misconfiguration is detected up front and named explicitly. |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design rationale.

## Quickstart

```bash
cd backend
npm install
cp .env.example .env   # add a free LLM key + your Razorpay TEST keys
npm test               # 74 unit tests, no network/API keys required
npm start              # serves the app at http://localhost:4000
```

Full setup — a free LLM key, Razorpay test keys, optional webhook tunnel — is in
[docs/SETUP.md](docs/SETUP.md). The default provider (Groq) has a free tier, so
the only paid option is Anthropic, and it's opt-in.

## The three things to try

Open `http://localhost:4000`.

**1. Assisted checkout** — the on-ramp.
Click the prompt chips: search → add to cart → try `Add 500 desk lamps` to watch
a guardrail reject it → checkout → confirm. A human authorises the payment.

**2. Unattended run** — the actual thesis.
Set a budget of ₹8,000, a per-order cap of ₹5,000, scope it to `audio`, and give
it a goal. The agent searches, adds, summarises and pays **with no human turn at
all**. Then re-run it scoped to `storage`, or with a ₹2,000 cap, and watch the
mandate refuse to authorise the spend — that rejection is the whole point.

**3. Verify the audit chain.**
Run `npm run audit` for a readable table of every record plus a chain check —
or hit **Verify chain** in the UI. Both go green. Now open
`backend/data/audit.jsonl` in any editor, change one field of any line, save,
and check again. It goes red and names the record you touched.

**Bonus — Recovery.** Build a cart in Assisted mode without checking out, then
open the Recovery tab and scan with `0` minutes. The agent ranks abandoned carts
by how recoverable they are, drafts a nudge specific to where the buyer dropped
off, and mints a live payment link so they never re-enter the funnel.

## What "bounded" means here, concretely

The agent can never:

- call a tool outside a fixed whitelist of 8 read/cart/checkout tools
- add more than `MAX_ITEM_QUANTITY` (default 10) units of one product
- create a payment link above `MAX_ORDER_VALUE_INR` (default ₹50,000) — the
  merchant's ceiling, which applies in both modes
- create a payment link *unattended* without a signed mandate that covers the
  amount, the per-order cap, the category, the transaction count and the expiry
- create a payment link *attended* without a prior `summarize_order` shown
  in-session and an explicit `confirmed: true`
- widen its own mandate — every granted field is covered by the signature

All of it is enforced in `backend/src/agent/guardrails.js` and
`backend/src/agent/mandate.js`, and tested — not just described in a prompt.

## Project structure

```
backend/
  src/
    agent/         agent loop, tool schemas + executors, guardrails, mandates,
                   unattended runs, hash-chained audit log,
                   providers/ (multi-provider LLM adapter)
    catalog/       AI-readable product catalog (JSON) + read-only accessors
    growth/        abandoned-cart detection, ranking and recovery
    razorpay/      Razorpay SDK wrapper (payment links) + webhook verification
    routes/        /api/chat, /api/audit, /api/unattended, /api/mandate,
                   /api/growth, /api/webhooks/razorpay
    server.js
  scripts/
    show-audit.js  readable audit-trail viewer + chain check (`npm run audit`)
  test/            74 unit tests — guardrails, mandates, audit tamper-evidence,
                   provider translation, catalog, webhook signatures, tools,
                   growth, HTTP contracts
frontend/
  index.html       single-file UI: assisted chat, unattended runs, recovery
docs/
  ARCHITECTURE.md  design rationale, mapped to track requirements
  SETUP.md         how to get API keys and run this locally
  DEMO_SCRIPT.md   5-minute pitch video script + shot list
```

## Tech stack

- **Backend:** Node.js + Express
- **Agent:** provider-agnostic tool-use loop — [`backend/src/agent/agent.js`](backend/src/agent/agent.js).
  Runs on **Groq**, **Google Gemini**, OpenRouter, Cerebras, a local **Ollama**,
  or Anthropic Claude; switch with one env var. Everything above
  [`llm.js`](backend/src/agent/llm.js) is identical regardless of provider —
  the OpenAI dialect is translated at the boundary only.
  Default: Groq `openai/gpt-oss-120b` — free tier, ~1s per turn, so the demo has
  no dead air.
- **Payments:** Razorpay Node SDK, TEST mode, Payment Links API
- **Frontend:** vanilla HTML/CSS/JS, no build step
- **Tests:** Node's built-in test runner (`node --test`), zero external deps

## Scope, and what this is not

One catalog, one payment primitive (Payment Links), in-memory sessions. The
mandate is a **server-side HMAC** — it proves the grant wasn't altered after this
server issued it. It is deliberately *not* claimed to be a buyer-held
cryptographic credential; see
[ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations--next-steps) for what a
production version (buyer-held keys, RBI-style delegated payment mandates,
AP2/ACP interop) would need instead.

## License

MIT — see [LICENSE](LICENSE).

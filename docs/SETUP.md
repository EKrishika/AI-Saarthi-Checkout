# Setup

## Prerequisites

- Node.js 18+ (built and tested on Node 22)
- A free [Razorpay](https://razorpay.com) account (Test Mode is enough — no
  business verification needed to get test keys)
- An API key from any supported LLM provider — **several have free tiers**,
  see step 3 below

## 1. Get Razorpay TEST keys

1. Sign up / log in at the [Razorpay Dashboard](https://dashboard.razorpay.com).
2. Make sure you're in **Test Mode** (toggle, top of the dashboard).
3. Go to **Settings → API Keys → Generate Test Key**.
4. Copy the `Key Id` and `Key Secret`.

These are safe to use for a demo — they only work against Razorpay's test
environment, and test-mode payments use dummy card numbers, not real money.

## 2. (Optional but recommended) Set up the webhook

The agent creates payment links and can poll their status directly, but the
"proper" agentic-commerce path is the signed webhook callback:

1. Dashboard → **Settings → Webhooks → Add New Webhook**.
2. If running locally, expose your server with a tunnel, e.g.
   `npx localtunnel --port 4000` or `ngrok http 4000`, and use the resulting
   HTTPS URL + `/api/webhooks/razorpay` as the webhook URL.
3. Select the `payment_link.paid` event (and optionally `payment_link.expired`).
4. Copy the **Webhook Secret** shown after creation.

## 3. Get an LLM API key (free options)

The agent needs a model that supports **tool calling**. Several providers offer
that free. Pick one, set `LLM_PROVIDER` to match, and paste its key.

| `LLM_PROVIDER` | Get a key | Cost | Notes |
|---|---|---|---|
| `groq` **(default)** | [console.groq.com/keys](https://console.groq.com/keys) | Free tier | Fastest — best for a demo video, no dead air |
| `gemini` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier | No card needed; very reliable tool calling |
| `openrouter` | [openrouter.ai/keys](https://openrouter.ai/keys) | Free models available | Widest model choice |
| `cerebras` | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Free tier | Very fast |
| `ollama` | [ollama.com](https://ollama.com) | Free, local | No key at all; needs a capable machine |
| `anthropic` | [console.anthropic.com](https://console.anthropic.com) | Paid | Highest quality tool use |

Only the key for the provider you selected is read. To switch providers, change
`LLM_PROVIDER` and restart — nothing else in the codebase changes, because the
translation lives in `backend/src/agent/providers/`.

Override the model with `LLM_MODEL` if a provider retires the default — which
happens more often than you'd think. To see what your key can actually reach:

```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

Current Groq default: `openai/gpt-oss-120b`. A faster, slightly weaker option is
`openai/gpt-oss-20b`.

## 4. Configure and run

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env`:

```ini
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...        # optional, only if you set up the webhook
MANDATE_SIGNING_SECRET=...         # signs spend mandates; any long random string

LLM_PROVIDER=groq                  # groq | gemini | openrouter | cerebras | ollama | anthropic
GROQ_API_KEY=gsk_...               # only the selected provider's key is read
LLM_MODEL=                         # optional — blank uses the provider default
MAX_ORDER_VALUE_INR=50000
MAX_ITEM_QUANTITY=10
PORT=4000
```

Then:

```bash
npm test     # 74 unit tests — pass with no keys configured at all
npm start    # http://localhost:4000
```

## Checking your setup

With the server running, open `http://localhost:4000`. The header shows the
model in use and the active guardrail caps, read live from `/api/health`. If
either API key is missing you get an explicit amber banner naming the missing
variable rather than a confusing failure part-way through a conversation.

You can check the same thing from the terminal:

```bash
curl -s http://localhost:4000/api/health
```

## Trying the unattended flow

The assisted chat works as soon as the keys are in. For the unattended run —
where a signed mandate replaces human confirmation — open the **Unattended**
tab, set a budget and a category scope, and give it a goal.

Two things worth doing in that order:

1. Scope the mandate to `audio` with a ₹5,000 per-order cap and ask it to buy
   earbuds. It completes a real test-mode payment with no human turn.
2. Re-run scoped to `storage`, or drop the cap to ₹2,000. The mandate refuses to
   authorise the spend, and the rejection code says exactly which limit fired.

To check the audit trail is tamper-evident, hit **Verify chain** in the sidebar
(green), then edit any line of `backend/data/audit.jsonl` in a text editor and
hit it again — it goes red and names the record you changed.

## Testing a payment end to end

Razorpay Test Mode accepts a fixed set of dummy card numbers — see
[Razorpay's test card documentation](https://razorpay.com/docs/payments/payments/test-card-upi-details/)
for the current list (a common one is `4111 1111 1111 1111`, any future
expiry, any CVV). No real money moves at any point in test mode.

## Running without a webhook tunnel

If you skip step 2, everything still works end-to-end: the agent can create a
payment link and you (or a judge watching the demo) can open it and pay, and
`check_payment_status` polls Razorpay directly for the result instead of
waiting on the webhook. The webhook path exists to show the signed-callback
pattern a real integration would use; it's not required to demo the
conversational checkout flow itself.

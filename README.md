# Mimir

> The Nordic Nerd's operational lens. Voice + text interface to the agency.

Live dashboard + conversational AI ("Mimir") that watches across pipeline, money, outbound, clients, and ops. Built on Nuxt 3, deployed on Vercel, voice via ElevenLabs (with browser fallback), tool-use via the Anthropic API.

## What it does (v1)

- **Dashboard** — single-screen view of MTD revenue, MRR, pipeline at every stage, replies pending, outbound deliverability, calls today, active clients.
- **Mimir** — conversational AI you can type or talk to. Calls tools to read agency data, answers in Mimir's voice (calm, considered, slightly archaic). Voice in via browser Web Speech API; voice out via ElevenLabs (free tier covers personal use).
- **Read+write actions** — Mimir can add deal notes, send the audit one-pager, trigger the weekly scrape. Write actions require explicit confirmation in conversation.

## Stack

- Nuxt 3 (TS strict), Tailwind, `@nuxtjs/tailwindcss`
- Anthropic API (`claude-sonnet-4-6`) with tool use
- ElevenLabs TTS (turbo-v2.5, ~500ms latency)
- Web Speech API (browser-native, no key)
- Vercel serverless functions for backend
- Cookie-based auth (password gate)

## Run locally

```bash
pnpm install
cp .env.example .env   # fill in NUXT_ANTHROPIC_API_KEY + NUXT_APP_PASSWORD at minimum
pnpm dev
```

Open `http://localhost:3000`, enter your password, you're in.

## Deploy

See `DEPLOY.md` for the full GitHub + Vercel walkthrough.

## v1 scope notes

All read tools currently return **mock data** with clear TODOs marking where to wire live APIs. The shape and Claude tool-use plumbing are production-quality; only the implementations are stubbed.

To go live, fill in:
- `NUXT_HUBSPOT_API_KEY` → wire `getPipelineSummary` to HubSpot CRM API
- `NUXT_STRIPE_SECRET_KEY` → wire `getMoneySummary` to Stripe balance + subscriptions
- `NUXT_SMARTLEAD_API_KEY` (or Instantly) → wire `getPendingReplies` + `getOutboundHealth`
- Gmail OAuth or label query → optional alternative for `getPendingReplies`

Each tool implementation lives in `server/utils/tools.ts`. Each one is ~15-20 lines of fetch code when wired live.

## Voice notes

- **Voice in:** browser Web Speech API (works in Chrome, Safari, Edge — not Firefox by default). No API key.
- **Voice out:** ElevenLabs primary, browser SpeechSynthesis fallback. If `NUXT_ELEVENLABS_API_KEY` is missing or the API errors, the client transparently falls back. No code change needed.
- **Default ElevenLabs voice:** "Brian" (calm, considered). Override with `NUXT_ELEVENLABS_VOICE_ID`. Voice library: https://elevenlabs.io/app/voice-library.

## Agent voice (Mimir)

Mimir's system prompt lives in `server/utils/system-prompt.ts`. He speaks as the Norse god of wisdom — calm, dry, observational, brief. Banned: corporate-speak, emoji, exclamation marks. Defaults to 1-3 sentences unless the question warrants depth.

When you ask him to do something that touches money or sends external comms, he confirms before acting.

## Routes

| Route | Purpose | Auth |
|---|---|---|
| `/` | Password gate | — |
| `/dashboard` | Live data dashboard | required |
| `/chat` | Mimir voice + text chat | required |

## Files of note

- `server/utils/system-prompt.ts` — Mimir's personality
- `server/utils/tools.ts` — tool definitions + handlers (Anthropic tool-use schema)
- `server/api/chat.post.ts` — chat endpoint, agentic tool loop (max 6 turns)
- `server/api/speak.post.ts` — ElevenLabs TTS
- `composables/useVoice.ts` — voice in/out (Web Speech + ElevenLabs/fallback)
- `composables/useMimir.ts` — chat state

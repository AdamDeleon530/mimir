# Deploying Mimir — GitHub + Vercel

End-to-end: from `~/Code/NordicNerd/mimir/` on your laptop → live at `https://mimir-<your-slug>.vercel.app` with auto-deploy on every `git push`.

---

## 1. Create the GitHub repo

This is the only manual step that can't be scripted from here (needs your GitHub login).

```bash
cd ~/Code/NordicNerd/mimir

# Init local repo + first commit
git init -b main
git add .
git commit -m "Initial scaffold — Mimir v1"

# Create remote repo + push (using GitHub CLI — install with `brew install gh`)
gh auth login        # one-time, opens browser
gh repo create thenordicnerd/mimir --private --source=. --remote=origin --push
```

Don't have GitHub CLI? Equivalent without it:

```bash
# Manually create a new private repo at https://github.com/new — name it `mimir`
# Then locally:
git remote add origin git@github.com:<your-username>/mimir.git
git push -u origin main
```

No GitHub Actions — Vercel runs the build on every push and gives you a preview URL for PRs, which covers CI for this project.

---

## 2. Get your API keys ready

**Required:**
- **Anthropic API key**: https://console.anthropic.com → API Keys → Create Key. Starts with `sk-ant-`.
- **App password**: any long random string. Generate with `openssl rand -base64 24`.

**Optional but recommended for the JARVIS feel:**
- **ElevenLabs API key**: https://elevenlabs.io → Profile → API Keys. Free tier = 10k chars/month, ~plenty for personal use.

Stash all of these in 1Password under "Mimir — Vercel."

---

## 3. Deploy to Vercel

```bash
# One-time setup
npm install -g vercel
cd ~/Code/NordicNerd/mimir
vercel login      # browser auth, one time

# First deploy — links the project
vercel
# Prompts:
#   ? Set up and deploy? Y
#   ? Which scope? (your personal team)
#   ? Link to existing project? N
#   ? Project name? mimir
#   ? Directory? ./
#   ? Override settings? N
# It deploys to a preview URL. Note the URL.
```

This creates the Vercel project AND links the GitHub repo, so future pushes to `main` auto-deploy production. The first `vercel` command without flags makes a preview deployment; `vercel --prod` makes production.

**Auto-deploy via GitHub:** if you used `gh repo create` in step 1, Vercel auto-detected the GitHub repo and connected it. If not, go to your Vercel dashboard → project → Settings → Git → Connect.

From this point: `git push` → Vercel builds → deployed in ~90 seconds.

---

## 4. Set environment variables in Vercel

Vercel CLI command (run locally; values stay private):

```bash
vercel env add NUXT_ANTHROPIC_API_KEY production
# Paste your Anthropic key when prompted

vercel env add NUXT_APP_PASSWORD production
# Paste your chosen password

vercel env add NUXT_ELEVENLABS_API_KEY production
# Paste ElevenLabs key (skip if not using)

vercel env add NUXT_ELEVENLABS_VOICE_ID production
# Paste voice ID (default "Brian" is nPczCjzI2devNBz1zQrb)
```

Or via dashboard: Vercel project → Settings → Environment Variables.

Set the same variables for "preview" and "development" environments if you want them to work locally and on preview deployments too:

```bash
vercel env add NUXT_ANTHROPIC_API_KEY preview development
```

After setting envs, redeploy production once so it picks them up:

```bash
vercel --prod
```

---

## 5. Verify it's live

1. Open the production URL Vercel printed.
2. Enter your password.
3. You should land on the dashboard (mostly empty for now — that's expected, mock data).
4. Click "ask mimir →" in the header.
5. Type "how's pipeline?" — Mimir should answer using his read tools.
6. If ElevenLabs is configured, he'll speak. Otherwise browser TTS kicks in.
7. Tap the mic icon and speak — your words appear in the input. Release → sent.

If chat 500s, check Vercel logs: `vercel logs --since 5m`.

---

## 6. Custom domain (optional, when ready)

To put it on `jarvis.thenordicnerd.com` (or whatever):

```bash
vercel domains add mimir.thenordicnerd.com mimir
# Then add the CNAME record Vercel shows in your Cloudflare DNS:
#   CNAME  mimir  cname.vercel-dns.com
```

Wait for SSL provisioning (~1 minute). Done.

---

## 7. Going live on the integrations

The read tools in `server/utils/tools.ts` return mock data in v1. To wire each one live:

| Tool | Live wiring | When |
|---|---|---|
| `get_pipeline_summary` | HubSpot API — see `~/Personal/NordicNerd-Ops/01-Stack-Setup/hubspot-setup.md` for the Private App + scopes | After HubSpot tenant is set up |
| `get_money_summary` | Stripe API — `~/Personal/NordicNerd-Ops/01-Stack-Setup/stripe-setup.md` | After LLC + Stripe live mode |
| `get_pending_replies` | Smartlead/Instantly API or Gmail label query | After cold inboxes warmed |
| `get_outbound_health` | Smartlead `/api/v1/email-accounts` | After cold inboxes connected |

Each one is ~20 lines of fetch code. Look for `// TODO:` comments in `server/utils/tools.ts`.

---

## CI/CD recap

```
edit a file → git commit → git push
       ↓
Vercel detects push, builds, deploys to production
       ↓
Live in ~90 seconds
```

PRs auto-get a preview URL from Vercel. Build failures block production deploys automatically. That's the full pipeline.

---

## Troubleshooting

**`vercel build` fails locally:** check `pnpm typecheck` first — that surfaces real TS errors before Vercel sees them.

**Chat returns 401:** the session cookie isn't set or expired. Log in again at `/`.

**ElevenLabs voice not playing but no error:** the API returned 503 (no key, quota exceeded, etc.) and the client fell back to browser TTS automatically. Check the browser console — there should be no errors. To debug, hit `/api/speak` directly and inspect the response.

**Voice input not working:** Web Speech API doesn't work in Firefox by default. Use Chrome, Safari, or Edge. Also requires HTTPS in production (Vercel handles this automatically).

**"crypto" errors during build:** add `node:crypto` to externals if you fork the auth handler — Nitro should already handle this.

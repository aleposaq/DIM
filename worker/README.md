# dim-ai-proxy

A Cloudflare Worker for DIM's AI assistant. It keeps the API keys on the server, sends each request to Claude, and falls back to Gemini when Claude is rate limited, overloaded, unreachable, or has no key set.

- `POST /chat` takes `{ system, tools, messages, geminiSignatures }`, where `messages` is a conversation in Anthropic Messages format. It returns `{ provider, content, stop_reason, fallbackReason?, geminiSignatures? }`, with `content` always in Anthropic format, even when Gemini answered.
- Every `POST` needs `Authorization: Bearer <PROXY_TOKEN>`. The Worker URL is public, so without the token anyone could run up your Anthropic bill.
- Only origins listed in `ALLOWED_ORIGINS` (in `wrangler.toml`) may call it from a browser. Other origins get 403.
- Bodies over 2 MB are rejected (the panel asks you to start a new chat).
- The model is chosen by the Worker (`CLAUDE_MODEL`, `CLAUDE_EFFORT`, `GEMINI_MODEL` in `wrangler.toml`), not by the caller.
- Claude requests use server-side refusal fallbacks (`fallbacks: "default"`), so if Claude's safety checks decline a request it's retried on Anthropic's recommended fallback model.

## Setup

```powershell
cd worker
npm install
npx wrangler login                         # sign in to Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY  # paste your Anthropic API key
npx wrangler secret put GEMINI_API_KEY     # paste your Google AI Studio key (fallback)
npx wrangler secret put PROXY_TOKEN        # paste a long random string, see below
npx wrangler deploy
```

To make a random token in PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
```

Paste the same token into the assistant panel under **Settings → Access token**.

Set a monthly spend limit for your Anthropic API key in the Claude Console, in case the token ever leaks.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill it in, and run `npx wrangler dev` (serves on `http://localhost:8787`).

## Test

```sh
npm test          # unit tests with mocked Claude and Gemini
npm run typecheck
```

Against the deployed Worker, in Windows PowerShell (passing JSON to `curl.exe` breaks on the quotes):

```powershell
$url = "https://dim-ai-proxy.<subdomain>.workers.dev/chat"
$token = "<your PROXY_TOKEN>"
$body = '{"system":"Be brief.","tools":[],"messages":[{"role":"user","content":"say hi"}]}'

# Should print provider "claude" and a greeting
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 60 | ConvertTo-Json -Depth 10

# Should fail with 401 (no token)
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -TimeoutSec 30

# Should fail with 403 "Origin not allowed"
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body -Headers @{ Origin = "https://evil.example"; Authorization = "Bearer $token" } -TimeoutSec 30
```

A new workers.dev subdomain can take 10-15 minutes before HTTPS works. Until then requests fail with a TLS handshake error.

Note: when Gemini's free tier answers, prompts and responses may be used by Google to improve its products.

## Hooking up DIM

The assistant is behind the `aiAssistant` feature flag, which is on for dev builds only.

1. The Worker URL is set in `config/ai-proxy.ts` and is allowed by DIM's Content Security Policy automatically. To use a different deployment without editing that file, set `DIM_AI_PROXY_URL` before `pnpm start`:

   ```powershell
   $env:DIM_AI_PROXY_URL = "https://dim-ai-proxy.<subdomain>.workers.dev"
   pnpm start
   ```

   `http://localhost:8787` (`wrangler dev`) is always allowed in dev builds.

2. Open the assistant with the lightning-bolt button in the header or **Shift+A**.
3. Under **Settings**, paste the access token. The Worker URL defaults to the one above (both are saved in localStorage as `dim-ai-proxy-url` and `dim-ai-proxy-token`). A different URL must also be allowed by the CSP, so change `config/ai-proxy.ts` (or `DIM_AI_PROXY_URL`) to match and restart `pnpm start`.

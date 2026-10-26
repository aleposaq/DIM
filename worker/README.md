# dim-ai-proxy

A Cloudflare Worker that forwards DIM AI assistant requests to Gemini, so the Gemini API key stays on the server.

- `POST /chat` takes `{ contents, tools, systemInstruction }` in Gemini `generateContent` format and returns Google's JSON unchanged.
- Only origins listed in `ALLOWED_ORIGINS` (in `wrangler.toml`) may call it from a browser. Other origins get 403.
- Bodies over 200 KB are rejected.

## Setup

```sh
cd worker
npm install
npx wrangler login                     # sign in to Cloudflare
npx wrangler secret put GEMINI_API_KEY # paste your Google AI Studio key
npx wrangler deploy
```

For local development, copy `.dev.vars.example` to `.dev.vars`, add your key, and run `npx wrangler dev` (serves on `http://localhost:8787`).

## Test

In Windows PowerShell, use `Invoke-RestMethod` (passing JSON to `curl.exe` breaks on the quotes):

```powershell
$url = "https://dim-ai-proxy.<subdomain>.workers.dev/chat"

# Should return a Gemini response
$body = '{"contents":[{"role":"user","parts":[{"text":"say hi"}]}]}'
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10

# Should fail with 403 "Origin not allowed"
Invoke-RestMethod -Method Post -Uri $url -ContentType "application/json" -Body '{"contents":[]}' -Headers @{ Origin = "https://evil.example" }
```

A new workers.dev subdomain can take 10-15 minutes before HTTPS works. Until then requests fail with a TLS handshake error.

Note: on Gemini's free tier, prompts and responses may be used by Google to improve its products.

## Hooking up DIM

The assistant is behind the `aiAssistant` feature flag, which is on for dev builds only.

1. Start DIM with the Worker URL so the Content Security Policy allows it:

   ```powershell
   $env:DIM_AI_PROXY_URL = "https://dim-ai-proxy.<subdomain>.workers.dev"
   pnpm start
   ```

   `http://localhost:8787` (`wrangler dev`) is always allowed in dev builds.

2. Open the assistant with the lightning-bolt button in the header or **Shift+A**.
3. The Worker URL defaults to `DIM_AI_PROXY_URL`. You can change it under **Settings** in the panel (saved in localStorage as `dim-ai-proxy-url`), but the new URL must also be allowed by the CSP, so restart `pnpm start` with the matching `DIM_AI_PROXY_URL`.

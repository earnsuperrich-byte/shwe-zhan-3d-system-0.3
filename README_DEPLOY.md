# Shwe Zhan 3D — PostgreSQL production deployment

This version replaces the Render-ephemeral `data.json` storage with PostgreSQL.

## Render
1. Push this project to GitHub.
2. In Render, create a Blueprint from the repository, or create a PostgreSQL database and a Web Service.
3. The included `render.yaml` defines both. Set `OWNER_ADMIN_PASSWORD` in Render; do not commit it.
4. Deploy the web service with `npm install` and `npm start`.
5. Health check: `/api/health`.

## Important
- Existing data in an old Render instance cannot be recreated from this source code if it was already lost by an ephemeral filesystem reset.
- If a legacy `data.json` exists beside the service at startup and the PostgreSQL database is empty, the server attempts a one-time migration.
- User accounts remain approved until an admin revokes approval.
- Each account owns its own projects; max 10 projects per account, with the oldest removed when creating the 11th.
- Owner Admin is bootstrapped from `OWNER_ADMIN_USERNAME` / `OWNER_ADMIN_PASSWORD`.
- Secrets should be stored in Render Environment Variables.


## Voice Input + AI interpretation

This build adds a separate Voice Input module without changing the existing keyboard entry parser.

### How it works
1. The browser records a short voice command and sends it to the authenticated `/api/voice/transcribe` endpoint.
2. If `GEMINI_API_KEY` is configured, Gemini transcribes the Burmese or English audio. Browser Speech-to-Text is used as a fallback if Gemini is unavailable.
3. Gemini is instructed to convert Burmese/English number words to digits and return at most one uppercase `R`; the app enforces the same output rule before sending command text to `/api/voice/interpret`.
4. Gemini interprets the command into strict JSON; the browser validates it and creates the existing 3-digit permutations deterministically.
5. Confirm mode shows a preview before adding entries. Auto Submit is optional.
6. If Gemini is unavailable, the app uses browser speech recognition and the local deterministic fallback parser where available.

### Important R/ပါတ်လည် rule
- `490 R 300` or `၄၉၀ အာ သုံးရာ` -> all 6 unique permutations = 300.
- `490 300 R 100` or `၄၉၀ သုံးရာ အာ တစ်ရာ` -> 490 = 300; the other 5 unique permutations = 100.
- Ambiguous commands are never auto-submitted.

### Render environment variables
- `GEMINI_API_KEY` — optional. Keep it server-side in Render Environment Variables; never put the key in `public/index.html`.
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`.
- `GEMINI_STT_MODEL` — defaults to `gemini-2.5-flash`; used for audio transcription.
- Gemini audio transcription needs the server-side `GEMINI_API_KEY`. The browser fallback needs a supported Chromium browser and microphone permission.

### Browser note
Gemini audio transcription processes each short recording after capture rather than transcribing in real time. Allow microphone permission. Browser fallback recognition availability and Burmese recognition quality can vary by browser/device/network. The AI interpreter is not allowed to invent missing number/cash values.

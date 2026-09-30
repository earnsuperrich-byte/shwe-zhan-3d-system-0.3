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
1. Browser Speech-to-Text listens in Burmese (`my-MM`) or English (`en-US`).
2. The transcript is sent to `/api/voice/interpret`.
3. If `GEMINI_API_KEY` is configured, the server asks Gemini to interpret the command into a strict JSON command.
4. The browser validates the command and generates the existing 3-digit permutations deterministically.
5. Confirm mode shows a preview before adding entries. Auto Submit is optional.
6. If the AI endpoint is unavailable, a local deterministic fallback parser handles common Burmese/English number phrases.

### Important R/ပါတ်လည် rule
- `490 R 300` or `၄၉၀ အာ သုံးရာ` -> all 6 unique permutations = 300.
- `490 300 R 100` or `၄၉၀ သုံးရာ အာ တစ်ရာ` -> 490 = 300; the other 5 unique permutations = 100.
- Ambiguous commands are never auto-submitted.

### Render environment variables
- `GEMINI_API_KEY` — optional. Keep it server-side in Render Environment Variables; never put the key in `public/index.html`.
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`.
- Speech-to-Text itself uses the browser SpeechRecognition API, so no speech API key is required by this module.

### Browser note
Use a Chromium-based browser such as current Chrome or Edge and allow microphone permission. Browser SpeechRecognition availability and Burmese recognition quality can vary by browser/device/network. The AI layer is an interpretation/correction layer; it is not allowed to invent missing number/cash values.

# Shwe Zhan 3D v29

This update changes only project-limit and approved-account behavior.

## Project limit
- Maximum 10 projects per user.
- When a user creates an 11th project, the oldest project owned by that same user is automatically deleted first, then the new project is created.
- Other users' projects are never removed by this rule.
- Existing project delete function remains available.

## Approved accounts
- An approved account remains approved across later logins/reloads until an Admin explicitly revokes approval.
- No repeated approval is required for an already-approved account.

## Files to update
- `server.js`
- `public/index.html` (unchanged from v28; included for a complete package)
- `package.json`
- `public/logo.png`


## Voice Input addition
- Added Burmese/English Voice Input card.
- Added Confirm Before Submit and Auto Submit modes.
- Added server-side AI interpretation endpoint using Gemini when `GEMINI_API_KEY` is configured.
- Added deterministic local fallback parser.
- Existing keyboard parser and entry submission path remain unchanged.

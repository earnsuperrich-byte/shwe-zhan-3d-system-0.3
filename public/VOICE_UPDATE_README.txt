Shwe Zhan 3D — Voice Input Update

This update replaces only the frontend index.html. Existing server.js,
package.json, logo.png and backend/database files remain unchanged.

Supported examples:
  1) လေးဂိုးသုည ၅၀၀        -> 490 / 500
  2) လေးဂိုးသုည၅၀၀          -> 490 / 500
  3) ငါးတစ်ကိုး ငါးဆယ်      -> 519 / 50
  4) ၅၁၉၅၀                  -> 519 / 50
  5) 490 R 300               -> 490, 409, 094, 049, 940, 904 at 300 each
  6) 490 300 R 100          -> 490 at 300; remaining permutations at 100
  7) 490 R 300 100          -> rejected as ambiguous (no guessing)
  8) လေးဂိုးသုည ငါးရာ အာ တစ်ရာ
     -> 490 at 500; R permutations at 100

Voice UI:
  - Confirm Before Submit (default)
  - Auto Submit
  - Preview
  - Confirm / Speak Again / Cancel

The voice capture uses the browser SpeechRecognition/Web Speech API.
Chrome/Edge are recommended. The recognized text is passed through a
deterministic business parser before it reaches the existing entry function.

Deployment:
  Replace the current project's index.html with this file.
  Keep the existing backend files unchanged.

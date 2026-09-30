# v32 PostgreSQL + Voice AI — 2026-09-30 Fix

This update fixes a synchronization race that could make an edited result number or table entry appear briefly and then revert.

## Fixed
- Result number (`ပေါက်ဂဏန်း`) is saved immediately through a dedicated server endpoint.
- Project sync now compares both entries and result number.
- While editing/submitting locally, background sync is paused so another poll cannot overwrite the edit.
- Table cell edits mark the page as locally editing before the prompts and keep sync paused while the edit auto-saves.
- Existing keyboard input and existing entry parser behavior are preserved.

## Render
Deploy this entire project directory to the GitHub repository connected to the Render Web Service. Do not upload this ZIP as a nested ZIP inside the repository.

The new endpoint is:
PUT /api/projects/:projectId/result
Body: {"resultNumber":"000"}

No new environment variable is required for this fix.

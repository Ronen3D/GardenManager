# /push — Version bump, review staged files, and push

You are performing a push workflow for the GardenManager project. Follow these steps carefully and in order:

## Step 1: Increment the UI version

1. Search for the current version string in src/web/app.ts by looking for the pattern <span class="beta-badge">vX.Y.Z</span> (where X.Y.Z are digits). If zero or multiple matches are found, stop and ask the user before proceeding.. Do NOT rely on a hardcoded line number — the line may shift.
2. Extract the current version (e.g. 1.9.3). If this file is already staged and contains a version change, use the updated version and do not increment again.
3. Always increment by exactly +0.0.1, with carry-over (like an odometer, each digit 0-9):
   - `2.1.1` → `2.1.2`
   - `2.1.9` → `2.2.0`
   - `2.9.9` → `3.0.0`
   - `9.9.9` → `10.0.0`
   The scope of changes does NOT affect the version bump — it is always +1.
4. Edit the file to replace the old version with the new one, keeping the exact same format (`v` prefix, inside the `beta-badge` span).
5. Stage this change with `git add`.

## Step 2: Stage ALL modified files

1. Run `git status` to see all modified, staged, and untracked files.
2. Stage **all** modified and previously-staged files — not just files changed in the current conversation. The push captures the full state of the working tree.
3. **Exclude** (unstage with `git reset HEAD <file>`) only files that are clearly: temporary files, debug artifacts, generated/build output, log files, `.env` or credential files, screenshots/images, or other unintended changes.
4. **If uncertain** about any file — ask the user before proceeding. Do not silently exclude or include ambiguous files.
5. Run `git diff --cached --stat` for an overview of what will be committed.

## Step 3: Generate push description and commit

1. Review all staged changes (read the diffs, not just file names) and identify distinct **change topics** — logical themes that group related changes regardless of which files they touch.
2. Compose a concise commit message in this format:
   ```
   Version X.Y.Z

   1. <change topic — what changed and why>
   2. <change topic — what changed and why>
   ...
   ```
   - Start with `Version X.Y.Z` matching the new UI version.
   - List changes as **numbered topics**, not per-file. Each item describes a logical change (e.g. "Removed ETA display from calibration overlay" or "Compact mobile warehouse cards for narrow screens").
   - Keep each item to one sentence. Aim for 2-5 items total.
   - **Under each numbered item**, add an indented plain-English explanation (non-technical) that a non-developer stakeholder could understand. Focus on the user-facing impact, not implementation details. Always write these explanations in English, never in Hebrew.
3. Present the commit message to the user for approval before committing.
4. Once approved, commit and push to the remote.

## Important notes

- This is a UI-only version bump. Do NOT modify package.json, config files, or any other versioning mechanism unless it is clearly already tied to the UI display.
- Always ask the user before proceeding if anything is unclear or ambiguous.
- Use Hebrew for user-facing messages if the user communicates in Hebrew.

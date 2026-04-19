# /push — Version bump, review staged files, and push

You are performing a push workflow for the GardenManager project. Follow these steps carefully and in order:

## Step 1: Increment the UI version

1. Search for the current version string in src/web/app.ts by looking for the pattern <span class="beta-badge">vX.Y.Z</span> (where X.Y.Z are digits). If zero or multiple matches are found, stop and ask the user before proceeding. Do NOT rely on a hardcoded line number — the line may shift.
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

2. **For each topic, look up the user-facing name before writing its explanation.** Internal code names (`future-sos.ts`, `generateBatchRescuePlans`, `FSOS`, "rescue.ts") are NOT what the user sees — translate to the on-screen feature name:
   - Grep the web UI (`src/web/`, especially `app.ts`, modal files, tab files, `style.css`) for the Hebrew label displayed to the user for the affected feature.
   - In the explanation, use an **English translation of the Hebrew UI label**, not the internal code name.
   - Known feature translations (extend this list if you find new ones):

     | Internal / code name | Hebrew UI label | English translation to use in explanations |
     |---|---|---|
     | Future-SOS, FSOS, future-sos | `אי זמינות עתידית` | "future unavailability" |
     | rescue / batch rescue plans | `תוכניות החלפה` | "replacement plans" |
     | affected assignments | `שיבוצים שיש להחליף` | "assignments to replace" |
     | opt-out (keep assignment) | (checkbox next to the assignment) | "keep this assignment as-is" |
     | partial plan badge | `תצוגה חלקית בלבד` | "partial preview" |
     | constraint violation | `הפרות אילוצים` | "constraint violations" |
     | load balance section | `איזון עומסים` | "workload balance" |
     | assignment changes section | `שינויי שיבוץ` | "assignment changes" |
     | injected emergency task | `משימת חירום (BALTAM)` | "emergency task" |
     | live / temporal mode | `מצב חי` | "live mode" |
     | schedule dirty warning | (yellow banner at top of schedule tab) | "unsaved-edits warning" |

   - If the feature doesn't appear in the table, grep for the Hebrew label yourself. If you cannot find a user-visible label, stop and ask the user what to call it.

3. **Translate constraint IDs to plain English.** Users don't see `HC-3` / `HC-5` / `SC-7` — they see red warnings and tooltip text. Use these translations (extend if needed):

   | Internal ID | What the user experiences | Plain-English name |
   |---|---|---|
   | HC-1 | "level too low for this slot" | "seniority / level mismatch" |
   | HC-3 | "this person is unavailable during this shift" | "availability conflict" |
   | HC-5 | "this person is already assigned somewhere else at this time" | "double-booking" |
   | HC-6 | "certification required" | "missing certification" |
   | HC-7 | "this person must work with a group-mate" | "group pairing conflict" |
   | HC-8 | "forbidden certification on this slot" | "forbidden certification" |
   | HC-11 | (injected emergency conflict) | "emergency-task conflict" |
   | HC-12 | "too many consecutive shifts" | "consecutive-shift limit" |
   | HC-14 | "not enough rest between shifts" | "rest-gap violation" |
   | SC-3 / SC-6 / SC-7 / SC-8 / SC-9 / SC-10 | fairness / rest / workload warnings (not blocking) | "fairness warning" or "workload warning" (pick by context) |

4. Compose a concise commit message in this format:
   ```
   Version X.Y.Z

   1. <change topic — one-sentence summary of what changed and why>
   2. <change topic — one-sentence summary of what changed and why>
   ...
   ```
   - Start with `Version X.Y.Z` matching the new UI version.
   - List changes as **numbered topics**, not per-file. Each item is a logical change.
   - Keep each top-line summary to one sentence. Aim for 2-5 items total.
   - **Under each numbered item**, add an indented plain-English explanation that a non-developer stakeholder could understand. Rules for the explanation:

     - **Frame as before → after from the user's perspective.** Describe what the user saw, did, or experienced before this change, then what they see / do / experience now. Examples:
       - "Before, when you kept some assignments as-is while using future unavailability, the kept assignments still showed availability-conflict warnings on them. Now those warnings are gone — kept assignments look normal."
       - "Previously, the top 3 replacement plans could be near-duplicates of each other. Now they're guaranteed to be meaningfully different alternatives."
       - "Before, the top-ranked replacement plan could silently contain a double-booking. Now the planner checks each plan for double-bookings, rest-gap violations, and consecutive-shift-limit issues before ranking, so the #1 plan is always safe to apply."

     - **Allowed vocabulary:**
       - The English translations from the tables in Step 3.2 and 3.3 above (future unavailability, replacement plans, availability conflict, double-booking, rest-gap violation, etc.).
       - Domain terms the user already knows: participant, slot, shift, day, certification, group, warning, conflict, schedule, plan.
       - Hebrew UI labels **quoted verbatim** when referring to a specific on-screen string (e.g. `the "תצוגה חלקית בלבד" badge`), but always alongside the English explanation.

     - **Banned vocabulary:**
       - File names, function names, class names, variable names, file paths, line numbers, module names (`future-sos.ts`, `generateBatchRescuePlans`, `scoreSwapSet`, `computeEffectiveUnavailabilityWindows`).
       - Raw constraint IDs (`HC-3`, `HC-5`, `SC-7`) — always translate via the Step 3.3 table.
       - Data-structure terms (arrays, maps, scratch buffers, hashes), algorithm names (DFS, MMR, simulated annealing, greedy), big-O notation, "allocation pressure", "time budget" (prefer "could run out of time" / "took too long" / "got stuck halfway through").

     - **Always write these explanations in English, never in Hebrew** (except for the inline Hebrew UI quotations described above).

     - If a change is purely internal (refactor, test-only, dead-code removal) with NO observable user effect, say so explicitly: "No user-visible change — internal cleanup only." Do not invent a user impact.

5. Present the commit message to the user for approval before committing.

6. Once approved, commit and push to the remote.

## Important notes

- This is a UI-only version bump. Do NOT modify package.json, config files, or any other versioning mechanism unless it is clearly already tied to the UI display.
- Always ask the user before proceeding if anything is unclear or ambiguous.
- Use Hebrew for user-facing chat messages if the user communicates in Hebrew. The commit-message explanations themselves stay in English (Step 3.4).

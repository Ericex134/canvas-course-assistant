# Course Knowledge Base

For course questions, notes, deadlines, or a knowledge-base refresh, read and follow `skills/course-assistant/SKILL.md` and `PROJECT_INSTRUCTIONS.md`.

## Fast Answer Path

For ordinary course questions, especially "what is due", "what should I read", "what are my todos", "when is the quiz/midterm/final", or "what is coming up", do not start by scanning every source file.

1. Read `calendar.md` first for all-course dated events.
2. Read `course-context.md` next for course names, review coverage, and whether the latest Canvas collection was partial.
3. If the question needs course-specific detail, read only the relevant `courses/<course>/calendar.md` or `calendar.json`.
4. For readings or preparation details not shown in the calendars, search reviewed notes narrowly with `rg` using the relevant course, date, assignment, quiz, reading title, or keyword.
5. Only inspect `source-manifest.json`, `review-state.json`, source PDFs, or Canvas metadata when the calendars/notes are ambiguous, missing citations, or the user asks for a refresh/audit.
6. State freshness and gaps briefly when relevant: use the timestamps in `calendar.md`, `course-context.md`, and `canvas/exports/sync-report.md`.

Prefer targeted commands such as `rg -n "Sep 21|Quiz 1|reading" courses/<course>/notes` and `sed` on known calendar files over broad `rg --files` dumps. Avoid reading `canvas/node_modules`, raw snapshots, or every note unless the task truly requires a full review.

The scraper collects sources; the course assistant decides what deserves notes and maintains the calendar. Keep sources and notes flat within each course. Track reviewed content hashes so reruns process new material and reuse prior reviews of identical files. The scraper does not own agent notes, review state, or calendar files.

For scraper maintenance, preserve this contract. The user performs end-to-end Canvas testing; provide a testing guide rather than running a live scrape unless requested. Never treat an interrupted or partial collection as complete.

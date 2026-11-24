# Course Knowledge Base

Canvas sources and agent-reviewed notes for the starred courses in `2026W1_V`.

Each course has one flat `sources/` folder. The scraper collects attachments, prints Canvas content to PDF, and maintains an inventory. The course assistant reviews new sources, decides which need notes, and maintains assignments, readings, and tasks. Repeat runs reuse previous reviews and duplicate-file notes.

## Use

From this folder, collect sources:

```bash
node canvas/scripts/sync-canvas.mjs
```

Then ask an agent with access to this folder:

> Use skills/course-assistant/SKILL.md to review the downloaded sources without rerunning the scraper. Write useful course notes, source manifests, and calendars, and remember which sources you reviewed or skipped.

For later updates:

> Use skills/course-assistant/SKILL.md to refresh my courses and review only new or unreviewed sources.

After the first review, ask questions such as "What is due this week?", "What readings should I do before class?", or "Explain this lecture's main ideas with citations."

The first agent review creates `calendar.md`, per-course calendars, `manifest.md`, `review-state.json`, and useful notes. The scraper alone does not create study notes.

- [Install](INSTALL.md)
- [Manual testing guide](canvas/TESTING.md)
- [Scraper details](canvas/README.md)
- [Agent contract](PROJECT_INSTRUCTIONS.md)
- [Course-assistant skill](skills/course-assistant/SKILL.md)

Old generated folders are preserved in `canvas/data/legacy/`. Browser sessions and private course materials are local; exclude them from public sharing.

# Course Knowledge Base Contract

Use [the course-assistant skill](skills/course-assistant/SKILL.md) to refresh sources, write notes, maintain tasks, and answer course questions.

## Layout

```text
Knowledge Base/
  calendar.md                     # agent: all-course tasks, deadlines, readings
  course-context.md               # agent: course index and review coverage
  skills/course-assistant/SKILL.md
  courses/<course>/
    sources/                      # scraper: flat originals and PDF captures
    source-manifest.json          # scraper: stable IDs, hashes, paths, issues
    canvas-metadata.json          # scraper: structured Canvas records
    notes/                        # agent: flat, useful reviewed Markdown
    review-state.json             # agent: persistent review/skip decisions
    manifest.md                   # agent: source descriptions and note links
    calendar.json                 # agent: structured, deduplicated tasks
    calendar.md                   # agent: human-readable course calendar
  canvas/exports/sync-report.md
  canvas/data/state/latest.json
  canvas/data/raw-snapshots/
  canvas/data/legacy/              # archived pre-migration folders
```

Agent-owned files are created during the first agent review, not filled with placeholders by the scraper. Source manifests are inventories, not proof an agent has read the sources.

## Collection

Run `node canvas/scripts/sync-canvas.mjs` from the root. It uses the persistent browser profile and only starred courses matching `2026W1_V` by default. Keep the browser open until completion. It attempts saved login buttons; password/Duo can still need the user.

Discovery uses paginated course/folder listings, module items, inner page/assignment/discussion HTML, and a bounded recursive browser crawl. Canvas webpages become PDF sources. Existing PDFs retain their bytes. Text/images receive PDF companions; Office formats require LibreOffice. Unsupported formats retain originals with explicit conversion status. No source is merely renamed to PDF. HTML/JSON preview and login responses are not saved as attachments.

Failures, inaccessible content, conversion problems, and crawl limits appear in the sync report. Incomplete runs exit nonzero and preserve collected work. A complete collection refers to the configured accessible paths, not future/unpublished content or agent review.

## Repeat Runs

Canvas file IDs identify attachments across preview/download URLs and filenames. External downloads use a URL identity. Each source has a `contentHash`; attachments use file bytes, webpages use content before PDF generation to avoid PDF timestamp churn. Unchanged Canvas size/update metadata lets reruns reuse local files and saved hashes without redownloading or rereading bytes. New downloads are hashed in memory. Identical bytes under distinct Canvas IDs are marked `duplicateOf`; the agent reuses their review and notes. Originals remain separately attributable.

Compare `source-manifest.json` with agent-owned `review-state.json`, not modification times. Remember both reviewed and deliberately skipped sources. Originals and PDF companions share one record. Rebuild missing notes; decide what to do with new files; skip unchanged completed reviews. Local sources not observed this run are retained with `observedThisRun: false`; missing visibility is not cancellation or deletion.

## Answers and Calendar

Read root/course calendars for tasks. For class questions, use the course manifest and notes, then the source for detail. Check scrape and review freshness independently. Legacy raw extraction and keyword dashboards are not reviewed evidence.

Cite source paths and page/slide/section locators. Preserve exact deadlines and America/Vancouver timezone; distinguish due, available, and reading dates. Do not invent dates, infer completion from time passing, or assume every section date applies to this student. Preserve user completion marks. Surface missing sources, incomplete reviews, and conflicting dates.

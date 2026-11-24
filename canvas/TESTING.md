# Manual End-to-End Testing

These are acceptance checks for you to run. Live Canvas has not been tested during this change.

## 1. Collect

From the knowledge-base root:

```bash
node canvas/scripts/sync-canvas.mjs
```

Keep the browser open until the script closes it. Confirm saved login buttons are pressed; finish password/Duo if requested. Confirm only starred `2026W1_V` courses are collected. Read `canvas/exports/sync-report.md`, including every issue. A partial status means some collection/conversion could not finish, not that everything failed.

## 2. CPSC 423 Files

Open CPSC 423's Files tab yourself and pick files from the root and nested folders. Compare their names with the titles in `source-manifest.json`; open the referenced `sources/` paths. PDFs should contain lecture/reading content, not login screens, JSON, or previews. Compare the accessible listing against `canvas-metadata.json`. The report should show file/folder counts. The `/files` page should appear in the latest run's page records, or have an explicit error.

If files remain missing, retain the report and note the Canvas course/file URL and visible filename. Do not send browser cookies or session data.

## 3. Module and Assignment Attachments

For ASIA 326, select a module item whose inner description links to a reading. Confirm the download exists even without a Files tab. Repeat for an attachment in an assignment description. Check a late module item as well as the first. Inspect the assignment/page PDF and compare due/availability dates in `canvas-metadata.json` against Canvas.

## 4. Layout and PDF Quality

- Each course uses flat `sources/`. No `sources/readings`, `sources/slides`, or categorized notes are recreated.
- Old generated folders are preserved in `canvas/data/legacy/<course>/`.
- Original PDFs open unchanged. Canvas captures contain useful content and label missing images.
- TXT/image attachments have a PDF companion, represented by one inventory record.
- Office conversion needs LibreOffice. Without it, originals remain and `needs-conversion` explains why. ZIPs intentionally remain original-only.
- No new `.html` login/preview sources or raw-extraction Markdown notes appear.

## 5. Run Again

Run the command twice without new Canvas material. Source IDs/paths should remain stable, attachments should show `unchanged`, and no `file (1).pdf` copies should appear. The latest snapshot should mark unchanged Canvas downloads `reused: true`: those reuse saved fingerprints and do not download/hash the file again. Distinct Canvas IDs with identical bytes should share hashes and have `duplicateOf`. URL aliases for one Canvas file should resolve to one source. Audit snapshots increase by design; repeated source copies do not.

## 6. Agent Review

Ask:

> Use skills/course-assistant/SKILL.md to review existing downloads without rerunning the scraper. Review new sources, create useful course notes and calendars, and persist all review and skip decisions.

Check:

- Notes explain concepts with source/page citations, including visual slide content where relevant.
- Navigation and redundant materials can be skipped with reasons.
- Every source appears in `manifest.md`, including skipped, duplicate, and unreadable sources.
- `review-state.json` records the exact reviewed `contentHash` and decision for completed reviews.
- Root/course calendars have course labels, citations, and correct Vancouver dates/times. Unknown deadlines stay unknown; conflicts are called out.
- Original and PDF companion do not produce duplicate notes or tasks.

Ask the agent to review again. Unchanged noted/skipped sources should be reused without rereading/rewriting. Duplicates should link to existing notes. Completion marks must survive. When Canvas gains a file, refresh again: the new item should be reviewed while previously handled sources are skipped.

Finally ask "What is due this week?", "What readings do I have before my next ASIA 326 class?", and a lecture question. Verify answers against citations. The agent should distinguish scrape freshness from completed review coverage.

## 7. Interruption Recovery (Optional)

During a separate run, close the Canvas browser. The scraper should exit interrupted instead of claiming all courses synced. Collected files/manifests must survive. Rerun normally and confirm collection continues without multiplying files or touching reviewed notes.

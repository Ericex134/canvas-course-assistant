# Canvas Source Collector

The scraper uses a logged-in Playwright browser and authenticated Canvas GET requests. No API token is needed. It collects sources for [the course-assistant skill](../skills/course-assistant/SKILL.md); it does not generate study notes or guess tasks from keywords.

## Run

From the knowledge-base root:

```bash
node canvas/scripts/sync-canvas.mjs
```

Or from `canvas/`, use `npm run sync`. A visible browser reuses `canvas/.browser-profile/`. Saved-login buttons are clicked automatically; password/Duo can still need you. Leave the browser open until the script closes it.

Optional settings belong in `canvas/config/config.json`; see `config/config.example.json`. The default term is exactly `2026W1_V`, with starred courses only. Inclusion/exclusion filters match a course name substring or ID. `maxPagesPerCourse` bounds browser crawling; API listing pages are fetched independently. Hitting a limit is reported as incomplete collection.

## File Discovery

- Paginate course files and course folders, then each folder's files.
- Visit `/files` explicitly, even if navigation omits its tab.
- Paginate each module's items, including modules whose inline list is absent.
- Follow inner module pages and assignment descriptions with the browser's HTML parser.
- Resolve Canvas preview URLs, `?preview=ID`, and API file references through file metadata to real downloads.
- Collect pages, assignments, discussions, announcements, and available discussion replies.
- Recursively follow same-course browser links, including nested folders and pages.

API references: [Files and folders](https://developerdocs.instructure.com/services/canvas/resources/files), [Modules and module items](https://developerdocs.instructure.com/services/canvas/resources/modules). Only content accessible to the signed-in student is available. External tool sites, arbitrary external articles, and video recordings are not crawled; recognizable direct external document links are downloaded.

## Sources and PDFs

All course sources go directly in `courses/<course>/sources/`. Canvas pages are PDFs; scripts/embeds are removed and uncaptured images are explicitly noted. Authenticated same-Canvas images are embedded when available. Original PDFs stay intact. Text/images receive PDF companions. Office conversion uses LibreOffice via `libreOfficePath` or the default macOS application path. ZIPs and unsupported formats remain original-only. Failed conversions retain originals and appear in the report.

`source-manifest.json` tracks IDs, original/PDF paths, fingerprints, duplicates, provenance, conversion status, and whether each source was seen this run. Original and PDF companion share one record. `canvas-metadata.json` preserves structured dates, assignments, modules, and discussion records. Agent notes/calendars are never overwritten.

## Reruns and Recovery

Stable Canvas IDs prevent preview/download aliases becoming duplicate attachments. When Canvas file size and update metadata match the previous run and the local original exists, the scraper reuses it without downloading or hashing it again. New downloads are fingerprinted once while their bytes are already in memory. The agent uses the saved fingerprint to reuse reviews and recognize duplicates. Distinct IDs with identical bytes retain provenance but share notes. Audit snapshots grow per run by design.

The course file listing also avoids redundant folder requests when it already contains that folder's reported file count. Pages captured through the API are not reopened in the browser. Browser crawling remains the fallback for additional content and the explicit Files tab.

`canvas/exports/sync-report.md` shows new/updated/unchanged counts and collection/conversion issues. `canvas/data/state/latest.json` has per-course checkpoints; timestamped snapshots preserve older runs. Closed browsers produce an interrupted run. Partial/interrupted runs exit nonzero. Rerun after fixing the reported cause.

One-time migration flattens existing source folders and archives old notes, summaries, concepts, HTML previews, and untyped `.download` artifacts under `canvas/data/legacy/<course>/`. Originals are preserved. `--migrate-only` only reorganizes local files and inventories them; it does not open Canvas or convert sources. The next regular sync converts eligible imported files and matches attachments to imported originals by hash.

See [TESTING.md](TESTING.md) for manual acceptance checks.

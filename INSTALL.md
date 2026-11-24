# Install and Use

Requirements: Node.js 18+, Canvas access, and your `2026W1_V` courses starred in Canvas All Courses.

From `canvas/`:

```bash
npm install
npx playwright install chromium
```

From the knowledge-base root:

```bash
node canvas/scripts/sync-canvas.mjs
```

Keep the visible browser open until completion. The saved profile reuses your session; finish password/Duo prompts when needed. Read `canvas/exports/sync-report.md` afterward. Partial/interrupted runs preserve files and exit nonzero.

Optional: install LibreOffice for DOCX/PPTX/XLSX and related PDF conversions. The default executable is `/Applications/LibreOffice.app/Contents/MacOS/soffice`; override `libreOfficePath` in `canvas/config/config.json` for another installation. Without it, originals are saved and failed conversions are listed. PDFs, Canvas pages, text, and images do not need LibreOffice. ZIPs remain native.

Settings are documented in `canvas/config/config.example.json`. Old `convertDownloadedPdfs` and `downloadExtensions` settings are unused: no extracted Markdown is generated, and Canvas attachments are preserved regardless of extension (except HTML preview artifacts).

After collecting, invoke [skills/course-assistant/SKILL.md](skills/course-assistant/SKILL.md) in an agent with workspace access. `AGENTS.md` directs local agents to it. Invoke the skill by path; no separate agent service or scheduler is required.

See [manual testing](canvas/TESTING.md) before your first review. Do not publicly share the browser profile or private course materials.

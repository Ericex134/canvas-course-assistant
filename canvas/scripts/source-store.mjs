import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeName = value => String(value || 'source').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 150) || 'source';
export async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, file);
}
export const writeJson = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2) + '\n');

async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

async function movePreserving(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (await exists(to)) to += `.${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await fs.rename(from, to);
}

// Archive the old layout once; never overwrite notes authored by a later agent.
export async function migrateCourse(root, slug) {
  const courseDir = path.join(root, 'courses', slug);
  const marker = path.join(courseDir, '.source-layout-v2.json');
  if (await exists(marker)) return;
  const archive = path.join(root, 'canvas', 'data', 'legacy', slug);
  const sourcesDir = path.join(courseDir, 'sources');
  await fs.mkdir(sourcesDir, { recursive: true });
  for (const name of ['notes', 'summaries', 'concepts', 'README.md', 'course-context.md']) {
    const oldPath = path.join(courseDir, name);
    if (await exists(oldPath)) await movePreserving(oldPath, path.join(archive, name));
  }
  for (const file of await walk(sourcesDir)) {
    const relative = path.relative(sourcesDir, file);
    if (/\.(html?|download)$/i.test(file)) {
      await movePreserving(file, path.join(archive, 'sources', relative));
      continue;
    }
    if (path.dirname(file) === sourcesDir) continue;
    let target = path.join(sourcesDir, path.basename(file));
    if (await exists(target)) {
      const digest = hash(await fs.readFile(file));
      if (digest === hash(await fs.readFile(target))) {
        await movePreserving(file, path.join(archive, 'duplicate-sources', relative));
        continue;
      }
      target = path.join(sourcesDir, `${digest.slice(0, 12)}-${path.basename(file)}`);
    }
    await movePreserving(file, target);
  }
  async function removeEmpty(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await removeEmpty(path.join(dir, e.name));
    }
    if (dir !== sourcesDir) await fs.rmdir(dir).catch(error => { if (error.code !== 'ENOTEMPTY') throw error; });
  }
  await removeEmpty(sourcesDir);
  await writeJson(marker, { version: 2, migratedAt: new Date().toISOString(), archive: path.relative(root, archive) });
}

export class SourceStore {
  constructor(root, course, renderer, config) {
    this.root = root;
    this.course = course;
    this.renderer = renderer;
    this.config = config;
    this.dir = path.join(root, 'courses', course.slug);
    this.records = new Map();
    this.seen = new Set();
    this.conversionAttempts = new Set();
  }
  async init() {
    await migrateCourse(this.root, this.course.slug);
    const manifest = await readJson(path.join(this.dir, 'source-manifest.json'), { sources: [] });
    for (const record of manifest.sources) this.records.set(record.id, record);
    const knownPaths = new Set(manifest.sources.flatMap(r => [r.path, r.pdfPath].filter(Boolean)));
    for (const file of await walk(path.join(this.dir, 'sources'))) {
      const relative = path.relative(this.dir, file);
      if (knownPaths.has(relative)) continue;
      const bytes = await fs.readFile(file);
      const sha256 = hash(bytes);
      const id = `local:${hash(relative).slice(0, 20)}`;
      this.records.set(id, {
        id, kind: 'local-file', title: path.basename(file), path: relative,
        pdfPath: /\.pdf$/i.test(file) ? relative : null,
        sha256, contentHash: sha256, bytes: bytes.length, origins: [],
        conversion: /\.pdf$/i.test(file) ? 'original-pdf' : 'pending',
        firstSeenAt: new Date().toISOString(), change: 'imported'
      });
    }
    await atomicWrite(path.join(this.dir, 'README.md'), `# ${this.course.name}\n\nCanvas: ${this.course.url}\n\n- sources/: original attachments and PDF captures, in one flat folder.\n- source-manifest.json: scraper inventory, fingerprints, provenance, and conversion issues.\n- notes/: reviewed Markdown written by the course assistant, only when useful.\n- review-state.json: agent decisions keyed by source ID and reviewed content hash.\n- manifest.md: agent descriptions, note links, and skipped-source reasons.\n- calendar.md: agent-reviewed assignments, readings, and dates.\n\nOld generated folders are preserved under canvas/data/legacy/${this.course.slug}/ at the knowledge-base root.\n`);
    await this.save('pending');
  }
  async save(status, issues = []) {
    const sources = [...this.records.values()];
    const canonical = new Map();
    // Stable IDs make duplicate selection deterministic across runs.
    for (const r of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
      r.observedThisRun = this.seen.has(r.id);
      r.duplicateOf = canonical.get(r.contentHash) || null;
      if (!r.duplicateOf) canonical.set(r.contentHash, r.id);
    }
    await writeJson(path.join(this.dir, 'source-manifest.json'), {
      schemaVersion: 2, course: this.course, syncedAt: new Date().toISOString(),
      syncStatus: status, issues, sources
    });
  }
  async put({ id, title, body, filename, url, kind, metadata = {}, contentHash }) {
    const sha256 = hash(body);
    const fingerprint = contentHash || sha256;
    let old = this.records.get(id);
    if (!old) {
      // Adopt a migrated local source when its bytes match a discovered attachment.
      old = [...this.records.values()].find(r => r.id.startsWith('local:') && r.sha256 === sha256);
      if (old) this.records.delete(old.id);
    }
    const sameExtension = old?.path && path.extname(old.path).toLowerCase() === path.extname(filename).toLowerCase();
    const relative = sameExtension ? old.path : `sources/${safeName(id)}--${safeName(filename)}`;
    const target = path.join(this.dir, relative);
    const unchanged = old?.contentHash === fingerprint && await exists(target);
    if (!unchanged) await atomicWrite(target, body);
    const now = new Date().toISOString();
    const record = {
      ...old, id, title, kind, url, path: relative, bytes: unchanged ? old.bytes : body.length,
      sha256: unchanged ? old.sha256 : sha256, contentHash: fingerprint, metadata,
      firstSeenAt: old?.firstSeenAt || now, lastSeenAt: now,
      changedAt: unchanged ? old.changedAt || old.firstSeenAt : now,
      change: unchanged ? 'unchanged' : old ? 'updated' : 'new',
      origins: [...new Set([...(old?.origins || []), url].filter(Boolean))]
    };
    if (!unchanged) { record.pdfPath = null; record.pdfForHash = null; }
    this.records.set(id, record);
    this.seen.add(id);
    await this.convert(record);
    await this.save('in-progress');
    return record;
  }
  async convert(record) {
    const source = path.join(this.dir, record.path);
    const ext = path.extname(source).toLowerCase();
    if (ext === '.pdf') {
      record.pdfPath = record.path;
      record.pdfForHash = record.contentHash;
      record.conversion = 'original-pdf';
      return;
    }
    if (record.pdfPath && record.pdfForHash === record.contentHash && await exists(path.join(this.dir, record.pdfPath))) return;
    if (!this.renderer) return;
    const attempt = `${record.id}:${record.contentHash}`;
    if (this.conversionAttempts.has(attempt)) return;
    this.conversionAttempts.add(attempt);
    const pdfPath = `${record.path}.pdf`;
    try {
      let pdf;
      if (['.txt', '.md', '.csv', '.tsv', '.json', '.ipynb'].includes(ext)) {
        pdf = await this.renderer.render(`<pre>${escapeHtml(await fs.readFile(source, 'utf8'))}</pre>`, record.title, record.url);
      } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
        const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1);
        pdf = await this.renderer.render(`<img src="data:image/${mime};base64,${(await fs.readFile(source)).toString('base64')}">`, record.title, record.url);
      } else if (['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.odp', '.ods', '.rtf'].includes(ext)) {
        const binary = this.config.libreOfficePath || '/Applications/LibreOffice.app/Contents/MacOS/soffice';
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pdf-'));
        try {
          await runFile(binary, [`-env:UserInstallation=file://${temporary}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', temporary, source], { timeout: 120000 });
          pdf = await fs.readFile(path.join(temporary, `${path.basename(source, ext)}.pdf`));
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      } else {
        record.conversion = 'original-only';
        record.conversionReason = `No faithful PDF conversion for ${ext || 'unknown format'}; original retained.`;
        return;
      }
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Converter did not produce a PDF');
      await atomicWrite(path.join(this.dir, pdfPath), pdf);
      record.pdfPath = pdfPath;
      record.pdfForHash = record.contentHash;
      record.conversion = 'converted';
      delete record.conversionReason;
    } catch (error) {
      record.conversion = 'needs-conversion';
      record.conversionReason = error.code === 'ENOENT' ? 'Install LibreOffice or configure libreOfficePath; original retained.' : error.message;
    }
  }
}

export class PdfRenderer {
  constructor(browser, request, origin, maxBytes) {
    this.browser = browser;
    this.request = request;
    this.origin = origin;
    this.maxBytes = maxBytes;
  }
  async render(html, title, url) {
    const page = await this.browser.newPage({ javaScriptEnabled: false });
    try {
      // No scripts, embeds, or network requests from untrusted course HTML.
      await page.route('**/*', route => route.abort());
      await page.setContent(`<html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
      const images = await page.evaluate(base => {
        document.querySelectorAll('script,style,link,iframe,object,embed,form,input,button,video,audio').forEach(el => el.remove());
        for (const el of document.querySelectorAll('*')) {
          for (const attr of [...el.attributes]) {
            if (!['href', 'src', 'alt', 'colspan', 'rowspan'].includes(attr.name)) el.removeAttribute(attr.name);
          }
          for (const name of ['href', 'src']) {
            if (!el.hasAttribute(name)) continue;
            try {
              const value = new URL(el.getAttribute(name), base);
              if (['http:', 'https:'].includes(value.protocol) || (name === 'src' && /^data:image\//i.test(value.href))) el.setAttribute(name, value.href);
              else el.removeAttribute(name);
            } catch { el.removeAttribute(name); }
          }
        }
        return [...document.images].map((img, index) => ({ index, src: img.getAttribute('src') }));
      }, url || this.origin);
      const warnings = [];
      for (const img of images) {
        if (img.src?.startsWith('data:image/')) continue;
        let data = null;
        try {
          if (new URL(img.src).origin === this.origin) {
            const response = await this.request.get(img.src, { timeout: 20000 });
            try {
              const mime = response.headers()['content-type'] || '';
              if (response.ok() && /^image\/(png|jpeg|gif|webp)/i.test(mime)) {
                const bytes = await response.body();
                if (bytes.length <= this.maxBytes) data = `data:${mime.split(';')[0]};base64,${bytes.toString('base64')}`;
              }
            } finally { await response.dispose(); }
          }
        } catch { /* Preserve an explicit placeholder for images that cannot be captured. */ }
        if (!data) warnings.push(`Image not captured: ${img.src || 'unknown source'}`);
        await page.evaluate(({ index, data }) => {
          const el = document.images[index];
          if (data) el.src = data;
          else { el.removeAttribute('src'); el.alt = `[Image unavailable: ${el.alt || 'see original Canvas page'}]`; }
        }, { index: img.index, data });
      }
      const sanitized = await page.locator('body').innerHTML();
      await page.setContent(`<html><head><meta charset="utf-8"><style>
        @page { size: A4; margin: 18mm; } body { font: 11pt Arial, sans-serif; color: #111; }
        h1 { font-size: 20pt; } img { max-width: 100%; max-height: 240mm; object-fit: contain; }
        pre { white-space: pre-wrap; overflow-wrap: anywhere; } table { border-collapse: collapse; max-width:100%; }
        td,th { border: 1px solid #aaa; padding: 4px; overflow-wrap: anywhere; } a { overflow-wrap:anywhere; }
      </style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(url || 'Local source')}</p>${sanitized}${warnings.length ? `<h2>Capture limitations</h2><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}</body></html>`);
      await page.evaluate(async () => {
        await Promise.all([...document.images].filter(i => i.hasAttribute('src')).map(i => i.decode().catch(() => {})));
        await document.fonts.ready;
      });
      return await page.pdf({ format: 'A4', printBackground: true });
    } finally { await page.close(); }
  }
}

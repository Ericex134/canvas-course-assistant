#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SourceStore, PdfRenderer, atomicWrite, readJson, writeJson, hash, safeName, escapeHtml, exists } from './source-store.mjs';

const canvasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(canvasDir);
const defaults = {
  baseUrl: 'https://canvas.ubc.ca', headless: false, termInclude: ['2026W1_V'],
  courseInclude: [], courseExclude: [], maxCourses: 20, maxPagesPerCourse: 300,
  downloadMaxBytes: 100 * 1024 * 1024, libreOfficePath: null,
  discoverFilesViaCanvasApi: true, discoverModulesViaCanvasApi: true, discoverAssignmentsViaCanvasApi: true
};
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const errorText = error => String(error.message || error);
const relative = file => path.relative(root, file).split(path.sep).join('/');
const stamp = () => new Date().toISOString();

function assertOpen(page) {
  if (page.isClosed()) throw new Error('Canvas browser was closed. Sync interrupted; keep the browser open until the script finishes.');
}
function courseApi(course, suffix) { return `${new URL(course.url).origin}/api/v1/courses/${course.id}/${suffix}`; }
function fileId(href, origin) {
  try {
    const url = new URL(href);
    if (url.origin !== origin) return null;
    return url.pathname.match(/\/(?:files)\/(\d+)(?:\/|$)/)?.[1]
      || (/\/courses\/\d+\/files\/?$/.test(url.pathname) ? url.searchParams.get('preview')?.match(/^\d+$/)?.[0] : null);
  } catch { return null; }
}
function courseLink(href, course) {
  try {
    const url = new URL(href, course.url);
    if (url.origin !== new URL(course.url).origin) return null;
    if (!new RegExp(`^/courses/${course.id}(?:/|$)`).test(url.pathname)) return null;
    if (/\/(users|grades|people|settings|external_tools|submissions)(?:\/|$)/.test(url.pathname)) return null;
    if (!new RegExp(`^/courses/${course.id}/?$`).test(url.pathname) && !/\/(modules|assignments|pages|wiki|files|discussion_topics|announcements|quizzes)(?:\/|$)/.test(url.pathname)) return null;
    if (/\/(edit|delete|new)$/.test(url.pathname)) return null;
    url.hash = '';
    // Keep folder/module identifiers, but remove tracking and file-preview presentation options.
    for (const key of ['wrap', 'module_item_id', 'download_frd']) url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}

async function apiGet(session, url) {
  assertOpen(session.page);
  let response;
  try {
    response = await session.context.request.get(url, { timeout: 45000, maxRedirects: 5 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const json = await response.json();
    return { json, next: response.headers().link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null };
  } catch (error) {
    assertOpen(session.page);
    session.issues.push({ kind: 'api', url, error: errorText(error) });
    return null;
  } finally { if (response) await response.dispose(); }
}
async function apiList(session, url) {
  const result = [];
  const seen = new Set();
  while (url) {
    if (seen.has(url)) { session.issues.push({ kind: 'pagination', url, error: 'Repeated next-page URL' }); break; }
    seen.add(url);
    const data = await apiGet(session, url);
    if (!data) break;
    if (!Array.isArray(data.json)) { session.issues.push({ kind: 'api', url, error: 'Expected a JSON list' }); break; }
    result.push(...data.json);
    url = data.next;
  }
  return result;
}

async function login(page, config) {
  await page.goto(`${config.baseUrl}/courses`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Reusing Canvas login. Complete password/Duo if requested; keep this browser open until sync finishes.');
  const deadline = Date.now() + 300000;
  let clickedAt = 0;
  while (Date.now() < deadline) {
    assertOpen(page);
    if (new URL(page.url()).origin === new URL(config.baseUrl).origin && !/login|saml|auth/.test(page.url())) {
      if (await page.locator('a[href*="/courses/"]').count()) return;
    }
    if (Date.now() - clickedAt > 8000) {
      for (const locator of [page.getByRole('button', { name: /^(log in|login|sign in|continue)$/i }), page.getByRole('link', { name: /^(log in|login|sign in|continue)$/i }), page.locator('input[type="submit"][value="Login"], input[type="submit"][value="Log in"]')]) {
        if (await locator.first().isVisible().catch(() => false)) {
          await locator.first().click({ timeout: 5000 }).catch(() => {});
          clickedAt = Date.now();
          break;
        }
      }
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('Canvas login timed out. Complete login and rerun.');
}

async function discoverCourses(session, config) {
  await login(session.page, config);
  const all = await apiList(session, `${config.baseUrl}/api/v1/courses?enrollment_state=active&include[]=term&include[]=favorites&per_page=100`);
  let candidates = all.filter(c => c.is_favorite).map(c => ({
    id: String(c.id), name: c.name, term: c.term?.name || '', url: `${config.baseUrl}/courses/${c.id}`
  }));
  if (!candidates.length) {
    await session.page.goto(`${config.baseUrl}/courses`, { waitUntil: 'domcontentloaded' });
    await session.page.waitForTimeout(1000);
    candidates = await session.page.evaluate(() => [...document.querySelectorAll('tr')].flatMap(row => {
      const a = row.querySelector('a[href*="/courses/"]');
      const id = a?.href.match(/\/courses\/(\d+)/)?.[1];
      if (!id) return [];
      const starred = [...row.querySelectorAll('[aria-label],[title],[class*="star"],[class*="favorite"]')].some(el => {
        const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`;
        return !/not favorite|not starred|add.*favorite|add.*star/i.test(text) && /remove.*favorite|remove.*star|favorited|starred|icon-star(?!-empty)/i.test(text);
      });
      return starred ? [{ id, name: a.textContent.trim(), term: row.textContent.match(/\b\d{4}W[12]_V\b/)?.[0] || '', url: `${location.origin}/courses/${id}` }] : [];
    }));
  }
  const courses = [...new Map(candidates.map(c => [c.id, c])).values()].filter(c =>
    config.termInclude.includes(c.term) &&
    (!config.courseInclude.length || config.courseInclude.some(x => c.name.includes(x) || c.id === String(x))) &&
    !config.courseExclude.some(x => c.name.includes(x) || c.id === String(x))
  );
  if (courses.length > config.maxCourses) throw new Error(`Found ${courses.length} matching courses; raise maxCourses=${config.maxCourses} to avoid silently omitting courses.`);
  if (!courses.length) throw new Error(`No starred courses found for ${config.termInclude.join(', ')}. Check Canvas All Courses stars and term labels.`);
  const previous = await readJson(path.join(canvasDir, 'data/state/latest.json'), { courses: [] });
  return courses.map(c => ({ ...c, slug: previous.courses?.find(old => String(old.id) === c.id)?.slug || safeName(c.name).replace(/\./g, '-') }));
}

async function htmlLinks(session, html, base) {
  await session.parser.setContent(String(html || ''));
  return session.parser.evaluate(baseUrl => {
    const links = [];
    for (const el of document.querySelectorAll('a[href], [data-api-endpoint], iframe[src], embed[src], object[data]')) {
      const raw = el.getAttribute('href') || el.getAttribute('data-api-endpoint') || el.getAttribute('src') || el.getAttribute('data');
      try {
        const url = new URL(raw, baseUrl);
        if (/^https?:$/.test(url.protocol)) links.push({ href: url.toString(), text: el.textContent.trim() || el.getAttribute('title') || 'Linked source' });
      } catch { /* Ignore malformed links. */ }
    }
    return links;
  }, base);
}

function filename(response, suggested, href) {
  const headers = response.headers();
  const disposition = headers['content-disposition'] || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  name = name?.[1] || name?.[2] || suggested || path.basename(new URL(href).pathname);
  if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* Keep plain name. */ } }
  name = safeName(name);
  const mime = headers['content-type']?.split(';')[0];
  const extensions = { 'application/pdf': '.pdf', 'text/plain': '.txt', 'text/csv': '.csv', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/zip': '.zip' };
  if (!path.extname(name) && extensions[mime]) name += extensions[mime];
  return name;
}

async function download(session, course, store, link, via, knownFile = null) {
  const origin = new URL(course.url).origin;
  const id = knownFile?.id ? String(knownFile.id) : fileId(link.href, origin);
  const directExtension = /\.(pdf|docx?|pptx?|xlsx?|txt|md|csv|tsv|zip|ipynb|png|jpe?g|gif|webp|rtf|odt|odp|ods)(?:[?#]|$)/i.test(link.href);
  if (!id && !directExtension) return false;
  const sourceId = id ? `canvas-file:${id}` : `url:${hash(link.href.split('#')[0]).slice(0, 24)}`;
  if (session.downloaded.has(sourceId)) return true;
  if (session.failedDownloads.has(sourceId)) return true;
  let file = knownFile;
  if (id && !file) file = (await apiGet(session, `${origin}/api/v1/files/${id}`))?.json;
  if (file?.locked_for_user || file?.hidden_for_user) {
    session.failedDownloads.add(sourceId);
    session.issues.push({ kind: 'unavailable-file', id: sourceId, url: link.href, error: file.lock_explanation || 'Locked or hidden for this user' });
    return true;
  }
  const existing = store.records.get(sourceId);
  // Canvas metadata is the fast path; reuse the saved digest without reading file bytes.
  if (file?.updated_at && existing?.metadata?.updatedAt === file.updated_at &&
      existing.metadata.size === file.size && existing.metadata.modifiedAt === file.modified_at &&
      await exists(path.join(store.dir, existing.path))) {
    existing.change = 'unchanged';
    existing.lastSeenAt = stamp();
    store.seen.add(sourceId);
    session.downloaded.add(sourceId);
    session.downloads.push({ courseId: course.id, id: sourceId, path: relative(path.join(store.dir, existing.path)), change: 'unchanged', reused: true, sha256: existing.sha256 });
    return true;
  }
  let href = file?.url;
  if (!href && id) {
    const original = new URL(link.href);
    const target = new URL(`${origin}/courses/${course.id}/files/${id}/download`);
    if (original.searchParams.has('verifier')) target.searchParams.set('verifier', original.searchParams.get('verifier'));
    target.searchParams.set('download_frd', '1');
    href = target.toString();
  }
  href ||= link.href;
  let response;
  try {
    assertOpen(session.page);
    response = await session.context.request.get(href, { timeout: 60000, maxRedirects: 8 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const mime = response.headers()['content-type'] || '';
    let name = filename(response, file?.display_name || file?.filename, href);
    const jsonAttachment = /\.(json|ipynb)$/i.test(name);
    if (/text\/html/i.test(mime) || (/application\/(json|.*\+json)/i.test(mime) && !jsonAttachment)) throw new Error('Received HTML/JSON instead of a file; preview/login/API response was not saved');
    if (Number(response.headers()['content-length']) > session.config.downloadMaxBytes) throw new Error('File exceeds downloadMaxBytes');
    const body = await response.body();
    if (body.length > session.config.downloadMaxBytes) throw new Error('File exceeds downloadMaxBytes');
    if (!body.length) throw new Error('Empty download');
    if (/^\s*(<!doctype html|<html)/i.test(body.subarray(0, 200).toString()) || (!jsonAttachment && /^\s*\{\s*"(?:id|errors|message)"/i.test(body.subarray(0, 200).toString()))) throw new Error('Preview or API response was not saved');
    if (/\.html?$/i.test(name)) throw new Error('HTML attachment skipped');
    if (body.subarray(0, 5).equals(Buffer.from('%PDF-')) && !/\.pdf$/i.test(name)) name += '.pdf';
    if (/\.pdf$/i.test(name) && !body.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Download is named PDF but has no PDF signature');
    const record = await store.put({
      id: sourceId, title: file?.display_name || link.text || name, filename: name, body,
      url: id ? `${origin}/courses/${course.id}/files/${id}` : link.href, kind: 'attachment',
      metadata: { fileId: id, folderId: file?.folder_id, updatedAt: file?.updated_at, modifiedAt: file?.modified_at, size: file?.size, contentType: mime, discoveredVia: via }
    });
    session.downloaded.add(sourceId);
    session.downloads.push({ courseId: course.id, id: sourceId, path: relative(path.join(store.dir, record.path)), change: record.change, sha256: record.sha256 });
  } catch (error) {
    assertOpen(session.page);
    session.failedDownloads.add(sourceId);
    session.issues.push({ kind: 'download', id: sourceId, url: link.href, error: errorText(error) });
  } finally { if (response) await response.dispose(); }
  return true;
}

async function capture(session, store, { id, title, html, url, kind, metadata = {} }) {
  // Ignore volatile UI attributes/scripts when deciding whether a page needs another PDF.
  await session.parser.setContent(String(html || ''));
  const content = await session.parser.evaluate(() => {
    document.querySelectorAll('script,style,link,button,input,form').forEach(el => el.remove());
    return {
      text: document.body.textContent.replace(/\s+/g, ' ').trim(),
      links: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
      images: [...document.querySelectorAll('img')].map(img => [img.getAttribute('src'), img.getAttribute('alt')])
    };
  });
  const contentHash = hash(JSON.stringify({ content, title, metadata }));
  const old = store.records.get(id);
  if (old?.contentHash === contentHash && await exists(path.join(store.dir, old.path))) {
    old.change = 'unchanged'; old.lastSeenAt = stamp(); store.seen.add(id);
    return old;
  }
  try {
    const body = await session.renderer.render(html, title, url);
    return await store.put({ id, title, html, url, kind, metadata, contentHash, body, filename: `${safeName(title)}.pdf` });
  } catch (error) {
    assertOpen(session.page);
    session.issues.push({ kind: 'pdf-capture', url, error: errorText(error) });
    return null;
  }
}

async function followContent(session, course, store, html, url, via) {
  const links = await htmlLinks(session, html, url);
  for (const link of links) {
    if (!await download(session, course, store, link, via)) {
      const next = courseLink(link.href, course);
      if (next) session.queue.add(next);
    }
  }
}

async function discoverFiles(session, course, store) {
  if (!session.config.discoverFilesViaCanvasApi) return;
  const files = await apiList(session, courseApi(course, 'files?per_page=100'));
  // The folder endpoint supplies a second discovery path for app-style Files tabs.
  const folders = await apiList(session, courseApi(course, 'folders?per_page=100'));
  session.metadata.folders = folders;
  for (const folder of folders) {
    if (folder.for_submissions || folder.locked_for_user || folder.hidden_for_user) continue;
    const listedCount = files.filter(file => file.folder_id === folder.id).length;
    if (Number.isInteger(folder.files_count) && listedCount >= folder.files_count) continue;
    files.push(...await apiList(session, `${new URL(course.url).origin}/api/v1/folders/${folder.id}/files?per_page=100`));
  }
  const unique = [...new Map(files.filter(f => f.id).map(f => [f.id, f])).values()];
  session.metadata.files = unique;
  for (const file of unique) await download(session, course, store, {
    href: `${course.url}/files/${file.id}`, text: file.display_name || file.filename
  }, 'files-and-folders-api', file);
  console.log(`  Files listing: ${unique.length} records across ${folders.length} folders.`);
}

async function discoverModules(session, course, store) {
  if (!session.config.discoverModulesViaCanvasApi) return;
  const modules = await apiList(session, courseApi(course, 'modules?per_page=100'));
  session.metadata.modules = modules;
  for (const module of modules) {
    // Embedded items can be omitted/truncated; always paginate the dedicated endpoint.
    module.items = await apiList(session, courseApi(course, `modules/${module.id}/items?per_page=100`));
    for (const item of module.items) {
      if (item.type === 'File' && item.content_id) {
        await download(session, course, store, { href: `${course.url}/files/${item.content_id}`, text: item.title }, 'module-file');
        continue;
      }
      if (item.html_url) session.queue.add(item.html_url);
      if (item.external_url) await download(session, course, store, { href: item.external_url, text: item.title }, 'module-external-file');
      const apiUrl = item.url || (item.page_url ? courseApi(course, `pages/${encodeURIComponent(item.page_url)}`) : null);
      if (!apiUrl || new URL(apiUrl, course.url).origin !== new URL(course.url).origin) continue;
      const detail = (await apiGet(session, apiUrl))?.json;
      if (!detail) continue;
      const html = [detail.body, detail.description, detail.message].filter(Boolean).join('\n');
      const url = detail.html_url || item.html_url || course.url;
      if (html) {
        const contentId = item.type === 'Page' ? `canvas-page:${detail.page_id || detail.url || item.page_url}` : `module-item:${item.id}`;
        await capture(session, store, { id: contentId, title: detail.title || detail.name || item.title, html, url, kind: 'module-content' });
        await followContent(session, course, store, html, url, 'module-body');
        if (item.type === 'Page') session.capturedUrls.add(url.split('?')[0]);
      }
    }
  }
}

async function discoverAssignments(session, course, store) {
  if (!session.config.discoverAssignmentsViaCanvasApi) return;
  const assignments = await apiList(session, courseApi(course, 'assignments?include[]=submission&include[]=all_dates&per_page=100'));
  session.metadata.assignments = assignments;
  for (const assignment of assignments) {
    const url = assignment.html_url || `${course.url}/assignments/${assignment.id}`;
    const metadata = {
      assignmentId: assignment.id, dueAt: assignment.due_at, unlockAt: assignment.unlock_at,
      lockAt: assignment.lock_at, allDates: assignment.all_dates || [], points: assignment.points_possible,
      submissionTypes: assignment.submission_types, submission: assignment.submission || null,
      lockedForUser: assignment.locked_for_user, lockExplanation: assignment.lock_explanation
    };
    const html = `<h2>Assignment details (Canvas data)</h2><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>${assignment.description || ''}`;
    await capture(session, store, { id: `assignment:${assignment.id}`, title: assignment.name, html, url, kind: 'assignment', metadata });
    await followContent(session, course, store, assignment.description, url, 'assignment-description');
    session.queue.add(url);
    session.capturedUrls.add(url.split('?')[0]);
  }
}

async function discoverPagesAndDiscussions(session, course, store) {
  const courseDetails = (await apiGet(session, `${new URL(course.url).origin}/api/v1/courses/${course.id}?include[]=syllabus_body`))?.json;
  session.metadata.courseDetails = courseDetails;
  if (courseDetails?.syllabus_body) {
    const url = `${course.url}/assignments/syllabus`;
    await capture(session, store, { id: `syllabus:${course.id}`, title: `${course.name} Syllabus`, html: courseDetails.syllabus_body, url, kind: 'syllabus' });
    await followContent(session, course, store, courseDetails.syllabus_body, url, 'syllabus');
    session.capturedUrls.add(url);
  }
  const pages = await apiList(session, courseApi(course, 'pages?per_page=100'));
  session.metadata.pages = pages;
  for (const p of pages) {
    const detail = (await apiGet(session, courseApi(course, `pages/${encodeURIComponent(p.url)}`)))?.json;
    if (!detail || detail.locked_for_user) continue;
    const url = detail.html_url || `${course.url}/pages/${p.url}`;
    await capture(session, store, { id: `canvas-page:${detail.page_id || detail.url}`, title: detail.title, html: detail.body || '', url, kind: 'canvas-page' });
    await followContent(session, course, store, detail.body, url, 'page-body');
    session.capturedUrls.add(url.split('?')[0]);
  }
  const topics = await apiList(session, courseApi(course, 'discussion_topics?per_page=100'));
  const announcements = await apiList(session, courseApi(course, 'discussion_topics?only_announcements=true&per_page=100'));
  session.metadata.discussions = [...new Map([...topics, ...announcements].map(t => [t.id, t])).values()];
  for (const topic of session.metadata.discussions) {
    const url = topic.html_url || `${course.url}/discussion_topics/${topic.id}`;
    const view = topic.discussion_subentry_count > 0 ? (await apiGet(session, courseApi(course, `discussion_topics/${topic.id}/view?include_new_entries=1`)))?.json : null;
    const replies = [];
    const entries = new Map();
    function visit(entries) {
      for (const entry of entries || []) {
        if (!entry.deleted && entry.message) replies.push(`<p>Reply ${escapeHtml(entry.id)}; ${escapeHtml(entry.created_at)}</p>${entry.message}`);
        visit(entry.replies);
      }
    }
    function collect(items) {
      for (const entry of items || []) {
        entries.set(entry.id, { ...entry, replies: [] });
        collect(entry.replies);
      }
    }
    collect(view?.view);
    collect(view?.new_entries);
    visit([...entries.values()]);
    topic.entries = [...entries.values()];
    topic.capturedReplies = replies.length;
    const html = `<p>Posted: ${escapeHtml(topic.posted_at)}; updated: ${escapeHtml(topic.last_reply_at)}</p>${topic.message || ''}${replies.join('\n')}`;
    await capture(session, store, { id: `discussion:${topic.id}`, title: topic.title, html, url, kind: topic.is_announcement ? 'announcement' : 'discussion' });
    await followContent(session, course, store, html, url, 'discussion-content');
    if (topic.attachments) for (const a of topic.attachments) await download(session, course, store, { href: a.url, text: a.display_name }, 'discussion-attachment', a);
    session.queue.add(url);
    session.capturedUrls.add(url.split('?')[0]);
  }
}

async function crawl(session, course, store) {
  const visited = new Set();
  let count = 0;
  // Sets accept newly discovered entries during iteration: this is a bounded recursive crawl.
  for (const candidate of session.queue) {
    const url = courseLink(candidate, course);
    if (!url || visited.has(url)) continue;
    if (await download(session, course, store, { href: url, text: 'Canvas linked file' }, 'browser-link')) continue;
    if (session.capturedUrls.has(url.split('?')[0])) continue;
    if (count >= session.config.maxPagesPerCourse) {
      session.issues.push({ kind: 'crawl-limit', url, error: `Reached maxPagesPerCourse=${session.config.maxPagesPerCourse}; some pages remain unvisited.` });
      break;
    }
    visited.add(url); count++;
    assertOpen(session.page);
    const result = { courseId: course.id, requestedUrl: url, ok: false };
    try {
      const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
      await session.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      result.url = session.page.url();
      if (!courseLink(result.url, course)) throw new Error('Redirected outside the course (login or unavailable content)');
      const content = await session.page.evaluate(() => {
        const el = document.querySelector('#content') || document.querySelector('main') || document.body;
        return { html: el.innerHTML, text: el.innerText, title: document.title };
      });
      if (/That page has been disabled for this course/i.test(content.text)) {
        result.skipped = 'disabled-course-page';
      } else {
        if (/access denied|unauthorized|you do not have permission/i.test(content.text.slice(0, 800))) throw new Error('Canvas reports access denied');
        result.ok = true; result.title = content.title; result.text = content.text;
        // Read HTML anchors after rendering, including preview=ID file links and folders.
        await followContent(session, course, store, content.html, result.url, 'rendered-page');
        if (!session.capturedUrls.has(result.url.split('?')[0]) && content.text.trim()) {
          const canonical = new URL(result.url);
          canonical.hash = '';
          const id = `web-page:${hash(canonical.toString()).slice(0, 20)}`;
          await capture(session, store, { id, title: content.title, html: content.html, url: result.url, kind: 'canvas-page' });
        }
      }
    } catch (error) {
      assertOpen(session.page);
      result.error = errorText(error);
      session.issues.push({ kind: 'page', url, error: result.error });
    }
    session.pages.push(result);
  }
  console.log(`  Browser pages: ${count}; downloaded attachments: ${session.downloaded.size}.`);
}

async function report(snapshot) {
  const latest = path.join(canvasDir, 'data/state/latest.json');
  await writeJson(latest, snapshot);
  await writeJson(path.join(canvasDir, 'data/raw-snapshots', `${snapshot.startedAt.replace(/[:.]/g, '-')}.json`), snapshot);
  const lines = ['# Canvas Sync Report', '', `Status: ${snapshot.status}`, `Finished: ${snapshot.finishedAt}`, '', 'This reports collection, not agent review or calendar completeness.', ''];
  for (const c of snapshot.courseResults) {
    lines.push(`## ${c.name}`, '', `Status: ${c.status}; sources: ${c.sources}; new: ${c.new ?? 0}; updated: ${c.updated ?? 0}; unchanged: ${c.unchanged ?? 0}.`, `Files listing: ${c.filesListed ?? 'not finished'} records; folders: ${c.foldersListed ?? 'not finished'}.`, '');
    for (const issue of c.issues) lines.push(`- ${issue.kind}: ${issue.error}${issue.url ? ` (${issue.url})` : ''}`);
    lines.push('');
  }
  for (const c of snapshot.courses.filter(course => !snapshot.courseResults.some(result => result.id === course.id))) {
    lines.push(`## ${c.name}`, '', 'Not collected yet in this run.', '');
  }
  for (const issue of snapshot.issues) lines.push(`- ${issue.kind}: ${issue.error}`);
  await atomicWrite(path.join(canvasDir, 'exports/sync-report.md'), lines.join('\n') + '\n');
}

async function migrateOnly(config) {
  const latest = await readJson(path.join(canvasDir, 'data/state/latest.json'), { courses: [] });
  for (const course of latest.courses) {
    const store = new SourceStore(root, course, null, config);
    await store.init();
    await store.save('migration-only');
    console.log(`Migrated ${course.name}: ${store.records.size} sources, prior notes preserved in legacy archive.`);
  }
  for (const name of ['upcoming.md', 'files.md', 'notes.md', 'changes.md']) {
    const file = path.join(canvasDir, 'exports', name);
    if (await exists(file)) {
      const archived = path.join(canvasDir, 'data/legacy/exports', `${Date.now()}-${name}`);
      await fs.mkdir(path.dirname(archived), { recursive: true });
      await fs.rename(file, archived);
    }
  }
}

async function main() {
  const config = { ...defaults, ...await readJson(arg('--config') || path.join(canvasDir, 'config/config.json'), {}) };
  config.baseUrl = (arg('--base-url') || config.baseUrl).replace(/\/$/, '');
  if (!Array.isArray(config.termInclude) || !config.termInclude.length) throw new Error('termInclude must contain the intended Canvas term, e.g. 2026W1_V.');
  if (process.argv.includes('--migrate-only')) return migrateOnly(config);
  let context, renderBrowser, parser, session, store;
  const snapshot = { schemaVersion: 2, startedAt: stamp(), status: 'in-progress', courses: [], courseResults: [], issues: [], pages: [], downloads: [] };
  try {
    context = await chromium.launchPersistentContext(path.join(canvasDir, '.browser-profile'), { headless: Boolean(config.headless), acceptDownloads: true });
    const page = context.pages()[0] || await context.newPage();
    session = { context, page, config, issues: snapshot.issues };
    snapshot.courses = await discoverCourses(session, config);
    renderBrowser = await chromium.launch({ headless: true });
    parser = await renderBrowser.newPage({ javaScriptEnabled: false });
    await parser.route('**/*', route => route.abort());
    const renderer = new PdfRenderer(renderBrowser, context.request, new URL(config.baseUrl).origin, config.downloadMaxBytes);
    for (const course of snapshot.courses) {
      console.log(`Collecting ${course.name}`);
      session = { context, page, config, parser, renderer, issues: [], downloaded: new Set(), failedDownloads: new Set(),
        queue: new Set(['', '/files', '/modules', '/assignments', '/assignments/syllabus', '/announcements', '/discussion_topics', '/pages', '/quizzes'].map(route => course.url + route)),
        capturedUrls: new Set(), metadata: {}, pages: snapshot.pages, downloads: snapshot.downloads };
      store = new SourceStore(root, course, renderer, config);
      await store.init();
      await discoverFiles(session, course, store);
      await discoverModules(session, course, store);
      await discoverAssignments(session, course, store);
      await discoverPagesAndDiscussions(session, course, store);
      await crawl(session, course, store);
      for (const record of store.records.values()) {
        await store.convert(record);
        if (record.conversion === 'needs-conversion') session.issues.push({ kind: 'conversion', id: record.id, error: record.conversionReason });
      }
      const status = session.issues.length ? 'partial' : 'complete';
      await writeJson(path.join(store.dir, 'canvas-metadata.json'), { course, syncedAt: stamp(), ...session.metadata });
      await store.save(status, session.issues);
      const records = [...store.records.values()];
      snapshot.courseResults.push({ id: course.id, name: course.name, status, sources: records.length,
        filesListed: session.metadata.files?.length || 0, foldersListed: session.metadata.folders?.length || 0,
        ...Object.fromEntries(['new', 'updated', 'unchanged'].map(change => [change, records.filter(r => store.seen.has(r.id) && r.change === change).length])), issues: session.issues });
      // Checkpoint after each course so completed work survives later failures.
      snapshot.finishedAt = stamp();
      await report(snapshot);
      store = null;
    }
    snapshot.status = snapshot.issues.length || snapshot.courseResults.some(c => c.status !== 'complete') ? 'partial' : 'complete';
  } catch (error) {
    snapshot.status = 'interrupted';
    snapshot.issues.push({ kind: 'fatal', error: errorText(error) });
    if (store) {
      await store.save('interrupted', [...session.issues, { kind: 'fatal', error: errorText(error) }]);
      snapshot.courseResults.push({ id: store.course.id, name: store.course.name, status: 'interrupted', sources: store.records.size, issues: session.issues });
    }
    console.error(errorText(error));
  } finally {
    snapshot.finishedAt = stamp();
    try { await report(snapshot); }
    finally {
      if (context) await context.close().catch(() => {});
      if (renderBrowser) await renderBrowser.close().catch(() => {});
    }
  }
  console.log(`Sync ${snapshot.status}. See canvas/exports/sync-report.md. Sources collected; agent review is a separate step.`);
  if (snapshot.status !== 'complete') process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });

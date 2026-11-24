#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const canvasDir = path.resolve(__dirname, '..');
const outDir = path.join(canvasDir, 'data', 'diagnostics', new Date().toISOString().replace(/[:.]/g, '-'));
const baseUrl = process.argv.includes('--base-url') ? process.argv[process.argv.indexOf('--base-url') + 1] : 'https://canvas.ubc.ca';

async function ensureDir(dir) { await fs.mkdir(dir, { recursive: true }); }
async function writeJson(name, data) { await fs.writeFile(path.join(outDir, name), JSON.stringify(data, null, 2) + '\n', 'utf8'); }
async function writeText(name, text) { await fs.writeFile(path.join(outDir, name), text, 'utf8'); }

async function waitForLogin(page) {
  await page.goto(new URL('/courses', baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  console.log('Log in if needed. Waiting until Canvas course links are visible...');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const count = await page.locator('a[href*="/courses/"]').count().catch(() => 0);
    if (count > 0) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('Timed out waiting for Canvas login/course links.');
}

async function collectPage(page, name) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  const data = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map(a => ({
      text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
      href: a.href,
      aria: a.getAttribute('aria-label'),
      title: a.getAttribute('title'),
      classes: a.className?.toString?.() || '',
      closest: a.closest('tr, li, [role="row"], .ig-row, .context_module_item, .assignment, .course-list-table-row, .ic-DashboardCard')?.outerHTML?.slice(0, 3000) || ''
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"]')).slice(0, 200).map(b => ({
      text: (b.textContent || b.value || '').replace(/\s+/g, ' ').trim(),
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      classes: b.className?.toString?.() || '',
      outer: b.outerHTML.slice(0, 1200)
    }));
    const modules = Array.from(document.querySelectorAll('.context_module, [class*="module" i], .ig-row, .context_module_item')).slice(0, 100).map(el => ({
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      classes: el.className?.toString?.() || '',
      outer: el.outerHTML.slice(0, 2500)
    }));
    return {
      url: location.href,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 12000) || '',
      links,
      buttons,
      modules
    };
  });
  await writeJson(`${name}.json`, data);
  await writeText(`${name}.txt`, data.bodyText);
  console.log(`Saved ${name}: ${data.url}`);
  return data;
}

async function main() {
  await ensureDir(outDir);
  const context = await chromium.launchPersistentContext(path.join(canvasDir, '.browser-profile'), {
    headless: false,
    acceptDownloads: true
  });
  const page = context.pages()[0] || await context.newPage();
  await waitForLogin(page);
  const coursesPage = await collectPage(page, 'courses');

  const courseLinks = coursesPage.links
    .filter(l => /\/courses\/\d+/.test(l.href))
    .map(l => ({ id: l.href.match(/\/courses\/(\d+)/)?.[1], text: l.text, href: l.href, aria: l.aria, title: l.title, closest: l.closest }))
    .filter((l, i, arr) => l.id && arr.findIndex(x => x.id === l.id) === i);
  await writeJson('course-links.json', courseLinks);

  const firstCourse = courseLinks[0];
  if (!firstCourse) throw new Error('No course links found after login.');
  const routes = [
    ['home', `/courses/${firstCourse.id}`],
    ['modules', `/courses/${firstCourse.id}/modules`],
    ['assignments', `/courses/${firstCourse.id}/assignments`],
    ['files', `/courses/${firstCourse.id}/files`],
    ['syllabus', `/courses/${firstCourse.id}/assignments/syllabus`],
    ['announcements', `/courses/${firstCourse.id}/announcements`]
  ];
  for (const [name, route] of routes) {
    await page.goto(new URL(route, baseUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log(`Could not load ${name}: ${e.message}`));
    await collectPage(`course-${name}`);
  }
  await writeText('README.txt', `Diagnostics saved in ${outDir}\nFirst inspected course: ${JSON.stringify(firstCourse, null, 2)}\n`);
  console.log(`Diagnostics saved in ${outDir}`);
  await context.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

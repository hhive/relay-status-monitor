import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveDocumentTitle, findThemeStylesheet, renderDocsPage, renderMarkdownWithOutline } from '../src/lib/docs-render';

test('renderMarkdownWithOutline renders the markdown structures the old regex renderer dropped', () => {
  const { html } = renderMarkdownWithOutline([
    '1. 第一步',
    '2. 第二步',
    '',
    '- 无序项',
    '',
    '**粗体** 与 `行内代码` 与 *斜体*',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> 引用',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '---',
  ].join('\n'));
  assert.match(html, /<ol>\s*<li>第一步<\/li>\s*<li>第二步<\/li>\s*<\/ol>/);
  assert.match(html, /<ul>\s*<li>无序项<\/li>\s*<\/ul>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<code>行内代码<\/code>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<table>[\s\S]*<th>列A<\/th>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /<hr>/);
});

test('renderMarkdownWithOutline keeps inline formatting inside headings and adds unique anchors', () => {
  const { html, outline } = renderMarkdownWithOutline('# **加粗**标题\n\n## 重复\n\n## 重复\n');
  assert.match(html, /<h1 id="[^"]+"><strong>加粗<\/strong>标题<\/h1>/);
  assert.doesNotMatch(html, /\*\*/);
  assert.deepEqual(outline.map((item) => item.depth), [0, 1, 1]);
  assert.deepEqual(outline.map((item) => item.text), ['加粗标题', '重复', '重复']);
  assert.equal(new Set(outline.map((item) => item.id)).size, 3);
});

test('deriveDocumentTitle prefers the first heading and falls back to the first text line', () => {
  assert.equal(deriveDocumentTitle('# 标题\n\n正文', '兜底'), '标题');
  assert.equal(deriveDocumentTitle('小逆中转操作说明\n\n正文', '兜底'), '小逆中转操作说明');
  assert.equal(deriveDocumentTitle('![图](/docs/a.png)\n\n---\n', '兜底'), '兜底');
});

test('findThemeStylesheet resolves the hashed VitePress stylesheet and tolerates a missing build', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-assets-'));
  assert.equal(await findThemeStylesheet(path.join(dir, 'missing')), null);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'app.Dr3FVB50.js'), '');
  await writeFile(path.join(dir, 'assets', 'style.CDxiQf8X.css'), '');
  assert.equal(await findThemeStylesheet(path.join(dir, 'assets')), 'style.CDxiQf8X.css');
});

test('renderDocsPage builds a sidebar shell that reuses the VitePress stylesheet when present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-page-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'style.CDxiQf8X.css'), '');
  const page = await renderDocsPage({
    markdown: '# 章节一\n\n内容\n\n# 章节二\n\n内容\n\n# 章节三\n\n内容\n',
    title: '操作说明',
    assetsDir: path.join(dir, 'assets'),
  });
  assert.match(page, /<title>操作说明<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="\.\/assets\/style\.CDxiQf8X\.css">/);
  assert.match(page, /<article class="vp-doc">/);
  assert.match(page, /class="doc-sidebar"/);
  assert.match(page, /<nav class="doc-outline"/);
  // The VitePress guide/API/deployment entries carry no synced content and were removed.
  assert.doesNotMatch(page, /doc-sitenav/);
  assert.doesNotMatch(page, /\/docs\/(guide|api|ops)\//);
  assert.match(page, /class="doc-lightbox"/);
  assert.match(page, /class="doc-theme-toggle"/);
  assert.match(page, /<a href="#[^"]+"/);
});

test('renderDocsPage emits an inline script that parses as valid JavaScript', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-script-'));
  const page = await renderDocsPage({ markdown: '# A\n\n# B\n\n# C\n', title: 'T', assetsDir: path.join(dir, 'assets') });
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'page must contain an inline script');
  assert.doesNotMatch(script, /<\/script>/);
  assert.doesNotThrow(() => new Function(script));
});

test('renderDocsPage drops the sidebar when the document has too few headings to navigate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monitor-docs-flat-'));
  const page = await renderDocsPage({ markdown: '# 只有一个标题\n\n正文', title: '简短文档', assetsDir: path.join(dir, 'assets') });
  assert.doesNotMatch(page, /class="doc-sidebar"/);
  assert.doesNotMatch(page, /class="doc-outline"/);
  assert.match(page, /<article class="vp-doc">/);
});

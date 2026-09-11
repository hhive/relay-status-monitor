import { readdir } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';

/** Markdown renderer shared by every synced/imported document page. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

// External links keep the isolation the hand-rolled renderer used to add.
const renderLinkOpen = markdown.renderer.rules.link_open
  ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const href = tokens[index].attrGet('href');
  if (typeof href === 'string' && /^https?:\/\//.test(href)) {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noreferrer noopener');
  }
  return renderLinkOpen(tokens, index, options, env, self);
};

export interface DocsOutlineItem {
  id: string;
  text: string;
  /** Heading depth normalised so the shallowest heading in the document is 0. */
  depth: number;
}

export interface RenderedDocs {
  html: string;
  outline: DocsOutlineItem[];
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function plainText(value: string): string {
  return decodeEntities(markdown.renderInline(value).replace(/<[^>]*>/g, '')).trim();
}

function slugify(value: string): string {
  const slug = plainText(value).toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/**
 * Render markdown to HTML while collecting a heading outline.
 * Heading ids are assigned on the token stream so anchors stay stable even for
 * headings nested inside blockquotes or list items.
 */
export function renderMarkdownWithOutline(source: string): RenderedDocs {
  const tokens = markdown.parse(source, {});
  const raw: Array<{ id: string; text: string; level: number }> = [];
  const used = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const inline = tokens[index + 1]?.content ?? '';
    const base = slugify(inline);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    token.attrSet('id', id);
    raw.push({ id, text: plainText(inline), level: Number(token.tag.slice(1)) });
  }
  const shallowest = raw.reduce((min, item) => Math.min(min, item.level), 6);
  return {
    html: markdown.renderer.render(tokens, markdown.options, {}),
    outline: raw.map((item) => ({ id: item.id, text: item.text, depth: item.level - shallowest })),
  };
}

/** Resolve the hashed VitePress theme stylesheet shipped alongside the docs. */
export async function findThemeStylesheet(assetsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(assetsDir);
    return entries.filter((name) => /^style\..+\.css$/.test(name)).sort()[0] ?? null;
  } catch {
    return null;
  }
}

/** First heading, else first non-empty line, used as the document title. */
export function deriveDocumentTitle(source: string, fallback: string): string {
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^!\[/.test(trimmed) || trimmed === '---') continue;
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    const candidate = plainText(heading ? heading[1] : trimmed);
    if (candidate) return candidate.slice(0, 60);
  }
  return fallback;
}

const LAYOUT_CSS = [
  '*{box-sizing:border-box}',
  'body{background:var(--vp-c-bg,#fff)}',
  '.doc-shell{display:flex;align-items:flex-start;max-width:1440px;margin:0 auto}',
  '.doc-sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;flex:0 0 268px;width:268px;padding:24px 16px 40px;border-right:1px solid var(--vp-c-divider,#e5e7eb)}',
  '.doc-brand{font-weight:600;font-size:15px;padding:0 8px 12px;color:var(--vp-c-text-1,#1f2937);word-break:break-word}',
  '.doc-outline{display:flex;flex-direction:column;font-size:13px;line-height:1.5}',
  '.doc-outline a{display:block;padding:5px 8px;border-radius:6px;color:var(--vp-c-text-2,#4b5563);text-decoration:none;border-left:2px solid transparent}',
  '.doc-outline a:hover{color:var(--vp-c-brand-1,#3451b2);background:var(--vp-c-bg-soft,#f2f3f5)}',
  '.doc-outline a.is-active{color:var(--vp-c-brand-1,#3451b2);border-left-color:var(--vp-c-brand-1,#3451b2);font-weight:500}',
  '.doc-sidebar-footer{margin-top:24px;padding:12px 8px 0;border-top:1px solid var(--vp-c-divider,#e5e7eb)}',
  '.doc-theme-toggle{font-size:13px;padding:4px 10px;border-radius:8px;border:1px solid var(--vp-c-divider,#e5e7eb);background:transparent;color:var(--vp-c-text-2,#4b5563);cursor:pointer}',
  '.doc-main{flex:1;min-width:0;padding:40px 40px 96px}',
  '.doc-main .vp-doc{max-width:760px;margin:0 auto}',
  '.doc-main .vp-doc p>img{max-width:640px;width:100%;height:auto;cursor:zoom-in}',
  '.doc-menu-toggle{display:none}',
  '.doc-lightbox{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;overflow:auto}',
  '.doc-lightbox[hidden]{display:none}',
  '.doc-lightbox img{max-width:none;background:#fff;border-radius:6px}',
  'body.doc-locked{overflow:hidden}',
  '@media (max-width:959px){',
  '.doc-sidebar{position:fixed;top:0;left:0;z-index:60;background:var(--vp-c-bg,#fff);transform:translateX(-100%);transition:transform .2s ease;box-shadow:0 0 24px rgba(0,0,0,.12)}',
  '.doc-sidebar.is-open{transform:translateX(0)}',
  '.doc-main{padding:24px 20px 72px}',
  '.doc-menu-toggle{display:inline-block;position:sticky;top:12px;z-index:50;margin-bottom:12px;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--vp-c-divider,#e5e7eb);background:var(--vp-c-bg,#fff);color:var(--vp-c-text-1,#1f2937);cursor:pointer}',
  '}',
].join('');

const FALLBACK_CSS = [
  '.vp-doc{font-size:16px;line-height:1.75;color:var(--vp-c-text-1,#1f2937)}',
  '.vp-doc h1{font-size:28px;margin:0 0 20px;padding-bottom:14px;border-bottom:1px solid var(--vp-c-divider,#e5e7eb)}',
  '.vp-doc h2{font-size:22px;margin:40px 0 14px;padding-top:20px;border-top:1px solid var(--vp-c-divider,#e5e7eb)}',
  '.vp-doc h3{font-size:19px;margin:28px 0 10px}',
  '.vp-doc h4,.vp-doc h5,.vp-doc h6{font-size:17px;margin:24px 0 8px}',
  '.vp-doc p{margin:12px 0}',
  '.vp-doc ul,.vp-doc ol{padding-left:24px;margin:12px 0}',
  '.vp-doc li{margin:4px 0}',
  '.vp-doc a{color:#2563eb;text-decoration:none}',
  '.vp-doc a:hover{text-decoration:underline}',
  '.vp-doc code{background:var(--vp-c-bg-soft,#f2f3f5);border-radius:4px;padding:2px 5px;font-size:.9em}',
  '.vp-doc pre{background:var(--vp-c-bg-soft,#f2f3f5);border-radius:8px;padding:16px;overflow:auto}',
  '.vp-doc pre code{background:none;padding:0}',
  '.vp-doc blockquote{margin:16px 0;padding:1px 16px;border-left:3px solid var(--vp-c-divider,#e5e7eb);color:var(--vp-c-text-2,#4b5563)}',
  '.vp-doc table{border-collapse:collapse;margin:16px 0;display:block;overflow-x:auto}',
  '.vp-doc th,.vp-doc td{border:1px solid var(--vp-c-divider,#e5e7eb);padding:8px 12px;text-align:left}',
  '.vp-doc hr{border:none;border-top:1px solid var(--vp-c-divider,#e5e7eb);margin:28px 0}',
].join('');

const THEME_SCRIPT = [
  '(function(){',
  'var root=document.documentElement;',
  'var stored=null;try{stored=localStorage.getItem("docs-theme");}catch(e){}',
  'var prefers=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;',
  'function apply(theme){root.classList.toggle("dark",theme==="dark");}',
  'apply(stored||(prefers?"dark":"light"));',
  'var themeToggle=document.querySelector(".doc-theme-toggle");',
  'if(themeToggle){themeToggle.addEventListener("click",function(){var next=root.classList.contains("dark")?"light":"dark";apply(next);try{localStorage.setItem("docs-theme",next);}catch(e){}});}',
  'var sidebar=document.querySelector(".doc-sidebar");',
  'var menuToggle=document.querySelector(".doc-menu-toggle");',
  'if(menuToggle&&sidebar){menuToggle.addEventListener("click",function(){sidebar.classList.toggle("is-open");});}',
  'var headings=[].slice.call(document.querySelectorAll(".vp-doc h1[id],.vp-doc h2[id],.vp-doc h3[id],.vp-doc h4[id],.vp-doc h5[id],.vp-doc h6[id]"));',
  'var links=[].slice.call(document.querySelectorAll(".doc-outline a"));',
  'function targetId(link){try{return decodeURIComponent(link.getAttribute("href").slice(1));}catch(e){return "";}}',
  'function highlight(){',
  'if(!headings.length)return;',
  'var current=null;',
  'for(var i=0;i<headings.length;i++){if(headings[i].getBoundingClientRect().top<=120){current=headings[i].id;}else{break;}}',
  'links.forEach(function(link){link.classList.toggle("is-active",current!==null&&targetId(link)===current);});',
  'var active=document.querySelector(".doc-outline a.is-active");',
  'if(active&&sidebar){var linkRect=active.getBoundingClientRect();var barRect=sidebar.getBoundingClientRect();',
  'if(linkRect.top<barRect.top+16){sidebar.scrollTop-=(barRect.top+16-linkRect.top);}',
  'else if(linkRect.bottom>barRect.bottom-16){sidebar.scrollTop+=(linkRect.bottom-barRect.bottom+16);}}',
  '}',
  'var queued=false;',
  'function onScroll(){if(queued)return;queued=true;window.requestAnimationFrame(function(){queued=false;highlight();});}',
  'window.addEventListener("scroll",onScroll,{passive:true});',
  'window.addEventListener("resize",onScroll);',
  'highlight();',
  'var overlay=document.querySelector(".doc-lightbox");',
  'var overlayImage=overlay?overlay.querySelector("img"):null;',
  'function closeLightbox(){if(!overlay||overlay.hidden)return;overlay.hidden=true;if(overlayImage)overlayImage.removeAttribute("src");document.body.classList.remove("doc-locked");}',
  'if(overlay&&overlayImage){',
  'overlay.addEventListener("click",closeLightbox);',
  'document.addEventListener("keydown",function(event){if(event.key==="Escape")closeLightbox();});',
  '[].slice.call(document.querySelectorAll(".vp-doc p>img")).forEach(function(image){',
  'image.addEventListener("click",function(){overlayImage.src=image.src;overlayImage.alt=image.alt||"";overlay.hidden=false;document.body.classList.add("doc-locked");});',
  '});',
  '}',
  '})();',
].join('');

function renderOutline(outline: DocsOutlineItem[]): string {
  if (outline.length < 3) return '';
  const items = outline.map((item) => {
    const indent = item.depth > 0 ? `padding-left:${8 + item.depth * 14}px` : '';
    return `<a href="#${escapeHtml(item.id)}"${indent ? ` style="${indent}"` : ''}>${escapeHtml(item.text)}</a>`;
  }).join('');
  return `<nav class="doc-outline" aria-label="本页目录">${items}</nav>`;
}

export interface RenderDocsPageOptions {
  markdown: string;
  title: string;
  /** Directory holding the built VitePress assets, used to reuse its theme CSS. */
  assetsDir: string;
}

/**
 * Build the standalone HTML page served for a synced or imported document.
 * Layout, outline and lightbox are self-contained; typography is reused from the
 * VitePress build output when it is available next to the page.
 */
export async function renderDocsPage(options: RenderDocsPageOptions): Promise<string> {
  const { html, outline } = renderMarkdownWithOutline(options.markdown);
  const stylesheet = await findThemeStylesheet(options.assetsDir);
  const themeLink = stylesheet ? `<link rel="stylesheet" href="./assets/${encodeURIComponent(stylesheet)}">` : '';
  const title = escapeHtml(options.title);
  const outlineNav = renderOutline(outline);
  const sidebar = outlineNav
    ? `<aside class="doc-sidebar"><div class="doc-brand">${title}</div>`
      + `${outlineNav}`
      + `<div class="doc-sidebar-footer"><button type="button" class="doc-theme-toggle">切换主题</button></div></aside>`
    : '';
  const menuToggle = outlineNav ? '<button type="button" class="doc-menu-toggle">目录</button>' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + `${themeLink}<style>${FALLBACK_CSS}${LAYOUT_CSS}</style></head><body>`
    + `<div class="doc-shell">${sidebar}<main class="doc-main">${menuToggle}`
    + `<article class="vp-doc">${html}</article></main></div>`
    + `<div class="doc-lightbox" hidden><img alt=""></div>`
    + `<script>${THEME_SCRIPT}</script></body></html>`;
}

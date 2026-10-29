#!/usr/bin/env node
// 站内链接与本地资源检查：确认引用的页面、图片、脚本、样式、音效等文件都在仓库里，且大小写完全一致
// （Cloudflare Pages 区分大小写，Windows 本地不区分，容易漏）。只查站内，不查外链（http/https、//、mailto: 等跳过）。
// 扫描范围：
//   - HTML 标签属性 href / src / poster / data-src / srcset，以及指向本站（环境变量 SITE_URL）的绝对地址；
//   - HTML 里的 <script type="importmap"> 本地映射；
//   - CSS 文件和 HTML 内联 <style> / style="" 里的 url(...)、@import；
//   - JS 文件与 HTML 内联脚本里的相对 import / export from / import()，以及以 /assets/ 开头的带扩展名字符串。
// 解析规则按 Cloudflare Pages：/foo 可对应 foo、foo.html 或 foo/index.html；_redirects 里的来源路径视为有效。
// 以 git 跟踪的文件为准（没 git add 的文件不会上线，也算不存在）。
// 用法：node scripts/check-links.mjs
import fs from 'node:fs';
import path from 'node:path';
import { trackedFiles, lineOf, report, finish, blankOut } from './check-lib.mjs';

const SITE = (process.env.SITE_URL || 'https://flarepanel.invalid').replace(/\/+$/, '');
const tracked = new Set(trackedFiles());
const trackedLower = new Map();
for (const f of tracked) trackedLower.set(f.toLowerCase(), f);
const trackedDirsLower = new Map();
for (const f of tracked) {
  const parts = f.split('/');
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join('/');
    trackedDirsLower.set(d.toLowerCase(), d);
  }
}

// 归档文章不对外提供，跳过
const keep = (f) => !f.startsWith('posts/_archive/');
const htmlFiles = trackedFiles('*.html').filter(keep);
const cssFiles = trackedFiles('*.css').filter(keep);
// 本仓库没有带占位地址的模板
const templates = new Set();
const jsFiles = trackedFiles('*.js', '*.mjs').filter(keep)
  // 第三方库原样保留，不扫描其中的字符串
  .filter((f) => !f.startsWith('assets/libs/'));

// _redirects 里明确写出的来源路径（不含通配）视为有效
const redirectSources = new Set();
if (fs.existsSync('_redirects')) {
  for (const line of fs.readFileSync('_redirects', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const src = t.split(/\s+/)[0];
    if (!src.includes('*')) redirectSources.add(src);
  }
}

// 由 Worker / Functions 处理的动态路径，不对应静态文件
const dynamicPrefixes = ['/api/', '/cdn-cgi/'];

const skip = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$|<)/i;

/** 返回 null 表示存在；否则返回问题说明 */
function resolveTarget(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { rel = urlPath; }
  rel = path.posix.normalize(rel).replace(/^\/+/, '');
  if (rel.startsWith('..')) return '路径跳出了网站根目录';
  const cands = rel === '' || rel === '.' ? ['index.html']
    : rel.endsWith('/') ? [rel + 'index.html']
    : [rel, rel + '.html', rel + '/index.html'];
  if (cands.some((c) => tracked.has(c))) return null;
  for (const c of cands) {
    const real = trackedLower.get(c.toLowerCase());
    if (real) return `大小写不一致，仓库里是 ${real}`;
  }
  const dir = trackedDirsLower.get(rel.replace(/\/$/, '').toLowerCase());
  if (dir && dir !== rel.replace(/\/$/, '')) return `大小写不一致，仓库里是 ${dir}/`;
  return '文件不存在';
}

let checked = 0;
function checkRef(file, text, index, raw, baseDir) {
  raw = raw.trim();
  if (!raw) return;
  if (raw.startsWith(SITE + '/') || raw === SITE) {
    if (templates.has(file)) return;
    raw = raw.slice(SITE.length) || '/';
  }
  if (skip.test(raw)) return;
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return;
  const abs = clean.startsWith('/') ? clean : '/' + path.posix.join(baseDir, clean);
  if (dynamicPrefixes.some((p) => abs.startsWith(p))) return;
  if (redirectSources.has(abs) || redirectSources.has(abs.replace(/\/$/, ''))) return;
  checked++;
  const problem = resolveTarget(abs);
  if (problem) report(file, lineOf(text, index), `${raw}  → ${problem}`);
}

const cssUrlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
function scanCss(file, text, css, offset, baseDir) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of stripped.matchAll(cssUrlRe)) {
    checkRef(file, text, offset + m.index, m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '', baseDir);
  }
}

const importRe = /(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?(["'])([^"'\n]+)\1|\bimport\s*\(\s*(["'])([^"'\n]+)\3\s*\)/gm;
const assetStrRe = /(["'`])(\/assets\/[^"'`\s$]+?\.(?:png|jpe?g|webp|gif|svg|ico|mp3|ogg|wav|m4a|mp4|webm|json|css|js|mjs|woff2?|ttf|otf|glb|gltf|txt|wasm))\1/gi;
function stripJsComments(js) {
  // 粗略去掉 /* */ 和行首 // 注释，避免把注释里的示例路径当成引用
  return js.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}
function scanJs(file, text, js, offset, baseDir) {
  const code = stripJsComments(js);
  for (const m of code.matchAll(importRe)) {
    const spec = m[2] ?? m[4];
    if (!/^(\.{1,2}\/|\/)/.test(spec)) continue; // 裸模块名交给 importmap
    const idx = offset + m.index + m[0].indexOf(spec);
    checkRef(file, text, idx, spec, baseDir);
  }
  for (const m of code.matchAll(assetStrRe)) checkRef(file, text, offset + m.index, m[2], baseDir);
}

const attrRe = /\s(href|src|poster|data-src|srcset|content|style)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
for (const file of htmlFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const baseDir = path.posix.dirname(file);
  // 标签属性：去掉脚本、样式和注释里的内容，避免把 JS 字符串当链接
  const html = blankOut(text);
  for (const m of html.matchAll(attrRe)) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? '';
    const valIdx = m.index + m[0].indexOf(val);
    if (name === 'srcset') {
      for (const part of val.split(',')) checkRef(file, text, valIdx, part.trim().split(/\s+/)[0] || '', baseDir);
    } else if (name === 'content') {
      // 只看 og:image 等写成本站绝对地址的 meta
      if (val.startsWith(SITE + '/')) checkRef(file, text, valIdx, val, baseDir);
    } else if (name === 'style') {
      scanCss(file, text, val, valIdx, baseDir);
    } else {
      checkRef(file, text, valIdx, val, baseDir);
    }
  }
  const noComments = blankOut(text, { scripts: false, styles: false });
  // 内联 <style>
  for (const m of noComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    scanCss(file, text, m[1], m.index + m[0].indexOf('>') + 1, baseDir);
  }
  // 内联 <script>：importmap 与 JS
  for (const m of noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const body = m[2];
    const off = m.index + m[0].indexOf('>') + 1;
    if (/type\s*=\s*["']?importmap/i.test(attrs)) {
      let map;
      try { map = JSON.parse(body); } catch { report(file, lineOf(text, off), 'importmap 不是合法 JSON'); continue; }
      const targets = [...Object.values(map.imports || {}), ...Object.values(map.scopes || {}).flatMap((s) => Object.values(s))];
      for (const t of targets) {
        if (typeof t !== 'string') continue;
        const idx = off + Math.max(0, body.indexOf(t));
        // 以 / 结尾的前缀映射只查目录是否存在
        if (t.endsWith('/') && !/^[a-z]+:|^\/\//i.test(t)) {
          const abs = t.startsWith('/') ? t : '/' + path.posix.join(baseDir, t);
          const d = path.posix.normalize(abs).replace(/^\/+|\/+$/g, '');
          checked++;
          if (!trackedDirsLower.has(d.toLowerCase())) report(file, lineOf(text, idx), `importmap ${t}  → 目录不存在`);
          else if (trackedDirsLower.get(d.toLowerCase()) !== d) report(file, lineOf(text, idx), `importmap ${t}  → 大小写不一致，仓库里是 ${trackedDirsLower.get(d.toLowerCase())}/`);
        } else checkRef(file, text, idx, t, baseDir);
      }
    } else if (!/type\s*=\s*["']?(?:application\/(?:ld\+)?json|text\/(?:template|html|plain))/i.test(attrs)) {
      scanJs(file, text, body, off, baseDir);
    }
  }
}

for (const file of cssFiles) {
  const text = fs.readFileSync(file, 'utf8');
  scanCss(file, text, text, 0, path.posix.dirname(file));
}

for (const file of jsFiles) {
  const text = fs.readFileSync(file, 'utf8');
  scanJs(file, text, text, 0, path.posix.dirname(file));
}

finish(
  `已检查 ${htmlFiles.length} 个 HTML、${cssFiles.length} 个 CSS、${jsFiles.length} 个 JS 文件里的 ${checked} 处站内引用，全部有效且大小写一致`,
  '站内链接 / 本地资源检查发现问题',
);

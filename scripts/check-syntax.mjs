#!/usr/bin/env node
// 配置与样式文件语法检查（只查能否解析，不查风格）：
//   json  — *.json 严格 JSON；*.jsonc 与 tsconfig.json 允许注释和尾逗号
//   xml   — *.xml（含 sitemap.xml）、*.svg 是否为格式良好的 XML
//   toml  — *.toml（wrangler.toml 等），用 smol-toml 解析
//   css   — *.css 文件和 HTML 里的 <style> 块，用 postcss 解析（未闭合的大括号/字符串、多余的 } 等）
// 用法：node scripts/check-syntax.mjs [json|xml|toml|css ...]   不带参数时全部检查
// 依赖：npm ci --prefix scripts/ci
import fs from 'node:fs';
import { trackedFiles, loadDep, lineOf, report, finish } from './check-lib.mjs';

const skipArchive = (f) => !f.startsWith('posts/_archive/');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');

// ---------- JSON ----------
function stripJsonc(src) {
  // 去掉注释（保留字符串内容与换行），再去掉 } ] 前的尾逗号
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      out += src[i] ?? '';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

// JSON.parse 有些报错不带位置（如 "Unexpected token ']'"），这里用一个最小的递归下降解析器找出第一个出错的偏移
function jsonErrorOffset(src) {
  let i = 0;
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i])) i++; };
  const fail = () => { throw i; };
  const lit = (w) => { if (src.startsWith(w, i)) i += w.length; else fail(); };
  function str() {
    if (src[i] !== '"') fail();
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src.charCodeAt(i) < 0x20) fail();
      if (src[i] === '\\') {
        i++;
        if (src[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) fail(); i += 5; continue; }
        if (!'"\\/bfnrt'.includes(src[i] ?? 'x')) fail();
      }
      i++;
    }
    if (src[i] !== '"') fail();
    i++;
  }
  function num() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) fail();
    i += m[0].length;
  }
  function value() {
    ws();
    const c = src[i];
    if (c === '{') {
      i++; ws();
      if (src[i] === '}') { i++; return; }
      for (;;) { ws(); str(); ws(); if (src[i] !== ':') fail(); i++; value(); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return; } fail(); }
    } else if (c === '[') {
      i++; ws();
      if (src[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === ']') { i++; return; } fail(); }
    } else if (c === '"') str();
    else if (c === 't') lit('true');
    else if (c === 'f') lit('false');
    else if (c === 'n') lit('null');
    else num();
  }
  try { value(); ws(); if (i < src.length) fail(); return -1; } catch (pos) { return typeof pos === 'number' ? pos : -1; }
}

function checkJson() {
  const files = trackedFiles('*.json', '*.jsonc', '*.webmanifest').filter(skipArchive);
  for (const f of files) {
    let src = read(f);
    const lenient = f.endsWith('.jsonc') || /(^|\/)tsconfig[^/]*\.json$/.test(f);
    if (lenient) src = stripJsonc(src);
    try {
      JSON.parse(src);
    } catch (e) {
      const m = /line (\d+)/.exec(e.message);
      const pos = /position (\d+)/.exec(e.message);
      let line = m ? +m[1] : pos ? lineOf(src, +pos[1]) : 0;
      if (!line) { const off = jsonErrorOffset(src); if (off >= 0) line = lineOf(src, off); }
      report(f, line, `JSON 语法错误：${e.message.replace(/, (?:\.\.\.)?"[\s\S]*" is not valid JSON$/, '').split('\n')[0]}`);
    }
  }
  return files.length;
}

// ---------- XML ----------
const nameRe = /^[A-Za-z_:\u00C0-\uFFFF][\w.\-:\u00B7\u00C0-\uFFFF]*$/;
function xmlError(src) {
  // 返回 [偏移, 说明] 或 null
  const stack = [];
  let i = 0, roots = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const text = src.slice(i, lt < 0 ? n : lt);
    if (stack.length === 0 && text.trim()) return [i, '根元素之外出现了文本'];
    if (/&/.test(text)) {
      const re = /&([^;\s&<]*)(;?)/g; let m;
      while ((m = re.exec(text))) {
        const ok = m[2] && (/^(amp|lt|gt|quot|apos)$/.test(m[1]) || /^#\d+$/.test(m[1]) || /^#x[0-9a-f]+$/i.test(m[1]));
        if (!ok) return [i + m.index, `非法的 & 实体「${m[0].slice(0, 20)}」（裸 & 需写成 &amp;）`];
      }
    }
    if (lt < 0) break;
    i = lt;
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4); if (e < 0) return [i, '注释没有闭合']; i = e + 3; continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i); if (e < 0) return [i, 'CDATA 没有闭合']; i = e + 3; continue;
    }
    if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i); if (e < 0) return [i, '处理指令没有闭合']; i = e + 2; continue;
    }
    if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
      let depth = 0, j = i;
      for (; j < n; j++) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; else if (src[j] === '>' && depth <= 0) break; }
      if (j >= n) return [i, 'DOCTYPE 没有闭合']; i = j + 1; continue;
    }
    // 标签：按引号扫描到 >
    let j = i + 1, q = null;
    for (; j < n; j++) {
      const c = src[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '<') return [j, '标签里出现了未转义的 <'];
      else if (c === '>') break;
    }
    if (j >= n) return [i, '标签没有闭合'];
    const tag = src.slice(i, j + 1);
    if (tag[1] === '/') {
      const name = tag.slice(2, -1).trim();
      const top = stack.pop();
      if (top !== name) return [i, top ? `结束标签 </${name}> 与开始标签 <${top}> 不匹配` : `多余的结束标签 </${name}>`];
    } else {
      const selfClose = tag.endsWith('/>');
      const inner = tag.slice(1, selfClose ? -2 : -1);
      const nm = /^[^\s/>]+/.exec(inner);
      if (!nm || !nameRe.test(nm[0])) return [i, `非法的标签名「${tag.slice(0, 30)}」`];
      let rest = inner.slice(nm[0].length);
      const seen = new Set();
      const attrRe = /^\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/;
      while (rest.trim()) {
        const a = attrRe.exec(rest);
        if (!a) return [i, `<${nm[0]}> 的属性写法有误（属性值必须加引号）：「${rest.trim().slice(0, 30)}」`];
        if (seen.has(a[1])) return [i, `<${nm[0]}> 有重复属性 ${a[1]}`];
        seen.add(a[1]);
        const v = a[3] ?? a[4];
        if (v.includes('<')) return [i, `属性 ${a[1]} 的值里有未转义的 <`];
        const em = /&([^;\s&<]*)(;?)/g; let m;
        while ((m = em.exec(v))) {
          const ok = m[2] && (/^(amp|lt|gt|quot|apos)$/.test(m[1]) || /^#\d+$/.test(m[1]) || /^#x[0-9a-f]+$/i.test(m[1]));
          if (!ok) return [i, `属性 ${a[1]} 里有非法的 & 实体（裸 & 需写成 &amp;）`];
        }
        rest = rest.slice(a[0].length);
      }
      if (stack.length === 0) { roots++; if (roots > 1) return [i, '出现了第二个根元素']; }
      if (!selfClose) stack.push(nm[0]);
    }
    i = j + 1;
  }
  if (stack.length) return [n, `标签 <${stack[stack.length - 1]}> 没有闭合`];
  if (!roots) return [0, '没有根元素'];
  return null;
}

function checkXml() {
  const files = trackedFiles('*.xml', '*.svg').filter(skipArchive);
  for (const f of files) {
    const src = read(f);
    const err = xmlError(src);
    if (err) report(f, lineOf(src, err[0]), `XML 格式错误：${err[1]}`);
  }
  return files.length;
}

// ---------- TOML ----------
function checkToml() {
  const { parse } = loadDep('smol-toml');
  const files = trackedFiles('*.toml').filter(skipArchive);
  for (const f of files) {
    try { parse(read(f)); } catch (e) {
      report(f, e.line || 0, `TOML 语法错误：${String(e.message).split('\n')[0]}`);
    }
  }
  return files.length;
}

// ---------- CSS ----------
function checkCss() {
  const postcss = loadDep('postcss');
  const tryParse = (css, f, lineBase) => {
    try { postcss.parse(css, { from: f }); } catch (e) {
      if (!e.reason) throw e;
      report(f, (e.line || 1) + lineBase, `CSS 解析错误：${e.reason}`);
    }
  };
  const cssFiles = trackedFiles('*.css').filter(skipArchive);
  for (const f of cssFiles) tryParse(read(f), f, 0);
  // HTML 内联 <style>
  const htmlFiles = trackedFiles('*.html').filter(skipArchive);
  let blocks = 0;
  for (const f of htmlFiles) {
    const html = read(f).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
    let m;
    while ((m = re.exec(html))) {
      blocks++;
      const start = m.index + m[0].indexOf('>') + 1;
      tryParse(m[1], f, lineOf(html, start) - 1);
    }
  }
  return `${cssFiles.length} 个 CSS 文件 + ${blocks} 个内联 <style>`;
}

const all = { json: checkJson, xml: checkXml, toml: checkToml, css: checkCss };
const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all);
const summary = [];
for (const k of which) {
  if (!all[k]) { console.error(`未知检查项：${k}（可选：${Object.keys(all).join(' ')}）`); process.exit(2); }
  summary.push(`${k}: ${all[k]()}`);
}
finish(`语法检查通过（${summary.join('；')}）`, '语法检查发现问题');

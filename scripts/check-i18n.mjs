// 界面多语言检查（CI 用）：
//   1. assets/js/i18n/zh.js 和 en.js 的词条键完全一致，且同一词条两种语言的 {占位符} 一致；
//   2. JS 里用到的词条（'命名空间.键' 形式的字符串）和 HTML 里 data-i18n* 属性引用的词条都存在；
//   3. 词典里没被用到的词条只提示，不算错。
// 用法：node scripts/check-i18n.mjs
// 只用 Node 自带模块，不需要 npm 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackedFiles, report, finish } from './check-lib.mjs';

const root = process.cwd();
const { zh } = await import(pathToFileURL(path.join(root, 'assets/js/i18n/zh.js')).href);
const { en } = await import(pathToFileURL(path.join(root, 'assets/js/i18n/en.js')).href);

const zhKeys = Object.keys(zh);
const enKeys = new Set(Object.keys(en));
for (const k of zhKeys) if (!enKeys.has(k)) report('assets/js/i18n/en.js', 0, `缺少词条：${k}`);
for (const k of enKeys) if (!(k in zh)) report('assets/js/i18n/zh.js', 0, `缺少词条：${k}`);

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
for (const k of zhKeys) {
  if (k in en && placeholders(zh[k]) !== placeholders(en[k])) {
    report('assets/js/i18n/en.js', 0, `词条 ${k} 的占位符和中文不一致：zh {${placeholders(zh[k])}} / en {${placeholders(en[k])}}`);
  }
}

const namespaces = new Set(zhKeys.map(k => k.split('.')[0]));
const used = new Set();

// JS：'ns.key' / "ns.key" 形式的字符串
const jsFiles = trackedFiles('assets/js/*.js', 'assets/js/**/*.js').filter(f => !f.startsWith('assets/js/i18n/'));
for (const file of jsFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/['"]([a-z][A-Za-z0-9]*)\.([A-Za-z0-9]+)['"]/g)) {
      if (!namespaces.has(m[1])) continue;
      const key = `${m[1]}.${m[2]}`;
      used.add(key);
      if (!(key in zh)) report(file, i + 1, `词条不存在：${key}`);
    }
  });
}

// HTML：data-i18n、data-i18n-html、data-i18n-title、data-i18n-placeholder、data-i18n-aria-label、data-i18n-content
for (const file of trackedFiles('*.html')) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
      used.add(m[1]);
      if (!(m[1] in zh)) report(file, i + 1, `词条不存在：${m[1]}`);
    }
  });
}

const unused = zhKeys.filter(k => !used.has(k));
if (unused.length) console.log(`提示：${unused.length} 个词条没有被直接引用（可能是拼接使用）：${unused.join(', ')}`);

finish(`多语言检查通过（${zhKeys.length} 个词条，中英文键一致）`, '多语言检查发现问题');

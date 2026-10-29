// JS 语法检查（CI 用）：
//   1. git 跟踪的所有 .js / .mjs / .cjs 文件检查语法；
//   2. HTML 里的内联 <script>（普通脚本、type="module"）也检查语法，type="application/ld+json" 等检查 JSON 格式。
// 用法：node scripts/check-js.mjs
// 为什么不直接 node --check：Node 22 对 .js 里的 ES 模块语法错误，node --check 会直接放过（自动识别模块时退出码仍是 0），
// 所以这里把代码从 stdin 喂给 node，先按看起来更像的那种（普通脚本 / 模块）检查，不通过再换另一种，两种都不通过才算错。
// 只用 Node 自带模块，不需要 npm 依赖。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import { trackedFiles, report, finish, lineOf, blankOut, parseAttrs } from './check-lib.mjs';

function nodeCheck(code, inputType) {
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '--check'], { input: code, encoding: 'utf8' });
  if (r.status === 0) return null;
  const err = r.stderr || '';
  const m = /\[stdin\]:(\d+)/.exec(err);
  const msg = (/^\w*Error: .*$/m.exec(err) || [err.trim().split('\n').pop()])[0];
  // 把出错那一行代码也带上，方便直接定位
  const block = err.split('\n').slice(1, 3).join(' | ').trim();
  return { line: m ? Number(m[1]) : 1, msg: block ? `${msg}  →  ${block}` : msg };
}

const looksLikeModule = (code) => /^\s*(?:import\s*[\w{*'"]|export\s)/m.test(code) || /\bimport\.meta\b/.test(code);

// 先按看起来更像的那种检查，不通过再换另一种；都不通过时报第一种的错误
function checkSource(code, preferModule) {
  const first = preferModule ? 'module' : 'commonjs';
  const second = preferModule ? 'commonjs' : 'module';
  const e1 = nodeCheck(code, first);
  if (!e1) return null;
  return nodeCheck(code, second) ? e1 : null;
}

// 1. 独立 JS 文件
const jsFiles = trackedFiles('*.js', '*.mjs', '*.cjs');
for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  let err;
  if (file.endsWith('.mjs')) err = nodeCheck(code, 'module');
  else if (file.endsWith('.cjs')) err = nodeCheck(code, 'commonjs');
  else err = checkSource(code, looksLikeModule(code));
  if (err) report(file, err.line, `JS 语法错误：${err.msg}`);
}

// 2. HTML 内联脚本（HTML 注释里的 <script> 不算）
const JS_TYPES = ['', 'text/javascript', 'application/javascript', 'javascript'];
const JSON_TYPES = ['application/ld+json', 'importmap', 'application/json', 'speculationrules'];
const htmlFiles = trackedFiles('*.html', '*.htm');
let inline = 0;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  // 注释范围：先把 script/style 内容抹掉再找，免得脚本里的 "<!--" 字符串被当成注释
  const comments = [];
  const masked = blankOut(html, { scripts: true, styles: true, comments: false });
  for (const m of masked.matchAll(/<!--[\s\S]*?-->/g)) comments.push([m.index, m.index + m[0].length]);
  const inComment = (pos) => comments.some(([a, b]) => pos >= a && pos < b);

  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (inComment(m.index)) continue;
    const attrs = parseAttrs(`<script${m[1]}>`);
    if ('src' in attrs) continue;
    const code = m[2];
    if (!code.trim()) continue;
    const type = (attrs.type || '').trim().toLowerCase();
    const offset = lineOf(html, m.index + m[0].indexOf('>') + 1) - 1;
    if (JSON_TYPES.includes(type)) {
      inline++;
      try { JSON.parse(code); } catch (e) {
        const pos = /position (\d+)/.exec(e.message);
        const line = pos ? code.slice(0, Number(pos[1])).split('\n').length : 1;
        const brief = e.message.replace(/\s+/g, ' ').slice(0, 160);
        report(file, offset + line, `<script type="${type}"> 里的 JSON 格式错误${pos ? '' : '（行号为这段脚本的起点）'}：${brief}`);
      }
      continue;
    }
    if (type === 'module') {
      inline++;
      const err = nodeCheck(code, 'module');
      if (err) report(file, offset + err.line, `内联 <script type="module"> 语法错误：${err.msg}`);
      continue;
    }
    if (!JS_TYPES.includes(type)) continue; // 模板等非 JS 内容
    inline++;
    // 普通脚本按经典脚本解析：里面写 import / export 浏览器会报错，这里也会报
    try {
      new vm.Script(code, { filename: file });
    } catch (e) {
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lm = new RegExp(`${esc}:(\\d+)`).exec(e.stack || '');
      report(file, offset + (lm ? Number(lm[1]) : 1), `内联 <script> 语法错误：${e.name}: ${e.message}`);
    }
  }
}

finish(`JS 语法检查通过：${jsFiles.length} 个 JS 文件，${inline} 段内联脚本`, 'JS 语法检查发现问题');

// 体检脚本共用的小工具：列出仓库文件、输出错误（GitHub Actions 下带文件/行号注解）、加载 scripts/ci 里的固定版本依赖。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** git 跟踪的文件（-z 避免中文文件名被转义），可传 pathspec */
export function trackedFiles(...specs) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...specs], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/** 加载 scripts/ci/node_modules 里的依赖；没装时给出安装提示 */
export function loadDep(name) {
  const req = createRequire(path.join(here, 'ci', 'package.json'));
  try {
    return req(name);
  } catch {
    console.error(`缺少依赖 ${name}，请先运行：npm ci --prefix scripts/ci`);
    process.exit(2);
  }
}

/** 由字符偏移算行号（1 起） */
export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const gha = !!process.env.GITHUB_ACTIONS;
let errorCount = 0;

/** 报告一个问题：本地输出 文件:行  说明；Actions 里同时打 ::error 注解 */
export function report(file, line, msg) {
  errorCount++;
  const loc = line ? `${file}:${line}` : file;
  console.log(`${loc}  ${msg}`);
  if (gha) {
    const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const props = [`file=${esc(file).replace(/,/g, '%2C').replace(/:/g, '%3A')}`];
    if (line) props.push(`line=${line}`);
    console.log(`::error ${props.join(',')}::${esc(msg)}`);
  }
}

/** 收尾：有问题就以 1 退出 */
export function finish(okMsg, failMsg) {
  if (errorCount) {
    console.log(`\n${failMsg}（共 ${errorCount} 处）`);
    process.exit(1);
  }
  console.log(okMsg);
}

/** 把 HTML 里的注释、<script>、<style> 内容抹成空格（保留换行，行号不变） */
export function blankOut(html, { scripts = true, styles = true, comments = true } = {}) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  if (comments) html = html.replace(/<!--[\s\S]*?-->/g, blank);
  const tags = [scripts && 'script', styles && 'style'].filter(Boolean);
  if (tags.length) {
    const re = new RegExp(`<(${tags.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
    html = html.replace(re, (m) => {
      const open = m.match(/^<[^>]*>/)[0];
      const close = m.match(/<\/[^>]*>$/)[0];
      return open + blank(m.slice(open.length, m.length - close.length)) + close;
    });
  }
  return html;
}

/** 解析一个标签字符串里的属性，返回小写属性名 → 值 */
export function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const body = tag.replace(/^<[^\s>]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(body))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

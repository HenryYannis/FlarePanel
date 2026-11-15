#!/usr/bin/env node
// 仓库卫生检查：
//   conflict — 文本文件里不能残留合并冲突标记（行首 <<<<<<< / ======= / >>>>>>> / |||||||）；
//   size     — 单个文件不能超过 25 MiB（Cloudflare Pages 单文件上限）；
//   version  — 版本号单一真值（lib/version.js，禁止在前端或各接口硬编码散落）。
// 用法：node scripts/check-repo.mjs [conflict|size|version ...]   不带参数时全部检查
import fs from 'node:fs';
import { trackedFiles, report, finish } from './check-lib.mjs';

const MAX = 25 * 1024 * 1024;
const files = trackedFiles();

function checkConflict() {
  // <<<<<<< 和 >>>>>>> 后面是分支名或行尾；======= 必须独占一整行
  const re = /^(?:<{7}(?: .*)?|>{7}(?: .*)?|={7}|\|{7}(?: .*)?)\r?$/;
  let n = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf.subarray(0, 8000).includes(0)) continue; // 二进制文件
    n++;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((l, i) => {
      if (re.test(l)) report(f, i + 1, `残留合并冲突标记：${l.trim().slice(0, 40)}`);
    });
  }
  return `${n} 个文本文件无冲突标记`;
}

function checkSize() {
  let biggest = ['', 0];
  for (const f of files) {
    const { size } = fs.statSync(f);
    if (size > biggest[1]) biggest = [f, size];
    if (size > MAX) report(f, 0, `文件 ${(size / 1048576).toFixed(1)} MiB，超过 Cloudflare Pages 单文件 25 MiB 上限`);
  }
  return `最大文件 ${biggest[0]}（${(biggest[1] / 1048576).toFixed(2)} MiB）`;
}

function checkVersion() {
  const vPath = 'lib/version.js';
  if (!fs.existsSync(vPath)) {
    report(vPath, 0, '缺失版本号唯一真值文件 lib/version.js');
    return '版本号真值检查失败';
  }
  const content = fs.readFileSync(vPath, 'utf8');
  const m = /export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/.exec(content);
  if (!m || !/^\d+\.\d+\.\d+$/.test(m[1])) {
    report(vPath, 0, `lib/version.js 中的 VERSION (${m ? m[1] : 'null'}) 不是合法的 SemVer 格式（如 1.0.1）`);
    return '版本号格式不合规';
  }
  const curM = /export\s+const\s+CURRENT_VERSION\s*=\s*(?:`v\$\{VERSION\}`|['"]v[^'"]+['"])/.exec(content);
  if (!curM) {
    report(vPath, 0, 'lib/version.js 必须导出 CURRENT_VERSION = `v${VERSION}`');
  }

  // 检查 functions/api/version.js 是否正确引用 lib/version.js
  const apiVersionPath = 'functions/api/version.js';
  if (fs.existsSync(apiVersionPath)) {
    const apiContent = fs.readFileSync(apiVersionPath, 'utf8');
    if (!apiContent.includes('../../lib/version.js') || /const\s+CURRENT_VERSION\s*=\s*['"]v\d+\.\d+\.\d+['"]/.test(apiContent)) {
      report(apiVersionPath, 0, 'functions/api/version.js 必须从 lib/version.js 导入 CURRENT_VERSION，不得硬编码版本号');
    }
  }

  // 检查 assets/js/app.js 是否存在硬编码的旧版本兜底
  const appJsPath = 'assets/js/app.js';
  if (fs.existsSync(appJsPath)) {
    const appContent = fs.readFileSync(appJsPath, 'utf8');
    if (/['"]v\d+\.\d+\.\d+['"]/.test(appContent)) {
      report(appJsPath, 0, 'assets/js/app.js 存在硬编码版本号，必须通过 /api/version 动态获取');
    }
  }

  return `版本号唯一真值统一（v${m[1]}，lib/version.js）`;
}

const all = { conflict: checkConflict, size: checkSize, version: checkVersion };
const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all);
const summary = [];
for (const k of which) {
  if (!all[k]) { console.error(`未知检查项：${k}（可选：${Object.keys(all).join(' ')}）`); process.exit(2); }
  summary.push(all[k]());
}
finish(`仓库卫生检查通过（${summary.join('；')}）`, '仓库卫生检查发现问题');

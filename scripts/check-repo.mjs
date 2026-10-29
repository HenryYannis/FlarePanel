#!/usr/bin/env node
// 仓库卫生检查：
//   conflict — 文本文件里不能残留合并冲突标记（行首 <<<<<<< / ======= / >>>>>>> / |||||||）；
//   size     — 单个文件不能超过 25 MiB（Cloudflare Pages 单文件上限）。
// 用法：node scripts/check-repo.mjs [conflict|size ...]   不带参数时全部检查
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

const all = { conflict: checkConflict, size: checkSize };
const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(all);
const summary = [];
for (const k of which) {
  if (!all[k]) { console.error(`未知检查项：${k}（可选：${Object.keys(all).join(' ')}）`); process.exit(2); }
  summary.push(all[k]());
}
finish(`仓库卫生检查通过（${summary.join('；')}）`, '仓库卫生检查发现问题');

#!/usr/bin/env node
// Cloudflare Pages 配置文件格式校验：_redirects、_headers、_routes.json。
// 规则照搬 Cloudflare 官方解析器（cloudflare/workers-sdk 的 workers-shared/utils/configuration/
// parseRedirects.ts、parseHeaders.ts、validateURL.ts）：凡是官方解析器会判为无效、部署时被忽略的行，这里都报错。
// 文档：https://developers.cloudflare.com/pages/configuration/redirects/
//       https://developers.cloudflare.com/pages/configuration/headers/
//       https://developers.cloudflare.com/pages/functions/routing/#create-a-_routesjson-file
// 用法：node scripts/check-pages-config.mjs
import fs from 'node:fs';
import { report, finish } from './check-lib.mjs';

const PERMITTED_STATUS_CODES = new Set([200, 301, 302, 303, 307, 308]);
const MAX_LINE_LENGTH = 2000;
const MAX_HEADER_RULES = 100;
const MAX_DYNAMIC_REDIRECT_RULES = 100;
const MAX_STATIC_REDIRECT_RULES = 2000;
const SPLAT_REGEX = /\*/g;
const PLACEHOLDER_REGEX = /:[A-Za-z]\w*/g;
const URL_REGEX = /^https:\/\/+(?<host>[^/]+)\/?(?<path>.*)/;

function extractPathname(p = '/', includeSearch, includeHash) {
  if (!p.startsWith('/')) p = `/${p}`;
  const url = new URL(`//${p}`, 'relative://');
  return `${url.pathname}${includeSearch ? url.search : ''}${includeHash ? url.hash : ''}`;
}

function validateUrl(token, onlyRelative = false, disallowPorts = false, includeSearch = false, includeHash = false) {
  const host = URL_REGEX.exec(token);
  if (host && host.groups && host.groups.host) {
    if (onlyRelative) return [undefined, `来源只能写相对路径，不能写绝对地址 ${token}`];
    if (disallowPorts && /.*:\d+$/.test(host.groups.host)) return [undefined, `不支持写端口：${token}`];
    return [`https://${host.groups.host}${extractPathname(host.groups.path, includeSearch, includeHash)}`, undefined];
  }
  if (!token.startsWith('/') && onlyRelative) token = `/${token}`;
  if (token.startsWith('/')) {
    try { return [extractPathname(token, includeSearch, includeHash), undefined]; } catch { return [undefined, `无法解析 URL ${token}`]; }
  }
  return [undefined, onlyRelative ? '路径必须以 / 开头' : '地址必须以 / 开头（相对路径）或 https:// 开头'];
}
const urlHasHost = (t) => { const h = URL_REGEX.exec(t); return Boolean(h && h.groups && h.groups.host); };

// ---------- _redirects ----------
let redirectCount = 0;
function checkRedirects(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seen = new Set();
  let staticRules = 0, dynamicRules = 0, canCreateStatic = true;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    const ln = i + 1;
    if (!line || line.startsWith('#')) continue;
    if (line.length > MAX_LINE_LENGTH) { report(file, ln, `单行超过 ${MAX_LINE_LENGTH} 字符，会被忽略`); continue; }
    const tokens = line.replace(/\s+#.*$/, '').split(/\s+/);
    if (tokens.length < 2 || tokens.length > 3) { report(file, ln, `每行应为「来源 目标 [状态码]」2～3 段，实际 ${tokens.length} 段：${line}`); continue; }
    const [from0, to0, status0 = '302'] = tokens;
    const [from, fromErr] = validateUrl(from0, true, true, false, false);
    if (fromErr) { report(file, ln, fromErr); continue; }
    if (canCreateStatic && !from.match(SPLAT_REGEX) && !from.match(PLACEHOLDER_REGEX)) {
      if (++staticRules > MAX_STATIC_REDIRECT_RULES) { report(file, ln, `静态规则超过 ${MAX_STATIC_REDIRECT_RULES} 条上限，会被忽略`); continue; }
    } else {
      canCreateStatic = false;
      if (++dynamicRules > MAX_DYNAMIC_REDIRECT_RULES) { report(file, ln, `动态规则超过 ${MAX_DYNAMIC_REDIRECT_RULES} 条上限，其后全部被忽略`); break; }
    }
    if ((from.match(SPLAT_REGEX) || []).length > 1) { report(file, ln, `来源里只能有一个 *：${from0}`); continue; }
    const [to, toErr] = validateUrl(to0, false, false, true, true);
    if (toErr) { report(file, ln, toErr); continue; }
    const status = Number(status0);
    if (Number.isNaN(status) || !PERMITTED_STATUS_CODES.has(status)) {
      report(file, ln, `状态码只能是 200、301、302（默认）、303、307、308，实际 ${status0}，Cloudflare 会忽略这一行：${line}`);
      continue;
    }
    if (!urlHasHost(to) && ((from.endsWith('/*') && /\/index(.html)?$/.test(to)) || (from.endsWith('/') && /\/index(.html)?$/.test(to)))) {
      report(file, ln, `会造成无限重定向，Cloudflare 会忽略这一行：${line}`); continue;
    }
    if (seen.has(from)) { report(file, ln, `来源 ${from} 重复，后面这条会被忽略`); continue; }
    seen.add(from);
    if (status === 200 && urlHasHost(to)) { report(file, ln, `200 代理只能指向站内相对路径：${to}`); continue; }
    if (/:splat\b/.test(to) && !from.includes('*')) report(file, ln, `目标用了 :splat，但来源里没有 *：${line}`);
    for (const ph of to.match(PLACEHOLDER_REGEX) || []) {
      if (ph !== ':splat' && !(from.match(PLACEHOLDER_REGEX) || []).includes(ph)) report(file, ln, `目标用了占位符 ${ph}，但来源里没有定义：${line}`);
    }
    redirectCount++;
  }
}

// ---------- _headers ----------
let headerRuleCount = 0;
function checkHeaders(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const isPath = /^([^\s]+:\/\/|^\/)/;
  let rule = null, skipUntilNextPath = false;
  const closeRule = () => {
    if (!rule) return;
    if (rule.count > 0) headerRuleCount++;
    else report(file, rule.ln, `路径 ${rule.path} 下面没有任何头部，这条规则无效`);
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] || '';
    const line = raw.trim();
    const ln = i + 1;
    if (!line || line.startsWith('#')) continue;
    if (line.length > MAX_LINE_LENGTH) { report(file, ln, `单行超过 ${MAX_LINE_LENGTH} 字符，会被忽略`); continue; }
    if (isPath.test(line)) {
      skipUntilNextPath = false;
      closeRule();
      rule = null;
      if (headerRuleCount >= MAX_HEADER_RULES) { report(file, ln, `规则超过 ${MAX_HEADER_RULES} 条上限，其后全部被忽略`); break; }
      const [p, err] = validateUrl(line, false, true);
      if (err) { report(file, ln, err); skipUntilNextPath = true; continue; }
      const wc = (p.match(SPLAT_REGEX) || []).length;
      if (wc > 1) { report(file, ln, `一条规则只能有一个 *：${p}`); skipUntilNextPath = true; continue; }
      if (wc > 0 && /:splat(?!\w)/.test(p)) { report(file, ln, `* 不能和 :splat 同时使用：${p}`); skipUntilNextPath = true; continue; }
      rule = { path: p, ln, count: 0 };
      continue;
    }
    if (skipUntilNextPath) continue;
    if (!/^\s/.test(raw)) report(file, ln, `头部行应缩进写在路径下面：${line}`);
    if (!line.includes(':')) {
      if (!rule) report(file, ln, '这一行前面缺少以 / 开头的路径');
      else if (line.startsWith('! ')) rule.count++;
      else report(file, ln, `头部应写成「名称: 值」：${line}`);
      continue;
    }
    const [rawName, ...rest] = line.split(':');
    const name = rawName.trim();
    const value = rest.join(':').trim();
    if (name.includes(' ')) { report(file, ln, `头部名称不能有空格：${name}`); continue; }
    if (!name) { report(file, ln, '缺少头部名称'); continue; }
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) { report(file, ln, `头部名称含非法字符：${name}`); continue; }
    if (!value) { report(file, ln, `头部 ${name} 没有值`); continue; }
    if (!rule) { report(file, ln, `头部 ${name} 前面缺少路径`); continue; }
    rule.count++;
  }
  closeRule();
}

// ---------- _routes.json ----------
function checkRoutes(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { report(file, 0, `不是合法 JSON：${e.message}`); return; }
  if (data.version !== 1) report(file, 0, `version 必须是 1，实际 ${JSON.stringify(data.version)}`);
  const inc = data.include, exc = data.exclude ?? [];
  if (!Array.isArray(inc) || inc.length === 0) report(file, 0, 'include 必须是非空数组');
  if (!Array.isArray(exc)) report(file, 0, 'exclude 必须是数组');
  const all = [...(Array.isArray(inc) ? inc : []), ...(Array.isArray(exc) ? exc : [])];
  if (all.length > 100) report(file, 0, `include + exclude 共 ${all.length} 条，超过 100 条上限`);
  for (const r of all) {
    if (typeof r !== 'string' || !r.startsWith('/')) report(file, 0, `规则必须是以 / 开头的字符串：${JSON.stringify(r)}`);
    else if (r.length > 100) report(file, 0, `规则超过 100 字符：${r}`);
  }
  for (const k of Object.keys(data)) if (!['version', 'include', 'exclude', 'description'].includes(k)) report(file, 0, `未知字段 ${k}`);
}

const done = [];
if (fs.existsSync('_redirects')) { checkRedirects('_redirects'); done.push(`_redirects ${redirectCount} 条有效规则`); }
if (fs.existsSync('_headers')) { checkHeaders('_headers'); done.push(`_headers ${headerRuleCount} 条规则`); }
if (fs.existsSync('_routes.json')) { checkRoutes('_routes.json'); done.push('_routes.json'); }
finish(`Pages 配置格式正确（${done.join('；') || '无配置文件'}）`, 'Pages 配置格式有问题');

// ============================================
// Cloudflare Pages Functions - 内部文件拦截中间件
// pages_build_output_dir 是 "."，仓库根目录整个被当成静态站发布，
// 不拦的话 /README.md、/wrangler.jsonc、/.gitignore、/schema.sql 都能直接下载。
// ============================================

function notFound() {
  return new Response('404 Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  // 先解码再判断：静态文件服务会解码路径，不解码的话 /%41GENTS.md 这类写法能绕过拦截
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch (e) {
    return notFound();
  }
  // 再合并连续斜杠：静态文件服务把 //wrangler.jsonc 当成 /wrangler.jsonc 返回，不合并的话能绕过拦截
  path = path.replace(/\/{2,}/g, '/');
  const lower = path.toLowerCase();

  // /api/* 交给各自的 Functions，不在这里拦
  if (lower.startsWith('/api/')) {
    return context.next();
  }

  // 内部目录（现在没有，以后加了也不会被发布出去）
  const blockedPrefixes = ['/docs/', '/scripts/', '/workers/', '/lib/', '/node_modules/'];

  // 根目录内部配置文件
  const blockedFiles = ['/agents.md', '/_headers', '/_routes.json', '/package.json', '/package-lock.json'];

  const blocked =
    // 任意一段以 . 开头：.gitignore、.git/、.wrangler/、.dev.vars 等点文件
    lower.split('/').some(seg => seg.startsWith('.')) ||
    // wrangler.jsonc / wrangler.toml / wrangler.json 等
    /^\/wrangler\.[^/]*$/.test(lower) ||
    blockedFiles.includes(lower) ||
    blockedPrefixes.some(prefix => lower.startsWith(prefix)) ||
    // 文档和本地脚本：.md、.command（启动本地预览.command）、.sh
    lower.endsWith('.md') ||
    lower.endsWith('.command') ||
    lower.endsWith('.sh') ||
    lower.endsWith('.sql');

  if (blocked) {
    return notFound();
  }

  return context.next();
}

// ====================================================
// FlarePanel 配置文件：部署前只需要改这一个文件
// 站点顺序就是后台里站点按钮的顺序
// ====================================================

export const PANEL = {
    // 后台标题（浏览器标签和顶部导航栏）
    title: 'FlarePanel',
    // 在后台回复评论时显示的昵称
    adminName: '站长',
    // 浏览量统计里的页面分类（按网址前缀匹配，没匹配上的归入「其他页面」）
    // 某个站点想用自己的分类，在站点里写 viewTypes 覆盖
    viewTypes: [
        { key: 'posts', label: '文章', prefixes: ['/posts/'] },
        { key: 'tools', label: '工具', prefixes: ['/tools/'] }
    ],
    // 浏览量统计里不显示的页面：网址里含这些关键词就跳过，例如 ['/docs', '/drafts']
    viewExcludes: []
};

// 每个站点一项。用不到的资源留空字符串即可，对应栏目会自动隐藏该站点。
export const SITES = [
    {
        // 站点显示名
        name: '示例站点',
        // 站点网址：评论和浏览量里的相对路径会拼成这个网址的链接
        url: 'https://example.com',
        // D1 数据库名（不是 ID）：存 comments、article_views、file_downloads 三张表
        commentDb: 'example-comment',
        // D1 数据库名：存 users 表（站点没有会员系统就留空）
        accountDb: 'example-account',
        // R2 存储桶名（不用文件管理就留空）
        bucket: 'example-assets',
        // 存储桶绑定的公开域名（用于复制文件链接和快速读取，没有就留空）
        filesDomain: 'https://files.example.com',
        // AI 网关日志里这个站点的 site_id（不用 AI Hub 就留空）
        aiSiteId: ''
    }
];

// AI Hub：需要配套的 AI 网关 Worker（OpenAI 兼容接口 + KV 配置），没有就保持 enabled: false，后台不显示这个栏目
export const AI_HUB = {
    enabled: false,
    // 网关地址，以 /v1 结尾，例如 https://ai.example.com/v1
    gatewayUrl: '',
    // 网关读取配置的 KV 命名空间 ID
    kvNamespaceId: '',
    // KV 里配置的键名
    configKey: 'AI_GATEWAY_CONFIG'
};

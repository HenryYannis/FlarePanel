/**
 * 统一胶囊切换（Capsule Tabs）
 * 用法：容器加 class="capsule-tabs" data-capsule-tabs，按钮作为直接子元素，选中按钮带 .active。
 * 页面原有的切换逻辑只需照常切换 .active，滑块会自动跟随。
 * 之后动态插入页面的胶囊条会被自动接管，也可手动调用 window.initCapsuleTabs(元素)。
 * 整块重新渲染的胶囊条可给 data-capsule-tabs 一个名字（如 data-capsule-tabs="ai-subtabs"），
 * 新渲染出来的滑块会从上一次的位置滑到新位置。
 */
(function () {
    'use strict';

    const lastIndexByName = new Map(); // 按名字记住上一次选中的位置

    function initCapsuleTabs(bar) {
        if (!bar || bar.__capsuleTabs) return;
        bar.__capsuleTabs = true;

        let indicator = bar.querySelector(':scope > .capsule-tabs-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'capsule-tabs-indicator';
            indicator.setAttribute('aria-hidden', 'true');
            bar.prepend(indicator);
        }

        const getButtons = () => Array.from(bar.children).filter(el => el !== indicator);
        const getActiveIndex = () => getButtons().findIndex(el => el.classList.contains('active'));

        const name = bar.dataset.capsuleTabs;

        const place = () => {
            const btn = getButtons()[getActiveIndex()];
            if (!btn || !btn.offsetWidth) {
                indicator.style.opacity = '0';
                return;
            }
            const firstTime = indicator.style.opacity !== '1';
            if (firstTime) indicator.style.transition = 'none'; // 首次出现直接定位，不播放滑动
            indicator.style.width = `${btn.offsetWidth}px`;
            indicator.style.height = `${btn.offsetHeight}px`;
            indicator.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
            indicator.style.opacity = '1';
            if (firstTime) {
                void indicator.offsetWidth;
                indicator.style.transition = '';
            }
            if (name) lastIndexByName.set(name, getActiveIndex());
        };

        const lastIndex = getActiveIndex();

        // 同名胶囊条被整块重新渲染：先停在上一次的位置，再滑到当前选中项
        const previous = name ? getButtons()[lastIndexByName.get(name)] : null;
        if (previous && lastIndexByName.get(name) !== lastIndex && previous.offsetWidth) {
            indicator.style.transition = 'none';
            indicator.style.width = `${previous.offsetWidth}px`;
            indicator.style.height = `${previous.offsetHeight}px`;
            indicator.style.transform = `translate(${previous.offsetLeft}px, ${previous.offsetTop}px)`;
            indicator.style.opacity = '1';
            void indicator.offsetWidth;
            indicator.style.transition = '';
        }

        new MutationObserver(place).observe(bar, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class']
        });

        // 胶囊条从隐藏变为显示、字体加载完成或窗口缩放时重新定位
        if (window.ResizeObserver) {
            new ResizeObserver(place).observe(bar);
        } else {
            window.addEventListener('resize', place);
        }
        place();
    }

    function initAll() {
        document.querySelectorAll('[data-capsule-tabs]').forEach(initCapsuleTabs);
        // 接管之后由 JS 渲染出来的胶囊条（例如排盘结果、后台子页面）
        new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches('[data-capsule-tabs]')) initCapsuleTabs(node);
                    node.querySelectorAll('[data-capsule-tabs]').forEach(initCapsuleTabs);
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.initCapsuleTabs = initCapsuleTabs;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAll);
    } else {
        initAll();
    }
})();

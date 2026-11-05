/**
 * 客户端 bundle 契约测试（离线，不需要浏览器/React/DSH）。
 *
 * 假造运行时的两个入口：`window.__ModuleLoader__.load` 与 `require('react')`，
 * 断言：id 等于包名、factory 惰性、只 require 平台 seed 模块、槽位注册正确、
 * 面板能渲染出标题与空状态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(here, '../../lib/client.js');

function loadBundle(options = {}) {
    const source = fs.readFileSync(bundlePath, 'utf8');
    const registered = [];
    const sandbox = {
        window: {
            __ModuleLoader__: {
                load(registration) {
                    registered.push(registration);
                },
            },
        },
        console,
        fetch: () => Promise.reject(new Error('no network in unit test')),
        // 面板的自动刷新副作用依赖浏览器定时器；契约测试不需要真的跑 tick。
        setInterval: () => 0,
        clearInterval: () => {},
    };
    if (options.localStorage !== undefined) {
        sandbox.localStorage = {
            getItem(key) { return options.localStorage.has(key) ? options.localStorage.get(key) : null; },
            setItem(key, value) { options.localStorage.set(key, String(value)); },
        };
    }
    if (options.windowEvents !== undefined) {
        sandbox.window.addEventListener = (type, listener) => {
            if (type === 'storage') options.windowEvents.push(listener);
        };
        sandbox.window.removeEventListener = () => {};
    }
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: bundlePath });
    assert.equal(registered.length, 1, 'bundle 必须只调用一次 __ModuleLoader__.load');
    return registered[0];
}

function findAll(node, predicate, found = []) {
    if (node === null || typeof node !== 'object') return found;
    if (predicate(node)) found.push(node);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) findAll(child, predicate, found);
    return found;
}

function reactStub(options = {}) {
    const cleanups = [];
    return {
        Fragment: 'Fragment',
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) { return [initial, () => {}]; },
        useEffect(fn) {
            // 默认不执行副作用；runEffects 用于断言「挂载本身不打开右侧栏」。
            if (options.runEffects !== true) return;
            const cleanup = fn();
            if (typeof cleanup === 'function') cleanups.push(cleanup);
        },
        useMemo(fn) { return fn(); },
        useCallback(fn) { return fn; },
        useRef(value) { return { current: value ?? null }; },
        cleanups,
    };
}

function findSidebarButton(tree) {
    return findAll(tree, (node) => (
        node.props && node.props.className === 'et-btn'
        && Array.isArray(node.children) && node.children.includes('右侧栏')
    ))[0];
}

// 挂载真实 ExploreTreePanel 的最小运行环境；useEffect 立即执行，才能覆盖
// 「进入页签自动 openTab」这条旧链路。mode: immediate 导航先就绪 / late 后到 / missing 插件不可用。
function panelHarness(mode) {
    const registration = loadBundle();
    const react = reactStub({ runEffects: true });
    const module = registration.factory(() => react);
    const opened = [];
    const nav = { openTab(kind) { opened.push(kind); } };
    let viewEntry;
    let navCallback = null;
    module.apply({
        slots: {
            inject(name, factory) {
                const entry = factory();
                if (name === 'conversation.view') viewEntry = entry;
            },
            register(options, component) { return { options, component }; },
        },
        inject(_deps, callback) {
            const deps = Array.from(_deps);
            if (deps.includes('sidebarRight')) {
                if (mode === 'immediate') callback({ sidebarRight: nav, effect(execute) { return execute(); } });
                if (mode === 'late') navCallback = callback;
            }
            if (deps.includes('sidebarRightTabs')) {
                callback({ sidebarRightTabs: { register() { return () => {}; } }, effect(execute) { return execute(); } });
            }
        },
    });
    return {
        render(props = { sessionId: 's1', useSessions: undefined }) {
            return viewEntry.component(props);
        },
        flushNav() {
            const callback = navCallback;
            navCallback = null;
            if (callback === null) throw new Error('没有待就绪的 sidebarRight 回调');
            callback({ sidebarRight: nav, effect(execute) { return execute(); } });
        },
        opened,
        cleanup() {
            while (react.cleanups.length > 0) {
                const cleanup = react.cleanups.pop();
                try { cleanup(); } catch (error) { /* 清理失败不影响断言 */ }
            }
        },
    };
}

describe('lib/client.js bundle contract', () => {
    it('id 等于包名，factory 惰性且只依赖 react', () => {
        const registration = loadBundle();
        assert.equal(registration.id, 'dsh-explore-tree');
        assert.equal(typeof registration.factory, 'function');
        const module = registration.factory((specifier) => {
            if (specifier === 'react') return reactStub();
            throw new Error(`unexpected require("${specifier}")`);
        });
        assert.equal(module.name, 'dsh-explore-tree');
        assert.deepEqual(Array.from(module.inject), ['slots']);
        assert.equal(typeof module.apply, 'function');
    });

    it('注册 conversation.view、settings.section 与右侧栏预览', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        const injected = [];
        const injectedDeps = [];
        const tabs = [];
        const ctx = {
            slots: {
                inject(name, factory) { injected.push({ name, entry: factory() }); },
                register(options, component) { return { options, component }; },
            },
            inject(_deps, callback) {
                const deps = Array.from(_deps);
                injectedDeps.push(deps);
                if (deps.length === 1 && deps[0] === 'sidebarRight') {
                    callback({ sidebarRight: { openTab() {} }, effect(execute) { execute(); return () => {}; } });
                    return;
                }
                if (deps.length === 1 && deps[0] === 'sidebarRightTabs') {
                    callback({
                        sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {}; } },
                        effect(execute) { execute(); return () => {}; },
                    });
                    return;
                }
                assert.fail(`意外的可选注入依赖：${deps.join(',')}`);
            },
        };
        module.apply(ctx);
        assert.deepEqual(injectedDeps, [['sidebarRight'], ['sidebarRightTabs']], '导航与页签分别可选注入，sidebarRight 缺失不应让 body 消失');
        assert.equal(injected.length, 3);
        assert.deepEqual(injected.map((item) => item.name), ['conversation.view', 'settings.section', 'sidebar.right.pane.tab']);
        const view = injected[0].entry;
        assert.equal(view.options.name, 'conversation.view');
        assert.equal(view.options.id, 'explore-tree');
        assert.equal(view.options.order, 45, '页签顺序：对话0/轨迹10/上下文20/编队30/记忆40/预览50 之间');
        assert.equal(typeof view.options.label, 'function');
        assert.equal(view.options.label(), '研究轨迹');
        assert.equal(typeof view.component, 'function');
        const settings = injected[1].entry;
        assert.equal(settings.options.name, 'settings.section');
        assert.equal(settings.options.id, 'explore-tree');
        assert.equal(settings.options.order, 518);
        assert.equal(typeof settings.options.label, 'function');
        assert.equal(settings.options.label(), '研究轨迹');
        assert.equal(typeof settings.component, 'function');

        assert.equal(tabs.length, 1, '右侧栏只注册一个页签');
        assert.equal(tabs[0].id, 'research-tree');
        assert.equal(tabs[0].kind, 'research-tree');
        assert.equal(tabs[0].keepMounted, true);
        assert.equal(tabs[0].priority, 'extension');
        assert.equal(typeof tabs[0].title, 'function');
        assert.equal(tabs[0].title(), '研究轨迹');
        assert.equal(tabs[0].guide[0].id, 'explore-tree');
        // 侧边栏 GuideBody 直接调用 entry.title() 和 entry.description?.()；
        // 字符串会让整页 guide 抛 TypeError，必须锁成函数。
        assert.equal(typeof tabs[0].guide[0].title, 'function');
        assert.equal(tabs[0].guide[0].title(), '研究轨迹');
        assert.equal(typeof tabs[0].guide[0].description, 'function');
        assert.match(tabs[0].guide[0].description(), /目标、待办与下一步/);
        const preview = injected[2].entry;
        assert.equal(preview.options.name, 'sidebar.right.pane.tab');
        assert.equal(preview.options.key, 'research-tree');
        assert.equal(typeof preview.component, 'function');
    });

    it('面板工具栏的「右侧栏」按钮调用 sidebarRight.openTab', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        let viewEntry;
        const opened = [];
        module.apply({
            slots: {
                inject(name, factory) {
                    const entry = factory();
                    if (name === 'conversation.view') viewEntry = entry;
                },
                register(options, component) { return { options, component }; },
            },
            inject(_deps, callback) {
                const deps = Array.from(_deps);
                if (deps.includes('sidebarRight')) {
                    callback({ sidebarRight: { openTab(kind) { opened.push(kind); } }, effect(execute) { return execute(); } });
                }
                if (deps.includes('sidebarRightTabs')) {
                    callback({ sidebarRightTabs: { register() { return () => {}; } }, effect(execute) { return execute(); } });
                }
            },
        });
        const tree = viewEntry.component({ sessionId: 's1', useSessions: undefined });
        const button = findAll(tree, (node) => (
            node.props && node.props.className === 'et-btn'
            && Array.isArray(node.children) && node.children.includes('右侧栏')
        ))[0];
        assert.ok(button, '工具栏应有右侧栏入口，否则用户没有可见入口');
        assert.equal(button.props.disabled, false);
        button.props.onClick();
        assert.deepEqual(opened, ['research-tree']);
    });

    // 回归：旧版首次进入会话的「研究轨迹」页会自动 openTab，用户视为 bug。
    it('挂载研究轨迹面板不自动打开右侧栏，只有点工具栏按钮才打开', () => {
        const panel = panelHarness('immediate');
        try {
            panel.render({ sessionId: 's1', useSessions: undefined });
            panel.render({ sessionId: 's2', useSessions: undefined });
            assert.deepEqual(panel.opened, [], '进入/切换研究轨迹页签都不应打开右侧栏');

            const button = findSidebarButton(panel.render({ sessionId: 's1', useSessions: undefined }));
            assert.ok(button, '工具栏仍应保留「右侧栏」入口');
            assert.equal(button.props.disabled, false, '侧栏服务可用时按钮不应禁用');
            button.props.onClick();
            assert.deepEqual(panel.opened, ['research-tree'], '只有显式点击才打开右侧栏');
        } finally {
            panel.cleanup();
        }
    });

    it('侧栏服务晚到时不自动补开；就绪后重新渲染按钮可用', () => {
        const panel = panelHarness('late');
        try {
            const before = findSidebarButton(panel.render({ sessionId: 's1', useSessions: undefined }));
            assert.equal(before.props.disabled, true, '服务未就绪时按钮禁用');
            panel.flushNav(); // 旧实现会拿 sidebarPreviewPending 在这里自动补开
            assert.deepEqual(panel.opened, [], '服务就绪不应自动打开右侧栏');

            const after = findSidebarButton(panel.render({ sessionId: 's1', useSessions: undefined }));
            assert.equal(after.props.disabled, false, '服务就绪后按钮应变可用');
            after.props.onClick();
            assert.deepEqual(panel.opened, ['research-tree']);
        } finally {
            panel.cleanup();
        }
    });

    it('右侧栏插件不可用时「右侧栏」按钮保持禁用且点击无副作用', () => {
        const panel = panelHarness('missing');
        try {
            const button = findSidebarButton(panel.render({ sessionId: 's1', useSessions: undefined }));
            assert.ok(button);
            assert.equal(button.props.disabled, true);
            assert.equal(button.props.title, '右侧栏插件不可用');
            button.props.onClick();
            assert.deepEqual(panel.opened, []);
        } finally {
            panel.cleanup();
        }
    });

    it('页签类型 id 已被旧 bundle 占用时仍注册右侧栏 body，不留空白页签', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        let bodyEntry;
        module.apply({
            slots: {
                inject(name, factory) {
                    if (name === 'sidebar.right.pane.tab') bodyEntry = factory();
                },
                register(options, component) { return { options, component }; },
            },
            inject(_deps, callback) {
                const deps = Array.from(_deps);
                if (deps.includes('sidebarRight')) {
                    callback({ sidebarRight: { openTab() {} }, effect(execute) { execute(); return () => {}; } });
                }
                if (deps.includes('sidebarRightTabs')) {
                    callback({
                        sidebarRightTabs: {
                            register() { throw new Error('sidebarRight: tab type id "research-tree" is already registered'); },
                        },
                        effect(execute) { execute(); return () => {}; },
                    });
                }
            },
        });
        assert.ok(bodyEntry, 'body 必须先于页签类型注册，否则重复 id 会让页签空白');
        assert.equal(bodyEntry.options.key, 'research-tree');
        assert.equal(typeof bodyEntry.component, 'function');
    });

    it('右侧栏预览在空数据下渲染加载态，不抛错', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        let previewEntry;
        module.apply({
            slots: {
                inject(name, factory) { if (name === 'sidebar.right.pane.tab') previewEntry = factory(); },
                register(options, component) { return { options, component }; },
            },
            inject(_deps, callback) {
                callback({
                    sidebarRightTabs: { register() { return () => {}; } },
                    effect(execute) { return execute(); },
                });
            },
        });
        const tree = previewEntry.component({ sessionId: 's1', useSessions: undefined });
        const json = JSON.stringify(tree);
        assert.ok(json.includes('研究轨迹'), '预览标题必须出现');
        assert.ok(json.includes('正在读取研究图'), '首帧显示加载态');
        assert.ok(!json.includes('读取失败'), '未发起请求时不应显示错误态');
    });

    it('面板在空数据下渲染标题与加载态，不抛错', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        let viewEntry;
        module.apply({
            slots: {
                inject(name, factory) {
                    const entry = factory();
                    if (name === 'conversation.view') viewEntry = entry;
                },
                register(options, component) { return { options, component }; },
            },
        });
        const tree = viewEntry.component({ sessionId: 's1', useSessions: undefined });
        const json = JSON.stringify(tree);
        assert.ok(json.includes('研究轨迹'), '面板标题必须出现');
        assert.ok(json.includes('正在读取研究图'), '首帧必须显示加载态而不是空白/崩溃');
        assert.ok(json.includes('当前会话工作区'), '未解析出会话工作区时显示占位名');
        assert.ok(json.includes('显示选项在 设置 → 研究轨迹'), '面板要提示偏好已移到设置页');
        assert.ok(!json.includes('自动刷新'), '自动刷新已移到设置页，不应再出现在工具栏');
        assert.ok(!json.includes('隐藏动作'), '隐藏动作已移到设置页');
        assert.ok(!json.includes('只看待办'), '只看待办已移到设置页');
        assert.ok(!json.includes('工作目录路径'), '工作区不再需要手动选择/输入');
        assert.ok(!json.includes('打开'), '不再有路径输入与打开按钮');
    });

    it('设置分区渲染显示/过滤偏好与恢复默认', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        let settingsEntry;
        module.apply({
            slots: {
                inject(name, factory) {
                    if (name === 'settings.section') settingsEntry = factory();
                },
                register(options, component) { return { options, component }; },
            },
        });
        const tree = settingsEntry.component({});
        const json = JSON.stringify(tree);
        for (const text of ['研究轨迹', '显示', '过滤', '自动刷新', '紧凑模式', '大纲', '详情栏', '隐藏动作', '隐藏产物', '隐藏笔记', '只看待办', '仅本会话', 'AI 解析', '显示 AI 解析', '恢复默认']) {
            assert.ok(json.includes(text), '设置页应包含「' + text + '」');
        }
        assert.ok(!json.includes('正在读取研究图'), '设置页不应触发面板请求/加载态');
    });

    it('设置页开关写入 localStorage，重新渲染立即生效', () => {
        const storage = new Map();
        const registration = loadBundle({ localStorage: storage });
        const module = registration.factory(() => reactStub());
        let settingsEntry;
        module.apply({
            slots: {
                inject(name, factory) {
                    if (name === 'settings.section') settingsEntry = factory();
                },
                register(options, component) { return { options, component }; },
            },
        });
        const toggle = (tree, title) => findAll(tree, (node) => (
            typeof node.type === 'function' && node.type.name === 'ToggleRow' && node.props.title === title
        ))[0];
        let tree = settingsEntry.component({});
        const auto = toggle(tree, '自动刷新');
        assert.equal(auto.props.checked, true);
        auto.props.onChange(false);
        tree = settingsEntry.component({});
        assert.equal(toggle(tree, '自动刷新').props.checked, false, '关闭后重新渲染应反映新值');
        assert.equal(JSON.parse(storage.get('explore-tree.prefs.v1')).autoRefresh, false, '偏好应持久化');
        assert.equal(storage.get('explore-tree.prefs.v1.autoRefresh'), 'false', '单项 key 是并发写入的真实来源');
        auto.props.onChange(true);
        assert.equal(JSON.parse(storage.get('explore-tree.prefs.v1')).autoRefresh, true);
        assert.equal(storage.get('explore-tree.prefs.v1.autoRefresh'), 'true');

        const aiToggle = toggle(tree, '显示 AI 解析');
        assert.equal(aiToggle.props.checked, true, 'AI 解析默认开启');
        aiToggle.props.onChange(false);
        tree = settingsEntry.component({});
        assert.equal(toggle(tree, '显示 AI 解析').props.checked, false);
        assert.equal(storage.get('explore-tree.prefs.v1.showAnalysis'), 'false', 'AI 解析开关使用单项 key 持久化');
    });

    it('两个标签页改不同偏好不互相覆盖，storage 事件会同步', () => {
        const storage = new Map();
        const eventsA = [];
        const eventsB = [];
        const settingsOf = (registration) => {
            const module = registration.factory(() => reactStub());
            let entry;
            module.apply({
                slots: {
                    inject(name, factory) {
                        if (name === 'settings.section') entry = factory();
                    },
                    register(options, component) { return { options, component }; },
                },
            });
            return entry.component;
        };
        const toggle = (tree, title) => findAll(tree, (node) => (
            typeof node.type === 'function' && node.type.name === 'ToggleRow' && node.props.title === title
        ))[0];
        const settingsA = settingsOf(loadBundle({ localStorage: storage, windowEvents: eventsA }));
        const settingsB = settingsOf(loadBundle({ localStorage: storage, windowEvents: eventsB }));

        // A、B 都在对方写入前读到默认值，各自只改一个不同的偏好。
        toggle(settingsA({}), '自动刷新').props.onChange(false);
        toggle(settingsB({}), '隐藏笔记').props.onChange(false);

        assert.equal(storage.get('explore-tree.prefs.v1.autoRefresh'), 'false', 'A 的自动刷新应保留');
        assert.equal(storage.get('explore-tree.prefs.v1.hideNotes'), 'false', 'B 的隐藏笔记应保留');

        // 任一标签页收到单项 key 的 storage 事件后重新合并，两个改动都在。
        for (const listener of eventsA) listener({ key: 'explore-tree.prefs.v1.hideNotes' });
        const treeA = settingsA({});
        assert.equal(toggle(treeA, '自动刷新').props.checked, false);
        assert.equal(toggle(treeA, '隐藏笔记').props.checked, false, 'A 应看到 B 的改动');
    });

    it('损坏的 localStorage 回退默认值', () => {
        const storage = new Map([['explore-tree.prefs.v1', '{not json']]);
        const registration = loadBundle({ localStorage: storage });
        const module = registration.factory(() => reactStub());
        let settingsEntry;
        module.apply({
            slots: {
                inject(name, factory) {
                    if (name === 'settings.section') settingsEntry = factory();
                },
                register(options, component) { return { options, component }; },
            },
        });
        const tree = settingsEntry.component({});
        const auto = findAll(tree, (node) => typeof node.type === 'function' && node.type.name === 'ToggleRow' && node.props.title === '自动刷新')[0];
        assert.equal(auto.props.checked, true, '损坏值不应影响默认偏好');
    });
});

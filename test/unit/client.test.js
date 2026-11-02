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
    };
    if (options.localStorage !== undefined) {
        sandbox.localStorage = {
            getItem(key) { return options.localStorage.has(key) ? options.localStorage.get(key) : null; },
            setItem(key, value) { options.localStorage.set(key, String(value)); },
        };
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

function reactStub() {
    return {
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) { return [initial, () => {}]; },
        useEffect() {},
        useMemo(fn) { return fn(); },
        useCallback(fn) { return fn; },
        useRef(value) { return { current: value ?? null }; },
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

    it('注册 conversation.view 页签与 settings.section 设置分区', () => {
        const registration = loadBundle();
        const module = registration.factory(() => reactStub());
        const injected = [];
        const ctx = {
            slots: {
                inject(name, factory) { injected.push({ name, entry: factory() }); },
                register(options, component) { return { options, component }; },
            },
        };
        module.apply(ctx);
        assert.equal(injected.length, 2);
        assert.deepEqual(injected.map((item) => item.name), ['conversation.view', 'settings.section']);
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
        assert.ok(!json.includes('只看未决'), '只看未决已移到设置页');
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
        for (const text of ['研究轨迹', '显示', '过滤', '自动刷新', '紧凑模式', '大纲', '详情栏', '隐藏动作', '隐藏产物', '隐藏笔记', '只看未决', '仅本会话', '恢复默认']) {
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
        auto.props.onChange(true);
        assert.equal(JSON.parse(storage.get('explore-tree.prefs.v1')).autoRefresh, true);
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

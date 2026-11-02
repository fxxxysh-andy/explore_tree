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

function loadBundle() {
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
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: bundlePath });
    assert.equal(registered.length, 1, 'bundle 必须只调用一次 __ModuleLoader__.load');
    return registered[0];
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

    it('只注册 conversation.view 上栏页签（不再有顶栏按钮/弹层）', () => {
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
        assert.equal(injected.length, 1);
        assert.equal(injected[0].name, 'conversation.view');
        const view = injected[0].entry;
        assert.equal(view.options.name, 'conversation.view');
        assert.equal(view.options.id, 'explore-tree');
        assert.equal(view.options.order, 45, '页签顺序：对话0/轨迹10/上下文20/编队30/记忆40/预览50 之间');
        assert.equal(typeof view.options.label, 'function');
        assert.equal(view.options.label(), '研究轨迹');
        assert.equal(typeof view.component, 'function');
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
        assert.ok(json.includes('自动刷新'), '刷新开关必须出现');
        assert.ok(json.includes('正在读取研究图'), '首帧必须显示加载态而不是空白/崩溃');
        assert.ok(json.includes('当前会话工作区'), '未解析出会话工作区时显示占位名');
        assert.ok(!json.includes('工作目录路径'), '工作区不再需要手动选择/输入');
        assert.ok(!json.includes('打开'), '不再有路径输入与打开按钮');
    });
});

/**
 * dsh-explore-tree 客户端面板（手写 bundle，无构建步骤）。
 *
 * 宿主只做一件事：把 `lib/client.js` 交给 `window.__ModuleLoader__` 注册 factory；
 * factory 在模块真正被加载时才执行（惰性 CJS）。因此这里不碰 document，也不在
 * 顶层跑副作用。
 *
 * UI 占用 **conversation.view**（会话上栏的页签，紧挨着「轨迹」）：
 * 数据来自宿主路由 `GET /explore-tree/workspaces` 与 `/explore-tree/snapshot`。
 *
 * 布局契约（见 docs/research/client-api.md §5.3）：conversation.view 不能自己当
 * 纵向滚动容器——高度随内容自然增长，由宿主的 scrollBody 滚动；画布只在自己的
 * scrollLeft/scrollTop 内滚动，拖动/滚轮缩放都不带动整页。
 *
 * v0.7 可观察性改造：滚动/缩放/适应宽度、紧凑模式、搜索与定位、按类型过滤、
 * 轮次快捷条、详情栏可收起、节点详情/子节点/路径可跳转、无选中时显示图概况。
 * v0.18 滚动/拖动：指针拖动平移、Ctrl/⌘+滚轮以指针为中心缩放、Shift+滚轮横向滚动、
 * 双击空白适应宽度；缩放锚点统一回填 scrollLeft/scrollTop，选中定位不再 scrollIntoView。
 * 面板仍然只读：不写回研究图，不向主对话注入内容。
 */
window.__ModuleLoader__.load({
    id: 'dsh-explore-tree',
    factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;

        /** 平台内置模块，永远可用，不打进 bundle。 */
        var React = require('react');
        var h = React.createElement;

        var PANEL_ID = 'explore-tree';
        var SIDEBAR_TAB_ID = 'research-tree';
        var sidebarPreviewOpen = null;
        // 侧栏服务可能比面板晚就绪；先记下待展开的会话，服务到位后补开一次。
        var sidebarPreviewPending = null;
        // 每个会话只在第一次打开「研究轨迹」页签时自动展开右侧栏，之后由工具栏按钮控制。
        var sidebarPreviewAutoOpened = Object.create(null);
        var VIEW_ORDER = 45; // 对话=0 轨迹=10 上下文=20 编队=30 记忆=40 预览=50
        var SETTINGS_ORDER = 518;
        var REFRESH_MS = 3000;
        var STORAGE_KEY = 'explore-tree.workspace';
        var ZOOM_MIN = 0.2;
        var ZOOM_MAX = 1.6;
        var ZOOM_STEP = 0.1;

        var KIND_LABEL = {
            goal: '目标',
            topic: '主干',
            question: '问题',
            hypothesis: '假设',
            step: '步骤',
            action: '动作',
            evidence: '证据',
            decision: '决策',
            dead_end: '死路',
            conclusion: '结论',
            artifact: '产物',
            note: '笔记',
        };
        var KIND_COLOR = {
            goal: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            topic: '#2f6f9f',
            question: '#8a63d2',
            hypothesis: '#d08a00',
            step: '#5a7d9a',
            action: '#5a8f6a',
            evidence: '#2f8f83',
            decision: '#b05a9a',
            dead_end: '#c0504d',
            conclusion: '#2e8b57',
            artifact: '#7a6a4f',
            note: '#777',
        };
        var KIND_ORDER = ['goal', 'topic', 'step', 'question', 'hypothesis', 'evidence', 'decision', 'dead_end', 'conclusion', 'artifact', 'action', 'note'];
        var THOUGHT_KINDS = ['question', 'hypothesis', 'evidence', 'decision', 'dead_end', 'conclusion'];
        var LEAF_ROOT_KINDS = ['question', 'hypothesis', 'decision', 'conclusion', 'dead_end'];
        var STATUS_LABEL = { open: '未决', active: '进行中', done: '完成', abandoned: '放弃' };
        var STATUS_COLOR = {
            open: '#8a8a8a',
            active: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            done: '#2e8b57',
            abandoned: '#c0504d',
        };
        var SUGGEST_LABEL = {
            seed: '起步',
            verify: '验证',
            resolve: '收敛',
            branch: '换路径',
            deepen: '深入',
            consolidate: '巩固',
            revive: '重开',
            stop: '收尾',
        };
        var CARD_NORMAL = { cardW: 262, cardH: 128, gapX: 22, gapY: 44 };
        var CARD_COMPACT = { cardW: 196, cardH: 88, gapX: 16, gapY: 36 };

        // 面板显示/过滤偏好。v0.23 起从工具栏移到「设置 → 研究轨迹」，由面板与设置页共享。
        // 单个偏好各占一个 localStorage key（整对象读改写会在两个标签页同时改不同项时丢更新）；
        // PREFS_KEY 只保留为旧版本的镜像，读取时先旧后新。
        var PREFS_KEY = 'explore-tree.prefs.v1';
        var PREF_STORAGE_PREFIX = PREFS_KEY + '.';
        var PREF_DEFAULTS = {
            autoRefresh: true,
            compact: false,
            showOutline: true,
            showInspector: true,
            hideActions: true,
            hideArtifacts: false,
            hideNotes: true,
            onlyOpen: false,
            onlySession: false,
        };
        var PREF_KEYS = Object.keys(PREF_DEFAULTS);
        var prefListeners = [];
        var PREFS = loadPrefs();
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            // 设置页/多个标签页共享同一份 localStorage：另一个标签页改动后跟着刷新。
            window.addEventListener('storage', function (event) {
                if (event === null) return;
                if (typeof event.key === 'string' && event.key !== PREFS_KEY && event.key.indexOf(PREF_STORAGE_PREFIX) !== 0) return;
                PREFS = loadPrefs();
                notifyPrefs();
            });
        }

        function clonePrefs(source) {
            var result = {};
            for (var index = 0; index < PREF_KEYS.length; index += 1) {
                var key = PREF_KEYS[index];
                result[key] = source !== null && typeof source === 'object' && typeof source[key] === 'boolean'
                    ? source[key]
                    : PREF_DEFAULTS[key];
            }
            return result;
        }

        function loadPrefs() {
            var result = clonePrefs(PREF_DEFAULTS);
            try {
                if (typeof localStorage === 'undefined') return result;
                var raw = null;
                try {
                    raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
                } catch (error) {
                    // 损坏的旧值：忽略，继续读单项 key。
                }
                if (raw !== null && typeof raw === 'object') {
                    for (var index = 0; index < PREF_KEYS.length; index += 1) {
                        var legacyKey = PREF_KEYS[index];
                        if (Object.prototype.hasOwnProperty.call(raw, legacyKey) && typeof raw[legacyKey] === 'boolean') {
                            result[legacyKey] = raw[legacyKey];
                        }
                    }
                }
                for (var item = 0; item < PREF_KEYS.length; item += 1) {
                    var stored = localStorage.getItem(PREF_STORAGE_PREFIX + PREF_KEYS[item]);
                    if (stored === 'true' || stored === 'false') result[PREF_KEYS[item]] = stored === 'true';
                }
            } catch (error) {
                // 隐私模式或损坏的旧值：回退到默认偏好。
            }
            return result;
        }

        function persistPrefs(onlyKey) {
            try {
                if (typeof localStorage === 'undefined') return;
                var keys = typeof onlyKey === 'string' ? [onlyKey] : PREF_KEYS;
                for (var index = 0; index < keys.length; index += 1) {
                    var key = keys[index];
                    localStorage.setItem(PREF_STORAGE_PREFIX + key, PREFS[key] ? 'true' : 'false');
                }
                // 旧版本仍读整对象；真实取值以单项 key 为准。
                localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS));
            } catch (error) {
                // 忽略持久化失败，偏好仍在内存中生效。
            }
        }

        function subscribePrefs(listener) {
            prefListeners.push(listener);
            return function () {
                var index = prefListeners.indexOf(listener);
                if (index >= 0) prefListeners.splice(index, 1);
            };
        }

        function notifyPrefs() {
            for (var index = 0; index < prefListeners.length; index += 1) {
                try {
                    prefListeners[index](PREFS);
                } catch (error) {
                    // 单个订阅者失败不影响其他面板/设置页。
                }
            }
        }

        function setPref(key, value) {
            if (!Object.prototype.hasOwnProperty.call(PREF_DEFAULTS, key) || typeof value !== 'boolean') return;
            if (PREFS[key] === value) return;
            var next = clonePrefs(PREFS);
            next[key] = value;
            PREFS = next;
            persistPrefs(key);
            notifyPrefs();
        }

        function resetPrefs() {
            PREFS = clonePrefs(PREF_DEFAULTS);
            persistPrefs();
            notifyPrefs();
        }

        function usePrefs() {
            var pair = React.useState(PREFS);
            React.useEffect(function () {
                return subscribePrefs(function (next) { pair[1](next); });
            }, []);
            return pair[0];
        }

        var CSS = [
            '.et-root{display:flex;flex-direction:column;font:var(--dsw-font-xs-13,13px)/1.55 var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box;width:100%;min-width:0;overflow-x:clip}',
            '.et-bar{position:sticky;top:0;z-index:20;display:flex;flex-direction:column;gap:8px;padding:10px 18px 9px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-bg-base,#fff);box-shadow:0 6px 14px -14px rgba(0,0,0,.35)}',
            '.et-bar-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;min-width:0}',
            '.et-bar h2{margin:0;font-size:14px;font-weight:650;letter-spacing:.01em}',
            '.et-muted{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.92))}',
            '.et-faint{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75))}',
            '.et-ws{font-size:12px;max-width:240px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
            '.et-stats{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-stats b{font-weight:650;color:var(--dsw-alias-label-primary,inherit)}',
            '.et-spacer{flex:1 1 auto}',
            '.et-group{display:flex;align-items:center;gap:2px;padding:1px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:7px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.04))}',
            '.et-group button{font:inherit;font-size:11.5px;line-height:1.6;padding:1px 7px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}',
            '.et-group button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
            '.et-group .et-zoom-value{min-width:40px;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-btn{font:inherit;font-size:11.5px;line-height:1.7;padding:1px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));color:inherit;cursor:pointer}',
            '.et-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
            '.et-btn[data-active="1"]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);color:var(--dsw-alias-state-business-primary,#4d6bfe);background:rgba(77,107,254,.1)}',
            '.et-search{flex:0 1 250px;min-width:150px;font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;outline:none}',
            '.et-search:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
            '.et-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:1.8;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
            '.et-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.et-chip[data-active="1"]{border-color:currentColor;background:rgba(77,107,254,.09);font-weight:600}',
            '.et-chip[disabled]{cursor:default;opacity:.55}',
            '.et-legend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px}',
            '.et-body{display:flex;align-items:flex-start;gap:14px;padding:12px 18px 44px;min-width:0}',
            '.et-outline{width:228px;flex:0 0 228px;max-height:min(72vh,780px);overflow:auto;position:sticky;top:0}',
            '.et-outline-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}',
            '.et-outline-item{display:flex;align-items:baseline;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.5;text-align:left;cursor:pointer;overflow:hidden}',
            '.et-outline-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.et-outline-item[data-active="1"]{background:rgba(77,107,254,.12);color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
            '.et-outline-turn{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
            '.et-outline-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.et-outline-count{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75))}',
            '.et-canvas{position:relative;flex:1 1 auto;min-width:0;height:min(72vh,780px);min-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));border-radius:12px;background-image:radial-gradient(rgba(128,128,128,.14) 1px,transparent 1px);background-size:18px 18px;cursor:grab;overscroll-behavior:contain;touch-action:pan-x pan-y}',
            '.et-canvas.et-dragging{cursor:grabbing}',
            '.et-canvas.et-dragging,.et-canvas.et-dragging *{user-select:none;-webkit-user-select:none}',
            '.et-graph{position:relative;transform-origin:0 0}',
            '.et-side{width:336px;flex:0 0 336px;padding:2px 0 24px;display:flex;flex-direction:column;gap:12px}',
            '.et-card{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:11px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 2px rgba(0,0,0,.05);cursor:pointer;text-align:left;font:inherit;color:inherit;overflow:hidden;transition:box-shadow .12s ease,opacity .12s ease}',
            '.et-card:hover{box-shadow:0 3px 14px rgba(0,0,0,.16);z-index:3}',
            '.et-card[data-compact="1"]{padding:5px 8px;gap:2px}',
            '.et-card[data-compact="1"] .et-card-title{font-size:12px;line-height:1.36}',
            '.et-card[data-compact="1"] .et-card-summary{display:none}',
            '.et-card[data-compact="1"] .et-card-foot{display:none}',
            '.et-graph-zoom{position:relative}',
            '.et-card[data-selected="1"]{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4d6bfe),0 4px 16px rgba(0,0,0,.16);z-index:4}',
            '.et-card[data-dim="1"]{opacity:.24}',
            '.et-card[data-dim="1"]:hover{opacity:.7}',
            '.et-card-head{display:flex;align-items:center;gap:6px;min-width:0}',
            '.et-card-badge{flex:0 0 auto;font-size:10px;line-height:1.7;padding:0 6px;border-radius:5px;background:rgba(128,128,128,.12);font-weight:650}',
            '.et-card-meta{flex:1 1 auto;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.et-card-ai{flex:0 0 auto;font-size:9.5px;line-height:1.6;padding:0 4px;border-radius:4px;background:rgba(77,107,254,.16);color:var(--dsw-alias-state-business-primary,#4d6bfe);font-weight:700}',
            '.et-card-title{font-size:12.5px;font-weight:600;line-height:1.42;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-card-summary{font-size:11px;line-height:1.42;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-card-sub{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%}',
            '.et-card-foot{display:flex;align-items:center;gap:5px;min-height:14px;margin-top:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-card-foot .et-card-sub{max-width:none;flex:1 1 auto;min-width:0;text-align:right}',
            '.et-card-digest{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary,rgba(90,100,115,.98));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-digest{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:rgba(47,111,159,.08);border:1px solid rgba(47,111,159,.25);font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}',
            '.et-digest b{font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));display:block;margin-bottom:2px}',
            '.et-digest-history{margin-top:6px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(90,100,110,.85));}',
            '.et-digest-version{opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.et-outline-item[data-depth]{padding-left:calc(6px + var(--et-depth,0) * 12px)}',
            '.et-card-toggle{margin-left:0;font:inherit;font-size:10.5px;line-height:1.5;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;cursor:pointer}',
            '.et-card-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
            '.et-badge{flex:0 0 auto;font-size:10px;padding:0 5px;border-radius:4px;border:1px solid currentColor;opacity:.95;line-height:1.6}',
            '.et-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block}',
            '.et-section{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.035))}',
            '.et-section h3{margin:0 0 8px;font-size:11.5px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));display:flex;align-items:center;justify-content:space-between;gap:8px}',
            '.et-detail-title{margin:8px 0 5px;font-size:14px;font-weight:650;line-height:1.45;overflow-wrap:anywhere}',
            '.et-summary{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.98))}',
            '.et-summary[data-clamped="1"]{max-height:8.8em;overflow:hidden;mask-image:linear-gradient(180deg,#000 62%,transparent)}',
            '.et-summary-toggle{margin-top:4px}',
            '.et-path{display:flex;flex-wrap:wrap;gap:2px 4px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));overflow-wrap:anywhere;margin-bottom:2px}',
            '.et-path button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline dotted;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.et-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}',
            '.et-item{padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.04))}',
            '.et-item[data-clickable="1"]{cursor:pointer}',
            '.et-item[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
            '.et-item-title{display:flex;gap:6px;align-items:baseline;font-weight:600;font-size:12px;overflow-wrap:anywhere}',
            '.et-item-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));overflow-wrap:anywhere;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
            '.et-reason{margin:3px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.96));overflow-wrap:anywhere}',
            '.et-avoid{border-color:rgba(190,80,77,.45)}',
            '.et-tag{display:inline-block;margin:4px 4px 0 0;padding:0 6px;font-size:10.5px;border-radius:999px;background:rgba(128,128,128,.16)}',
            '.et-empty{padding:44px 24px;text-align:center;max-width:600px;margin:0 auto;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-err{color:#c0504d}',
            '.et-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
            '.et-fold{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.035));padding:8px 10px}',
            '.et-fold>summary{cursor:pointer;font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));letter-spacing:.02em;text-transform:uppercase}',
            '.et-fold[data-count="0"]>summary{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));font-weight:600}',
            '.et-fold-body{padding-top:8px}',
            '.et-overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}',
            '.et-overview-cell{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
            '.et-overview-cell b{display:block;font-size:16px;line-height:1.25}',
            '.et-overview-cell span{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8))}',
            '.et-steps{display:flex;align-items:center;gap:6px;flex:1 1 420px;min-width:0;overflow-x:auto;padding:1px 0 2px;scrollbar-width:thin}',
            '.et-steps .et-chip{flex:0 0 auto}',
            '.et-bar-kind{height:4px;border-radius:2px;background:currentColor;opacity:.75}',
            '.et-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));margin:2px 0 0}',
            '.et-match-nav{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-set-root{max-width:760px;padding:4px 0 28px;font:var(--dsw-font-xs-13,13px)/1.6 var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,inherit)}',
            '.et-set-head h2{margin:0 0 4px;font-size:16px;font-weight:650;letter-spacing:.01em}',
            '.et-set-head p{margin:0 0 14px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-set-group{margin:0 0 12px;padding:2px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.035))}',
            '.et-set-group h3{margin:11px 0 1px;font-size:11.5px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '.et-set-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));cursor:pointer}',
            '.et-set-row:first-of-type{border-top:0}',
            '.et-set-row-main{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
            '.et-set-row-title{font-size:12.5px;font-weight:550}',
            '.et-set-row-desc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.85))}',
            '.et-set-check{flex:0 0 auto;width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
            '.et-set-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px}',
            '.et-set-btn{font:inherit;font-size:12px;line-height:1.5;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:6px;background:transparent;color:inherit;cursor:pointer}',
            '.et-set-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.et-set-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.82))}',
            '.et-preview-root{display:flex;flex-direction:column;gap:10px;padding:12px 12px 28px;font:var(--dsw-font-xs-13,13px)/1.55 var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box;width:100%;min-width:0}',
            '.et-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.et-preview-head h2{margin:0;font-size:14px;font-weight:650;letter-spacing:.01em;flex:0 0 auto}',
            '.et-preview-ws{font-size:11.5px;max-width:100%;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.07));color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
            '.et-preview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}',
            '.et-preview-metric{padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-base,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));min-width:0}',
            '.et-preview-metric b{display:block;font-size:16px;line-height:1.25}',
            '.et-preview-metric span{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.8));white-space:nowrap}',
            '.et-preview-section{padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.035));min-width:0}',
            '.et-preview-label{font-size:10.5px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));margin-bottom:6px}',
            '.et-preview-goal{font-size:12.5px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}',
            '.et-preview-item{padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}',
            '.et-preview-item:first-of-type{border-top:0;padding-top:0}',
            '.et-preview-item summary{cursor:pointer;display:flex;gap:5px;align-items:baseline;font-weight:600;font-size:11.5px}',
            '.et-preview-item .et-preview-sub{margin:3px 0 0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.96));font-size:11px}',
            '.et-preview-next .et-reason{margin-top:4px}',
            '.et-preview-foot{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.82))}',
            '.et-preview-hint{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}',
            '@media (max-width: 1200px){.et-outline{display:none}}',
            '@media (max-width: 1000px){.et-body{flex-direction:column}.et-side{width:100%;flex-basis:auto}.et-canvas{width:100%}}',
        ].join('');

        // ───────────────────────────── 数据 ─────────────────────────────

        function fetchJson(url) {
            return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }

        function workspaceItems(snapshot) {
            if (snapshot === null || typeof snapshot !== 'object') return [];
            if (Array.isArray(snapshot.items)) return snapshot.items;
            if (Array.isArray(snapshot.workspaces)) return snapshot.workspaces;
            if (snapshot.byId !== null && typeof snapshot.byId === 'object') return Object.values(snapshot.byId);
            return [];
        }

        function workspacePath(item) {
            return item.path ?? item.cwd ?? item.root ?? '';
        }

        function workspaceLabel(item) {
            if (typeof item.title === 'string' && item.title !== '') return item.title;
            var p = workspacePath(item);
            var parts = p.split(/[\\/]/u).filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : p;
        }

        /**
         * 当前会话的工作目录。conversation.view 会传 sessionId，标准 props 里有
         * useSessions（ClientStore 快照）；用它把页签默认绑定到本会话的工作区。
         */
        function readSessionWorkspace(props) {
            try {
                if (typeof props.useSessions !== 'function' || typeof props.sessionId !== 'string') return '';
                var cwd = props.useSessions(function (snapshot) {
                    return snapshot !== null && typeof snapshot === 'object' && snapshot.byId !== null && typeof snapshot.byId === 'object'
                        ? snapshot.byId[props.sessionId]?.cwd
                        : undefined;
                });
                return typeof cwd === 'string' ? cwd : '';
            } catch (error) {
                return '';
            }
        }

        function storageKeyFor(sessionId) {
            return STORAGE_KEY + '.' + (typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default');
        }

        function readStoredWorkspace(sessionId) {
            try {
                if (typeof localStorage === 'undefined') return '';
                return localStorage.getItem(storageKeyFor(sessionId)) ?? '';
            } catch (error) {
                return '';
            }
        }

        function storeWorkspace(sessionId, workspace) {
            if (typeof workspace !== 'string' || workspace === '') return;
            try {
                if (typeof localStorage !== 'undefined') localStorage.setItem(storageKeyFor(sessionId), workspace);
            } catch (error) {
                // 隐私模式等场景忽略持久化失败。
            }
        }

        function sameRoot(a, b) {
            return typeof a === 'string' && typeof b === 'string' && a !== '' && b !== '' && a.toLowerCase() === b.toLowerCase();
        }

        function nodeById(nodes) {
            var map = new Map();
            for (var i = 0; i < nodes.length; i += 1) map.set(nodes[i].id, nodes[i]);
            return map;
        }

        function maxDepthOf(nodes) {
            var byId = nodeById(nodes);
            var max = 0;
            for (var i = 0; i < nodes.length; i += 1) {
                var current = nodes[i];
                var depth = 1;
                var guard = 0;
                while (current.parentId !== null && current.parentId !== undefined && guard < 200) {
                    current = byId.get(current.parentId);
                    if (current === undefined) break;
                    depth += 1;
                    guard += 1;
                }
                if (depth > max) max = depth;
            }
            return max;
        }

        // ───────────────────────────── 过滤与布局 ─────────────────────────────

        function hiddenByOptions(node, options) {
            if (options.hideActions && node.kind === 'action') return true;
            if (options.hideArtifacts && node.kind === 'artifact') return true;
            // 旧图的 note 是 P0/P1 之前的「过程旁白」：默认折叠，不占视野；需要时可在工具栏取消隐藏。
            if (options.hideNotes && node.kind === 'note') return true;
            if (options.onlySessionId && node.sessionId !== options.onlySessionId) return true;
            if (options.kindFilter !== null && options.kindFilter !== undefined && node.kind !== options.kindFilter) return true;
            return false;
        }

        /** 主干视图节点：goal/topic，以及直接挂在 topic 下的叶根。 */
        function isTrunkNode(node, byId) {
            if (node.tags && node.tags.indexOf('archived') >= 0) return false;
            if (node.kind === 'goal' || node.kind === 'topic') return true;
            if (LEAF_ROOT_KINDS.indexOf(node.kind) < 0) return false;
            var parent = node.parentId === null || node.parentId === undefined ? undefined : byId.get(node.parentId);
            return parent !== undefined && parent.kind === 'topic';
        }

        /**
         * 结构过滤：隐藏某种 kind 时把子节点就近挂到未隐藏祖先上。
         * 只保留「匹配节点 + 其祖先」，因此按类型过滤后仍能看到上下文路径。
         */
        function visibleTree(nodes, options) {
            var byId = nodeById(nodes);
            var hidden = function (node) {
                if (options.trunkOnly && !isTrunkNode(node, byId)) return true;
                return hiddenByOptions(node, options);
            };
            var keep = new Set();
            for (var i = 0; i < nodes.length; i += 1) {
                var node = nodes[i];
                if (hidden(node)) continue;
                var current = node;
                var guard = 0;
                while (current !== undefined && current !== null && guard < 200) {
                    if (!hidden(current)) keep.add(current.id);
                    current = current.parentId === null || current.parentId === undefined ? undefined : byId.get(current.parentId);
                    guard += 1;
                }
            }
            var out = [];
            for (var j = 0; j < nodes.length; j += 1) {
                var item = nodes[j];
                if (!keep.has(item.id)) continue;
                var parentId = item.parentId ?? null;
                var parentGuard = 0;
                while (parentId !== null && !keep.has(parentId) && parentGuard < 200) {
                    var parent = byId.get(parentId);
                    parentId = parent === undefined ? null : (parent.parentId ?? null);
                    parentGuard += 1;
                }
                if (parentId === item.parentId) {
                    out.push(item);
                } else {
                    out.push({ ...item, parentId: parentId });
                }
            }
            return out;
        }

        function childrenMap(nodes) {
            var map = new Map();
            for (var i = 0; i < nodes.length; i += 1) {
                var node = nodes[i];
                if (node.parentId === null || node.parentId === undefined) continue;
                if (!map.has(node.parentId)) map.set(node.parentId, []);
                map.get(node.parentId).push(node);
            }
            for (var list of map.values()) list.sort(function (a, b) { return (a.order ?? 0) - (b.order ?? 0); });
            return map;
        }

        function layoutTree(nodes, collapsed, dimensions) {
            var dims = dimensions ?? CARD_NORMAL;
            var byId = nodeById(nodes);
            var children = childrenMap(nodes);
            var roots = nodes.filter(function (node) { return node.parentId === null || node.parentId === undefined || !byId.has(node.parentId); });
            roots.sort(function (a, b) { return (a.order ?? 0) - (b.order ?? 0); });
            var collapsedSet = collapsed instanceof Set ? collapsed : new Set(Object.keys(collapsed ?? {}).filter(function (key) { return collapsed[key] === true; }));
            var padX = 20;
            var padY = 16;
            var cardW = dims.cardW;
            var cardH = dims.cardH;
            var gapX = dims.gapX;
            var gapY = dims.gapY;
            // 单行最多铺多宽：超过就把子节点换行，避免 20 个兄弟把画布拉成几屏宽。
            var maxLine = Math.max(cardW * 2, 920);

            function kidsOf(node) {
                return collapsedSet.has(node.id) ? [] : (children.get(node.id) ?? []);
            }

            // 先按「打包行」量出每个节点的块尺寸：块宽=最宽的一行，块高=卡片+各行子块。
            var blocks = new Map();
            function measure(node) {
                var kids = kidsOf(node);
                var lines = [];
                var current = [];
                var currentWidth = 0;
                var lineWidths = [];
                for (var k = 0; k < kids.length; k += 1) {
                    var block = measure(kids[k]);
                    var need = current.length === 0 ? block.width : block.width + gapX;
                    if (current.length > 0 && currentWidth + need > maxLine) {
                        lines.push(current);
                        lineWidths.push(currentWidth);
                        current = [];
                        currentWidth = 0;
                    }
                    current.push({ node: kids[k], block: block });
                    currentWidth += (current.length > 1 ? gapX : 0) + block.width;
                }
                if (current.length > 0) {
                    lines.push(current);
                    lineWidths.push(currentWidth);
                }
                var width = Math.max(cardW, lineWidths.length > 0 ? Math.max.apply(null, lineWidths) : 0);
                var height = cardH;
                if (lines.length > 0) {
                    height += gapY;
                    for (var i = 0; i < lines.length; i += 1) {
                        var lineHeight = 0;
                        for (var j = 0; j < lines[i].length; j += 1) lineHeight = Math.max(lineHeight, lines[i][j].block.height);
                        height += lineHeight + (i < lines.length - 1 ? gapY : 0);
                    }
                }
                var block = { width: width, height: height, lines: lines, lineWidths: lineWidths };
                blocks.set(node.id, block);
                return block;
            }

            var rows = [];
            var depthMax = 0;
            function place(node, left, top, depth) {
                var block = blocks.get(node.id) ?? { width: cardW, height: cardH, lines: [], lineWidths: [] };
                rows.push({ node: node, x: left + (block.width - cardW) / 2, y: top, depth: depth, width: block.width });
                if (depth > depthMax) depthMax = depth;
                var lineTop = top + cardH + gapY;
                for (var i = 0; i < block.lines.length; i += 1) {
                    var line = block.lines[i];
                    var lineWidth = block.lineWidths[i];
                    var cursor = left + (block.width - lineWidth) / 2;
                    var lineHeight = 0;
                    for (var j = 0; j < line.length; j += 1) lineHeight = Math.max(lineHeight, line[j].block.height);
                    for (var k = 0; k < line.length; k += 1) {
                        place(line[k].node, cursor, lineTop, depth + 1);
                        cursor += line[k].block.width + gapX;
                    }
                    lineTop += lineHeight + gapY;
                }
            }

            // 多个根（多个会话/目标）同样按行打包，纵向堆叠而不是横向无限拉长。
            var width = 0;
            var top = padY;
            var rootLine = [];
            var rootLineWidth = 0;
            function flushRoots() {
                if (rootLine.length === 0) return;
                var lineWidth = rootLineWidth;
                var cursor = padX;
                var lineHeight = 0;
                for (var i = 0; i < rootLine.length; i += 1) lineHeight = Math.max(lineHeight, rootLine[i].block.height);
                for (var j = 0; j < rootLine.length; j += 1) {
                    place(rootLine[j].node, cursor, top, 0);
                    cursor += rootLine[j].block.width + gapX;
                }
                width = Math.max(width, lineWidth);
                top += lineHeight + gapY;
                rootLine = [];
                rootLineWidth = 0;
            }
            for (var q = 0; q < roots.length; q += 1) {
                var rootBlock = measure(roots[q]);
                var need = rootLine.length === 0 ? rootBlock.width : rootBlock.width + gapX;
                if (rootLine.length > 0 && rootLineWidth + need > maxLine) flushRoots();
                rootLine.push({ node: roots[q], block: rootBlock });
                rootLineWidth += (rootLine.length > 1 ? gapX : 0) + rootBlock.width;
            }
            flushRoots();
            var height = roots.length > 0 ? top - gapY + padY : cardH + padY * 2;
            return {
                rows: rows,
                width: Math.max(cardW + padX * 2, width + padX * 2),
                height: height,
                children: children,
                roots: roots,
                collapsed: collapsedSet,
                depthMax: depthMax + 1,
            };
        }

        function pathOf(nodes, id) {
            var byId = nodeById(nodes);
            var chain = [];
            var current = byId.get(id);
            var guard = 0;
            while (current !== undefined && guard < 200) {
                chain.unshift(current);
                current = current.parentId === null || current.parentId === undefined ? undefined : byId.get(current.parentId);
                guard += 1;
            }
            return chain;
        }

        function ancestorIdsOf(nodes, ids) {
            var byId = nodeById(nodes);
            var out = new Set();
            for (var id of ids) {
                var current = byId.get(id);
                var guard = 0;
                while (current !== undefined && guard < 200) {
                    if (current.parentId !== null && current.parentId !== undefined) out.add(current.parentId);
                    current = current.parentId === null || current.parentId === undefined ? undefined : byId.get(current.parentId);
                    guard += 1;
                }
            }
            return out;
        }

        function matchesQuery(node, query) {
            if (query === '') return true;
            var text = (node.title + '\n' + (node.summary ?? '') + '\n' + (node.tags ?? []).join(' ') + '\n' + node.id + '\n' + (KIND_LABEL[node.kind] ?? node.kind)).toLowerCase();
            return query.split(/\s+/u).filter(Boolean).every(function (part) { return text.includes(part); });
        }

        function stepNodes(nodes) {
            return nodes
                .filter(function (node) { return node.kind === 'step'; })
                .sort(function (a, b) { return (a.turn ?? 9999) - (b.turn ?? 9999) || (a.order ?? 0) - (b.order ?? 0); });
        }

        /** 每个节点的子树统计：后代总数 + 各 kind 计数（卡片「子树 N」与大纲计数用）。 */
        function computeSubtreeStats(nodes) {
            var children = new Map();
            for (var i = 0; i < nodes.length; i += 1) {
                var parentId = nodes[i].parentId ?? null;
                if (parentId === null) continue;
                if (!children.has(parentId)) children.set(parentId, []);
                children.get(parentId).push(nodes[i]);
            }
            var result = new Map();
            var visit = function (node, guard) {
                if (result.has(node.id)) return result.get(node.id);
                var stats = { total: 0, byKind: {} };
                if (guard > 400) return stats;
                var kids = children.get(node.id) ?? [];
                for (var j = 0; j < kids.length; j += 1) {
                    var sub = visit(kids[j], guard + 1);
                    stats.total += sub.total + 1;
                    Object.keys(sub.byKind).forEach(function (kind) {
                        stats.byKind[kind] = (stats.byKind[kind] ?? 0) + sub.byKind[kind];
                    });
                    stats.byKind[kids[j].kind] = (stats.byKind[kids[j].kind] ?? 0) + 1;
                }
                result.set(node.id, stats);
                return stats;
            };
            for (var k = 0; k < nodes.length; k += 1) visit(nodes[k], 0);
            return result;
        }

        function subtreeText(stats) {
            if (stats === undefined || stats.total === 0) return '';
            var parts = [];
            ['question', 'hypothesis', 'evidence', 'decision', 'conclusion', 'dead_end'].forEach(function (kind) {
                var count = stats.byKind[kind] ?? 0;
                if (count > 0) parts.push(KIND_LABEL[kind] + count);
            });
            return parts.length === 0 ? '子树 ' + stats.total : '子树 ' + stats.total + ' · ' + parts.slice(0, 2).join(' ');
        }

        // ───────────────────────────── 小组件 ─────────────────────────────

        function Dot(props) {
            return h('span', {
                className: 'et-dot',
                style: { background: STATUS_COLOR[props.status] ?? '#8a8a8a' },
                title: STATUS_LABEL[props.status] ?? props.status,
            });
        }

        function KindBadge(props) {
            return h('span', {
                className: 'et-badge',
                style: { color: KIND_COLOR[props.kind] ?? 'inherit' },
                title: KIND_LABEL[props.kind] ?? props.kind,
            }, KIND_LABEL[props.kind] ?? props.kind);
        }

        /** 长摘要默认收起：旧 step 的原始 reasoning 只露摘要，需要时展开。 */
        function CollapsibleSummary(props) {
            var text = typeof props.text === 'string' ? props.text : '';
            var limit = props.limit ?? 280;
            var pair = React.useState(false);
            var expanded = pair[0];
            var setExpanded = pair[1];
            if (text === '') return null;
            if (text.length <= limit) return h('p', { className: 'et-summary' }, text);
            return h('div', null,
                h('p', { className: 'et-summary', 'data-clamped': expanded ? '0' : '1' }, text),
                h('button', {
                    className: 'et-btn et-summary-toggle',
                    onClick: function () { setExpanded(!expanded); },
                }, expanded ? '收起全文' : '展开全文 · ' + text.length + ' 字'),
            );
        }

        function DetailPanel(props) {
            var node = props.node;
            if (node === null || node === undefined) return null;
            var children = props.children ?? [];
            var nodeMap = new Map();
            var allNodes = props.nodes ?? [];
            for (var index = 0; index < allNodes.length; index += 1) nodeMap.set(allNodes[index].id, allNodes[index]);
            var relations = (props.edges ?? []).filter(function (edge) { return edge.from === node.id || edge.to === node.id; });
            return h('div', { className: 'et-section' },
                h('h3', null,
                    h('span', null, '节点详情'),
                    h('button', { className: 'et-btn', onClick: props.onClose, title: '收起详情栏' }, '收起'),
                ),
                h('div', { className: 'et-row' },
                    h(KindBadge, { kind: node.kind }),
                    h('span', { className: 'et-faint' }, node.id),
                    h(Dot, { status: node.status }),
                    h('span', { className: 'et-faint' }, STATUS_LABEL[node.status] ?? node.status),
                    node.confidence === null || node.confidence === undefined ? null : h('span', { className: 'et-faint' }, '置信度 ' + node.confidence),
                    node.hits > 1 ? h('span', { className: 'et-faint' }, '重复 ' + node.hits + ' 次') : null,
                    node.owner ? h('span', { className: 'et-faint' }, '@' + node.owner) : null,
                    node.kind === 'topic' && node.leaseEpoch !== undefined ? h('span', { className: 'et-faint' }, 'epoch ' + node.leaseEpoch) : null,
                    node.nodeVersion !== undefined ? h('span', { className: 'et-faint', title: 'CAS 版本' }, 'v' + node.nodeVersion) : null,
                ),
                h('div', { className: 'et-detail-title' }, node.title),
                node.kind === 'topic'
                    ? h('div', { className: 'et-digest' },
                        h('b', null, '摘要 · 父节点是子节点摘要的摘要'),
                        node.digest !== null && node.digest !== undefined && node.digest !== '' ? node.digest : '（尚未生成）',
                        node.digestHistory && node.digestHistory.length > 1
                            ? h('div', { className: 'et-digest-history' },
                                '历史 ' + node.digestHistory.length + ' 版（rollback 可回滚）：',
                                node.digestHistory.slice(-3).reverse().map(function (item, index) {
                                    return h('div', { key: index, className: 'et-digest-version' }, 'r' + item.revision + ' · ' + item.source + ' · ' + item.digest);
                                }),
                            )
                            : null,
                    )
                    : null,
                h('div', { className: 'et-path', title: '点击路径上的节点可跳转' }, props.path.map(function (item, index) {
                    return h('span', { key: item.id, className: 'et-row', style: { gap: '3px' } },
                        index > 0 ? h('span', { className: 'et-faint' }, '›') : null,
                        h('button', { onClick: function () { props.onFocus(item.id); }, title: item.title }, item.title),
                    );
                })),
                h('div', { className: 'et-row', style: { marginTop: '6px' } },
                    h('button', { className: 'et-btn', onClick: function () { props.onFocus(node.id); } }, '在图中定位'),
                    props.onToggleChildren === undefined ? null : h('button', { className: 'et-btn', onClick: props.onToggleChildren }, props.childrenCollapsed ? '展开子节点' : '收起子节点'),
                ),
                h(CollapsibleSummary, { text: node.summary }),
                node.tags.length > 0 ? h('div', null, node.tags.map(function (tag) { return h('span', { className: 'et-tag', key: tag }, tag); })) : null,
                node.refs.length > 0
                    ? h('div', { style: { marginTop: '12px' } },
                        h('h3', null, '引用'),
                        h('ul', { className: 'et-list' }, node.refs.map(function (ref, index) {
                            return h('li', { key: index, className: 'et-item' },
                                h('div', { className: 'et-item-title' }, h('span', { className: 'et-tag' }, ref.kind), h('span', { className: 'et-faint' }, ref.label ?? '')),
                                h('div', { className: 'et-reason' }, String(ref.value ?? '')),
                            );
                        })),
                    )
                    : null,
                children.length > 0
                    ? h('div', { style: { marginTop: '12px' } },
                        h('h3', null, '子节点 · ' + children.length),
                        h('ul', { className: 'et-list' }, children.slice(0, 24).map(function (child) {
                            return h('li', {
                                key: child.id,
                                className: 'et-item',
                                'data-clickable': '1',
                                onClick: function () { props.onFocus(child.id); },
                            },
                                h('div', { className: 'et-item-title' }, h(KindBadge, { kind: child.kind }), h('span', null, child.title)),
                                child.summary ? h('div', { className: 'et-item-sub' }, child.summary) : null,
                            );
                        })),
                    )
                    : null,
                relations.length > 0
                    ? h('div', { style: { marginTop: '12px' } },
                        h('h3', null, '关系 · ' + relations.length),
                        h('ul', { className: 'et-list' }, relations.slice(0, 16).map(function (edge) {
                            var outgoing = edge.from === node.id;
                            var other = nodeMap.get(outgoing ? edge.to : edge.from);
                            if (other === undefined) return null;
                            return h('li', {
                                key: edge.id,
                                className: 'et-item',
                                'data-clickable': '1',
                                onClick: function () { props.onFocus(other.id); },
                            },
                                h('div', { className: 'et-item-title' },
                                    h('span', { className: 'et-tag' }, edge.kind),
                                    h('span', { className: 'et-faint' }, outgoing ? '→ ' : '← '),
                                    h(KindBadge, { kind: other.kind }),
                                    h('span', null, other.title),
                                ),
                                edge.note ? h('div', { className: 'et-reason' }, edge.note) : null,
                            );
                        })),
                    )
                    : null,
            );
        }

        function OverviewPanel(props) {
            var stats = props.stats ?? {};
            var nodes = props.nodes ?? [];
            var byKind = stats.byKind ?? {};
            var byStatus = stats.byStatus ?? {};
            var roots = props.roots ?? [];
            var openInfo = props.open ?? null;
            var openNodes = Array.isArray(openInfo?.items)
                ? openInfo.items
                : nodes.filter(function (node) { return node.status === 'open' || node.status === 'active'; }).slice(0, 8);
            var openCount = openInfo !== null ? (openInfo.visibleCount ?? openNodes.length)
                : (byStatus.open ?? 0) + (byStatus.active ?? 0);
            var kinds = KIND_ORDER.filter(function (kind) { return (byKind[kind] ?? 0) > 0; });
            var maxKind = kinds.reduce(function (max, kind) { return Math.max(max, byKind[kind] ?? 0); }, 1);
            return h('div', { className: 'et-section' },
                h('h3', null, h('span', null, '图概况'), h('span', { className: 'et-faint', style: { fontWeight: 400, textTransform: 'none' } }, props.workspaceName ?? '')),
                h('div', { className: 'et-overview-grid' },
                    h('div', { className: 'et-overview-cell' }, h('b', null, String(stats.nodes ?? nodes.length)), h('span', null, '节点')),
                    h('div', { className: 'et-overview-cell' }, h('b', null, String(stats.edges ?? 0)), h('span', null, '关系')),
                    h('div', { className: 'et-overview-cell' }, h('b', null, String(props.maxDepth ?? 0)), h('span', null, '层深')),
                    h('div', { className: 'et-overview-cell' }, h('b', null, String(stats.unverifiedHypotheses ?? 0)), h('span', null, '未验证假设')),
                ),
                h('div', { style: { marginTop: '10px' } },
                    h('h3', null, '类型分布（点击过滤）'),
                    kinds.map(function (kind) {
                        var count = byKind[kind] ?? 0;
                        return h('button', {
                            key: kind,
                            className: 'et-chip',
                            style: { color: KIND_COLOR[kind] ?? 'inherit', width: '100%', justifyContent: 'space-between', marginBottom: '3px' },
                            onClick: function () { props.onFilterKind(kind); },
                            title: '只看「' + (KIND_LABEL[kind] ?? kind) + '」',
                        },
                            h('span', null, KIND_LABEL[kind] ?? kind),
                            h('span', null, String(count)),
                        );
                    }),
                ),
                h('div', { style: { marginTop: '10px' } },
                    h('h3', null, '未决 · ' + openCount + ' 未决 / ' + (byStatus.active ?? 0) + ' 进行中'),
                    openNodes.length === 0
                        ? h('p', { className: 'et-hint' }, '没有未决节点。')
                        : h('ul', { className: 'et-list' }, openNodes.map(function (node) {
                            return h('li', {
                                key: node.id,
                                className: 'et-item',
                                'data-clickable': '1',
                                onClick: function () { props.onFocus(node.id); },
                            },
                                h('div', { className: 'et-item-title' }, h(KindBadge, { kind: node.kind }), h('span', null, node.title)),
                                node.summary ? h('div', { className: 'et-item-sub' }, node.summary) : null,
                            );
                        })),
                    openInfo !== null && (openInfo.hiddenCount ?? 0) > 0
                        ? h('p', { className: 'et-hint' }, '已折叠 ' + openInfo.hiddenCount + ' 项：旁白 ' + (openInfo.noiseCount ?? 0) + ' / 旧主题 ' + (openInfo.staleCount ?? 0) + ' / 推理细节 ' + (openInfo.detailCount ?? 0))
                        : null,
                ),
                roots.length > 0
                    ? h('div', { style: { marginTop: '10px' } },
                        h('h3', null, '根节点 · ' + roots.length),
                        h('ul', { className: 'et-list' }, roots.slice(0, 8).map(function (node) {
                            return h('li', {
                                key: node.id,
                                className: 'et-item',
                                'data-clickable': '1',
                                onClick: function () { props.onFocus(node.id); },
                            },
                                h('div', { className: 'et-item-title' }, h(KindBadge, { kind: node.kind }), h('span', null, node.title)),
                            );
                        })),
                    )
                    : null,
            );
        }

        function FrontierPanel(props) {
            var frontier = props.frontier;
            var suggestions = frontier !== null && frontier !== undefined && Array.isArray(frontier.suggestions) ? frontier.suggestions : [];
            var avoid = frontier !== null && frontier !== undefined && Array.isArray(frontier.avoid) ? frontier.avoid : [];
            var notes = frontier !== null && frontier !== undefined && Array.isArray(frontier.notes) ? frontier.notes : [];
            return h('details', { className: 'et-fold', 'data-count': suggestions.length > 0 ? '1' : '0', open: suggestions.length > 0 },
                h('summary', null, '下一步建议 · ' + suggestions.length),
                h('div', { className: 'et-fold-body' },
                    suggestions.length === 0
                        ? h('p', { className: 'et-hint' }, '没有建议。')
                        : h('ul', { className: 'et-list' }, suggestions.slice(0, 6).map(function (suggestion, index) {
                            return h('li', { key: index, className: 'et-item' },
                                h('div', { className: 'et-item-title' },
                                    h('span', { className: 'et-badge', style: { color: '#7a5bd0' } }, SUGGEST_LABEL[suggestion.type] ?? suggestion.type),
                                    h('span', null, suggestion.title),
                                ),
                                h('p', { className: 'et-reason' }, suggestion.reason),
                                suggestion.nodeId !== null && suggestion.nodeId !== undefined
                                    ? h('button', { className: 'et-btn', style: { marginTop: '6px' }, onClick: function () { props.onFocus(suggestion.nodeId); } }, '定位 ' + suggestion.nodeId)
                                    : null,
                            );
                        })),
                    avoid.length > 0
                        ? h('div', { style: { marginTop: '10px' } },
                            h('h3', null, '应避免'),
                            h('ul', { className: 'et-list' }, avoid.slice(0, 6).map(function (item, index) {
                                return h('li', { key: index, className: 'et-item et-avoid' },
                                    h('div', { className: 'et-item-title' }, h('span', { className: 'et-badge', style: { color: '#c0504d' } }, '死路'), h('span', null, item.title)),
                                    h('p', { className: 'et-reason' }, item.reason),
                                );
                            })),
                        )
                        : null,
                    notes.length > 0
                        ? h('div', null, notes.slice(0, 4).map(function (note, index) { return h('p', { key: index, className: 'et-reason' }, note); }))
                        : null,
                ),
            );
        }

        function EmptyState(props) {
            return h('div', { className: 'et-empty' },
                h('h3', { style: { margin: '0 0 8px' } }, '研究图还是空的'),
                h('p', null, '在任意会话里正常工作即可：插件会在旁路把用户目标、轮次步骤、工具动作、产物和结论提取成树。也可以让模型显式调用 ',
                    h('code', null, 'explore_tree_record'), ' 记录假设、证据与死路。'),
                props.workspace !== '' ? h('p', { className: 'et-faint' }, '工作区：' + props.workspace) : null,
                h('button', { className: 'et-btn', style: { marginTop: '12px' }, onClick: props.onRefresh }, '立即刷新'),
            );
        }

        // ───────────────────────────── 画布 ─────────────────────────────

        /** 左侧大纲：目标 + 轮次，快速定位长树里的任意分支。 */
        function OutlinePanel(props) {
            var goals = props.roots ?? [];
            var steps = props.steps ?? [];
            var renderItem = function (node, turnLabel) {
                var stats = props.subtreeStats.get(node.id);
                return h('li', { key: node.id },
                    h('button', {
                        className: 'et-outline-item',
                        'data-active': props.selectedId === node.id ? '1' : '0',
                        title: node.title,
                        onClick: function () { props.onFocus(node.id); },
                    },
                        turnLabel !== null ? h('span', { className: 'et-outline-turn' }, turnLabel) : null,
                        h('span', { className: 'et-outline-title' }, node.title),
                        h('span', { className: 'et-outline-count' }, stats === undefined ? '' : String(stats.total)),
                    ),
                );
            };
            if (props.trunk) {
                var items = props.trunkItems ?? [];
                return h('div', { className: 'et-outline et-section' },
                    h('h3', null, '主干大纲'),
                    items.length === 0
                        ? h('div', { className: 'et-faint', style: { fontSize: '11px' } }, '还没有主干：用 record add kind=topic 建主题，再把叶根挂到主题下。')
                        : h('ul', { className: 'et-outline-list' }, items.map(function (item) {
                            var stats = props.subtreeStats.get(item.node.id);
                            return h('li', { key: item.node.id },
                                h('button', {
                                    className: 'et-outline-item',
                                    'data-active': props.selectedId === item.node.id ? '1' : '0',
                                    title: item.node.title,
                                    style: { '--et-depth': String(item.depth) },
                                    onClick: function () { props.onFocus(item.node.id); },
                                },
                                    h('span', { className: 'et-outline-title' }, item.node.title),
                                    h('span', { className: 'et-outline-count' }, stats === undefined ? '' : String(stats.total)),
                                ),
                            );
                        })),
                );
            }
            return h('div', { className: 'et-outline et-section' },
                h('h3', null, '大纲'),
                goals.length > 0 ? h('div', { className: 'et-faint', style: { fontSize: '10.5px', margin: '0 0 4px' } }, '目标') : null,
                h('ul', { className: 'et-outline-list' }, goals.map(function (goal) { return renderItem(goal, 'G'); })),
                steps.length > 0 ? h('div', { className: 'et-faint', style: { fontSize: '10.5px', margin: '8px 0 4px' } }, '轮次') : null,
                h('ul', { className: 'et-outline-list' }, steps.map(function (step) {
                    return renderItem(step, step.turn !== null && step.turn !== undefined ? 'T' + step.turn : '?');
                })),
            );
        }

        function TreeCanvas(props) {
            var layout = props.layout;
            var dims = props.dims;
            var rowById = new Map();
            for (var i = 0; i < layout.rows.length; i += 1) rowById.set(layout.rows[i].node.id, layout.rows[i]);

            var propsRef = React.useRef(props);
            propsRef.current = props;
            var dragRef = React.useRef(null);
            var suppressClickRef = React.useRef(false);

            // 选中卡片滚动到可视区：手算 scrollLeft/scrollTop，避免 scrollIntoView 把整页也滚走。
            React.useEffect(function () {
                var canvas = props.canvasRef !== null && props.canvasRef !== undefined ? props.canvasRef.current : null;
                if (canvas === null || canvas === undefined) return;
                var current = propsRef.current;
                var id = current.selectedId;
                if (id === null || id === undefined) return;
                var row = null;
                for (var i = 0; i < current.layout.rows.length; i += 1) {
                    if (current.layout.rows[i].node.id === id) { row = current.layout.rows[i]; break; }
                }
                if (row === null) return;
                var pad = 28;
                var left = row.x * current.zoom;
                var top = row.y * current.zoom;
                var right = left + current.dims.cardW * current.zoom;
                var bottom = top + current.dims.cardH * current.zoom;
                if (left - pad < canvas.scrollLeft) canvas.scrollLeft = Math.max(0, left - pad);
                else if (right + pad > canvas.scrollLeft + canvas.clientWidth) canvas.scrollLeft = right + pad - canvas.clientWidth;
                if (top - pad < canvas.scrollTop) canvas.scrollTop = Math.max(0, top - pad);
                else if (bottom + pad > canvas.scrollTop + canvas.clientHeight) canvas.scrollTop = bottom + pad - canvas.clientHeight;
            }, [props.selectedId]);

            // 缩放锚点：把缩放前指针下的那个点固定在原位（按钮缩放取视口中心）。
            React.useEffect(function () {
                var canvas = props.canvasRef !== null && props.canvasRef !== undefined ? props.canvasRef.current : null;
                var anchorRef = props.zoomAnchorRef;
                if (canvas === null || canvas === undefined || anchorRef === null || anchorRef === undefined) return;
                var anchor = anchorRef.current;
                if (!anchor) return;
                anchorRef.current = null;
                var maxLeft = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
                var maxTop = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
                canvas.scrollLeft = Math.min(maxLeft, Math.max(0, anchor.fx * canvas.scrollWidth - anchor.vx));
                canvas.scrollTop = Math.min(maxTop, Math.max(0, anchor.fy * canvas.scrollHeight - anchor.vy));
            }, [props.zoom]);

            // 拖动平移 / Ctrl(⌘)+滚轮缩放 / 双击空白适应宽度。
            React.useEffect(function () {
                if (typeof document === 'undefined') return undefined;
                var canvas = props.canvasRef !== null && props.canvasRef !== undefined ? props.canvasRef.current : null;
                if (canvas === null || canvas === undefined) return undefined;

                function isControl(target) {
                    if (target === null || target === undefined || typeof target.closest !== 'function') return false;
                    return target.closest('button,a,input,textarea,select,summary') !== null;
                }
                function clearDrag() {
                    dragRef.current = null;
                    canvas.classList.remove('et-dragging');
                }
                function onPointerDown(event) {
                    if (event.pointerType === 'touch') return;
                    if (event.button !== 0 && event.button !== 1) return;
                    if (isControl(event.target)) return;
                    event.preventDefault();
                    dragRef.current = {
                        id: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        left: canvas.scrollLeft,
                        top: canvas.scrollTop,
                        moved: false,
                    };
                    canvas.classList.add('et-dragging');
                    if (typeof canvas.setPointerCapture === 'function') {
                        try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* 某些浏览器不支持，忽略 */ }
                    }
                }
                function onPointerMove(event) {
                    var drag = dragRef.current;
                    if (drag === null || drag === undefined || drag.id !== event.pointerId) return;
                    var dx = event.clientX - drag.x;
                    var dy = event.clientY - drag.y;
                    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
                    if (!drag.moved) return;
                    var maxLeft = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
                    var maxTop = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
                    canvas.scrollLeft = Math.min(maxLeft, Math.max(0, drag.left - dx));
                    canvas.scrollTop = Math.min(maxTop, Math.max(0, drag.top - dy));
                }
                function onPointerUp(event) {
                    var drag = dragRef.current;
                    if (drag === null || drag === undefined || drag.id !== event.pointerId) return;
                    if (drag.moved) {
                        suppressClickRef.current = true;
                        window.setTimeout(function () { suppressClickRef.current = false; }, 0);
                    }
                    clearDrag();
                    if (typeof canvas.releasePointerCapture === 'function') {
                        try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
                    }
                }
                function onClickCapture(event) {
                    if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        event.stopPropagation();
                        event.preventDefault();
                    }
                }
                function onWheel(event) {
                    if (event.ctrlKey || event.metaKey) {
                        event.preventDefault();
                        var rect = canvas.getBoundingClientRect();
                        var factor = Math.max(0.75, Math.min(1.33, Math.exp(-event.deltaY * 0.0015)));
                        var current = propsRef.current;
                        if (typeof current.onZoom === 'function') {
                            current.onZoom(current.zoom * factor, {
                                vx: event.clientX - rect.left,
                                vy: event.clientY - rect.top,
                            });
                        }
                        return;
                    }
                    if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                        event.preventDefault();
                        canvas.scrollLeft += event.deltaY;
                    }
                }
                function onDoubleClick(event) {
                    if (isControl(event.target)) return;
                    if (event.target !== null && event.target !== undefined && typeof event.target.closest === 'function' && event.target.closest('[data-node-id]') !== null) return;
                    if (typeof propsRef.current.onFitWidth === 'function') propsRef.current.onFitWidth();
                }
                function onMouseDown(event) {
                    if (event.button === 1) event.preventDefault();
                }
                canvas.addEventListener('pointerdown', onPointerDown);
                canvas.addEventListener('pointermove', onPointerMove);
                canvas.addEventListener('pointerup', onPointerUp);
                canvas.addEventListener('pointercancel', onPointerUp);
                canvas.addEventListener('click', onClickCapture, true);
                canvas.addEventListener('wheel', onWheel, { passive: false });
                canvas.addEventListener('dblclick', onDoubleClick);
                canvas.addEventListener('mousedown', onMouseDown);
                return function () {
                    canvas.removeEventListener('pointerdown', onPointerDown);
                    canvas.removeEventListener('pointermove', onPointerMove);
                    canvas.removeEventListener('pointerup', onPointerUp);
                    canvas.removeEventListener('pointercancel', onPointerUp);
                    canvas.removeEventListener('click', onClickCapture, true);
                    canvas.removeEventListener('wheel', onWheel);
                    canvas.removeEventListener('dblclick', onDoubleClick);
                    canvas.removeEventListener('mousedown', onMouseDown);
                };
            }, [layout.rows.length]);

            if (layout.rows.length === 0) {
                return h('div', { className: 'et-empty et-faint' }, '当前筛选下没有可见节点。');
            }

            var edges = [];
            for (var e = 0; e < layout.rows.length; e += 1) {
                var row = layout.rows[e];
                if (row.node.parentId === null || row.node.parentId === undefined) continue;
                var parentRow = rowById.get(row.node.parentId);
                if (parentRow === undefined) continue;
                var x1 = parentRow.x + dims.cardW / 2;
                var y1 = parentRow.y + dims.cardH;
                var x2 = row.x + dims.cardW / 2;
                var y2 = row.y;
                var midY = y1 + dims.gapY * 0.5;
                var onPath = props.pathIds !== null && props.pathIds.has(row.node.id) && props.pathIds.has(row.node.parentId);
                edges.push(h('path', {
                    key: 'e-' + row.node.id,
                    d: 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2,
                    fill: 'none',
                    stroke: onPath ? 'var(--dsw-alias-state-business-primary,#4d6bfe)' : 'rgba(128,140,170,.5)',
                    strokeWidth: onPath ? 2 : 1.3,
                }));
            }

            // 跨轮/跨分支关系边：树线只表达 parentId，研究推进关系画成虚线。
            var edgeColors = {
                supports: '#3fa66a',
                contradicts: '#d05555',
                refines: '#4d6bfe',
                depends: '#8a6fd1',
                replaces: '#c9793a',
                duplicates: '#9aa3b5',
                continues: '#9aa3b5',
                related: '#9aa3b5',
            };
            var graphEdges = props.edges ?? [];
            for (var g = 0; g < graphEdges.length; g += 1) {
                var relation = graphEdges[g];
                var fromRow = rowById.get(relation.from);
                var toRow = rowById.get(relation.to);
                if (fromRow === undefined || toRow === undefined) continue;
                var relationActive = props.selectedId === relation.from || props.selectedId === relation.to;
                var ex1 = fromRow.x + dims.cardW / 2;
                var ey1 = fromRow.y + dims.cardH / 2;
                var ex2 = toRow.x + dims.cardW / 2;
                var ey2 = toRow.y + dims.cardH / 2;
                var cx1 = ex1 + (ex2 - ex1) * 0.3;
                var cy1 = ey1 + (ey2 - ey1) * 0.3 + 14;
                var cx2 = ex1 + (ex2 - ex1) * 0.7;
                var cy2 = ey1 + (ey2 - ey1) * 0.7 - 14;
                edges.push(h('path', {
                    key: 'r-' + relation.id,
                    d: 'M ' + ex1 + ' ' + ey1 + ' C ' + cx1 + ' ' + cy1 + ', ' + cx2 + ' ' + cy2 + ', ' + ex2 + ' ' + ey2,
                    fill: 'none',
                    stroke: edgeColors[relation.kind] ?? '#9aa3b5',
                    strokeOpacity: relationActive ? 0.95 : 0.28,
                    strokeWidth: relationActive ? 1.9 : 1.1,
                    strokeDasharray: relationActive ? null : '4 4',
                }, h('title', null, relation.kind + '：' + relation.from + ' → ' + relation.to + (relation.note ? '（' + relation.note + '）' : ''))));
            }

            return h('div', {
                className: 'et-canvas',
                ref: props.canvasRef,
                title: '拖动平移 · Ctrl/⌘ + 滚轮缩放 · 双击空白处适应宽度',
            },
                h('div', { className: 'et-graph-zoom', style: { width: layout.width * props.zoom + 'px', height: layout.height * props.zoom + 'px' } },
                    h('div', {
                        className: 'et-graph',
                        style: {
                            width: layout.width + 'px',
                            height: layout.height + 'px',
                            transform: 'scale(' + props.zoom + ')',
                        },
                    },
                        h('svg', { width: layout.width, height: layout.height, style: { position: 'absolute', inset: 0, pointerEvents: 'none' } }, edges),
                        layout.rows.map(function (row) {
                            var node = row.node;
                            var kids = layout.children.get(node.id) ?? [];
                            var isCollapsed = layout.collapsed.has(node.id);
                            var dim = (props.dimmedIds !== null && props.dimmedIds.has(node.id)) || (props.matchedIds !== null && !props.matchedIds.has(node.id) && props.matchedIds.size > 0);
                            if (node.id === props.selectedId) dim = false;
                            var matched = props.matchedIds !== null && props.matchedIds.has(node.id);
                            return h('div', {
                                key: node.id,
                                className: 'et-card',
                                role: 'button',
                                tabIndex: 0,
                                'data-node-id': node.id,
                                'data-selected': props.selectedId === node.id ? '1' : '0',
                                'data-dim': dim ? '1' : '0',
                                'data-kind': node.kind,
                                'data-compact': props.compact ? '1' : '0',
                                'data-matched': matched ? '1' : '0',
                                style: {
                                    left: row.x + 'px',
                                    top: row.y + 'px',
                                    width: dims.cardW + 'px',
                                    height: dims.cardH + 'px',
                                    borderTop: '3px solid ' + (KIND_COLOR[node.kind] ?? '#888'),
                                    opacity: dim ? 0.24 : (node.status === 'abandoned' ? 0.7 : 1),
                                },
                                title: node.title + (node.summary ? '\n' + node.summary : ''),
                                onClick: function () { props.onSelect(node.id); },
                                onKeyDown: function (event) { if (event.key === 'Enter' || event.key === ' ') props.onSelect(node.id); },
                            },
                                h('div', { className: 'et-card-head' },
                                    h('span', { className: 'et-card-badge', style: { color: KIND_COLOR[node.kind] ?? 'inherit' } }, KIND_LABEL[node.kind] ?? node.kind),
                                    h('span', { className: 'et-card-meta' }, node.id
                                        + (node.hits > 1 ? ' · ×' + node.hits : '')
                                        + (node.owner ? ' · @' + node.owner : '')
                                        + (matched ? ' · 匹配' : '')),
                                    (node.tags ?? []).includes('llm')
                                        ? h('span', { className: 'et-card-ai', title: 'LLM 辅助提取' }, 'AI')
                                        : null,
                                ),
                                h('div', { className: 'et-card-title' }, node.title),
                                node.kind === 'topic' && node.digest
                                    ? h('div', { className: 'et-card-digest', title: node.digest }, node.digest)
                                    : (node.summary ? h('div', { className: 'et-card-summary' }, node.summary) : null),
                                h('div', { className: 'et-card-foot' },
                                    h(Dot, { status: node.status }),
                                    h('span', null, STATUS_LABEL[node.status] ?? node.status),
                                    node.kind === 'topic' && props.topicProgress && props.topicProgress.get(node.id)
                                        ? h('span', { className: 'et-card-sub', title: '主题进度' },
                                            '叶 ' + props.topicProgress.get(node.id).done + '/' + props.topicProgress.get(node.id).total)
                                        : null,
                                    props.subtreeStats && (props.subtreeStats.get(node.id)?.total ?? 0) > 0
                                        ? h('span', { className: 'et-card-sub', title: '子树聚合' }, subtreeText(props.subtreeStats.get(node.id)))
                                        : null,
                                    kids.length > 0
                                        ? h('button', {
                                            className: 'et-card-toggle',
                                            title: isCollapsed ? '展开 ' + kids.length + ' 个子节点' : '收起子节点',
                                            onClick: function (event) { event.stopPropagation(); props.onToggle(node.id); },
                                        }, isCollapsed ? '▸ ' + kids.length : '▾')
                                        : null,
                                ),
                            );
                        }),
                    ),
                ),
            );
        }

        // ───────────────────────────── 侧边栏预览 ─────────────────────────────

        function previewGoalOf(snapshot, sessionId) {
            var nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            var byId = nodeById(nodes);
            var sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
            var session = sessions.find(function (item) {
                return item !== null && typeof item === 'object' && (item.sessionId === sessionId || item.id === sessionId);
            });
            if (session !== undefined && session !== null && typeof session.goalId === 'string') {
                var known = byId.get(session.goalId);
                if (known !== undefined) return known;
            }
            var goals = nodes.filter(function (node) { return node.kind === 'goal'; });
            goals.sort(function (a, b) {
                return String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''));
            });
            return goals.length > 0 ? goals[0] : null;
        }

        /**
         * 右侧栏预览：当前会话目标、未决前 3 与第一条建议。
         * 只读 GET /explore-tree/snapshot；完整画布仍在 conversation.view 的「研究轨迹」页签。
         */
        function ResearchTreePreview(props) {
            var sessionCwd = readSessionWorkspace(props);
            var pair = React.useState({ loading: true, error: '', snapshot: null });
            var state = pair[0];
            var setState = pair[1];
            var prefs = usePrefs();
            var aliveRef = React.useRef(true);
            var timerRef = React.useRef(null);

            var refresh = React.useCallback(function () {
                var remembered = readStoredWorkspace(props.sessionId);
                var wanted = sessionCwd !== '' ? sessionCwd : remembered;
                var query = wanted !== '' ? '?workspace=' + encodeURIComponent(wanted) : '';
                fetchJson('/explore-tree/snapshot' + query)
                    .then(function (snapshot) {
                        if (!aliveRef.current) return;
                        setState({ loading: false, error: '', snapshot: snapshot });
                        if (typeof snapshot?.workspace?.root === 'string' && snapshot.workspace.root !== '') {
                            storeWorkspace(props.sessionId, snapshot.workspace.root);
                        }
                    })
                    .catch(function (error) {
                        if (!aliveRef.current) return;
                        setState(function (previous) {
                            return { ...previous, loading: false, error: String(error && error.message ? error.message : error) };
                        });
                    });
            }, [props.sessionId, sessionCwd]);

            React.useEffect(function () {
                aliveRef.current = true;
                refresh();
                return function () { aliveRef.current = false; };
            }, [refresh]);

            React.useEffect(function () {
                if (!prefs.autoRefresh) return undefined;
                timerRef.current = setInterval(function () { refresh(); }, REFRESH_MS);
                return function () { if (timerRef.current !== null) clearInterval(timerRef.current); };
            }, [refresh, prefs.autoRefresh]);

            var snapshot = state.snapshot;
            var nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            var stats = snapshot?.stats ?? {};
            var openInfo = snapshot?.open ?? null;
            var openItems = Array.isArray(openInfo?.items) ? openInfo.items.slice(0, 3) : [];
            var goal = previewGoalOf(snapshot, props.sessionId);
            var suggestions = Array.isArray(snapshot?.frontier?.suggestions) ? snapshot.frontier.suggestions : [];
            var suggestion = suggestions.length > 0 ? suggestions[0] : null;
            var workspaceName = typeof snapshot?.workspace?.name === 'string' && snapshot.workspace.name !== ''
                ? snapshot.workspace.name
                : (sessionCwd !== '' ? workspaceLabel({ path: sessionCwd }) : '当前会话工作区');
            var openCount = stats.openUnresolved ?? (openInfo !== null ? openInfo.visibleCount : 0);

            return h('div', { className: 'et-preview-root', 'data-plugin': 'dsh-explore-tree' },
                h('style', null, CSS),
                h('div', { className: 'et-preview-head' },
                    h('h2', null, '研究轨迹'),
                    h('span', { className: 'et-preview-ws', title: snapshot?.workspace?.root ?? sessionCwd }, workspaceName),
                    h('span', { className: 'et-spacer' }),
                    h('button', { type: 'button', className: 'et-btn', onClick: refresh, disabled: state.loading }, state.loading ? '读取中' : '刷新'),
                ),
                state.loading && snapshot === null
                    ? h('p', { className: 'et-preview-hint' }, '正在读取研究图…')
                    : null,
                state.error !== ''
                    ? h('p', { className: 'et-preview-hint et-err' }, '读取失败：' + state.error)
                    : null,
                snapshot !== null
                    ? h(React.Fragment, null,
                        h('div', { className: 'et-preview-metrics' },
                            h('div', { className: 'et-preview-metric' }, h('b', null, String(stats.nodes ?? nodes.length)), h('span', null, '节点')),
                            h('div', { className: 'et-preview-metric' }, h('b', null, String(openCount)), h('span', null, '未决')),
                            h('div', { className: 'et-preview-metric' }, h('b', null, String(stats.edges ?? 0)), h('span', null, '关系')),
                        ),
                        h('div', { className: 'et-preview-section' },
                            h('div', { className: 'et-preview-label' }, '当前目标'),
                            goal !== null
                                ? h('div', { className: 'et-preview-goal' }, goal.title)
                                : h('p', { className: 'et-preview-hint' }, '还没有目标；在会话里提出任务后自动建立。'),
                        ),
                        h('div', { className: 'et-preview-section' },
                            h('div', { className: 'et-preview-label' }, '未决 · ' + openCount),
                            openItems.length > 0
                                ? openItems.map(function (node) {
                                    return h('details', { key: node.id, className: 'et-preview-item' },
                                        h('summary', null,
                                            h(KindBadge, { kind: node.kind }),
                                            h('span', null, node.title),
                                        ),
                                        node.summary ? h('p', { className: 'et-preview-sub' }, node.summary) : null,
                                    );
                                })
                                : h('p', { className: 'et-preview-hint' }, '没有可见未决项。'),
                            openInfo !== null && (openInfo.hiddenCount ?? 0) > 0
                                ? h('p', { className: 'et-preview-hint' }, '另有 ' + openInfo.hiddenCount + ' 项已折叠。')
                                : null,
                        ),
                        suggestion !== null
                            ? h('div', { className: 'et-preview-section et-preview-next' },
                                h('div', { className: 'et-preview-label' }, '下一步建议'),
                                h('div', { className: 'et-preview-goal' },
                                    h('span', { className: 'et-badge', style: { color: '#7a5bd0', marginRight: '5px' } }, SUGGEST_LABEL[suggestion.type] ?? suggestion.type),
                                    suggestion.title,
                                ),
                                suggestion.reason ? h('p', { className: 'et-reason' }, suggestion.reason) : null,
                            )
                            : null,
                        h('p', { className: 'et-preview-foot' }, '完整视图见会话上方的「研究轨迹」页签。'),
                    )
                    : null,
            );
        }

        // ───────────────────────────── 设置页 ─────────────────────────────

        function ToggleRow(props) {
            return h('label', { className: 'et-set-row' },
                h('span', { className: 'et-set-row-main' },
                    h('span', { className: 'et-set-row-title' }, props.title),
                    h('span', { className: 'et-set-row-desc' }, props.desc),
                ),
                h('input', {
                    type: 'checkbox',
                    className: 'et-set-check',
                    checked: props.checked,
                    onChange: function (event) { props.onChange(event.target.checked); },
                }),
            );
        }

        function ExploreTreeSettings() {
            var prefs = usePrefs();
            return h('section', { className: 'et-set-root', 'data-plugin': 'dsh-explore-tree' },
                h('style', null, CSS),
                h('div', { className: 'et-set-head' },
                    h('h2', null, '研究轨迹'),
                    h('p', null, '研究轨迹面板的显示与过滤偏好。修改立即生效，保存在当前浏览器；不影响研究图数据。'),
                ),
                h('div', { className: 'et-set-group' },
                    h('h3', null, '显示'),
                    h(ToggleRow, {
                        title: '自动刷新',
                        desc: '每 3 秒读取一次研究图；关闭后只在切回面板或手动刷新时更新。',
                        checked: prefs.autoRefresh,
                        onChange: function (value) { setPref('autoRefresh', value); },
                    }),
                    h(ToggleRow, {
                        title: '紧凑模式',
                        desc: '用更小的卡片显示，一屏看到更多节点。',
                        checked: prefs.compact,
                        onChange: function (value) { setPref('compact', value); },
                    }),
                    h(ToggleRow, {
                        title: '大纲',
                        desc: '显示左侧大纲，快速跳转目标与步骤。',
                        checked: prefs.showOutline,
                        onChange: function (value) { setPref('showOutline', value); },
                    }),
                    h(ToggleRow, {
                        title: '详情栏',
                        desc: '显示右侧节点详情；关闭后画布更宽。',
                        checked: prefs.showInspector,
                        onChange: function (value) { setPref('showInspector', value); },
                    }),
                ),
                h('div', { className: 'et-set-group' },
                    h('h3', null, '过滤'),
                    h(ToggleRow, {
                        title: '隐藏动作',
                        desc: '过滤掉工具调用动作节点。',
                        checked: prefs.hideActions,
                        onChange: function (value) { setPref('hideActions', value); },
                    }),
                    h(ToggleRow, {
                        title: '隐藏产物',
                        desc: '过滤掉产物节点；需要查看文件时再打开。',
                        checked: prefs.hideArtifacts,
                        onChange: function (value) { setPref('hideArtifacts', value); },
                    }),
                    h(ToggleRow, {
                        title: '隐藏笔记',
                        desc: '过滤掉笔记节点（旧图里多为过程旁白）。',
                        checked: prefs.hideNotes,
                        onChange: function (value) { setPref('hideNotes', value); },
                    }),
                    h(ToggleRow, {
                        title: '只看未决',
                        desc: '非未决节点变淡显示，便于聚焦当前问题。',
                        checked: prefs.onlyOpen,
                        onChange: function (value) { setPref('onlyOpen', value); },
                    }),
                    h(ToggleRow, {
                        title: '仅本会话',
                        desc: '只显示当前会话创建的节点；研究树默认跨会话共享。',
                        checked: prefs.onlySession,
                        onChange: function (value) { setPref('onlySession', value); },
                    }),
                ),
                h('div', { className: 'et-set-actions' },
                    h('button', { type: 'button', className: 'et-set-btn', onClick: resetPrefs }, '恢复默认'),
                    h('span', { className: 'et-set-note' }, '恢复默认不会改动研究图，只重置本页偏好。'),
                ),
            );
        }

        // ───────────────────────────── 主面板 ─────────────────────────────

        var EMPTY_STATE = {
            loading: true,
            error: '',
            workspaces: [],
            workspace: '',
            snapshot: null,
            selectedId: null,
            kindFilter: null,
            collapsed: {},
            zoom: 1,
            zoomTouched: false,
            view: 'auto',
            query: '',
        };

        function currentWorkspaceName(state) {
            var list = Array.isArray(state.workspaces) ? state.workspaces : [];
            for (var i = 0; i < list.length; i += 1) {
                if (sameRoot(workspacePath(list[i]), state.workspace)) return workspaceLabel(list[i]);
            }
            return state.workspace !== '' ? state.workspace : '当前会话工作区';
        }

        function clampZoom(value) {
            return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
        }

        function ExploreTreePanel(props) {
            var sessionCwd = readSessionWorkspace(props);
            var statePair = React.useState(EMPTY_STATE);
            var state = statePair[0];
            var setState = statePair[1];
            var prefs = usePrefs();
            var timerRef = React.useRef(null);
            var aliveRef = React.useRef(true);
            var canvasRef = React.useRef(null);
            var zoomAnchorRef = React.useRef(null);

            var refresh = React.useCallback(function () {
                fetchJson('/explore-tree/workspaces')
                    .then(function (payload) {
                        if (!aliveRef.current) return null;
                        var workspaces = Array.isArray(payload?.workspaces) ? payload.workspaces : workspaceItems(payload);
                        var known = function (value) {
                            return value !== '' && workspaces.some(function (workspace) { return sameRoot(workspacePath(workspace), value); });
                        };
                        var remembered = readStoredWorkspace(props.sessionId);
                        var wanted = sessionCwd !== ''
                            ? sessionCwd
                            : (known(remembered)
                                ? remembered
                                : (workspaces[0] !== undefined ? workspacePath(workspaces[0]) : ''));
                        var query = wanted !== '' ? '?workspace=' + encodeURIComponent(wanted) : '';
                        return fetchJson('/explore-tree/snapshot' + query).then(function (snapshot) {
                            return { workspaces: workspaces, snapshot: snapshot };
                        });
                    })
                    .then(function (result) {
                        if (result === null || result === undefined || !aliveRef.current) return;
                        var snapshot = result.snapshot;
                        var chosen = typeof snapshot?.workspace?.root === 'string' && snapshot.workspace.root !== ''
                            ? snapshot.workspace.root
                            : '';
                        if (chosen !== '') storeWorkspace(props.sessionId, chosen);
                        setState(function (previous) {
                            var collapsed = Object.assign({}, previous.collapsed);
                            var counts = {};
                            var kindById = {};
                            var list = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
                            for (var i = 0; i < list.length; i += 1) {
                                kindById[list[i].id] = list[i].kind;
                                if (list[i].parentId !== null && list[i].parentId !== undefined) {
                                    counts[list[i].parentId] = (counts[list[i].parentId] ?? 0) + 1;
                                }
                            }
                            // 子节点特别多的节点默认折叠，先给一张「关键节点」总览；用户展开后记住选择。
                            // goal/topic 是主干锚点，默认始终展开（否则主干视图只剩几个空目标卡）。
                            Object.keys(counts).forEach(function (id) {
                                var kind = kindById[id];
                                if (counts[id] > 8 && kind !== 'goal' && kind !== 'topic' && collapsed[id] === undefined) collapsed[id] = true;
                            });
                            var stillExists = previous.selectedId !== null
                                && Array.isArray(snapshot?.nodes)
                                && snapshot.nodes.some(function (node) { return node.id === previous.selectedId; });
                            return {
                                loading: false,
                                error: '',
                                workspaces: result.workspaces,
                                workspace: chosen,
                                snapshot: snapshot,
                                selectedId: stillExists ? previous.selectedId : (snapshot?.focus ?? null),
                                kindFilter: previous.kindFilter,
                                collapsed: collapsed,
                                zoom: previous.zoom,
                                zoomTouched: previous.zoomTouched,
                                view: previous.view,
                                query: previous.query,
                            };
                        });
                    })
                    .catch(function (error) {
                        if (!aliveRef.current) return;
                        setState(function (previous) {
                            return { ...previous, loading: false, error: String(error && error.message ? error.message : error) };
                        });
                    });
            }, [props.sessionId, sessionCwd]);

            React.useEffect(function () {
                aliveRef.current = true;
                refresh();
                return function () { aliveRef.current = false; };
            }, [refresh, props.sessionId, sessionCwd]);

            React.useEffect(function () {
                if (!prefs.autoRefresh) return undefined;
                timerRef.current = setInterval(function () { refresh(); }, REFRESH_MS);
                return function () { if (timerRef.current !== null) clearInterval(timerRef.current); };
            }, [refresh, prefs.autoRefresh]);

            // 右侧栏预览是插件可选能力：第一次进入某个会话的研究轨迹页时自动展开一次，
            // 让用户不用先找「右侧栏」入口；之后关掉就由工具栏按钮重新打开。
            React.useEffect(function () {
                var sessionKey = typeof props.sessionId === 'string' ? props.sessionId : '';
                if (sessionKey === '' || sidebarPreviewAutoOpened[sessionKey] === true) return;
                if (sidebarPreviewOpen === null) {
                    sidebarPreviewPending = sessionKey;
                    return;
                }
                sidebarPreviewAutoOpened[sessionKey] = true;
                sidebarPreviewOpen();
            }, [props.sessionId]);

            var snapshot = state.snapshot;
            var nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            var edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
            var stats = snapshot?.stats ?? {};

            var hasTopics = React.useMemo(function () {
                return nodes.some(function (node) { return node.kind === 'topic'; });
            }, [nodes]);
            var effectiveView = state.view === 'auto' ? (hasTopics ? 'trunk' : 'study') : state.view;

            var scopeNodes = React.useMemo(function () {
                if (!prefs.onlySession || !props.sessionId) return nodes;
                return nodes.filter(function (node) { return node.sessionId === props.sessionId; });
            }, [nodes, prefs.onlySession, props.sessionId]);

            var viewNodes = React.useMemo(function () {
                if (effectiveView !== 'trunk' || !hasTopics) return scopeNodes;
                // 主干视图只保留「已经建了主题」的目标，避免旧图里未建主干的 goal 占满画布。
                return scopeNodes.filter(function (node) {
                    if (node.kind !== 'goal') return true;
                    return scopeNodes.some(function (child) { return child.parentId === node.id && child.kind === 'topic'; });
                });
            }, [scopeNodes, effectiveView, hasTopics]);

            var visibleNodes = React.useMemo(function () {
                return visibleTree(viewNodes, {
                    hideActions: prefs.hideActions,
                    hideArtifacts: prefs.hideArtifacts,
                    hideNotes: prefs.hideNotes,
                    kindFilter: state.kindFilter,
                    trunkOnly: effectiveView === 'trunk',
                });
            }, [viewNodes, prefs.hideActions, prefs.hideArtifacts, prefs.hideNotes, state.kindFilter, effectiveView]);
            var subtreeStats = React.useMemo(function () { return computeSubtreeStats(visibleNodes); }, [visibleNodes]);

            var topicProgress = React.useMemo(function () {
                var map = new Map();
                var byId = nodeById(nodes);
                for (var i = 0; i < nodes.length; i += 1) {
                    var node = nodes[i];
                    if (LEAF_ROOT_KINDS.indexOf(node.kind) < 0) continue;
                    var parent = node.parentId === null || node.parentId === undefined ? undefined : byId.get(node.parentId);
                    if (parent === undefined || parent.kind !== 'topic') continue;
                    var entry = map.get(parent.id) ?? { total: 0, done: 0, open: 0 };
                    entry.total += 1;
                    if (node.status === 'done') entry.done += 1;
                    if (node.status === 'open' || node.status === 'active') entry.open += 1;
                    map.set(parent.id, entry);
                }
                return map;
            }, [nodes]);

            var trunkItems = React.useMemo(function () {
                if (effectiveView !== 'trunk') return [];
                var ids = new Set();
                for (var i = 0; i < visibleNodes.length; i += 1) ids.add(visibleNodes[i].id);
                var byParent = new Map();
                for (var j = 0; j < visibleNodes.length; j += 1) {
                    var parentId = visibleNodes[j].parentId ?? null;
                    if (parentId === null || !ids.has(parentId)) continue;
                    if (!byParent.has(parentId)) byParent.set(parentId, []);
                    byParent.get(parentId).push(visibleNodes[j]);
                }
                var items = [];
                var walk = function (node, depth) {
                    items.push({ node: node, depth: depth });
                    var kids = byParent.get(node.id) ?? [];
                    for (var k = 0; k < kids.length; k += 1) walk(kids[k], depth + 1);
                };
                for (var r = 0; r < visibleNodes.length; r += 1) {
                    var rootParent = visibleNodes[r].parentId ?? null;
                    if (rootParent === null || !ids.has(rootParent)) walk(visibleNodes[r], 0);
                }
                return items;
            }, [visibleNodes, effectiveView]);

            var query = state.query.trim().toLowerCase();
            var matches = React.useMemo(function () {
                if (query === '') return [];
                return scopeNodes.filter(function (node) { return matchesQuery(node, query); });
            }, [scopeNodes, query]);
            var matchedIds = React.useMemo(function () {
                var set = new Set();
                for (var i = 0; i < matches.length; i += 1) set.add(matches[i].id);
                return set;
            }, [matches]);
            var forcedExpand = React.useMemo(function () {
                return ancestorIdsOf(nodes, query === '' ? [] : matches.map(function (node) { return node.id; }));
            }, [nodes, query, matches]);

            var effectiveCollapsed = React.useMemo(function () {
                var set = new Set();
                var source = state.collapsed ?? {};
                Object.keys(source).forEach(function (id) { if (source[id] === true) set.add(id); });
                forcedExpand.forEach(function (id) { set.delete(id); });
                return set;
            }, [state.collapsed, forcedExpand]);

            var dims = prefs.compact ? CARD_COMPACT : CARD_NORMAL;
            var layout = React.useMemo(function () {
                return layoutTree(visibleNodes, effectiveCollapsed, dims);
            }, [visibleNodes, effectiveCollapsed, prefs.compact]);

            var selected = nodes.find(function (node) { return node.id === state.selectedId; }) ?? null;
            var selectedPath = selected !== null ? pathOf(nodes, selected.id) : [];
            var pathIds = React.useMemo(function () {
                var set = new Set();
                for (var i = 0; i < selectedPath.length; i += 1) set.add(selectedPath[i].id);
                return set;
            }, [selectedPath]);
            var selectedChildren = selected !== null ? nodes.filter(function (node) { return node.parentId === selected.id; }) : [];
            var roots = visibleNodes.filter(function (node) { return node.parentId === null || node.parentId === undefined; });
            var maxDepth = React.useMemo(function () { return maxDepthOf(scopeNodes); }, [scopeNodes]);
            var dimmedIds = React.useMemo(function () {
                if (!prefs.onlyOpen) return null;
                var set = new Set();
                for (var i = 0; i < scopeNodes.length; i += 1) {
                    // 聚焦目标始终保亮：从搜索/简报跳到已关闭节点时，不需要关掉全局「只看未决」。
                    if (scopeNodes[i].id === state.selectedId) continue;
                    if (scopeNodes[i].status !== 'open' && scopeNodes[i].status !== 'active') set.add(scopeNodes[i].id);
                }
                return set;
            }, [scopeNodes, prefs.onlyOpen, state.selectedId]);

            function focusNode(id) {
                setState(function (previous) {
                    var collapsed = Object.assign({}, previous.collapsed);
                    var byId = nodeById(Array.isArray(previous.snapshot?.nodes) ? previous.snapshot.nodes : []);
                    var current = byId.get(id);
                    var guard = 0;
                    while (current !== undefined && current.parentId !== null && current.parentId !== undefined && guard < 200) {
                        collapsed[current.parentId] = false;
                        current = byId.get(current.parentId);
                        guard += 1;
                    }
                    var target = byId.get(id);
                    var keepTrunk = target !== undefined && isTrunkNode(target, byId);
                    return { ...previous, selectedId: id, collapsed: collapsed, kindFilter: null, view: keepTrunk ? previous.view : 'study' };
                });
            }

            function nextMatch() {
                if (matches.length === 0) return;
                var ids = matches.map(function (node) { return node.id; });
                var index = ids.indexOf(state.selectedId);
                focusNode(ids[(index + 1) % ids.length]);
            }

            function applyZoom(nextZoom, anchor, touched) {
                var target = clampZoom(nextZoom);
                if (Math.abs(target - state.zoom) < 0.001) return;
                var element = canvasRef.current;
                if (element !== null && element !== undefined && anchor !== undefined && anchor !== null) {
                    var width = element.scrollWidth > 0 ? element.scrollWidth : 0;
                    var height = element.scrollHeight > 0 ? element.scrollHeight : 0;
                    zoomAnchorRef.current = {
                        fx: width > 0 ? (element.scrollLeft + anchor.vx) / width : 0,
                        fy: height > 0 ? (element.scrollTop + anchor.vy) / height : 0,
                        vx: anchor.vx,
                        vy: anchor.vy,
                    };
                }
                setState(function (previous) {
                    return { ...previous, zoom: target, zoomTouched: touched !== false };
                });
            }

            function viewportCenter() {
                var element = canvasRef.current;
                if (element === null || element === undefined) return { vx: 0, vy: 0 };
                return { vx: element.clientWidth * 0.5, vy: element.clientHeight * 0.5 };
            }

            // 适应宽度：以左上角为锚点并回到顶部，同时恢复「自动适配」状态。
            function fitWidth() {
                var element = canvasRef.current;
                var available = element !== null && element !== undefined && element.clientWidth > 0 ? element.clientWidth : 1100;
                var target = clampZoom((available - 48) / Math.max(1, layout.width));
                if (element !== null && element !== undefined) {
                    element.scrollLeft = 0;
                    element.scrollTop = 0;
                }
                applyZoom(target, { vx: 0, vy: 0 }, false);
            }

            // 首次加载/切换工作区时自动缩放到「能看见整棵树」；用户手动缩放后不再打扰。
            React.useEffect(function () {
                if (state.zoomTouched) return;
                var element = canvasRef.current;
                if (element === null || element === undefined || element.clientWidth <= 0) return;
                var wanted = clampZoom(Math.min(1, (element.clientWidth - 48) / Math.max(1, layout.width)));
                if (Math.abs(state.zoom - wanted) >= 0.01) {
                    setState(function (previous) {
                        return Math.abs(previous.zoom - wanted) < 0.01 ? previous : { ...previous, zoom: wanted };
                    });
                }
            }, [layout.width, layout.height, state.zoomTouched, state.workspace]);

            function toggleKind(kind) {
                setState(function (previous) {
                    return { ...previous, kindFilter: previous.kindFilter === kind ? null : kind };
                });
            }

            function collapseAll() {
                var parentIds = new Set();
                var ids = new Set();
                for (var i = 0; i < visibleNodes.length; i += 1) {
                    if (visibleNodes[i].parentId !== null && visibleNodes[i].parentId !== undefined) parentIds.add(visibleNodes[i].parentId);
                }
                parentIds.forEach(function (id) { ids.add(id); });
                var collapsed = {};
                ids.forEach(function (id) { collapsed[id] = true; });
                setState(function (previous) { return { ...previous, collapsed: collapsed }; });
            }

            var steps = React.useMemo(function () { return stepNodes(scopeNodes); }, [scopeNodes]);
            var stepCounts = React.useMemo(function () {
                var counts = {};
                for (var i = 0; i < nodes.length; i += 1) {
                    var parentId = nodes[i].parentId;
                    if (parentId !== null && parentId !== undefined) counts[parentId] = (counts[parentId] ?? 0) + 1;
                }
                return counts;
            }, [nodes]);

            var kindCounts = stats.byKind ?? {};
            var legendKinds = KIND_ORDER.filter(function (kind) { return (kindCounts[kind] ?? 0) > 0; });

            return h('div', { className: 'et-root' },
                h('style', null, CSS),
                h('div', { className: 'et-bar' },
                    h('div', { className: 'et-bar-row' },
                        h('h2', null, '研究轨迹'),
                        h('span', { className: 'et-ws', title: state.workspace }, currentWorkspaceName(state)),
                        h('span', { className: 'et-stats' },
                            h('span', null, '节点 ', h('b', null, String(stats.nodes ?? nodes.length))),
                            h('span', null, '想法 ', h('b', null, String(THOUGHT_KINDS.reduce(function (sum, kind) { return sum + (kindCounts[kind] ?? 0); }, 0)))),
                            h('span', {
                                title: (stats.openHidden ?? 0) > 0
                                    ? '另有 ' + stats.openHidden + ' 项已折叠（旁白/旧主题/推理细节）'
                                    : '与概览一致的可见未决数',
                            }, '未决 ', h('b', null, String(stats.openUnresolved ?? ((stats.byStatus?.open ?? 0) + (stats.byStatus?.active ?? 0))))),
                            h('span', null, '关系 ', h('b', null, String(stats.edges ?? 0))),
                            h('span', null, '层深 ', h('b', null, String(maxDepth))),
                        ),
                        h('span', { className: 'et-spacer' }),
                        h('span', { className: 'et-group', title: '主干=目标/主题/叶根（交流与交接）；研究=全部节点（含叶内细节）' },
                            h('button', {
                                'data-active': effectiveView === 'trunk' ? '1' : '0',
                                onClick: function () { setState(function (previous) { return { ...previous, view: 'trunk' }; }); },
                            }, '主干'),
                            h('button', {
                                'data-active': effectiveView === 'study' ? '1' : '0',
                                onClick: function () { setState(function (previous) { return { ...previous, view: 'study' }; }); },
                            }, '研究'),
                        ),
                        h('button', { className: 'et-btn', onClick: collapseAll, title: '折叠所有有子节点的卡片' }, '折叠'),
                        h('button', { className: 'et-btn', onClick: function () { setState(function (previous) { return { ...previous, collapsed: {} }; }); } }, '展开'),
                        h('button', { className: 'et-btn', onClick: fitWidth, title: '把整棵树缩放到画布宽度' }, '适应宽度'),
                        h('button', { className: 'et-btn', onClick: function () { var last = steps[steps.length - 1]; if (last !== undefined) focusNode(last.id); }, title: '跳到最新一轮' }, '最新'),
                        h('button', {
                            className: 'et-btn',
                            disabled: sidebarPreviewOpen === null,
                            onClick: function () { if (sidebarPreviewOpen !== null) sidebarPreviewOpen(); },
                            title: sidebarPreviewOpen === null
                                ? '右侧栏插件不可用'
                                : '在右侧栏打开研究轨迹预览：目标、未决与下一步',
                        }, '右侧栏'),
                        h('span', { className: 'et-group' },
                            h('button', { onClick: function () { applyZoom(state.zoom - ZOOM_STEP, viewportCenter(), true); }, title: '缩小（Ctrl/⌘ + 滚轮也可缩放）' }, '−'),
                            h('button', { className: 'et-zoom-value', onClick: function () { applyZoom(1, viewportCenter(), true); }, title: '恢复 100%' }, Math.round(state.zoom * 100) + '%'),
                            h('button', { onClick: function () { applyZoom(state.zoom + ZOOM_STEP, viewportCenter(), true); }, title: '放大' }, '+'),
                        ),
                        h('button', { className: 'et-btn', onClick: function () { refresh(); } }, '刷新'),
                        h('span', { className: 'et-faint', style: { fontSize: '11px' } }, '显示选项在 设置 → 研究轨迹'),
                    ),
                    h('div', { className: 'et-bar-row' },
                        h('input', {
                            className: 'et-search',
                            type: 'search',
                            value: state.query,
                            placeholder: '搜索标题 / 摘要 / 标签…',
                            onChange: function (event) { setState(function (previous) { return { ...previous, query: event.target.value }; }); },
                            onKeyDown: function (event) { if (event.key === 'Enter') nextMatch(); },
                        }),
                        query !== ''
                            ? h('span', { className: 'et-match-nav' },
                                h('span', null, matches.length + ' 处匹配'),
                                h('button', { className: 'et-btn', onClick: nextMatch, disabled: matches.length === 0 }, '下一个'),
                                h('button', { className: 'et-btn', onClick: function () { setState(function (previous) { return { ...previous, query: '' }; }); } }, '清除'),
                            )
                            : null,
                        h('div', { className: 'et-steps', title: '按轮次定位（横向滚动）' },
                            h('span', { className: 'et-faint', style: { flex: '0 0 auto' } }, '轮次'),
                            steps.length === 0
                                ? h('span', { className: 'et-faint' }, '—')
                                : steps.map(function (step) {
                                    var label = step.turn !== null && step.turn !== undefined ? '第 ' + step.turn + ' 轮' : step.title.slice(0, 12);
                                    var count = stepCounts[step.id] ?? 0;
                                    return h('button', {
                                        key: step.id,
                                        className: 'et-chip',
                                        'data-active': state.selectedId === step.id ? '1' : '0',
                                        title: step.title,
                                        onClick: function () { focusNode(step.id); },
                                    }, label + ' · ' + count);
                                }),
                        ),
                    ),
                    legendKinds.length > 0
                        ? h('div', { className: 'et-legend' },
                            h('span', { className: 'et-faint' }, '图例'),
                            legendKinds.map(function (kind) {
                                return h('button', {
                                    key: kind,
                                    className: 'et-chip',
                                    'data-active': state.kindFilter === kind ? '1' : '0',
                                    style: { color: KIND_COLOR[kind] ?? 'inherit' },
                                    onClick: function () { toggleKind(kind); },
                                    title: '只看「' + (KIND_LABEL[kind] ?? kind) + '」',
                                }, KIND_LABEL[kind] ?? kind, h('span', { className: 'et-faint', style: { color: 'inherit' } }, String(kindCounts[kind] ?? 0)));
                            }),
                            state.kindFilter !== null
                                ? h('button', { className: 'et-btn', onClick: function () { setState(function (previous) { return { ...previous, kindFilter: null }; }); } }, '取消类型过滤')
                                : null,
                        )
                        : null,
                ),
                state.error !== ''
                    ? h('div', { className: 'et-empty et-err' },
                        '读取研究图失败：' + state.error,
                        h('p', { className: 'et-faint' }, '确认插件已加载，且宿主路由 /explore-tree 可访问。'),
                        h('button', { className: 'et-btn', style: { marginTop: '10px' }, onClick: function () { refresh(); } }, '重试'),
                    )
                    : (snapshot === null
                        ? h('div', { className: 'et-empty et-faint' }, '正在读取研究图…')
                        : (nodes.length > 0 && visibleNodes.length === 0
                            ? h('div', { className: 'et-empty et-faint' }, '当前筛选下没有可见节点：取消类型过滤、降低隐藏条件或展开折叠节点再看。')
                            : (visibleNodes.length === 0
                                ? h(EmptyState, { workspace: state.workspace, onRefresh: function () { refresh(); } })
                                : h('div', { className: 'et-body' },
                                prefs.showOutline
                                    ? h(OutlinePanel, {
                                        roots: roots,
                                        steps: steps,
                                        subtreeStats: subtreeStats,
                                        selectedId: state.selectedId,
                                        onFocus: focusNode,
                                        trunk: effectiveView === 'trunk',
                                        trunkItems: trunkItems,
                                    })
                                    : null,
                                h(TreeCanvas, {
                                    layout: layout,
                                    dims: dims,
                                    zoom: state.zoom,
                                    compact: prefs.compact,
                                    selectedId: state.selectedId,
                                    collapsed: state.collapsed,
                                    dimmedIds: dimmedIds,
                                    matchedIds: query !== '' ? matchedIds : null,
                                    pathIds: pathIds,
                                    edges: edges,
                                    subtreeStats: subtreeStats,
                                    topicProgress: topicProgress,
                                    canvasRef: canvasRef,
                                    zoomAnchorRef: zoomAnchorRef,
                                    onZoom: function (target, anchor) { applyZoom(target, anchor, true); },
                                    onFitWidth: fitWidth,
                                    onSelect: function (id) { setState(function (previous) { return { ...previous, selectedId: id }; }); },
                                    onToggle: function (id) {
                                        setState(function (previous) {
                                            var collapsed = Object.assign({}, previous.collapsed);
                                            collapsed[id] = collapsed[id] !== true;
                                            return { ...previous, collapsed: collapsed };
                                        });
                                    },
                                }),
                                prefs.showInspector
                                    ? h('div', { className: 'et-side' },
                                        selected !== null
                                            ? h(DetailPanel, {
                                                key: selected.id,
                                                node: selected,
                                                path: selectedPath,
                                                children: selectedChildren,
                                                nodes: nodes,
                                                edges: edges,
                                                onFocus: focusNode,
                                                onClose: function () { setPref('showInspector', false); },
                                                onToggleChildren: function () {
                                                    setState(function (previous) {
                                                        var collapsed = Object.assign({}, previous.collapsed);
                                                        collapsed[selected.id] = collapsed[selected.id] !== true;
                                                        return { ...previous, collapsed: collapsed };
                                                    });
                                                },
                                                childrenCollapsed: state.collapsed?.[selected.id] === true,
                                            })
                                            : h(OverviewPanel, {
                                                stats: stats,
                                                nodes: nodes,
                                                open: snapshot?.open,
                                                roots: roots,
                                                maxDepth: maxDepth,
                                                workspaceName: currentWorkspaceName(state),
                                                onFocus: focusNode,
                                                onFilterKind: toggleKind,
                                            }),
                                        h('div', { style: { marginTop: '10px' } },
                                            h(FrontierPanel, { frontier: snapshot?.frontier, onFocus: focusNode }),
                                        ),
                                    )
                                    : null,
                            )))),
            );
        }

        // ───────────────────────────── 槽位注册 ─────────────────────────────

        var inject = ['slots'];

        // 可根据「右侧栏」插件存在与否降级：没有 sidebarRightTabs 时只注册会话页签与设置分区。
        function registerSidebarPreview(ctx) {
            if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return;
            // 页签类型与 body 只依赖 sidebarRightTabs；导航控制器单独注入。
            // 两者合成一个 ctx.inject 时，HMR 或 sidebarRight 暂时不可用会让 body 一起消失，
            // 留下一个点开是空白的页签。
            ctx.inject(['sidebarRight'], function (navCtx) {
                if (navCtx === null || typeof navCtx !== 'object') return;
                var nav = navCtx.sidebarRight;
                if (nav === null || typeof nav !== 'object' || typeof nav.openTab !== 'function') return;
                sidebarPreviewOpen = function () {
                    try {
                        // openTab 会展开右栏并落一个 research-tree 页；没有当前会话时宿主会抛错，按钮点击按无操作处理。
                        nav.openTab(SIDEBAR_TAB_ID);
                    } catch (error) {
                        // 宿主没有可显示的会话（hero 页/全局页）时保持静默。
                    }
                };
                if (sidebarPreviewPending !== null) {
                    var pending = sidebarPreviewPending;
                    sidebarPreviewPending = null;
                    sidebarPreviewAutoOpened[pending] = true;
                    sidebarPreviewOpen();
                }
                if (typeof navCtx.effect === 'function') {
                    navCtx.effect(function () {
                        return function () { sidebarPreviewOpen = null; sidebarPreviewPending = null; };
                    });
                }
            });
            ctx.inject(['sidebarRightTabs'], function (sidebarCtx) {
                if (sidebarCtx === null || typeof sidebarCtx !== 'object') return;
                var tabs = sidebarCtx.sidebarRightTabs;
                if (tabs === null || typeof tabs !== 'object' || typeof tabs.register !== 'function') return;
                var definition = {
                    id: SIDEBAR_TAB_ID,
                    kind: SIDEBAR_TAB_ID,
                    title: function () { return '研究轨迹'; },
                    keepMounted: true,
                    priority: 'extension',
                    guide: [{
                        id: 'explore-tree',
                        order: 20,
                        // 原生的 GuideBody 按 entry.title() / entry.description?.() 取值；
                        // 写成字符串会在渲染时抛 TypeError，整页 guide 变空白。
                        title: function () { return '研究轨迹'; },
                        description: function () { return '当前会话的研究树目标、未决与下一步'; },
                    }],
                };
                // 先注册 body，再注册页签类型：HMR 重复注册 id 时 tabs.register 会 throw，
                // 若 body 在其后注册，页签会留下来、内容却是空白。
                var slots = ctx.slots;
                if (slots !== null && typeof slots === 'object' && typeof slots.inject === 'function') {
                    slots.inject('sidebar.right.pane.tab', function () {
                        return slots.register({
                            name: 'sidebar.right.pane.tab',
                            key: SIDEBAR_TAB_ID,
                        }, ResearchTreePreview);
                    });
                }
                function registerTabType() {
                    try {
                        return tabs.register(definition);
                    } catch (error) {
                        // 旧 bundle 的注册尚未释放时 id 会重复；body 已经注册，保留旧页签定义即可。
                        if (error && /already registered/.test(String(error.message))) return function () {};
                        throw error;
                    }
                }
                if (typeof sidebarCtx.effect === 'function') {
                    sidebarCtx.effect(registerTabType);
                } else {
                    registerTabType();
                }
            });
        }

        function apply(ctx) {
            // 会话上栏页签 conversation.view（与「对话 / 轨迹 / 上下文 …」并列）。
            // 页签自动绑定当前会话工作区；不向主对话注入任何内容。
            ctx.slots.inject('conversation.view', function () {
                return ctx.slots.register({
                    name: 'conversation.view',
                    id: PANEL_ID,
                    order: VIEW_ORDER,
                    label: function () { return '研究轨迹'; },
                }, ExploreTreePanel);
            });
            // 设置页「研究轨迹」分区：面板的显示/过滤偏好集中在这里，面板工具栏只留画布操作。
            ctx.slots.inject('settings.section', function () {
                return ctx.slots.register({
                    name: 'settings.section',
                    id: PANEL_ID,
                    order: SETTINGS_ORDER,
                    label: function () { return '研究轨迹'; },
                }, ExploreTreeSettings);
            });
            // 右侧栏预览：仅在宿主装有右侧栏客户端插件时注册；缺少依赖不影响主面板。
            registerSidebarPreview(ctx);
        }

        exports.name = 'dsh-explore-tree';
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
    },
});

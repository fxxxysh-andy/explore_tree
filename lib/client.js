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
        // 右侧栏预览只由用户点面板工具栏的「右侧栏」按钮打开；进入页签本身不弹侧栏。
        // 侧栏服务晚就绪时按钮保持禁用，就绪后再变可用（见 registerSidebarPreview）。
        var sidebarPreviewOpen = null;
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
        var STATUS_LABEL = { open: '打开', active: '进行中', done: '完成', abandoned: '放弃' };
        var STATUS_COLOR = {
            open: '#8a8a8a',
            active: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            done: '#2e8b57',
            abandoned: '#c0504d',
        };
        // 语义阶段：服务端按 kind + status + 收束原因派生，前端只展示，不自行改状态。
        var PHASE_LABEL = {
            todo: '待办',
            doing: '进行中',
            recorded: '已记录',
            completed: '已完成',
            closed: '已关闭',
            dead_end: '死路',
            curated: '已收敛',
            merged: '已合并',
            tool_noise: '工具噪音',
            aborted: '中断',
        };
        var PHASE_COLOR = {
            todo: '#d08a00',
            doing: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            recorded: '#2f8f83',
            completed: '#2e8b57',
            closed: '#6b7280',
            dead_end: '#c0504d',
            curated: '#8a8a8a',
            merged: '#8a8a8a',
            tool_noise: '#8a8a8a',
            aborted: '#8a8a8a',
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
            showAnalysis: true,
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
            '.et-root,.et-set-root,.et-preview-root{--et-ink:var(--dsw-alias-label-primary,#1f2533);--et-ink2:var(--dsw-alias-label-secondary,rgba(88,99,115,.96));--et-ink3:var(--dsw-alias-label-tertiary,rgba(120,132,150,.92));--et-line:var(--dsw-alias-border-l2,rgba(128,140,168,.24));--et-line-soft:var(--dsw-alias-border-l1,rgba(128,140,168,.15));--et-surface:var(--dsw-alias-bg-base,#fff);--et-layer:var(--dsw-alias-bg-layer-1,rgba(128,140,168,.06));--et-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--et-card-shadow:0 1px 2px rgba(16,24,40,.05),0 12px 28px -22px rgba(16,24,40,.42)}',
            '.et-root{display:flex;flex-direction:column;font:var(--dsw-font-xs-13,13px)/1.55 var(--dsw-font-family,inherit);color:var(--et-ink);box-sizing:border-box;width:100%;min-width:0;overflow-x:clip;background:radial-gradient(1100px 300px at 10% -120px,rgba(77,107,254,.07),transparent 70%),radial-gradient(900px 260px at 100% -80px,rgba(47,143,131,.06),transparent 72%),var(--et-surface)}',
            '.et-brand{flex:1 1 auto;min-width:0}',
            '.et-hero{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 18px 10px;border-bottom:1px solid var(--et-line);background:var(--et-surface);box-shadow:0 10px 30px -28px rgba(16,24,40,.6)}',
            '.et-brand{display:flex;align-items:center;gap:10px;min-width:0}',
            '.et-logo{width:36px;height:36px;flex:0 0 36px;border-radius:12px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4d6bfe,#7b5cff 52%,#2f8f83);box-shadow:0 8px 18px -8px rgba(77,107,254,.8),inset 0 1px 0 rgba(255,255,255,.35)}',
            '.et-logo svg{display:block}',
            '.et-title{display:flex;align-items:baseline;gap:8px;margin:0;font-size:15.5px;font-weight:700;letter-spacing:.01em;line-height:1.25}',
            '.et-title em{font-style:normal;font-size:9.5px;font-weight:700;letter-spacing:.16em;color:var(--et-ink3);text-transform:uppercase}',
            '.et-subline{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:3px;font-size:11px;color:var(--et-ink2);min-width:0}',
            '.et-live{display:inline-flex;align-items:center;gap:5px;padding:1px 8px 1px 6px;border-radius:999px;background:rgba(46,139,87,.12);color:#2b8555;font-weight:600;line-height:1.65;white-space:nowrap}',
            '.et-live i{width:6px;height:6px;border-radius:50%;background:#2e8b57;box-shadow:0 0 0 0 rgba(46,139,87,.5);animation:et-ping 2.4s ease-out infinite}',
            '.et-live[data-live="0"]{background:rgba(128,140,168,.16);color:var(--et-ink2)}',
            '.et-live[data-live="0"] i{background:var(--et-ink3);animation:none;box-shadow:none}',
            '.et-ws{font-size:11px;max-width:230px;padding:1px 8px;border-radius:999px;background:var(--et-layer);border:1px solid var(--et-line-soft);color:var(--et-ink2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.7}',
            '.et-muted{color:var(--et-ink2)}',
            '.et-faint{color:var(--et-ink3)}',
            '.et-spacer{flex:1 1 auto;min-width:4px}',
            '.et-kpis{display:flex;align-items:stretch;gap:6px;margin-left:auto;flex-wrap:wrap}',
            '.et-kpi{position:relative;min-width:62px;padding:4px 10px 5px;border-radius:11px;border:1px solid var(--et-line-soft);background:var(--et-layer);display:flex;flex-direction:column;justify-content:center;line-height:1.15;overflow:hidden}',
            '.et-kpi b{font-size:16px;font-weight:750;letter-spacing:-.015em;font-variant-numeric:tabular-nums}',
            '.et-kpi span{font-size:9.5px;letter-spacing:.08em;color:var(--et-ink3);text-transform:uppercase;white-space:nowrap}',
            '.et-kpi[data-tone="node"] b{color:#4d6bfe}.et-kpi[data-tone="thought"] b{color:#8a63d2}.et-kpi[data-tone="todo"] b{color:#c98a00}.et-kpi[data-tone="edge"] b{color:#2f8f83}',
            '.et-kpi-delta{position:absolute;top:3px;right:5px;font-size:9px;font-weight:700;color:#2e8b57;background:rgba(46,139,87,.13);border-radius:999px;padding:0 4px;line-height:1.5;animation:et-pop .5s ease both}',
            '.et-hero-tools{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
            '.et-tabs,.et-seg{display:flex;align-items:center;gap:2px;padding:3px;border-radius:11px;background:var(--et-layer);border:1px solid var(--et-line-soft)}',
            '.et-tabs button,.et-seg button{font:inherit;font-size:11.5px;line-height:1.6;padding:2px 11px;border:0;border-radius:8px;background:transparent;color:var(--et-ink2);cursor:pointer;white-space:nowrap;transition:color .15s,background .15s,box-shadow .15s}',
            '.et-tabs button:hover,.et-seg button:hover{color:var(--et-ink);background:rgba(128,140,168,.1)}',
            '.et-tabs button[data-active="1"],.et-seg button[data-active="1"]{background:var(--et-surface);color:var(--et-ink);font-weight:650;box-shadow:0 1px 2px rgba(16,24,40,.14),0 0 0 1px var(--et-line-soft)}',
            '.et-spark-wrap{display:flex;align-items:center;gap:5px;padding:1px 8px 1px 6px;border-radius:9px;border:1px solid var(--et-line-soft);background:var(--et-layer);font-size:9.5px;letter-spacing:.06em;color:var(--et-ink3);text-transform:uppercase}',
            '.et-spark{display:block;overflow:visible}',
            '.et-spark-line{fill:none;stroke:#4d6bfe;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}',
            '.et-spark-area{fill:rgba(77,107,254,.18);stroke:none}',
            '.et-btn{font:inherit;font-size:11.5px;line-height:1.7;padding:1px 9px;border-radius:8px;border:1px solid var(--et-line);background:var(--et-surface);color:var(--et-ink2);cursor:pointer;white-space:nowrap;transition:border-color .15s,background .15s,color .15s,box-shadow .15s}',
            '.et-btn:hover{border-color:rgba(77,107,254,.55);color:var(--et-ink);box-shadow:0 2px 8px -4px rgba(16,24,40,.28)}',
            '.et-btn:active{transform:translateY(1px)}',
            '.et-btn[disabled]{cursor:default;opacity:.5;box-shadow:none}',
            '.et-btn[data-active="1"]{border-color:var(--et-accent);color:var(--et-accent);background:rgba(77,107,254,.1)}',
            '.et-btn[data-primary="1"]{border-color:transparent;color:#fff;font-weight:600;background:linear-gradient(135deg,#4d6bfe,#6a5cf5 60%,#4f7ff0);box-shadow:0 5px 14px -7px rgba(77,107,254,.9)}',
            '.et-btn[data-primary="1"]:hover{color:#fff;box-shadow:0 7px 18px -7px rgba(77,107,254,.95)}',
            '.et-toolbar{position:relative;display:flex;flex-direction:column;gap:7px;padding:10px 18px 8px;border-bottom:1px solid var(--et-line-soft);background:linear-gradient(180deg,var(--et-layer),transparent)}',
            '.et-bar-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}',
            '.et-search{flex:0 1 280px;min-width:160px;font:inherit;font-size:12px;padding:4px 10px;border-radius:9px;border:1px solid var(--et-line);background:var(--et-surface);color:var(--et-ink);outline:none;transition:border-color .15s,box-shadow .15s}',
            '.et-search::placeholder{color:var(--et-ink3)}',
            '.et-search:focus{border-color:var(--et-accent);box-shadow:0 0 0 3px rgba(77,107,254,.14)}',
            '.et-match-nav{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--et-ink2)}',
            '.et-zoom{display:flex;align-items:center;gap:1px;padding:1px;border:1px solid var(--et-line);border-radius:9px;background:var(--et-surface)}',
            '.et-zoom button{font:inherit;font-size:11.5px;line-height:1.6;padding:1px 6px;border:0;border-radius:7px;background:transparent;color:var(--et-ink2);cursor:pointer}',
            '.et-zoom button:hover{background:var(--et-layer);color:var(--et-ink)}',
            '.et-zoom .et-zoom-value{min-width:42px;text-align:center;font-variant-numeric:tabular-nums;color:var(--et-ink2)}',
            '.et-steps{display:flex;align-items:center;gap:5px;flex:1 1 360px;min-width:0;overflow-x:auto;padding:1px 0 3px;scrollbar-width:thin}',
            '.et-steps .et-chip{flex:0 0 auto}',
            '.et-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.75;padding:0 8px;border-radius:999px;border:1px solid var(--et-line-soft);background:var(--et-surface);color:var(--et-ink2);cursor:pointer;white-space:nowrap;transition:border-color .15s,background .15s,color .15s}',
            '.et-chip:hover{border-color:var(--et-line);color:var(--et-ink);background:var(--et-layer)}',
            '.et-chip[data-active="1"]{border-color:currentColor;background:rgba(77,107,254,.1);font-weight:650}',
            '.et-chip b{font-weight:650;font-variant-numeric:tabular-nums;opacity:.85}',
            '.et-legend{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px}',
            '.et-legend .et-chip{border-color:transparent;background:transparent;padding:0 6px}',
            '.et-legend .et-chip:hover{background:var(--et-layer)}',
            '.et-hint{font-size:10.5px;color:var(--et-ink3);margin:0;white-space:nowrap}',
            '.et-dash{display:flex;flex-direction:column;gap:12px;padding:14px 18px 56px;min-width:0}',
            '.et-dash>*{animation:et-rise .42s cubic-bezier(.22,.61,.36,1) both}',
            '.et-dash>*:nth-child(2){animation-delay:.04s}.et-dash>*:nth-child(3){animation-delay:.08s}.et-dash>*:nth-child(4){animation-delay:.12s}.et-dash>*:nth-child(5){animation-delay:.16s}',
            '.et-stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:10px}',
            '.et-stat{position:relative;padding:11px 13px 12px;border:1px solid var(--et-line-soft);border-radius:15px;background:var(--et-surface);box-shadow:var(--et-card-shadow);overflow:hidden;min-width:0}',
            '.et-stat::after{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--et-tone,#4d6bfe),transparent 88%);opacity:.9}',
            '.et-stat-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--et-ink3);font-weight:650}',
            '.et-stat-value{margin-top:2px;font-size:25px;font-weight:750;letter-spacing:-.025em;line-height:1.12;font-variant-numeric:tabular-nums}',
            '.et-stat-sub{margin-top:2px;font-size:10.5px;color:var(--et-ink2);display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
            '.et-stat-sub b{font-weight:650;color:var(--et-tone,#4d6bfe)}',
            '.et-stat-spark{position:absolute;right:9px;bottom:9px;width:78px;height:24px;opacity:.75;pointer-events:none}',
            '.et-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
            '.et-dash-row{display:grid;gap:12px;min-width:0;align-items:start}',
            '.et-dash-row[data-cols="2"]{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}',
            '.et-dash-row[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}',
            '.et-dash-row[data-cols="2+1"]{grid-template-columns:repeat(2,minmax(0,1fr))}',
            '.et-dash-row[data-cols="2+1"]>*:nth-child(3){grid-column:1/-1}',
            '.et-dash-row[data-cols="2+1b"]{grid-template-columns:repeat(2,minmax(0,1fr))}',
            '.et-dash-row[data-cols="2+1b"]>*:nth-child(1){grid-column:1;grid-row:1}',
            '.et-dash-row[data-cols="2+1b"]>*:nth-child(2){grid-column:1/-1;grid-row:2}',
            '.et-dash-row[data-cols="2+1b"]>*:nth-child(3){grid-column:2;grid-row:1}',
            '.et-dash-row[data-cols="2+1b"] .et-fold-body .et-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start}',
            '.et-dash-row[data-cols="2+1b"] .et-fold-body .et-item{margin:0}',
            '.et-panel{position:relative,min-width:0;padding:13px 15px 14px;border:1px solid var(--et-line-soft);border-radius:16px;background:var(--et-surface);box-shadow:var(--et-card-shadow);overflow:hidden}',
            '.et-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:9px;min-width:0}',
            '.et-panel-title{font-size:12.5px;font-weight:700;letter-spacing:.01em;display:flex;align-items:center;gap:7px}',
            '.et-panel-title::before{content:"";width:3px;height:13px;border-radius:2px;background:linear-gradient(180deg,#4d6bfe,#2f8f83)}',
            '.et-panel-sub{margin-top:2px;font-size:10.5px;color:var(--et-ink3)}',
            '.et-range{display:flex;gap:1px;padding:2px;border-radius:8px;background:var(--et-layer);border:1px solid var(--et-line-soft)}',
            '.et-range button{font:inherit;font-size:10.5px;line-height:1.5;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--et-ink3);cursor:pointer}',
            '.et-range button[data-active="1"]{background:var(--et-surface);color:var(--et-ink);font-weight:650;box-shadow:0 1px 2px rgba(16,24,40,.14)}',
            '.et-chart{display:block;width:100%;height:auto;overflow:visible}',
            '.et-chart-grid{stroke:rgba(128,140,168,.22);stroke-width:1;shape-rendering:crispEdges}',
            '.et-chart-axis{font-size:9.5px;fill:var(--et-ink3);font-variant-numeric:tabular-nums}',
            '.et-chart-bar{fill:rgba(77,107,254,.2);rx:2}',
            '.et-chart-bar[data-on="1"]{fill:rgba(77,107,254,.48)}',
            '.et-chart-line{fill:none;stroke:#4d6bfe;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round;filter:drop-shadow(0 3px 6px rgba(77,107,254,.28))}',
            '.et-chart-area{fill:url(#etAreaFill);stroke:none}',
            '.et-chart-dot{fill:#fff;stroke:#4d6bfe;stroke-width:2}',
            '.et-chart-halo{fill:rgba(77,107,254,.22);animation:et-pulse 2.6s ease-out infinite;transform-box:fill-box;transform-origin:center}',
            '.et-chart-hover{fill:transparent;cursor:crosshair}',
            '.et-chart-hover-line{stroke:rgba(77,107,254,.35);stroke-width:1;stroke-dasharray:3 3}',
            '.et-chart-tip-box{fill:#1b2434;opacity:.97;filter:drop-shadow(0 10px 20px rgba(16,24,40,.32))}',
            '.et-chart-tip-text{font-size:10px;fill:#fff;font-weight:600;letter-spacing:.01em}',
            '.et-chart-tip-sub{font-size:9.5px;fill:rgba(255,255,255,.7)}',
            '.et-chart-foot{margin-top:4px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--et-ink3)}',
            '.et-chart-key{display:inline-flex;align-items:center;gap:5px}',
            '.et-chart-key i{width:9px;height:9px;border-radius:3px;display:inline-block}',
            '.et-donut-wrap{display:flex;align-items:center;gap:12px;min-width:0}',
            '.et-donut{width:132px;height:132px;flex:0 0 132px}',
            '.et-donut-total{font-size:20px;font-weight:750;fill:var(--et-ink);font-variant-numeric:tabular-nums}',
            '.et-donut-cap{font-size:9px;fill:var(--et-ink3);letter-spacing:.08em}',
            '.et-progress{margin-top:10px;padding-top:9px;border-top:1px solid var(--et-line-soft)}',
            '.et-progress-bar{height:7px;border-radius:999px;background:rgba(128,140,168,.16);overflow:hidden}',
            '.et-progress-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#4d6bfe,#2f8f83);box-shadow:0 0 10px -1px rgba(47,143,131,.6);min-width:3px;transition:width .5s cubic-bezier(.22,.61,.36,1)}',
            '.et-progress-labels{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;font-size:10px;color:var(--et-ink3);font-variant-numeric:tabular-nums}',
            '.et-progress-labels b{color:var(--et-ink);font-weight:650}',
            '.et-phase-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 18px;flex:1 1 auto;min-width:0;font-size:11px}',
            '.et-phase-row{display:flex;align-items:center;gap:6px;min-width:0;cursor:default}',
            '.et-phase-row i{width:7px;height:7px;border-radius:50%;flex:0 0 7px}',
            '.et-phase-row span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--et-ink2)}',
            '.et-phase-row b{font-variant-numeric:tabular-nums;font-weight:650}',
            '.et-phase-row em{font-style:normal;font-size:9.5px;color:var(--et-ink3);width:29px;text-align:right;font-variant-numeric:tabular-nums}',
            '.et-heat-wrap{display:flex;flex-direction:column;gap:7px;min-width:0}',
            '.et-heat{display:grid;grid-template-rows:repeat(7,13px);grid-auto-flow:column;grid-auto-columns:13px;gap:3px}',
            '.et-heat-cell{border-radius:2.5px;background:rgba(128,140,168,.14);display:block;transition:transform .12s,box-shadow .12s}',
            '.et-heat-cell[data-level="1"]{background:rgba(77,107,254,.24)}.et-heat-cell[data-level="2"]{background:rgba(77,107,254,.42)}.et-heat-cell[data-level="3"]{background:rgba(77,107,254,.62)}.et-heat-cell[data-level="4"]{background:rgba(77,107,254,.85)}',
            '.et-heat-cell[data-future="1"]{background:transparent;box-shadow:inset 0 0 0 1px rgba(128,140,168,.14)}',
            '.et-heat-cell:hover{transform:scale(1.5);box-shadow:0 0 0 1px var(--et-surface),0 2px 6px rgba(16,24,40,.35);z-index:2;position:relative}',
            '.et-heat-body{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
            '.et-heat-grid{display:flex;align-items:flex-start;gap:5px;min-width:0}',
            '.et-heat-days{display:grid;grid-template-rows:repeat(7,13px);gap:3px;font-size:9px;line-height:13px;color:var(--et-ink3);text-align:right;flex:0 0 auto}',
            '.et-heat-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;flex:1 1 190px;min-width:170px;margin-left:auto}',
            '.et-heat-stat{padding:7px 9px;border-radius:10px;background:var(--et-layer);min-width:0}',
            '.et-heat-stat b{display:block;font-size:16px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}',
            '.et-heat-stat span{font-size:9.5px;color:var(--et-ink3)}',
            '.et-heat-big{font-size:22px;font-weight:750;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}',
            '.et-heat-big span{margin-left:4px;font-size:10px;font-weight:500;color:var(--et-ink3);letter-spacing:0}',
            '.et-heat-line{font-size:10.5px;color:var(--et-ink3)}',
            '.et-heat-line b{font-weight:650;color:var(--et-ink)}',
            '.et-heat-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--et-ink3);flex-wrap:wrap}',
            '.et-heat-scale{display:inline-flex;align-items:center;gap:3px}',
            '.et-heat-scale i{width:9px;height:9px;border-radius:2px;background:rgba(77,107,254,.2);display:inline-block}',
            '.et-heat-scale i[data-n="2"]{background:rgba(77,107,254,.42)}.et-heat-scale i[data-n="3"]{background:rgba(77,107,254,.62)}.et-heat-scale i[data-n="4"]{background:rgba(77,107,254,.85)}',
            '.et-kindbars{display:flex;flex-direction:column;gap:3px;min-width:0}',
            '.et-kindstack{display:flex;height:7px;border-radius:999px;overflow:hidden;background:rgba(128,140,168,.14);margin:1px 0 9px}',
            '.et-kindstack i{display:block;height:100%}',
            '.et-kindbar{display:grid;grid-template-columns:64px minmax(0,1fr) 34px 30px;gap:8px;align-items:center;width:100%;padding:3px 0;border:0;background:none;font:inherit;font-size:11px;color:var(--et-ink2);text-align:left;cursor:pointer;border-radius:6px}',
            '.et-kindbar:hover{background:var(--et-layer)}',
            '.et-kindbar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.et-kindtrack{height:7px;border-radius:999px;background:rgba(128,140,168,.14);overflow:hidden}',
            '.et-kindfill{display:block;height:100%;border-radius:999px;background:currentColor;opacity:.82;box-shadow:0 0 8px -2px currentColor;transition:width .45s cubic-bezier(.22,.61,.36,1)}',
            '.et-kindbar b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right;color:var(--et-ink)}',
            '.et-kindbar em{font-style:normal;font-size:9.5px;color:var(--et-ink3);text-align:right;font-variant-numeric:tabular-nums}',
            '.et-feed{display:flex;flex-direction:column;gap:1px;min-width:0}',
            '.et-feed-item{display:flex;align-items:flex-start;gap:8px;width:100%;padding:6px 7px;border:0;border-radius:8px;background:transparent;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:0}',
            '.et-feed-item:hover{background:var(--et-layer)}',
            '.et-feed-dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px;margin-top:5px;box-shadow:0 0 0 3px rgba(128,140,168,.12)}',
            '.et-feed-main{min-width:0;flex:1 1 auto}',
            '.et-feed-title{font-size:11.5px;font-weight:550;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
            '.et-feed-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:1px;font-size:10px;color:var(--et-ink3)}',
            '.et-feed-time{flex:0 0 auto;font-size:10px;color:var(--et-ink3);font-variant-numeric:tabular-nums;margin-top:4px}',
            '.et-open{display:flex;flex-direction:column;gap:2px;min-width:0}',
            '.et-open-item{display:flex;align-items:flex-start;gap:7px;width:100%;padding:6px 7px;border:0;border-radius:8px;background:transparent;font:inherit;text-align:left;color:inherit;cursor:pointer;min-width:0}',
            '.et-open-item:hover{background:var(--et-layer)}',
            '.et-open-title{font-size:11.5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;min-width:0;flex:1 1 auto}',
            '.et-open-kind{flex:0 0 auto;font-size:9.5px;line-height:1.6;padding:0 5px;border-radius:5px;background:var(--et-layer);font-weight:650}',
            '.et-dash-empty{padding:18px 6px;text-align:center;font-size:11.5px;color:var(--et-ink3)}',
            '.et-main-text{margin:0;font-size:11.5px;line-height:1.6;color:var(--et-ink2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}',
            '.et-body{display:flex;align-items:flex-start;gap:13px;padding:13px 18px 46px;min-width:0}',
            '.et-outline{position:sticky;top:86px;width:236px;flex:0 0 236px;max-height:min(74vh,820px);overflow:auto;padding:10px 9px;border:1px solid var(--et-line-soft);border-radius:15px;background:var(--et-surface);box-shadow:var(--et-card-shadow)}',
            '.et-outline-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}',
            '.et-outline-item{display:flex;align-items:baseline;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.45;text-align:left;cursor:pointer;overflow:hidden;transition:background .12s,color .12s}',
            '.et-outline-item:hover{background:var(--et-layer)}',
            '.et-outline-item[data-active="1"]{background:rgba(77,107,254,.12);color:var(--et-accent);font-weight:600}',
            '.et-outline-item[data-depth]{padding-left:calc(6px + var(--et-depth,0) * 11px)}',
            '.et-outline-turn{flex:0 0 auto;font-size:9.5px;color:var(--et-ink3);font-variant-numeric:tabular-nums}',
            '.et-outline-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.et-outline-count{flex:0 0 auto;font-size:9.5px;color:var(--et-ink3);font-variant-numeric:tabular-nums}',
            '.et-canvas{position:relative;flex:1 1 auto;min-width:0;height:min(74vh,840px);min-height:440px;overflow:auto;border:1px solid var(--et-line-soft);border-radius:16px;background-color:var(--et-surface);background-image:radial-gradient(rgba(128,140,168,.18) 1px,transparent 1px),linear-gradient(180deg,rgba(77,107,254,.035),transparent 240px);background-size:18px 18px,100% 100%;cursor:grab;overscroll-behavior:contain;touch-action:pan-x pan-y;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}',
            '.et-canvas.et-dragging{cursor:grabbing}',
            '.et-canvas.et-dragging,.et-canvas.et-dragging *{user-select:none;-webkit-user-select:none}',
            '.et-graph{position:relative;transform-origin:0 0}',
            '.et-side{position:sticky;top:86px;width:340px;flex:0 0 340px;padding:0 0 24px;display:flex;flex-direction:column;gap:11px;min-width:0;max-height:calc(100vh - 104px);overflow:auto;scrollbar-width:thin}',
            '.et-card{--et-accent:var(--dsw-alias-state-business-primary,#4d6bfe);position:absolute;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:9px 11px 8px;border:1px solid var(--et-line);border-left:3px solid var(--et-accent);border-radius:12px;background:var(--et-surface);box-shadow:0 1px 2px rgba(16,24,40,.05),0 8px 18px -18px rgba(16,24,40,.4);cursor:pointer;text-align:left;font:inherit;color:inherit;overflow:hidden;transition:transform .14s ease,box-shadow .14s ease,border-color .14s}',
            '.et-card:hover{transform:translateY(-2px);box-shadow:0 1px 2px rgba(16,24,40,.05),0 12px 22px -12px rgba(16,24,40,.36);z-index:3}',
            '.et-card[data-compact="1"]{padding:5px 8px;gap:2px}',
            '.et-card[data-compact="1"] .et-card-title{font-size:12px;line-height:1.36}',
            '.et-card[data-compact="1"] .et-card-summary{display:none}',
            '.et-card[data-compact="1"] .et-card-foot{display:none}',
            '.et-card[data-selected="1"]{box-shadow:0 0 0 2px var(--et-accent),0 14px 26px -14px rgba(77,107,254,.55);transform:translateY(-2px);z-index:4}',
            '.et-card[data-dim="1"]{opacity:.22}',
            '.et-card[data-dim="1"]:hover{opacity:.7}',
            '.et-card[data-matched="1"]:not([data-selected="1"]){border-color:rgba(201,138,0,.75);box-shadow:0 0 0 2px rgba(201,138,0,.28),0 8px 18px -16px rgba(16,24,40,.4)}',
            '.et-card[data-new="1"]::after{content:"";position:absolute;inset:-4px;border-radius:15px;border:2px solid var(--et-accent);opacity:0;pointer-events:none;animation:et-ring 1.7s ease-out 3}',
            '.et-card[data-new="1"] .et-card-newdot{display:inline-block}',
            '.et-card-newdot{display:none;position:absolute;top:7px;right:7px;width:7px;height:7px;border-radius:50%;background:#2e8b57;box-shadow:0 0 0 3px rgba(46,139,87,.18)}',
            '.et-card-head{display:flex;align-items:center;gap:6px;min-width:0}',
            '.et-card-badge{flex:0 0 auto;font-size:9.5px;line-height:1.7;padding:0 6px;border-radius:5px;background:rgba(128,140,168,.14);font-weight:700;letter-spacing:.02em}',
            '.et-card-meta{flex:1 1 auto;min-width:0;font-size:9.5px;color:var(--et-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
            '.et-card-ai{flex:0 0 auto;font-size:9px;line-height:1.6;padding:0 4px;border-radius:4px;background:rgba(77,107,254,.16);color:var(--et-accent);font-weight:700}',
            '.et-card-title{font-size:12.5px;font-weight:650;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-card-summary{font-size:10.5px;line-height:1.42;color:var(--et-ink3);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-card-sub{margin-left:auto;font-size:9.5px;color:var(--et-ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%;font-variant-numeric:tabular-nums}',
            '.et-card-foot{display:flex;align-items:center;gap:5px;min-height:14px;margin-top:auto;font-size:10px;color:var(--et-ink2)}',
            '.et-card-foot .et-card-sub{max-width:none;flex:1 1 auto;min-width:0;text-align:right}',
            '.et-card-digest{font-size:10.5px;line-height:1.4;color:var(--et-ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
            '.et-card-toggle{margin-left:0;font:inherit;font-size:9.5px;line-height:1.5;padding:0 6px;border-radius:6px;border:1px solid var(--et-line);background:var(--et-surface);color:var(--et-ink2);cursor:pointer}',
            '.et-card-toggle:hover{background:var(--et-layer);color:var(--et-ink)}',
            '.et-digest{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:rgba(47,111,159,.08);border:1px solid rgba(47,111,159,.25);font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
            '.et-digest b{font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--et-ink3);display:block;margin-bottom:2px}',
            '.et-digest-history{margin-top:6px;font-size:10.5px;line-height:1.5;color:var(--et-ink2)}',
            '.et-digest-version{opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.et-badge{flex:0 0 auto;font-size:9.5px;padding:0 5px;border-radius:4px;border:1px solid currentColor;opacity:.95;line-height:1.6}',
            '.et-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block}',
            '.et-section{margin:0;padding:11px 12px;border:1px solid var(--et-line-soft);border-radius:14px;background:var(--et-surface);box-shadow:var(--et-card-shadow)}',
            '.et-section h3{margin:0 0 8px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--et-ink3);display:flex;align-items:center;justify-content:space-between;gap:8px}',
            '.et-detail-title{margin:7px 0 5px;font-size:14px;font-weight:700;line-height:1.4;overflow-wrap:anywhere;letter-spacing:-.005em}',
            '.et-summary{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:var(--et-ink2)}',
            '.et-summary[data-clamped="1"]{max-height:8.8em;overflow:hidden;mask-image:linear-gradient(180deg,#000 62%,transparent)}',
            '.et-summary-toggle{margin-top:4px}',
            '.et-path{display:flex;flex-wrap:wrap;gap:2px 4px;align-items:center;font-size:10.5px;color:var(--et-ink3);overflow-wrap:anywhere;margin-bottom:2px}',
            '.et-path button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-decoration:underline dotted;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.et-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px}',
            '.et-item{padding:7px 9px;border:1px solid var(--et-line-soft);border-radius:10px;background:var(--et-layer)}',
            '.et-item[data-clickable="1"]{cursor:pointer}',
            '.et-item[data-clickable="1"]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,168,.12))}',
            '.et-item-title{display:flex;gap:6px;align-items:baseline;font-weight:600;font-size:11.5px;overflow-wrap:anywhere}',
            '.et-item-sub{font-size:10.5px;color:var(--et-ink3);overflow-wrap:anywhere;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
            '.et-reason{margin:3px 0 0;font-size:11px;color:var(--et-ink2);overflow-wrap:anywhere}',
            '.et-avoid{border-color:rgba(190,80,77,.45)}',
            '.et-tag{display:inline-block;flex:0 0 auto;white-space:nowrap;margin:4px 4px 0 0;padding:0 6px;font-size:10px;border-radius:999px;background:rgba(128,140,168,.16)}',
            '.et-empty{padding:48px 24px;text-align:center;max-width:600px;margin:0 auto;color:var(--et-ink2)}',
            '.et-empty-orb{width:44px;height:44px;margin:0 auto 12px;border-radius:14px;background:conic-gradient(from 180deg,#4d6bfe,#2f8f83,#8a63d2,#4d6bfe);opacity:.9;animation:et-spin 3.2s linear infinite;box-shadow:0 10px 24px -12px rgba(77,107,254,.8)}',
            '.et-empty-orb::after{content:"";display:block;width:28px;height:28px;border-radius:9px;background:var(--et-surface);transform:translate(8px,8px)}',
            '.et-err{color:#c0504d}',
            '.et-fold{border:1px solid var(--et-line-soft);border-radius:13px;background:var(--et-surface);box-shadow:var(--et-card-shadow);padding:9px 11px}',
            '.et-fold>summary{cursor:pointer;font-size:10.5px;font-weight:700;color:var(--et-ink3);letter-spacing:.06em;text-transform:uppercase}',
            '.et-fold[data-count="0"]>summary{color:var(--et-ink3);font-weight:600}',
            '.et-fold-body{padding-top:8px}',
            '.et-overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}',
            '.et-overview-cell{padding:7px 8px;border-radius:9px;background:var(--et-layer);border:1px solid var(--et-line-soft)}',
            '.et-overview-cell b{display:block;font-size:17px;line-height:1.25;font-variant-numeric:tabular-nums}',
            '.et-overview-cell span{font-size:10px;color:var(--et-ink3)}',
            '.et-ai{position:relative;overflow:hidden;border:1px solid rgba(77,107,254,.22);background:linear-gradient(120deg,rgba(77,107,254,.055),rgba(47,143,131,.045) 55%,var(--et-surface) 80%)}',
            '.et-ai::after{content:"";position:absolute;width:340px;height:340px;right:-150px;top:-230px;border-radius:50%;background:radial-gradient(circle,rgba(120,96,255,.2),transparent 70%);pointer-events:none}',
            '.et-ai-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;position:relative;z-index:1}',
            '.et-ai-orb{flex:0 0 auto;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4d6bfe,#8a63d2 65%,#2f8f83);box-shadow:0 9px 20px -12px rgba(77,107,254,.95)}',
            '.et-ai-orb svg{display:block}',
            '.et-ai-badge{margin-left:auto;font-size:10px;font-weight:650;letter-spacing:.04em;padding:3px 9px;border-radius:999px;border:1px solid rgba(77,107,254,.26);background:rgba(77,107,254,.09);color:#3f5bd9;white-space:nowrap}',
            '.et-ai-badge[data-state="loading"]{animation:et-breathe 1.6s ease-in-out infinite}',
            '.et-ai-badge[data-state="error"]{border-color:rgba(208,85,85,.32);background:rgba(208,85,85,.09);color:#b24141}',
            '.et-ai-body{margin-top:10px;display:flex;flex-direction:column;gap:10px;position:relative;z-index:1}',
            '.et-ai-headline{margin:0;font-size:15px;font-weight:700;letter-spacing:.01em;line-height:1.45}',
            '.et-ai-summary{margin:0;font-size:12px;line-height:1.68;color:var(--et-ink2);max-width:88ch}',
            '.et-ai-findings{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:8px}',
            '.et-ai-finding{padding:10px 11px;border:1px solid var(--et-line-soft);border-left:3px solid var(--et-ink3);border-radius:11px;background:var(--et-surface);min-width:0}',
            '.et-ai-finding[data-kind="progress"]{border-left-color:#2f8f83}',
            '.et-ai-finding[data-kind="blocker"]{border-left-color:#d05555}',
            '.et-ai-finding[data-kind="risk"]{border-left-color:#d08a00}',
            '.et-ai-finding[data-kind="insight"]{border-left-color:#8a63d2}',
            '.et-ai-kind{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.06em;margin-bottom:4px;color:var(--et-ink3)}',
            '.et-ai-finding[data-kind="progress"] .et-ai-kind{color:#2f8f83}',
            '.et-ai-finding[data-kind="blocker"] .et-ai-kind{color:#b24141}',
            '.et-ai-finding[data-kind="risk"] .et-ai-kind{color:#a76a00}',
            '.et-ai-finding[data-kind="insight"] .et-ai-kind{color:#7650bd}',
            '.et-ai-finding h4{margin:0 0 3px;font-size:12px;font-weight:650;line-height:1.45;overflow-wrap:anywhere}',
            '.et-ai-finding p{margin:0;font-size:11px;line-height:1.6;color:var(--et-ink2);overflow-wrap:anywhere}',
            '.et-ai-refs{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}',
            '.et-ai-ref{font:inherit;font-size:10px;line-height:1.4;padding:1px 6px;border-radius:6px;border:1px solid var(--et-line);background:var(--et-layer);color:var(--et-ink2);cursor:pointer}',
            '.et-ai-ref:hover{color:var(--et-accent);border-color:rgba(77,107,254,.5)}',
            '.et-ai-recs{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:8px;margin:0;padding:0;list-style:none}',
            '.et-ai-rec{display:flex;gap:8px;padding:8px 10px;border-radius:11px;background:rgba(77,107,254,.055);border:1px solid rgba(77,107,254,.15);font-size:11px;line-height:1.55;min-width:0}',
            '.et-ai-rec i{flex:0 0 auto;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;font-size:9px;font-style:normal;font-weight:700;background:linear-gradient(135deg,#4d6bfe,#2f8f83);color:#fff;margin-top:1px}',
            '.et-ai-rec b{display:block;font-size:11.5px;margin-bottom:1px;overflow-wrap:anywhere}',
            '.et-ai-rec span{color:var(--et-ink2);overflow-wrap:anywhere}',
            '.et-ai-meta{font-size:10.5px;color:var(--et-ink3);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
            '.et-ai-empty{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:12px;border:1px dashed rgba(77,107,254,.3);background:rgba(77,107,254,.04)}',
            '.et-ai-empty p{margin:0;font-size:11.5px;line-height:1.6;color:var(--et-ink2);flex:1 1 260px}',
            '.et-ai-skel{display:flex;flex-direction:column;gap:7px}',
            '.et-ai-skel i{display:block;height:11px;border-radius:6px;background:linear-gradient(90deg,rgba(128,140,168,.16),rgba(128,140,168,.05),rgba(128,140,168,.16));background-size:200% 100%;animation:et-shimmer 1.4s linear infinite}',
            '.et-ai-skel i:nth-child(2){width:84%}',
            '.et-ai-skel i:nth-child(3){width:62%}',
            '.et-ai-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto;position:relative;z-index:1}',
            '@keyframes et-breathe{0%,100%{opacity:.6}50%{opacity:1}}',
            '@keyframes et-shimmer{from{background-position:0 0}to{background-position:-200% 0}}',
            '.et-set-root{max-width:1080px;padding:2px 0 30px;font:var(--dsw-font-xs-13,13px)/1.6 var(--dsw-font-family,inherit);color:var(--et-ink)}',
            '.et-set-head{position:relative;padding:15px 17px;margin-bottom:13px;border:1px solid var(--et-line-soft);border-radius:16px;background:linear-gradient(120deg,rgba(77,107,254,.075),rgba(47,143,131,.05) 60%,var(--et-surface) 85%);box-shadow:var(--et-card-shadow);overflow:hidden}',
            '.et-set-head::after{content:"";position:absolute;width:220px;height:220px;right:-90px;top:-140px;border-radius:50%;background:radial-gradient(circle,rgba(77,107,254,.16),transparent 70%);pointer-events:none}',
            '.et-set-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
            '.et-set-title h2{margin:0;font-size:17px;font-weight:700;letter-spacing:.01em}',
            '.et-set-badge{font-size:10px;font-weight:650;letter-spacing:.04em;padding:2px 8px;border-radius:999px;border:1px solid rgba(47,143,131,.28);background:rgba(47,143,131,.09);color:#237a6f}',
            '.et-set-head p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--et-ink2);max-width:72ch}',
            '.et-set-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px;align-items:start}',
            '.et-set-group{margin:0;padding:12px 15px 5px;border:1px solid var(--et-line-soft);border-radius:16px;background:var(--et-surface);box-shadow:var(--et-card-shadow);min-width:0}',
            '.et-set-group[data-wide="1"]{grid-column:1/-1}',
            '.et-set-group h3{display:flex;align-items:center;gap:7px;margin:0 0 4px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--et-ink3)}',
            '.et-set-group h3::before{content:"";width:15px;height:15px;border-radius:6px;background:linear-gradient(135deg,rgba(77,107,254,.9),rgba(47,143,131,.8));box-shadow:0 3px 8px -4px rgba(77,107,254,.8)}',
            '.et-set-row{display:flex;align-items:center;gap:14px;padding:10px 8px;margin:0 -8px;border-top:1px solid var(--et-line-soft);border-radius:10px;cursor:pointer;transition:background .15s ease}',
            '.et-set-row:hover{background:var(--et-layer)}',
            '.et-set-row:first-of-type{border-top:0}',
            '.et-set-row-main{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
            '.et-set-row-title{font-size:12.5px;font-weight:600}',
            '.et-set-row-desc{font-size:11px;line-height:1.55;color:var(--et-ink3)}',
            '.et-set-switch{position:relative;flex:0 0 auto;width:36px;height:21px;display:inline-block}',
            '.et-set-check{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:2}',
            '.et-set-track{position:absolute;inset:0;border-radius:999px;background:rgba(128,140,168,.34);transition:background .18s ease}',
            '.et-set-track::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.32);transition:transform .18s cubic-bezier(.2,.8,.2,1)}',
            '.et-set-check:checked + .et-set-track{background:linear-gradient(135deg,#4d6bfe,#2f8f83)}',
            '.et-set-check:checked + .et-set-track::after{transform:translateX(15px)}',
            '.et-set-check:focus-visible + .et-set-track{outline:2px solid rgba(77,107,254,.55);outline-offset:2px}',
            '.et-set-ai{margin:4px 0 9px;padding:11px 12px;border:1px dashed rgba(77,107,254,.28);border-radius:12px;background:rgba(77,107,254,.04)}',
            '.et-set-ai b{display:block;font-size:11.5px;margin-bottom:3px}',
            '.et-set-ai p{margin:0 0 5px;font-size:11px;line-height:1.6;color:var(--et-ink2)}',
            '.et-set-ai code{font-size:10.5px;padding:1px 6px;border-radius:6px;background:var(--et-layer);border:1px solid var(--et-line-soft);color:var(--et-ink2)}',
            '.et-set-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;padding:0 2px}',
            '.et-set-btn{font:inherit;font-size:12px;line-height:1.5;padding:6px 14px;border:1px solid var(--et-line);border-radius:9px;background:var(--et-surface);color:var(--et-ink2);cursor:pointer;transition:border-color .15s ease,color .15s ease}',
            '.et-set-btn:hover{border-color:rgba(77,107,254,.55);color:var(--et-ink)}',
            '.et-set-note{font-size:11px;color:var(--et-ink3)}',
            '.et-preview-root{display:flex;flex-direction:column;gap:10px;padding:12px 12px 28px;font:var(--dsw-font-xs-13,13px)/1.55 var(--dsw-font-family,inherit);color:var(--et-ink);box-sizing:border-box;width:100%;min-width:0}',
            '.et-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
            '.et-preview-head h2{margin:0;font-size:14px;font-weight:700;letter-spacing:.01em;flex:0 0 auto}',
            '.et-preview-ws{font-size:11px;max-width:100%;padding:1px 8px;border-radius:999px;background:var(--et-layer);border:1px solid var(--et-line-soft);color:var(--et-ink2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
            '.et-preview-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}',
            '.et-preview-metric{padding:8px 9px;border-radius:11px;background:var(--et-surface);border:1px solid var(--et-line-soft);min-width:0;box-shadow:var(--et-card-shadow)}',
            '.et-preview-metric b{display:block;font-size:17px;line-height:1.25;font-variant-numeric:tabular-nums}',
            '.et-preview-metric span{font-size:10px;color:var(--et-ink3);white-space:nowrap}',
            '.et-preview-section{padding:10px;border:1px solid var(--et-line-soft);border-radius:13px;background:var(--et-surface);box-shadow:var(--et-card-shadow);min-width:0}',
            '.et-preview-label{font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--et-ink3);margin-bottom:6px}',
            '.et-preview-goal{font-size:12px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}',
            '.et-preview-item{padding:6px 0;border-top:1px solid var(--et-line-soft);font-size:11px;line-height:1.5;overflow-wrap:anywhere}',
            '.et-preview-item:first-of-type{border-top:0;padding-top:0}',
            '.et-preview-item summary{cursor:pointer;display:flex;gap:5px;align-items:baseline;font-weight:600;font-size:11px}',
            '.et-preview-item .et-preview-sub{margin:3px 0 0;color:var(--et-ink2);font-size:10.5px}',
            '.et-preview-next .et-reason{margin-top:4px}',
            '.et-preview-foot{margin:0;font-size:10.5px;line-height:1.5;color:var(--et-ink3)}',
            '.et-preview-hint{margin:0;font-size:11px;color:var(--et-ink2)}',
            '.et-preview-spark{display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--et-line-soft);border-radius:11px;background:var(--et-surface);box-shadow:var(--et-card-shadow)}',
            '.et-preview-spark svg{flex:1 1 auto;min-width:0;width:100%;height:26px}',
            '.et-preview-spark span{flex:0 0 auto;font-size:10px;color:var(--et-ink3)}',
            '@keyframes et-ping{0%{box-shadow:0 0 0 0 rgba(46,139,87,.5)}65%{box-shadow:0 0 0 6px rgba(46,139,87,0)}100%{box-shadow:0 0 0 0 rgba(46,139,87,0)}}',
            '@keyframes et-pulse{0%{transform:scale(.55);opacity:.55}70%{transform:scale(1.7);opacity:0}100%{transform:scale(1.7);opacity:0}}',
            '@keyframes et-ring{0%{transform:scale(.985);opacity:.9}55%{transform:scale(1.018);opacity:.28}100%{transform:scale(1.02);opacity:0}}',
            '@keyframes et-rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',
            '@keyframes et-pop{0%{opacity:0;transform:translateY(-3px) scale(.8)}100%{opacity:1;transform:none}}',
            '@keyframes et-spin{to{transform:rotate(360deg)}}',
            '@keyframes et-flow{to{stroke-dashoffset:-26}}',
            '@media (max-width: 1320px){.et-dash-row[data-cols="3"]{grid-template-columns:repeat(2,minmax(0,1fr))}.et-dash-row[data-cols="2"]{grid-template-columns:minmax(0,1fr)}}',
            '@media (max-width: 1200px){.et-outline{display:none}.et-kpis{margin-left:0}}',
            '@media (max-width: 1000px){.et-body{flex-direction:column}.et-side{width:100%;flex-basis:auto}.et-canvas{width:100%}.et-dash-row[data-cols="3"],.et-dash-row[data-cols="2+1"],.et-dash-row[data-cols="2+1b"]{grid-template-columns:minmax(0,1fr)}.et-dash-row[data-cols="2+1"]>*:nth-child(3),.et-dash-row[data-cols="2+1b"]>*{grid-column:auto;grid-row:auto}.et-dash-row[data-cols="2+1b"] .et-fold-body .et-list{grid-template-columns:minmax(0,1fr)}.et-heat{grid-auto-columns:10px;grid-template-rows:repeat(7,10px)}}',
            '@media (prefers-reduced-motion: reduce){.et-root *,.et-set-root *,.et-preview-root *{animation:none!important;transition:none!important}}',
        ].join('');



        // ───────────────────────────── 数据 ─────────────────────────────

        function fetchJson(url) {
            return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }

        // POST 时宿主会回 {ok:false,error,code}，把后端错误码带到前端，便于显示「未配置模型」等可操作提示。
        function postJson(url) {
            return fetch(url, { method: 'POST', headers: { accept: 'application/json' } }).then(function (response) {
                return response.json().catch(function () { return null; }).then(function (body) {
                    if (body !== null && body !== undefined && body.ok === false) {
                        var failure = new Error(typeof body.error === 'string' && body.error !== '' ? body.error : ('HTTP ' + response.status));
                        failure.code = body.code ?? 'analysis_failed';
                        failure.status = response.status;
                        throw failure;
                    }
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return body;
                });
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

        function nodePhaseLabel(node) {
            if (node !== null && node !== undefined && typeof node.phase === 'string' && PHASE_LABEL[node.phase] !== undefined) {
                return PHASE_LABEL[node.phase];
            }
            return STATUS_LABEL[node?.status] ?? node?.status ?? '';
        }

        function nodePhaseColor(node) {
            return PHASE_COLOR[node?.phase] ?? STATUS_COLOR[node?.status] ?? '#8a8a8a';
        }

        function isTodoNode(node) {
            if (node === null || node === undefined) return false;
            if (typeof node.phase === 'string') return node.phase === 'todo';
            return (node.kind === 'question' || node.kind === 'hypothesis' || node.kind === 'decision')
                && (node.status === 'open' || node.status === 'active');
        }

        function Dot(props) {
            return h('span', {
                className: 'et-dot',
                style: { background: props.color ?? STATUS_COLOR[props.status] ?? '#8a8a8a' },
                title: props.label ?? STATUS_LABEL[props.status] ?? props.status,
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
                    h(Dot, { status: node.status, color: nodePhaseColor(node), label: nodePhaseLabel(node) }),
                    h('span', { className: 'et-faint' }, nodePhaseLabel(node)),
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
            var digest = props.digest ?? null;
            var workspaceDigest = props.workspaceDigest ?? null;
            var openNodes = Array.isArray(openInfo?.items)
                ? openInfo.items
                : nodes.filter(function (node) { return node.status === 'open' || node.status === 'active'; }).slice(0, 8);
            var openCount = digest !== null ? (digest.todo?.visible ?? openNodes.length)
                : (openInfo !== null ? (openInfo.visibleCount ?? openNodes.length)
                    : (byStatus.open ?? 0) + (byStatus.active ?? 0));
            var scopeLabel = digest !== null && digest.scope === 'session' ? '本会话' : '全图';
            var todo = digest?.todo ?? {};
            var closedCount = (digest?.completed ?? 0) + (digest?.closed ?? 0);
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
                    h('h3', null, '待办 · ' + openCount + (digest !== null ? ' · ' + scopeLabel : '')),
                    digest !== null
                        ? h('p', { className: 'et-hint', style: { marginBottom: '6px' } },
                            '共 ' + (todo.total ?? openCount) + ' · 强 ' + (todo.strong ?? 0) + ' / 自动 ' + (todo.weak ?? 0)
                            + ' · 已折叠 ' + (todo.hidden ?? 0)
                            + ' · 进行中 ' + (digest.doing ?? 0)
                            + ' · 已记录 ' + (digest.recorded ?? 0)
                            + ' · 已收束 ' + closedCount
                            + ' · 真死路 ' + (digest.deadEnd ?? 0))
                        : null,
                    digest !== null && digest.scope === 'session' && workspaceDigest !== null
                        ? h('p', { className: 'et-hint', style: { marginBottom: '6px' } },
                            '全图：待办 ' + (workspaceDigest.todo?.visible ?? 0) + '（强 ' + (workspaceDigest.todo?.strong ?? 0) + '）'
                            + ' · 已记录 ' + (workspaceDigest.recorded ?? 0) + ' · 真死路 ' + (workspaceDigest.deadEnd ?? 0))
                        : null,
                    openNodes.length === 0
                        ? h('p', { className: 'et-hint' }, '没有待办节点。')
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
            var limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : 6;
            var avoidLimit = Number.isInteger(props.avoidLimit) && props.avoidLimit >= 0 ? props.avoidLimit : 6;
            return h('details', { className: 'et-fold', 'data-count': suggestions.length > 0 ? '1' : '0', open: suggestions.length > 0 },
                h('summary', null, '下一步建议 · ' + suggestions.length),
                h('div', { className: 'et-fold-body' },
                    suggestions.length === 0
                        ? h('p', { className: 'et-hint' }, '没有建议。')
                        : h('ul', { className: 'et-list' }, suggestions.slice(0, limit).map(function (suggestion, index) {
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
                            h('ul', { className: 'et-list' }, avoid.slice(0, avoidLimit).map(function (item, index) {
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
                        h('span', { className: 'et-outline-count' }, stats === undefined || stats.total === 0 ? '' : String(stats.total)),
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
                                    h('span', { className: 'et-outline-count' }, stats === undefined || stats.total === 0 ? '' : String(stats.total)),
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
                                    h(Dot, { status: node.status, color: nodePhaseColor(node), label: nodePhaseLabel(node) }),
                                    h('span', null, nodePhaseLabel(node)),
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
         * 右侧栏预览：当前会话目标、待办前 3 与第一条建议。
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
                var params = [];
                if (wanted !== '') params.push('workspace=' + encodeURIComponent(wanted));
                if (typeof props.sessionId === 'string' && props.sessionId !== '') {
                    params.push('session=' + encodeURIComponent(props.sessionId));
                }
                var query = params.length > 0 ? '?' + params.join('&') : '';
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
            var digest = snapshot?.digest ?? null;
            var workspaceDigest = snapshot?.workspaceDigest ?? null;
            var openInfo = snapshot?.open ?? null;
            var openItems = Array.isArray(openInfo?.items) ? openInfo.items.slice(0, 3) : [];
            var goal = previewGoalOf(snapshot, props.sessionId);
            var suggestions = Array.isArray(snapshot?.frontier?.suggestions) ? snapshot.frontier.suggestions : [];
            var suggestion = suggestions.length > 0 ? suggestions[0] : null;
            var workspaceName = typeof snapshot?.workspace?.name === 'string' && snapshot.workspace.name !== ''
                ? snapshot.workspace.name
                : (sessionCwd !== '' ? workspaceLabel({ path: sessionCwd }) : '当前会话工作区');
            var openCount = digest !== null ? (digest.todo?.visible ?? 0)
                : (stats.openUnresolved ?? (openInfo !== null ? openInfo.visibleCount : 0));
            var scopeLabel = digest !== null && digest.scope === 'session' ? '本会话' : '全图';

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
                            h('div', { className: 'et-preview-metric', title: '待办只算 question/hypothesis/decision；结构节点不算' }, h('b', null, String(openCount)), h('span', null, '待办')),
                            h('div', { className: 'et-preview-metric' }, h('b', null, String(stats.edges ?? 0)), h('span', null, '关系')),
                        ),
                        h('div', { className: 'et-preview-section' },
                            h('div', { className: 'et-preview-label' }, '当前目标'),
                            goal !== null
                                ? h('div', { className: 'et-preview-goal' }, goal.title)
                                : h('p', { className: 'et-preview-hint' }, '还没有目标；在会话里提出任务后自动建立。'),
                        ),
                        h('div', { className: 'et-preview-section' },
                            h('div', { className: 'et-preview-label' }, '待办 · ' + openCount + (digest !== null ? ' · ' + scopeLabel : '')),
                            digest !== null
                                ? h('p', { className: 'et-preview-hint' },
                                    '强 ' + (digest.todo?.strong ?? 0) + ' / 自动 ' + (digest.todo?.weak ?? 0)
                                    + ' · 进行中 ' + (digest.doing ?? 0) + ' · 已记录 ' + (digest.recorded ?? 0))
                                : null,
                            digest !== null && digest.scope === 'session' && workspaceDigest !== null
                                ? h('p', { className: 'et-preview-hint' },
                                    '全图：待办 ' + (workspaceDigest.todo?.visible ?? 0)
                                    + '（强 ' + (workspaceDigest.todo?.strong ?? 0) + '）'
                                    + ' · 已记录 ' + (workspaceDigest.recorded ?? 0)
                                    + ' · 真死路 ' + (workspaceDigest.deadEnd ?? 0))
                                : null,
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
                                : h('p', { className: 'et-preview-hint' }, '没有可见待办项。'),
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
                h('span', { className: 'et-set-switch' },
                    h('input', {
                        type: 'checkbox',
                        className: 'et-set-check',
                        checked: props.checked,
                        onChange: function (event) { props.onChange(event.target.checked); },
                    }),
                    h('i', { className: 'et-set-track' }),
                ),
            );
        }

        function ExploreTreeSettings() {
            var prefs = usePrefs();
            return h('section', { className: 'et-set-root', 'data-plugin': 'dsh-explore-tree' },
                h('style', null, CSS),
                h('div', { className: 'et-set-head' },
                    h('div', { className: 'et-set-title' },
                        h('span', { className: 'et-logo', 'aria-hidden': 'true', style: { width: '28px', height: '28px', borderRadius: '9px' } },
                            h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none' },
                                h('circle', { cx: 12, cy: 5.4, r: 2.6, fill: 'currentColor', opacity: '.95' }),
                                h('circle', { cx: 5.6, cy: 17.4, r: 2.6, fill: 'currentColor', opacity: '.8' }),
                                h('circle', { cx: 18.4, cy: 17.4, r: 2.6, fill: 'currentColor', opacity: '.8' }),
                                h('path', { d: 'M10.6 7.6 7 14.8M13.4 7.6 17 14.8M8.2 17.4h7.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: '.9' }),
                            ),
                        ),
                        h('h2', null, '研究轨迹'),
                        h('span', { className: 'et-set-badge' }, '偏好 · 即时生效'),
                    ),
                    h('p', null, '面板的显示与过滤偏好。修改立即生效，保存在当前浏览器；不影响研究图数据与团队共享状态。'),
                ),
                h('div', { className: 'et-set-grid' },
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
                        title: '只看待办',
                        desc: '非待办节点变淡显示，便于聚焦当前问题。',
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
                h('div', { className: 'et-set-group', 'data-wide': '1' },
                    h('h3', null, 'AI 解析'),
                    h(ToggleRow, {
                        title: '显示 AI 解析',
                        desc: '在概览页展示模型对研究图的解读；关闭后不发起解析请求。',
                        checked: prefs.showAnalysis,
                        onChange: function (value) { setPref('showAnalysis', value); },
                    }),
                    h('div', { className: 'et-set-ai' },
                        h('b', null, '模型路由'),
                        h('p', null, '默认继承插件的 llm.provider / llm.model；也可以为解析单独指定 analysis.provider 与 analysis.model。'),
                        h('p', null, '解析结果在宿主内存缓存 10 分钟，概览页的「重新解析」可跳过缓存。'),
                        h('code', null, 'analysis.maxInputChars = 12000'),
                    ),
                ),
                h('div', { className: 'et-set-actions' },
                    h('button', { type: 'button', className: 'et-set-btn', onClick: resetPrefs }, '恢复默认'),
                    h('span', { className: 'et-set-note' }, '恢复默认不会改动研究图，只重置本页偏好。'),
                ),
                ),
            );
        }

        // ───────────────────────────── 主面板 ─────────────────────────────

        var DAY_MS = 86400000;
        var PHASE_ORDER = ['doing', 'todo', 'recorded', 'completed', 'closed', 'dead_end', 'curated', 'merged', 'tool_noise', 'aborted'];

        function timeOf(value) {
            if (typeof value !== 'string' || value === '') return null;
            var parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : null;
        }

        function startOfDay(ts) {
            var date = new Date(ts);
            date.setHours(0, 0, 0, 0);
            return date.getTime();
        }

        function two(n) { return n < 10 ? '0' + n : String(n); }

        function monthDay(ts) {
            var date = new Date(ts);
            return (date.getMonth() + 1) + '/' + date.getDate();
        }

        function relativeTime(ts, now) {
            if (ts === null) return '';
            var diff = Math.max(0, now - ts);
            var minutes = Math.floor(diff / 60000);
            if (minutes < 1) return '刚刚';
            if (minutes < 60) return minutes + ' 分钟前';
            var hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + ' 小时前';
            var days = Math.floor(hours / 24);
            if (days < 30) return days + ' 天前';
            return monthDay(ts);
        }

        function phaseOfNode(node) {
            if (typeof node.phase === 'string' && node.phase !== '') return node.phase;
            return node.status === 'done' ? 'completed' : 'todo';
        }

        function phaseCountsOf(nodes) {
            var counts = {};
            for (var i = 0; i < nodes.length; i += 1) {
                var phase = phaseOfNode(nodes[i]);
                counts[phase] = (counts[phase] ?? 0) + 1;
            }
            return counts;
        }

        function buildTrend(nodes, days, now) {
            var end = startOfDay(now);
            var start = end - (days - 1) * DAY_MS;
            var created = [];
            var updated = [];
            for (var k = 0; k < days; k += 1) { created.push(0); updated.push(0); }
            var base = 0;
            for (var i = 0; i < nodes.length; i += 1) {
                var c = timeOf(nodes[i].createdAt);
                if (c !== null) {
                    if (c < start) base += 1;
                    else {
                        var ci = Math.floor((startOfDay(c) - start) / DAY_MS);
                        if (ci >= 0 && ci < days) created[ci] += 1;
                    }
                }
                var u = timeOf(nodes[i].updatedAt);
                if (u !== null) {
                    var ui = Math.floor((startOfDay(u) - start) / DAY_MS);
                    if (ui >= 0 && ui < days) updated[ui] += 1;
                }
            }
            var rows = [];
            var running = base;
            var maxCreated = 0;
            var maxCum = 1;
            for (var j = 0; j < days; j += 1) {
                running += created[j];
                if (created[j] > maxCreated) maxCreated = created[j];
                if (running > maxCum) maxCum = running;
                rows.push({
                    t: start + j * DAY_MS,
                    created: created[j],
                    updated: updated[j],
                    cumulative: running,
                });
            }
            return { start: start, end: end, days: days, rows: rows, base: base, maxCreated: maxCreated, maxCum: maxCum, total: running };
        }

        function buildHeatmap(nodes, weeks, now) {
            var end = startOfDay(now);
            var dow = (new Date(end).getDay() + 6) % 7;
            var monday = end - dow * DAY_MS;
            var start = monday - (weeks - 1) * 7 * DAY_MS;
            var span = weeks * 7;
            var counts = [];
            for (var k = 0; k < span; k += 1) counts.push(0);
            var indexOf = function (ts) {
                var diff = Math.round((startOfDay(ts) - start) / DAY_MS);
                return diff >= 0 && diff < span ? diff : -1;
            };
            for (var i = 0; i < nodes.length; i += 1) {
                var c = timeOf(nodes[i].createdAt);
                var u = timeOf(nodes[i].updatedAt);
                if (c !== null) { var ci = indexOf(c); if (ci >= 0) counts[ci] += 1; }
                if (u !== null) { var ui = indexOf(u); if (ui >= 0 && ui !== ci) counts[ui] += 1; }
            }
            var max = 1;
            var active = 0;
            var total = 0;
            for (var m = 0; m < counts.length; m += 1) {
                total += counts[m];
                if (counts[m] > 0) active += 1;
                if (counts[m] > max) max = counts[m];
            }
            var peakT = null;
            var cells = [];
            for (var n = 0; n < span; n += 1) {
                var dayStart = start + n * DAY_MS;
                var ratio = counts[n] / max;
                var level = counts[n] === 0 ? 0 : (ratio <= 0.25 ? 1 : (ratio <= 0.5 ? 2 : (ratio <= 0.75 ? 3 : 4)));
                if (counts[n] > 0 && counts[n] === max && peakT === null) peakT = dayStart;
                cells.push({ t: dayStart, count: counts[n], level: level, future: dayStart > end });
            }
            var streak = 0;
            for (var s = cells.length - 1; s >= 0; s -= 1) {
                if (cells[s].future) continue;
                if (cells[s].count > 0) streak += 1;
                else break;
            }
            return { start: start, end: end, cells: cells, max: max, active: active, total: total, streak: streak, peakT: peakT };
        }

        function Sparkline(props) {
            var rows = Array.isArray(props.rows) ? props.rows : [];
            var width = props.width ?? 120;
            var height = props.height ?? 30;
            var values = rows.map(function (row) { return row.created ?? 0; });
            var max = 1;
            for (var i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
            var pointX = function (index) {
                return values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
            };
            var pointY = function (value) {
                return height - 2 - (value / max) * (height - 4);
            };
            var line = '';
            for (var j = 0; j < values.length; j += 1) {
                line += (j === 0 ? 'M ' : 'L ') + pointX(j).toFixed(1) + ' ' + pointY(values[j]).toFixed(1) + ' ';
            }
            var area = values.length === 0 ? '' : line + 'L ' + width + ' ' + height + ' L 0 ' + height + ' Z';
            return h('svg', { className: 'et-spark', width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
                values.length === 0 ? null : h('path', { className: 'et-spark-area', d: area }),
                values.length === 0 ? null : h('path', { className: 'et-spark-line', d: line }),
            );
        }

        function TrendChart(props) {
            var rows = Array.isArray(props.rows) ? props.rows : [];
            var hoverPair = React.useState(-1);
            var hover = hoverPair[0];
            var setHover = hoverPair[1];
            var width = 720;
            var height = 238;
            var padL = 38;
            var padR = 16;
            var padT = 14;
            var padB = 26;
            var plotW = width - padL - padR;
            var plotH = height - padT - padB;
            var band = 44;
            var count = rows.length;
            var maxCum = Math.max(1, props.maxCum ?? 1);
            var maxCreated = Math.max(1, props.maxCreated ?? 1);
            var xOf = function (index) {
                return count <= 1 ? padL + plotW / 2 : padL + (index / (count - 1)) * plotW;
            };
            var yOf = function (value) {
                return padT + plotH - (value / maxCum) * plotH;
            };
            var line = '';
            var area = '';
            if (count > 0) {
                for (var i = 0; i < count; i += 1) {
                    line += (i === 0 ? 'M ' : 'L ') + xOf(i).toFixed(1) + ' ' + yOf(rows[i].cumulative).toFixed(1) + ' ';
                }
                area = line + 'L ' + xOf(count - 1).toFixed(1) + ' ' + (padT + plotH) + ' L ' + xOf(0).toFixed(1) + ' ' + (padT + plotH) + ' Z';
            }
            var barWidth = Math.max(2, (plotW / Math.max(1, count)) * 0.56);
            var grid = [0, 0.5, 1].map(function (ratio, index) {
                var y = padT + plotH - plotH * ratio;
                var value = Math.round(maxCum * ratio);
                return h('g', { key: 'grid' + index },
                    h('line', { className: 'et-chart-grid', x1: padL, x2: width - padR, y1: y, y2: y }),
                    h('text', { className: 'et-chart-axis', x: padL - 7, y: y + 3, textAnchor: 'end' }, String(value)),
                );
            });
            var tickIndexes = count <= 1 ? [0] : [0, Math.floor((count - 1) / 2), count - 1];
            var xLabels = tickIndexes.map(function (index) {
                return h('text', {
                    key: 'x' + index,
                    className: 'et-chart-axis',
                    x: xOf(index),
                    y: height - 7,
                    textAnchor: index === 0 ? 'start' : (index === count - 1 ? 'end' : 'middle'),
                }, monthDay(rows[index].t));
            });
            var bars = rows.map(function (row, index) {
                var barHeight = (row.created / maxCreated) * band;
                return h('rect', {
                    key: 'bar' + index,
                    className: 'et-chart-bar',
                    'data-on': hover === index ? '1' : '0',
                    x: (xOf(index) - barWidth / 2).toFixed(1),
                    y: (padT + plotH - barHeight).toFixed(1),
                    width: barWidth.toFixed(1),
                    height: Math.max(0, barHeight).toFixed(1),
                    rx: 2,
                });
            });
            var last = rows[count - 1];
            var hoverRows = rows.map(function (row, index) {
                var step = plotW / Math.max(1, count);
                return h('rect', {
                    key: 'hover' + index,
                    className: 'et-chart-hover',
                    x: (xOf(index) - step / 2).toFixed(1),
                    y: padT,
                    width: step.toFixed(1),
                    height: plotH,
                    onMouseEnter: function () { setHover(index); },
                    onMouseLeave: function () { setHover(-1); },
                }, h('title', null, monthDay(row.t) + ' · 新增 ' + row.created + ' · 累计 ' + row.cumulative));
            });
            var tip = null;
            if (hover >= 0 && rows[hover] !== undefined) {
                var tipW = 152;
                var tipH = 42;
                var pointX = xOf(hover);
                var pointY = yOf(rows[hover].cumulative);
                var tipX = Math.min(width - padR - tipW, Math.max(padL, pointX - tipW / 2));
                // 贴近悬停点：优先在点上方，靠近顶部时翻到下方，再夹在绘图区内，避免遮挡网格与坐标轴。
                var tipY = pointY - tipH - 12;
                if (tipY < padT + 2) tipY = pointY + 14;
                tipY = Math.min(padT + plotH - tipH - 2, Math.max(padT + 2, tipY));
                var tipAnchorX = Math.max(tipX + 9, Math.min(pointX + 9, tipX + tipW - 9));
                tip = h('g', { key: 'tip', style: { pointerEvents: 'none' } },
                    h('line', { className: 'et-chart-hover-line', x1: pointX, x2: pointX, y1: padT, y2: padT + plotH }),
                    h('circle', { className: 'et-chart-dot', cx: pointX, cy: pointY, r: 3.2 }),
                    h('rect', { className: 'et-chart-tip-box', x: tipX, y: tipY, width: tipW, height: tipH, rx: 8 }),
                    h('text', { className: 'et-chart-tip-text', x: tipAnchorX, y: tipY + 17 }, monthDay(rows[hover].t) + ' · 新增 ' + rows[hover].created),
                    h('text', { className: 'et-chart-tip-sub', x: tipAnchorX, y: tipY + 32 }, '累计 ' + rows[hover].cumulative + ' · 更新 ' + rows[hover].updated),
                );
            }
            return h('svg', { className: 'et-chart', viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': '每日新增与累计节点趋势' },
                h('defs', null,
                    h('linearGradient', { id: 'etAreaFill', x1: '0', y1: '0', x2: '0', y2: '1' },
                        h('stop', { offset: '0%', stopColor: '#4d6bfe', stopOpacity: '0.32' }),
                        h('stop', { offset: '100%', stopColor: '#4d6bfe', stopOpacity: '0.02' }),
                    ),
                ),
                grid,
                bars,
                count > 0 ? h('path', { className: 'et-chart-area', d: area }) : null,
                count > 0 ? h('path', { className: 'et-chart-line', d: line }) : null,
                hoverRows,
                last !== undefined ? h('circle', { className: 'et-chart-halo', cx: xOf(count - 1), cy: yOf(last.cumulative), r: 9 }) : null,
                last !== undefined ? h('circle', { className: 'et-chart-dot', cx: xOf(count - 1), cy: yOf(last.cumulative), r: 4 }) : null,
                xLabels,
                tip,
            );
        }

        function PhaseDonut(props) {
            var counts = props.counts ?? {};
            var total = props.total ?? 0;
            var radius = 44;
            var circumference = 2 * Math.PI * radius;
            var segments = [];
            var offset = 0;
            for (var i = 0; i < PHASE_ORDER.length; i += 1) {
                var phase = PHASE_ORDER[i];
                var value = counts[phase] ?? 0;
                if (value <= 0) continue;
                var length = (value / Math.max(1, total)) * circumference;
                var gap = 2.4;
                segments.push(h('circle', {
                    key: phase,
                    cx: 59,
                    cy: 59,
                    r: radius,
                    fill: 'none',
                    stroke: PHASE_COLOR[phase] ?? '#8a8a8a',
                    strokeWidth: 12,
                    strokeDasharray: Math.max(0.01, length - gap) + ' ' + circumference,
                    strokeDashoffset: -offset,
                    strokeLinecap: 'butt',
                    transform: 'rotate(-90 59 59)',
                }, h('title', null, (PHASE_LABEL[phase] ?? phase) + ' · ' + value)));
                offset += length;
            }
            return h('div', { className: 'et-donut-wrap' },
                h('svg', { className: 'et-donut', viewBox: '0 0 118 118', role: 'img', 'aria-label': '阶段构成' },
                    h('circle', { cx: 59, cy: 59, r: radius, fill: 'none', stroke: 'rgba(128,140,168,.16)', strokeWidth: 12 }),
                    segments,
                    h('text', { className: 'et-donut-total', x: 59, y: 58, textAnchor: 'middle' }, String(total)),
                    h('text', { className: 'et-donut-cap', x: 59, y: 72, textAnchor: 'middle' }, '节点'),
                ),
                h('div', { className: 'et-phase-legend' },
                    PHASE_ORDER.filter(function (phase) { return (counts[phase] ?? 0) > 0; }).map(function (phase) {
                        var value = counts[phase] ?? 0;
                        return h('div', { className: 'et-phase-row', key: phase, title: (PHASE_LABEL[phase] ?? phase) + '：' + value + ' 个节点' },
                            h('i', { style: { background: PHASE_COLOR[phase] ?? '#8a8a8a' } }),
                            h('span', null, PHASE_LABEL[phase] ?? phase),
                            h('b', null, String(value)),
                            h('em', null, Math.round((value / Math.max(1, total)) * 100) + '%'),
                        );
                    }),
                ),
            );
        }

        function HeatmapGrid(props) {
            var cells = Array.isArray(props.cells) ? props.cells : [];
            return h('div', { className: 'et-heat', role: 'img', 'aria-label': '近 8 周活跃热力' },
                cells.map(function (cell) {
                    return h('span', {
                        key: cell.t,
                        className: 'et-heat-cell',
                        'data-level': String(cell.level),
                        'data-future': cell.future ? '1' : '0',
                        title: monthDay(cell.t) + ' · ' + (cell.future ? '未到' : cell.count + ' 次新建/更新'),
                    });
                }),
            );
        }

        var ANALYSIS_KIND_LABEL = { progress: '进展', blocker: '阻塞', risk: '风险', insight: '洞察' };

        function analysisStatusLabel(analysis) {
            if (analysis.status === 'loading') return '正在解析';
            if (analysis.status === 'ready') return '已生成';
            if (analysis.status === 'error') return '解析失败';
            if (analysis.enabled === false) return '已关闭';
            if (analysis.configured === false) return '待配置';
            return '未解析';
        }

        function analysisMetaText(analysis) {
            var meta = analysis.meta;
            if (meta === null || meta === undefined) return '';
            var parts = [];
            if (typeof meta.provider === 'string' && meta.provider !== '') {
                parts.push('由 ' + meta.provider + (typeof meta.model === 'string' && meta.model !== '' ? ' / ' + meta.model : '') + ' 生成');
            }
            if (typeof meta.nodeCount === 'number') parts.push('阅读 ' + meta.nodeCount + ' 个节点');
            if (typeof meta.tookMs === 'number' && meta.tookMs > 0) parts.push((meta.tookMs / 1000).toFixed(1) + ' 秒');
            if (meta.cached === true) parts.push('来自缓存');
            return parts.join(' · ');
        }

        function AnalysisRefs(props) {
            var ids = Array.isArray(props.ids) ? props.ids : [];
            if (ids.length === 0) return null;
            return h('div', { className: 'et-ai-refs' },
                ids.map(function (id) {
                    return h('button', {
                        key: id,
                        className: 'et-ai-ref',
                        title: '在研究中定位 ' + id,
                        onClick: function () { if (typeof props.onOpenNode === 'function') props.onOpenNode(id); },
                    }, id);
                }),
            );
        }

        function AnalysisPanel(props) {
            var analysis = props.analysis ?? {};
            var status = analysis.status ?? 'idle';
            var data = analysis.data ?? null;
            var running = status === 'loading';
            var canRun = analysis.enabled !== false;
            var action = null;
            if (data !== null) {
                action = h('button', { className: 'et-btn', disabled: running, onClick: function () { if (!running) props.onAnalyze(true); } }, running ? '解析中…' : '重新解析');
            } else if (canRun) {
                action = h('button', { className: 'et-btn', 'data-primary': '1', disabled: running, onClick: function () { if (!running) props.onAnalyze(false); } }, running ? '解析中…' : '开始解析');
            }
            var body = null;
            if (running) {
                body = h('div', { className: 'et-ai-skel' }, h('i'), h('i'), h('i'));
            } else if (analysis.error !== '' && analysis.error !== undefined && analysis.error !== null) {
                body = h('div', { className: 'et-ai-empty' },
                    h('p', null, '解析失败：' + String(analysis.error)),
                    h('button', { className: 'et-btn', onClick: function () { props.onAnalyze(false); } }, '重试'),
                );
            } else if (data !== null) {
                var findings = Array.isArray(data.findings) ? data.findings : [];
                var recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
                body = h(React.Fragment, null,
                    data.headline !== undefined && data.headline !== '' ? h('h3', { className: 'et-ai-headline' }, data.headline) : null,
                    data.summary !== undefined && data.summary !== '' ? h('p', { className: 'et-ai-summary' }, data.summary) : null,
                    findings.length > 0
                        ? h('div', { className: 'et-ai-findings' },
                            findings.map(function (item, index) {
                                return h('div', { key: 'f' + index, className: 'et-ai-finding', 'data-kind': item.kind },
                                    h('span', { className: 'et-ai-kind' }, ANALYSIS_KIND_LABEL[item.kind] ?? item.kind),
                                    h('h4', null, item.title),
                                    h('p', null, item.detail),
                                    h(AnalysisRefs, { ids: item.nodeIds, onOpenNode: props.onOpenNode }),
                                );
                            }),
                        )
                        : null,
                    recommendations.length > 0
                        ? h('div', null,
                            h('div', { className: 'et-panel-sub', style: { marginBottom: '6px' } }, '建议下一步'),
                            h('ol', { className: 'et-ai-recs' },
                                recommendations.map(function (item, index) {
                                    return h('li', { key: 'r' + index, className: 'et-ai-rec' },
                                        h('i', null, String(index + 1)),
                                        h('div', { style: { minWidth: '0' } },
                                            h('b', null, item.title),
                                            h('span', null, item.detail),
                                            h(AnalysisRefs, { ids: item.nodeIds, onOpenNode: props.onOpenNode }),
                                        ),
                                    );
                                }),
                            ),
                        )
                        : null,
                    analysisMetaText(analysis) !== ''
                        ? h('div', { className: 'et-ai-meta' }, analysisMetaText(analysis))
                        : null,
                );
            } else if (analysis.enabled === false) {
                body = h('div', { className: 'et-ai-empty' },
                    h('p', null, 'AI 解析已在插件配置中关闭（analysis.enabled = false）。'),
                );
            } else if (analysis.configured === false) {
                body = h('div', { className: 'et-ai-empty' },
                    h('p', null, '尚未配置模型路由。在插件配置里填写 analysis.provider / analysis.model，或继承 llm.provider / llm.model 后即可开始解析。'),
                );
            } else {
                body = h('div', { className: 'et-ai-empty' },
                    h('p', null, '让模型阅读当前研究图的目标、主题、待办与死路，生成可引用的进展判断与下一步建议。结果在宿主缓存 10 分钟。'),
                );
            }
            return h('div', { className: 'et-panel et-ai' },
                h('div', { className: 'et-ai-head' },
                    h('span', { className: 'et-ai-orb', 'aria-hidden': 'true' },
                        h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none' },
                            h('path', { d: 'M12 3.2 13.9 9l5.9 1.9-5.9 1.9L12 18.7l-1.9-5.9L4.2 10.9 10.1 9Z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
                            h('path', { d: 'M18.6 15.4 19.4 18l2.6.8-2.6.8-.8 2.6-.8-2.6-2.6-.8 2.6-.8Z', fill: 'currentColor', opacity: '.82' }),
                        ),
                    ),
                    h('div', { style: { minWidth: '0', flex: '1 1 220px' } },
                        h('div', { className: 'et-panel-title' }, 'AI 解析'),
                        h('div', { className: 'et-panel-sub' }, '模型阅读当前研究图，给出进展、阻塞与下一步'),
                    ),
                    h('span', { className: 'et-ai-badge', 'data-state': status }, analysisStatusLabel(analysis)),
                    h('div', { className: 'et-ai-actions' }, action),
                ),
                h('div', { className: 'et-ai-body' }, body),
            );
        }

        function Dashboard(props) {
            var nodes = Array.isArray(props.nodes) ? props.nodes : [];
            var stats = props.stats ?? {};
            var digest = props.digest ?? null;
            var open = props.open ?? null;
            var frontier = props.frontier ?? null;
            var edges = Array.isArray(props.edges) ? props.edges : [];
            var sessions = Array.isArray(props.sessions) ? props.sessions : [];
            var anchor = timeOf(props.generatedAt) ?? Date.now();
            var rangePair = React.useState(7);
            var range = rangePair[0];
            var setRange = rangePair[1];
            var trend = React.useMemo(function () { return buildTrend(nodes, range, anchor); }, [nodes, range, anchor]);
            // 热力窗口跟随数据年龄：图还年轻时不做 8 周空网格，最多铺 12 周。
            var heatWeeks = React.useMemo(function () {
                var earliest = null;
                for (var i = 0; i < nodes.length; i += 1) {
                    var created = timeOf(nodes[i].createdAt);
                    if (created !== null && (earliest === null || created < earliest)) earliest = created;
                }
                if (earliest === null) return 4;
                var span = Math.ceil((anchor - earliest) / (7 * DAY_MS)) + 1;
                return Math.max(4, Math.min(12, span));
            }, [nodes, anchor]);
            var heat = React.useMemo(function () { return buildHeatmap(nodes, heatWeeks, anchor); }, [nodes, heatWeeks, anchor]);
            var phaseCounts = React.useMemo(function () { return phaseCountsOf(nodes); }, [nodes]);
            var heroTrend = React.useMemo(function () { return buildTrend(nodes, 14, anchor); }, [nodes, anchor]);
            var weekAgo = anchor - 7 * DAY_MS;
            var weekAdded = 0;
            for (var w = 0; w < nodes.length; w += 1) {
                var created = timeOf(nodes[w].createdAt);
                if (created !== null && created >= weekAgo) weekAdded += 1;
            }
            var todayAdded = 0;
            var todayStart = startOfDay(anchor);
            for (var t = 0; t < nodes.length; t += 1) {
                var createdToday = timeOf(nodes[t].createdAt);
                if (createdToday !== null && createdToday >= todayStart) todayAdded += 1;
            }
            var total = nodes.length;
            var thoughts = 0;
            var kindCounts = stats.byKind ?? {};
            for (var k = 0; k < THOUGHT_KINDS.length; k += 1) thoughts += kindCounts[THOUGHT_KINDS[k]] ?? 0;
            var doneCount = phaseCounts.completed ?? 0;
            var donePct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
            var todo = digest?.todo ?? null;
            var openCount = todo !== null ? (todo.visible ?? 0) : (stats.openUnresolved ?? ((stats.byStatus?.open ?? 0) + (stats.byStatus?.active ?? 0)));
            var strongCount = open?.strongCount ?? todo?.strong ?? 0;
            var weakCount = open?.weakCount ?? todo?.weak ?? 0;
            var openItems = Array.isArray(open?.items) ? open.items.slice(0, 6) : [];
            var recent = React.useMemo(function () {
                return nodes.slice()
                    .filter(function (node) { return timeOf(node.updatedAt) !== null; })
                    .sort(function (a, b) { return (timeOf(b.updatedAt) ?? 0) - (timeOf(a.updatedAt) ?? 0); })
                    .slice(0, 6);
            }, [nodes]);
            var kinds = KIND_ORDER.map(function (kind) { return { kind: kind, count: kindCounts[kind] ?? 0 }; })
                .filter(function (item) { return item.count > 0; })
                .sort(function (a, b) { return b.count - a.count; })
                .slice(0, 8);
            var maxKind = 1;
            for (var kk = 0; kk < kinds.length; kk += 1) if (kinds[kk].count > maxKind) maxKind = kinds[kk].count;
            var scopeLabel = digest !== null && digest.scope === 'session' ? '本会话' : '全图';
            var settled = digest?.settled ?? null;
            var kpiCards = [
                { tone: 'node', label: '节点总数', value: total, sub: '近 7 天 +' + weekAdded + ' · 今日 +' + todayAdded, spark: props.showSpark === false ? null : heroTrend },
                { tone: 'thought', label: '想法', value: thoughts, sub: '占 ' + (total > 0 ? Math.round((thoughts / total) * 100) : 0) + '% · 推理链' },
                { tone: 'todo', label: '待办', value: openCount, sub: '强 ' + strongCount + ' · 弱 ' + weakCount },
                { tone: 'edge', label: '会话', value: (sessions.length || stats.sessions || 0), sub: edges.length + ' 条关系 · ' + (kindCounts.goal ?? 0) + ' 个目标' },
            ];
            return h('div', { className: 'et-dash' },
                h('div', { className: 'et-stats-row' },
                    kpiCards.map(function (card) {
                        return h('div', { className: 'et-stat', key: card.label, style: { '--et-tone': card.tone === 'node' ? '#4d6bfe' : (card.tone === 'thought' ? '#8a63d2' : (card.tone === 'todo' ? '#d08a00' : '#2f8f83')) } },
                            h('div', { className: 'et-stat-label' }, card.label),
                            h('div', { className: 'et-stat-value' }, String(card.value)),
                            h('div', { className: 'et-stat-sub' }, card.sub),
                            card.spark !== null && card.spark !== undefined
                                ? h('div', { className: 'et-stat-spark', title: '近 14 天新增' }, h(Sparkline, { rows: card.spark.rows, width: 78, height: 24 }))
                                : null,
                            card.tone === 'node' && todayAdded > 0
                                ? h('span', { className: 'et-kpi-delta' }, '＋' + todayAdded)
                                : null,
                        );
                    }),
                ),
                props.showAnalysis !== false
                    ? h(AnalysisPanel, { analysis: props.analysis, onAnalyze: props.onAnalyze, onOpenNode: props.onOpenNode })
                    : null,
                h('div', { className: 'et-dash-row', 'data-cols': '2' },
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '研究脉搏'),
                                h('div', { className: 'et-panel-sub' }, '每日新增与累计节点 · 近 ' + range + ' 天'),
                            ),
                            h('div', { className: 'et-range' },
                                [7, 30, 90].map(function (value) {
                                    return h('button', {
                                        key: value,
                                        'data-active': range === value ? '1' : '0',
                                        onClick: function () { setRange(value); },
                                    }, value + ' 天');
                                }),
                            ),
                        ),
                        h(TrendChart, { rows: trend.rows, maxCum: trend.maxCum, maxCreated: trend.maxCreated }),
                        h('div', { className: 'et-chart-foot' },
                            h('span', { className: 'et-chart-key' }, h('i', { style: { background: 'rgba(77,107,254,.28)' } }), '每日新增'),
                            h('span', { className: 'et-chart-key' }, h('i', { style: { background: '#4d6bfe' } }), '累计节点'),
                            h('span', null, '区间新增 ' + (trend.total - trend.base) + ' · 日均 ' + ((trend.total - trend.base) / range).toFixed(1)),
                        ),
                    ),
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '阶段构成'),
                                h('div', { className: 'et-panel-sub' }, '按展示阶段归类 · ' + total + ' 个节点'),
                            ),
                        ),
                        h(PhaseDonut, { counts: phaseCounts, total: total }),
                        h('div', { className: 'et-progress', title: '已完成 ' + doneCount + ' / ' + total + ' 个节点' },
                            h('div', { className: 'et-progress-bar' }, h('i', { style: { width: Math.max(1, donePct) + '%' } })),
                            h('div', { className: 'et-progress-labels' },
                                h('span', null, '完成率 ', h('b', null, donePct + '%')),
                                h('span', null, '已完成 ', h('b', null, String(doneCount)), ' / ' + total),
                            ),
                        ),
                        h('div', { className: 'et-chart-foot' },
                            h('span', null, '完成率 ' + donePct + '%'),
                            h('span', null, '进行中 ' + (phaseCounts.doing ?? 0)),
                            h('span', null, '死路 ' + (phaseCounts.dead_end ?? 0)),
                        ),
                    ),
                ),
                h('div', { className: 'et-dash-row', 'data-cols': '2+1' },
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '活跃热力'),
                                h('div', { className: 'et-panel-sub' }, '近 ' + heatWeeks + ' 周 · 新建与更新'),
                            ),
                        ),
                        h('div', { className: 'et-heat-body' },
                            h('div', { className: 'et-heat-grid' },
                                h('div', { className: 'et-heat-days', 'aria-hidden': 'true' },
                                    ['一', '', '三', '', '五', '', '日'].map(function (day, index) { return h('span', { key: 'd' + index }, day); }),
                                ),
                                h(HeatmapGrid, { cells: heat.cells }),
                            ),
                            h('div', { className: 'et-heat-stats' },
                                h('div', { className: 'et-heat-stat' }, h('b', null, String(heat.total)), h('span', null, '次记录')),
                                h('div', { className: 'et-heat-stat' }, h('b', null, String(heat.max)), h('span', null, '峰值/日')),
                                h('div', { className: 'et-heat-stat' }, h('b', null, String(heat.active)), h('span', null, '活跃日')),
                                h('div', { className: 'et-heat-stat' }, h('b', null, String(heat.streak)), h('span', null, '连续天')),
                            ),
                        ),
                        h('div', { className: 'et-heat-foot' },
                            h('span', null, '近 ' + heatWeeks + ' 周 · 新建/更新节点数' + (heat.peakT !== null ? ' · 峰值 ' + monthDay(heat.peakT) : '')),
                            h('span', { className: 'et-heat-scale', title: '颜色越深，当天新建/更新越多' }, '少', h('i', { 'data-n': '2' }), h('i', { 'data-n': '3' }), h('i', { 'data-n': '4' }), '多'),
                        ),
                    ),
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '节点类型'),
                                h('div', { className: 'et-panel-sub' }, '点击只看该类型'),
                            ),
                        ),
                        h('div', { className: 'et-kindstack', title: '类型占比' },
                            kinds.map(function (item) {
                                return h('i', { key: 'stack-' + item.kind, style: { width: ((item.count / Math.max(1, total)) * 100).toFixed(2) + '%', background: KIND_COLOR[item.kind] ?? '#8a8a8a' } });
                            }),
                        ),
                        h('div', { className: 'et-kindbars' },
                            kinds.length === 0
                                ? h('div', { className: 'et-dash-empty' }, '还没有节点')
                                : kinds.map(function (item) {
                                    return h('button', {
                                        key: item.kind,
                                        className: 'et-kindbar',
                                        title: '只看「' + (KIND_LABEL[item.kind] ?? item.kind) + '」',
                                        onClick: function () { if (typeof props.onFilterKind === 'function') props.onFilterKind(item.kind); },
                                    },
                                        h('span', { style: { color: KIND_COLOR[item.kind] ?? 'inherit' } }, KIND_LABEL[item.kind] ?? item.kind),
                                        h('span', { className: 'et-kindtrack' },
                                            h('span', { className: 'et-kindfill', style: { width: Math.max(3, Math.round((item.count / maxKind) * 100)) + '%', color: KIND_COLOR[item.kind] ?? '#4d6bfe' } }),
                                        ),
                                        h('b', null, String(item.count)),
                                        h('em', null, Math.round((item.count / Math.max(1, total)) * 100) + '%'),
                                    );
                                }),
                        ),
                    ),
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '最近动态'),
                                h('div', { className: 'et-panel-sub' }, '按更新时间排序 · 点击定位'),
                            ),
                        ),
                        h('div', { className: 'et-feed' },
                            recent.length === 0
                                ? h('div', { className: 'et-dash-empty' }, '还没有更新记录')
                                : recent.map(function (node) {
                                    return h('button', {
                                        key: node.id,
                                        className: 'et-feed-item',
                                        onClick: function () { if (typeof props.onOpenNode === 'function') props.onOpenNode(node.id); },
                                        title: node.title,
                                    },
                                        h('i', { className: 'et-feed-dot', style: { background: KIND_COLOR[node.kind] ?? '#8a8a8a' } }),
                                        h('span', { className: 'et-feed-main' },
                                            h('span', { className: 'et-feed-title' }, node.title),
                                            h('span', { className: 'et-feed-meta' },
                                                h(KindBadge, { kind: node.kind }),
                                                h('span', null, nodePhaseLabel(node)),
                                                h('span', null, '· ' + node.id),
                                            ),
                                        ),
                                        h('span', { className: 'et-feed-time' }, relativeTime(timeOf(node.updatedAt), anchor)),
                                    );
                                }),
                        ),
                    ),
                ),
                h('div', { className: 'et-dash-row', 'data-cols': '2+1b' },
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '待办焦点'),
                                h('div', { className: 'et-panel-sub' }, '强 ' + strongCount + ' · 折叠 ' + (open?.hiddenCount ?? todo?.hidden ?? 0) + ' · ' + scopeLabel),
                            ),
                            h('button', { className: 'et-btn', onClick: function () { if (typeof props.onShowAll === 'function') props.onShowAll(); } }, '全部'),
                        ),
                        h('div', { className: 'et-open' },
                            openItems.length === 0
                                ? h('div', { className: 'et-dash-empty' }, '没有待办，研究图处于收敛状态')
                                : openItems.map(function (node) {
                                    return h('button', {
                                        key: node.id,
                                        className: 'et-open-item',
                                        onClick: function () { if (typeof props.onOpenNode === 'function') props.onOpenNode(node.id); },
                                        title: node.title,
                                    },
                                        h('span', { className: 'et-open-kind', style: { color: KIND_COLOR[node.kind] ?? 'inherit' } }, KIND_LABEL[node.kind] ?? node.kind),
                                        h('span', { className: 'et-open-title' }, node.title),
                                    );
                                }),
                        ),
                        h('div', { className: 'et-chart-foot' },
                            h('span', null, '显示前 ' + openItems.length + ' 条 · 共 ' + (open?.total ?? openCount) + ' 条待办 · ' + scopeLabel),
                        ),
                    ),
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '下一步建议'),
                                h('div', { className: 'et-panel-sub' }, '来自当前焦点分支'),
                            ),
                        ),
                        frontier !== null
                            ? h(FrontierPanel, { frontier: frontier, limit: 4, avoidLimit: 2, onFocus: function (id) { if (typeof props.onOpenNode === 'function') props.onOpenNode(id); } })
                            : h('div', { className: 'et-dash-empty' }, '暂无建议'),
                    ),
                    h('div', { className: 'et-panel' },
                        h('div', { className: 'et-panel-head' },
                            h('div', null,
                                h('div', { className: 'et-panel-title' }, '记录口径'),
                                h('div', { className: 'et-panel-sub' }, '数字与折叠项说明'),
                            ),
                        ),
                        h('div', { className: 'et-overview-grid' },
                            h('div', { className: 'et-overview-cell' }, h('b', null, String(total)), h('span', null, '节点')),
                            h('div', { className: 'et-overview-cell' }, h('b', null, String(digest?.todo?.total ?? openCount)), h('span', null, '待办总数')),
                            h('div', { className: 'et-overview-cell' }, h('b', null, String(digest?.settled?.total ?? 0)), h('span', null, '已收敛')),
                            h('div', { className: 'et-overview-cell' }, h('b', null, String(digest?.todo?.hidden ?? 0)), h('span', null, '折叠待办')),
                        ),
                        h('p', { className: 'et-main-text' },
                            '待办只算 question / hypothesis / decision；结构节点与产物不计入。'
                            + '已收敛包含 ' + (settled !== null ? '人工整理 ' + (settled.curated ?? 0) + '、合并 ' + (settled.merged ?? 0) + '、工具噪音 ' + (settled.toolNoise ?? 0) : '暂无统计')
                            + '。' + (digest !== null && digest.reconciled === true ? '阶段合计与总数一致。' : ''),
                        ),
                    ),
                ),
            );
        }

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
            page: 'tree',
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
            var stateRef = React.useRef(state);
            var newTimerRef = React.useRef(null);
            var newPair = React.useState([]);
            var newIds = newPair[0];
            var setNewIds = newPair[1];
            var syncPair = React.useState(0);
            var lastSync = syncPair[0];
            var setLastSync = syncPair[1];
            var analysisPair = React.useState({ status: 'idle', enabled: null, configured: null, data: null, meta: null, error: '' });
            var analysis = analysisPair[0];
            var setAnalysis = analysisPair[1];
            stateRef.current = state;

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
                        var params = [];
                        if (wanted !== '') params.push('workspace=' + encodeURIComponent(wanted));
                        if (typeof props.sessionId === 'string' && props.sessionId !== '') {
                            params.push('session=' + encodeURIComponent(props.sessionId));
                        }
                        var query = params.length > 0 ? '?' + params.join('&') : '';
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
                        var previousSnapshot = stateRef.current.snapshot;
                        var addedIds = [];
                        if (previousSnapshot !== null && previousSnapshot !== undefined
                            && sameRoot(workspacePath(previousSnapshot.workspace), chosen)) {
                            var before = new Set();
                            var previousNodes = Array.isArray(previousSnapshot.nodes) ? previousSnapshot.nodes : [];
                            for (var b = 0; b < previousNodes.length; b += 1) before.add(previousNodes[b].id);
                            var nextNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
                            for (var a = 0; a < nextNodes.length; a += 1) {
                                if (!before.has(nextNodes[a].id)) addedIds.push(nextNodes[a].id);
                            }
                            if (addedIds.length > 60) addedIds = addedIds.slice(addedIds.length - 60);
                        }
                        if (addedIds.length > 0) {
                            if (newTimerRef.current !== null) clearTimeout(newTimerRef.current);
                            setNewIds(addedIds);
                            newTimerRef.current = setTimeout(function () {
                                if (aliveRef.current) setNewIds([]);
                            }, 12000);
                        }
                        setLastSync(Date.now());
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
                                page: previous.page ?? 'tree',
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
                return function () {
                    aliveRef.current = false;
                    if (newTimerRef.current !== null) clearTimeout(newTimerRef.current);
                };
            }, [refresh, props.sessionId, sessionCwd]);

            React.useEffect(function () {
                if (!prefs.autoRefresh) return undefined;
                timerRef.current = setInterval(function () { refresh(); }, REFRESH_MS);
                return function () { if (timerRef.current !== null) clearInterval(timerRef.current); };
            }, [refresh, prefs.autoRefresh]);

            // 进入概览或切换工作区时只探测「是否已有缓存/是否已配置」，不触发模型调用。
            React.useEffect(function () {
                if (state.workspace === '' || state.page !== 'overview') return undefined;
                var alive = true;
                fetchJson('/explore-tree/analyze?workspace=' + encodeURIComponent(state.workspace))
                    .then(function (payload) {
                        if (!alive || !aliveRef.current) return;
                        setAnalysis(function (previous) {
                            if (previous.status === 'loading') return previous;
                            var data = payload?.analysis ?? previous.data;
                            return {
                                status: data !== null && data !== undefined ? 'ready' : 'idle',
                                enabled: payload?.enabled !== false,
                                configured: payload?.configured === true,
                                data: data ?? null,
                                meta: payload?.meta ?? previous.meta,
                                error: '',
                            };
                        });
                    })
                    .catch(function () {
                        // 状态探测失败不打扰面板；用户仍可主动点「开始解析」。
                    });
                return function () { alive = false; };
            }, [state.workspace, state.page]);

            function runAnalysis(force) {
                var workspace = state.workspace;
                if (workspace === '') return;
                setAnalysis(function (previous) { return { ...previous, status: 'loading', error: '' }; });
                var url = '/explore-tree/analyze?workspace=' + encodeURIComponent(workspace) + (force ? '&force=1' : '');
                postJson(url).then(function (payload) {
                    if (!aliveRef.current) return;
                    setAnalysis({ status: 'ready', enabled: true, configured: true, data: payload?.analysis ?? null, meta: payload?.meta ?? null, error: '' });
                }).catch(function (error) {
                    if (!aliveRef.current) return;
                    var code = typeof error?.code === 'string' ? error.code : '';
                    var message = String(error && error.message ? error.message : error);
                    if (code === 'llm_not_configured') message = '尚未配置模型路由（analysis.provider / llm.provider）';
                    else if (code === 'llm_unavailable') message = '宿主未提供 llm 能力';
                    else if (code === 'analysis_disabled') message = 'AI 解析已在插件配置中关闭';
                    setAnalysis(function (previous) {
                        return {
                            ...previous,
                            status: 'error',
                            error: message,
                            enabled: code === 'analysis_disabled' ? false : previous.enabled,
                        };
                    });
                });
            }

            var snapshot = state.snapshot;
            var nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            var edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
            var stats = snapshot?.stats ?? {};
            var page = state.page === 'overview' ? 'overview' : 'tree';

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
                // 主干视图只保留「已经建了主题」的目标，避免旧图里未建主干的目标占满画布。
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
                    var entry = map.get(parent.id) ?? { total: 0, done: 0, open: 0, dead: 0 };
                    entry.total += 1;
                    if (node.phase === 'recorded' || node.status === 'done') entry.done += 1;
                    else if (node.phase === 'todo') entry.open += 1;
                    else if (node.phase === 'dead_end') entry.dead += 1;
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
                    // 聚焦目标始终保亮：从搜索/简报跳到已关闭节点时，不需要关掉全局「只看待办」。
                    if (scopeNodes[i].id === state.selectedId) continue;
                    if (!isTodoNode(scopeNodes[i])) set.add(scopeNodes[i].id);
                }
                return set;
            }, [scopeNodes, prefs.onlyOpen, state.selectedId]);
            var freshIds = React.useMemo(function () {
                var set = new Set();
                for (var i = 0; i < newIds.length; i += 1) set.add(newIds[i]);
                return set;
            }, [newIds]);

            function focusNode(id, options) {
                var holdView = options !== undefined && options !== null && options.keepView === true;
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
                    return { ...previous, selectedId: id, collapsed: collapsed, kindFilter: null, view: holdView ? previous.view : (keepTrunk ? previous.view : 'study') };
                });
            }

            function openNode(id) {
                focusNode(id, { keepView: true });
                setState(function (previous) {
                    return previous.page === 'tree' ? previous : { ...previous, page: 'tree' };
                });
            }

            function showPage(next) {
                setState(function (previous) {
                    return previous.page === next ? previous : { ...previous, page: next };
                });
            }

            function filterKindAndOpen(kind) {
                setState(function (previous) {
                    return { ...previous, kindFilter: previous.kindFilter === kind ? null : kind, page: 'tree' };
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
            var digest = snapshot?.digest ?? null;
            var openMain = digest !== null ? (digest.todo?.visible ?? 0)
                : (stats.openUnresolved ?? ((stats.byStatus?.open ?? 0) + (stats.byStatus?.active ?? 0)));
            var openScope = digest !== null && digest.scope === 'session' ? '本会话' : '全图';
            var heroTrend = React.useMemo(function () { return buildTrend(nodes, 14, timeOf(snapshot?.generatedAt) ?? Date.now()); }, [nodes, snapshot]);
            var thoughtTotal = THOUGHT_KINDS.reduce(function (sum, kind) { return sum + (kindCounts[kind] ?? 0); }, 0);
            var sinceText = '尚未同步';
            if (lastSync > 0) {
                var seconds = Math.max(0, Math.round((Date.now() - lastSync) / 1000));
                sinceText = seconds < 5 ? '刚刚' : (seconds < 90 ? seconds + ' 秒前' : Math.round(seconds / 60) + ' 分钟前');
            }
            var todayAdded = 0;
            var todayStart = startOfDay(Date.now());
            for (var hh = 0; hh < nodes.length; hh += 1) {
                var createdHh = timeOf(nodes[hh].createdAt);
                if (createdHh !== null && createdHh >= todayStart) todayAdded += 1;
            }

            return h('div', { className: 'et-root' },
                h('style', null, CSS),
                h('div', { className: 'et-hero' },
                    h('div', { className: 'et-brand' },
                        h('span', { className: 'et-logo', 'aria-hidden': 'true' },
                            h('svg', { width: 21, height: 21, viewBox: '0 0 24 24', fill: 'none' },
                                h('circle', { cx: 12, cy: 5.4, r: 2.6, fill: 'currentColor', opacity: '.95' }),
                                h('circle', { cx: 5.6, cy: 17.4, r: 2.6, fill: 'currentColor', opacity: '.8' }),
                                h('circle', { cx: 18.4, cy: 17.4, r: 2.6, fill: 'currentColor', opacity: '.8' }),
                                h('path', { d: 'M10.6 7.6 7 14.8M13.4 7.6 17 14.8M8.2 17.4h7.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: '.9' }),
                            ),
                        ),
                        h('div', null,
                            h('div', { className: 'et-title' }, '研究轨迹', h('em', null, 'Explore Tree')),
                            h('div', { className: 'et-subline' },
                                h('span', { className: 'et-live', 'data-live': prefs.autoRefresh ? '1' : '0', title: prefs.autoRefresh ? '每 3 秒同步一次快照' : '自动同步已关闭，点「刷新」手动更新' },
                                    h('i'),
                                    prefs.autoRefresh ? ('实时 · ' + sinceText) : '手动',
                                ),
                                h('span', { className: 'et-ws', title: state.workspace }, currentWorkspaceName(state)),
                            ),
                        ),
                    ),
                    page === 'tree' ? h('div', { className: 'et-kpis' },
                        h('div', { className: 'et-kpi', 'data-tone': 'node', title: '节点总数' },
                            h('b', null, String(nodes.length)),
                            h('span', null, '节点'),
                            newIds.length > 0 ? h('i', { className: 'et-kpi-delta' }, '＋' + newIds.length) : null,
                        ),
                        h('div', { className: 'et-kpi', 'data-tone': 'thought', title: '问题 / 假设 / 证据 / 决策 / 死路 / 结论' },
                            h('b', null, String(thoughtTotal)),
                            h('span', null, '想法'),
                        ),
                        h('div', { className: 'et-kpi', 'data-tone': 'todo', title: '待办只算 question/hypothesis/decision（' + openScope + '）' },
                            h('b', null, String(openMain)),
                            h('span', null, '待办'),
                        ),
                        h('div', { className: 'et-kpi', 'data-tone': 'edge', title: '关系边' },
                            h('b', null, String(stats.edges ?? edges.length)),
                            h('span', null, '关系'),
                        ),
                    ) : null,
                    h('div', { className: 'et-hero-tools' },
                        h('div', { className: 'et-tabs' },
                            h('button', { 'data-active': page === 'overview' ? '1' : '0', onClick: function () { showPage('overview'); } }, '概览'),
                            h('button', { 'data-active': page === 'tree' ? '1' : '0', onClick: function () { showPage('tree'); } }, '研究树'),
                        ),
                        h('span', { className: 'et-spark-wrap', title: '近 14 天新增节点' },
                            h(Sparkline, { rows: heroTrend.rows, width: 88, height: 24 }),
                            '14 天',
                        ),
                        h('button', { className: 'et-btn', onClick: function () { refresh(); }, title: '立即刷新快照' }, '刷新'),
                        h('button', {
                            className: 'et-btn',
                            'data-primary': '1',
                            disabled: sidebarPreviewOpen === null,
                            onClick: function () { if (sidebarPreviewOpen !== null) sidebarPreviewOpen(); },
                            title: sidebarPreviewOpen === null
                                ? '右侧栏插件不可用'
                                : '右侧栏预览：目标、待办与下一步',
                        }, '右侧栏'),
                    ),
                ),
                page === 'tree'
                    ? h('div', { className: 'et-toolbar' },
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
                            h('span', { className: 'et-spacer' }),
                            h('span', { className: 'et-seg', title: '主干=目标/主题/叶根（交流与交接）；研究=全部节点（含叶内细节）' },
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
                            h('span', { className: 'et-zoom' },
                                h('button', { onClick: function () { applyZoom(state.zoom - ZOOM_STEP, viewportCenter(), true); }, title: '缩小（Ctrl/⌘ + 滚轮也可缩放）' }, '−'),
                                h('button', { className: 'et-zoom-value', onClick: function () { applyZoom(1, viewportCenter(), true); }, title: '恢复 100%' }, Math.round(state.zoom * 100) + '%'),
                                h('button', { onClick: function () { applyZoom(state.zoom + ZOOM_STEP, viewportCenter(), true); }, title: '放大' }, '+'),
                            ),
                        ),
                        h('div', { className: 'et-bar-row' },
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
                            h('span', { className: 'et-spacer' }),
                            h('span', { className: 'et-hint' }, '显示选项在 设置 → 研究轨迹'),
                        ),
                        legendKinds.length > 0
                            ? h('div', { className: 'et-legend' },
                                h('span', { className: 'et-faint', style: { fontSize: '10px' } }, '图例'),
                                legendKinds.map(function (kind) {
                                    return h('button', {
                                        key: kind,
                                        className: 'et-chip',
                                        'data-active': state.kindFilter === kind ? '1' : '0',
                                        style: { color: KIND_COLOR[kind] ?? 'inherit' },
                                        onClick: function () { toggleKind(kind); },
                                        title: '只看「' + (KIND_LABEL[kind] ?? kind) + '」',
                                    }, KIND_LABEL[kind] ?? kind, h('b', { style: { color: 'inherit' } }, String(kindCounts[kind] ?? 0)));
                                }),
                                state.kindFilter !== null
                                    ? h('button', { className: 'et-btn', onClick: function () { setState(function (previous) { return { ...previous, kindFilter: null }; }); } }, '取消类型过滤')
                                    : null,
                            )
                            : null,
                    )
                    : null,
                state.error !== ''
                    ? h('div', { className: 'et-empty et-err' },
                        '读取研究图失败：' + state.error,
                        h('p', { className: 'et-faint' }, '确认插件已加载，且宿主路由 /explore-tree 可访问。'),
                        h('button', { className: 'et-btn', style: { marginTop: '10px' }, onClick: function () { refresh(); } }, '重试'),
                    )
                    : (snapshot === null
                        ? h('div', { className: 'et-empty' },
                            h('div', { className: 'et-empty-orb' }),
                            h('p', null, '正在读取研究图…'),
                            h('p', { className: 'et-faint', style: { fontSize: '11.5px' } }, '目标 · 待办 · 动态跟踪'),
                        )
                        : (nodes.length === 0
                            ? h(EmptyState, { workspace: state.workspace, onRefresh: function () { refresh(); } })
                            : (page === 'overview'
                                ? h(Dashboard, {
                                    nodes: nodes,
                                    edges: edges,
                                    stats: stats,
                                    digest: snapshot?.digest,
                                    open: snapshot?.open,
                                    frontier: snapshot?.frontier,
                                    sessions: snapshot?.sessions,
                                    generatedAt: snapshot?.generatedAt,
                                    onOpenNode: openNode,
                                    onFilterKind: filterKindAndOpen,
                                    analysis: analysis,
                                    onAnalyze: runAnalysis,
                                    showAnalysis: prefs.showAnalysis,
                                    onShowAll: function () {
                                        setState(function (previous) { return { ...previous, page: 'tree', kindFilter: null }; });
                                    },
                                })
                                : (visibleNodes.length === 0
                                    ? h('div', { className: 'et-empty et-faint' }, '当前筛选下没有可见节点：取消类型过滤、降低隐藏条件或展开折叠节点再看。')
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
                                        freshIds: freshIds,
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
                                                    digest: snapshot?.digest,
                                                    workspaceDigest: snapshot?.workspaceDigest,
                                                    roots: roots,
                                                    maxDepth: maxDepth,
                                                    workspaceName: currentWorkspaceName(state),
                                                    onFocus: focusNode,
                                                    onFilterKind: toggleKind,
                                                }),
                                            h('div', { style: { marginTop: '0' } },
                                                h(FrontierPanel, { frontier: snapshot?.frontier, onFocus: focusNode }),
                                            ),
                                        )
                                        : null,
                                ))))),
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
                if (typeof navCtx.effect === 'function') {
                    navCtx.effect(function () {
                        return function () { sidebarPreviewOpen = null; };
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
                        description: function () { return '当前会话的研究树目标、待办与下一步'; },
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

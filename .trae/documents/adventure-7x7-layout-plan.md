# adventure.html 文字冒险界面改造方案

**版本**：v1.0  
**日期**：2026-07-28

---

## 1. 改造目标

对 [adventure.html](file:///home/zyh/DND/adventure.html) 进行两项核心改造：

| # | 改造项 | 现状 | 目标 |
|---|--------|------|------|
| 1 | 导航范围 | 只显示当前地的 4 个邻居（1 格） | 以当前地为中心，上下左右各渲染最多 3 格（7×7 Grid） |
| 2 | 页面布局 | 单列居中，上下堆叠 | 三栏布局：左侧面板 + 中央框架 + 右侧角色卡 |

---

## 2. 三栏布局

```
┌────────────────────────────────────────────────────────────┐
│  [返回大厅]                    DNDBOX                       │  ← top-bar
├────────────────────────────────────────────────────────────┤
│                   场景描述文字（旁白）                        │  ← scene-banner
├──────────────┬──────────────────────────────┬──────────────┤
│              │                              │              │
│  左侧面板     │       中央框架区               │  右侧面板     │
│  (队伍+任务)  │      (nav grid 7×7)           │  (角色卡)    │
│  [先空置]     │                              │              │
│              │   ● 当前地居中高亮             │              │
│              │   ● 上下左右最多 3 格          │              │
│              │   ● 伪元素直线连接             │              │
│              │                              │              │
├──────────────┴──────────────────────────────┴──────────────┤
│                      NPC 列表                               │
└────────────────────────────────────────────────────────────┘
```

### 2.1 左侧面板（先空置，预留接口）

- 宽度：`220px`
- 预留分区：上部 `战队成员`（头像+状态条），下部 `当前任务`
- 占位内容：半透明虚线框 + 斜体文字 "暂无队伍" / "暂无任务"
- 后续填充时只需写入两行 HTML

### 2.2 中央框架区

- 宽度自适应（`flex: 1`）
- 内嵌一个**高长宽短**的框（`max-width: 600px`，`padding: 40px 20px`，边框 `1px solid var(--border)`，圆角 `16px`）
- 框内上边缘距场景描述栏约 `100px`（通过顶部 `margin` / `padding` 控制）
- 框内放置 7×7 导航 Grid

### 2.3 右侧面板（角色卡）

- 宽度：`240px`
- 显示当前冒险者的基本信息：头像（首字圆形）、名称、等级、HP/AC 等
- 数据来源：读取 `localStorage` 的 `currentCharacter`（如果有），否则显示占位
- 后续可扩展为完整角色卡弹窗入口

---

## 3. 7×7 导航 Grid

### 3.1 链式漫游规则

从当前地出发，每个方向独立走邻居链：

```js
function walkChain(id, dir, maxDepth) {
  const chain = [];
  let cur = id;
  for (let i = 0; i < maxDepth; i++) {
    const loc = findLocation(cur);
    if (!loc || !loc.neighbors || !loc.neighbors[dir]) break; // 截断
    const nextId = loc.neighbors[dir];
    chain.push(nextId);
    cur = nextId;
  }
  return chain; // [距离1, 距离2, 距离3]
}
```

- **岔路截断**：只严格沿指定方向走，不跳转到其他方向
- **null 截断**：该方向邻居为 null → 停止

### 3.2 Grid 结构

7×7 CSS Grid，行/列均为 `auto`：

```
  列1    列2    列3    列4    列5    列6    列7
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│      │      │ (3上) │      │      │      │      │  ← 行1: 上3
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │ (2上) │      │      │      │      │  ← 行2: 上2
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │ (1上) │      │      │      │      │  ← 行3: 上1
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│(3左) │(2左) │(1左) │  ●   │(1右) │(2右) │(3右) │  ← 行4: 当前行
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │ (1下) │      │      │      │      │  ← 行5: 下1
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │ (2下) │      │      │      │      │  ← 行6: 下2
├──────┼──────┼──────┼──────┼──────┼──────┼──────┤
│      │      │ (3下) │      │      │      │      │  ← 行7: 下3
└──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```

- 行4 列4（中心）= 当前地（高亮按钮）
- 行1/2/3 列4 = 上方 3/2/1 格
- 行5/6/7 列4 = 下方 1/2/3 格
- 行4 列1/2/3 = 左侧 3/2/1 格
- 行4 列4/5/6 = 右侧 1/2/3 格
- 其余格子为空（不渲染）

### 3.3 连线规则

- 只在相邻的非空格子之间画线
- 竖线：上下相邻的格子，用 `::after` 在按钮底部/顶部画竖线
- 横线：左右相邻的格子，用 `::after` 在按钮右侧/左侧画横线
- 当前地（中心）向四个方向各发射一条线到相邻邻居

### 3.4 按钮样式

- 当前地：`accent` 背景，白色文字，稍大
- 邻居按钮：`paper-card` 背景，Hover 变色
- 空位置：不渲染 DOM 元素（或 `visibility: hidden`）
- 按钮宽度：约 `90-100px`（比现在窄，适配 7 列）
- 行高：约 `70px`

---

## 4. 文件改动清单

### 4.1 [adventure.html](file:///home/zyh/DND/adventure.html)

**CSS 改动**：

| 改动项 | 说明 |
|--------|------|
| `body` → `flex-direction: column` 不变 | — |
| 新增 `.adventure-body` | 三栏 flex 容器（left + center + right），`flex: 1` |
| 删除 `.adventure-main` 的 `justify-content: center` | 改为顶部对齐 |
| 新增 `.left-panel` | 宽 220px，flex-shrink: 0，虚线占位框 |
| 新增 `.center-area` | flex: 1，居中容器 |
| 新增 `.nav-frame` | 边框框体，max-width: 600px，padding: 40px 28px，margin-top: ~100px |
| 新增 `.right-panel` | 宽 240px，flex-shrink: 0，角色卡面板 |
| 改造 `.nav-grid` | 7×7 Grid，grid-template-columns/rows 各 7 份 |
| 改造 `.nav-btn` | 缩小尺寸，调整字体 |
| 改造连线规则 | 相邻格子之间的线，通过 UI 渲染时动态判断 |

**JS 改动**：

| 函数 | 改动 |
|------|------|
| `walkChain(id, dir, maxDepth)` | **新增**，沿方向链式漫游 |
| `renderNav()` | **重写**，渲染 7×7 Grid，每个格子按链结果决定显示/隐藏 |
| `renderRightPanel()` | **新增**，读取 localStorage 渲染角色卡 |
| `loadData()` 末尾 | 追加 `renderRightPanel()` 调用 |

**DOM 改动**：

```html
<!-- 场景描述栏保持不变 -->
<div class="adventure-body">
  <aside class="left-panel">
    <!-- 队伍 + 任务占位 -->
  </aside>
  <main class="center-area">
    <div class="nav-frame">
      <div class="nav-grid" id="nav-grid">
        <!-- 49 个格子的模板 -->
      </div>
    </div>
  </main>
  <aside class="right-panel">
    <!-- 角色卡 -->
  </aside>
</div>
<!-- NPC 列表保持不变 -->
```

### 4.2 数据文件

**不改动** [world-forgotten-realms.json](file:///home/zyh/DND/data/adventure/world-forgotten-realms.json) 和 [npcs-forgotten-realms.json](file:///home/zyh/DND/data/adventure/npcs-forgotten-realms.json)。

---

## 5. 预计算方案（性能优化）

由于地点图是静态的（旅途中不动态添加/删除地点），可以**在加载数据时预计算**每个节点的四方向链，避免每次 `renderNav()` 都重新漫游：

```js
const chainCache = {}; // { "locationId:up": ["id1","id2","id3"], ... }

function buildChains() {
  for (const id of Object.keys(allLocations)) {
    for (const dir of ['up','down','left','right']) {
      chainCache[`${id}:${dir}`] = walkChain(id, dir, 3);
    }
  }
}
```

`renderNav()` 直接查缓存取链结果，O(1) 渲染。

---

## 6. 实现步骤

1. 在 `adventure.html` 中：
   - 替换 `.adventure-main` 为三栏布局
   - 新增左/右面板 CSS + DOM 占位
   - 新增 `.nav-frame` 框体样式
   - 将 `.nav-grid` 改为 7×7，生成 49 个格子
   - 重写 `renderNav()` 用预计算链渲染
   - 新增 `renderRightPanel()` 角色卡
   - 调整连线伪元素逻辑
2. 验证：在 `phandalin-main-street` 位置检查四周 3 格是否正确渲染，截断是否生效
3. 浏览器测试布局和交互

---

**状态**：待确认后开发

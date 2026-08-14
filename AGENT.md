# AGENT.md

本文件为 AI 助手与开发者在 DNDBOX 项目中工作的全局约定。执行任务前先阅读本文件与涉及模块的现有代码。

## 图标资源规范（assets/icons）

项目中所有图标为本地 SVG 文件，前端通过 `loadSvgIcon(iconName)` 动态加载（`/assets/icons/equipment/{icon}.svg`，加载失败时自动使用兜底图标）。**新增图标时必须遵循以下规范**：

1. **存放位置**
   - 装备/物品/道具类图标：`assets/icons/equipment/`
   - 界面 UI 图标：`assets/icons/ui/`

2. **文件命名**
   - 全小写 snake_case，如 `potion.svg`、`greatsword.svg`。
   - 文件名即图标名，在数据 JSON 中用 `icon` 字段引用（不含 `.svg` 后缀）。

3. **SVG 样式要求**
   - `viewBox="0 0 24 24"`。
   - 单色线条风格：`fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`。
   - 不写死颜色、不使用渐变/滤镜——颜色由外层 CSS `color`（多为 `var(--accent)`）控制。
   - 保持与现有图标一致的线性轮廓风格。

4. **数据关联**
   - 物品类（`data/adventures/*/chapters/*/items.json` 或 `equipment/*.json`）增加 `"icon": "图标名"` 字段。
   - 未配置 `icon` 字段的物品，前端默认回退到 `pouch` 图标（背包），可接受但尽量显式配置。

5. **图标分类约定**
   - 装备类（武器/护甲等）：按物品名命名（`sword`、`bow`、`torch`、`lantern`）。
   - 工具类：按具体物品各自命名（`pickaxe`、`rope`），不要共用笼统图标。
   - 药水/消耗品：`potion` 及变体（`potion`、后续可扩展 `potion-greater` 等）。
   - 食物类：`rations`。

6. **无需改动前端代码**
   - `loadSvgIcon` 已支持任意图标名 + 兜底，新增图标只加 SVG 文件 + JSON `icon` 字段即可。

## 其他约定

- **讨论与编码边界（铁律）**：未获用户明确确认前**不得修改任何代码**。方案讨论、代码阅读、问题分析均属讨论阶段；只有用户确认方案/明确说"开始做"后，才允许动手写代码。讨论中即使已给出改动方向，也必须等用户点头再实施。
- 后端 Python 位于 `backend/`，修改后运行 `python3 -m py_compile` 验证。
- 前端为单文件静态页面（`adventure.html` 等），无构建步骤；修改后用 IDE 诊断确认无 JS 语法错误。
- 运行时数据变更（NPC 状态、物品拿取等）优先复用已有机制：`npc_states`、`location_states`、`player_inventory`，避免重复造轮子。

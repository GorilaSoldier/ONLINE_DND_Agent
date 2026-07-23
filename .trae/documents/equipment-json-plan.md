# 装备 JSON 化实施方案

## Summary

将当前硬编码在 `lobby.html` 中的装备展示逻辑，以及 `elias.json` 中只含名称的装备条目，改造为"角色 JSON + 类型化装备库 JSON"的双层结构。

- **角色 JSON**：保留每个角色实际拥有的装备实例（ID、名称、数量、是否装备、自定义备注）。
- **装备库 JSON**：按装备类型分文件存储（武器、护甲、饰品等），包含基础属性、效果、描述、图标引用等。
- **前端**：从后端同时获取角色数据与装备库数据，合并后渲染物品栏。

## Current State Analysis

### 已有文件

1. **`data/characters/elias.json`**
   - `inventory.items` 中每个装备只有 `name`、`quantity`、`equipped` 三个字段。
   - 没有装备类型、效果、描述、图标等元数据。

2. **`backend/main.py`**
   - 已提供 `/api/characters` 和 `/api/characters/{char_id}`。
   - 没有装备相关接口。

3. **`lobby.html`**
   - 物品栏通过 `renderInventory(char)` 函数渲染，只展示名称和"已装备"标签。
   - 装备槽位（`left-slots` / `right-slots`）是硬编码的 8 个空图标，未与具体装备关联。
   - 右键菜单、拖拽装备等交互已有事件委托，但数据源仍依赖 DOM 中的 `.item-name`。

### 主要问题

- 装备信息分散在前端硬编码和角色 JSON 中，无法扩展描述、稀有度、图标等属性。
- 同一件装备被多个角色持有时，属性需要重复维护。
- 装备槽位只是占位图标，没有显示实际装备。

## Proposed Changes

### 1. 新增装备库 JSON 文件

**文件列表：**
- `data/equipment/weapons.json`
- `data/equipment/armors.json`
- `data/equipment/accessories.json`

**内容结构（以 `weapons.json` 为例）：**

```json
{
  "type": "weapon",
  "items": {
    "longsword": {
      "id": "longsword",
      "name": "长剑",
      "type": "weapon",
      "subtype": "sword",
      "rarity": "common",
      "description": "一把标准的长剑。",
      "icon": "sword",
      "properties": {
        "damage": "1d8 挥砍",
        "weight": "3磅"
      }
    }
  }
}
```

**说明：**
- 同一类型装备集中在一个文件，方便修改属性、效果、描述。
- 用 `id` 作为唯一标识，角色 JSON 中通过 `equipment_id` 引用。
- `icon` 字段先用类型图标名（如 `sword`、`shield`、`armor`、`amulet`），不绑定具体图片路径，后续可直接替换为图片 URL。

### 2. 修改角色 JSON

**文件：** `data/characters/elias.json`

**修改内容：**
- 将 `inventory.items` 中的条目从纯名称对象改为引用装备库的对象：

```json
{
  "inventory": {
    "gold": 500,
    "items": [
      { "equipment_id": "travel_clothes", "quantity": 1, "equipped": false },
      { "equipment_id": "breastplate", "quantity": 1, "equipped": true },
      { "equipment_id": "shield", "quantity": 1, "equipped": true },
      { "equipment_id": "emblem", "quantity": 1, "equipped": true },
      { "equipment_id": "common_clothes", "quantity": 1, "equipped": false }
    ]
  }
}
```

- 保留 `quantity` 和 `equipped`，便于角色实例化管理。
- 保留 `name` 作为可选覆盖字段，用于允许角色持有命名装备（如"祖父的剑"）。

### 3. 扩展后端接口

**文件：** `backend/main.py`

**新增接口：**

1. `GET /api/equipment`
   - 返回所有装备库文件合并后的完整装备列表。

2. `GET /api/equipment/{type}`
   - 返回指定类型的装备，如 `/api/equipment/weapons`。

3. `GET /api/equipment/{type}/{item_id}`
   - 返回单个装备详情，如 `/api/equipment/weapons/longsword`。

**实现方式：**
- 在 `main.py` 中新增 `DATA_DIR_EQUIPMENT = Path(__file__).parent.parent / "data" / "equipment"`。
- 加载时按类型读取 JSON 文件，按 `id` 平铺成一个装备字典返回。
- 复用现有 `json.load` 模式，保持代码风格一致。

### 4. 修改前端渲染逻辑

**文件：** `lobby.html`

**修改内容：**

1. **新增装备库获取函数**
   - 在 `loadCharacter` 成功后，并行请求 `/api/equipment`。
   - 将装备库数据缓存到全局变量 `window.equipmentCatalog`。

2. **修改 `renderInventory(char)`**
   - 接收 `char` 和 `equipmentCatalog` 两个参数。
   - 对每个 `item`，通过 `equipment_id` 在装备库中查找名称、描述、图标、稀有度。
   - 渲染时显示：图标 + 名称 + 数量 + "已装备"标签。
   - 如果装备库中找不到，fallback 显示角色 JSON 中保存的 `name`。

3. **装备槽位与已装备物品关联（可选第一阶段简化）**
   - 第一阶段先不改变硬编码槽位布局，只让物品栏卡片显示更丰富的信息。
   - 在物品栏卡片上增加 `data-type` 属性，用于后续做装备槽位自动映射。

4. **事件委托兼容**
   - 现有右键菜单、"已装备"切换逻辑依赖 `.item-name`，需要改为依赖 `data-item-id`。
   - 将 `item-card` 上的 `data-equipment-id` 作为唯一标识。

### 5. 类型图标方案

- 在 CSS 或内联 SVG 中预定义几类图标：`sword`、`shield`、`armor`、`amulet`、`clothes`、`bow`、`staff`。
- 装备 JSON 中 `icon` 字段对应图标名，前端根据图标名渲染对应 SVG。
- 不引入外部图片，保持项目轻量；后续有具体美术资源时，只需把 `icon` 改为图片路径并扩展渲染逻辑。

## Assumptions & Decisions

1. **角色 JSON 保留完整名称**
   - 决定：保留 `name` 字段作为可选项，默认从装备库读取。
   - 原因：允许角色拥有命名装备，同时保持装备库作为标准数据源。

2. **装备库按类型分文件**
   - 决定：`weapons.json`、`armors.json`、`accessories.json` 分开。
   - 原因：比单一文件易于维护，比每个装备一个文件更轻量；DND 装备类型天然适合分类。

3. **先不做具体装备图片**
   - 决定：用一种类型一个 SVG 图标替代。
   - 原因：减少美术资源依赖，快速验证方案；预留 `icon` 字段方便后续替换。

4. **装备槽位第一阶段不动**
   - 决定：先改造物品栏数据源和渲染，不改动 `left-slots` / `right-slots` 硬编码布局。
   - 原因：用户强调"不能动现在 HTML 页面写好的各种布局"，槽位映射作为第二阶段功能。

5. **后端接口复用现有 FastAPI 结构**
   - 决定：新增 `/api/equipment/*` 接口，与 `/api/characters/*` 风格一致。
   - 原因：保持 API 一致性，前端调用方式统一。

## Verification Steps

1. 启动后端：`python -m uvicorn main:app --port 8000 --reload`
2. 访问 `http://127.0.0.1:8000/api/equipment`，确认返回所有装备数据。
3. 访问 `http://127.0.0.1:8000/api/equipment/weapons`，确认返回武器类装备。
4. 访问 `http://127.0.0.1:8000/api/characters/elias`，确认 `inventory.items` 使用 `equipment_id`。
5. 打开 `http://127.0.0.1:8000/lobby.html`，进入"我的角色" → 埃利亚斯 → 物品栏标签。
6. 检查物品栏是否正确显示：图标、名称、数量、"已装备"标签。
7. 检查右键菜单、装备/卸下功能是否仍能正常工作。
8. 检查浏览器控制台无报错。

## 实施顺序

1. 创建 `data/equipment/` 目录及类型 JSON 文件。
2. 填充埃利亚斯当前拥有的装备到装备库。
3. 修改 `data/characters/elias.json` 中的 `inventory.items`。
4. 扩展 `backend/main.py` 装备接口。
5. 修改 `lobby.html` 前端渲染与事件委托。
6. 启动后端并验证。

/**
 * 战斗全局常量
 * 集中管理战斗规则中的固定数值，后续需要调整只需改这里。
 */

/** 1 格 = 1.5 米（D&D 5e 标准：1 格 = 5 英尺 ≈ 1.5m） */
export const CELL_METERS = 1.5;

/** 近战攻击射程（格） */
export const MELEE_RANGE_CELLS = 1;

/** 远程攻击射程（格）：6 格 = 9 米
 *  （BG3 远程为 18m，因战斗地图仅 18×24 格，12 格几乎覆盖全图，压缩到 9m 以协调比例） */
export const RANGED_RANGE_CELLS = 6;

/* ── 探索迷雾（2026-09-12 定稿，见文字冒险方案 11.4） ── */

/** 无黑暗视觉（人类/半身人/龙裔/吉斯洋基人）的视野半径（格）
 *  （5e RAW：纯黑暗中无黑暗视觉且无光源 = 目盲，故为 0 格；必须依靠火把/提灯等光源才可见） */
export const VISION_RADIUS_NORMAL = 0;

/* 黑暗视觉半径不在此写死：由种族特性写入角色卡的 background.attributes.darkvision（米数），
   迷雾端按 CELL_METERS 换算成格（普通黑暗视觉 6m → 4 格 / 卓越黑暗视觉 9m → 6 格） */

/* 光源照明半径（火把/提灯）不在此写死：由装备库 weapons.json 的 stats.light_radius_cells 驱动，
   见 js/character/equipment-effects.js（需装备才生效） */

/** 挡视线的障碍 kind 集合（water 挡移动不挡视线，可跳过故视线可穿）
 *  background = 地图上不存在的占位格（洞外虚空）：不可通行，但**不挡视线/光线**
 *  cliff = 场景内垂直崖壁：无限高，挡视线+挡光 */
export const SIGHT_BLOCKING_KINDS = new Set(['wall', 'tree', 'rock', 'cliff']);

/* ── 视线高度与固定光源（2026-10-27 定稿，见战斗地图方案 §7.3 / §12） ── */

/** 观察者眼睛在所在格 z 层之上的高度（层；1 层 = 1.5m） */
export const EYE_HEIGHT_LAYERS = 1;

/** 固定环境光源（篝火/火盆/墙上火把）火焰在所在格 z 层之上的高度（层） */
export const LIGHT_FLAME_HEIGHT_LAYERS = 0.5;

/** 视线高度容差（层）：连线插值高度允许被地形略微遮挡的余量 */
export const SIGHT_HEIGHT_TOLERANCE = 0.2;

/** 向上抬头的视线上限（层）：目标格比观察者高超过该层数（5 层 = 7.5m）→ 崖壁完全遮挡，
 *  不再判定“看到崖沿顶面”；等高与向下的视线不受此限（2026-10-29） */
export const MAX_UPWARD_SIGHT_LAYERS = 5;

/** 地图固定光源的照明半径（格）：与火把/提灯一致，地图 JSON 不存半径字段 */
export const FIXED_LIGHT_RADIUS_CELLS = 4;

/* ── canonical v2 枚举中文标签 ──
   标签表与展示函数统一定义在 ui/ui-shared.js（经典脚本，先于本模块执行），
   这里只做转出，避免同一份中文表在仓库里存两份。 */

export const DAMAGE_TYPE_LABEL = window.DAMAGE_TYPE_LABEL;
export const SCHOOL_LABEL = window.SCHOOL_LABEL;
export const ACTION_COST_LABEL = window.ACTION_COST_LABEL;
export const rangeLabel = window.rangeLabel;
export const damageTypeLabel = window.damageTypeLabel;

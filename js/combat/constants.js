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

/** 挡视线的障碍 kind 集合（water 挡移动不挡视线，可跳过故视线可穿） */
export const SIGHT_BLOCKING_KINDS = new Set(['wall', 'tree', 'rock', 'background']);

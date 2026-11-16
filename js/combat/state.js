/**
 * 战斗系统共享状态（唯一数据源）
 * 所有战斗模块 import 同一份可变对象，避免拆分后各持副本导致状态不同步
 * 注意：mapConfig / layers 由 main.js 初始化时赋值；tokens 数组原地增删
 */

export const API_BASE = window.location.origin;
export const ADVENTURE_ID = 'lost-mine-of-phandelver';
export const CHAPTER_ID = 'ch1';

export const combatState = {
  /* ── 地图与图层（main.initMap 赋值） ── */
  mapConfig: null,
  layers: null,

  /* ── token 池 ── */
  tokens: [],

  /* ── 选中与交互状态机 ── */
  selectedToken: null,
  currentRange: new Map(),          // 当前移动/跳跃范围（key=cellKey）
  state: 'idle',                    // idle | selected | moving | targeting | jumping
  pendingAction: null,              // 待结算动作 {type:'attack',kind} | {type:'spell',spellId}
  targetableTokens: [],             // 射程内可点击目标
  rangeCircle: null,                // 射程圆 DOM 元素
  jumpRangeCells: 0,                // 跳跃半径（格）
  verticalPrompt: null,             // 垂直移动选择浮层 DOM（相邻格 |Δz|≥2 时弹出）

  /* ── 遭遇上下文（M6：从 adventure.html 经 sessionStorage 传入） ── */
  encounterContext: null,

  /* ── 当前战斗（battles.json 条目；activeBattleId 从 localStorage 读取） ── */
  activeBattle: null,

  /* ── 地图探险模式（activeMapId 从 localStorage 读取；与 activeBattleId 二选一） ── */
  mapMode: false,
  mapId: null,
  debugMap: false,                  // ?map= 调试入口（无冒险上下文）
  mapBattles: [],                   // 当前地图上尚未击败的 on_enter 战斗

  /* ── 探索迷雾（fog.js 初始化；revealed 会话内存，刷新即重置） ── */
  fog: {
    enabled: false,          // 地图 JSON 有 fog_zones 才启用
    zoneSet: new Set(),      // 迷雾覆盖格集合（"col,row"，来自地图 JSON）
    revealed: new Set(),     // 已永久揭示的格子（会话内永久，刷新清零）
    sightBlockSet: new Set(),// 挡视线的障碍格（wall/tree/rock/background，water 不挡视线）
    layer: null,             // 最上层黑幕 canvas（z-index 30，pointer-events none）
  },


  /* ── 开关 ── */
  nonlethalEnabled: false,          // 非致命打击（session 内存，刷新即丢）

  /* ── 数据目录（loadCombatData 填充） ── */
  npcCatalog: {},
  npcTemplates: {},
  spellLookup: {},
  equipmentCatalog: {},

  /* ── 法术位（D&D 5e：1环位，长休恢复） ── */
  spellSlots: { 1: { max: 2, used: 0 } },

  /* ── 动作经济（每回合重置，见 combat-loop.initTurnResources） ── */
  turnResources: {
    action: 1,
    bonus: 1,
    moveLeft: 0,
    moveBase: 0,
    secondWindUsed: false,
    actionSurgeUsed: false,
    justRevived: false,
  },

  /* ── 先攻顺序（combat-loop 维护） ── */
  initiativeOrder: [],
  currentInitIndex: -1,
  turnCounter: 1,
  lastLogTurn: null,                // 战斗日志轮次分隔条状态（combat-ui 读取）

  /* ── 战斗阶段 ── */
  combatPhase: 'idle',              // idle | player | enemy | victory | defeat
  enemyTurnRunning: false,
};

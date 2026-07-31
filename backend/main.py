"""DNDBOX Backend — FastAPI 入口"""
import logging
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pathlib import Path

logger = logging.getLogger(__name__)

app = FastAPI(title="DNDBOX Backend", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 注册路由 ──
from routers.characters import router as characters_router
from routers.data import router as data_router
from routers.game import router as game_router

app.include_router(characters_router)
app.include_router(data_router)
app.include_router(game_router)

# ── 开场白缓存 ──
# key: f"{adventure_id}:{chapter_id}:{scene_id}"
_opening_cache: dict = {}
# 开场白生成时的背景 exchange（用于注入 session history）
_opening_exchange_cache: dict = {}


@app.on_event("startup")
async def pre_generate_opening():
    """启动时预生成开场白，减少首轮延迟"""
    import asyncio
    from services.ai_gm import AIGM
    from services.game_state import load_adventure_chapter, find_scene, get_location, load_chapter_summary

    try:
        ai_gm = AIGM()
        if not ai_gm.client:
            logger.warning("AI GM 未配置，跳开场白预生成")
            return

        # 为默认模组/章节/场景预生成
        adventure_id = "lost-mine-of-phandelver"
        chapter_id = "ch1"
        scene_id = "ch1-scene1"

        data = load_adventure_chapter(adventure_id, chapter_id)
        scene = find_scene(data, scene_id)
        if not scene:
            logger.warning(f"场景 {scene_id} 未找到，跳开场白预生成")
            return

        location = get_location(data, scene.get("location"))
        if not location:
            logger.warning("起始地点未找到，跳开场白预生成")
            return

        # 获取 NPC 信息
        npc_ids = scene.get("npcs", [])
        npcs = []
        for nid in npc_ids:
            npc = data["npcs"].get(nid)
            if npc:
                npc_copy = dict(npc)
                npc_copy["id"] = nid
                npcs.append(npc_copy)

        # 获取物品信息
        items = []
        item_entries = location.get("items", [])
        for entry in item_entries:
            iid = entry.get("id") if isinstance(entry, dict) else entry
            item = data["items"].get(iid)
            if item:
                items.append(dict(item, id=iid))

        chapter_summary = load_chapter_summary(adventure_id, chapter_id)

        # 使用默认角色名（前端加载角色后会替换）
        character_name = "爱米利亚"

        logger.info("正在预生成开场白...")
        opening = await asyncio.to_thread(
            ai_gm.generate_opening,
            adventure_name="凡戴尔的失落矿坑",
            chapter_summary=chapter_summary,
            scene_name=scene.get("name", ""),
            location=location,
            npcs=npcs,
            items=items,
            character_name=character_name,
        )

        cache_key = f"{adventure_id}:{chapter_id}:{scene_id}"
        _opening_cache[cache_key] = opening

        # 构建背景 exchange（供 session history 注入）
        bg_prompt = f"""【以下是你的 GM 背景资料，请记住这些信息】

模组：凡戴尔的失落矿坑
章节：{scene.get('name', '')}
地点：{location.get('name', '')} — {location.get('description', '')}

任务：护送甘德伦·碎石者的采矿物资从绝冬城前往凡达林，报酬每人十个金币。

关键NPC：
""" + "\n".join([f"- {n.get('name')}（{n.get('role', '')}）：{', '.join(n.get('personality', []))}" for n in npcs])

        _opening_exchange_cache[cache_key] = [
            {"role": "user", "content": bg_prompt},
            {"role": "assistant", "content": opening},
        ]

        usage = ai_gm.last_usage.get('opening', {})
        logger.info(
            f"开场白预生成完成 "
            f"(prompt_tokens={usage.get('prompt_tokens', '?')}, "
            f"completion_tokens={usage.get('completion_tokens', '?')})"
        )

    except Exception as e:
        logger.warning(f"开场白预生成失败（将使用硬编码 fallback）: {e}")


# ── 根路径 ──
@app.get("/")
def root():
    return RedirectResponse(url="/login.html")


# ── 静态文件服务（必须在最后） ──
BASE_DIR = Path(__file__).parent.parent
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")


def get_cached_opening(adventure_id: str, chapter_id: str, scene_id: str) -> str | None:
    """获取缓存的开场白"""
    return _opening_cache.get(f"{adventure_id}:{chapter_id}:{scene_id}")


def get_opening_exchange(adventure_id: str, chapter_id: str, scene_id: str) -> list | None:
    """获取开场白背景 exchange（用于注入 session history）"""
    return _opening_exchange_cache.get(f"{adventure_id}:{chapter_id}:{scene_id}")

"""DNDBOX Backend — FastAPI 入口"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pathlib import Path

app = FastAPI(title="DNDBOX Backend", version="0.2.0")

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


# ── 根路径 ──
@app.get("/")
def root():
    return RedirectResponse(url="/login.html")


# ── 静态文件服务（必须在最后） ──
BASE_DIR = Path(__file__).parent.parent
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")

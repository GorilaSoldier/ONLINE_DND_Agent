@echo off
chcp 65001 >nul
echo =========================================
echo   DNDBOX Web Demo
echo =========================================

:: 检查 Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 python，请先安装 Python 3.10+
    echo   下载: https://www.python.org/downloads/
    pause
    exit /b 1
)

:: 安装依赖
echo [1/2] 安装依赖...
pip install -r requirements.txt -q
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败，请检查网络连接
    pause
    exit /b 1
)

:: 启动服务
echo [2/2] 启动服务...
echo.
echo   打开浏览器访问: http://localhost:8000
echo   按 Ctrl+C 停止服务
echo.

:: 自动打开浏览器
start http://localhost:8000

python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

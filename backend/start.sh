#!/bin/bash
# DNDBOX Web Demo 启动脚本 (Linux/macOS)

cd "$(dirname "$0")"

echo "========================================="
echo "  DNDBOX Web Demo"
echo "========================================="

# 检查 Python3
if ! command -v python3 &> /dev/null; then
    echo "[错误] 未找到 python3，请先安装 Python 3.10+"
    echo "  Ubuntu/Debian: sudo apt install python3 python3-pip"
    echo "  macOS:         brew install python3"
    exit 1
fi

# 安装依赖
echo "[1/2] 安装依赖..."
pip3 install -r requirements.txt -q
if [ $? -ne 0 ]; then
    echo "[错误] 依赖安装失败，请检查网络连接"
    exit 1
fi

# 启动服务
echo "[2/2] 启动服务..."
echo ""
echo "  打开浏览器访问: http://localhost:8000"
echo "  按 Ctrl+C 停止服务"
echo ""

python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Write-Host "========================================="
Write-Host "  DNDBOX Web Demo"
Write-Host "========================================="

# 检查 Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未找到 python，请先安装 Python 3.10+" -ForegroundColor Red
    Write-Host "  下载: https://www.python.org/downloads/"
    Read-Host "按任意键退出"
    exit 1
}

# 安装依赖
Write-Host "[1/2] 安装依赖..."
pip install -r requirements.txt -q
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 依赖安装失败，请检查网络连接" -ForegroundColor Red
    Read-Host "按任意键退出"
    exit 1
}

# 启动服务
Write-Host "[2/2] 启动服务..."
Write-Host ""
Write-Host "  打开浏览器访问: http://localhost:8000"
Write-Host "  按 Ctrl+C 停止服务"
Write-Host ""

python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

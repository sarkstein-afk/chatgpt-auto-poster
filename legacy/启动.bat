@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ═══════════════════════════════════
echo   ChatGPT 海报自动生成工具
echo ═══════════════════════════════════
echo.

:: 检查 node_modules 是否存在
if not exist "node_modules\" (
    echo [1/2] 正在安装依赖...
    call npm install
    echo.
    echo [2/2] 正在安装 Chrome 浏览器驱动...
    call npx playwright install chromium
    echo.
    echo ✅ 环境配置完成！
    echo.
)

echo 🚀 启动中...
echo.
node gpt-bot.js

pause

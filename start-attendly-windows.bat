@echo off
cd /d %~dp0
docker compose up --build -d
echo.
echo Attendly is starting.
echo Open this on this computer:
echo   http://localhost:4000
echo.
echo Open this on other computers on the same network:
echo   http://YOUR-COMPUTER-IP:4000
echo.
echo Login:
echo   admin@attendly.local
echo   admin123!
echo.
pause

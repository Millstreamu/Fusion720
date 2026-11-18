@echo off
rem Double-click to run Fusion720 locally, then open http://localhost:8720
start "" http://localhost:8720/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8720

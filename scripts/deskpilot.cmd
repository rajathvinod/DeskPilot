@echo off
rem Thin shim so `deskpilot` works from any terminal. Add this folder to PATH once.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deskpilot.ps1" %*

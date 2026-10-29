@echo off
rem veritas: start, open and check the Veritas server. The Windows twin of bin/veritas (spec 024 G2).
rem   veritas serve [--port N]   start the server (downloads the search model the first time)
rem   veritas open               open the web app in the browser
rem   veritas status             is it running, and what is indexed
rem   veritas model              download the search model now
rem VERITAS_DATA moves the data and the model out of the code folder (server\paths.py); VERITAS_PYTHON picks the Python.
setlocal EnableExtensions
if defined VERITAS_ROOT (set "root=%VERITAS_ROOT%") else (for %%I in ("%~dp0..") do set "root=%%~fI")
set "server=%root%\server"
if defined VERITAS_PYTHON (set "python=%VERITAS_PYTHON%") else (set "python=%server%\.venv\Scripts\python.exe")
if defined VERITAS_PORT (set "port=%VERITAS_PORT%") else (set "port=27182")
if defined VERITAS_DATA (set "models=%VERITAS_DATA%\models") else (set "models=%server%\models")
set "model=%models%\snowflake-arctic-embed-s"
rem Notes, settings and the index files are UTF-8; without this Windows Python reads them in the ANSI code page.
set "PYTHONUTF8=1"

if "%~1"=="serve" goto serve
if "%~1"=="open" goto open
if "%~1"=="status" goto status
if "%~1"=="model" goto model
echo veritas serve [--port N]   start the server (downloads the search model the first time)
echo veritas open               open the web app in the browser
echo veritas status             is it running, and what is indexed
echo veritas model              download the search model now
exit /b 2

:serve
if "%~2"=="--port" set "port=%~3"
call :get_model || exit /b 1
if defined VERITAS_DATA if not exist "%VERITAS_DATA%" mkdir "%VERITAS_DATA%"
if not defined KB_BACKEND set "KB_BACKEND=onnx"
cd /d "%server%" || exit /b 1
"%python%" kb.py serve --port %port%
exit /b %errorlevel%

:open
start "" "http://localhost:%port%/app/"
exit /b 0

:status
curl -fs -m 2 "http://localhost:%port%/ping" >nul 2>&1
if errorlevel 1 goto not_running
echo Veritas is running at http://localhost:%port%/app/
curl -fs -m 5 "http://localhost:%port%/status" | "%python%" -c "import json,sys; print(json.load(sys.stdin).get('notes', 0), 'notes and papers indexed')" 2>nul
exit /b 0
:not_running
echo Veritas is not running. Start it with: veritas serve
exit /b 1

:model
call :get_model || exit /b 1
echo Search model ready in %model%
exit /b 0

:get_model
if exist "%model%\onnx\model.onnx" if exist "%model%\tokenizer.json" exit /b 0
echo Veritas: downloading the search model (133 MB, once)...
if not exist "%model%\onnx" mkdir "%model%\onnx"
call :fetch "onnx\model.onnx" "onnx/model.onnx" || exit /b 1
call :fetch "tokenizer.json" "tokenizer.json" || exit /b 1
call :fetch "config.json" "config.json" || exit /b 1
exit /b 0

rem :fetch <file under the model folder> <its path in the Hugging Face repo>; curl.exe ships with Windows 10 and 11.
:fetch
curl -fL --progress-bar -o "%model%\%~1.part" "https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/%~2" || exit /b 1
move /y "%model%\%~1.part" "%model%\%~1" >nul
exit /b %errorlevel%

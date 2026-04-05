#!/bin/bash

# Check if we're in the right directory
if [ ! -f "requirements.txt" ]; then
    echo "Error: Please run this script from the project directory"
    echo "Make sure you've extracted all files from the zip archive"
    read -p "Press Enter to exit..."
    exit 1
fi

# Check if virtual environment exists (.venv preferred, venv fallback)
if [ -f ".venv/bin/activate" ]; then
    VENV_DIR=".venv"
elif [ -f "venv/bin/activate" ]; then
    VENV_DIR="venv"
else
    echo "Virtual environment not found. Run repo setup first (./setup.sh) or run build.sh in this folder."
    exit 1
fi

echo "Activating virtual environment..."
source "$VENV_DIR/bin/activate"

# Launch browser based on OS
echo "Opening web interface..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://127.0.0.1:7860" || echo "Unable to auto-open browser. Please navigate to http://127.0.0.1:7860"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://127.0.0.1:7860" || echo "Unable to auto-open browser. Please navigate to http://127.0.0.1:7860"
    elif command -v sensible-browser >/dev/null 2>&1; then
        sensible-browser "http://127.0.0.1:7860" || echo "Unable to auto-open browser. Please navigate to http://127.0.0.1:7860"
    elif command -v x-www-browser >/dev/null 2>&1; then
        x-www-browser "http://127.0.0.1:7860" || echo "Unable to auto-open browser. Please navigate to http://127.0.0.1:7860"
    else
        echo "Unable to auto-open browser. Please navigate to http://127.0.0.1:7860"
    fi
fi

echo "Starting Twitter Bot Control Center..."
python sherpa_bot.py

# If there's an error, provide detailed feedback
if [ $? -ne 0 ]; then
    echo "Error running the application."
    echo "Please check:"
    echo "1. Your internet connection"
    echo "2. That all API keys are correctly entered"
    echo "3. That you have sufficient permissions"
fi

deactivate

# Language Learning Assistant - Electron Version

A modern, sleek desktop application for real-time language transcription and translation, built with Electron.

## Features

- 🎨 Modern, dark-themed UI
- 🎤 Real-time audio capture from microphones or system output
- 📝 Automatic transcription using SenseVoice
- 🌐 Real-time translation using Ollama
- 🔊 Volume threshold filtering
- 🌍 Multi-language support (Chinese, English, Japanese, Korean, Cantonese)
- 📊 Side-by-side transcription and translation display

## Prerequisites

1. **Node.js** (v16 or higher)
2. **Python** (3.8 or higher)
3. **Ollama** running locally on `http://localhost:11434`
4. **Python dependencies** (see requirements.txt)

## Installation

1. Install Node.js dependencies:
```bash
npm install
```

2. Install Python dependencies:
```bash
pip install -r requirements.txt
```

3. Make sure Ollama is running and the model is available:
```bash
ollama pull gemma3:4b
```

## Running the Application

Start the Electron app:
```bash
npm start
```

## Project Structure

- `main.js` - Electron main process (window management, IPC)
- `preload.js` - Preload script for secure IPC bridge
- `renderer.js` - Frontend logic and UI interactions
- `index.html` - UI structure
- `styles.css` - Modern styling
- `electron_backend.py` - Python backend bridge for audio/transcription
- `electron-config.json` - Configuration file

## Configuration

Edit `electron-config.json` to customize:
- Ollama endpoint and model
- Volume threshold
- Buffer duration
- Other settings

## Architecture

The app uses a hybrid architecture:
- **Electron frontend**: Modern UI built with HTML/CSS/JavaScript
- **Python backend**: Handles audio capture and SenseVoice transcription
- **IPC communication**: JSON messages between Electron and Python processes
- **Ollama API**: HTTP requests for translation

## Development

For development with auto-reload:
```bash
npm run dev
```

## Building

To build distributables:
```bash
npm install electron-builder --save-dev
npm run build
```

## Notes

- The Python backend runs as a subprocess and communicates via stdin/stdout
- Audio capture uses the existing `audio_capture.py` module
- Transcription uses SenseVoice via the existing `sensevoice_transcriber.py`
- Translation is handled directly in Electron via HTTP requests to Ollama

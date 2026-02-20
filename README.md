# Language Learning Desktop App

A desktop application that helps you learn foreign languages by:
1. Capturing system audio output (what you hear)
2. Transcribing foreign language speech to text using SenseVoice
3. Translating the transcription to English using Ollama
4. Displaying both original transcription and translation in real-time

## Features

- Real-time audio capture from system output
- Modular transcription service (easily switch between models)
- Translation using Ollama with multilingual models
- Clean, modern desktop UI

## Prerequisites

1. **Python 3.8+**
2. **Ollama** installed and running with a multilingual model:
   ```powershell
   ollama pull gemma2:2b
   # or
   ollama pull gemma2:9b
   ```

3. **SenseVoice model** will be automatically downloaded on first run

4. **Windows Audio Setup** (for capturing system audio):
   - On Windows, you may need to enable "Stereo Mix" or configure a virtual audio cable
   - Alternatively, use a tool like VB-Audio Virtual Cable or VoiceMeeter
   - The app will try to detect loopback devices automatically

## Installation

1. Clone or download this repository

2. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```

3. (Optional) Install ffmpeg for better audio handling:
   - **Using winget** (Windows 10/11):
     ```powershell
     winget install ffmpeg
     ```
   - **Using Chocolatey** (if installed):
     ```powershell
     choco install ffmpeg
     ```
   - **Manual installation**:
     1. Download from https://ffmpeg.org/download.html
     2. Extract and add to PATH, or
     3. Use the full path to ffmpeg.exe
   
   Note: ffmpeg is optional - the app will work with torchaudio as fallback.

4. Make sure Ollama is running:
   ```powershell
   ollama serve
   ```

## Usage

1. Start the application:
   ```powershell
   python main.py
   ```

2. Select your audio output device from the dropdown

3. Click "Start Capturing" to begin transcription and translation

4. Play audio with foreign language content on your system

5. View real-time transcriptions and translations in the app window

## Configuration

- **Ollama Model**: Edit `config.py` to change the Ollama model name
- **Ollama Endpoint**: Default is `http://localhost:11434`, change in `config.py` if needed
- **Language Jitter Window**: Edit `config.py` to adjust `LANGUAGE_JITTER_WINDOW` (default: 3) - number of consecutive samples that must agree before changing detected language
- **Audio Settings**: Adjust sample rate, chunk size in `audio_capture.py`

## Language Selection

The app includes a language selector with autocomplete that allows you to:
- **Override language detection**: Select a specific language (zh, en, yue, ja, ko) to force transcription in that language
- **Auto-detect mode**: Select "auto" to let SenseVoice automatically detect the language
- **Jitter reduction**: When in auto mode, the app uses a configurable window (default: 3 samples) to reduce language switching jitter - the detected language only changes when the last N samples all agree on a new language

## Architecture

- `main.py`: Main application entry point and UI
- `audio_capture.py`: System audio capture using WASAPI loopback
- `transcription_service.py`: Abstract transcription interface
- `sensevoice_transcriber.py`: SenseVoice implementation
- `translation_service.py`: Ollama translation service
- `config.py`: Configuration settings

## Switching Transcription Models

To use a different transcription model, create a new class that implements the `TranscriptionService` interface in `transcription_service.py` and update `main.py` to use it.

Example: See `example_whisper_transcriber.py` for a Whisper implementation example.

To switch models:
1. Create your transcription service class implementing `TranscriptionService`
2. In `main.py`, change the import:
   ```python
   from your_transcriber import YourTranscriber as TranscriptionService
   ```
3. Update the initialization in `_init_services()` method

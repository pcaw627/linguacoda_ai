"""
Configuration settings for the language learning app
"""

# Ollama settings
OLLAMA_ENDPOINT = "http://127.0.0.1:11434"
OLLAMA_MODEL = "gemma3:4b"  # Change to gemma2:9b for better quality (slower)

# Audio capture settings
SAMPLE_RATE = 16000  # SenseVoice typically uses 16kHz
CHUNK_SIZE = 4096  # Audio buffer size
CHANNELS = 1  # Mono audio

# Buffer settings - silence-based accumulation
BUFFER_SILENCE_THRESHOLD = 0.0001  # RMS amplitude threshold for silence detection
BUFFER_SILENCE_DURATION = 0.2  # Seconds of silence required before processing buffer
BUFFER_MAX_DURATION = 10.0  # Maximum seconds to accumulate before forcing buffer processing

# Volume threshold settings
# Audio below this threshold (RMS amplitude) will not be transcribed
# Range: 0.0 (no filtering) to 1.0 (very strict)
# Typical values: 0.0001-0.001 for very sensitive, 0.001-0.01 for normal environments
VOLUME_THRESHOLD = 0.0001  # Fixed threshold - adjustable via UI slider

# Transcription settings
TRANSCRIPTION_LANGUAGE = "auto"  # "auto" for automatic detection, or specific language code
USE_ITN = True  # Inverse Text Normalization

# Language detection jitter reduction
LANGUAGE_JITTER_WINDOW = 3  # Number of consecutive samples that must agree before changing language

# UI settings
UPDATE_INTERVAL_MS = 100  # How often to update the UI (milliseconds)
MAX_TEXT_LENGTH = 1000  # Maximum characters to display

# SenseVoice model settings
SENSEVOICE_MODEL = "iic/SenseVoiceSmall"  # or "iic/SenseVoice" for larger model

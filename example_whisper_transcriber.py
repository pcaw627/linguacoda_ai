"""
Example: Whisper transcription service implementation
This demonstrates how to swap out the transcription model
"""
import numpy as np
from typing import List
from transcription_service import TranscriptionService
import config
import tempfile
import os


class WhisperTranscriber(TranscriptionService):
    """
    Example Whisper-based transcription service
    To use this instead of SenseVoice, replace the import in main.py:
    
    from whisper_transcriber import WhisperTranscriber as TranscriptionService
    """
    
    def __init__(self, model_name: str = "base"):
        """
        Initialize Whisper transcriber
        
        Args:
            model_name: Whisper model name (tiny, base, small, medium, large)
        """
        try:
            import whisper
            self.model = whisper.load_model(model_name)
            self.is_ready_flag = True
            print(f"Whisper model '{model_name}' loaded successfully")
        except ImportError:
            print("Error: openai-whisper not installed. Install with: pip install openai-whisper")
            raise
        except Exception as e:
            print(f"Error loading Whisper model: {e}")
            raise
    
    def transcribe(self, audio_data: np.ndarray, language: str = "auto") -> tuple[str, str]:
        """Transcribe audio data to text"""
        if not self.is_ready():
            return ("", language if language != "auto" else "unknown")
        
        try:
            import soundfile as sf
            
            # Save to temporary file
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
                sf.write(tmp_file.name, audio_data, config.SAMPLE_RATE)
                tmp_path = tmp_file.name
            
            try:
                # Transcribe
                result = self.model.transcribe(
                    tmp_path,
                    language=None if language == "auto" else language,
                    task="transcribe"
                )
                
                text = result.get("text", "").strip()
                detected_lang = result.get("language", language if language != "auto" else "unknown")
                return (text, detected_lang)
            finally:
                os.unlink(tmp_path)
        except Exception as e:
            print(f"Transcription error: {e}")
            return ("", language if language != "auto" else "unknown")
    
    def transcribe_batch(self, audio_chunks: List[np.ndarray], language: str = "auto") -> List[tuple[str, str]]:
        """Transcribe multiple audio chunks"""
        results = []
        for chunk in audio_chunks:
            text, lang = self.transcribe(chunk, language)
            results.append((text, lang))
        return results
    
    def is_ready(self) -> bool:
        """Check if the service is ready"""
        return self.is_ready_flag and self.model is not None
    
    def cleanup(self):
        """Clean up resources"""
        self.model = None
        self.is_ready_flag = False

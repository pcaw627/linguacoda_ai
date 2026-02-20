"""
Client for connecting to the external transcription server
"""
import requests
import base64
import numpy as np
from typing import Optional
from pathlib import Path
import time

TOKEN_FILE = Path(__file__).parent / ".transcription_server.token"
SERVER_URL = "http://127.0.0.1:8765"
HEALTH_CHECK_TIMEOUT = 2
REQUEST_TIMEOUT = 30


class TranscriptionClient:
    """Client for external transcription server"""
    
    def __init__(self, server_url: str = SERVER_URL):
        self.server_url = server_url
        self.token = self._load_token()
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {self.token}',
            'Content-Type': 'application/json'
        })
        self._last_health_check = 0
        self._health_check_interval = 5  # Check health every 5 seconds
        self._server_was_running = False
    
    def _load_token(self) -> Optional[str]:
        """Load authentication token from file"""
        if TOKEN_FILE.exists():
            try:
                with open(TOKEN_FILE, 'r') as f:
                    token = f.read().strip()
                    if token:
                        return token
            except Exception as e:
                print(f"Warning: Failed to load token: {e}", file=__import__('sys').stderr)
        return None
    
    def is_server_running(self, force_check: bool = False) -> bool:
        """Check if the transcription server is running
        
        Args:
            force_check: If True, always check. If False, use cached result if recent.
        """
        import time as time_module
        current_time = time_module.time()
        
        # Use cached result if check was recent and not forcing
        if not force_check and (current_time - self._last_health_check) < self._health_check_interval:
            return self._server_was_running
        
        try:
            response = self.session.get(
                f"{self.server_url}/health",
                timeout=HEALTH_CHECK_TIMEOUT
            )
            is_running = response.status_code == 200
            self._server_was_running = is_running
            self._last_health_check = current_time
            return is_running
        except (requests.exceptions.RequestException, requests.exceptions.Timeout):
            self._server_was_running = False
            self._last_health_check = current_time
            return False
    
    def transcribe(self, audio_data: np.ndarray, language: str = "auto") -> tuple[str, str]:
        """
        Transcribe audio data using the external server
        
        Args:
            audio_data: Audio samples as numpy array (float32, mono, 16kHz)
            language: Language code or "auto" for automatic detection
            
        Returns:
            Tuple of (transcribed_text, detected_language)
        """
        # Force health check before transcription
        if not self.is_server_running(force_check=True):
            return ("", language if language != "auto" else "unknown")
        
        try:
            # Ensure audio is in correct format
            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32)
            
            # Encode audio to base64
            audio_bytes = audio_data.tobytes()
            audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
            
            # Send request
            response = self.session.post(
                f"{self.server_url}/transcribe",
                json={
                    "audio": audio_b64,
                    "language": language
                },
                timeout=REQUEST_TIMEOUT
            )
            
            if response.status_code == 200:
                result = response.json()
                return (
                    result.get("transcription", ""),
                    result.get("detectedLang", language if language != "auto" else "unknown")
                )
            elif response.status_code == 503:
                # Service not ready
                return ("", language if language != "auto" else "unknown")
            else:
                print(f"Transcription request failed: {response.status_code} - {response.text}", 
                      file=__import__('sys').stderr)
                return ("", language if language != "auto" else "unknown")
                
        except requests.exceptions.Timeout:
            print("Transcription request timed out", file=__import__('sys').stderr)
            return ("", language if language != "auto" else "unknown")
        except Exception as e:
            print(f"Transcription error: {e}", file=__import__('sys').stderr)
            return ("", language if language != "auto" else "unknown")
    
    def transcribe_batch(self, audio_chunks: list, language: str = "auto") -> list:
        """Transcribe multiple audio chunks"""
        results = []
        for chunk in audio_chunks:
            text, lang = self.transcribe(chunk, language)
            results.append((text, lang))
        return results
    
    def is_ready(self) -> bool:
        """Check if the service is ready to transcribe"""
        return self.is_server_running()
    
    def cleanup(self):
        """Clean up resources"""
        if hasattr(self, 'session'):
            self.session.close()

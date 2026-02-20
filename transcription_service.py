"""
Abstract transcription service interface
"""
from abc import ABC, abstractmethod
from typing import List, Optional
import numpy as np


class TranscriptionService(ABC):
    """Abstract base class for transcription services"""
    
    @abstractmethod
    def transcribe(self, audio_data: np.ndarray, language: str = "auto") -> tuple[str, str]:
        """
        Transcribe audio data to text
        
        Args:
            audio_data: Audio samples as numpy array (float32, mono, 16kHz)
            language: Language code or "auto" for automatic detection
            
        Returns:
            Tuple of (transcribed_text, detected_language)
            detected_language will be the same as language if not "auto"
        """
        pass
    
    @abstractmethod
    def transcribe_batch(self, audio_chunks: List[np.ndarray], language: str = "auto") -> List[str]:
        """
        Transcribe multiple audio chunks
        
        Args:
            audio_chunks: List of audio samples
            language: Language code or "auto" for automatic detection
            
        Returns:
            List of transcribed text strings
        """
        pass
    
    @abstractmethod
    def is_ready(self) -> bool:
        """Check if the service is ready to transcribe"""
        pass
    
    @abstractmethod
    def cleanup(self):
        """Clean up resources"""
        pass

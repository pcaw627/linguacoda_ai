"""
SenseVoice transcription service implementation
"""
import numpy as np
from typing import List, Optional
from transcription_service import TranscriptionService
import config
from pathlib import Path
import queue
import threading
import os
import sys


class SenseVoiceTranscriber(TranscriptionService):
    """SenseVoice-based transcription service"""
    
    def __init__(self, model_dir: Optional[str] = None, sensevoice_repo_path: Optional[str] = None):
        """
        Initialize SenseVoice transcriber
        
        Args:
            model_dir: Model directory path (None to use default)
            sensevoice_repo_path: Path to cloned SenseVoice repository (None to auto-detect)
        """
        self.model_dir = model_dir or config.SENSEVOICE_MODEL
        self.sensevoice_repo_path = sensevoice_repo_path or self._find_sensevoice_repo()
        self.model = None
        self.is_ready_flag = False
        self._init_model()
    
    def _find_sensevoice_repo(self):
        """Find the SenseVoice repository path"""
        # Check if SenseVoice directory exists in current directory
        current_dir = Path(__file__).parent
        sensevoice_path = current_dir / "SenseVoice"
        
        if sensevoice_path.exists() and (sensevoice_path / "model.py").exists():
            return str(sensevoice_path)
        
        # Check parent directory
        parent_sensevoice = current_dir.parent / "SenseVoice"
        if parent_sensevoice.exists() and (parent_sensevoice / "model.py").exists():
            return str(parent_sensevoice)
        
        # Return None if not found (will use remote model)
        return None
    
    def _init_model(self):
        """Initialize the SenseVoice model"""
        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
            
            # Store postprocess function for later use
            self.postprocess = rich_transcription_postprocess
            
            print(f"Loading SenseVoice model: {self.model_dir}")
            
            # Build AutoModel arguments
            model_kwargs = {
                "model": self.model_dir,
                "device": "cpu",  # Change to "cuda:0" if GPU available
                "disable_update": True,
            }
            
            # If we have a local SenseVoice repo, use it
            if self.sensevoice_repo_path:
                model_py_path = os.path.join(self.sensevoice_repo_path, "model.py")
                if os.path.exists(model_py_path):
                    model_kwargs["trust_remote_code"] = True
                    model_kwargs["remote_code"] = model_py_path
                    print(f"Using local SenseVoice model from: {self.sensevoice_repo_path}")
            
            self.model = AutoModel(**model_kwargs)
            self.is_ready_flag = True
            print("SenseVoice model loaded successfully")
            
        except ImportError as e:
            print(f"Error: funasr not installed. Install with: pip install funasr")
            print(f"Import error details: {e}")
            raise
        except Exception as e:
            print(f"Error loading SenseVoice model: {e}")
            import traceback
            traceback.print_exc()
            raise
    
    def transcribe(self, audio_data: np.ndarray, language: str = "auto") -> tuple[str, str]:
        """
        Transcribe audio data to text
        
        Args:
            audio_data: Audio samples as numpy array (float32, mono, 16kHz)
            language: Language code or "auto" for automatic detection
            
        Returns:
            Tuple of (transcribed_text, detected_language)
        """
        if not self.is_ready():
            return ("", language if language != "auto" else "unknown")
        
        try:
            # Ensure audio is in correct format
            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32)
            
            # Normalize audio if needed
            if np.max(np.abs(audio_data)) > 1.0:
                audio_data = audio_data / np.max(np.abs(audio_data))
            
            # SenseVoice expects file path or list of file paths
            # We'll need to save to temporary file or use in-memory approach
            # For now, we'll use a workaround with temporary file
            import tempfile
            import soundfile as sf
            
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
                sf.write(tmp_file.name, audio_data, config.SAMPLE_RATE)
                tmp_path = tmp_file.name
            
            try:
                # Suppress progress bar output from FunASR
                import contextlib
                import io
                import os
                
                # Disable tqdm progress bars via environment variable
                old_tqdm_disable = os.environ.get('TQDM_DISABLE', None)
                os.environ['TQDM_DISABLE'] = '1'
                
                try:
                    # Redirect stdout/stderr to suppress progress bars
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        # Transcribe
                        result = self.model.generate(
                            input=tmp_path,
                            cache={},
                            language=language if language != "auto" else "auto",
                            use_itn=config.USE_ITN,
                            batch_size_s=60,
                            merge_vad=True,
                            merge_length_s=15,
                        )
                finally:
                    # Restore original tqdm setting
                    if old_tqdm_disable is None:
                        os.environ.pop('TQDM_DISABLE', None)
                    else:
                        os.environ['TQDM_DISABLE'] = old_tqdm_disable
                
                # Extract text and detected language from result
                # Result format: list of dicts with "text" and potentially "lang" key
                detected_lang = language if language != "auto" else "unknown"
                
                if result and len(result) > 0:
                    if isinstance(result[0], dict):
                        text = result[0].get('text', '')
                        # Check if language is in the result
                        if 'lang' in result[0]:
                            detected_lang = result[0]['lang']
                        elif language == "auto":
                            # If auto mode, we need to infer from text or use a default
                            # SenseVoice may not always return lang, so we'll track it separately
                            detected_lang = "auto"
                    elif isinstance(result[0], str):
                        text = result[0]
                    else:
                        text = str(result[0])
                    
                    # Post-process the text using SenseVoice's utility
                    if hasattr(self, 'postprocess') and text:
                        try:
                            text = self.postprocess(text)
                        except:
                            pass  # If postprocess fails, use raw text
                    
                    return (text.strip(), detected_lang)
                return ("", detected_lang)
                
            finally:
                # Clean up temp file
                import os
                try:
                    os.unlink(tmp_path)
                except:
                    pass
                    
        except Exception as e:
            print(f"Transcription error: {e}")
            return ("", language if language != "auto" else "unknown")
    
    def transcribe_batch(self, audio_chunks: List[np.ndarray], language: str = "auto") -> List[tuple[str, str]]:
        """
        Transcribe multiple audio chunks
        
        Args:
            audio_chunks: List of audio samples
            language: Language code or "auto" for automatic detection
            
        Returns:
            List of tuples (transcribed_text, detected_language)
        """
        results = []
        for chunk in audio_chunks:
            text, lang = self.transcribe(chunk, language)
            results.append((text, lang))
        return results
    
    def is_ready(self) -> bool:
        """Check if the service is ready to transcribe"""
        return self.is_ready_flag and self.model is not None
    
    def cleanup(self):
        """Clean up resources"""
        self.model = None
        self.is_ready_flag = False

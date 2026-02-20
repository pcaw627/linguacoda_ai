"""
Translation service using Ollama
"""
import requests
import json
from typing import Optional
import config


class TranslationService:
    """Translation service using Ollama API"""
    
    def __init__(self, endpoint: Optional[str] = None, model: Optional[str] = None):
        """
        Initialize translation service
        
        Args:
            endpoint: Ollama API endpoint (default from config)
            model: Ollama model name (default from config)
        """
        self.endpoint = endpoint or config.OLLAMA_ENDPOINT
        self.model = model or config.OLLAMA_MODEL
        self.api_url = f"{self.endpoint}/api/generate"
    
    def translate(self, text: str, target_language: str = "English") -> str:
        """
        Translate text to target language
        
        Args:
            text: Text to translate
            target_language: Target language (default: English)
            
        Returns:
            Translated text
        """
        if not text or not text.strip():
            return ""
        
        try:
            prompt = f"Translate the following text to {target_language}. If there is nothing between [START] and [END] then respond only with \"_\". Only provide the translation, no explanations:\n\n[START]{text}[END]"
            
            payload = {
                "model": self.model,
                "prompt": prompt,
                "stream": False
            }
            
            response = requests.post(self.api_url, json=payload, timeout=30)
            response.raise_for_status()
            
            result = response.json()
            translation = result.get("response", "").strip()
            
            # Clean up translation (remove any extra text)
            lines = translation.split('\n')
            # Take the first non-empty line that looks like a translation
            for line in lines:
                line = line.strip()
                if line and not line.startswith("Translation:") and not line.startswith("Here"):
                    return line
            
            return translation if translation else text
            
        except requests.exceptions.RequestException as e:
            print(f"Translation API error: {e}")
            return f"[Translation error: {e}]"
        except Exception as e:
            print(f"Translation error: {e}")
            return f"[Translation error: {e}]"
    
    def is_available(self) -> bool:
        """Check if Ollama service is available"""
        try:
            response = requests.get(f"{self.endpoint}/api/tags", timeout=5)
            return response.status_code == 200
        except:
            return False

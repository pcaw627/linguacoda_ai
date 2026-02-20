"""
Main application for language learning desktop app
"""
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import threading
import queue
import numpy as np
from audio_capture import AudioCapture
from sensevoice_transcriber import SenseVoiceTranscriber
from translation_service import TranslationService
from device_cache import load_cache, save_cache, find_stereo_mix_device
import config
import time


class LanguageLearningApp:
    """Main application window"""
    
    def __init__(self, root):
        self.root = root
        self.root.title("Language Learning Assistant")
        self.root.geometry("1200x800")
        # State
        self.is_capturing = False
        self.audio_capture = None
        self.transcriber = None
        self.translator = None
        
        # Audio buffer for transcription (accumulate chunks)
        self.audio_buffer = []
        self.buffer_duration = config.BUFFER_DURATION  # seconds of audio to accumulate before transcribing
        self.last_transcription_time = time.time()
        
        # Queues for thread-safe UI updates
        self.transcription_queue = queue.Queue()
        self.translation_queue = queue.Queue()
        
        # Current text - stored as pairs for alignment
        self.transcription_pairs = []  # List of (transcription, translation) tuples
        
        # Language detection with jitter reduction
        self.language_history = []  # Track detected languages
        self.current_detected_language = "auto"  # Current stable language
        self.selected_language = "auto"  # User-selected language override
        
        # Initialize services
        self._init_services()
        
        # Build UI
        self._build_ui()
        
        # Start UI update loop
        self._update_ui()
        
        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self._on_closing)
    
    def _init_services(self):
        """Initialize transcription and translation services"""
        try:
            print("Initializing transcription service...")
            self.transcriber = SenseVoiceTranscriber()
            
            print("Initializing translation service...")
            self.translator = TranslationService()
            
            if not self.translator.is_available():
                messagebox.showwarning(
                    "Ollama Not Available",
                    "Ollama service is not available. Please make sure Ollama is running.\n"
                    f"Expected endpoint: {config.OLLAMA_ENDPOINT}"
                )
        except Exception as e:
            messagebox.showerror("Initialization Error", f"Failed to initialize services: {e}")
    
    def _build_ui(self):
        """Build the user interface"""
        # Main container
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)  # Add second column for side-by-side layout
        main_frame.rowconfigure(3, weight=1)  # Single row for both text boxes
        
        # Device selection
        device_frame = ttk.Frame(main_frame)
        device_frame.grid(row=0, column=0, sticky=(tk.W, tk.E), pady=5)
        
        ttk.Label(device_frame, text="Audio Device:").grid(row=0, column=0, padx=5)
        self.device_var = tk.StringVar()
        self.device_combo = ttk.Combobox(device_frame, textvariable=self.device_var, state="readonly", width=50)
        self.device_combo.grid(row=0, column=1, padx=5, sticky=(tk.W, tk.E))
        device_frame.columnconfigure(1, weight=1)
        
        ttk.Button(device_frame, text="Refresh", command=lambda: self._refresh_devices(use_cache=False)).grid(row=0, column=2, padx=5)
        
        # Track device selection changes to save to cache
        self.device_combo.bind('<<ComboboxSelected>>', self._on_device_selected)
        
        # Language selection
        lang_frame = ttk.Frame(main_frame)
        lang_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=5)
        
        ttk.Label(lang_frame, text="Language:").grid(row=0, column=0, padx=5)
        self.language_var = tk.StringVar(value="auto")
        # Supported languages with autocomplete
        self.language_options = ["auto", "zh", "en", "yue", "ja", "ko", "nospeech"]
        self.language_combo = ttk.Combobox(
            lang_frame, 
            textvariable=self.language_var, 
            values=self.language_options,
            width=20
        )
        self.language_combo.grid(row=0, column=1, padx=5, sticky=(tk.W, tk.E))
        self.language_combo.bind('<KeyRelease>', self._on_language_typing)
        self.language_combo.bind('<<ComboboxSelected>>', self._on_language_selected)
        
        # Detected language display
        self.detected_lang_label = ttk.Label(lang_frame, text="Detected: auto", foreground="gray")
        self.detected_lang_label.grid(row=0, column=2, padx=10)
        
        # Control buttons
        control_frame = ttk.Frame(main_frame)
        control_frame.grid(row=2, column=0, columnspan=2, pady=10, sticky=(tk.W, tk.E))
        
        self.start_button = ttk.Button(control_frame, text="Start Capturing", command=self._start_capture)
        self.start_button.grid(row=0, column=0, padx=5)
        
        self.stop_button = ttk.Button(control_frame, text="Stop Capturing", command=self._stop_capture, state="disabled")
        self.stop_button.grid(row=0, column=1, padx=5)
        
        # Status label
        self.status_label = ttk.Label(control_frame, text="Ready", foreground="green")
        self.status_label.grid(row=0, column=2, padx=10)
        
        # Volume threshold control
        ttk.Label(control_frame, text="Volume Threshold:").grid(row=0, column=3, padx=(20, 5))
        self.volume_threshold_var = tk.DoubleVar(value=config.VOLUME_THRESHOLD)
        self.volume_threshold_scale = ttk.Scale(
            control_frame,
            from_=0.0,
            to=0.1,
            variable=self.volume_threshold_var,
            orient=tk.HORIZONTAL,
            length=150,
            command=self._on_volume_threshold_change
        )
        self.volume_threshold_scale.grid(row=0, column=4, padx=5)
        self.volume_threshold_label = ttk.Label(control_frame, text=f"{config.VOLUME_THRESHOLD:.4f}")
        self.volume_threshold_label.grid(row=0, column=5, padx=5)
        
        # Transcription section (left side)
        trans_frame = ttk.LabelFrame(main_frame, text="Original Transcription", padding="5")
        trans_frame.grid(row=3, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=5, padx=(0, 5))
        trans_frame.columnconfigure(0, weight=1)
        trans_frame.rowconfigure(0, weight=1)
        
        self.transcription_text = scrolledtext.ScrolledText(
            trans_frame,
            wrap=tk.WORD,
            height=10,
            font=("Arial", 11)
        )
        self.transcription_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Translation section (right side)
        trans_frame = ttk.LabelFrame(main_frame, text="English Translation", padding="5")
        trans_frame.grid(row=3, column=1, sticky=(tk.W, tk.E, tk.N, tk.S), pady=5, padx=(5, 0))
        trans_frame.columnconfigure(0, weight=1)
        trans_frame.rowconfigure(0, weight=1)
        
        self.translation_text = scrolledtext.ScrolledText(
            trans_frame,
            wrap=tk.WORD,
            height=10,
            font=("Arial", 11),
            foreground="blue"
        )
        self.translation_text.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Load devices (use cache on startup for faster loading)
        self._refresh_devices(use_cache=True)
    
    def _on_language_typing(self, event):
        """Handle typing in language combobox for autocomplete"""
        value = self.language_var.get().lower()
        if value:
            # Filter options that start with the typed value
            matches = [opt for opt in self.language_options if opt.startswith(value)]
            if matches:
                self.language_combo['values'] = matches
            else:
                self.language_combo['values'] = self.language_options
        else:
            self.language_combo['values'] = self.language_options
    
    def _on_language_selected(self, event=None):
        """Handle language selection change"""
        self.selected_language = self.language_var.get().lower()
        # Reset language history when user manually selects
        if self.selected_language != "auto":
            self.language_history = []
            self.current_detected_language = self.selected_language
            self.detected_lang_label.config(text=f"Detected: {self.selected_language} (manual)", foreground="blue")
        else:
            self.current_detected_language = "auto"
            self.detected_lang_label.config(text="Detected: auto", foreground="gray")
    
    def _on_volume_threshold_change(self, value=None):
        """Handle volume threshold slider change"""
        threshold = self.volume_threshold_var.get()
        config.VOLUME_THRESHOLD = threshold
        self.volume_threshold_label.config(text=f"{threshold:.4f}")
    
    def _refresh_devices(self, use_cache: bool = True):
        """Refresh list of available audio devices
        
        Args:
            use_cache: If True, try to load from cache first. If False, force refresh.
        """
        try:
            if self.audio_capture:
                if use_cache:
                    devices = self.audio_capture.get_all_audio_devices(use_cache=True)
                else:
                    devices = self.audio_capture.get_all_audio_devices_fresh()
            else:
                # Create temporary capture to get devices
                temp_capture = AudioCapture(lambda x: None)
                if use_cache:
                    devices = temp_capture.get_all_audio_devices(use_cache=True)
                else:
                    devices = temp_capture.get_all_audio_devices_fresh()
            
            device_names = [f"{d['name']} (ID: {d['id']})" for d in devices]
            self.device_combo['values'] = device_names
            
            # Load cached selection or default to stereo mix
            cached_data = load_cache() if use_cache else None
            selected_device = None
            
            if cached_data and cached_data.get('selected_device_id') is not None:
                # Try to find cached device
                cached_device_id = cached_data['selected_device_id']
                for i, device in enumerate(devices):
                    if device['id'] == cached_device_id:
                        selected_device = device
                        self.device_combo.current(i)
                        break
            
            # If no cached device or cached device unavailable, try stereo mix
            if selected_device is None:
                stereo_mix = find_stereo_mix_device(devices)
                if stereo_mix:
                    for i, device in enumerate(devices):
                        if device['id'] == stereo_mix['id']:
                            self.device_combo.current(i)
                            selected_device = stereo_mix
                            break
            
            # Fallback to first device
            if selected_device is None and device_names:
                self.device_combo.current(0)
                selected_device = devices[0] if devices else None
            
            # Save to cache
            if selected_device:
                save_cache(devices, selected_device['id'], 
                          selected_device.get('type', 'input'), 
                          selected_device['name'])
        except Exception as e:
            messagebox.showerror("Error", f"Failed to refresh devices: {e}")
    
    def _on_device_selected(self, event=None):
        """Handle device selection change - save to cache"""
        try:
            device_id = self._get_selected_device_id()
            if device_id is not None:
                # Get current device list
                if self.audio_capture:
                    devices = self.audio_capture.get_all_audio_devices(use_cache=True)
                else:
                    temp_capture = AudioCapture(lambda x: None)
                    devices = temp_capture.get_all_audio_devices(use_cache=True)
                
                # Find selected device
                selected_device = None
                for device in devices:
                    if device['id'] == device_id:
                        selected_device = device
                        break
                
                if selected_device:
                    save_cache(devices, device_id, 
                              selected_device.get('type', 'input'), 
                              selected_device['name'])
        except Exception as e:
            print(f"Warning: Failed to save device selection: {e}")
    
    def _get_selected_device_id(self):
        """Get the selected device ID"""
        selection = self.device_var.get()
        if not selection:
            return None
        
        try:
            # Extract ID from selection string "Name (ID: 0)"
            device_id = int(selection.split("ID: ")[1].rstrip(")"))
            return device_id
        except:
            return None
    
    def _audio_callback(self, audio_chunk: np.ndarray):
        """Callback for audio chunks"""
        if not self.is_capturing:
            return
        
        # Accumulate audio chunks
        self.audio_buffer.append(audio_chunk)
        
        # Check if we have enough audio to transcribe
        buffer_length = sum(len(chunk) for chunk in self.audio_buffer) / config.SAMPLE_RATE
        
        if buffer_length >= self.buffer_duration:
            # Process in separate thread to avoid blocking
            threading.Thread(target=self._process_audio_buffer, daemon=True).start()
    
    def _calculate_volume(self, audio_data: np.ndarray) -> float:
        """Calculate RMS (Root Mean Square) amplitude of audio data"""
        if len(audio_data) == 0:
            return 0.0
        # RMS amplitude: sqrt(mean(squared values))
        rms = np.sqrt(np.mean(audio_data ** 2))
        return float(rms)
    
    def _process_audio_buffer(self):
        """Process accumulated audio buffer"""
        if not self.audio_buffer:
            return
        
        try:
            # Concatenate audio chunks
            audio_data = np.concatenate(self.audio_buffer)
            
            # Check volume threshold before processing
            volume = self._calculate_volume(audio_data)
            current_threshold = self.volume_threshold_var.get() if hasattr(self, 'volume_threshold_var') else config.VOLUME_THRESHOLD
            if volume <= current_threshold:
                # Volume too low, skip transcription
                self.audio_buffer = []  # Clear buffer
                return
            
            self.audio_buffer = []  # Clear buffer
            
            # Determine language to use for transcription
            # If user selected a specific language, use it; otherwise use auto
            transcription_lang = self.selected_language if self.selected_language != "auto" else "auto"
            
            # Transcribe
            if self.transcriber and self.transcriber.is_ready():
                transcription, detected_lang = self.transcriber.transcribe(audio_data, transcription_lang)
                
                if transcription and transcription.strip():
                    # Handle language detection with jitter reduction
                    if self.selected_language == "auto" and detected_lang and detected_lang != "auto" and detected_lang != "unknown":
                        # Add to history
                        self.language_history.append(detected_lang)
                        
                        # Keep only last N samples
                        if len(self.language_history) > config.LANGUAGE_JITTER_WINDOW:
                            self.language_history.pop(0)
                        
                        # Check if last N samples agree
                        if len(self.language_history) >= config.LANGUAGE_JITTER_WINDOW:
                            # Check if all last N samples are the same
                            last_n = self.language_history[-config.LANGUAGE_JITTER_WINDOW:]
                            if len(set(last_n)) == 1:  # All agree
                                new_lang = last_n[0]
                                if new_lang != self.current_detected_language:
                                    self.current_detected_language = new_lang
                                    # Update UI in main thread
                                    self.root.after(0, lambda: self.detected_lang_label.config(
                                        text=f"Detected: {new_lang}",
                                        foreground="green"
                                    ))
                    
                    # Filter out transcriptions containing "_" (often indicates errors/placeholders)
                    if "_" not in transcription:
                        # Store transcription with a placeholder for translation
                        self.transcription_queue.put(('transcription', transcription))
                        
                        # Translate in separate thread
                        threading.Thread(
                            target=self._translate_text,
                            args=(transcription,),
                            daemon=True
                        ).start()
                    else:
                        # Skip transcription and translation if it contains "_"
                        print(f"Skipping transcription with '_': {transcription[:50]}...")
        except Exception as e:
            print(f"Error processing audio: {e}")
    
    def _translate_text(self, text: str):
        """Translate text using Ollama"""
        if not self.translator:
            return
        
        try:
            translation = self.translator.translate(text)
            if translation:
                self.translation_queue.put(('translation', translation))
        except Exception as e:
            print(f"Translation error: {e}")
    
    def _start_capture(self):
        """Start audio capture"""
        if self.is_capturing:
            return
        
        try:
            device_id = self._get_selected_device_id()
            
            self.audio_capture = AudioCapture(self._audio_callback, device_id)
            self.audio_capture.start()
            
            self.is_capturing = True
            self.start_button.config(state="disabled")
            self.stop_button.config(state="normal")
            self.status_label.config(text="Capturing...", foreground="green")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to start capture: {e}")
            self.is_capturing = False
    
    def _stop_capture(self):
        """Stop audio capture"""
        if not self.is_capturing:
            return
        
        self.is_capturing = False
        
        if self.audio_capture:
            self.audio_capture.stop()
            self.audio_capture = None
        
        self.start_button.config(state="normal")
        self.stop_button.config(state="disabled")
        self.status_label.config(text="Stopped", foreground="red")
        
        # Clear buffer
        self.audio_buffer = []
    
    def _count_lines(self, text: str) -> int:
        """Count the number of lines in text"""
        if not text:
            return 0
        return len(text.split('\n'))
    
    def _format_pairs_for_display(self) -> tuple[str, str]:
        """Format transcription and translation pairs with proper alignment"""
        if not self.transcription_pairs:
            return ("", "")
        
        transcription_lines = []
        translation_lines = []
        
        for i, (trans, trans_lang) in enumerate(self.transcription_pairs):
            trans_lines = trans.split('\n') if trans else ['']
            trans_lang_lines = trans_lang.split('\n') if trans_lang else ['']
            
            # Get line counts
            trans_count = len(trans_lines)
            trans_lang_count = len(trans_lang_lines)
            
            # Add separator before this pair (except for first one)
            if i > 0:
                # Get current line counts (before adding this pair)
                current_trans_lines = len(transcription_lines)
                current_trans_lang_lines = len(translation_lines)
                current_max = max(current_trans_lines, current_trans_lang_lines)
                
                # Pad the shorter column to match the maximum
                # This creates a gap if the previous pair had more lines
                if current_trans_lines < current_max:
                    for _ in range(current_max - current_trans_lines):
                        transcription_lines.append("")
                
                if current_trans_lang_lines < current_max:
                    for _ in range(current_max - current_trans_lang_lines):
                        translation_lines.append("")
                
                # Add separator line (blank line between pairs)
                transcription_lines.append("")
                translation_lines.append("")
            
            # Add current pair's lines
            transcription_lines.extend(trans_lines)
            translation_lines.extend(trans_lang_lines)
            
            # Align current pair - pad the shorter one to match
            current_trans_total = len(transcription_lines)
            current_trans_lang_total = len(translation_lines)
            current_max_total = max(current_trans_total, current_trans_lang_total)
            
            if current_trans_total < current_max_total:
                for _ in range(current_max_total - current_trans_total):
                    transcription_lines.append("")
            
            if current_trans_lang_total < current_max_total:
                for _ in range(current_max_total - current_trans_lang_total):
                    translation_lines.append("")
        
        return ("\n".join(transcription_lines), "\n".join(translation_lines))
    
    def _update_ui(self):
        """Update UI with new transcriptions and translations"""
        # Process transcription queue
        try:
            while True:
                item_type, content = self.transcription_queue.get_nowait()
                if item_type == 'transcription':
                    # Add new transcription pair with empty translation placeholder
                    self.transcription_pairs.append((content, ""))
        except queue.Empty:
            pass
        
        # Process translation queue
        try:
            while True:
                item_type, content = self.translation_queue.get_nowait()
                if item_type == 'translation':
                    # Find the last pair with empty translation and update it
                    for i in range(len(self.transcription_pairs) - 1, -1, -1):
                        trans, trans_lang = self.transcription_pairs[i]
                        if not trans_lang:  # Found the pair waiting for translation
                            self.transcription_pairs[i] = (trans, content)
                            break
        except queue.Empty:
            pass
        
        # Format and display pairs
        transcription_text, translation_text = self._format_pairs_for_display()
        
        # Limit text length
        if len(transcription_text) > config.MAX_TEXT_LENGTH:
            truncated = transcription_text[-config.MAX_TEXT_LENGTH:]
            first_newline = truncated.find("\n")
            if first_newline > 0:
                transcription_text = truncated[first_newline + 1:]
            else:
                transcription_text = truncated
            # Rebuild pairs from truncated text (simplified - just truncate display)
            # Note: This is a simplified approach; for better handling, we'd need to track pairs differently
        
        if len(translation_text) > config.MAX_TEXT_LENGTH:
            truncated = translation_text[-config.MAX_TEXT_LENGTH:]
            first_newline = truncated.find("\n")
            if first_newline > 0:
                translation_text = truncated[first_newline + 1:]
            else:
                translation_text = truncated
        
        # Update UI
        self.transcription_text.delete(1.0, tk.END)
        self.transcription_text.insert(1.0, transcription_text)
        self.transcription_text.see(tk.END)
        
        self.translation_text.delete(1.0, tk.END)
        self.translation_text.insert(1.0, translation_text)
        self.translation_text.see(tk.END)
        
        # Schedule next update
        self.root.after(config.UPDATE_INTERVAL_MS, self._update_ui)
    
    def _on_closing(self):
        """Handle window closing"""
        self._stop_capture()
        
        if self.transcriber:
            self.transcriber.cleanup()
        
        self.root.destroy()


def main():
    """Main entry point"""
    print("Initializing Language Learning Assistant...")
    root = tk.Tk()
    app = LanguageLearningApp(root)
    print("Application window ready. Starting main loop...")
    root.mainloop()


if __name__ == "__main__":
    main()

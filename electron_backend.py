"""
Python backend for Electron app
Handles audio capture and transcription
"""
import sys
import json
import threading
import queue
import numpy as np
import time
from audio_capture import AudioCapture
from transcription_client import TranscriptionClient
from device_cache import load_cache, save_cache, find_stereo_mix_device
import config

class ElectronBackend:
    def __init__(self):
        self.audio_capture = None
        self.transcriber = None
        self.is_capturing = False
        self.audio_buffer = []
        self.buffer_silence_threshold = config.BUFFER_SILENCE_THRESHOLD
        self.buffer_silence_duration = config.BUFFER_SILENCE_DURATION
        self.buffer_max_duration = config.BUFFER_MAX_DURATION
        self.volume_threshold = config.VOLUME_THRESHOLD
        self.selected_language = "auto"
        self.language_history = []
        self.current_detected_language = "auto"
        
        # Silence detection tracking
        self.silence_start_time = None
        self.buffer_start_time = None
        
        # Transcriber client will connect to external server
        self.transcriber = None
        self._transcriber_initializing = False
    
    def _init_transcriber(self, wait_for_completion=False):
        """Initialize transcription client (connects to external server)
        
        Args:
            wait_for_completion: If True, wait for server to be ready
        """
        if self.transcriber is not None:
            return  # Already initialized
        
        if self._transcriber_initializing:
            if wait_for_completion:
                # Wait for background initialization to complete
                import time as time_module
                print("Transcriber initialization in progress, waiting...", file=sys.stderr)
                for _ in range(60):  # Wait up to 6 seconds
                    time_module.sleep(0.1)
                    if self.transcriber is not None:
                        print("Transcriber initialization completed", file=sys.stderr)
                        return
                    if not self._transcriber_initializing:
                        # Initialization failed or completed
                        break
                if self.transcriber is None:
                    print("Transcriber initialization did not complete, trying again...", file=sys.stderr)
                    # Reset flag and try again
                    self._transcriber_initializing = False
                else:
                    return
            else:
                return  # Already initializing, don't wait
        
        try:
            self._transcriber_initializing = True
            print("Connecting to transcription server...", file=sys.stderr)
            self.transcriber = TranscriptionClient()
            
            # Check if server is running
            if not self.transcriber.is_server_running():
                print("Transcription server is not running. Please ensure it's started.", file=sys.stderr)
                # Don't fail here - the server might start later
                # The client will handle reconnection attempts
            else:
                print("Connected to transcription server", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"Failed to initialize transcription client: {e}", file=sys.stderr)
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(f"Failed to initialize transcription client: {e}")
        finally:
            self._transcriber_initializing = False
    
    def _send_message(self, msg_type, data):
        """Send JSON message to Electron"""
        message = json.dumps({"type": msg_type, "data": data})
        print(message, flush=True)
    
    def _send_error(self, error):
        """Send error message"""
        self._send_message("error", error)
    
    def _calculate_volume(self, audio_data):
        """Calculate RMS amplitude"""
        if len(audio_data) == 0:
            return 0.0
        rms = np.sqrt(np.mean(audio_data ** 2))
        return float(rms)
    
    def _audio_callback(self, audio_chunk):
        """Callback for audio chunks - uses silence-based buffering"""
        if not self.is_capturing:
            return
        
        current_time = time.time()
        
        # Calculate volume of current chunk
        volume = self._calculate_volume(audio_chunk)
        
        # Debug: Log first few chunks to verify audio is being received
        if not hasattr(self, '_chunk_count'):
            self._chunk_count = 0
        self._chunk_count += 1
        if self._chunk_count <= 5:
            print(f"Audio chunk {self._chunk_count}: shape={audio_chunk.shape}, volume={volume:.6f}", file=sys.stderr)
        
        # Initialize buffer start time on first chunk
        if self.buffer_start_time is None:
            self.buffer_start_time = current_time
            print(f"Started audio buffering at {current_time}", file=sys.stderr)
        
        # Add chunk to buffer
        self.audio_buffer.append(audio_chunk)
        
        # Calculate current buffer duration
        buffer_length = sum(len(chunk) for chunk in self.audio_buffer) / config.SAMPLE_RATE
        
        # Check if we've exceeded max duration
        if buffer_length >= self.buffer_max_duration:
            print(f"Buffer max duration reached ({buffer_length:.2f}s), processing...", file=sys.stderr)
            # Copy buffer before processing to avoid race conditions
            buffer_to_process = list(self.audio_buffer)
            # Force process buffer
            threading.Thread(target=self._process_audio_buffer, args=(buffer_to_process,), daemon=True).start()
            # Clear the buffer after copying
            self.audio_buffer = []
            self.buffer_start_time = None
            self.silence_start_time = None
            return
        
        # Check for silence
        if volume <= self.buffer_silence_threshold:
            # Volume is below silence threshold
            if self.silence_start_time is None:
                # Start tracking silence
                self.silence_start_time = current_time
            else:
                # Check if we've had enough silence
                silence_duration = current_time - self.silence_start_time
                if silence_duration >= self.buffer_silence_duration:
                    print(f"Silence detected ({silence_duration:.2f}s), processing buffer ({buffer_length:.2f}s, {len(self.audio_buffer)} chunks)...", file=sys.stderr)
                    # Copy buffer before processing to avoid race conditions
                    buffer_to_process = list(self.audio_buffer)
                    # Process buffer after silence period
                    threading.Thread(target=self._process_audio_buffer, args=(buffer_to_process,), daemon=True).start()
                    # Clear the buffer after copying
                    self.audio_buffer = []
                    self.buffer_start_time = None
                    self.silence_start_time = None
        else:
            # Volume is above threshold - reset silence tracking
            if self.silence_start_time is not None:
                print(f"Audio detected (volume={volume:.6f}), resetting silence tracking", file=sys.stderr)
            self.silence_start_time = None
    
    def _process_audio_buffer(self, buffer_to_process=None):
        """Process accumulated audio buffer
        
        Args:
            buffer_to_process: Optional pre-copied buffer to process. If None, uses self.audio_buffer
        """
        # Use provided buffer or current buffer
        if buffer_to_process is None:
            buffer_to_process = self.audio_buffer
        
        if not buffer_to_process:
            print("Process audio buffer called but buffer is empty", file=sys.stderr)
            return
        
        try:
            print(f"Processing audio buffer: {len(buffer_to_process)} chunks", file=sys.stderr)
            audio_data = np.concatenate(buffer_to_process)
            buffer_duration = len(audio_data) / config.SAMPLE_RATE
            print(f"Concatenated audio: {len(audio_data)} samples, {buffer_duration:.2f}s", file=sys.stderr)
            
            # Check volume threshold (skip if entire buffer is too quiet)
            volume = self._calculate_volume(audio_data)
            print(f"Buffer volume: {volume:.6f}, threshold: {self.volume_threshold:.6f}", file=sys.stderr)
            if volume <= self.volume_threshold:
                print(f"Buffer volume too low ({volume:.6f} <= {self.volume_threshold:.6f}), skipping transcription", file=sys.stderr)
                return
            
            # Initialize transcriber client if needed (wait for completion if already initializing)
            if self.transcriber is None:
                print("Transcriber client not initialized, initializing now...", file=sys.stderr)
                self._init_transcriber(wait_for_completion=True)
            
            # Check if transcriber was successfully initialized
            if not self.transcriber:
                print("Transcriber client is None after initialization attempt, cannot transcribe", file=sys.stderr)
                return
            
            # Check if server is running and ready
            if not self.transcriber.is_server_running():
                print("Transcription server is not running, skipping transcription", file=sys.stderr)
                return
            
            if not self.transcriber.is_ready():
                print("Transcription server not ready yet, waiting...", file=sys.stderr)
                # Wait a bit for server to be ready
                import time as time_module
                for _ in range(10):  # Wait up to 1 second
                    time_module.sleep(0.1)
                    if self.transcriber.is_ready():
                        break
                
                if not self.transcriber.is_ready():
                    print("Transcription server still not ready after waiting", file=sys.stderr)
                    return
            
            # Transcribe
            print(f"Calling transcriber with {len(audio_data)} samples, language: {self.selected_language}", file=sys.stderr)
            transcription_lang = self.selected_language if self.selected_language != "auto" else "auto"
            transcription, detected_lang = self.transcriber.transcribe(audio_data, transcription_lang)
            
            print(f"Transcription result: '{transcription}', detected_lang: {detected_lang}", file=sys.stderr)
            
            if transcription and transcription.strip() and "_" not in transcription:
                # Handle language detection
                if self.selected_language == "auto" and detected_lang and detected_lang != "auto" and detected_lang != "unknown":
                    self.language_history.append(detected_lang)
                    if len(self.language_history) > config.LANGUAGE_JITTER_WINDOW:
                        self.language_history.pop(0)
                    
                    if len(self.language_history) >= config.LANGUAGE_JITTER_WINDOW:
                        last_n = self.language_history[-config.LANGUAGE_JITTER_WINDOW:]
                        if len(set(last_n)) == 1:
                            new_lang = last_n[0]
                            if new_lang != self.current_detected_language:
                                self.current_detected_language = new_lang
                
                print(f"Sending transcription to UI: '{transcription.strip()}'", file=sys.stderr)
                self._send_message("transcription", {
                    "transcription": transcription.strip(),
                    "detectedLang": detected_lang if detected_lang else self.current_detected_language
                })
            else:
                if not transcription:
                    print("Transcription is empty", file=sys.stderr)
                elif not transcription.strip():
                    print("Transcription is only whitespace", file=sys.stderr)
                elif "_" in transcription:
                    print(f"Transcription contains '_' (likely error): '{transcription}'", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"Error processing audio: {e}", file=sys.stderr)
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(f"Error processing audio: {e}")
    
    def start_capture(self, device_id=None, output_device_id=None):
        """Start audio capture
        
        Args:
            device_id: Input device ID (for microphones)
            output_device_id: Output device ID (for loopback - captures from this output device)
        """
        if self.is_capturing:
            print("Already capturing, ignoring start request", file=sys.stderr)
            return
        
        try:
            # Reset audio tracking
            self._chunk_count = 0
            self.audio_buffer = []
            self.buffer_start_time = None
            self.silence_start_time = None
            
            # If output_device_id is specified, find the corresponding loopback device
            if output_device_id is not None:
                print(f"Finding loopback device for output device {output_device_id}", file=sys.stderr)
                device_id = self._find_loopback_for_output(output_device_id)
                if device_id is None:
                    self._send_error(f"No loopback device found for output device {output_device_id}")
                    return
                print(f"Found loopback device ID: {device_id}", file=sys.stderr)
                # Save the output device selection
                self._save_device_selection(output_device_id, 'output')
            elif device_id is not None:
                # Validate device exists before trying to use it
                try:
                    import sounddevice as sd
                    device_info = sd.query_devices(device_id)
                    print(f"Using input device {device_id}: {device_info['name']}", file=sys.stderr)
                except Exception as e:
                    self._send_error(f"Device {device_id} is no longer available. Please refresh device list.")
                    # Refresh device list
                    self.get_audio_devices(use_cache=False, force_refresh=True)
                    return
                # Save the input device selection
                self._save_device_selection(device_id, 'input')
            else:
                print("No device specified, using default", file=sys.stderr)
            
            print(f"Starting audio capture on device {device_id}", file=sys.stderr)
            self.audio_capture = AudioCapture(self._audio_callback, device_id)
            self.audio_capture.start()
            self.is_capturing = True
            print("Audio capture started successfully", file=sys.stderr)
            self._send_message("status", "capturing")
        except Exception as e:
            import traceback
            print(f"Failed to start capture: {e}", file=sys.stderr)
            print(traceback.format_exc(), file=sys.stderr)
            self._send_error(f"Failed to start capture: {e}")
            # If device is invalid, refresh device list
            if "device" in str(e).lower() or "not found" in str(e).lower():
                self.get_audio_devices(use_cache=False, force_refresh=True)
    
    def _save_device_selection(self, device_id, device_type):
        """Save device selection to cache"""
        try:
            # Get current device list
            temp_capture = AudioCapture(lambda x: None)
            devices = temp_capture.get_all_audio_devices(use_cache=True)
            
            # Find the selected device
            selected_device = None
            for device in devices:
                if device['id'] == device_id:
                    selected_device = device
                    break
            
            if selected_device:
                save_cache(devices, device_id, device_type, selected_device['name'])
        except Exception as e:
            print(f"Warning: Failed to save device selection: {e}", file=sys.stderr)
    
    def _find_loopback_for_output(self, output_device_id):
        """Find the loopback device that corresponds to the given output device"""
        try:
            import sounddevice as sd
            
            # Get all devices
            devices = sd.query_devices()
            output_device = devices[output_device_id]
            output_device_name = output_device['name'].lower()
            
            # Get host APIs
            hostapis = sd.query_hostapis()
            wasapi_id = None
            for api_id, api_info in enumerate(hostapis):
                if 'WASAPI' in api_info['name']:
                    wasapi_id = api_id
                    break
            
            # Find loopback device that matches this output device
            for i, device in enumerate(devices):
                if device['max_input_channels'] > 0:
                    device_name = device['name'].lower()
                    
                    # Check if it's a WASAPI loopback device
                    if wasapi_id is not None and device['hostapi'] == wasapi_id:
                        # Check if this loopback device corresponds to the selected output device
                        # Loopback devices often have similar names or "loopback" in the name
                        if 'loopback' in device_name:
                            # Try to match by name similarity
                            normalized_output = output_device_name.replace(' (high definition audio device)', '')
                            normalized_input = device_name.replace(' (loopback)', '').replace(' (high definition audio device)', '')
                            
                            # If names match or are similar, this is likely the right loopback device
                            if normalized_output in normalized_input or normalized_input in normalized_output:
                                return i
                        # Also check if device has both input and output channels and matches
                        elif device['max_output_channels'] > 0:
                            # This might be a device that can capture its own output
                            if output_device_name in device_name or device_name in output_device_name:
                                return i
            
            # If no exact match, return None
            return None
        except Exception as e:
            self._send_error(f"Error finding loopback device: {e}")
            return None
    
    def stop_capture(self):
        """Stop audio capture"""
        self.is_capturing = False
        
        if self.audio_capture:
            self.audio_capture.stop()
            self.audio_capture = None
        
        self.audio_buffer = []
        self.buffer_start_time = None
        self.silence_start_time = None
        self._send_message("status", "stopped")
    
    def get_audio_devices(self, use_cache: bool = True, force_refresh: bool = False):
        """Get list of audio devices - returns both input and output devices separately
        Uses the same method as list_audio_devices.py
        
        Args:
            use_cache: If True, try to load from cache first
            force_refresh: If True, force refresh and update cache
        """
        try:
            import sounddevice as sd
            
            # Check cache first if not forcing refresh
            if use_cache and not force_refresh:
                cached_data = load_cache()
                if cached_data and cached_data.get('devices'):
                    # Return cached devices immediately without validation for fast startup
                    # Validation will happen when user tries to start capture
                    print(f"Using cached devices (count: {len(cached_data['devices'])})", file=sys.stderr)
                    devices = cached_data['devices']
                    return self._format_devices_for_electron(devices, cached_data)
                else:
                    print("No cache found or cache is empty, refreshing devices...", file=sys.stderr)
            
            # Cache miss or force refresh - get fresh devices
            print("Refreshing device list (this may take a few seconds)...", file=sys.stderr)
            temp_capture = AudioCapture(lambda x: None)
            input_devices = temp_capture.get_input_devices()
            loopback_devices = temp_capture.get_loopback_devices()
            
            # Get all output devices directly from sounddevice
            all_devices = sd.query_devices()
            output_devices = []
            
            for i, device in enumerate(all_devices):
                # Only include devices that have output channels
                if device['max_output_channels'] > 0:
                    output_devices.append({
                        "id": i,
                        "name": device['name']
                    })
            
            # Format input devices (microphones)
            input_list = [{"id": d["id"], "name": f"[Microphone] {d['name']}"} for d in input_devices]
            
            # Format output devices (for loopback selection)
            output_list = [{"id": d["id"], "name": f"[Speaker Output] {d['name']}"} for d in output_devices]
            
            # Combine all devices for caching (same format as main.py)
            all_combined_devices = []
            for device in input_devices:
                all_combined_devices.append({
                    **device,
                    'name': f"[Microphone] {device['name']}"
                })
            for device in loopback_devices:
                all_combined_devices.append({
                    **device,
                    'name': f"[Speaker Output] {device['name']}"
                })
            
            # Try to get default device (cached or stereo mix)
            cached_data = load_cache() if use_cache else None
            default_device = None
            default_device_id = None
            
            if cached_data and cached_data.get('selected_device_id') is not None:
                # Check if cached device is still available
                cached_device_id = cached_data['selected_device_id']
                for device in all_combined_devices:
                    if device['id'] == cached_device_id:
                        default_device = device
                        default_device_id = cached_device_id
                        break
            
            # If no cached device or unavailable, try stereo mix
            if default_device is None:
                stereo_mix = find_stereo_mix_device(all_combined_devices)
                if stereo_mix:
                    default_device = stereo_mix
                    default_device_id = stereo_mix['id']
            
            # Save to cache (always save device list, even if no default device)
            print(f"Saving device cache: {len(all_combined_devices)} devices", file=sys.stderr)
            save_cache(all_combined_devices, default_device_id,
                      default_device.get('type', 'input') if default_device else None,
                      default_device['name'] if default_device else None)
            
            # Send devices with type information
            device_list = {
                "input": input_list,
                "output": output_list,
                "defaultDeviceId": default_device_id,
                "defaultDeviceType": default_device.get('type', 'input') if default_device else None
            }
            
            self._send_message("audio-devices", device_list)
            
            # Initialize transcriber after devices are loaded (non-blocking)
            if self.transcriber is None and not self._transcriber_initializing:
                def init_transcriber_after_devices():
                    self._init_transcriber()
                threading.Thread(target=init_transcriber_after_devices, daemon=True).start()
        except Exception as e:
            self._send_error(f"Failed to get devices: {e}")
    
    def _format_devices_for_electron(self, devices, cached_data):
        """Format cached devices for Electron frontend"""
        input_list = []
        output_list = []
        
        for device in devices:
            device_name = device.get('name', '')
            device_id = device.get('id')
            device_type = device.get('type', 'input')
            
            if '[Microphone]' in device_name:
                input_list.append({
                    "id": device_id,
                    "name": device_name
                })
            elif '[Speaker Output]' in device_name:
                output_list.append({
                    "id": device_id,
                    "name": device_name
                })
        
        device_list = {
            "input": input_list,
            "output": output_list,
            "defaultDeviceId": cached_data.get('selected_device_id'),
            "defaultDeviceType": cached_data.get('selected_device_type')
        }
        
        self._send_message("audio-devices", device_list)
        
        # Initialize transcriber after devices are loaded (non-blocking)
        if self.transcriber is None and not self._transcriber_initializing:
            def init_transcriber_after_devices():
                self._init_transcriber()
            threading.Thread(target=init_transcriber_after_devices, daemon=True).start()
        
        return device_list
    
    def set_volume_threshold(self, threshold):
        """Set volume threshold"""
        self.volume_threshold = threshold
        config.VOLUME_THRESHOLD = threshold
    
    def set_language(self, language):
        """Set transcription language"""
        self.selected_language = language
        if language != "auto":
            self.language_history = []
            self.current_detected_language = language

def main():
    backend = ElectronBackend()
    
    # Send initial device list FIRST (use cache for fast startup)
    # Transcription service will be initialized automatically after devices are loaded
    backend.get_audio_devices(use_cache=True, force_refresh=False)
    
    # Read commands from stdin
    for line in sys.stdin:
        try:
            command = json.loads(line.strip())
            action = command.get("action")
            
            if action == "start":
                device_id = command.get("deviceId")
                device_type = command.get("deviceType", "input")  # "input" or "output"
                
                # Convert device_id to int if it's a valid string/number, else None
                parsed_device_id = None
                if device_id and device_id != "":
                    try:
                        parsed_device_id = int(device_id)
                    except (ValueError, TypeError):
                        parsed_device_id = None
                
                # If it's an output device, we want loopback from it
                if device_type == "output":
                    backend.start_capture(device_id=None, output_device_id=parsed_device_id)
                else:
                    backend.start_capture(device_id=parsed_device_id, output_device_id=None)
            elif action == "stop":
                backend.stop_capture()
            elif action == "get-devices":
                force_refresh = command.get("forceRefresh", False)
                backend.get_audio_devices(use_cache=not force_refresh, force_refresh=force_refresh)
            elif action == "set-threshold":
                threshold = command.get("threshold")
                backend.set_volume_threshold(threshold)
            elif action == "set-language":
                language = command.get("language")
                backend.set_language(language)
            elif action == "save-device-selection":
                device_id = command.get("deviceId")
                device_type = command.get("deviceType", "input")
                if device_id is not None:
                    backend._save_device_selection(int(device_id), device_type)
        except json.JSONDecodeError:
            continue
        except Exception as e:
            backend._send_error(f"Error processing command: {e}")

if __name__ == "__main__":
    main()

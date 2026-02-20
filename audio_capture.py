"""
System audio capture module using WASAPI loopback for Windows
"""
import sounddevice as sd
import numpy as np
import queue
import threading
from typing import Callable, Optional, List, Dict, Any
import config
from device_cache import load_cache, save_cache, find_stereo_mix_device, find_device_by_id, validate_cached_device


class AudioCapture:
    """Captures audio from system output (what you hear)"""
    
    def __init__(self, callback: Callable[[np.ndarray], None], device_id: Optional[int] = None):
        """
        Initialize audio capture
        
        Args:
            callback: Function to call with audio chunks (numpy array)
            device_id: Audio device ID (None for default loopback device)
        """
        self.callback = callback
        self.device_id = device_id
        self.is_capturing = False
        self.stream = None
        self.audio_queue = queue.Queue()
        
    def _audio_callback(self, indata, frames, time, status):
        """Internal callback for sounddevice stream"""
        if status:
            print(f"Audio status: {status}")
        if self.is_capturing:
            # Convert to mono if stereo
            if indata.shape[1] > 1:
                audio_data = np.mean(indata, axis=1)
            else:
                audio_data = indata[:, 0]
            
            # Debug: Log first few callbacks
            if not hasattr(self, '_callback_count'):
                self._callback_count = 0
            self._callback_count += 1
            if self._callback_count <= 3:
                volume = np.sqrt(np.mean(audio_data ** 2))
                print(f"AudioCapture callback {self._callback_count}: frames={frames}, shape={audio_data.shape}, volume={volume:.6f}")
            
            self.audio_queue.put(audio_data.copy())
    
    def _process_audio(self):
        """Process audio from queue in separate thread"""
        while self.is_capturing:
            try:
                audio_chunk = self.audio_queue.get(timeout=0.1)
                if self.callback:
                    self.callback(audio_chunk)
            except queue.Empty:
                continue
            except Exception as e:
                print(f"Error processing audio: {e}")
    
    def get_loopback_devices(self):
        """Get list of available loopback devices (output device audio)"""
        devices = sd.query_devices()
        loopback_devices = []
        
        # Get host APIs
        hostapis = sd.query_hostapis()
        wasapi_id = None
        for api_id, api_info in enumerate(hostapis):
            if 'WASAPI' in api_info['name']:
                wasapi_id = api_id
                break
        
        # First, collect all output device names for matching
        output_device_names = {}
        for i, device in enumerate(devices):
            if device['max_output_channels'] > 0:
                # Normalize the name for matching (remove common suffixes)
                normalized_name = device['name'].lower().replace(' (high definition audio device)', '')
                output_device_names[normalized_name] = device['name']
        
        # Now find loopback devices (input devices that correspond to output devices)
        for i, device in enumerate(devices):
            device_name = device['name'].lower()
            
            # On Windows with WASAPI, loopback devices are input devices
            # that correspond to output devices
            if device['max_input_channels'] > 0:
                # Check if it's a WASAPI device
                if wasapi_id is not None and device['hostapi'] == wasapi_id:
                    # Method 1: Check if "loopback" is explicitly in the name
                    if 'loopback' in device_name:
                        loopback_devices.append({
                            'id': i,
                            'name': device['name'],
                            'channels': device['max_input_channels'],
                            'type': 'loopback'
                        })
                    # Method 2: Check if this input device name matches an output device name
                    # (loopback devices often have similar names to their output counterparts)
                    else:
                        normalized_input_name = device_name.replace(' (high definition audio device)', '')
                        # Check if there's a matching output device
                        for output_norm_name, output_full_name in output_device_names.items():
                            # If the input device name is similar to an output device name,
                            # it's likely a loopback device
                            if (normalized_input_name in output_norm_name or 
                                output_norm_name in normalized_input_name or
                                normalized_input_name == output_norm_name):
                                # But exclude if it's clearly a microphone (has "microphone" or "mic" in name)
                                if 'microphone' not in device_name and 'mic' not in device_name:
                                    loopback_devices.append({
                                        'id': i,
                                        'name': f"{device['name']} (captures: {output_full_name})",
                                        'channels': device['max_input_channels'],
                                        'type': 'loopback'
                                    })
                                    break
                    # Method 3: If device has both input and output channels, it might be loopback
                    # (but this is less reliable, so we check this last)
                    if device['max_output_channels'] > 0 and device['max_input_channels'] > 0:
                        # Check if we haven't already added it
                        if not any(d['id'] == i for d in loopback_devices):
                            # Exclude microphones
                            if 'microphone' not in device_name and 'mic' not in device_name:
                                loopback_devices.append({
                                    'id': i,
                                    'name': device['name'],
                                    'channels': device['max_input_channels'],
                                    'type': 'loopback'
                                })
        
        # If still no loopback devices found, list all WASAPI input devices
        # (user can try them to see which one works)
        if not loopback_devices and wasapi_id is not None:
            for i, device in enumerate(devices):
                if (device['max_input_channels'] > 0 and 
                    device['hostapi'] == wasapi_id and
                    'microphone' not in device['name'].lower() and
                    'mic' not in device['name'].lower()):
                    loopback_devices.append({
                        'id': i,
                        'name': f"{device['name']} (try this for loopback)",
                        'channels': device['max_input_channels'],
                        'type': 'possible_loopback'
                    })
        
        # If no loopback devices found, try to use default input device
        # (might work if configured as loopback)
        if not loopback_devices:
            default_input = sd.default.device[0]
            if default_input is not None:
                default_device = sd.query_devices(default_input)
                loopback_devices.append({
                    'id': default_input,
                    'name': f"{default_device['name']} (Default - try this)",
                    'channels': default_device['max_input_channels'],
                    'type': 'default'
                })
        
        return loopback_devices
    
    def get_input_devices(self):
        """Get list of available input devices (microphones)"""
        devices = sd.query_devices()
        input_devices = []
        
        # Get host APIs
        hostapis = sd.query_hostapis()
        wasapi_id = None
        for api_id, api_info in enumerate(hostapis):
            if 'WASAPI' in api_info['name']:
                wasapi_id = api_id
                break
        
        for i, device in enumerate(devices):
            device_name = device['name'].lower()
            
            # Input devices have input channels
            if device['max_input_channels'] > 0:
                # Exclude loopback devices
                is_loopback = 'loopback' in device_name
                
                # For WASAPI, also exclude devices that match output device names
                if wasapi_id is not None and device['hostapi'] == wasapi_id:
                    # If it has both input and output channels and no "loopback" in name,
                    # it might still be a headset (include it)
                    if not is_loopback:
                        input_devices.append({
                            'id': i,
                            'name': device['name'],
                            'channels': device['max_input_channels'],
                            'type': 'input'
                        })
                else:
                    # For non-WASAPI, include if not explicitly loopback
                    if not is_loopback:
                        input_devices.append({
                            'id': i,
                            'name': device['name'],
                            'channels': device['max_input_channels'],
                            'type': 'input'
                        })
        
        return input_devices
    
    def get_all_audio_devices(self, use_cache: bool = True):
        """Get list of all available audio devices (both input and loopback)
        
        Args:
            use_cache: If True, try to load from cache first. If cache is invalid, refresh.
        """
        if use_cache:
            cached_data = load_cache()
            if cached_data and cached_data.get('devices'):
                # Return cached devices immediately without validation for fast startup
                # Validation will happen when user tries to use the device
                print(f"AudioCapture: Using cached devices (count: {len(cached_data['devices'])})")
                return cached_data['devices']
        
        # Cache miss or invalid - refresh devices
        return self._refresh_all_audio_devices()
    
    def _refresh_all_audio_devices(self):
        """Refresh and return list of all available audio devices (both input and loopback)"""
        input_devices = self.get_input_devices()
        loopback_devices = self.get_loopback_devices()
        
        all_devices = []
        
        # Add input devices with label
        for device in input_devices:
            all_devices.append({
                **device,
                'name': f"[Microphone] {device['name']}"
            })
        
        # Add loopback devices with label
        for device in loopback_devices:
            all_devices.append({
                **device,
                'name': f"[Speaker Output] {device['name']}"
            })
        
        return all_devices
    
    def get_all_audio_devices_fresh(self):
        """Get fresh list of all available audio devices (force refresh, no cache)"""
        return self._refresh_all_audio_devices()
    
    def validate_and_get_default_device(self, devices: List[Dict[str, Any]], 
                                        cached_device_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Validate cached device and return default device selection
        
        Returns:
            Device dict if valid cached device found, or stereo mix device, or first device, or None
        """
        # First, try to find and validate cached device
        if cached_device_id is not None:
            cached_device = find_device_by_id(devices, cached_device_id)
            if cached_device:
                return cached_device
        
        # If no cached device or cached device unavailable, try stereo mix
        stereo_mix = find_stereo_mix_device(devices)
        if stereo_mix:
            return stereo_mix
        
        # Fallback to first device
        if devices:
            return devices[0]
        
        return None
    
    def start(self):
        """Start capturing audio"""
        if self.is_capturing:
            return
        
        try:
            # Find loopback device if not specified
            if self.device_id is None:
                devices = self.get_loopback_devices()
                if devices:
                    self.device_id = devices[0]['id']
                else:
                    # Use default input device (may work if configured as loopback)
                    self.device_id = sd.default.device[0]
                    if self.device_id is None:
                        raise RuntimeError("No audio input device found. Please configure a loopback device.")
            
            # Open audio stream (as input stream for loopback)
            self.stream = sd.InputStream(
                device=self.device_id,
                channels=config.CHANNELS,
                samplerate=config.SAMPLE_RATE,
                blocksize=config.CHUNK_SIZE,
                callback=self._audio_callback,
                dtype=np.float32
            )
            
            self.is_capturing = True
            self.stream.start()
            
            # Start processing thread
            self.process_thread = threading.Thread(target=self._process_audio, daemon=True)
            self.process_thread.start()
            
            print(f"Audio capture started on device {self.device_id}")
            
        except Exception as e:
            print(f"Error starting audio capture: {e}")
            raise
    
    def stop(self):
        """Stop capturing audio"""
        self.is_capturing = False
        
        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None
        
        print("Audio capture stopped")
    
    def is_active(self):
        """Check if capture is active"""
        return self.is_capturing and self.stream is not None and self.stream.active

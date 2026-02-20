"""
Device cache module for caching audio device lists and selections
"""
import json
import os
from pathlib import Path
from typing import Optional, Dict, List, Any


CACHE_FILE = Path(__file__).parent / "device_cache.json"


def load_cache() -> Optional[Dict[str, Any]]:
    """Load device cache from file"""
    if not CACHE_FILE.exists():
        print(f"Device cache file not found: {CACHE_FILE}")
        return None
    
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            device_count = len(data.get('devices', []))
            print(f"Loaded device cache: {device_count} devices, selected device ID: {data.get('selected_device_id')}")
            return data
    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: Failed to load device cache: {e}")
        return None


def save_cache(devices: List[Dict[str, Any]], selected_device_id: Optional[int] = None, 
               selected_device_type: Optional[str] = None, selected_device_name: Optional[str] = None):
    """Save device cache to file"""
    cache_data = {
        "devices": devices,
        "selected_device_id": selected_device_id,
        "selected_device_type": selected_device_type,
        "selected_device_name": selected_device_name
    }
    
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache_data, f, indent=2)
        print(f"Saved device cache to {CACHE_FILE}: {len(devices)} devices, selected: {selected_device_id}")
    except IOError as e:
        print(f"Warning: Failed to save device cache: {e}")


def find_stereo_mix_device(devices: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Find a device with 'stereo mix' in the name (case-insensitive)"""
    for device in devices:
        device_name = device.get('name', '').lower()
        if 'stereo mix' in device_name:
            return device
    return None


def find_device_by_id(devices: List[Dict[str, Any]], device_id: int) -> Optional[Dict[str, Any]]:
    """Find a device by its ID in the cached list"""
    for device in devices:
        if device.get('id') == device_id:
            return device
    return None


def validate_cached_device(devices: List[Dict[str, Any]], cached_device_id: int) -> bool:
    """Check if a cached device ID is still available in the current device list"""
    return find_device_by_id(devices, cached_device_id) is not None

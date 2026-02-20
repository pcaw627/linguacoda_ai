"""
Diagnostic script to list all available audio devices
Run this to see what devices are detected on your system
"""
import sounddevice as sd
from audio_capture import AudioCapture

def list_all_devices():
    """List all devices that sounddevice can see"""
    print("=" * 80)
    print("ALL AUDIO DEVICES (from sounddevice)")
    print("=" * 80)
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    
    for i, device in enumerate(devices):
        hostapi_name = hostapis[device['hostapi']]['name'] if device['hostapi'] < len(hostapis) else 'Unknown'
        print(f"\nDevice {i}: {device['name']}")
        print(f"  Host API: {hostapi_name}")
        print(f"  Input Channels: {device['max_input_channels']}")
        print(f"  Output Channels: {device['max_output_channels']}")
        print(f"  Default Sample Rate: {device['default_samplerate']}")
    
    print("\n" + "=" * 80)
    print("DETECTED INPUT DEVICES (Microphones)")
    print("=" * 80)
    capture = AudioCapture(lambda x: None)
    input_devices = capture.get_input_devices()
    for device in input_devices:
        print(f"  ID {device['id']}: {device['name']} ({device['channels']} channels)")
    
    if not input_devices:
        print("  No input devices detected!")
    
    print("\n" + "=" * 80)
    print("DETECTED LOOPBACK DEVICES (Speaker Output)")
    print("=" * 80)
    loopback_devices = capture.get_loopback_devices()
    for device in loopback_devices:
        print(f"  ID {device['id']}: {device['name']} ({device['channels']} channels)")
    
    if not loopback_devices:
        print("  No loopback devices detected!")
        print("\n  This might mean:")
        print("  - Your system doesn't expose WASAPI loopback devices")
        print("  - You need to enable 'Stereo Mix' or similar in Windows sound settings")
        print("  - Try using a virtual audio cable or similar software")
    
    print("\n" + "=" * 80)
    print("ALL AVAILABLE DEVICES (Combined)")
    print("=" * 80)
    all_devices = capture.get_all_audio_devices()
    for device in all_devices:
        print(f"  ID {device['id']}: {device['name']} ({device['channels']} channels)")
    
    if not all_devices:
        print("  No devices detected at all!")
    
    print("\n" + "=" * 80)
    print("DEFAULT DEVICES")
    print("=" * 80)
    default_input = sd.default.device[0]
    default_output = sd.default.device[1]
    if default_input is not None:
        default_input_device = sd.query_devices(default_input)
        print(f"Default Input: {default_input_device['name']} (ID: {default_input})")
    if default_output is not None:
        default_output_device = sd.query_devices(default_output)
        print(f"Default Output: {default_output_device['name']} (ID: {default_output})")

if __name__ == "__main__":
    try:
        list_all_devices()
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

"""
Setup verification script
Run this to check if all dependencies are properly installed
"""
import sys


def check_import(module_name, package_name=None):
    """Check if a module can be imported"""
    try:
        __import__(module_name)
        print(f"✓ {package_name or module_name} is installed")
        return True
    except ImportError:
        print(f"✗ {package_name or module_name} is NOT installed")
        return False


def main():
    """Check all dependencies"""
    print("Checking dependencies...\n")
    
    all_ok = True
    
    # Core dependencies
    all_ok &= check_import("numpy", "numpy")
    all_ok &= check_import("sounddevice", "sounddevice")
    all_ok &= check_import("soundfile", "soundfile")
    all_ok &= check_import("requests", "requests")
    
    # SenseVoice dependencies
    print("\nChecking SenseVoice dependencies...")
    all_ok &= check_import("funasr", "funasr")
    all_ok &= check_import("modelscope", "modelscope")
    
    # Check if SenseVoice repo is available
    print("\nChecking SenseVoice repository...")
    from pathlib import Path
    current_dir = Path(__file__).parent
    sensevoice_path = current_dir / "SenseVoice"
    if sensevoice_path.exists() and (sensevoice_path / "model.py").exists():
        print(f"✓ SenseVoice repository found at: {sensevoice_path}")
    else:
        print("⚠ SenseVoice repository not found locally")
        print("  The app will download models from ModelScope/HuggingFace")
        print("  To use local repo, clone it to: ./SenseVoice/")
    
    # GUI (tkinter comes with Python)
    print("\nChecking GUI...")
    try:
        import tkinter
        print("✓ tkinter is available")
    except ImportError:
        print("✗ tkinter is NOT available (should come with Python)")
        all_ok = False
    
    # Ollama check
    print("\nChecking Ollama connection...")
    try:
        import requests
        response = requests.get("http://127.0.0.1:11434/api/tags", timeout=2)
        if response.status_code == 200:
            print("✓ Ollama is running and accessible")
        else:
            print("✗ Ollama returned unexpected status code")
            all_ok = False
    except requests.exceptions.ConnectionError:
        print("✗ Ollama is NOT running or not accessible")
        print("  Make sure Ollama is running: ollama serve")
        all_ok = False
    except Exception as e:
        print(f"✗ Error checking Ollama: {e}")
        all_ok = False
    
    print("\n" + "="*50)
    if all_ok:
        print("✓ All checks passed! You're ready to run the app.")
    else:
        print("✗ Some checks failed. Please install missing dependencies.")
        print("\nInstall missing packages with:")
        print("  pip install -r requirements.txt")
    print("="*50)
    
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

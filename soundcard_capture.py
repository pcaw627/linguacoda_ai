"""
WASAPI loopback capture via the soundcard library.

PortAudio (used by sounddevice) does not expose Windows WASAPI loopback alias
devices in its standard build, so capturing "what you hear" through it either
falls back to hardware mixers like Stereo Mix or — worse — silently grabs an
unrelated input device (e.g. a Bluetooth HFP mic), which forces Windows to
switch the headset to the low-quality call profile and mutes playback.

The soundcard library uses WASAPI directly and can open a render endpoint with
the loopback flag. That captures the exact stream being sent to the speakers
without taking ownership of the device, so audio keeps playing normally.
"""
from __future__ import annotations

import sys
import threading
import warnings
from typing import Callable, List, Dict, Any, Optional

import numpy as np
import soundcard as sc
from soundcard.mediafoundation import SoundcardRuntimeWarning

import config


warnings.filterwarnings(
    "ignore",
    message="data discontinuity in recording",
    category=SoundcardRuntimeWarning,
)


_COINIT_MULTITHREADED = 0x0
# S_OK (0) and S_FALSE (1, already initialised) both mean "good to go".
# RPC_E_CHANGED_MODE (0x80010106) means another COM mode is active on this
# thread — usually fine because it stays initialised either way.
_COM_OK_HRESULTS = (0x00000000, 0x00000001, -2147417850)  # last == 0x80010106 signed


def _coinitialize_thread() -> Optional[object]:
    """Ensure COM is initialised on the current thread.
    
    Soundcard uses WASAPI/MediaFoundation, which is a COM API. Background
    threads must call CoInitializeEx before any WASAPI calls or they get
    CO_E_NOTINITIALIZED (0x800401F0). Returns the ole32 handle so the caller
    can pair it with CoUninitialize.
    """
    if not sys.platform.startswith("win"):
        return None
    import ctypes
    ole32 = ctypes.windll.ole32
    hr = ole32.CoInitializeEx(None, _COINIT_MULTITHREADED)
    if hr not in _COM_OK_HRESULTS:
        print(f"CoInitializeEx returned unexpected HRESULT 0x{hr & 0xFFFFFFFF:08x}")
    return ole32


def list_output_endpoints() -> List[Dict[str, Any]]:
    """Return all Windows output endpoints suitable for loopback capture."""
    endpoints: List[Dict[str, Any]] = []
    try:
        default_id: Optional[str] = sc.default_speaker().id
    except Exception:
        default_id = None

    for sp in sc.all_speakers():
        endpoints.append({
            "id": sp.id,
            "name": sp.name,
            "channels": sp.channels,
            "type": "output",
            "is_default": sp.id == default_id,
        })
    return endpoints


class SoundcardLoopbackCapture:
    """Captures the render stream of a Windows output endpoint.

    The interface mirrors `AudioCapture` (start/stop/is_active) so the rest of
    the backend can swap implementations based on device type.
    """

    def __init__(self, callback: Callable[[np.ndarray], None], device_id: str):
        self.callback = callback
        self.device_id = device_id
        self.is_capturing = False
        self._thread: Optional[threading.Thread] = None
        self._error: Optional[Exception] = None

    def _resolve_microphone(self):
        try:
            return sc.get_microphone(self.device_id, include_loopback=True)
        except (IndexError, RuntimeError):
            for mic in sc.all_microphones(include_loopback=True):
                if mic.id == self.device_id and mic.isloopback:
                    return mic
            raise RuntimeError(
                f"No loopback endpoint found for device id {self.device_id!r}"
            )

    def _record_loop(self, mic) -> None:
        ole32 = _coinitialize_thread()
        try:
            with mic.recorder(
                samplerate=config.SAMPLE_RATE,
                channels=1,
                blocksize=config.CHUNK_SIZE,
            ) as recorder:
                while self.is_capturing:
                    data = recorder.record(numframes=config.CHUNK_SIZE)
                    if not self.is_capturing:
                        break
                    if data.ndim > 1:
                        if data.shape[1] > 1:
                            chunk = np.mean(data, axis=1)
                        else:
                            chunk = data[:, 0]
                    else:
                        chunk = data
                    chunk = np.ascontiguousarray(chunk, dtype=np.float32)
                    try:
                        self.callback(chunk)
                    except Exception as cb_err:
                        print(f"Loopback callback error: {cb_err}")
        except Exception as e:
            self._error = e
            print(f"Soundcard loopback recording error: {e}")
        finally:
            self.is_capturing = False
            if ole32 is not None:
                try:
                    ole32.CoUninitialize()
                except Exception:
                    pass

    def start(self) -> None:
        if self.is_capturing:
            return
        mic = self._resolve_microphone()
        self.is_capturing = True
        self._error = None
        self._thread = threading.Thread(
            target=self._record_loop, args=(mic,), daemon=True
        )
        self._thread.start()
        print(f"Soundcard loopback capture started on {mic.name}")

    def stop(self) -> None:
        if not self.is_capturing and self._thread is None:
            return
        self.is_capturing = False
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=1.5)
        print("Soundcard loopback capture stopped")

    def is_active(self) -> bool:
        return self.is_capturing and self._thread is not None and self._thread.is_alive()

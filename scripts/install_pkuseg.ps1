# ─────────────────────────────────────────────────────────────────────────────
# install_pkuseg.ps1
#
# Build & install pkuseg (and the rest of the alignment runtime) on
# Windows + modern Python (3.10+).
#
# Why this script exists
# ──────────────────────
# pkuseg's PyPI sdist ships *pre-generated* Cython C++ files (the .cpp next
# to each .pyx). Those .cpp were emitted by a very old Cython and reference
# CPython C-API symbols that were removed in 3.10. There are no Windows
# wheels for Python 3.10+ on PyPI, so plain `pip install pkuseg` falls back
# to source and fails at compile time with errors like
# `'_PyOpaque_TupleOrList_*'` or `'PyThreadState_GetUnchecked'`.
#
# How this script fixes it
# ────────────────────────
# pkuseg's setup.py already has a code path that *cythonizes the .pyx files*
# instead of using the stale .cpp — but only if `Cython.Distutils` is
# importable when setup.py runs. With pip's default build isolation, pip
# spins up a clean build venv that doesn't include Cython, so setup.py
# silently picks the broken .cpp path. The fix is:
#
#   1. Install a modern Cython + numpy directly into the *current* env
#      (the env pkuseg will actually run in).
#   2. Force a source build (no wheel) with `--no-binary`.
#   3. Tell pip to skip build isolation (`--no-build-isolation`) so
#      setup.py sees our just-installed Cython and regenerates fresh .cpp
#      from the .pyx files.
#
# Also installed here
# ───────────────────
#   - simalign
#   - transformers<4.41
#   - sentencepiece
#
# Why pin Transformers: recent Transformers releases assume newer Torch
# APIs such as `torch.library.register_fake`. The FunASR/SenseVoice stack
# on Windows can leave you with an older Torch where that attribute does
# not exist, which makes SimAlign fail while importing BERT/XLM-R.
# Pinning Transformers below those releases is the least invasive fix;
# it avoids a huge Torch reinstall.
#
# Prereqs (one-time, manual)
# ──────────────────────────
#   - Microsoft C++ Build Tools (MSVC 14.x). Install via "Visual Studio
#     Installer" → "Desktop development with C++" workload, or:
#         winget install Microsoft.VisualStudio.2022.BuildTools
#     then enable the "MSVC v143 - VS 2022 C++ x64/x86 build tools" component.
#   - The target conda env must be *activated in the current PowerShell
#     session* so plain `python` resolves to the interpreter you want to
#     install into. The script installs into whatever `python` resolves
#     to on PATH after activation; it does NOT require the env to bundle
#     its own python (some conda envs — including `livesub` here — just
#     shadow env vars while `python` keeps pointing at the system one).
#
# Usage
# ─────
# Run it in-process from your already-activated PowerShell session:
#
#     conda activate livesub
#     .\scripts\install_pkuseg.ps1
#
# Do NOT invoke as `powershell -File scripts\install_pkuseg.ps1` — that
# spawns a fresh PowerShell process which does NOT inherit your conda
# activation, so the install lands in the wrong env (usually `base`).
# This script aborts if it detects that situation.
#
# If you really do want to install into `base`, pass `-AllowBaseEnv`.
# ─────────────────────────────────────────────────────────────────────────────

[CmdletBinding()]
param(
    [switch] $AllowBaseEnv
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) {
    Write-Host "`n[install_pkuseg] $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Host "[install_pkuseg] $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host "[install_pkuseg] WARNING: $msg" -ForegroundColor Yellow
}
function Fail($msg) {
    Write-Host "`n[install_pkuseg] ERROR: $msg" -ForegroundColor Red
    exit 1
}

# ── 1. Verify we're in the intended conda env ────────────────────────────────
#
# This script is most commonly run after `conda activate <env>`. The most
# painful failure mode is when the user runs it via `powershell -File ...`,
# which spawns a fresh shell that DOESN'T inherit the parent's conda
# activation — pip then installs into `base` and the actual app (running
# in some other env) sees nothing change. We refuse to proceed in that case
# unless -AllowBaseEnv is passed.

$condaEnv    = $env:CONDA_DEFAULT_ENV
$condaPrefix = $env:CONDA_PREFIX

if (-not $condaPrefix) {
    Fail @"
CONDA_PREFIX is not set in this shell. Either:
  1. Activate the target env first, then re-run in-process:
       conda activate livesub
       .\scripts\install_pkuseg.ps1
  2. Or, if you genuinely don't use conda, edit this script to remove
     the env check below.
"@
}

if (-not $AllowBaseEnv -and $condaEnv -eq 'base') {
    Fail @"
You're in the conda 'base' env. Almost certainly NOT what you want — the
LinguaCoda app runs in your project env (e.g. 'livesub'), so installing
pkuseg into base would leave the runtime env untouched.

Fix:
  conda activate livesub      # or whatever env the app runs in
  .\scripts\install_pkuseg.ps1

If you really want to install into base, re-run with -AllowBaseEnv.

(Did you invoke this as ``powershell -File scripts\install_pkuseg.ps1``?
 That spawns a fresh shell and drops the parent's conda activation.
 Run it in-process instead: ``.\scripts\install_pkuseg.ps1``.)
"@
}

# ── 2. Resolve python via PATH, then verify it's inside CONDA_PREFIX ─────────
#
# We can't just assume `<CONDA_PREFIX>\python.exe` exists — different env
# layouts (e.g. envs created with `--copy`, or with non-standard backends)
# may put python in Scripts\ or elsewhere. Instead, discover the python
# the activated shell has on PATH, then verify it lives inside CONDA_PREFIX
# (so we know `pip install` will land in the activated env, not some other
# Python on PATH).

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Fail "No 'python' on PATH. Activate the target env first, then re-run."
}
$pythonExe = $pythonCmd.Source

# Ask the interpreter itself where it lives, so we resolve symlinks etc.
$resolvedExe = (& $pythonExe -c "import sys; print(sys.executable)").Trim()
if (-not $resolvedExe -or -not (Test-Path $resolvedExe)) {
    Fail "Couldn't resolve sys.executable from $pythonExe."
}
$pythonExe = $resolvedExe

# Suppress per-user site-packages during this script so installs go strictly
# into the env's site-packages, not into $env:APPDATA\Python\Python3xx — which
# is shared across every same-version Python on the machine and is a common
# source of "I upgraded transformers but the app still sees the old one".
$env:PYTHONNOUSERSITE = '1'

Write-Step "Using interpreter (the one your activated shell has on PATH):"
$pyInfoJson = & $pythonExe -c "import json, os, site, sys; print(json.dumps({'executable': sys.executable, 'version': sys.version, 'prefix': sys.prefix, 'site_packages': [p for p in sys.path if p.endswith('site-packages')], 'conda_prefix': os.environ.get('CONDA_PREFIX'), 'conda_default_env': os.environ.get('CONDA_DEFAULT_ENV'), 'user_site': site.getusersitepackages(), 'user_site_enabled': site.ENABLE_USER_SITE}))"
$pyInfo = $pyInfoJson | ConvertFrom-Json
Write-Host "  python            = $($pyInfo.executable)"
Write-Host "  version           = $($pyInfo.version)"
Write-Host "  sys.prefix        = $($pyInfo.prefix)"
Write-Host "  CONDA_DEFAULT_ENV = $($pyInfo.conda_default_env)"
Write-Host "  CONDA_PREFIX      = $($pyInfo.conda_prefix)"
Write-Host "  user site         = $($pyInfo.user_site) (enabled=$($pyInfo.user_site_enabled); suppressed for this script via PYTHONNOUSERSITE)"
Write-Host "  install target(s) =" -NoNewline
foreach ($p in $pyInfo.site_packages) {
    Write-Host ""
    Write-Host "      $p"
}

# NOTE: we deliberately do NOT check that python lives inside CONDA_PREFIX.
# In this repo, `livesub` is a conda env that doesn't bundle its own Python —
# `conda activate livesub` just shadows env vars while plain `python` keeps
# resolving to the system interpreter. That system interpreter IS the one
# the LinguaCoda app actually uses, so it's also where pkuseg + SimAlign
# need to land. The base-env guard above is the only safety rail we need.

Write-Step "Python resolution order on PATH (for reference):"
where.exe python | ForEach-Object { Write-Host "  $_" }

# ── 3. Install alignment runtime pins ────────────────────────────────────────
Write-Step "Installing alignment runtime pins (SimAlign + compatible Transformers)..."
# Keep Transformers below releases that require newer torch.library APIs such
# as register_fake. This fixes SimAlign import failures without replacing the
# Torch version installed by the speech stack.
& $pythonExe -m pip install --upgrade "simalign>=0.4" "transformers>=4.20,<4.41" "sentencepiece>=0.1.99"
if ($LASTEXITCODE -ne 0) { Fail "alignment-runtime install failed (exit $LASTEXITCODE)" }

# ── 4. Install pkuseg build prereqs ──────────────────────────────────────────
Write-Step "Installing pkuseg build prerequisites (Cython + numpy) into the current env..."
# Cython is pinned <3.1 because pkuseg's .pyx files predate Cython 3 strict
# mode and a couple of constructs (e.g. implicit `noexcept`) trip warnings
# that 3.1+ may promote to errors. 0.29.x and 3.0.x are both fine.
# numpy is pinned <2 to keep pkuseg's built C ABI compatible with the rest
# of the env (funasr / torch / etc. still expect numpy 1.x).
& $pythonExe -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { Fail "pip/setuptools/wheel upgrade failed (exit $LASTEXITCODE)" }
& $pythonExe -m pip install --upgrade "cython>=0.29,<3.1" "numpy<2"
if ($LASTEXITCODE -ne 0) { Fail "Cython/numpy install failed (exit $LASTEXITCODE)" }

# ── 5. Build & install pkuseg from source ────────────────────────────────────
Write-Step "Installing pkuseg from source (no wheel, no build isolation)..."
# --no-binary=pkuseg : force pip to use the sdist (skip any precompiled
#                     wheel that might be linked against an old Python ABI).
# --no-build-isolation : let setup.py see our just-installed Cython so it
#                     regenerates fresh .cpp from the .pyx files instead of
#                     compiling the stale bundled .cpp.
& $pythonExe -m pip install --no-build-isolation --no-binary=pkuseg pkuseg
if ($LASTEXITCODE -ne 0) {
    Fail @"
pkuseg build failed (exit $LASTEXITCODE).

Most common causes on Windows:
  - MSVC C++ Build Tools are not installed. Look for "Microsoft Visual
    C++ 14.0 is required" in the output above.
      winget install Microsoft.VisualStudio.2022.BuildTools
    Then run "Visual Studio Installer" and enable
      "Desktop development with C++"
  - Cython 3.1+ strict-mode error in a .pyx file. Re-run after:
      & $pythonExe -m pip install "cython==0.29.37"
  - numpy 2.x ABI mismatch. Re-run after:
      & $pythonExe -m pip install "numpy<2"
"@
}

# ── 6. Verify everything imports against the env's runtime ───────────────────
Write-Step "Verifying pkuseg import + tiny segmentation..."
& $pythonExe -c "import pkuseg; seg = pkuseg.pkuseg(); print('  pkuseg OK ->', seg.cut('我爱北京天安门'))"
if ($LASTEXITCODE -ne 0) { Fail "pkuseg import verification failed (exit $LASTEXITCODE)" }

Write-Step "Verifying SimAlign + Transformers + Torch against this env..."
# Print versions and try the full SimAlign import path so a Torch/Transformers
# mismatch (e.g. missing torch.library.register_fake) surfaces here rather
# than later inside the running transcription server.
& $pythonExe -c @"
import torch, transformers
print('  torch        =', torch.__version__)
print('  transformers =', transformers.__version__)
print('  torch.library.register_fake exists =', hasattr(torch.library, 'register_fake'))
import simalign
print('  simalign OK')
from transformers import AutoTokenizer
print('  transformers.models.bert import OK')
"@
if ($LASTEXITCODE -ne 0) {
    Fail @"
SimAlign verification failed (exit $LASTEXITCODE).

If the traceback mentions `module 'torch.library' has no attribute
'register_fake'`, your Torch is older than the installed Transformers
expects. Options (pick one):

  1. Downgrade Transformers further:
       & $pythonExe -m pip install "transformers==4.35.2"
  2. Upgrade Torch (heavier, may conflict with FunASR):
       & $pythonExe -m pip install --upgrade "torch>=2.4"

After either fix, re-run this script.
"@
}

Write-Step "Where the new packages landed:"
& $pythonExe -m pip show pkuseg   2>$null | Select-String '^(Name|Version|Location):' | ForEach-Object { Write-Host "  $_" }
& $pythonExe -m pip show simalign 2>$null | Select-String '^(Name|Version|Location):' | ForEach-Object { Write-Host "  $_" }
& $pythonExe -m pip show transformers 2>$null | Select-String '^(Name|Version|Location):' | ForEach-Object { Write-Host "  $_" }

Write-Ok "Done. pkuseg + SimAlign are installed and importable in this env."
Write-Host "[install_pkuseg] Restart the LinguaCoda app to pick up the changes." -ForegroundColor Green

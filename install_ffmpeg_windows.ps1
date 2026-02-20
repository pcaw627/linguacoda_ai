# PowerShell script to help install ffmpeg on Windows
# Run this script as Administrator for automatic installation

Write-Host "FFmpeg Installation Helper for Windows" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Note: Some installation methods require Administrator privileges" -ForegroundColor Yellow
    Write-Host ""
}

# Method 1: Try winget (Windows 10/11)
Write-Host "Method 1: Trying winget..." -ForegroundColor Green
if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "winget found! Installing ffmpeg..." -ForegroundColor Green
    try {
        winget install ffmpeg
        Write-Host "✓ FFmpeg installed successfully via winget!" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "✗ Installation via winget failed: $_" -ForegroundColor Red
    }
} else {
    Write-Host "✗ winget not found" -ForegroundColor Yellow
}

Write-Host ""

# Method 2: Try Chocolatey
Write-Host "Method 2: Trying Chocolatey..." -ForegroundColor Green
if (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Host "Chocolatey found! Installing ffmpeg..." -ForegroundColor Green
    try {
        choco install ffmpeg -y
        Write-Host "✓ FFmpeg installed successfully via Chocolatey!" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "✗ Installation via Chocolatey failed: $_" -ForegroundColor Red
    }
} else {
    Write-Host "✗ Chocolatey not found" -ForegroundColor Yellow
}

Write-Host ""

# Method 3: Try Scoop
Write-Host "Method 3: Trying Scoop..." -ForegroundColor Green
if (Get-Command scoop -ErrorAction SilentlyContinue) {
    Write-Host "Scoop found! Installing ffmpeg..." -ForegroundColor Green
    try {
        scoop install ffmpeg
        Write-Host "✓ FFmpeg installed successfully via Scoop!" -ForegroundColor Green
        exit 0
    } catch {
        Write-Host "✗ Installation via Scoop failed: $_" -ForegroundColor Red
    }
} else {
    Write-Host "✗ Scoop not found" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "No package manager found or installation failed." -ForegroundColor Yellow
Write-Host ""
Write-Host "Manual installation options:" -ForegroundColor Cyan
Write-Host "1. Download from: https://ffmpeg.org/download.html" -ForegroundColor White
Write-Host "2. Extract the zip file" -ForegroundColor White
Write-Host "3. Add the 'bin' folder to your system PATH" -ForegroundColor White
Write-Host ""
Write-Host "Or use conda (if you have Anaconda/Miniconda):" -ForegroundColor Cyan
Write-Host "  conda install -c conda-forge ffmpeg" -ForegroundColor White
Write-Host ""
Write-Host "Note: FFmpeg is optional - the app works without it using torchaudio." -ForegroundColor Yellow

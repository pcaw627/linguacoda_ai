"""
Standalone transcription server
Runs as a separate process and handles transcription requests via HTTP API
"""
import sys
import os
import json
import base64
import secrets
import threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import numpy as np
from sensevoice_transcriber import SenseVoiceTranscriber
import config

# Server configuration
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8765
TOKEN_FILE = Path(__file__).parent / ".transcription_server.token"

# Global transcriber instance
transcriber = None
transcriber_lock = threading.Lock()


def get_or_create_token():
    """Get existing token or create a new one"""
    if TOKEN_FILE.exists():
        with open(TOKEN_FILE, 'r') as f:
            token = f.read().strip()
            if token:
                return token
    
    # Generate new token
    token = secrets.token_urlsafe(32)
    with open(TOKEN_FILE, 'w') as f:
        f.write(token)
    return token


def init_transcriber():
    """Initialize the transcription service"""
    global transcriber
    with transcriber_lock:
        if transcriber is None:
            print("Initializing transcription service...", file=sys.stderr, flush=True)
            try:
                transcriber = SenseVoiceTranscriber()
                print("Transcription service ready", file=sys.stderr, flush=True)
            except Exception as e:
                print(f"Failed to initialize transcription: {e}", file=sys.stderr, flush=True)
                import traceback
                traceback.print_exc(file=sys.stderr)
                raise
    return transcriber


class TranscriptionHandler(BaseHTTPRequestHandler):
    """HTTP request handler for transcription API"""
    
    def log_message(self, format, *args):
        """Override to send logs to stderr"""
        message = format % args
        print(f"[TranscriptionServer] {message}", file=sys.stderr, flush=True)
    
    def do_GET(self):
        """Handle GET requests (health check)"""
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                "status": "ok",
                "ready": transcriber is not None and transcriber.is_ready() if transcriber else False
            }
            self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        """Handle POST requests (transcription)"""
        # Check authentication
        auth_header = self.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode())
            return
        
        token = auth_header[7:]  # Remove 'Bearer ' prefix
        expected_token = get_or_create_token()
        
        if token != expected_token:
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid token"}).encode())
            return
        
        # Parse request
        if self.path == '/transcribe':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length == 0:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No data provided"}).encode())
                    return
                
                body = self.rfile.read(content_length)
                request_data = json.loads(body.decode('utf-8'))
                
                # Decode audio data
                audio_b64 = request_data.get('audio')
                if not audio_b64:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No audio data provided"}).encode())
                    return
                
                audio_bytes = base64.b64decode(audio_b64)
                audio_data = np.frombuffer(audio_bytes, dtype=np.float32)
                
                language = request_data.get('language', 'auto')
                
                # Initialize transcriber if needed
                if transcriber is None:
                    init_transcriber()
                
                # Wait for transcriber to be ready
                if not transcriber.is_ready():
                    # Try to wait a bit
                    import time
                    for _ in range(10):
                        time.sleep(0.1)
                        if transcriber.is_ready():
                            break
                    
                    if not transcriber.is_ready():
                        self.send_response(503)
                        self.send_header('Content-Type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({"error": "Transcription service not ready"}).encode())
                        return
                
                # Transcribe
                transcription, detected_lang = transcriber.transcribe(audio_data, language)
                
                # Send response
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {
                    "transcription": transcription,
                    "detectedLang": detected_lang
                }
                self.wfile.write(json.dumps(response).encode())
                
            except Exception as e:
                print(f"Transcription error: {e}", file=sys.stderr, flush=True)
                import traceback
                traceback.print_exc(file=sys.stderr)
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()


def main():
    """Main server entry point"""
    # Print token to stdout so parent process can read it
    token = get_or_create_token()
    print(f"TRANSCRIPTION_SERVER_TOKEN={token}", file=sys.stdout, flush=True)
    print(f"Transcription server starting on {SERVER_HOST}:{SERVER_PORT}", file=sys.stderr, flush=True)
    
    # Initialize transcriber in background
    def init_in_background():
        try:
            init_transcriber()
        except Exception as e:
            print(f"Background initialization failed: {e}", file=sys.stderr, flush=True)
    
    threading.Thread(target=init_in_background, daemon=True).start()
    
    # Start HTTP server
    try:
        server = HTTPServer((SERVER_HOST, SERVER_PORT), TranscriptionHandler)
    except OSError as e:
        if e.errno == 10048 or "Address already in use" in str(e) or "address already in use" in str(e).lower():
            print(f"Port {SERVER_PORT} is already in use. Another transcription server may be running.", file=sys.stderr, flush=True)
            print("If you want to use this server instance, please stop the other one first.", file=sys.stderr, flush=True)
            # Exit with code 0 to indicate this is expected (server already running)
            sys.exit(0)
        else:
            print(f"Failed to bind to {SERVER_HOST}:{SERVER_PORT}: {e}", file=sys.stderr, flush=True)
            sys.exit(1)
    
    try:
        print(f"Transcription server running on http://{SERVER_HOST}:{SERVER_PORT}", file=sys.stderr, flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down transcription server...", file=sys.stderr, flush=True)
        server.shutdown()
    except Exception as e:
        print(f"Server error: {e}", file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

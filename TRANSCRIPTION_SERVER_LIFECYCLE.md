# Transcription Server Lifecycle

## When the Transcription Server Stops

The transcription server will stop running under the following conditions:

1. **App Closes Normally**
   - When the Electron app closes (all windows closed)
   - The app only kills the server if it started it (has a process handle)
   - If another instance started the server, it will continue running

2. **Server Crashes**
   - If the server process encounters an unhandled exception
   - If the server process is killed externally (Task Manager, etc.)
   - The app will detect this and attempt to restart the server after 2 seconds

3. **Port Already in Use**
   - If port 8765 is already in use when trying to start the server
   - The server will exit with code 0 (normal exit)
   - The app will detect that another server is running and connect to it instead

4. **Manual Termination**
   - If you manually kill the server process
   - The app will detect the crash and attempt to restart it

## How Reconnection Works

The app uses a **health check-based approach** to ensure it connects to an existing server rather than spawning a new one:

### 1. **On App Startup**
   - The app first checks if a server is running via HTTP health check (`/health` endpoint)
   - If server is running → connects to existing instance (no new process spawned)
   - If server is not running → starts a new server instance

### 2. **Before Starting Server**
   - `startTranscriptionServer()` always performs a health check first
   - This prevents spawning duplicate servers even if:
     - Another app instance started the server
     - Server was started manually
     - Process handle was lost but server is still running

### 3. **Server Crash Recovery**
   - If the server crashes (non-zero exit code), the app:
     1. Waits 2 seconds
     2. Checks if server is running (maybe another instance restarted it)
     3. If not running, starts a new instance
     4. If running, connects to the existing instance

### 4. **Port Conflict Handling**
   - If the server can't bind to port 8765 (already in use):
     - Server exits with code 0 (normal exit)
     - App detects the exit and verifies server is running
     - App connects to the existing server instance

## Key Features

- **No Duplicate Servers**: Health check prevents spawning multiple servers
- **Automatic Reconnection**: App reconnects to existing server if available
- **Crash Recovery**: Server automatically restarts if it crashes
- **Process Isolation**: Server runs as separate process, isolated from main app
- **Graceful Shutdown**: Only kills server if the app instance started it

## Server Persistence

The server persists until:
- The app instance that started it closes (if it was started by the app)
- The server process crashes and can't be restarted
- The server is manually terminated

If you close one app instance but another is running, the server continues running and the new instance will connect to it.

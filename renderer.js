// Main renderer process logic
let config = null;
let isCapturing = false;
let transcriptionPairs = [];
let selectedDeviceId = null;
let selectedDeviceType = 'input'; // 'input' or 'output'
let selectedLanguage = 'auto';
let volumeThreshold = 0.0001;
let detectedLanguage = 'auto';
let isUserScrolling = false; // Track if user is manually scrolling
let isAtBottom = true; // Track if user is at the bottom
let scrollSyncTimeout = null; // Timeout for scroll sync
let scrollSyncRaf = null; // RequestAnimationFrame ID for scroll sync
let pendingScrollUpdate = false; // Flag to prevent multiple RAF calls

// View navigation
let currentView = 'menu'; // 'menu', 'transcription', or 'tone-matching'
let transcriptionViewInitialized = false; // one-time listener/UI setup guard

// Transcription service readiness (server has loaded the SenseVoice model)
let transcriptionReady = false;
let transcriptionReadyPollTimer = null;

// Vocab tracker state
let seenVocab = JSON.parse(localStorage.getItem('seenVocab') || '{}'); // { word: count }
let allHskWords = {}; // { word: hskLevel } loaded from local JSON
let vocabContextCache = {}; // Cache for Ollama-generated contexts
let pinyinCache = JSON.parse(localStorage.getItem('pinyinCache') || '{}'); // { word: pinyinString }

// Most recent audio device list reported by the backend (shared across views)
let lastAudioDevices = null;

// Tone Matching state
let toneMatchingInitialized = false; // one-time mic-button wiring guard
let toneMicDeviceId = null;          // chosen microphone (input) device id
let toneMicDeviceType = 'input';     // 'input' or 'loopback' for the chosen device
let toneMicActive = false;           // is the mic currently listening
let toneTarget = null;               // { word, symbol, numArr, noToneArr, tones }
let toneMediaStream = null;          // getUserMedia stream used only for the wave animation
let toneAudioCtx = null;
let toneAnalyser = null;
let toneRafId = null;                // requestAnimationFrame id for the level meter
let toneToastSeq = 0;                // unique id generator for toasts
let toneBusy = false;               // guard against overlapping result handling
let toneWrongStreak = 0;            // consecutive incorrect attempts on the current char
const TONE_MAX_WRONG = 5;          // auto-skip after this many wrong attempts in a row
// Tone matching practices single syllables, so use a shorter audio buffer for
// snappier feedback. The transcription view is left untouched and keeps the
// backend default (config.py BUFFER_MAX_DURATION).
const TONE_BUFFER_MAX_DURATION = 5.0;   // seconds (~20 chunks @ 4096 samples / 16kHz)
const DEFAULT_BUFFER_MAX_DURATION = 10.0; // mirrors config.py BUFFER_MAX_DURATION

function showMenuView() {
    document.getElementById('menu-view').style.display = 'flex';
    document.getElementById('transcription-view').style.display = 'none';
    const toneView = document.getElementById('tone-matching-view');
    if (toneView) toneView.style.display = 'none';
    currentView = 'menu';
    // Refresh vocab tracker when returning to menu
    initializeVocabTracker();
}

function showTranscriptionView() {
    document.getElementById('menu-view').style.display = 'none';
    document.getElementById('transcription-view').style.display = 'flex';
    const toneView = document.getElementById('tone-matching-view');
    if (toneView) toneView.style.display = 'none';
    currentView = 'transcription';
}

function showToneMatchingView() {
    document.getElementById('menu-view').style.display = 'none';
    document.getElementById('transcription-view').style.display = 'none';
    document.getElementById('tone-matching-view').style.display = 'flex';
    currentView = 'tone-matching';
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Initializing LinguaCoda Language Learning Suite...');
    
    // Setup window controls (always available)
    setupWindowControls();
    
    // Ctrl+scroll zoom — sends IPC to main process which handles webContents zoom
    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                window.electronAPI.zoomIn();
            } else {
                window.electronAPI.zoomOut();
            }
        }
    }, { passive: false });
    
    // Show menu view initially
    showMenuView();
    
    // Initialize vocab tracker on the menu page
    initializeVocabTracker();
    
    // Register the global transcription-result dispatcher up front so it is
    // active regardless of which feature view the user opens first. It is safe
    // to call this multiple times — it clears existing listeners before adding.
    setupElectronListeners();

    // Setup menu navigation
    document.getElementById('subtitles-translation-btn').addEventListener('click', () => {
        showTranscriptionView();
        // Initialize transcription view components when first shown
        initializeTranscriptionView();
    });

    // Tone Matching navigation
    document.getElementById('tone-matching-btn').addEventListener('click', () => {
        showToneMatchingView();
        initializeToneMatchingView();
    });
    
    // Back button (always wire up, it's in the transcription view)
    document.getElementById('back-btn').addEventListener('click', async () => {
        // Stop capture if active before navigating back
        if (isCapturing) {
            await stopCapture();
        }
        showMenuView();
    });

    // Back button for the tone matching view
    document.getElementById('tone-back-btn').addEventListener('click', async () => {
        await toneStopListening();
        showMenuView();
    });
    
    console.log('Application window ready. Starting main loop...');
});

// Initialize transcription view (called when navigating to it)
async function initializeTranscriptionView() {
    // Load config
    if (!config) {
        config = await window.electronAPI.getConfig();
        volumeThreshold = config.volumeThreshold;
    }
    
    // Wire up DOM + IPC listeners exactly once. This function runs every time
    // the user navigates into the transcription view; without this guard each
    // visit would register another set of listeners, causing every
    // transcription result to be handled multiple times (duplicate entries).
    if (!transcriptionViewInitialized) {
        setupEventListeners();
        setupElectronListeners();
        transcriptionViewInitialized = true;
    }
    await loadAudioDevices();
    
    // Update threshold slider
    document.getElementById('volume-threshold').value = volumeThreshold;
    updateThresholdDisplay();

    // Reflect transcription-service readiness on the status badge: keep it
    // yellow "Loading..." until the server reports the SenseVoice model is ready.
    updateUI();
    startTranscriptionReadyPolling();
}

// Poll the transcription server's /health endpoint until it reports the model
// is ready. While not ready, the status badge stays yellow "Loading..."; once
// ready it flips back to the green "Ready" badge.
function startTranscriptionReadyPolling() {
    if (transcriptionReady) {
        if (!isCapturing) updateStatus('Ready', 'ready');
        updateToneReadinessUI();
        return;
    }

    if (!isCapturing) updateStatus('Loading...', 'loading');
    updateToneReadinessUI();

    if (transcriptionReadyPollTimer) {
        clearTimeout(transcriptionReadyPollTimer);
        transcriptionReadyPollTimer = null;
    }

    pollTranscriptionReady();
}

async function pollTranscriptionReady() {
    let ready = false;
    try {
        const status = await window.electronAPI.getTranscriptionStatus();
        ready = !!(status && status.ready);
    } catch (err) {
        ready = false;
    }

    if (ready) {
        transcriptionReady = true;
        transcriptionReadyPollTimer = null;
        // Don't clobber an in-progress capture/stopped status.
        if (!isCapturing) updateStatus('Ready', 'ready');
        updateUI();
        updateToneReadinessUI();
        return;
    }

    if (!isCapturing) updateStatus('Loading...', 'loading');
    updateToneReadinessUI();
    transcriptionReadyPollTimer = setTimeout(pollTranscriptionReady, 1000);
}

// Reflect transcription-service readiness on the Tone Matching view: keep the
// status badge yellow "Loading..." and the mic disabled until the SenseVoice
// model reports ready, then flip to green "Ready". Reuses the same status
// component/classes as the transcription view.
function updateToneReadinessUI() {
    const statusEl = document.getElementById('tone-status');
    const micBtn = document.getElementById('tone-mic-btn');

    if (statusEl && !toneMicActive) {
        if (transcriptionReady) {
            statusEl.textContent = 'Ready';
            statusEl.className = 'status status-ready';
        } else {
            statusEl.textContent = 'Loading...';
            statusEl.className = 'status status-loading';
        }
    }

    if (micBtn) {
        // Can't start practicing until the model has finished loading.
        micBtn.disabled = !transcriptionReady && !toneMicActive;
    }
}

// Setup window controls (always available)
function setupWindowControls() {
    // Window controls
    document.getElementById('minimize-btn').addEventListener('click', () => {
        window.electronAPI.windowMinimize();
    });
    
    document.getElementById('maximize-btn').addEventListener('click', () => {
        window.electronAPI.windowMaximize();
    });
    
    document.getElementById('close-btn').addEventListener('click', () => {
        window.electronAPI.windowClose();
    });
}

// Setup event listeners for transcription view
function setupEventListeners() {
    // Window controls are set up separately in setupWindowControls()
    
    // Device selection
    document.getElementById('device-select').addEventListener('change', (e) => {
        const option = e.target.options[e.target.selectedIndex];
        selectedDeviceId = e.target.value;
        selectedDeviceType = option.dataset.type || 'input';
        // Save selection to cache via backend
        saveDeviceSelection(selectedDeviceId, selectedDeviceType);
    });
    
    document.getElementById('refresh-devices').addEventListener('click', () => {
        loadAudioDevices(true); // Force refresh
    });
    
    // Language selection
    document.getElementById('language-select').addEventListener('change', (e) => {
        selectedLanguage = e.target.value;
        if (selectedLanguage !== 'auto') {
            detectedLanguage = selectedLanguage;
            updateDetectedLanguage(selectedLanguage, true);
        } else {
            detectedLanguage = 'auto';
            updateDetectedLanguage('auto', false);
        }
    });
    
    // Volume threshold
    const thresholdSlider = document.getElementById('volume-threshold');
    thresholdSlider.addEventListener('input', (e) => {
        volumeThreshold = parseFloat(e.target.value);
        updateThresholdDisplay();
        window.electronAPI.setVolumeThreshold(volumeThreshold);
    });
    
    // Control buttons
    document.getElementById('start-btn').addEventListener('click', startCapture);
    document.getElementById('stop-btn').addEventListener('click', stopCapture);
    document.getElementById('clear-btn').addEventListener('click', clearTranscript);
    
    // Setup scroll synchronization between transcription and translation containers
    setupScrollSync();
    
    // Handle window resize to update bounding boxes
    let resizeTimeout = null;
    window.addEventListener('resize', () => {
        // Debounce resize events to avoid excessive updates
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            // Recalculate heights for all pairs without recreating content
            requestAnimationFrame(() => {
                recalculatePairHeights();
            });
        }, 150);
    });
}

// Setup scroll synchronization between the two containers
function setupScrollSync() {
    const transcriptionContainer = document.getElementById('transcription-text');
    const translationContainer = document.getElementById('translation-text');
    
    // Function to check if container is at bottom
    function isAtBottomOf(container) {
        const threshold = 5; // 5px threshold for "at bottom"
        const maxScroll = container.scrollHeight - container.clientHeight;
        if (maxScroll <= 0) return true; // No scroll needed
        return container.scrollTop >= maxScroll - threshold;
    }
    
    // Store scroll source and target for RAF
    let scrollSource = null;
    let scrollTarget = null;
    
    // Smooth scroll sync using requestAnimationFrame
    function performScrollSync() {
        if (!scrollSource || !scrollTarget) {
            pendingScrollUpdate = false;
            return;
        }
        
        const source = scrollSource;
        const target = scrollTarget;
        
        // Temporarily set flag to prevent recursive events
        const wasUserScrolling = isUserScrolling;
        isUserScrolling = true;
        
        const sourceMaxScroll = source.scrollHeight - source.clientHeight;
        const targetMaxScroll = target.scrollHeight - target.clientHeight;
        
        if (sourceMaxScroll > 0 && targetMaxScroll > 0) {
            const scrollRatio = source.scrollTop / sourceMaxScroll;
            const targetScrollTop = scrollRatio * targetMaxScroll;
            
            // Only update if there's a meaningful difference to avoid jitter
            if (Math.abs(target.scrollTop - targetScrollTop) > 0.5) {
                target.scrollTop = targetScrollTop;
            }
        }
        
        // Check if at bottom (both containers should be at bottom)
        isAtBottom = isAtBottomOf(source) && isAtBottomOf(target);
        
        // Clear the flag after a very short delay to allow smooth scrolling
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(() => {
            isUserScrolling = false;
        }, 16); // ~1 frame at 60fps
        
        pendingScrollUpdate = false;
        scrollSyncRaf = null;
    }
    
    // Function to queue scroll sync
    function syncScroll(source, target) {
        // When capturing, prevent user scrolling - only allow programmatic scrolling
        if (isCapturing) {
            // If user tried to scroll while capturing, reset to bottom
            // But only if it's not a programmatic scroll (isUserScrolling flag)
            if (!isUserScrolling) {
                requestAnimationFrame(() => {
                    if (isCapturing && !isUserScrolling) {
                        const sourceMaxScroll = source.scrollHeight - source.clientHeight;
                        const targetMaxScroll = target.scrollHeight - target.clientHeight;
                        source.scrollTop = Math.max(0, sourceMaxScroll);
                        target.scrollTop = Math.max(0, targetMaxScroll);
                    }
                });
            }
            return;
        }
        
        // Don't sync if we're already syncing (prevents infinite loops)
        if (isUserScrolling && pendingScrollUpdate) return;
        
        scrollSource = source;
        scrollTarget = target;
        
        // Use requestAnimationFrame for smooth syncing
        if (!pendingScrollUpdate) {
            pendingScrollUpdate = true;
            if (scrollSyncRaf) {
                cancelAnimationFrame(scrollSyncRaf);
            }
            scrollSyncRaf = requestAnimationFrame(performScrollSync);
        }
    }
    
    // Add scroll listeners to both containers with passive flag for better performance
    transcriptionContainer.addEventListener('scroll', () => {
        syncScroll(transcriptionContainer, translationContainer);
    }, { passive: true });
    
    translationContainer.addEventListener('scroll', () => {
        syncScroll(translationContainer, transcriptionContainer);
    }, { passive: true });
    
    // Prevent manual scrolling when capturing (but allow Ctrl+scroll for zoom)
    function handleWheel(e) {
        if (isCapturing && !e.ctrlKey) {
            // Prevent scrolling when capturing (unless Ctrl is held for zoom)
            e.preventDefault();
            e.stopPropagation();
        }
    }
    
    transcriptionContainer.addEventListener('wheel', handleWheel, { passive: false });
    translationContainer.addEventListener('wheel', handleWheel, { passive: false });
}

// Setup Electron IPC listeners
function setupElectronListeners() {
    // Defensively clear any previously-registered handlers so we never stack
    // duplicate listeners on the same channel (which would cause each
    // transcription result to be processed more than once).
    window.electronAPI.removeAllListeners('transcription-result');
    window.electronAPI.removeAllListeners('error');
    window.electronAPI.removeAllListeners('audio-devices');

    window.electronAPI.onTranscriptionResult((data) => {
        // Route results to whichever feature is currently active.
        if (currentView === 'tone-matching') {
            handleToneMatchingResult(data);
        } else {
            handleTranscriptionResult(data);
        }
    });
    
    window.electronAPI.onError((error) => {
        console.error('Error:', error);
        updateStatus('Error: ' + error, 'stopped');
    });
    
    window.electronAPI.onAudioDevices((devices) => {
        lastAudioDevices = devices;
        // Transcription view's device <select>.
        if (document.getElementById('device-select')) {
            populateDeviceSelect(devices);
        }
        // Tone matching view's device <select>.
        if (document.getElementById('tone-device-select')) {
            populateToneDeviceSelect(devices);
        }
    });
}

// Load audio devices
async function loadAudioDevices(forceRefresh = false) {
    const result = await window.electronAPI.getAudioDevices(forceRefresh);
    if (!result.success) {
        console.error('Failed to load devices');
    }
}

// Save device selection to cache
async function saveDeviceSelection(deviceId, deviceType) {
    // The backend will save this when we call getAudioDevices or start capture
    // But we can also explicitly save it here if needed
    try {
        await window.electronAPI.saveDeviceSelection(deviceId, deviceType);
    } catch (error) {
        console.error('Failed to save device selection:', error);
    }
}

// Populate device select
function populateDeviceSelect(devices) {
    const select = document.getElementById('device-select');
    select.innerHTML = '';
    
    if (devices && devices.input && devices.output) {
        if (devices.output.length > 0) {
            const outputGroup = document.createElement('optgroup');
            outputGroup.label = 'Speaker Output (Loopback)';
            devices.output.forEach((device) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name;
                option.dataset.type = device.type || 'loopback';
                outputGroup.appendChild(option);
            });
            select.appendChild(outputGroup);
        }
        
        if (devices.input.length > 0) {
            const inputGroup = document.createElement('optgroup');
            inputGroup.label = 'Microphones';
            devices.input.forEach((device) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name;
                option.dataset.type = device.type || 'input';
                inputGroup.appendChild(option);
            });
            select.appendChild(inputGroup);
        }
        
        // Select default device from cache, or stereo mix, or first device
        let selectedIndex = 0;
        if (devices.defaultDeviceId !== undefined && devices.defaultDeviceId !== null) {
            // Try to find the cached device
            for (let i = 0; i < select.options.length; i++) {
                const option = select.options[i];
                if (option.value == devices.defaultDeviceId) {
                    selectedIndex = i;
                    break;
                }
            }
        } else {
            // Try to find stereo mix
            for (let i = 0; i < select.options.length; i++) {
                const option = select.options[i];
                if (option.textContent.toLowerCase().includes('stereo mix')) {
                    selectedIndex = i;
                    break;
                }
            }
        }
        
        if (select.options.length > 0) {
            select.selectedIndex = selectedIndex;
            const selectedOption = select.options[selectedIndex];
            selectedDeviceId = selectedOption.value;
            selectedDeviceType = selectedOption.dataset.type || 
                                (devices.defaultDeviceType || 'input');
            
            // Save the selection
            saveDeviceSelection(selectedDeviceId, selectedDeviceType);
        }
    } else {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No devices found';
        select.appendChild(option);
    }
}

// Start capture
async function startCapture() {
    if (isCapturing) return;
    
    const result = await window.electronAPI.startCapture(selectedDeviceId, selectedDeviceType);
    if (result.success) {
        isCapturing = true;
        // When starting capture, scroll to bottom and enable autoscroll
        forceScrollToBottom();
        updateUI();
        updateStatus('Capturing...', 'capturing');
    } else {
        alert('Failed to start capture: ' + (result.error || 'Unknown error'));
    }
}

// Stop capture
async function stopCapture() {
    if (!isCapturing) return;
    
    const result = await window.electronAPI.stopCapture();
    if (result.success) {
        isCapturing = false;
        // When stopping capture, check current scroll position
        const transcriptionContainer = document.getElementById('transcription-text');
        const translationContainer = document.getElementById('translation-text');
        if (transcriptionContainer && translationContainer) {
            // Update isAtBottom based on current position
            const threshold = 5;
            const transcriptionMaxScroll = transcriptionContainer.scrollHeight - transcriptionContainer.clientHeight;
            const translationMaxScroll = translationContainer.scrollHeight - translationContainer.clientHeight;
            isAtBottom = (transcriptionMaxScroll <= 0 || transcriptionContainer.scrollTop >= transcriptionMaxScroll - threshold) &&
                        (translationMaxScroll <= 0 || translationContainer.scrollTop >= translationMaxScroll - threshold);
        }
        updateUI();
        updateStatus('Stopped', 'stopped');
    }
}

// Split text by sentence-ending punctuation
function splitIntoSentences(text) {
    if (!text || !text.trim()) return [];
    
    // Sentence-ending punctuation patterns:
    // - Single or multiple periods: . .. ...
    // - Chinese period: 。
    // - Full-width period: ．
    // - Ellipsis: ... (three or more periods)
    // Match one or more of these at the end of a sentence
    const sentenceEndRegex = /([.。．]{1,3}|\.{3,})/g;
    
    const sentences = [];
    let lastIndex = 0;
    let match;
    
    // Find all sentence endings
    const matches = [];
    while ((match = sentenceEndRegex.exec(text)) !== null) {
        matches.push({
            index: match.index,
            length: match[0].length,
            punctuation: match[0]
        });
    }
    
    // If no matches found, return the whole text as a single sentence
    if (matches.length === 0) {
        return [text.trim()];
    }
    
    // Split text at each match
    for (const match of matches) {
        const endIndex = match.index + match.length;
        const sentence = text.substring(lastIndex, endIndex).trim();
        
        if (sentence && !isOnlyPunctuation(sentence)) {
            sentences.push(sentence);
        }
        
        lastIndex = endIndex;
    }
    
    // Add remaining text if any (text after last punctuation)
    if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex).trim();
        if (remaining && !isOnlyPunctuation(remaining)) {
            sentences.push(remaining);
        }
    }
    
    return sentences.length > 0 ? sentences : [text.trim()];
}

// Handle transcription result
async function handleTranscriptionResult(data) {
    const { transcription, detectedLang } = data;
    
    if (!transcription || !transcription.trim()) return;
    
    // Skip if transcription is only punctuation
    if (isOnlyPunctuation(transcription)) {
        return;
    }
    
    // Update detected language
    if (selectedLanguage === 'auto' && detectedLang && detectedLang !== 'auto' && detectedLang !== 'unknown') {
        detectedLanguage = detectedLang;
        updateDetectedLanguage(detectedLang, false);
    }
    
    // Split transcription into sentences
    const sentences = splitIntoSentences(transcription);
    
    // Process each sentence as a separate pair
    for (const sentence of sentences) {
        if (!sentence || !sentence.trim() || isOnlyPunctuation(sentence)) {
            continue;
        }
        
        // Add transcription pair
        transcriptionPairs.push({ transcription: sentence.trim(), translation: '' });
        
        // Translate
        translateText(sentence.trim(), transcriptionPairs.length - 1);
    }
    
    // Track vocab from Chinese transcriptions
    if (Object.keys(allHskWords).length > 0) {
        for (const sentence of sentences) {
            trackVocabFromText(sentence);
        }
    }
    
    // Update display
    updateDisplay();
}

// Track HSK vocab words found in transcribed text
function trackVocabFromText(text) {
    if (!text || Object.keys(allHskWords).length === 0) return;
    
    // Greedy longest-match segmentation against the HSK dictionary
    let i = 0;
    while (i < text.length) {
        let matched = false;
        // Try longest match first (up to 6 chars for Chinese words)
        for (let len = Math.min(6, text.length - i); len >= 1; len--) {
            const candidate = text.substring(i, i + len);
            if (allHskWords[candidate] !== undefined) {
                // Found an HSK word — increment its seen count
                seenVocab[candidate] = (seenVocab[candidate] || 0) + 1;
                matched = true;
                i += len;
                break;
            }
        }
        if (!matched) i++;
    }
    // Persist to localStorage
    localStorage.setItem('seenVocab', JSON.stringify(seenVocab));
}

// Translate text
async function translateText(text, pairIndex) {
    try {
        const result = await window.electronAPI.translateText(text);
        if (result.success && transcriptionPairs[pairIndex]) {
            transcriptionPairs[pairIndex].translation = result.translation;
            updateDisplay();
        }
    } catch (error) {
        console.error('Translation error:', error);
    }
}

// Update display
function updateDisplay() {
    const transcriptionContainer = document.getElementById('transcription-text');
    const translationContainer = document.getElementById('translation-text');
    
    // Clear existing content
    transcriptionContainer.innerHTML = '';
    translationContainer.innerHTML = '';
    
    // Filter out pairs with only punctuation transcriptions
    const validPairs = transcriptionPairs.filter(pair => {
        return pair.transcription && !isOnlyPunctuation(pair.transcription);
    });
    
    // Limit number of pairs if needed
    const maxTextLength = config.maxTextLength || 1000;
    let totalLength = 0;
    let pairsToShow = validPairs;
    
    // Calculate which pairs to show based on max length
    if (validPairs.length > 0) {
        const reversedPairs = [...validPairs].reverse();
        const selectedPairs = [];
        
        for (const pair of reversedPairs) {
            const pairLength = (pair.transcription || '').length + (pair.translation || '').length;
            if (totalLength + pairLength > maxTextLength && selectedPairs.length > 0) {
                break;
            }
            selectedPairs.unshift(pair);
            totalLength += pairLength;
        }
        pairsToShow = selectedPairs;
    }
    
    // Create pair components with alignment
    const pairWrappers = [];
    
    pairsToShow.forEach((pair, displayIndex) => {
        // Find the actual index in the full transcriptionPairs array
        const actualIndex = transcriptionPairs.indexOf(pair);
        
        // Create pair wrapper for transcription
        const transcriptionPairWrapper = document.createElement('div');
        transcriptionPairWrapper.className = 'pair-wrapper';
        
        const transcriptionEl = document.createElement('div');
        transcriptionEl.className = 'pair-transcription';
        transcriptionEl.textContent = pair.transcription || '';
        if (actualIndex >= 0) {
            transcriptionEl.dataset.pairIndex = actualIndex;
            transcriptionEl.addEventListener('click', () => showDetailView(actualIndex));
        }
        
        transcriptionPairWrapper.appendChild(transcriptionEl);
        transcriptionContainer.appendChild(transcriptionPairWrapper);
        
        // Create pair wrapper for translation
        const translationPairWrapper = document.createElement('div');
        translationPairWrapper.className = 'pair-wrapper';
        
        const translationEl = document.createElement('div');
        translationEl.className = 'pair-translation';
        translationEl.textContent = pair.translation || '';
        if (actualIndex >= 0) {
            translationEl.dataset.pairIndex = actualIndex;
            translationEl.addEventListener('click', () => showDetailView(actualIndex));
        }
        
        translationPairWrapper.appendChild(translationEl);
        translationContainer.appendChild(translationPairWrapper);
        
        // Store references for height calculation
        pairWrappers.push({
            transcription: { wrapper: transcriptionPairWrapper, element: transcriptionEl },
            translation: { wrapper: translationPairWrapper, element: translationEl },
            index: displayIndex
        });
    });
    
    // Calculate heights and apply spacing after DOM is updated
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
        recalculatePairHeights(pairWrappers);
        // If capturing, ensure we scroll to bottom after layout
        if (isCapturing) {
            forceScrollToBottom();
        }
    });
}

// Force scroll to bottom (used when capturing)
function forceScrollToBottom() {
    const transcriptionContainer = document.getElementById('transcription-text');
    const translationContainer = document.getElementById('translation-text');
    if (!transcriptionContainer || !translationContainer) return;
    
    // Use double requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            isUserScrolling = true;
            const transcriptionMaxScroll = transcriptionContainer.scrollHeight - transcriptionContainer.clientHeight;
            const translationMaxScroll = translationContainer.scrollHeight - translationContainer.clientHeight;
            
            // Scroll to bottom
            if (transcriptionMaxScroll > 0) {
                transcriptionContainer.scrollTop = transcriptionMaxScroll;
            }
            if (translationMaxScroll > 0) {
                translationContainer.scrollTop = translationMaxScroll;
            }
            
            isAtBottom = true;
            
            // Verify scroll worked, retry if needed (sometimes layout takes longer)
            setTimeout(() => {
                const currentTranscriptionScroll = transcriptionContainer.scrollTop;
                const currentTranslationScroll = translationContainer.scrollTop;
                const expectedTranscriptionScroll = transcriptionContainer.scrollHeight - transcriptionContainer.clientHeight;
                const expectedTranslationScroll = translationContainer.scrollHeight - translationContainer.clientHeight;
                
                // If we're not at the bottom, try again
                if (isCapturing && (
                    (expectedTranscriptionScroll > 0 && Math.abs(currentTranscriptionScroll - expectedTranscriptionScroll) > 1) ||
                    (expectedTranslationScroll > 0 && Math.abs(currentTranslationScroll - expectedTranslationScroll) > 1)
                )) {
                    transcriptionContainer.scrollTop = expectedTranscriptionScroll;
                    translationContainer.scrollTop = expectedTranslationScroll;
                }
                
                isUserScrolling = false;
            }, 100);
        });
    });
}

// Recalculate heights for existing pairs (used for resize without recreating content)
function recalculatePairHeights(pairWrappers) {
    if (!pairWrappers || pairWrappers.length === 0) {
        // If no pairWrappers provided, find existing pairs in DOM
        const transcriptionContainer = document.getElementById('transcription-text');
        const translationContainer = document.getElementById('translation-text');
        const transcriptionWrappers = transcriptionContainer.querySelectorAll('.pair-wrapper');
        const translationWrappers = translationContainer.querySelectorAll('.pair-wrapper');
        
        if (transcriptionWrappers.length !== translationWrappers.length) return;
        
        pairWrappers = [];
        for (let i = 0; i < transcriptionWrappers.length; i++) {
            const transcriptionEl = transcriptionWrappers[i].querySelector('.pair-transcription');
            const translationEl = translationWrappers[i].querySelector('.pair-translation');
            if (transcriptionEl && translationEl) {
                pairWrappers.push({
                    transcription: { wrapper: transcriptionWrappers[i], element: transcriptionEl },
                    translation: { wrapper: translationWrappers[i], element: translationEl },
                    index: i
                });
            }
        }
    }
    
    pairWrappers.forEach((pair, index) => {
        // Get the natural heights of the content (scrollHeight includes content + padding)
        const transcriptionContentHeight = pair.transcription.element.scrollHeight;
        const translationContentHeight = pair.translation.element.scrollHeight;
        const maxContentHeight = Math.max(transcriptionContentHeight, translationContentHeight);
        
        // With box-sizing: border-box, minHeight includes padding and border
        // scrollHeight gives us content + padding, so we need to add border (1px top + 1px bottom = 2px)
        const minHeightWithBorder = maxContentHeight + 2;
        
        // Set minimum height on both elements to match the max height
        // This ensures the outlines (borders) are the same height and aligned
        pair.transcription.element.style.minHeight = `${minHeightWithBorder}px`;
        pair.translation.element.style.minHeight = `${minHeightWithBorder}px`;
        
        // Set minimum height on wrapper to ensure alignment
        pair.transcription.wrapper.style.minHeight = `${minHeightWithBorder}px`;
        pair.translation.wrapper.style.minHeight = `${minHeightWithBorder}px`;
        
        // Add spacing after the pair (except for the last one)
        if (index < pairWrappers.length - 1) {
            // Use 50% of max height as spacing, with a minimum of 10px
            const spacing = Math.max(maxContentHeight * 0.5, 10);
            pair.transcription.wrapper.style.marginBottom = `${spacing}px`;
            pair.translation.wrapper.style.marginBottom = `${spacing}px`;
        }
    });
    
    // Auto-scroll behavior based on capture state
    // Use double requestAnimationFrame to ensure layout is complete before scrolling
    if (isCapturing) {
        // When capturing, always autoscroll to bottom
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Temporarily disable scroll sync to prevent recursive events
                isUserScrolling = true;
                const transcriptionMaxScroll = transcriptionContainer.scrollHeight - transcriptionContainer.clientHeight;
                const translationMaxScroll = translationContainer.scrollHeight - translationContainer.clientHeight;
                transcriptionContainer.scrollTop = Math.max(0, transcriptionMaxScroll);
                translationContainer.scrollTop = Math.max(0, translationMaxScroll);
                // Update isAtBottom flag after scrolling
                isAtBottom = true;
                // Re-enable scroll sync after a brief delay
                setTimeout(() => {
                    isUserScrolling = false;
                }, 50);
            });
        });
    } else {
        // When not capturing, only autoscroll if user is at the bottom
        if (isAtBottom) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    // Temporarily disable scroll sync to prevent recursive events
                    isUserScrolling = true;
                    const transcriptionMaxScroll = transcriptionContainer.scrollHeight - transcriptionContainer.clientHeight;
                    const translationMaxScroll = translationContainer.scrollHeight - translationContainer.clientHeight;
                    transcriptionContainer.scrollTop = Math.max(0, transcriptionMaxScroll);
                    translationContainer.scrollTop = Math.max(0, translationMaxScroll);
                    // Update isAtBottom flag after scrolling
                    isAtBottom = true;
                    // Re-enable scroll sync after a brief delay
                    setTimeout(() => {
                        isUserScrolling = false;
                    }, 50);
                });
            });
        }
    }
}


// Update UI state
function updateUI() {
    // Can't start capturing until the transcription service has finished loading.
    document.getElementById('start-btn').disabled = isCapturing || !transcriptionReady;
    document.getElementById('stop-btn').disabled = !isCapturing;
    document.getElementById('device-select').disabled = isCapturing;
    document.getElementById('language-select').disabled = isCapturing;
}

// Clear every entry from the transcription/translation view.
// NOTE: this only clears the on-screen transcript — the HSK vocab tracker
// statistics gathered so far are intentionally left untouched.
function clearTranscript() {
    transcriptionPairs = [];

    const transcriptionContainer = document.getElementById('transcription-text');
    const translationContainer = document.getElementById('translation-text');
    if (transcriptionContainer) transcriptionContainer.innerHTML = '';
    if (translationContainer) translationContainer.innerHTML = '';

    // Reset scroll bookkeeping so the next entry autoscrolls cleanly.
    isAtBottom = true;

    updateDisplay();
}

// Update status
function updateStatus(text, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = text;
    statusEl.className = `status status-${type}`;
}

// Update detected language
function updateDetectedLanguage(lang, isManual) {
    const detectedLangEl = document.getElementById('detected-lang');
    if (isManual) {
        detectedLangEl.textContent = `Detected: ${lang} (manual)`;
        detectedLangEl.style.color = '#4a9eff';
    } else {
        detectedLangEl.textContent = `Detected: ${lang}`;
        detectedLangEl.style.color = '#b0b0b0';
    }
}

// Update threshold display
function updateThresholdDisplay() {
    document.getElementById('threshold-value').textContent = volumeThreshold.toFixed(4);
}

// Check if text is only punctuation (including foreign punctuation)
function isOnlyPunctuation(text) {
    if (!text || !text.trim()) return true;
    
    // Remove all whitespace
    const cleaned = text.replace(/\s/g, '');
    if (!cleaned) return true;
    
    // Unicode punctuation categories:
    // \p{P} - all punctuation
    // \p{S} - symbols
    // Common punctuation marks
    const punctuationRegex = /^[\p{P}\p{S}]+$/u;
    return punctuationRegex.test(cleaned);
}

// Detail View Functions
let currentDetailPairIndex = -1;

// Show detail view for a pair
async function showDetailView(pairIndex) {
    const pair = transcriptionPairs[pairIndex];
    if (!pair || !pair.transcription || !pair.translation) {
        return;
    }
    
    // Wait for translation if it's not ready yet
    if (!pair.translation || pair.translation.trim() === '') {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!pair.translation || pair.translation.trim() === '') {
            alert('Translation not ready yet. Please wait for the translation to complete.');
            return;
        }
    }
    
    currentDetailPairIndex = pairIndex;
    
    // Show modal
    const modal = document.getElementById('detail-view-modal');
    const loading = document.getElementById('detail-loading');
    const content = document.getElementById('detail-content');
    const error = document.getElementById('detail-error');
    
    modal.style.display = 'flex';
    loading.style.display = 'flex';
    content.style.display = 'none';
    error.style.display = 'none';
    
    // Setup close button
    document.getElementById('detail-view-close').onclick = () => {
        modal.style.display = 'none';
        hideDetailCardTooltip();
    };
    
    // Close on overlay click
    document.querySelector('.detail-modal-overlay').onclick = (e) => {
        if (e.target.classList.contains('detail-modal-overlay')) {
            modal.style.display = 'none';
            hideDetailCardTooltip();
        }
    };
    
    // Extract semantic units (tokenize + correlate with retry)
    try {
        const result = await window.electronAPI.extractSemanticUnits(
            pair.transcription,
            pair.translation
        );
        
        if (result.success && result.transcriptionChunks && result.translationChunks) {
            renderDetailView(
                pair.transcription,
                pair.translation,
                result.transcriptionChunks,
                result.translationChunks,
                result.correlations || []
            );
            loading.style.display = 'none';
            content.style.display = 'flex';
        } else {
            throw new Error(result.error || 'Failed to extract semantic units');
        }
    } catch (err) {
        console.error('Error extracting semantic units:', err);
        loading.style.display = 'none';
        error.style.display = 'block';
        error.textContent = `Error: ${err.message || 'Failed to extract semantic units'}`;
    }
}

// Render detail view with chunk-based cards and correlation highlighting.
//
// Correlations follow the many-to-many shape produced by the main process:
//   [{ id: "t1", matches: ["e1", "e2"] }, { id: "t2", matches: [] }, ...]
// (Older single-`match` entries are still tolerated for backwards compat.)
//
// Only chunks that participate in at least one mapping are rendered as
// interactive cards; unmapped chunks fall back to plain text so the UI doesn't
// imply a semantic link that the alignment pipeline never found.
function renderDetailView(transcription, translation, transcriptionChunks, translationChunks, correlations) {
    const transcriptionContainer = document.getElementById('detail-transcription');
    const translationContainer = document.getElementById('detail-translation');
    
    transcriptionContainer.innerHTML = '';
    translationContainer.innerHTML = '';

    // Compute which chunk IDs participate in any mapping.
    const mappedChunkIds = collectMappedChunkIds(correlations);
    
    // Match LLM-tokenized chunks back to positions in the original text
    const transSegments = matchChunksToText(transcription, transcriptionChunks);
    const transLangSegments = matchChunksToText(translation, translationChunks);
    
    // Render each sentence's chunks; mapped → card, unmapped → plain text
    renderChunksAsCards(transcriptionContainer, transcription, transSegments, 'transcription', mappedChunkIds);
    renderChunksAsCards(translationContainer, translation, transLangSegments, 'translation', mappedChunkIds);
    
    // Wire up hover highlighting driven by the correlation map
    setupCorrelationHighlighting(correlations);
}

// Walks the correlations array and returns the set of all chunk IDs (both
// transcription `t*` and translation `e*`) that participate in at least one
// mapping. A transcription chunk is "mapped" iff its matches array is
// non-empty; a translation chunk is "mapped" iff it appears in some
// transcription chunk's matches array.
function collectMappedChunkIds(correlations) {
    const mapped = new Set();
    if (!Array.isArray(correlations)) return mapped;
    for (const corr of correlations) {
        if (!corr || typeof corr.id !== 'string') continue;
        const matches = Array.isArray(corr.matches)
            ? corr.matches
            : (corr.match ? [corr.match] : []);
        const cleaned = matches.filter(m => typeof m === 'string' && m.length > 0);
        if (cleaned.length === 0) continue;
        mapped.add(corr.id);
        for (const m of cleaned) mapped.add(m);
    }
    return mapped;
}

// Match an ordered list of chunks back to character positions in the original text.
// Chunks are expected to be in sentence order; we advance a cursor so that repeated
// words resolve to distinct occurrences.
function matchChunksToText(text, chunks) {
    if (!text || !chunks || chunks.length === 0) return [];
    
    const segments = [];
    let searchPos = 0;
    
    for (const chunk of chunks) {
        const chunkText = (chunk.text || '').trim();
        if (!chunkText) continue;
        
        // Try exact match from current position
        let pos = text.indexOf(chunkText, searchPos);
        
        // Fallback: case-insensitive from current position
        if (pos === -1) {
            const lower = text.toLowerCase();
            pos = lower.indexOf(chunkText.toLowerCase(), searchPos);
        }
        
        // Last resort: search from the beginning (out-of-order tolerance)
        if (pos === -1) {
            pos = text.indexOf(chunkText);
            if (pos === -1) {
                pos = text.toLowerCase().indexOf(chunkText.toLowerCase());
            }
        }
        
        if (pos >= 0) {
            segments.push({
                start: pos,
                end: pos + chunkText.length,
                text: text.substring(pos, pos + chunkText.length),
                chunkId: chunk.id
            });
            searchPos = pos + chunkText.length;
        }
        // If chunk text can't be found at all, skip it (punctuation, parenthetical, etc.)
    }
    
    // Sort by position for rendering
    segments.sort((a, b) => a.start - b.start);
    return segments;
}

// Render text with matched chunk segments. Mapped chunks (those whose IDs are
// in `mappedChunkIds`) become interactive cards; unmapped chunks render as
// plain text so the UI doesn't imply a semantic link that doesn't exist.
// Gaps between segments are always plain text.
function renderChunksAsCards(container, fullText, segments, type, mappedChunkIds) {
    if (!fullText) return;
    
    if (segments.length === 0) {
        container.textContent = fullText;
        return;
    }

    const mappedSet = mappedChunkIds instanceof Set ? mappedChunkIds : new Set();
    let currentPos = 0;
    
    for (const segment of segments) {
        // Plain text before this segment
        if (segment.start > currentPos) {
            container.appendChild(document.createTextNode(fullText.substring(currentPos, segment.start)));
        }

        if (mappedSet.has(segment.chunkId)) {
            // Mapped chunk → interactive card
            const card = document.createElement('span');
            card.className = 'detail-card';
            card.dataset.type = type;
            card.dataset.chunkId = segment.chunkId;

            // Card visible text (kept as its own element so the tooltip child doesn't
            // bleed into the layout)
            const labelEl = document.createElement('span');
            labelEl.className = 'detail-card-label';
            labelEl.textContent = segment.text;
            card.appendChild(labelEl);

            // For Chinese chunks, attach a hover tooltip that shows pinyin under each char
            attachDetailCardPinyinTooltip(card, segment.text);

            container.appendChild(card);
        } else {
            // Unmapped chunk → render as plain text (no card box, no hover)
            container.appendChild(document.createTextNode(segment.text));
        }
        
        currentPos = segment.end;
    }
    
    // Trailing text after last segment
    if (currentPos < fullText.length) {
        container.appendChild(document.createTextNode(fullText.substring(currentPos)));
    }
}

// Shared, body-attached tooltip element. Lives outside the detail modal so it isn't
// clipped by the modal's scrolling/overflow:hidden containers, and so it isn't affected
// by transforms on .detail-card:hover (which would otherwise establish a containing block
// even for position:fixed children).
let detailCardTooltipEl = null;
function getDetailCardTooltip() {
    if (!detailCardTooltipEl) {
        detailCardTooltipEl = document.createElement('div');
        detailCardTooltipEl.className = 'detail-card-tooltip';
        detailCardTooltipEl.style.display = 'none';
        document.body.appendChild(detailCardTooltipEl);
    }
    return detailCardTooltipEl;
}

function hideDetailCardTooltip() {
    if (detailCardTooltipEl) {
        detailCardTooltipEl.style.display = 'none';
        detailCardTooltipEl.dataset.activeKey = '';
    }
}

// Attach hover handlers to show a pinyin tooltip for the chunk under the cursor.
// Skips chunks with no Chinese characters. Pinyin comes from the same IPC + cache as the vocab tracker.
function attachDetailCardPinyinTooltip(card, text) {
    if (!text || !/[\u4e00-\u9fff]/.test(text)) return;

    const chars = [...text];

    card.addEventListener('mouseenter', () => {
        const tooltip = getDetailCardTooltip();
        tooltip.dataset.activeKey = text;
        renderDetailCardTooltipContent(tooltip, chars, pinyinCache[text]);
        tooltip.style.display = 'block';
        positionDetailCardTooltip(tooltip, card);

        // Lazy-load pinyin on first hover; only update if still hovering the same card
        if (!pinyinCache[text]) {
            (async () => {
                try {
                    const result = await window.electronAPI.getPinyin(text);
                    if (result && result.success && result.pinyin) {
                        pinyinCache[text] = result.pinyin;
                        try { localStorage.setItem('pinyinCache', JSON.stringify(pinyinCache)); } catch (e) { /* quota */ }
                        if (detailCardTooltipEl && detailCardTooltipEl.dataset.activeKey === text) {
                            renderDetailCardTooltipContent(detailCardTooltipEl, chars, result.pinyin);
                            positionDetailCardTooltip(detailCardTooltipEl, card);
                        }
                    }
                } catch (err) {
                    console.error('Pinyin fetch failed for detail card', text, err);
                }
            })();
        }
    });

    card.addEventListener('mouseleave', () => {
        if (detailCardTooltipEl && detailCardTooltipEl.dataset.activeKey === text) {
            hideDetailCardTooltip();
        }
    });

    // Click → open the same vocab context modal as the vocab tracker, using the
    // chunk text as the lookup word and current seen count for the header label.
    card.addEventListener('click', (e) => {
        e.stopPropagation();
        hideDetailCardTooltip();
        showVocabContextModal(text, seenVocab[text] || 0);
    });
}

// Position the (fixed) tooltip below the card, flipping above if there's no room below.
// Clamps horizontally so the tooltip stays inside the viewport.
function positionDetailCardTooltip(tooltip, card) {
    const cardRect = card.getBoundingClientRect();
    // Reset so we can measure natural size
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const ttRect = tooltip.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 8;

    let top = cardRect.bottom + margin;
    if (top + ttRect.height > vh - margin) {
        const above = cardRect.top - ttRect.height - margin;
        if (above >= margin) top = above;
    }
    if (top < margin) top = margin;

    let left = cardRect.left + cardRect.width / 2 - ttRect.width / 2;
    if (left < margin) left = margin;
    if (left + ttRect.width > vw - margin) left = vw - ttRect.width - margin;

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
}

// (Re)render the contents of a detail-card tooltip. If pinyin syllables align 1:1
// with characters, show pinyin under each char. Otherwise fall back to showing the
// whole pinyin string under the row of characters.
function renderDetailCardTooltipContent(tooltip, chars, pinyinString) {
    tooltip.innerHTML = '';
    const loaded = !!pinyinString;
    const parts = loaded ? pinyinString.split(/\s+/).filter(Boolean) : [];
    const aligned = loaded && parts.length === chars.length;

    const row = document.createElement('div');
    row.className = 'detail-card-tt-row';
    chars.forEach((ch, i) => {
        const col = document.createElement('div');
        col.className = 'detail-card-tt-col';

        const charEl = document.createElement('span');
        charEl.className = 'detail-card-tt-char';
        charEl.textContent = ch;
        col.appendChild(charEl);

        if (aligned) {
            const pinyinEl = document.createElement('span');
            pinyinEl.className = 'detail-card-tt-pinyin';
            pinyinEl.textContent = parts[i];
            col.appendChild(pinyinEl);
        } else if (!loaded) {
            const pinyinEl = document.createElement('span');
            pinyinEl.className = 'detail-card-tt-pinyin loading';
            pinyinEl.textContent = '…';
            col.appendChild(pinyinEl);
        }

        row.appendChild(col);
    });
    tooltip.appendChild(row);

    if (loaded && !aligned) {
        const full = document.createElement('div');
        full.className = 'detail-card-tt-pinyin-full';
        full.textContent = pinyinString;
        tooltip.appendChild(full);
    }
}

// Build a bidirectional correlation map and wire hover events on cards.
//
// Correlations use the many-to-many shape `{ id: "t1", matches: ["e1", "e2"] }`
// produced by the main process. Hovering any card in a group highlights every
// other card that shares any link with it (including all siblings on the
// translation side that map back to the same transcription chunk).
function setupCorrelationHighlighting(correlations) {
    const cards = document.querySelectorAll('.detail-card');
    
    // Build lookup: chunkId → Set of correlated chunkIds
    const correlationMap = {};
    const addLink = (a, b) => {
        if (!a || !b || a === b) return;
        if (!correlationMap[a]) correlationMap[a] = new Set();
        correlationMap[a].add(b);
    };

    for (const corr of correlations) {
        if (!corr || typeof corr.id !== 'string') continue;
        const matches = Array.isArray(corr.matches)
            ? corr.matches
            : (corr.match ? [corr.match] : []);
        const cleaned = matches.filter(m => typeof m === 'string' && m.length > 0);
        if (cleaned.length === 0) continue;

        // Bidirectional t ↔ each e
        for (const m of cleaned) {
            addLink(corr.id, m);
            addLink(m, corr.id);
        }
        // Sibling links: hovering one translation chunk in a multi-match group
        // should also highlight the others (they collectively form the unit).
        for (const a of cleaned) {
            for (const b of cleaned) addLink(a, b);
        }
    }
    
    cards.forEach(card => {
        card.addEventListener('mouseenter', () => {
            const chunkId = card.dataset.chunkId;
            if (!chunkId) return;
            
            // Highlight this card
            card.classList.add('highlighted');
            
            // Highlight all correlated cards
            const linked = correlationMap[chunkId];
            if (linked) {
                cards.forEach(c => {
                    if (linked.has(c.dataset.chunkId)) {
                        c.classList.add('highlighted');
                    }
                });
            }
        });
        
        card.addEventListener('mouseleave', () => {
            cards.forEach(c => c.classList.remove('highlighted'));
        });
    });
}

// ========== Vocab Tracker ==========

// Initialize the vocab tracker (loads HSK dictionary, renders grid)
async function initializeVocabTracker() {
    // Load the HSK dictionary if not already loaded
    if (Object.keys(allHskWords).length === 0) {
        try {
            const result = await window.electronAPI.getHskDictionary();
            if (result.success && result.words) {
                allHskWords = result.words;
                console.log(`HSK dictionary loaded: ${Object.keys(allHskWords).length} words`);
            } else {
                console.error('Failed to load HSK dictionary:', result.error);
                const grid = document.getElementById('vocab-tracker-grid');
                if (grid) grid.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Failed to load HSK dictionary.</p>';
                return;
            }
        } catch (err) {
            console.error('Error loading HSK dictionary:', err);
            const grid = document.getElementById('vocab-tracker-grid');
            if (grid) grid.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Error loading dictionary.</p>';
            return;
        }
    }
    renderVocabGrid();
}

// Render the GitHub-style vocab grid grouped by HSK level
function renderVocabGrid() {
    const gridContainer = document.getElementById('vocab-tracker-grid');
    const statsEl = document.getElementById('vocab-tracker-stats');
    if (!gridContainer) return;

    gridContainer.innerHTML = '';

    // Group words by HSK level (only levels 1-6)
    const levels = {};
    let totalWords = 0;
    let totalSeen = 0;

    for (const [word, level] of Object.entries(allHskWords)) {
        if (level < 1 || level > 6) continue; // Skip level 7 (above HSK 6)
        if (!levels[level]) levels[level] = [];
        levels[level].push(word);
        totalWords++;
        if (seenVocab[word] && seenVocab[word] > 0) totalSeen++;
    }

    // Update stats
    if (statsEl) {
        statsEl.textContent = `${totalSeen} / ${totalWords} words seen`;
    }

    // Render each level section
    const sortedLevels = Object.keys(levels).sort((a, b) => Number(a) - Number(b));

    for (const level of sortedLevels) {
        const words = levels[level].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        const seenCount = words.filter(w => seenVocab[w] && seenVocab[w] > 0).length;

        const section = document.createElement('div');
        section.className = 'vocab-level-section';

        // Level header with progress bar
        const header = document.createElement('div');
        header.className = 'vocab-level-header';
        const pct = words.length > 0 ? Math.round((seenCount / words.length) * 100) : 0;
        header.innerHTML = `
            <span class="vocab-level-label">HSK ${level}</span>
            <div class="vocab-level-bar"><div style="width: ${pct}%;"></div></div>
            <span class="vocab-level-count">${seenCount}/${words.length}</span>
        `;
        section.appendChild(header);

        // Grid of cells
        const grid = document.createElement('div');
        grid.className = 'vocab-grid';

        for (const word of words) {
            const count = seenVocab[word] || 0;
            const cell = document.createElement('div');
            cell.className = 'vocab-cell';

            // Length-based font sizing so the word fits inside the box
            const len = [...word].length;
            if (len === 1) cell.classList.add('len-1');
            else if (len === 2) cell.classList.add('len-2');
            else if (len === 3) cell.classList.add('len-3');
            else if (len === 4) cell.classList.add('len-4');
            else cell.classList.add('len-many');

            // Color intensity based on count
            if (count >= 10) cell.classList.add('seen-4');
            else if (count >= 5) cell.classList.add('seen-3');
            else if (count >= 2) cell.classList.add('seen-2');
            else if (count >= 1) cell.classList.add('seen-1');

            // Character visible inside the cell
            const charLabel = document.createElement('span');
            charLabel.className = 'vocab-cell-char';
            charLabel.textContent = word;
            cell.appendChild(charLabel);

            // Tooltip: enlarged char + pinyin (lazy) + count
            const tooltip = document.createElement('div');
            tooltip.className = 'vocab-cell-tooltip';
            const cachedPinyin = pinyinCache[word];
            const pinyinClass = cachedPinyin ? 'tooltip-pinyin' : 'tooltip-pinyin loading';
            const pinyinText = cachedPinyin || '…';
            tooltip.innerHTML = `
                <span class="tooltip-char">${word}</span>
                <span class="${pinyinClass}" data-word="${word}">${pinyinText}</span>
                <span class="tooltip-count">Seen ${count} time${count !== 1 ? 's' : ''}</span>
            `;
            cell.appendChild(tooltip);

            // Lazy-load pinyin on first hover
            cell.addEventListener('mouseenter', () => ensurePinyin(word, tooltip));

            // Click → show context modal
            cell.addEventListener('click', () => showVocabContextModal(word, count));

            grid.appendChild(cell);
        }

        section.appendChild(grid);
        gridContainer.appendChild(section);
    }
}

// Lazy-load pinyin for a word and update the hover tooltip in-place
async function ensurePinyin(word, tooltipEl) {
    if (pinyinCache[word]) return;
    try {
        const result = await window.electronAPI.getPinyin(word);
        if (result && result.success && result.pinyin) {
            pinyinCache[word] = result.pinyin;
            try { localStorage.setItem('pinyinCache', JSON.stringify(pinyinCache)); } catch (e) { /* quota */ }
            const span = tooltipEl && tooltipEl.querySelector(`.tooltip-pinyin[data-word="${word}"]`);
            if (span) {
                span.textContent = result.pinyin;
                span.classList.remove('loading');
            }
        }
    } catch (err) {
        console.error('Pinyin fetch failed for', word, err);
    }
}

// Show the vocab context modal for a clicked word
async function showVocabContextModal(word, count) {
    const modal = document.getElementById('vocab-context-modal');
    const wordEl = document.getElementById('vocab-context-word');
    const loading = document.getElementById('vocab-context-loading');
    const textEl = document.getElementById('vocab-context-text');
    const errorEl = document.getElementById('vocab-context-error');

    if (!modal) return;

    wordEl.textContent = `${word}  (Seen ${count} time${count !== 1 ? 's' : ''})`;
    modal.style.display = 'flex';
    loading.style.display = 'flex';
    textEl.style.display = 'none';
    errorEl.style.display = 'none';

    // Close handlers
    document.getElementById('vocab-context-close').onclick = () => { modal.style.display = 'none'; };
    document.querySelector('.vocab-context-overlay').onclick = () => { modal.style.display = 'none'; };

    // Check cache first
    if (vocabContextCache[word]) {
        textEl.textContent = vocabContextCache[word];
        loading.style.display = 'none';
        textEl.style.display = 'block';
        return;
    }

    try {
        const result = await window.electronAPI.generateVocabContext(word);
        if (result.success && result.context) {
            vocabContextCache[word] = result.context;
            textEl.textContent = result.context;
            loading.style.display = 'none';
            textEl.style.display = 'block';
        } else {
            throw new Error(result.error || 'No context received');
        }
    } catch (err) {
        console.error('Error generating vocab context:', err);
        loading.style.display = 'none';
        errorEl.style.display = 'block';
        errorEl.textContent = `Error: ${err.message || 'Failed to generate context.'}`;
    }
}

// ========== Tone Matching ==========

// Entry point when the user opens the Tone Matching view.
async function initializeToneMatchingView() {
    const micBtn = document.getElementById('tone-mic-btn');

    // Wire the mic toggle + device controls exactly once.
    if (!toneMatchingInitialized) {
        micBtn.addEventListener('click', toneToggleMic);

        const deviceSelect = document.getElementById('tone-device-select');
        if (deviceSelect) {
            deviceSelect.addEventListener('change', (e) => {
                const option = e.target.options[e.target.selectedIndex];
                toneMicDeviceId = e.target.value;
                toneMicDeviceType = (option && option.dataset.type) || 'input';
            });
        }

        const refreshBtn = document.getElementById('tone-refresh-devices');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                window.electronAPI.getAudioDevices(true);
            });
        }

        const skipBtn = document.getElementById('tone-skip-btn');
        if (skipBtn) {
            skipBtn.addEventListener('click', () => { setNewToneCharacter(); });
        }

        toneMatchingInitialized = true;
    }

    // Always start in the "off" state when entering the view.
    toneMicActive = false;
    toneSetListeningUI(false);

    // Reflect transcription-service readiness (reuses the shared health polling).
    updateToneReadinessUI();
    startTranscriptionReadyPolling();

    // Make sure the HSK dictionary is loaded (vocab tracker may not have run yet).
    if (Object.keys(allHskWords).length === 0) {
        try {
            const result = await window.electronAPI.getHskDictionary();
            if (result.success && result.words) allHskWords = result.words;
        } catch (err) {
            console.error('Tone matching: failed to load HSK dictionary', err);
        }
    }

    // Resolve a microphone device for the Python transcription backend.
    pickToneMicDevice();

    // Pick the first character to practice.
    await setNewToneCharacter();
}

// Return the list of words the learner has already encountered in the tracker.
function toneGetSeenWords() {
    return Object.keys(seenVocab).filter((w) => seenVocab[w] > 0);
}

// Populate the tone matching device <select> and resolve the active device.
// Preserves the user's current selection across refreshes when possible.
function populateToneDeviceSelect(devices) {
    const select = document.getElementById('tone-device-select');
    if (!select) return;

    const previousValue = toneMicDeviceId;
    select.innerHTML = '';

    // Tone matching practices the learner's own speech, so only list microphones
    // (input devices) here — speaker/loopback outputs are intentionally excluded.
    if (!devices || !devices.input || devices.input.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No microphones found';
        select.appendChild(option);
        toneMicDeviceId = null;
        return;
    }

    devices.input.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.id;
        option.textContent = device.name;
        option.dataset.type = device.type || 'input';
        select.appendChild(option);
    });

    // Decide which option to select.
    let selectedIndex = 0;
    let matched = false;

    // 1) Keep the user's previous selection if it still exists.
    if (previousValue != null && previousValue !== '') {
        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].value == previousValue) { selectedIndex = i; matched = true; break; }
        }
    }
    // 2) Otherwise prefer the cached default if it's a microphone.
    if (!matched && devices.defaultDeviceType === 'input' && devices.defaultDeviceId != null) {
        for (let i = 0; i < select.options.length; i++) {
            if (select.options[i].value == devices.defaultDeviceId) { selectedIndex = i; matched = true; break; }
        }
    }

    if (select.options.length > 0) {
        select.selectedIndex = selectedIndex;
        const selectedOption = select.options[selectedIndex];
        toneMicDeviceId = selectedOption.value;
        toneMicDeviceType = selectedOption.dataset.type || 'input';
    }
}

// Ask the backend for the device list (populated via the 'audio-devices' event).
async function pickToneMicDevice() {
    try {
        await window.electronAPI.getAudioDevices(false);
    } catch (err) {
        console.error('Tone matching: getAudioDevices failed', err);
    }

    // If devices were already cached from a previous request, populate now.
    if (lastAudioDevices) {
        populateToneDeviceSelect(lastAudioDevices);
    }
}

// Choose a new random character from the seen-vocab pool and display it.
async function setNewToneCharacter() {
    const display = document.getElementById('tone-display');
    const charEl = document.getElementById('tone-display-char');
    const pinyinEl = document.getElementById('tone-display-pinyin');
    const hintEl = document.getElementById('tone-mic-hint');

    // A fresh character always resets the wrong-answer streak.
    toneWrongStreak = 0;

    const seen = toneGetSeenWords();

    if (seen.length === 0) {
        toneTarget = null;
        charEl.textContent = '—';
        pinyinEl.innerHTML = '';
        if (hintEl) {
            hintEl.innerHTML = '<span class="tone-matching-empty">No vocab seen yet. Use <b>Subtitles and Translation</b> to encounter some words first, then come back to practice your tones.</span>';
        }
        return;
    }

    // Avoid immediately repeating the current character when possible.
    let word = seen[Math.floor(Math.random() * seen.length)];
    if (seen.length > 1 && toneTarget && word === toneTarget.word) {
        word = seen[Math.floor(Math.random() * seen.length)];
    }

    charEl.textContent = word;
    pinyinEl.textContent = '…';

    // Fetch the tone-aware pinyin breakdown for the target.
    let info = null;
    try {
        const result = await window.electronAPI.getPinyinInfo(word);
        if (result && result.success) info = result;
    } catch (err) {
        console.error('Tone matching: getPinyinInfo failed', err);
    }

    if (!info) {
        // Fall back to the plain pinyin string if the detailed call failed.
        const fallback = pinyinCache[word] || word;
        pinyinEl.textContent = fallback;
        toneTarget = { word, symbol: fallback, numArr: [], noToneArr: [], tones: [] };
    } else {
        pinyinEl.textContent = info.symbol;
        toneTarget = {
            word,
            symbol: info.symbol,
            numArr: info.numArr,
            noToneArr: info.noToneArr,
            tones: info.tones,
        };
    }

    // Re-trigger the swap-in animation.
    display.classList.remove('swap-in');
    void display.offsetWidth; // force reflow so the animation can restart
    display.classList.add('swap-in');

    if (hintEl && toneMicActive) {
        hintEl.textContent = 'Listening… say the character above';
    } else if (hintEl) {
        hintEl.textContent = 'Tap the mic, then say the character above';
    }
}

// Toggle the persistent microphone on/off.
async function toneToggleMic() {
    if (toneMicActive) {
        await toneStopListening();
    } else {
        await toneStartListening();
    }
}

async function toneStartListening() {
    if (toneMicActive) return;

    // Wait for the transcription service to finish loading.
    if (!transcriptionReady) {
        showToneToast('Still loading', 'The speech model is still loading. Please wait for the status to show <b>Ready</b>.', false);
        return;
    }

    if (!toneTarget) {
        // Nothing to practice yet.
        return;
    }

    if (!toneMicDeviceId) {
        await pickToneMicDevice();
        if (!toneMicDeviceId) {
            showToneToast('No microphone', 'Could not find a microphone input device. Please connect a mic and reopen this view.', false);
            return;
        }
    }

    // Force the transcription language to Mandarin Chinese so tone matching
    // always evaluates Chinese pinyin rather than auto-detecting another language.
    try {
        await window.electronAPI.setLanguage('zh');
    } catch (err) {
        console.error('Tone matching: setLanguage failed', err);
    }

    // Use a shorter audio buffer so single-syllable attempts are transcribed
    // quickly. (The transcription view keeps the default buffer length.)
    try {
        await window.electronAPI.setBufferDuration(TONE_BUFFER_MAX_DURATION);
    } catch (err) {
        console.error('Tone matching: setBufferDuration failed', err);
    }

    // Start the Python backend capturing from the selected device.
    const result = await window.electronAPI.startCapture(toneMicDeviceId, toneMicDeviceType);
    if (!result || !result.success) {
        showToneToast('Mic error', `Failed to start the microphone: ${(result && result.error) || 'unknown error'}`, false);
        return;
    }

    toneMicActive = true;
    toneSetListeningUI(true);

    // Start the local visualizer (independent getUserMedia stream).
    toneStartVisualizer();
}

async function toneStopListening() {
    // Always tear down the visualizer.
    toneStopVisualizer();

    if (toneMicActive) {
        try {
            await window.electronAPI.stopCapture();
        } catch (err) {
            console.error('Tone matching: stopCapture failed', err);
        }
        // Restore auto language detection so other views aren't locked to Chinese.
        try {
            await window.electronAPI.setLanguage('auto');
        } catch (err) {
            console.error('Tone matching: resetLanguage failed', err);
        }
        // Restore the default audio buffer length for the transcription view.
        try {
            await window.electronAPI.setBufferDuration(DEFAULT_BUFFER_MAX_DURATION);
        } catch (err) {
            console.error('Tone matching: resetBufferDuration failed', err);
        }
    }

    toneMicActive = false;
    toneSetListeningUI(false);
}

// Reflect listening state on the mic button + hint text.
function toneSetListeningUI(listening) {
    const micBtn = document.getElementById('tone-mic-btn');
    const hintEl = document.getElementById('tone-mic-hint');
    if (!micBtn) return;

    micBtn.classList.toggle('listening', listening);
    micBtn.setAttribute('aria-pressed', listening ? 'true' : 'false');
    micBtn.style.setProperty('--mic-level', '0');

    // Lock device selection while actively capturing (matches transcription view).
    const deviceSelect = document.getElementById('tone-device-select');
    const refreshBtn = document.getElementById('tone-refresh-devices');
    if (deviceSelect) deviceSelect.disabled = listening;
    if (refreshBtn) refreshBtn.disabled = listening;

    // Reflect capture state on the shared status badge.
    const statusEl = document.getElementById('tone-status');
    if (statusEl) {
        if (listening) {
            statusEl.textContent = 'Listening...';
            statusEl.className = 'status status-capturing';
        } else if (transcriptionReady) {
            statusEl.textContent = 'Ready';
            statusEl.className = 'status status-ready';
        } else {
            statusEl.textContent = 'Loading...';
            statusEl.className = 'status status-loading';
        }
    }

    if (hintEl && toneTarget) {
        hintEl.textContent = listening
            ? 'Listening… say the character above'
            : 'Tap the mic, then say the character above';
    }
}

// Use getUserMedia + an AnalyserNode purely to animate the waves with the live
// microphone level. Transcription itself is handled by the Python backend.
async function toneStartVisualizer() {
    try {
        toneMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        toneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = toneAudioCtx.createMediaStreamSource(toneMediaStream);
        toneAnalyser = toneAudioCtx.createAnalyser();
        toneAnalyser.fftSize = 512;
        source.connect(toneAnalyser);

        const buffer = new Uint8Array(toneAnalyser.frequencyBinCount);
        const micBtn = document.getElementById('tone-mic-btn');
        let smoothed = 0;

        const tick = () => {
            toneAnalyser.getByteTimeDomainData(buffer);
            // Compute RMS deviation from the 128 midpoint.
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) {
                const v = (buffer[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / buffer.length);
            // Scale + clamp into a pleasant 0..1 range for the rings.
            const level = Math.min(1, rms * 3.2);
            // Smooth so the waves feel organic rather than jittery.
            smoothed = smoothed * 0.8 + level * 0.2;
            if (micBtn) micBtn.style.setProperty('--mic-level', smoothed.toFixed(3));
            toneRafId = requestAnimationFrame(tick);
        };
        tick();
    } catch (err) {
        // Visualizer is non-essential; transcription still works without it.
        console.warn('Tone matching: visualizer unavailable', err);
    }
}

function toneStopVisualizer() {
    if (toneRafId) {
        cancelAnimationFrame(toneRafId);
        toneRafId = null;
    }
    if (toneMediaStream) {
        toneMediaStream.getTracks().forEach((t) => t.stop());
        toneMediaStream = null;
    }
    if (toneAudioCtx) {
        try { toneAudioCtx.close(); } catch (e) { /* already closed */ }
        toneAudioCtx = null;
    }
    toneAnalyser = null;
    const micBtn = document.getElementById('tone-mic-btn');
    if (micBtn) micBtn.style.setProperty('--mic-level', '0');
}

// Handle a transcription result while the Tone Matching view is active.
async function handleToneMatchingResult(data) {
    if (!toneMicActive || !toneTarget) return;
    if (toneBusy) return; // ignore overlapping results while we evaluate one

    const transcription = data && data.transcription;
    if (!transcription || !transcription.trim()) return;

    // Keep only Chinese characters from what was heard.
    const spokenChars = (transcription.match(/[\u4e00-\u9fff]/g) || []).join('');
    if (!spokenChars) return; // no Chinese detected; wait for the next utterance

    toneBusy = true;
    try {
        let spoken = null;
        try {
            const result = await window.electronAPI.getPinyinInfo(spokenChars);
            if (result && result.success) spoken = result;
        } catch (err) {
            console.error('Tone matching: getPinyinInfo (spoken) failed', err);
        }
        if (!spoken) return;

        const verdict = compareTonePinyin(toneTarget, spoken);

        if (verdict.match) {
            toneWrongStreak = 0;
            toneFlash('green');
            showToneToast(`Nice! ${toneTarget.symbol}`, `That matched <b>${toneTarget.word}</b>. Here's a new one.`, true);
            // Advance to a new character after the green flash.
            setTimeout(() => { setNewToneCharacter(); }, 700);
        } else {
            toneWrongStreak++;
            toneFlash('orange');

            if (toneWrongStreak >= TONE_MAX_WRONG) {
                // Too many misses in a row — move on to a new character.
                showToneToast('Let\'s move on', `That's ${TONE_MAX_WRONG} tries on <b>${toneTarget.symbol}</b>. Skipping to a new character — you can always revisit this one later.`, false, spoken.symbol);
                setTimeout(() => { setNewToneCharacter(); }, 900);
            } else {
                const remaining = TONE_MAX_WRONG - toneWrongStreak;
                const suffix = ` <span style="opacity:0.8;">(${remaining} more ${remaining === 1 ? 'try' : 'tries'} before skipping)</span>`;
                showToneToast('Keep practicing', verdict.feedback + suffix, false, spoken.symbol);
            }
        }
    } finally {
        // Brief cooldown so a single utterance doesn't trigger multiple verdicts.
        setTimeout(() => { toneBusy = false; }, 900);
    }
}

// Compare the spoken pinyin against the target. Returns { match, feedback }.
function compareTonePinyin(target, spoken) {
    const tNoTone = (target.noToneArr || []).map((s) => s.toLowerCase());
    const tTones = target.tones || [];
    const sNoTone = (spoken.noToneArr || []).map((s) => s.toLowerCase());
    const sTones = spoken.tones || [];

    // If we lack a structured target breakdown, fall back to a string compare.
    if (tNoTone.length === 0) {
        const match = (spoken.symbol || '').replace(/\s+/g, '') === (target.symbol || '').replace(/\s+/g, '');
        return { match, feedback: buildToneFeedback(target, spoken, null) };
    }

    // The learner may say extra surrounding syllables; look for the target as a
    // contiguous run inside what was heard (by base syllable).
    const startIdx = findSubsequenceStart(sNoTone, tNoTone);

    if (startIdx === -1) {
        // Wrong sound entirely.
        return { match: false, feedback: buildToneFeedback(target, spoken, null) };
    }

    // Same base syllables — now compare tones for that aligned window.
    const alignedTones = sTones.slice(startIdx, startIdx + tTones.length);
    let toneMismatchIndex = -1;
    for (let i = 0; i < tTones.length; i++) {
        if (alignedTones[i] !== tTones[i]) {
            toneMismatchIndex = i;
            break;
        }
    }

    if (toneMismatchIndex === -1) {
        return { match: true, feedback: '' };
    }

    return {
        match: false,
        feedback: buildToneFeedback(target, spoken, { index: toneMismatchIndex, expected: tTones[toneMismatchIndex], got: alignedTones[toneMismatchIndex] }),
    };
}

// Find where `needle` (base syllables) starts within `haystack`, or -1.
function findSubsequenceStart(haystack, needle) {
    if (needle.length === 0) return -1;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
        let ok = true;
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) { ok = false; break; }
        }
        if (ok) return i;
    }
    return -1;
}

// Human-readable description of a Mandarin tone.
function describeTone(n) {
    switch (n) {
        case 1: return { name: '1st tone (high & level)', tip: 'Hold it high and flat, like singing a steady note.' };
        case 2: return { name: '2nd tone (rising)', tip: 'Glide upward, like asking “huh?”.' };
        case 3: return { name: '3rd tone (dipping)', tip: 'Dip your voice low, then let it rise back up.' };
        case 4: return { name: '4th tone (falling)', tip: 'Drop sharply from high to low, like a firm command.' };
        default: return { name: 'neutral tone', tip: 'Say it light, short and unstressed.' };
    }
}

// Craft corrective feedback text for the mismatch toast.
function buildToneFeedback(target, spoken, toneInfo) {
    const heard = spoken && spoken.symbol ? spoken.symbol : '(unclear)';

    if (toneInfo) {
        // Same syllable, wrong tone — give targeted tone coaching.
        const want = describeTone(toneInfo.expected);
        const got = describeTone(toneInfo.got);
        const syl = (target.noToneArr && target.noToneArr[toneInfo.index]) || '';
        return `Right sound, wrong tone. I heard <b>${heard}</b> (${got.name}), but <b>${target.symbol}</b> needs the <b>${want.name}</b>${syl ? ` on “${syl}”` : ''}. ${want.tip}`;
    }

    // Wrong pronunciation overall.
    return `I heard <b>${heard}</b>, but the target is <b>${target.symbol}</b> (${target.word}). Listen for the initial and final sounds, then try again slowly.`;
}

// Flash the mic button green (match) or orange (mismatch).
function toneFlash(type) {
    const micBtn = document.getElementById('tone-mic-btn');
    if (!micBtn) return;
    const cls = type === 'green' ? 'flash-green' : 'flash-orange';
    micBtn.classList.remove('flash-green', 'flash-orange');
    void micBtn.offsetWidth; // restart animation if same class re-applied
    micBtn.classList.add(cls);
    setTimeout(() => micBtn.classList.remove(cls), 950);
}

// Show a feedback toast on the right side. `success` toggles the green accent.
function showToneToast(title, bodyHtml, success, pinyin) {
    const container = document.getElementById('tone-toast-container');
    if (!container) return;

    const id = ++toneToastSeq;
    const toast = document.createElement('div');
    toast.className = `tone-toast${success ? ' toast-success' : ''}`;
    toast.dataset.id = String(id);
    toast.innerHTML = `
        <div class="tone-toast-title">${title}${pinyin ? ` <span class="tone-toast-pinyin">${pinyin}</span>` : ''}</div>
        <div class="tone-toast-body">${bodyHtml}</div>
    `;
    container.appendChild(toast);

    // Animate in.
    requestAnimationFrame(() => toast.classList.add('show'));

    // Limit how many toasts stack up.
    while (container.children.length > 4) {
        container.removeChild(container.firstChild);
    }

    // Auto-dismiss.
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
    }, success ? 3000 : 7000);
}

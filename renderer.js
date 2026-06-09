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
let currentView = 'menu'; // 'menu' or 'transcription'
let transcriptionViewInitialized = false; // one-time listener/UI setup guard

// Transcription service readiness (server has loaded the SenseVoice model)
let transcriptionReady = false;
let transcriptionReadyPollTimer = null;

// Vocab tracker state
let seenVocab = JSON.parse(localStorage.getItem('seenVocab') || '{}'); // { word: count }
let allHskWords = {}; // { word: hskLevel } loaded from local JSON
let vocabContextCache = {}; // Cache for Ollama-generated contexts
let pinyinCache = JSON.parse(localStorage.getItem('pinyinCache') || '{}'); // { word: pinyinString }
let vocabSearchQuery = ''; // Current vocab tracker search text
let allPinyinLoaded = false; // Whether pinyin for every HSK word has been fetched (for pinyin search)

function showMenuView() {
    document.getElementById('menu-view').style.display = 'flex';
    document.getElementById('transcription-view').style.display = 'none';
    currentView = 'menu';
    // Refresh vocab tracker when returning to menu
    initializeVocabTracker();
}

function showTranscriptionView() {
    document.getElementById('menu-view').style.display = 'none';
    document.getElementById('transcription-view').style.display = 'flex';
    currentView = 'transcription';
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
    
    // Setup menu navigation
    document.getElementById('subtitles-translation-btn').addEventListener('click', () => {
        showTranscriptionView();
        // Initialize transcription view components when first shown
        initializeTranscriptionView();
    });
    
    // Back button (always wire up, it's in the transcription view)
    document.getElementById('back-btn').addEventListener('click', async () => {
        // Stop capture if active before navigating back
        if (isCapturing) {
            await stopCapture();
        }
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
        return;
    }

    if (!isCapturing) updateStatus('Loading...', 'loading');

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
        return;
    }

    if (!isCapturing) updateStatus('Loading...', 'loading');
    transcriptionReadyPollTimer = setTimeout(pollTranscriptionReady, 1000);
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
        handleTranscriptionResult(data);
    });
    
    window.electronAPI.onError((error) => {
        console.error('Error:', error);
        updateStatus('Error: ' + error, 'stopped');
    });
    
    window.electronAPI.onAudioDevices((devices) => {
        populateDeviceSelect(devices);
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
    setupVocabSearch();
    renderVocabGrid();
}

// Normalize pinyin/latin text for searching: strip tone marks (and ü diaeresis)
// via Unicode decomposition, remove spaces, and lowercase. E.g. "xuè" -> "xue".
function normalizePinyin(str) {
    return (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}

// True if the string contains any Chinese (CJK) characters.
function hasChineseChars(str) {
    return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(str);
}

// Fetch pinyin for every HSK word (levels 1-6) in one batch so that pinyin
// search can match words the user has never hovered. Runs at most once.
async function ensureAllPinyin() {
    if (allPinyinLoaded) return;
    const missing = Object.entries(allHskWords)
        .filter(([word, level]) => level >= 1 && level <= 6 && !pinyinCache[word])
        .map(([word]) => word);

    if (missing.length === 0) {
        allPinyinLoaded = true;
        return;
    }

    try {
        const result = await window.electronAPI.getPinyinBatch(missing);
        if (result && result.success && result.pinyin) {
            Object.assign(pinyinCache, result.pinyin);
            try { localStorage.setItem('pinyinCache', JSON.stringify(pinyinCache)); } catch (e) { /* quota */ }
        }
    } catch (err) {
        console.error('Batch pinyin fetch failed:', err);
    }
    allPinyinLoaded = true;
}

// Wire up the vocab search input + clear button (idempotent).
function setupVocabSearch() {
    const input = document.getElementById('vocab-search-input');
    const clearBtn = document.getElementById('vocab-search-clear');
    if (!input || input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';

    input.addEventListener('input', async () => {
        const raw = input.value.trim();
        vocabSearchQuery = raw;
        if (clearBtn) clearBtn.style.display = raw ? 'block' : 'none';

        // A latin/pinyin query needs pinyin for all words, so load them once.
        if (raw && !hasChineseChars(raw) && !allPinyinLoaded) {
            await ensureAllPinyin();
            // Bail if the query changed while we were loading.
            if (input.value.trim() !== raw) return;
        }
        renderVocabGrid();
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            input.value = '';
            vocabSearchQuery = '';
            clearBtn.style.display = 'none';
            renderVocabGrid();
            input.focus();
        });
    }
}

// Decide whether a word matches the current search query. Empty query = match all.
// Chinese queries match against the character; latin queries match against the
// tone-stripped ("normalized") pinyin.
function vocabMatchesSearch(word) {
    const query = vocabSearchQuery;
    if (!query) return true;

    if (hasChineseChars(query)) {
        return word.includes(query);
    }

    const normalizedQuery = normalizePinyin(query);
    if (!normalizedQuery) return true;
    const normalizedPinyin = normalizePinyin(pinyinCache[word] || '');
    return normalizedPinyin.includes(normalizedQuery);
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

    let matchedWords = 0;

    for (const [word, level] of Object.entries(allHskWords)) {
        if (level < 1 || level > 6) continue; // Skip level 7 (above HSK 6)
        totalWords++;
        if (seenVocab[word] && seenVocab[word] > 0) totalSeen++;
        if (!vocabMatchesSearch(word)) continue; // Apply search filter
        if (!levels[level]) levels[level] = [];
        levels[level].push(word);
        matchedWords++;
    }

    // Update stats
    if (statsEl) {
        statsEl.textContent = vocabSearchQuery
            ? `${matchedWords} match${matchedWords !== 1 ? 'es' : ''} · ${totalSeen} / ${totalWords} words seen`
            : `${totalSeen} / ${totalWords} words seen`;
    }

    // Nothing matched the search → show an empty state.
    if (vocabSearchQuery && matchedWords === 0) {
        const empty = document.createElement('div');
        empty.className = 'vocab-search-empty';
        empty.textContent = `No words match “${vocabSearchQuery}”.`;
        gridContainer.appendChild(empty);
        return;
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

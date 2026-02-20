// Main renderer process logic
let config = null;
let isCapturing = false;
let transcriptionPairs = [];
let selectedDeviceId = null;
let selectedDeviceType = 'input'; // 'input' or 'output'
let selectedLanguage = 'auto';
let volumeThreshold = 0.0001;
let detectedLanguage = 'auto';
let fontSize = 15; // Default font size in pixels
let isUserScrolling = false; // Track if user is manually scrolling
let isAtBottom = true; // Track if user is at the bottom
let scrollSyncTimeout = null; // Timeout for scroll sync
let scrollSyncRaf = null; // RequestAnimationFrame ID for scroll sync
let pendingScrollUpdate = false; // Flag to prevent multiple RAF calls

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Initializing Language Learning Assistant...');
    
    // Load config
    config = await window.electronAPI.getConfig();
    volumeThreshold = config.volumeThreshold;
    
    // Load saved font size from localStorage
    const savedFontSize = localStorage.getItem('fontSize');
    if (savedFontSize) {
        fontSize = parseInt(savedFontSize, 10);
    }
    applyFontSize();
    
    // Setup UI
    setupEventListeners();
    setupElectronListeners();
    await loadAudioDevices();
    
    // Update threshold slider
    document.getElementById('volume-threshold').value = volumeThreshold;
    updateThresholdDisplay();
    
    console.log('Application window ready. Starting main loop...');
});

// Setup event listeners
function setupEventListeners() {
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
    
    // Zoom with Ctrl+scroll
    const contentArea = document.querySelector('.content-area');
    contentArea.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -2 : 2;
            fontSize = Math.max(10, Math.min(50, fontSize + delta));
            applyFontSize();
            localStorage.setItem('fontSize', fontSize.toString());
            // Update display to apply new font size
            updateDisplay();
        }
    }, { passive: false });
    
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
}

// Setup Electron IPC listeners
function setupElectronListeners() {
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
        // Add input devices
        if (devices.input.length > 0) {
            const inputGroup = document.createElement('optgroup');
            inputGroup.label = 'Microphones';
            devices.input.forEach((device) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name;
                option.dataset.type = 'input';
                inputGroup.appendChild(option);
            });
            select.appendChild(inputGroup);
        }
        
        // Add output devices
        if (devices.output.length > 0) {
            const outputGroup = document.createElement('optgroup');
            outputGroup.label = 'Speaker Output (Loopback)';
            devices.output.forEach((device) => {
                const option = document.createElement('option');
                option.value = device.id;
                option.textContent = device.name;
                option.dataset.type = 'output';
                outputGroup.appendChild(option);
            });
            select.appendChild(outputGroup);
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
        updateUI();
        updateStatus('Stopped', 'stopped');
    }
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
    
    // Add transcription pair
    transcriptionPairs.push({ transcription, translation: '' });
    
    // Translate
    translateText(transcription, transcriptionPairs.length - 1);
    
    // Update display
    updateDisplay();
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
    
    pairsToShow.forEach((pair, index) => {
        // Create pair wrapper for transcription
        const transcriptionPairWrapper = document.createElement('div');
        transcriptionPairWrapper.className = 'pair-wrapper';
        
        const transcriptionEl = document.createElement('div');
        transcriptionEl.className = 'pair-transcription';
        transcriptionEl.textContent = pair.transcription || '';
        transcriptionEl.style.fontSize = `${fontSize}px`;
        
        transcriptionPairWrapper.appendChild(transcriptionEl);
        transcriptionContainer.appendChild(transcriptionPairWrapper);
        
        // Create pair wrapper for translation
        const translationPairWrapper = document.createElement('div');
        translationPairWrapper.className = 'pair-wrapper';
        
        const translationEl = document.createElement('div');
        translationEl.className = 'pair-translation';
        translationEl.textContent = pair.translation || '';
        translationEl.style.fontSize = `${fontSize}px`;
        
        translationPairWrapper.appendChild(translationEl);
        translationContainer.appendChild(translationPairWrapper);
        
        // Store references for height calculation
        pairWrappers.push({
            transcription: { wrapper: transcriptionPairWrapper, element: transcriptionEl },
            translation: { wrapper: translationPairWrapper, element: translationEl },
            index: index
        });
    });
    
    // Calculate heights and apply spacing after DOM is updated
    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
        recalculatePairHeights(pairWrappers);
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
    
    // Auto-scroll only if user is at the bottom
    if (isAtBottom) {
        // Use requestAnimationFrame to ensure DOM is fully updated
        requestAnimationFrame(() => {
            // Temporarily disable scroll sync to prevent recursive events
            isUserScrolling = true;
            transcriptionContainer.scrollTop = transcriptionContainer.scrollHeight;
            translationContainer.scrollTop = translationContainer.scrollHeight;
            // Update isAtBottom flag after scrolling
            isAtBottom = true;
            // Re-enable scroll sync after a brief delay
            setTimeout(() => {
                isUserScrolling = false;
            }, 50);
        });
    }
}


// Update UI state
function updateUI() {
    document.getElementById('start-btn').disabled = isCapturing;
    document.getElementById('stop-btn').disabled = !isCapturing;
    document.getElementById('device-select').disabled = isCapturing;
    document.getElementById('language-select').disabled = isCapturing;
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

// Apply font size to text content
function applyFontSize() {
    // Font size is now applied directly in updateDisplay()
    // This function is kept for compatibility but the actual application
    // happens when we update the display
    const pairElements = document.querySelectorAll('.pair-transcription, .pair-translation');
    pairElements.forEach(el => {
        el.style.fontSize = `${fontSize}px`;
    });
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

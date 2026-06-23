/**
 * Cloud vocab sync for Electron renderer.
 * Keeps localStorage as offline draft; syncs to cloud API via main-process IPC.
 */

const VOCAB_SYNC_DEBOUNCE_MS = 5 * 60 * 1000;

let syncState = {
  initialized: false,
  dirty: false,
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null,
  getSeenVocab: null,
  setSeenVocab: null,
  refreshVocabUI: null,
};

function mergeOnLogin(remote, local) {
  const merged = { ...local };
  for (const [word, count] of Object.entries(remote || {})) {
    const localCount = merged[word] ?? 0;
    const remoteCount = typeof count === 'number' ? count : 0;
    merged[word] = Math.max(localCount, remoteCount);
  }
  return merged;
}

function isCloudSyncEnabled() {
  return typeof window.electronAPI?.vocabSyncPull === 'function';
}

function markVocabDirty() {
  if (!syncState.initialized) return;
  syncState.dirty = true;
}

async function pullAndMergeOnLogin() {
  if (!isCloudSyncEnabled()) return;

  const authStatus = await window.electronAPI.getAuthStatus();
  if (!authStatus?.signedIn || !authStatus?.cloudConfigured) return;

  try {
    const result = await window.electronAPI.vocabSyncPull();
    if (!result?.success) {
      syncState.lastSyncError = result?.error || 'Pull failed';
      return;
    }

    const local = syncState.getSeenVocab();
    const merged = mergeOnLogin(result.seenVocab || {}, local);
    syncState.setSeenVocab(merged);
    syncState.dirty = false;
    syncState.lastSyncAt = result.updatedAt || new Date().toISOString();
    syncState.lastSyncError = null;

    if (syncState.refreshVocabUI) {
      syncState.refreshVocabUI();
    }
    updateAccountStatusUI();
  } catch (err) {
    syncState.lastSyncError = err.message || 'Pull failed';
    updateAccountStatusUI();
  }
}

async function pushVocabToCloud() {
  if (!isCloudSyncEnabled() || syncState.syncing) return { success: false };

  const authStatus = await window.electronAPI.getAuthStatus();
  if (!authStatus?.signedIn || !authStatus?.cloudConfigured) {
    return { success: false, skipped: true };
  }

  if (!syncState.dirty) {
    return { success: true, skipped: true };
  }

  syncState.syncing = true;
  try {
    const seenVocab = syncState.getSeenVocab();
    const result = await window.electronAPI.vocabSyncPush(seenVocab);
    if (result?.success) {
      syncState.dirty = false;
      syncState.lastSyncAt = result.updatedAt || new Date().toISOString();
      syncState.lastSyncError = null;
      updateAccountStatusUI();
      return { success: true };
    }

    syncState.lastSyncError = result?.error || 'Push failed';
    updateAccountStatusUI();
    return { success: false, error: syncState.lastSyncError };
  } catch (err) {
    syncState.lastSyncError = err.message || 'Push failed';
    updateAccountStatusUI();
    return { success: false, error: syncState.lastSyncError };
  } finally {
    syncState.syncing = false;
  }
}

let debounceTimer = null;

function scheduleDebouncedSync() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (syncState.dirty) {
      pushVocabToCloud();
    }
  }, VOCAB_SYNC_DEBOUNCE_MS);
}

function formatSyncTime(iso) {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function updateAccountStatusUI() {
  const emailEl = document.getElementById('account-email');
  const statusEl = document.getElementById('account-sync-status');
  const signInBtn = document.getElementById('account-sign-in-btn');
  const signOutBtn = document.getElementById('account-sign-out-btn');

  if (!emailEl || !statusEl) return;

  const authStatus = await window.electronAPI.getAuthStatus();
  const signedIn = authStatus?.signedIn;
  const cloudConfigured = authStatus?.cloudConfigured;

  if (signInBtn) signInBtn.style.display = signedIn ? 'none' : 'inline-block';
  if (signOutBtn) signOutBtn.style.display = signedIn ? 'inline-block' : 'none';

  if (!cloudConfigured) {
    emailEl.textContent = 'Cloud sync not configured';
    statusEl.textContent = '';
    return;
  }

  if (signedIn) {
    emailEl.textContent = authStatus.email || 'Signed in';
    let status = `Last sync: ${formatSyncTime(syncState.lastSyncAt)}`;
    if (syncState.lastSyncError) {
      status += ` (${syncState.lastSyncError})`;
    }
    if (authStatus.cloudReachable === true) {
      status += ' · Cloud online';
    } else if (authStatus.cloudReachable === false) {
      status += ' · Cloud offline';
    }
    statusEl.textContent = status;
  } else {
    emailEl.textContent = 'Not signed in';
    statusEl.textContent = 'Vocab saved locally only';
  }
}

async function refreshCloudReachability() {
  if (!window.electronAPI.pingCloudHealth) return;
  try {
    await window.electronAPI.pingCloudHealth();
  } catch { /* ignore */ }
  updateAccountStatusUI();
}

function initVocabSync(hooks) {
  syncState.getSeenVocab = hooks.getSeenVocab;
  syncState.setSeenVocab = hooks.setSeenVocab;
  syncState.refreshVocabUI = hooks.refreshVocabUI || null;
  syncState.initialized = true;

  if (window.electronAPI.onVocabSyncRequest) {
    window.electronAPI.onVocabSyncRequest(async () => {
      try {
        await pushVocabToCloud();
      } finally {
        await window.electronAPI.notifyVocabSyncComplete();
      }
    });
  }

  pullAndMergeOnLogin();
  refreshCloudReachability();

  setInterval(() => {
    if (syncState.dirty) {
      pushVocabToCloud();
    }
  }, VOCAB_SYNC_DEBOUNCE_MS);
}

function setupAccountUI() {
  const signInBtn = document.getElementById('account-sign-in-btn');
  const signOutBtn = document.getElementById('account-sign-out-btn');
  const statusEl = document.getElementById('account-sync-status');

  if (signInBtn) {
    signInBtn.addEventListener('click', async () => {
      signInBtn.disabled = true;
      try {
        const result = await window.electronAPI.signIn();
        if (!result?.success) {
          console.warn('[Account] Sign in failed:', result?.error);
        } else if (statusEl) {
          statusEl.textContent =
            'Complete sign-in in your browser, then allow Open LinguaCoda';
        }
      } finally {
        signInBtn.disabled = false;
      }
    });
  }

  if (window.electronAPI.onAuthStateChanged) {
    window.electronAPI.onAuthStateChanged(async (data) => {
      if (data?.error) {
        syncState.lastSyncError = data.error;
      }
      if (data?.signedIn) {
        await pullAndMergeOnLogin();
      }
      updateAccountStatusUI();
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await pushVocabToCloud();
      await window.electronAPI.signOut();
      updateAccountStatusUI();
    });
  }

  updateAccountStatusUI();
}

window.VocabSync = {
  initVocabSync,
  setupAccountUI,
  markVocabDirty,
  scheduleDebouncedSync,
  mergeOnLogin,
  pushVocabToCloud,
  pullAndMergeOnLogin,
  updateAccountStatusUI,
};

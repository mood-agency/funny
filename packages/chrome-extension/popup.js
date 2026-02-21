/**
 * Funny UI Annotator - Popup Script
 *
 * Controls:
 * - Activate/deactivate annotator on the current page
 * - Display annotation list
 * - Configure Funny server connection, project, model
 * - Test connection
 */

const $ = (sel) => document.querySelector(sel);

// Elements
const connectionDot = $('#connectionDot');
const activateBtn = $('#activateBtn');
const annotationList = $('#annotationList');
const serverUrlInput = $('#serverUrl');
const projectSelect = $('#projectSelect');
const modelSelect = $('#modelSelect');
const modeSelect = $('#modeSelect');
const testConnectionBtn = $('#testConnectionBtn');
const statusBar = $('#statusBar');
const statusText = $('#statusText');

let isAnnotatorActive = false;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Load config
  const config = await sendMessage({ type: 'GET_CONFIG' });
  serverUrlInput.value = config.serverUrl || 'http://localhost:3001';
  modelSelect.value = config.model || 'sonnet';
  modeSelect.value = config.mode || 'local';

  // Get state from content script
  try {
    const state = await sendToActiveTab({ type: 'GET_STATE' });
    isAnnotatorActive = state?.active || false;
    updateActivateButton();
    if (state?.annotations?.length) {
      renderAnnotationList(state.annotations);
    }
  } catch (_) {
    // Content script not loaded yet
  }

  // Load projects
  await loadProjects(config.projectId);

  // Auto-test connection
  await testConnection(false);
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
activateBtn.addEventListener('click', async () => {
  try {
    const response = await sendToActiveTab({ type: 'TOGGLE_ANNOTATOR' });
    isAnnotatorActive = response?.active || false;
    updateActivateButton();
  } catch (_) {
    setStatus('Cannot activate on this page', 'error');
  }
});

testConnectionBtn.addEventListener('click', () => testConnection(true));

// Save config on change
serverUrlInput.addEventListener('change', () => saveCurrentConfig());
projectSelect.addEventListener('change', () => saveCurrentConfig());
modelSelect.addEventListener('change', () => saveCurrentConfig());
modeSelect.addEventListener('change', () => saveCurrentConfig());

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
function updateActivateButton() {
  if (isAnnotatorActive) {
    activateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
        <line x1="9" y1="9" x2="15" y2="15"></line>
        <line x1="15" y1="9" x2="9" y2="15"></line>
      </svg>
      Stop Annotating
    `;
    activateBtn.classList.remove('btn-primary');
    activateBtn.classList.add('btn-secondary');
  } else {
    activateBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="16"></line>
        <line x1="8" y1="12" x2="16" y2="12"></line>
      </svg>
      Start Annotating
    `;
    activateBtn.classList.remove('btn-secondary');
    activateBtn.classList.add('btn-primary');
  }
}

function renderAnnotationList(annotations) {
  if (!annotations || annotations.length === 0) {
    annotationList.innerHTML = '<div class="empty-state">No annotations yet. Click "Start Annotating" and select elements on the page.</div>';
    return;
  }

  annotationList.innerHTML = annotations.map((ann, i) => `
    <div class="annotation-item">
      <div class="annotation-number">${i + 1}</div>
      <div class="annotation-info">
        <div class="annotation-name">${escapeHtml(ann.elementName)}</div>
        ${ann.comment ? `<div class="annotation-comment">${escapeHtml(ann.comment)}</div>` : ''}
        <div class="annotation-badges">
          <span class="annotation-badge ${ann.intent}">${ann.intent}</span>
          <span class="annotation-badge ${ann.severity}">${ann.severity}</span>
        </div>
      </div>
    </div>
  `).join('');
}

async function loadProjects(selectedProjectId) {
  try {
    const result = await sendMessage({ type: 'FETCH_PROJECTS' });
    if (!result.success) throw new Error(result.error);

    const projects = result.projects;
    projectSelect.innerHTML = '<option value="">Select a project...</option>';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === selectedProjectId) opt.selected = true;
      projectSelect.appendChild(opt);
    });
  } catch (err) {
    projectSelect.innerHTML = '<option value="">Failed to load projects</option>';
  }
}

async function testConnection(showFeedback) {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) return;

  if (showFeedback) {
    setStatus('Connecting...', '');
  }

  const result = await sendMessage({ type: 'TEST_CONNECTION', serverUrl });

  if (result.success) {
    connectionDot.className = 'connection-dot connected';
    connectionDot.title = 'Connected';
    setStatus('Connected to Funny', 'success');
    // Reload projects with new URL
    await saveCurrentConfig();
    await loadProjects(projectSelect.value);
  } else {
    connectionDot.className = 'connection-dot error';
    connectionDot.title = 'Connection failed';
    setStatus(`Connection failed: ${result.error}`, 'error');
  }
}

async function saveCurrentConfig() {
  await sendMessage({
    type: 'SAVE_CONFIG',
    config: {
      serverUrl: serverUrlInput.value.trim(),
      projectId: projectSelect.value,
      model: modelSelect.value,
      mode: modeSelect.value
    }
  });
}

function setStatus(message, type) {
  statusText.textContent = message;
  statusBar.className = `status-bar ${type || ''}`;
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || {});
    });
  });
}

function sendToActiveTab(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) return reject(new Error('No active tab'));
      chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

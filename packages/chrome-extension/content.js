/**
 * Funny UI Annotator - Content Script
 *
 * Injects an overlay system into any webpage that lets users:
 * 1. Hover over elements to see highlights with element names
 * 2. Click to select and annotate elements
 * 3. Add comments with intent/severity
 * 4. Send all annotations to Funny via the background worker
 *
 * Uses Shadow DOM to isolate styles from the host page.
 */

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__funnyAnnotatorActive) return;
  window.__funnyAnnotatorActive = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let isActive = false;
  let annotations = [];
  let annotationCounter = 0;
  let hoveredElement = null;
  let isPaused = false;
  let annotationsVisible = true;

  // DOM refs (created once, reused)
  let shadowHost = null;
  let shadowRoot = null;
  let toolbar = null;
  let hoverHighlight = null;
  let hoverLabel = null;
  let popover = null;
  let badgeContainer = null;
  let highlightContainer = null;

  // ---------------------------------------------------------------------------
  // Shadow DOM setup
  // ---------------------------------------------------------------------------
  function createShadowHost() {
    shadowHost = document.createElement('div');
    shadowHost.id = 'funny-annotator-host';
    shadowHost.style.cssText = 'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647; pointer-events:none;';
    document.documentElement.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getStyles();
    shadowRoot.appendChild(style);

    // Containers
    highlightContainer = createElement('div', 'highlight-container');
    badgeContainer = createElement('div', 'badge-container');
    shadowRoot.appendChild(highlightContainer);
    shadowRoot.appendChild(badgeContainer);

    // Hover highlight
    hoverHighlight = createElement('div', 'hover-highlight');
    hoverLabel = createElement('div', 'hover-label');
    hoverHighlight.appendChild(hoverLabel);
    shadowRoot.appendChild(hoverHighlight);

    // Popover (hidden by default)
    popover = createPopover();
    shadowRoot.appendChild(popover);

    // Toolbar
    toolbar = createToolbar();
    shadowRoot.appendChild(toolbar);
  }

  function createElement(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Element info extraction
  // ---------------------------------------------------------------------------
  function getElementName(el) {
    // Try React component name first
    const reactName = getReactComponentName(el);
    if (reactName) return reactName;

    // Fallback: tag + class or id
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.split(/\s+/).filter(c => c && !c.startsWith('funny-')).slice(0, 2).join('.');
      if (cls) return `${tag}.${cls}`;
    }
    // Aria / role
    const role = el.getAttribute('role');
    if (role) return `${tag}[role="${role}"]`;
    // Use text content for small elements
    const text = el.textContent?.trim();
    if (text && text.length < 30 && text.length > 0) return `${tag} "${text.slice(0, 20)}"`;
    return tag;
  }

  function getReactComponentName(el) {
    try {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!key) return null;
      let fiber = el[key];
      // Walk up fiber tree to find named component
      while (fiber) {
        if (fiber.type && typeof fiber.type === 'function') {
          return fiber.type.displayName || fiber.type.name || null;
        }
        if (fiber.type && typeof fiber.type === 'object' && fiber.type.displayName) {
          return fiber.type.displayName;
        }
        fiber = fiber.return;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function getCSSSelector(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('funny-')).slice(0, 2);
        if (classes.length) selector += `.${classes.join('.')}`;
      }
      // Add nth-child if needed for disambiguation
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getComputedStylesSummary(el) {
    const cs = window.getComputedStyle(el);
    const props = [
      'display', 'position', 'width', 'height',
      'margin', 'padding',
      'font-family', 'font-size', 'font-weight', 'line-height',
      'color', 'background-color',
      'border', 'border-radius',
      'opacity', 'overflow',
      'flex-direction', 'justify-content', 'align-items', 'gap'
    ];
    return props
      .map(p => {
        const v = cs.getPropertyValue(p);
        if (!v || v === 'none' || v === 'normal' || v === 'auto' || v === '0px' || v === 'rgba(0, 0, 0, 0)') return null;
        return `${p}: ${v}`;
      })
      .filter(Boolean)
      .join('; ');
  }

  function getAccessibilityInfo(el) {
    const info = [];
    const role = el.getAttribute('role');
    if (role) info.push(`role="${role}"`);
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) info.push(`aria-label="${ariaLabel}"`);
    const ariaDescribedby = el.getAttribute('aria-describedby');
    if (ariaDescribedby) info.push(`aria-describedby="${ariaDescribedby}"`);
    const tabindex = el.getAttribute('tabindex');
    if (tabindex) info.push(`tabindex="${tabindex}"`);
    const alt = el.getAttribute('alt');
    if (alt) info.push(`alt="${alt}"`);
    return info.join(', ') || 'none';
  }

  function getNearbyText(el) {
    const texts = [];
    const prev = el.previousElementSibling;
    if (prev?.textContent?.trim()) texts.push(prev.textContent.trim().slice(0, 40));
    const own = el.textContent?.trim();
    if (own) texts.push(own.slice(0, 60));
    const next = el.nextElementSibling;
    if (next?.textContent?.trim()) texts.push(next.textContent.trim().slice(0, 40));
    return texts.join(' | ') || 'none';
  }

  // ---------------------------------------------------------------------------
  // Hover highlight
  // ---------------------------------------------------------------------------
  function showHoverHighlight(el) {
    if (!el || el === hoveredElement) return;
    hoveredElement = el;
    const rect = el.getBoundingClientRect();
    hoverHighlight.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      display: block;
      pointer-events: none;
    `;
    hoverLabel.textContent = getElementName(el);
  }

  function hideHoverHighlight() {
    hoveredElement = null;
    hoverHighlight.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Annotation highlights + badges (persistent, for annotated elements)
  // ---------------------------------------------------------------------------
  function renderAnnotations() {
    highlightContainer.innerHTML = '';
    badgeContainer.innerHTML = '';

    if (!annotationsVisible) return;

    annotations.forEach((ann, i) => {
      const el = ann._element;
      if (!el || !document.contains(el)) return;
      const rect = el.getBoundingClientRect();

      // Persistent highlight (green dashed border like Agentation)
      const hl = createElement('div', 'annotation-highlight');
      hl.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        pointer-events: none;
      `;
      highlightContainer.appendChild(hl);

      // Badge
      const badge = createElement('div', 'annotation-badge');
      badge.textContent = String(i + 1);
      badge.style.cssText = `
        position: fixed;
        top: ${rect.top - 10}px;
        left: ${rect.right - 10}px;
        pointer-events: auto;
        cursor: pointer;
      `;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        showPopoverForEdit(ann, i);
      });
      badgeContainer.appendChild(badge);
    });
  }

  // Reposition on scroll/resize
  function onScrollOrResize() {
    if (isActive) renderAnnotations();
  }

  // ---------------------------------------------------------------------------
  // Popover (annotation form)
  // ---------------------------------------------------------------------------
  function createPopover() {
    const pop = createElement('div', 'popover');
    pop.style.display = 'none';
    pop.innerHTML = `
      <div class="popover-header">
        <span class="popover-element-name"></span>
      </div>
      <textarea class="popover-textarea" placeholder="Describe the issue or change..." rows="3"></textarea>
      <div class="popover-options">
        <div class="popover-option-group">
          <label>Intent</label>
          <select class="popover-intent">
            <option value="fix">Fix</option>
            <option value="change">Change</option>
            <option value="question">Question</option>
            <option value="approve">Approve</option>
          </select>
        </div>
        <div class="popover-option-group">
          <label>Severity</label>
          <select class="popover-severity">
            <option value="suggestion">Suggestion</option>
            <option value="important">Important</option>
            <option value="blocking">Blocking</option>
          </select>
        </div>
      </div>
      <div class="popover-actions">
        <button class="popover-cancel">Cancel</button>
        <button class="popover-add">Add</button>
      </div>
    `;

    // Events
    pop.querySelector('.popover-cancel').addEventListener('click', () => hidePopover());
    pop.querySelector('.popover-add').addEventListener('click', () => addAnnotationFromPopover());

    // Enter to submit
    pop.querySelector('.popover-textarea').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addAnnotationFromPopover();
      }
    });

    return pop;
  }

  let pendingAnnotationElement = null;
  let editingAnnotationIndex = -1;

  function showPopoverForElement(el) {
    pendingAnnotationElement = el;
    editingAnnotationIndex = -1;
    const rect = el.getBoundingClientRect();

    popover.querySelector('.popover-element-name').textContent = getElementName(el);
    popover.querySelector('.popover-textarea').value = '';
    popover.querySelector('.popover-intent').value = 'fix';
    popover.querySelector('.popover-severity').value = 'suggestion';
    popover.querySelector('.popover-add').textContent = 'Add';

    positionPopover(rect);
    popover.style.display = 'block';
    popover.querySelector('.popover-textarea').focus();
  }

  function showPopoverForEdit(ann, index) {
    pendingAnnotationElement = ann._element;
    editingAnnotationIndex = index;
    const rect = ann._element.getBoundingClientRect();

    popover.querySelector('.popover-element-name').textContent = ann.elementName;
    popover.querySelector('.popover-textarea').value = ann.comment;
    popover.querySelector('.popover-intent').value = ann.intent;
    popover.querySelector('.popover-severity').value = ann.severity;
    popover.querySelector('.popover-add').textContent = 'Update';

    positionPopover(rect);
    popover.style.display = 'block';
    popover.querySelector('.popover-textarea').focus();
  }

  function positionPopover(rect) {
    const pw = 320;
    const ph = 260;
    let top = rect.bottom + 8;
    let left = rect.left;

    // Keep in viewport
    if (top + ph > window.innerHeight) top = rect.top - ph - 8;
    if (left + pw > window.innerWidth) left = window.innerWidth - pw - 16;
    if (left < 8) left = 8;
    if (top < 8) top = 8;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function hidePopover() {
    popover.style.display = 'none';
    pendingAnnotationElement = null;
    editingAnnotationIndex = -1;
  }

  function addAnnotationFromPopover() {
    const comment = popover.querySelector('.popover-textarea').value.trim();
    const intent = popover.querySelector('.popover-intent').value;
    const severity = popover.querySelector('.popover-severity').value;
    const el = pendingAnnotationElement;

    if (!el) return;

    const annotationData = {
      id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      comment,
      intent,
      severity,
      element: el.tagName.toLowerCase(),
      elementName: getElementName(el),
      elementPath: getCSSSelector(el),
      cssClasses: (typeof el.className === 'string' ? el.className : '').trim(),
      computedStyles: getComputedStylesSummary(el),
      accessibility: getAccessibilityInfo(el),
      nearbyText: getNearbyText(el),
      reactComponent: getReactComponentName(el) || '',
      outerHTML: el.outerHTML.slice(0, 2000),
      boundingBox: {
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height)
      },
      url: window.location.href,
      timestamp: Date.now(),
      _element: el // private ref, not serialized
    };

    if (editingAnnotationIndex >= 0) {
      annotations[editingAnnotationIndex] = annotationData;
    } else {
      annotationCounter++;
      annotations.push(annotationData);
    }

    hidePopover();
    renderAnnotations();
    updateToolbarCount();
  }

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function createToolbar() {
    const tb = createElement('div', 'toolbar');
    tb.innerHTML = `
      <button class="toolbar-btn" data-action="pause" title="Pause animations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="toggle-visibility" title="Toggle annotations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="copy" title="Copy as markdown">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="clear" title="Clear all annotations">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      <button class="toolbar-btn" data-action="settings" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
      <div class="toolbar-separator"></div>
      <button class="toolbar-btn toolbar-btn-send" data-action="send" title="Send to Funny">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
        <span class="toolbar-send-label">Send to Funny</span>
        <span class="toolbar-count" style="display:none">0</span>
      </button>
      <button class="toolbar-btn" data-action="close" title="Close annotator">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    tb.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      handleToolbarAction(btn.dataset.action);
    });

    return tb;
  }

  function updateToolbarCount() {
    const count = toolbar.querySelector('.toolbar-count');
    const label = toolbar.querySelector('.toolbar-send-label');
    if (annotations.length > 0) {
      count.textContent = String(annotations.length);
      count.style.display = 'inline-flex';
      label.textContent = `Send (${annotations.length})`;
    } else {
      count.style.display = 'none';
      label.textContent = 'Send to Funny';
    }
  }

  function handleToolbarAction(action) {
    switch (action) {
      case 'pause':
        togglePauseAnimations();
        break;
      case 'toggle-visibility':
        annotationsVisible = !annotationsVisible;
        renderAnnotations();
        break;
      case 'copy':
        copyAsMarkdown();
        break;
      case 'clear':
        annotations = [];
        annotationCounter = 0;
        renderAnnotations();
        updateToolbarCount();
        break;
      case 'settings':
        // Open popup
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
        break;
      case 'send':
        sendToFunny();
        break;
      case 'close':
        deactivate();
        break;
    }
  }

  function togglePauseAnimations() {
    isPaused = !isPaused;
    if (isPaused) {
      document.getAnimations().forEach(a => a.pause());
      toolbar.querySelector('[data-action="pause"]').classList.add('toolbar-btn-active');
    } else {
      document.getAnimations().forEach(a => a.play());
      toolbar.querySelector('[data-action="pause"]').classList.remove('toolbar-btn-active');
    }
  }

  // ---------------------------------------------------------------------------
  // Generate markdown output
  // ---------------------------------------------------------------------------
  function generateMarkdown() {
    if (annotations.length === 0) return '';

    let md = `## UI Review: ${window.location.href}\n\n`;
    md += `**Page title:** ${document.title}\n`;
    md += `**Viewport:** ${window.innerWidth}x${window.innerHeight}\n`;
    md += `**Date:** ${new Date().toISOString()}\n\n---\n\n`;

    annotations.forEach((ann, i) => {
      md += `### Annotation ${i + 1} — ${ann.intent} (${ann.severity})\n\n`;
      md += `**Element:** \`${ann.element}\` at \`${ann.elementPath}\`\n`;
      if (ann.cssClasses) md += `**Classes:** \`${ann.cssClasses}\`\n`;
      if (ann.reactComponent) md += `**React Component:** \`${ann.reactComponent}\`\n`;
      md += `**Styles:** ${ann.computedStyles}\n`;
      md += `**Accessibility:** ${ann.accessibility}\n`;
      md += `**Nearby text:** ${ann.nearbyText}\n`;
      md += `**Bounding box:** ${ann.boundingBox.width}x${ann.boundingBox.height} at (${ann.boundingBox.x}, ${ann.boundingBox.y})\n`;
      if (ann.comment) md += `\n**Comment:** ${ann.comment}\n`;
      md += `\n**HTML (truncated):**\n\`\`\`html\n${ann.outerHTML.slice(0, 500)}\n\`\`\`\n\n`;
      if (i < annotations.length - 1) md += `---\n\n`;
    });

    md += `\n---\n\nPlease analyze these UI annotations and provide:\n`;
    md += `1. CSS/styling fixes for each issue\n`;
    md += `2. Accessibility improvements if needed\n`;
    md += `3. Responsive design suggestions\n`;
    md += `4. Code changes with file paths and specific selectors\n`;

    return md;
  }

  function copyAsMarkdown() {
    const md = generateMarkdown();
    if (!md) return;
    navigator.clipboard.writeText(md).then(() => {
      showToast('Copied to clipboard');
    });
  }

  // ---------------------------------------------------------------------------
  // Send to Funny
  // ---------------------------------------------------------------------------
  async function sendToFunny() {
    if (annotations.length === 0) {
      showToast('No annotations to send');
      return;
    }

    const sendBtn = toolbar.querySelector('[data-action="send"]');
    sendBtn.classList.add('toolbar-btn-loading');
    sendBtn.setAttribute('disabled', 'true');

    try {
      // Take screenshot
      const screenshot = await captureScreenshot();

      // Serialize annotations (strip _element refs)
      const serialized = annotations.map(({ _element, ...rest }) => rest);

      // Send to background worker
      chrome.runtime.sendMessage({
        type: 'SEND_TO_FUNNY',
        data: {
          url: window.location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          annotations: serialized,
          markdown: generateMarkdown(),
          screenshot
        }
      }, (response) => {
        sendBtn.classList.remove('toolbar-btn-loading');
        sendBtn.removeAttribute('disabled');

        if (response?.success) {
          showToast(`Sent to Funny! Thread created.`);
        } else {
          showToast(response?.error || 'Failed to send. Is Funny running?', true);
        }
      });
    } catch (err) {
      sendBtn.classList.remove('toolbar-btn-loading');
      sendBtn.removeAttribute('disabled');
      showToast(`Error: ${err.message}`, true);
    }
  }

  function captureScreenshot() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
        resolve(response?.screenshot || null);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------
  function showToast(message, isError = false) {
    const existing = shadowRoot.querySelector('.toast');
    if (existing) existing.remove();

    const toast = createElement('div', `toast ${isError ? 'toast-error' : ''}`);
    toast.textContent = message;
    shadowRoot.appendChild(toast);

    setTimeout(() => toast.classList.add('toast-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------
  function onMouseMove(e) {
    if (!isActive || popover.style.display === 'block') return;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === shadowHost || shadowHost.contains(el)) {
      hideHoverHighlight();
      return;
    }
    // Ignore tiny elements and document/html
    if (el === document.documentElement || el === document.body) {
      hideHoverHighlight();
      return;
    }
    showHoverHighlight(el);
  }

  function onClick(e) {
    if (!isActive) return;

    // Ignore clicks on our own UI
    if (e.target === shadowHost || shadowHost.contains(e.target)) return;

    // Ignore if popover is open
    if (popover.style.display === 'block') {
      hidePopover();
      return;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === document.documentElement || el === document.body) return;

    e.preventDefault();
    e.stopPropagation();

    hideHoverHighlight();
    showPopoverForElement(el);
  }

  function onKeyDown(e) {
    if (!isActive) return;
    if (e.key === 'Escape') {
      if (popover.style.display === 'block') {
        hidePopover();
      } else {
        deactivate();
      }
      e.preventDefault();
    }
  }

  // ---------------------------------------------------------------------------
  // Activate / Deactivate
  // ---------------------------------------------------------------------------
  function activate() {
    if (isActive) return;
    isActive = true;
    if (!shadowHost) createShadowHost();
    toolbar.style.display = 'flex';

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);

    renderAnnotations();
    updateToolbarCount();
  }

  function deactivate() {
    isActive = false;
    hideHoverHighlight();
    hidePopover();
    toolbar.style.display = 'none';
    highlightContainer.innerHTML = '';
    badgeContainer.innerHTML = '';

    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);

    // Resume animations if paused
    if (isPaused) {
      document.getAnimations().forEach(a => a.play());
      isPaused = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Message listener (from popup or background)
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE_ANNOTATOR') {
      if (isActive) {
        deactivate();
      } else {
        activate();
      }
      sendResponse({ active: isActive });
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({
        active: isActive,
        annotationCount: annotations.length,
        annotations: annotations.map(({ _element, ...rest }) => rest)
      });
    }
    if (msg.type === 'ACTIVATE') {
      activate();
      sendResponse({ active: true });
    }
    return true; // Keep channel open for async
  });

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  function getStyles() {
    return `
      * { box-sizing: border-box; }

      .hover-highlight {
        display: none;
        border: 2px solid #3b82f6;
        background: rgba(59, 130, 246, 0.08);
        border-radius: 4px;
        pointer-events: none;
        z-index: 10;
        transition: all 0.1s ease;
      }

      .hover-label {
        position: absolute;
        top: -24px;
        left: -1px;
        background: #3b82f6;
        color: white;
        font-size: 11px;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        padding: 2px 8px;
        border-radius: 4px 4px 0 0;
        white-space: nowrap;
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .annotation-highlight {
        border: 2px dashed #22c55e;
        background: rgba(34, 197, 94, 0.06);
        border-radius: 4px;
        pointer-events: none;
        z-index: 5;
      }

      .annotation-badge {
        width: 22px;
        height: 22px;
        background: #3b82f6;
        color: white;
        font-size: 12px;
        font-weight: 700;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 15;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        transition: transform 0.15s ease;
      }
      .annotation-badge:hover {
        transform: scale(1.2);
      }

      /* Popover */
      .popover {
        position: fixed;
        width: 320px;
        background: #1a1a1a;
        color: #e5e5e5;
        border-radius: 12px;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        z-index: 100;
        pointer-events: auto;
      }

      .popover-header {
        margin-bottom: 10px;
      }

      .popover-element-name {
        color: #22c55e;
        font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
        font-size: 13px;
        font-weight: 600;
      }

      .popover-textarea {
        width: 100%;
        background: #2a2a2a;
        border: 1px solid #404040;
        border-radius: 8px;
        color: #e5e5e5;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        padding: 10px;
        resize: vertical;
        outline: none;
        min-height: 60px;
      }
      .popover-textarea:focus {
        border-color: #3b82f6;
      }
      .popover-textarea::placeholder {
        color: #666;
      }

      .popover-options {
        display: flex;
        gap: 10px;
        margin: 10px 0;
      }

      .popover-option-group {
        flex: 1;
      }

      .popover-option-group label {
        display: block;
        font-size: 11px;
        color: #888;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .popover-option-group select {
        width: 100%;
        background: #2a2a2a;
        border: 1px solid #404040;
        border-radius: 6px;
        color: #e5e5e5;
        font-size: 12px;
        padding: 6px 8px;
        outline: none;
        cursor: pointer;
      }
      .popover-option-group select:focus {
        border-color: #3b82f6;
      }

      .popover-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      .popover-cancel {
        background: transparent;
        border: none;
        color: #888;
        font-size: 13px;
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 6px;
      }
      .popover-cancel:hover {
        color: #ccc;
        background: #333;
      }

      .popover-add {
        background: #22c55e;
        border: none;
        color: white;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        padding: 6px 16px;
        border-radius: 6px;
      }
      .popover-add:hover {
        background: #16a34a;
      }

      /* Toolbar */
      .toolbar {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        display: none;
        align-items: center;
        gap: 4px;
        background: #1a1a1a;
        border-radius: 16px;
        padding: 8px 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        pointer-events: auto;
        z-index: 200;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      .toolbar-btn {
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: #aaa;
        cursor: pointer;
        border-radius: 10px;
        transition: all 0.15s ease;
        padding: 0;
      }
      .toolbar-btn:hover {
        background: #333;
        color: white;
      }
      .toolbar-btn-active {
        background: #333;
        color: #3b82f6;
      }
      .toolbar-btn[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .toolbar-btn-send {
        width: auto;
        padding: 0 14px;
        gap: 6px;
        background: #22c55e;
        color: white;
        font-weight: 600;
        font-size: 13px;
      }
      .toolbar-btn-send:hover {
        background: #16a34a;
        color: white;
      }
      .toolbar-btn-loading {
        opacity: 0.7;
        pointer-events: none;
      }

      .toolbar-send-label {
        white-space: nowrap;
      }

      .toolbar-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        background: rgba(255,255,255,0.2);
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        padding: 0 6px;
      }

      .toolbar-separator {
        width: 1px;
        height: 24px;
        background: #333;
        margin: 0 4px;
      }

      /* Toast */
      .toast {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: #1a1a1a;
        color: #e5e5e5;
        padding: 10px 20px;
        border-radius: 10px;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        opacity: 0;
        transition: all 0.3s ease;
        pointer-events: none;
        z-index: 300;
      }
      .toast-visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .toast-error {
        background: #dc2626;
        color: white;
      }

      .highlight-container, .badge-container {
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
      }
    `;
  }
})();

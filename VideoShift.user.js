// ==UserScript==
// @name         VideoShift - Universal Video Positioner (v1.2)
// @namespace    https://github.com/videoshift-project
// @version      1.2.0
// @description  Move fullscreen HTML5 videos vertically without a travel limit. No overlay outside YouTube.
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const NORMAL_STEP = 5;
    const FINE_STEP = 1;
    const BIG_STEP = 50;
    const YOUTUBE = /(^|\.)youtube\.com$/.test(location.hostname);
    const PANEL_ID = 'videoshift-panel-v12';

    const state = {
        video: null,
        offset: 0,
        method: null,
        property: null,
        originalValue: '',
        originalPriority: '',
        baseMargin: 0,
        baseTransform: 'none',
        panel: null,
        panelRoot: null,
        pointerListener: null,
        hideTimer: null,
        checkToken: 0,
        screenWidth: 0,
        screenHeight: 0
    };

    function fullscreenRoot() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function findVideo() {
        const root = fullscreenRoot();
        if (!root) return null;

        // Keep the selected video even when it has been moved completely
        // off-screen. Otherwise the user could not bring it back.
        if (state.video && state.video.isConnected &&
            (root === state.video || root.contains(state.video))) {
            return state.video;
        }

        if (root.matches && root.matches('video')) return root;

        let best = null;
        let bestScore = -1;
        for (const video of root.querySelectorAll('video')) {
            const css = getComputedStyle(video);
            if (css.display === 'none' || css.visibility === 'hidden') continue;
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (!area) continue;
            const score = area + (!video.paused ? 100000000 : 0);
            if (score > bestScore) {
                best = video;
                bestScore = score;
            }
        }
        return best;
    }

    function restoreProperty() {
        if (!state.video || !state.property) return;
        if (state.originalValue) {
            state.video.style.setProperty(
                state.property, state.originalValue, state.originalPriority
            );
        } else {
            state.video.style.removeProperty(state.property);
        }
    }

    function stopTracking() {
        state.checkToken++;
        restoreProperty();
        state.video = null;
        state.offset = 0;
        state.method = null;
        state.property = null;
        state.originalValue = '';
        state.originalPriority = '';
    }

    function beginTracking(video) {
        if (state.video === video) return;
        stopTracking();
        state.video = video;
        const css = getComputedStyle(video);

        // Important YouTube fix: moving .html5-video-container with
        // transform/translate can create a new containing block for its
        // absolutely positioned children. That may change video sizing.
        // When the video is positioned, shift its own margin instead.
        // This changes its location without changing width/height/scale.
        if (YOUTUBE && (css.position === 'absolute' || css.position === 'fixed')) {
            state.method = 'margin';
            state.property = 'margin-top';
            state.baseMargin = parseFloat(css.marginTop) || 0;
        } else {
            // On other players, transform the VIDEO element itself, never
            // a wrapper around it. Preserve its existing transform matrix.
            state.method = 'transform';
            state.property = 'transform';
            state.baseTransform = css.transform || 'none';
        }

        state.originalValue = video.style.getPropertyValue(state.property);
        state.originalPriority = video.style.getPropertyPriority(state.property);
        state.screenWidth = window.innerWidth;
        state.screenHeight = window.innerHeight;
    }

    function writeOffset() {
        if (!state.video) return;
        if (Math.abs(state.offset) < 0.005) {
            restoreProperty();
        } else if (state.method === 'margin') {
            state.video.style.setProperty(
                'margin-top',
                'calc(' + state.baseMargin + 'px + ' + state.offset + 'px)',
                'important'
            );
        } else {
            const base = state.baseTransform === 'none' ? '' : ' ' + state.baseTransform;
            state.video.style.setProperty(
                'transform',
                'translateY(' + state.offset + 'px)' + base,
                'important'
            );
        }
        updateStatus();
    }

    function dimensions(video) {
        const r = video.getBoundingClientRect();
        return { width: r.width, height: r.height };
    }

    function sizeChanged(a, b) {
        return Math.abs(a.width - b.width) > Math.max(2, a.width * 0.01) ||
               Math.abs(a.height - b.height) > Math.max(2, a.height * 0.01);
    }

    function recoverIfResized(before, token) {
        if (!state.video || token !== state.checkToken || state.offset === 0) return;
        if (window.innerWidth !== state.screenWidth ||
            window.innerHeight !== state.screenHeight) return;
        const after = dimensions(state.video);
        if (!sizeChanged(before, after)) return;

        // First retry without moving the video's margin. This fallback
        // transforms only the video (not the container or player controls).
        const video = state.video;
        const requested = state.offset;
        if (state.method === 'margin') {
            console.warn('[VideoShift] Video dimensions changed; switching to video-only transform.');
            restoreProperty();
            state.method = 'transform';
            state.property = 'transform';
            const css = getComputedStyle(video);
            state.baseTransform = css.transform || 'none';
            state.originalValue = video.style.getPropertyValue('transform');
            state.originalPriority = video.style.getPropertyPriority('transform');
            state.offset = requested;
            writeOffset();
        }

        if (sizeChanged(before, dimensions(video))) {
            console.warn('[VideoShift] Video dimensions changed again; movement cancelled to protect the image.');
            stopTracking();
            updateStatus();
        }
    }

    function updateStatus() {
        if (!state.panel) return;
        const label = state.panel.querySelector('[data-videoshift-status]');
        if (label) label.textContent = Math.round(state.offset) + ' px';
    }

    function setOffset(next) {
        const video = findVideo();
        if (!video || !Number.isFinite(next)) return false;
        beginTracking(video);
        const before = dimensions(video);

        // No min/max clamp: any positive or negative offset is allowed.
        state.offset = Math.round(next * 100) / 100;
        writeOffset();
        const token = ++state.checkToken;
        recoverIfResized(before, token);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => recoverIfResized(before, token));
        });
        return true;
    }

    function moveBy(amount) {
        const video = findVideo();
        if (!video) return false;
        beginTracking(video);
        return setOffset(state.offset + amount);
    }

    function paintedRect(video) {
        const r = video.getBoundingClientRect();
        const css = getComputedStyle(video);
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width > 0 && height > 0 && r.width > 0 && r.height > 0 &&
            (css.objectFit === 'contain' || css.objectFit === 'scale-down')) {
            let scale = Math.min(r.width / width, r.height / height);
            if (css.objectFit === 'scale-down') scale = Math.min(scale, 1);
            const visibleHeight = height * scale;
            const leftover = r.height - visibleHeight;
            const parts = css.objectPosition.trim().split(/\s+/);
            const y = parts.length > 1 ? parts[1] : '50%';
            let inset = leftover / 2;
            if (y === 'top') inset = 0;
            else if (y === 'bottom') inset = leftover;
            else if (/^-?[\d.]+%$/.test(y)) inset = leftover * parseFloat(y) / 100;
            else if (/^-?[\d.]+px$/.test(y)) inset = parseFloat(y);
            return { top: r.top + inset, bottom: r.top + inset + visibleHeight };
        }
        return { top: r.top, bottom: r.bottom };
    }

    function alignToEdge(bottom) {
        const video = findVideo();
        if (!video) return false;
        beginTracking(video);
        const image = paintedRect(video);
        const delta = bottom ? window.innerHeight - image.bottom : -image.top;
        // Edge-align only once. Arrow keys can still travel past the edge.
        return setOffset(state.offset + delta);
    }

    function hidePanel() {
        if (!state.panel) return;
        state.panel.style.opacity = '0';
        state.panel.style.pointerEvents = 'none';
    }

    function revealPanel() {
        if (!state.panel) return;
        clearTimeout(state.hideTimer);
        state.panel.style.opacity = '1';
        state.panel.style.pointerEvents = 'auto';
        state.hideTimer = setTimeout(hidePanel, 2500);
    }

    function removePanel() {
        clearTimeout(state.hideTimer);
        if (state.panelRoot && state.pointerListener) {
            state.panelRoot.removeEventListener('pointermove', state.pointerListener);
        }
        if (state.panel) state.panel.remove();
        state.panel = null;
        state.panelRoot = null;
        state.pointerListener = null;
    }

    function createYouTubePanel() {
        // No popup/controls on other websites, including movie sites.
        const root = fullscreenRoot();
        if (!YOUTUBE || !root || (root.matches && root.matches('video')) || state.panel) return;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText =
            'position:fixed!important;right:16px!important;top:16px!important;' +
            'z-index:2147483647!important;display:flex!important;align-items:center;' +
            'gap:5px;padding:8px;background:rgba(16,16,16,.87);color:#fff;' +
            'border-radius:10px;font:13px Arial,sans-serif;opacity:0;' +
            'pointer-events:none;transition:opacity .18s ease;';

        function button(text, title, handler) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = text;
            btn.title = title;
            btn.style.cssText =
                'background:#404040;color:#fff;border:0;border-radius:6px;' +
                'padding:7px 9px;font:13px Arial,sans-serif;cursor:pointer;';
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                handler();
                revealPanel();
            });
            panel.appendChild(btn);
        }

        button('▲5', '5 px up', () => moveBy(-NORMAL_STEP));
        button('▼5', '5 px down', () => moveBy(NORMAL_STEP));
        button('▲1', '1 px up', () => moveBy(-FINE_STEP));
        button('▼1', '1 px down', () => moveBy(FINE_STEP));
        button('Üst', 'Align top', () => alignToEdge(false));
        button('Alt', 'Align bottom', () => alignToEdge(true));
        button('Sıfırla', 'Reset position', () => setOffset(0));

        const status = document.createElement('span');
        status.setAttribute('data-videoshift-status', '');
        status.style.cssText = 'min-width:40px;text-align:right;white-space:nowrap;';
        status.textContent = '0 px';
        panel.appendChild(status);

        state.panel = panel;
        state.panelRoot = root;
        root.appendChild(panel);
        state.pointerListener = e => {
            if (e.clientX > window.innerWidth - 300 && e.clientY < 90) revealPanel();
        };
        root.addEventListener('pointermove', state.pointerListener, { passive: true });
        revealPanel();
    }

    function onFullscreenChange() {
        removePanel();
        stopTracking();
        if (fullscreenRoot()) createYouTubePanel();
    }

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    window.addEventListener('keydown', e => {
        if (!fullscreenRoot() || !e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.target instanceof Element &&
            e.target.closest('input, textarea, select, [contenteditable="true"]')) return;

        const step = e.shiftKey ? FINE_STEP : NORMAL_STEP;
        let command;
        switch (e.code) {
            case 'ArrowDown': command = () => moveBy(step); break;
            case 'ArrowUp': command = () => moveBy(-step); break;
            case 'PageDown': command = () => moveBy(BIG_STEP); break;
            case 'PageUp': command = () => moveBy(-BIG_STEP); break;
            case 'KeyB': command = () => alignToEdge(true); break;
            case 'KeyT': command = () => alignToEdge(false); break;
            case 'KeyR': command = () => setOffset(0); break;
            default: return;
        }
        if (!findVideo()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        command();
        if (YOUTUBE) revealPanel();
    }, true);

    // Recalibrate after a real fullscreen window resize; this is not a
    // travel limit. On next movement the new layout is used.
    window.addEventListener('resize', () => {
        if (!fullscreenRoot() || !state.video) return;
        const offset = state.offset;
        const video = state.video;
        stopTracking();
        beginTracking(video);
        setOffset(offset);
    });

    document.addEventListener('loadedmetadata', e => {
        if (e.target === state.video && fullscreenRoot()) {
            // A new stream can legitimately have a different aspect ratio.
            stopTracking();
        }
    }, true);

    if (fullscreenRoot()) createYouTubePanel();
})();

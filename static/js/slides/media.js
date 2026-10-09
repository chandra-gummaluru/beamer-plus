// Slide media overlays — videos, audio players, 3D models, and widget
// placement. Positions/sizes are stored as fractions of the slide container
// and converted to pixels here.
import { renderWidgets } from '../core/iframe-widget-renderer.js';
import { setWidgetInteractivityForSpotlight } from './spotlight.js';

let _state = null;

export function initMedia(state) {
    _state = state;
}

/* ─── media cache ─────────────────────────────────────────────── */

export async function loadMedia(path) {
    if (_state.mediaCache[path]) return _state.mediaCache[path];
    const f = _state.zipFile?.file(path);
    if (!f) return null;
    const url = URL.createObjectURL(await f.async('blob'));
    _state.mediaCache[path] = url;
    return url;
}

// Release all blob URLs from the previous presentation before dropping the
// cache — otherwise every load leaks the full media set until page refresh.
export function resetMediaCache() {
    for (const url of Object.values(_state.mediaCache)) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
            try { URL.revokeObjectURL(url); } catch (_) {}
        }
    }
    _state.mediaCache = {};
}

/* ─── render ──────────────────────────────────────────────────── */

export async function renderMedia(config, container, rect, isRight, slideKey = null) {
    if (config.videos) {
        for (const [videoIndex, v] of config.videos.entries()) {
            const url = await loadMedia(v.path);
            if (!url) continue;
            const video = document.createElement('video');
            const baseVideoId = v.id ?? `video-${videoIndex}`;
            video.src = url;
            video.volume = v.volume ?? 1;
            video.className = 'slide-video';
            video.disablePictureInPicture = true;
            Object.assign(video.dataset, { videoX: v.x, videoY: v.y, videoWidth: v.width, videoHeight: v.height, videoZIndex: v.zIndex ?? 5, videoId: baseVideoId + (isRight ? '-r' : '') });
            Object.assign(video.style, { position:'absolute', left:`${v.x*rect.width}px`, top:`${v.y*rect.height}px`, width:`${v.width*rect.width}px`, height:`${v.height*rect.height}px`, objectFit:'contain', zIndex: v.zIndex ?? 5, transition:'left 0.45s ease, top 0.45s ease, width 0.45s ease, height 0.45s ease' });
            if (v.playMode === 'once' || v.playMode === 'auto') { video.autoplay = true; video.muted = true; }
            if (v.playMode === 'loop') { video.autoplay = true; video.loop = true; video.muted = true; }
            if (v.playMode === 'manual') { video.controls = true; }
            // Expand-on-play: after expandDelay seconds the video grows to fill
            // the slide, then snaps back to its placed size when paused/ended.
            let _expandTimer = null;
            function _expandVideo() {
                if (!video.isConnected || video.paused) return;
                const cr = container.getBoundingClientRect();
                video.dataset.expanded = '1';
                Object.assign(video.style, { left: '0px', top: '0px', width: `${cr.width}px`, height: `${cr.height}px`, zIndex: '500' });
            }
            function _collapseVideo() {
                clearTimeout(_expandTimer); _expandTimer = null;
                delete video.dataset.expanded;
                const cr = container.getBoundingClientRect();
                const vz = video.dataset.videoZIndex;
                Object.assign(video.style, { left: `${v.x*cr.width}px`, top: `${v.y*cr.height}px`, width: `${v.width*cr.width}px`, height: `${v.height*cr.height}px`, zIndex: vz });
            }
            const _expands = !isRight && v.expandDelay != null && v.expandDelay !== '' && !isNaN(+v.expandDelay);
            video.addEventListener('play', () => {
                if (_expands && _expandTimer === null && !video.dataset.expanded) {
                    _expandTimer = setTimeout(_expandVideo, Math.max(0, +v.expandDelay) * 1000);
                }
            });
            video.addEventListener('pause', () => { if (_expands) _collapseVideo(); });
            video.addEventListener('ended', () => { if (_expands) _collapseVideo(); });
            video.addEventListener('click', (e) => { video.paused ? video.play() : video.pause(); e.stopPropagation(); });
            container.appendChild(video);
        }
    }
    if (config.audios) {
        for (const a of config.audios) {
            const url = await loadMedia(a.path);
            if (!url) continue;
            const audio = document.createElement('audio');
            audio.src = url;
            audio.className = 'slide-audio';
            if (a.playMode === 'auto')  { audio.autoplay = true; }
            if (a.playMode === 'loop')  { audio.autoplay = true; audio.loop = true; }
            audio.controls = (a.playMode !== 'auto' && a.playMode !== 'loop');
            Object.assign(audio.dataset, { audioX: a.x ?? 0.1, audioY: a.y ?? 0.1, audioWidth: a.width ?? 0.4 });
            Object.assign(audio.style, {
                position: 'absolute',
                left:   `${(a.x ?? 0.1) * rect.width}px`,
                top:    `${(a.y ?? 0.1) * rect.height}px`,
                width:  `${(a.width ?? 0.4) * rect.width}px`,
                height: '40px',
                zIndex: a.zIndex ?? 5,
            });
            container.appendChild(audio);
        }
    }
    if (config.models) {
        for (const m of config.models) {
            const url = await loadMedia(m.path);
            if (!url) continue;
            const mv = document.createElement('model-viewer');
            mv.src = url; mv.alt = m.alt ?? '3D model';
            mv.setAttribute('camera-controls', ''); mv.setAttribute('shadow-intensity', '1');
            if (m.autoRotate) mv.setAttribute('auto-rotate', '');
            if (m.animate !== false) mv.setAttribute('autoplay', '');
            if (m.animationName) mv.setAttribute('animation-name', m.animationName);
            Object.assign(mv.dataset, { modelId: m.id, mediaX: m.x, mediaY: m.y, mediaWidth: m.width, mediaHeight: m.height });
            Object.assign(mv.style, { position:'absolute', left:`${m.x*rect.width}px`, top:`${m.y*rect.height}px`, width:`${m.width*rect.width}px`, height:`${m.height*rect.height}px`, zIndex: m.zIndex ?? 5 });
            mv.style.setProperty('--progress-bar-height', '0px');
            const progressBarSlot = document.createElement('div');
            progressBarSlot.slot = 'progress-bar';
            mv.appendChild(progressBarSlot);
            container.appendChild(mv);
        }
    }
    if (config.widgets) {
        await renderWidgets(config, container, _state.zipFile, false, slideKey);
        setWidgetInteractivityForSpotlight(_state.annotationTool === 'spotlight');
    }
}

/* ─── reposition after container resize ───────────────────────── */

export function updateMediaPositions(container) {
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Videos
    container.querySelectorAll('.slide-video').forEach(el => {
        const x = parseFloat(el.dataset.videoX);
        const y = parseFloat(el.dataset.videoY);
        const w = parseFloat(el.dataset.videoWidth);
        const h = parseFloat(el.dataset.videoHeight);
        // A video grown to fill the slide while playing stays full size.
        const full = el.dataset.expanded === '1';
        if (![x, y, w, h].some(isNaN)) {
            // Videos carry a permanent inline `transition` used for the
            // expand-on-play animation (see renderMedia). Left as-is, it also
            // smooth-animates every layout-driven reposition here, making the
            // video visibly lag behind the rest of the slide during divider
            // drags / resizes (nothing else — widgets, audio, models — has a
            // transition). Suspend it for this synchronous update, then
            // restore it so expand-on-play still animates normally.
            const savedTransition = el.style.transition;
            el.style.transition = 'none';
            el.style.left   = full ? '0px' : `${x * rect.width}px`;
            el.style.top    = full ? '0px' : `${y * rect.height}px`;
            el.style.width  = `${(full ? 1 : w) * rect.width}px`;
            el.style.height = `${(full ? 1 : h) * rect.height}px`;
            void el.offsetWidth; // force reflow so `transition: none` takes effect before restoring
            el.style.transition = savedTransition;
        }
    });
    // Audio players
    container.querySelectorAll('.slide-audio').forEach(el => {
        const x = parseFloat(el.dataset.audioX);
        const y = parseFloat(el.dataset.audioY);
        const w = parseFloat(el.dataset.audioWidth);
        if (![x, y, w].some(isNaN)) {
            el.style.left  = `${x * rect.width}px`;
            el.style.top   = `${y * rect.height}px`;
            el.style.width = `${w * rect.width}px`;
        }
    });
    // 3D model viewers
    container.querySelectorAll('model-viewer').forEach(el => {
        const x = parseFloat(el.dataset.mediaX);
        const y = parseFloat(el.dataset.mediaY);
        const w = parseFloat(el.dataset.mediaWidth);
        const h = parseFloat(el.dataset.mediaHeight);
        if (![x, y, w, h].some(isNaN)) {
            el.style.left   = `${x * rect.width}px`;
            el.style.top    = `${y * rect.height}px`;
            el.style.width  = `${w * rect.width}px`;
            el.style.height = `${h * rect.height}px`;
        }
    });
}

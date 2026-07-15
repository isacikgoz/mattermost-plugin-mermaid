// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const BUTTON_STEP = 1.25;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Sizes the SVG to its intrinsic dimensions so it can be measured and scaled
 * predictably inside the viewer. Mermaid emits a `max-width` constraint and a
 * viewBox we can fall back to.
 */
function normalizeSvg(svg: SVGElement): {width: number; height: number} {
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';

    const viewBox = svg.getAttribute('viewBox');
    let width = 0;
    let height = 0;

    if (viewBox) {
        const parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4) {
            width = parts[2];
            height = parts[3];
        }
    }

    if (!width || !height) {
        const rect = svg.getBoundingClientRect();
        width = rect.width || 400;
        height = rect.height || 300;
    }

    svg.style.width = `${width}px`;
    svg.setAttribute('width', `${width}`);
    svg.removeAttribute('height');

    return {width, height};
}

function makeButton(label: string, text: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-plugin-viewer__button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = text;
    return button;
}

export function openMermaidViewer(svgMarkup: string): void {
    // Only one viewer at a time.
    document.querySelector('.mermaid-plugin-viewer')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'mermaid-plugin-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Mermaid diagram viewer');

    const stage = document.createElement('div');
    stage.className = 'mermaid-plugin-viewer__stage';

    const content = document.createElement('div');
    content.className = 'mermaid-plugin-viewer__content';
    content.innerHTML = svgMarkup;
    stage.appendChild(content);

    const toolbar = document.createElement('div');
    toolbar.className = 'mermaid-plugin-viewer__toolbar';

    const zoomOutBtn = makeButton('Zoom out', '\u2212');
    const resetBtn = makeButton('Reset zoom', '100%');
    resetBtn.classList.add('mermaid-plugin-viewer__button--reset');
    const zoomInBtn = makeButton('Zoom in', '+');
    const closeBtn = makeButton('Close', '\u2715');
    closeBtn.classList.add('mermaid-plugin-viewer__button--close');

    toolbar.append(zoomOutBtn, resetBtn, zoomInBtn, closeBtn);
    overlay.append(stage, toolbar);
    document.body.appendChild(overlay);

    const svg = content.querySelector('svg');
    const size = svg ? normalizeSvg(svg) : {width: 400, height: 300};

    let scale = 1;
    let translateX = 0;
    let translateY = 0;

    const apply = () => {
        content.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        resetBtn.textContent = `${Math.round(scale * 100)}%`;
    };

    const fitAndCenter = () => {
        const rect = stage.getBoundingClientRect();
        const padding = 48;
        const availWidth = Math.max(rect.width - padding, 50);
        const availHeight = Math.max(rect.height - padding, 50);
        scale = clamp(Math.min(availWidth / size.width, availHeight / size.height), MIN_SCALE, 1.5);
        translateX = (rect.width - (size.width * scale)) / 2;
        translateY = (rect.height - (size.height * scale)) / 2;
        apply();
    };

    const zoomAroundCenter = (factor: number) => {
        const rect = stage.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const newScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
        const k = newScale / scale;
        translateX = cx - (k * (cx - translateX));
        translateY = cy - (k * (cy - translateY));
        scale = newScale;
        apply();
    };

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const newScale = clamp(scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const k = newScale / scale;
        translateX = cx - (k * (cx - translateX));
        translateY = cy - (k * (cy - translateY));
        scale = newScale;
        apply();
    };

    let dragging = false;
    let movedDuringDrag = false;
    let startX = 0;
    let startY = 0;

    const onPointerDown = (e: PointerEvent) => {
        dragging = true;
        movedDuringDrag = false;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
        stage.setPointerCapture(e.pointerId);
        stage.classList.add('is-grabbing');
    };

    const onPointerMove = (e: PointerEvent) => {
        if (!dragging) {
            return;
        }
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        movedDuringDrag = true;
        apply();
    };

    const onPointerUp = (e: PointerEvent) => {
        dragging = false;
        stage.classList.remove('is-grabbing');
        stage.releasePointerCapture?.(e.pointerId);
    };

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    };

    // Clicking the empty backdrop (not the diagram, and not a drag) closes.
    const onStageClick = (e: MouseEvent) => {
        if (!movedDuringDrag && !content.contains(e.target as Node)) {
            close();
        }
    };

    function onKey(e: KeyboardEvent) {
        switch (e.key) {
        case 'Escape':
            close();
            break;
        case '+':
        case '=':
            zoomAroundCenter(BUTTON_STEP);
            break;
        case '-':
            zoomAroundCenter(1 / BUTTON_STEP);
            break;
        case '0':
            fitAndCenter();
            break;
        }
    }

    stage.addEventListener('wheel', onWheel, {passive: false});
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('click', onStageClick);
    document.addEventListener('keydown', onKey);

    zoomInBtn.addEventListener('click', () => zoomAroundCenter(BUTTON_STEP));
    zoomOutBtn.addEventListener('click', () => zoomAroundCenter(1 / BUTTON_STEP));
    resetBtn.addEventListener('click', fitAndCenter);
    closeBtn.addEventListener('click', close);

    fitAndCenter();
}

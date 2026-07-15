// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {useEffect} from 'react';
import {useSelector} from 'react-redux';

import {getTheme} from 'mattermost-redux/selectors/entities/preferences';

import {openMermaidViewer} from './mermaid_viewer';

import './mermaid.scss';

type Theme = ReturnType<typeof getTheme>;
type Mermaid = (typeof import('mermaid'))['default'];

// Mattermost renders fenced code blocks (```mermaid ... ```) into a
// `.post-code` container without exposing the original language in the DOM.
// This prefilter cheaply identifies blocks whose contents start with a known
// Mermaid diagram keyword so we only load the (large) Mermaid library and
// attempt a render when it's actually worthwhile.
const MERMAID_PREFILTER = /^\s*(?:%%\{[\s\S]*?\}%%\s*)*(?:graph|flowchart|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|architecture(?:-beta)?|kanban|radar)\b/;

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
    if (!mermaidPromise) {
        mermaidPromise = import('mermaid').then((mod) => mod.default);
    }
    return mermaidPromise;
}

function isDarkTheme(theme: Theme): boolean {
    const bg = theme?.centerChannelBg || '#ffffff';
    const hex = bg.replace('#', '');
    if (hex.length < 6) {
        return false;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = ((0.299 * r) + (0.587 * g) + (0.114 * b)) / 255;
    return luminance < 0.5;
}

type RenderedEntry = {
    id: number;
    source: string;
    container: HTMLElement;
    codeBlock: HTMLElement;
    svg?: string;
    zoom: number;
    baseWidth: number;
};

const INLINE_ZOOM_STEP = 1.25;
const INLINE_ZOOM_MIN = 0.1;
const INLINE_ZOOM_MAX = 4;

const ICON_ZOOM_OUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const ICON_ZOOM_IN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
const ICON_EXPAND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

class MermaidManager {
    private rendered = new Map<HTMLElement, RenderedEntry>();
    private idCounter = 0;
    private themeKey = 'default';
    private appliedThemeKey = '';
    private observer: MutationObserver | null = null;
    private scanScheduled = false;
    private renderQueue: Promise<unknown> = Promise.resolve();

    start(theme: Theme) {
        this.themeKey = isDarkTheme(theme) ? 'dark' : 'default';

        if (this.observer) {
            this.scheduleScan();
            return;
        }

        this.observer = new MutationObserver(() => this.scheduleScan());
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.scheduleScan();
    }

    setTheme(theme: Theme) {
        const key = isDarkTheme(theme) ? 'dark' : 'default';
        if (key === this.themeKey) {
            return;
        }
        this.themeKey = key;

        for (const entry of this.rendered.values()) {
            this.renderEntry(entry);
        }
    }

    private scheduleScan() {
        if (this.scanScheduled) {
            return;
        }
        this.scanScheduled = true;
        window.requestAnimationFrame(() => {
            this.scanScheduled = false;
            this.scan();
        });
    }

    private scan() {
        for (const [codeEl, entry] of this.rendered) {
            if (!codeEl.isConnected) {
                entry.container.remove();
                this.rendered.delete(codeEl);
            }
        }

        const codeEls = document.querySelectorAll<HTMLElement>('.post-code code');
        codeEls.forEach((el) => this.processCode(el));
    }

    private processCode(codeEl: HTMLElement) {
        const source = (codeEl.textContent || '').replace(/\s+$/, '');
        const existing = this.rendered.get(codeEl);

        if (existing) {
            // Re-attach if a re-render detached our diagram from the DOM.
            if (!existing.container.isConnected) {
                const codeBlock = codeEl.closest<HTMLElement>('.post-code');
                if (codeBlock) {
                    codeBlock.insertAdjacentElement('afterend', existing.container);
                    existing.codeBlock = codeBlock;
                    codeBlock.style.display = 'none';
                }
            }

            // The post was edited; re-evaluate the (possibly changed) contents.
            if (existing.source !== source) {
                existing.source = source;
                if (source && MERMAID_PREFILTER.test(source)) {
                    this.renderEntry(existing);
                } else {
                    this.revert(codeEl, existing);
                }
            }
            return;
        }

        if (!source || !MERMAID_PREFILTER.test(source)) {
            return;
        }

        const codeBlock = codeEl.closest<HTMLElement>('.post-code');
        if (!codeBlock) {
            return;
        }

        const container = document.createElement('div');
        container.className = 'mermaid-plugin-diagram';
        container.setAttribute('role', 'img');
        container.setAttribute('aria-label', 'Mermaid diagram');
        codeBlock.insertAdjacentElement('afterend', container);

        const entry: RenderedEntry = {
            id: ++this.idCounter,
            source,
            container,
            codeBlock,
            zoom: 1,
            baseWidth: 0,
        };
        this.rendered.set(codeEl, entry);
        this.renderEntry(entry);
    }

    private revert(codeEl: HTMLElement, entry: RenderedEntry) {
        entry.container.remove();
        entry.codeBlock.style.display = '';
        this.rendered.delete(codeEl);
    }

    private renderEntry(entry: RenderedEntry) {
        // Serialize renders: Mermaid keeps shared internal state and is not
        // safe to run concurrently.
        this.renderQueue = this.renderQueue.then(() => this.doRender(entry)).catch(() => {});
    }

    private async doRender(entry: RenderedEntry) {
        const mermaid = await loadMermaid();

        if (this.appliedThemeKey !== this.themeKey) {
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: this.themeKey as 'default' | 'dark',
                fontFamily: 'inherit',
            });
            this.appliedThemeKey = this.themeKey;
        }

        // A fresh id each time avoids collisions with Mermaid's temporary
        // measurement node when re-rendering the same diagram.
        const renderId = `mermaid-plugin-${entry.id}-${Date.now()}`;

        try {
            const {svg, bindFunctions} = await mermaid.render(renderId, entry.source);
            entry.svg = svg;
            entry.container.className = 'mermaid-plugin-diagram';
            entry.container.innerHTML = '';

            const scroll = document.createElement('div');
            scroll.className = 'mermaid-plugin-diagram__scroll';
            scroll.innerHTML = svg;
            entry.container.appendChild(scroll);
            bindFunctions?.(scroll);

            this.addZoomAffordance(entry, scroll);
            entry.codeBlock.style.display = 'none';
        } catch (error) {
            this.renderError(entry, error);
        }
    }

    private addZoomAffordance(entry: RenderedEntry, scroll: HTMLElement) {
        const svg = scroll.querySelector('svg');
        entry.baseWidth = this.getNaturalWidth(svg);

        // Initialize the zoom to the fraction the diagram is actually displayed
        // at (large diagrams are shrunk to fit the container), so the first
        // +/- click steps relative to what the user sees instead of jumping to
        // the natural (100%) size.
        const displayedWidth = svg ? svg.getBoundingClientRect().width : entry.baseWidth;
        entry.zoom = entry.baseWidth > 0 ?
            Math.min(INLINE_ZOOM_MAX, Math.max(INLINE_ZOOM_MIN, displayedWidth / entry.baseWidth)) :
            1;

        const makeButton = (label: string, icon: string, onClick: (e: Event) => void) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mermaid-plugin-diagram__button';
            button.setAttribute('aria-label', label);
            button.title = label;
            button.innerHTML = icon;
            button.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                onClick(e);
            };
            return button;
        };

        const toolbar = document.createElement('div');
        toolbar.className = 'mermaid-plugin-diagram__toolbar';
        toolbar.append(
            makeButton('Zoom out', ICON_ZOOM_OUT, () => this.setInlineZoom(entry, entry.zoom / INLINE_ZOOM_STEP)),
            makeButton('Zoom in', ICON_ZOOM_IN, () => this.setInlineZoom(entry, entry.zoom * INLINE_ZOOM_STEP)),
            makeButton('Full screen', ICON_EXPAND, () => {
                if (entry.svg) {
                    openMermaidViewer(entry.svg);
                }
            }),
        );
        entry.container.appendChild(toolbar);

        this.enableDragPan(scroll);
    }

    private enableDragPan(scroll: HTMLElement) {
        // Distance (px) the pointer must travel before we treat the gesture as a
        // pan rather than a click. Below this, we let the click bubble so
        // Mattermost's own post handler (e.g. opening the thread RHS) still works.
        const DRAG_THRESHOLD = 4;

        let dragging = false;
        let panned = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        const canPan = () =>
            scroll.scrollWidth > scroll.clientWidth + 1 || scroll.scrollHeight > scroll.clientHeight + 1;

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 || !canPan()) {
                return;
            }
            dragging = true;
            panned = false;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = scroll.scrollLeft;
            startTop = scroll.scrollTop;
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!dragging) {
                return;
            }
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!panned && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) {
                return;
            }

            // Once the gesture is clearly a drag, take it over: capture the
            // pointer, suppress native selection, and show the grabbing cursor.
            if (!panned) {
                panned = true;
                scroll.setPointerCapture(e.pointerId);
                scroll.classList.add('is-grabbing');
            }
            e.preventDefault();
            scroll.scrollLeft = startLeft - dx;
            scroll.scrollTop = startTop - dy;
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!dragging) {
                return;
            }
            dragging = false;
            scroll.classList.remove('is-grabbing');
            scroll.releasePointerCapture?.(e.pointerId);
        };

        // A drag-pan still fires a trailing click; swallow it so it doesn't reach
        // the post container and open the thread view. Plain clicks (no pan) pass
        // through untouched.
        const onClick = (e: MouseEvent) => {
            if (panned) {
                e.preventDefault();
                e.stopPropagation();
                panned = false;
            }
        };

        scroll.addEventListener('pointerdown', onPointerDown);
        scroll.addEventListener('pointermove', onPointerMove);
        scroll.addEventListener('pointerup', onPointerUp);
        scroll.addEventListener('pointercancel', onPointerUp);
        scroll.addEventListener('click', onClick, true);
    }

    private getNaturalWidth(svg: SVGElement | null): number {
        if (!svg) {
            return 0;
        }
        const viewBox = svg.getAttribute('viewBox');
        if (viewBox) {
            const parts = viewBox.split(/[\s,]+/).map(Number);
            if (parts.length === 4 && parts[2] > 0) {
                return parts[2];
            }
        }
        return svg.getBoundingClientRect().width;
    }

    private setInlineZoom(entry: RenderedEntry, zoom: number) {
        const clamped = Math.min(INLINE_ZOOM_MAX, Math.max(INLINE_ZOOM_MIN, zoom));
        entry.zoom = clamped;

        const scroll = entry.container.querySelector<HTMLElement>('.mermaid-plugin-diagram__scroll');
        const svg = scroll?.querySelector('svg');
        if (!scroll || !svg || !entry.baseWidth) {
            return;
        }

        // Drive the width explicitly at every level (100% == the diagram's
        // natural size). maxWidth must be cleared so Mermaid's own cap doesn't
        // fight the zoom, and the wrapper is a block container so the SVG can
        // overflow and scroll instead of being shrunk to fit.
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        svg.style.width = `${entry.baseWidth * clamped}px`;
        scroll.classList.toggle('mermaid-plugin-diagram__scroll--zoomed', clamped > 1);
    }

    private renderError(entry: RenderedEntry, error: unknown) {
        entry.codeBlock.style.display = '';
        entry.container.className = 'mermaid-plugin-error';
        entry.container.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'mermaid-plugin-error__title';
        title.textContent = 'Unable to render Mermaid diagram';

        const detail = document.createElement('div');
        detail.className = 'mermaid-plugin-error__detail';
        detail.textContent = error instanceof Error ? error.message : String(error);

        entry.container.append(title, detail);
    }
}

const manager = new MermaidManager();

export default function MermaidRenderer() {
    const theme = useSelector(getTheme);

    useEffect(() => {
        manager.start(theme);

        // Theme is intentionally only used for the initial start here; theme
        // changes are handled by the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        manager.setTheme(theme);
    }, [theme]);

    return null;
}

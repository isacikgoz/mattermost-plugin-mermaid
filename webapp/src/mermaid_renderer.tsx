// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {useEffect} from 'react';
import {useSelector} from 'react-redux';

import {getTheme} from 'mattermost-redux/selectors/entities/preferences';

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
};

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
            entry.container.className = 'mermaid-plugin-diagram';
            entry.container.innerHTML = svg;
            bindFunctions?.(entry.container);
            entry.codeBlock.style.display = 'none';
        } catch (error) {
            this.renderError(entry, error);
        }
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

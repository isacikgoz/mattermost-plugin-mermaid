// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import manifest from 'manifest';

import type {PluginRegistry} from 'types/mattermost-webapp';

import MermaidRenderer from './mermaid_renderer';

export default class Plugin {
    public async initialize(registry: PluginRegistry) {
        registry.registerRootComponent(MermaidRenderer);
    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());

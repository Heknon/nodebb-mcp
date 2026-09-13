import type { CapabilityRegistry } from '../capabilities.js';
import type { NodeBBClient } from '../client.js';
import type { Config } from '../config.js';

export interface ToolContext {
	client: NodeBBClient;
	config: Config;
	capabilities: CapabilityRegistry;
}

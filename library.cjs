'use strict';

// NodeBB loads plugins with require(); the server itself is ESM (dist/), so this
// bridge loads it once and hands it NodeBB's module loader.

const nbb = (typeof nodebb !== 'undefined' && nodebb && typeof nodebb.require === 'function')
	? nodebb.require.bind(nodebb)
	: require.main.require;

let loaded;
const plugin = () => (loaded ??= import('./dist/plugin/index.js'));

module.exports = {
	init: async params => (await plugin()).init(params, nbb),
	apiRoutes: async params => (await plugin()).apiRoutes(params, nbb),
	adminMenu: async header => (await plugin()).adminMenu(header),
};

'use strict';

/* global $, app, config, ajaxify, define */

// No dependencies in define(): NodeBB's build can leave a plugin ACP module with a
// dependency array undefined, so its init never runs. Load them with app.require().
define('admin/plugins/mcp', [], function () {
	var ACP = {};

	ACP.init = function () {
		app.require(['settings', 'alerts', 'api']).then(function (deps) {
			var settings = deps[0];
			var alerts = deps[1];
			var api = deps[2];

			settings.load('mcp', $('.mcp-settings'));
			$('#mcp-save').on('click', function () {
				settings.save('mcp', $('.mcp-settings'), function () {
					alerts.success('Saved. Connected apps have the change from their next request.');
				});
			});

			$('.mcp-revoke').on('click', function () {
				var id = $(this).attr('data-grant');
				var row = $(this).closest('tr');
				api.del('/plugins/mcp/grants/' + encodeURIComponent(id), {}).then(function () {
					row.remove();
					alerts.success('Connection revoked.');
				}).catch(alerts.error);
			});
		});
	};

	return ACP;
});

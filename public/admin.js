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

			$('#mcp-diagnose').on('click', function () {
				var button = $(this);
				var out = $('#mcp-diagnostics');
				button.prop('disabled', true);
				out.html('<p class="text-muted"><i class="fa fa-spinner fa-spin"></i> Testing (up to about 20 seconds)…</p>');
				api.get('/plugins/mcp/diagnostics', {}).then(function (report) {
					out.empty().append(renderReport(report));
				}).catch(function (err) {
					out.empty().append($('<div class="alert alert-danger"></div>').text('The test itself failed: ' + (err && err.message ? err.message : err)));
				}).finally(function () {
					button.prop('disabled', false);
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

	var STYLE = {
		ok: { cls: 'success', icon: 'fa-check-circle', label: 'OK' },
		warn: { cls: 'warning', icon: 'fa-exclamation-triangle', label: 'Warning' },
		fail: { cls: 'danger', icon: 'fa-times-circle', label: 'Failed' },
		skip: { cls: 'secondary', icon: 'fa-minus-circle', label: 'Skipped' },
	};

	// Built with .text() throughout: details can echo anything a proxy sent back.
	function renderReport(report) {
		var root = $('<div></div>');
		var top = STYLE[report.verdict] || STYLE.fail;
		root.append($('<div class="alert"></div>').addClass('alert-' + top.cls).append(
			$('<i class="fa me-2"></i>').addClass(top.icon),
			$('<strong></strong>').text(report.headline)
		));
		var list = $('<div class="list-group mb-3"></div>');
		(report.checks || []).forEach(function (check) {
			var st = STYLE[check.status] || STYLE.fail;
			var item = $('<div class="list-group-item"></div>');
			item.append($('<div class="d-flex gap-2 align-items-start"></div>').append(
				$('<i class="fa mt-1"></i>').addClass(st.icon + ' text-' + st.cls),
				$('<div class="flex-grow-1"></div>').append(
					$('<div class="fw-semibold"></div>').text(check.title),
					$('<div></div>').text(check.summary),
					check.advice ? $('<div class="form-text text-body"></div>').append($('<strong>What to do: </strong>'), document.createTextNode(check.advice)) : null,
					check.details ? $('<details class="mt-1"><summary class="small text-muted">Details</summary></details>')
						.append($('<pre class="small mb-0 text-wrap text-break"></pre>').text(JSON.stringify(check.details, null, 2))) : null
				),
				$('<span class="badge"></span>').addClass('text-bg-' + st.cls).text(st.label)
			));
			list.append(item);
		});
		root.append(list);
		var text = JSON.stringify(report, null, 2);
		var copy = $('<button class="btn btn-sm btn-outline-secondary"><i class="fa fa-copy"></i> Copy full report</button>');
		copy.on('click', function () {
			navigator.clipboard.writeText(text).then(function () { copy.text('Copied'); });
		});
		root.append(copy);
		return root;
	}

	return ACP;
});

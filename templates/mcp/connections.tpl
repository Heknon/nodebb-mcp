<div class="mcp-connections">
	<h3 class="fw-semibold"><i class="fa fa-plug"></i> Connected apps</h3>
	<p class="text-muted">Apps you allowed to use the forum as you, over MCP. Each acts with your own forum permissions; disconnecting one ends its access at once.</p>

	<div class="card mb-4">
		<div class="card-body">
			<h5 class="fw-semibold">Connect an app</h5>
			<p class="mb-2">Point your MCP client at this forum. In Claude Code:</p>
			<pre class="mb-2 text-wrap"><code class="text-break">claude mcp add --transport http forum {endpoint}</code></pre>
			<p class="text-muted small mb-0">The first time it connects, your browser opens here to sign in and allow it.</p>
		</div>
	</div>

	{{{ if hasGrants }}}
	<table class="table align-middle mcp-grants">
		<thead><tr><th>App</th><th>Connected</th><th>Last used</th><th></th></tr></thead>
		<tbody>
			{{{ each grants }}}
			<tr data-grant="{./id}">
				<td>{./clientName}</td>
				<td><span class="timeago" title="{./createdAtISO}"></span></td>
				<td>{{{ if ./used }}}<span class="timeago" title="{./lastUsedAtISO}"></span>{{{ else }}}<span class="text-muted">never</span>{{{ end }}}</td>
				<td class="text-end">
					<form method="post" action="{config.relative_path}/mcp/connections/disconnect" class="d-inline">
						<input type="hidden" name="csrf_token" value="{config.csrf_token}">
						<input type="hidden" name="grant" value="{./id}">
						<button type="submit" class="btn btn-sm btn-outline-danger">Disconnect</button>
					</form>
				</td>
			</tr>
			{{{ end }}}
		</tbody>
	</table>
	{{{ else }}}
	<p class="text-muted">No apps are connected.</p>
	{{{ end }}}
</div>

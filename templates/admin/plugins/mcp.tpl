<div class="acp-page-container">
	<div class="row">
		<div class="col-12 col-xxl-10">
			<div class="card mb-3">
				<div class="card-body">
					<h4 class="fw-bold"><i class="fa fa-plug"></i> MCP</h4>
					<p class="text-muted">The forum serves MCP at <code>{endpoint}</code>. People connect an MCP client there and sign in with their own forum account; each connection acts with that person's forum permissions.</p>
					<pre class="mb-0 text-wrap"><code class="text-break">claude mcp add --transport http forum {endpoint}</code></pre>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-body">
					<h5 class="fw-bold">Settings</h5>
					<form role="form" class="mcp-settings">
						<div class="form-check form-switch mb-2">
							<input type="checkbox" class="form-check-input" id="publicWrites" name="publicWrites">
							<label for="publicWrites" class="form-check-label">Public writes</label>
						</div>
						<p class="form-text">Let connected apps post topics and replies, edit posts, vote and accept answers — as the person, within their privileges. Off by default. Shotef ticket actions (notes, status, assignment) do not need this: Shotef checks team membership itself.</p>
						<div class="mb-2 mt-3">
							<label for="apiUrl" class="form-label">Forum address for tools</label>
							<input type="text" class="form-control" id="apiUrl" name="apiUrl" placeholder="Automatic: {autoApiUrl}">
						</div>
						<p class="form-text">Where tools send their requests to this forum, as seen from the forum's own server. Leave blank for automatic: NodeBB's own port on loopback, then the public URL if that fails. Set it when NodeBB listens somewhere else, for example <code>http://127.0.0.1:4567</code> or a container name such as <code>http://nodebb:4567</code>. Use <b>Test connection</b> below after saving.</p>
					</form>
					<button id="mcp-save" class="btn btn-primary">Save</button>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-body">
					<h5 class="fw-bold">Connection test</h5>
					<p class="form-text">Tools act by calling the forum's own API from inside the forum process: first over loopback, then through the public URL. This checks each step from the server's side and explains any failure.</p>
					<button id="mcp-diagnose" class="btn btn-outline-primary"><i class="fa fa-stethoscope"></i> Test connection</button>
					<div id="mcp-diagnostics" class="mt-3"></div>
				</div>
			</div>

			<div class="card mb-3">
				<div class="card-body">
					<h5 class="fw-bold">Connections</h5>
					{{{ if hasGrants }}}
					<table class="table table-sm align-middle">
						<thead><tr><th>Person</th><th>App</th><th>Connected</th><th>Last used</th><th></th></tr></thead>
						<tbody>
							{{{ each grants }}}
							<tr data-grant="{./id}">
								<td><a href="{config.relative_path}/uid/{./uid}">{./username}</a></td>
								<td>{./clientName}</td>
								<td><span class="timeago" title="{./createdAtISO}"></span></td>
								<td>{{{ if ./used }}}<span class="timeago" title="{./lastUsedAtISO}"></span>{{{ else }}}never{{{ end }}}</td>
								<td class="text-end"><button class="btn btn-sm btn-outline-danger mcp-revoke" data-grant="{./id}">Revoke</button></td>
							</tr>
							{{{ end }}}
						</tbody>
					</table>
					{{{ else }}}
					<p class="text-muted mb-0">Nobody has connected an app yet.</p>
					{{{ end }}}
					<p class="form-text mb-0">Each connection is also a NodeBB API token (Settings → API Access, "MCP: …"); deleting the token there ends the connection too.</p>
				</div>
			</div>
		</div>
	</div>
</div>

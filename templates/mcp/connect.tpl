<div class="row justify-content-center mcp-connect">
	<div class="col-lg-6 col-md-8">
		<div class="card shadow-sm mt-3">
			<div class="card-body p-4">
				{{{ if found }}}
				<h4 class="fw-semibold mb-3"><i class="fa fa-plug text-primary"></i> Connect {clientName}</h4>
				<p><strong>{clientName}</strong> wants to use {forumName} as you, <strong>{username}</strong>: read what you can read, and act where your account may act. Everything it does is checked against your own forum permissions.</p>
				<p class="text-muted small mb-4">You will be sent back to <code>{redirectHost}</code>. You can disconnect it at any time from <a href="{config.relative_path}/mcp/connections">Connected apps</a>.</p>
				<form method="post" action="{config.relative_path}/mcp/connect">
					<input type="hidden" name="csrf_token" value="{config.csrf_token}">
					<input type="hidden" name="request" value="{requestId}">
					<div class="d-flex gap-2 justify-content-end">
						<button type="submit" name="action" value="deny" class="btn btn-light">Cancel</button>
						<button type="submit" name="action" value="allow" class="btn btn-primary">Allow</button>
					</div>
				</form>
				{{{ else }}}
				<h4 class="fw-semibold mb-3">This connection link has expired</h4>
				<p class="text-muted mb-0">Start connecting again from your MCP client. Links last ten minutes and work once.</p>
				{{{ end }}}
			</div>
		</div>
	</div>
</div>

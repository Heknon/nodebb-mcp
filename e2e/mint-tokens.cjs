'use strict';

/**
 * Mint NodeBB API tokens for the e2e run, idempotently.
 *
 *   NODEBB_DIR=/home/user/NodeBB node e2e/mint-tokens.cjs 0 1 2 3
 *   -> {"0":"<master token>","1":"<token for uid 1>",...}
 *
 * uid 0 is a *master* token (acts as whichever `_uid` the caller passes).
 *
 * Why a NodeBB-context script rather than the HTTP API: token creation over
 * HTTP (`POST /api/v3/admin/tokens`) demands an interactive password re-auth,
 * so it cannot be scripted. Tokens are plain db records with no in-process
 * cache, so minting them behind a running forum is safe — unlike topics or
 * settings, the live server sees them immediately.
 *
 * Re-running returns the same tokens: each is tagged by its description.
 */

const path = require('path');

const NBB = path.resolve(process.env.NODEBB_DIR || '/home/user/NodeBB');
process.chdir(NBB);

const nconf = require(path.join(NBB, 'node_modules/nconf'));
nconf.argv().env({ separator: '__' }).file({ file: path.join(NBB, 'config.json') });
nconf.set('base_dir', NBB);
nconf.set('upload_path', path.resolve(NBB, 'public/uploads'));
nconf.set('upload_url', '/assets/uploads');

// NodeBB logs through winston to stdout; keep stdout for our JSON only.
const winston = require(path.join(NBB, 'node_modules/winston'));
winston.configure({ transports: [new winston.transports.Console({ silent: true })] });

const db = require(path.join(NBB, 'src/database'));

const TAG = 'nodebb-mcp e2e';

(async () => {
	const uids = process.argv.slice(2).map(n => Number.parseInt(n, 10)).filter(n => n >= 0);
	if (!uids.length) throw new Error('usage: mint-tokens.cjs <uid> [uid...]   (0 = master token)');

	await db.init();
	await require(path.join(NBB, 'src/meta')).configs.init();
	const api = require(path.join(NBB, 'src/api'));

	const existing = await api.utils.tokens.list();
	const out = {};
	for (const uid of uids) {
		const description = `${TAG} uid=${uid}`;
		const found = existing.find(t => t && t.description === description && t.uid === uid);
		// eslint-disable-next-line no-await-in-loop
		out[uid] = found ? found.token : await api.utils.tokens.generate({ uid, description });
	}
	process.stdout.write(`${JSON.stringify(out)}\n`);
	process.exit(0);
})().catch((err) => {
	process.stderr.write(`mint-tokens: ${err && err.stack ? err.stack : err}\n`);
	process.exit(1);
});

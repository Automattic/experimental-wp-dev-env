const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
	// Only so the window can name things the way the platform does — "Show in
	// Finder" against "Show in Explorer". Nothing branches on it in the main
	// process, where `process.platform` is read directly.
	platform: process.platform,
	getSites: () => ipcRenderer.invoke('sites:get'),
	getSitesWithMeta: () => ipcRenderer.invoke('sites:getAll'),
	addSite: (dir) => ipcRenderer.invoke('sites:add', dir),
	chooseDirectory: () => ipcRenderer.invoke('dialog:choose-dir'),
	setupWordPress: (dir, options = {}) => ipcRenderer.invoke('wordpress:setup', dir, options),
	runNpmInstall: async (dir, onLog, onDone) => {
		const { installId } = await ipcRenderer.invoke('npm:install', dir);
		const logHandler = (_e, payload) => {
			if (payload.installId === installId && onLog) onLog(payload);
		};
		const doneHandler = (_e, payload) => {
			if (payload.installId === installId) {
				ipcRenderer.removeListener('npm:install:log', logHandler);
				ipcRenderer.removeListener('npm:install:done', doneHandler);
				if (onDone) onDone(payload);
			}
		};
		ipcRenderer.on('npm:install:log', logHandler);
		ipcRenderer.on('npm:install:done', doneHandler);
	}
,
	runNpmScript: async (dir, scriptName, scriptArgs, onLog, onDone) => {
		const { runId } = await ipcRenderer.invoke('npm:run-script', dir, scriptName, scriptArgs || []);
		const logHandler = (_e, payload) => {
			if (payload.runId === runId && onLog) onLog(payload);
		};
		const doneHandler = (_e, payload) => {
			if (payload.runId === runId) {
				ipcRenderer.removeListener('npm:run-script:log', logHandler);
				ipcRenderer.removeListener('npm:run-script:done', doneHandler);
				if (onDone) onDone(payload);
			}
		};
		ipcRenderer.on('npm:run-script:log', logHandler);
		ipcRenderer.on('npm:run-script:done', doneHandler);
		return { runId };
	}
,
	npmKill: (params) => ipcRenderer.invoke('npm:kill', params)
,
	openExternal: (url) => ipcRenderer.invoke('url:open', url)
,
	listEditors: () => ipcRenderer.invoke('editor:list')
,
	// With a path, opens the folder in that application — one of the detected
	// ones, which main checks. Without one, the file dialog answers instead.
	openInEditor: (sitePath, editorPath = null) => ipcRenderer.invoke('editor:open', sitePath, editorPath)
,
	// Who the patch came from and where, app-wide (#166). An empty ref forgets
	// the field it is passed to.
	getProvenance: () => ipcRenderer.invoke('provenance:get')
,
	setWporgHandle: (ref) => ipcRenderer.invoke('provenance:set-handle', ref)
,
	setContributionEvent: (ref) => ipcRenderer.invoke('provenance:set-event', ref)
,
	showSiteInFileManager: (sitePath) => ipcRenderer.invoke('dir:show', sitePath)
,
	markSiteInitialized: (sitePath) => ipcRenderer.invoke('sites:mark-initialized', sitePath)
,
	deleteSite: (sitePath) => ipcRenderer.invoke('sites:delete', sitePath)

,
	setSiteLabel: (sitePath, label) => ipcRenderer.invoke('sites:set-label', sitePath, label)
,
	setSiteTicket: (sitePath, ref, options) => ipcRenderer.invoke('sites:set-ticket', sitePath, ref, options)
,
	// Ticket branches (#108): the tickets open in a site, and moving between them.
	listBranches: (sitePath) => ipcRenderer.invoke('branches:list', sitePath)
,
	switchBranch: (sitePath, ref) => ipcRenderer.invoke('branches:switch', sitePath, ref)
,
	// The active ticket's work moved onto the current trunk (#385); progress
	// rides the switch channel.
	rebaseBranch: (sitePath) => ipcRenderer.invoke('branches:rebase', sitePath)
,
	deleteBranch: (sitePath, ref) => ipcRenderer.invoke('branches:delete', sitePath, ref)
,
	// A long-lived subscription rather than the per-run pair the installs use
	// (#173): a switch's first progress event lands a few milliseconds in, well
	// before its `invoke` answers, and a listener attached afterwards would miss
	// the start of every switch. Payloads carry `sitePath`, so one subscription
	// serves every site.
	subscribeSwitchProgress: (handler) => {
		const h = (_e, payload) => handler && handler(payload);
		ipcRenderer.on('switch:progress', h);
		return () => ipcRenderer.removeListener('switch:progress', h);
	}
,
	// The work that came along into a newly linked ticket (#108). Send-only and
	// after the fact, like the switch progress above and for the same reason:
	// the count is a worktree walk, so it arrives when it arrives.
	subscribeCarriedWork: (handler) => {
		const h = (_e, payload) => handler && handler(payload);
		ipcRenderer.on('ticket:carried-work', h);
		return () => ipcRenderer.removeListener('ticket:carried-work', h);
	}
,
	subscribeSetupProgress: (handler) => {
		const h = (_e, payload) => handler && handler(payload);
		ipcRenderer.on('download:progress', h);
		return () => ipcRenderer.removeListener('download:progress', h);
	}
,
	subscribeSetupStatus: (handler) => {
		const h = (_e, payload) => handler && handler(payload);
		ipcRenderer.on('download:status', h);
		return () => ipcRenderer.removeListener('download:status', h);
	}
,
	createPatchWindow: (sitePath) => ipcRenderer.invoke('git:create-patch', sitePath)
,
	getPatch: (sitePath) => ipcRenderer.invoke('git:get-patch', sitePath)
,
	// With `{ handoff: true }` the saved file carries the provenance header and a
	// name that says whose work it is (#166); without options it is the bare
	// diff, which is what gets attached to a ticket.
	savePatch: (sitePath, options) => ipcRenderer.invoke('git:save-patch', sitePath, options)
,
	// Opening a pull request (#167). The token stays in the main process; what
	// crosses this bridge is a login, a device code and a pull request URL —
	// nothing that authorises anything.
	getGithubAccount: () => ipcRenderer.invoke('github:account')
,
	// Resolves as soon as there is a code to show; the outcome of the wait
	// arrives at `onDone`, since the contributor is in the browser by then.
	//
	// Exactly one done-listener exists at a time, tracked in the closure below:
	// a cancelled sign-in gets no outcome event at all — the main process
	// deliberately goes quiet — so the listener cannot clean itself up the way
	// the install and script handlers above do, and each sign-in→cancel cycle
	// would otherwise leave one behind for the life of the window.
	...(() => {
		let activeDoneHandler = null;
		const dropDoneHandler = () => {
			if (!activeDoneHandler) return;
			ipcRenderer.removeListener('github:sign-in:done', activeDoneHandler);
			activeDoneHandler = null;
		};
		return {
			signInToGithub: async (onDone) => {
				// A second sign-in supersedes the first in the main process, so
				// the first's outcome is never coming either.
				dropDoneHandler();
				const doneHandler = (_e, payload) => {
					if (activeDoneHandler === doneHandler) activeDoneHandler = null;
					ipcRenderer.removeListener('github:sign-in:done', doneHandler);
					if (onDone) onDone(payload);
				};
				activeDoneHandler = doneHandler;
				ipcRenderer.on('github:sign-in:done', doneHandler);
				const started = await ipcRenderer.invoke('github:sign-in');
				// A sign-in that never started has no outcome coming.
				if (!started || !started.ok) dropDoneHandler();
				return started;
			},
			cancelGithubSignIn: () => {
				dropDoneHandler();
				return ipcRenderer.invoke('github:sign-in-cancel');
			}
		};
	})()
,
	signOutOfGithub: () => ipcRenderer.invoke('github:sign-out')
,
	openPullRequest: (sitePath, options) => ipcRenderer.invoke('github:open-pr', sitePath, options)
,
	subscribePullRequestProgress: (handler) => {
		const h = (_e, payload) => handler && handler(payload);
		ipcRenderer.on('github:pr:progress', h);
		return () => ipcRenderer.removeListener('github:pr:progress', h);
	}
,
	isWorktreeDirty: (sitePath) => ipcRenderer.invoke('git:worktree-dirty', sitePath)
,
	hasUnsubmittedWork: (sitePath) => ipcRenderer.invoke('git:unsubmitted-work', sitePath)
,
	discardChanges: (sitePath) => ipcRenderer.invoke('git:discard-changes', sitePath)
,
	discardToBase: (sitePath) => ipcRenderer.invoke('git:discard-to-base', sitePath)
,
	markUpdateComplete: (sitePath) => ipcRenderer.invoke('sites:mark-update-complete', sitePath)
,
	choosePatchFile: () => ipcRenderer.invoke('dialog:choose-patch-file')
,
	previewPatch: (sitePath, patchText) => ipcRenderer.invoke('git:preview-patch', sitePath, patchText)
,
	listTicketPatches: (sitePath) => ipcRenderer.invoke('git:list-ticket-patches', sitePath)
,
	fetchPrDiff: (number) => ipcRenderer.invoke('git:fetch-pr-diff', number)
,
	listTracAttachments: (sitePath) => ipcRenderer.invoke('trac:list-attachments', sitePath)
,
	fetchTracAttachment: (url) => ipcRenderer.invoke('trac:fetch-attachment', url)
,
	applyPatch: async (sitePath, options, onLog, onDone) => {
		const { applyId } = await ipcRenderer.invoke('git:apply-patch', sitePath, options);
		const logHandler = (_e, payload) => {
			if (payload.applyId === applyId && onLog) onLog(payload);
		};
		const doneHandler = (_e, payload) => {
			if (payload.applyId === applyId) {
				ipcRenderer.removeListener('git:apply-patch:log', logHandler);
				ipcRenderer.removeListener('git:apply-patch:done', doneHandler);
				if (onDone) onDone(payload);
			}
		};
		ipcRenderer.on('git:apply-patch:log', logHandler);
		ipcRenderer.on('git:apply-patch:done', doneHandler);
		return { applyId };
	}
,
	updateTrunk: async (sitePath, onLog, onDone) => {
		const { updateId } = await ipcRenderer.invoke('git:update-trunk', sitePath);
		const logHandler = (_e, payload) => {
			if (payload.updateId === updateId && onLog) onLog(payload);
		};
		const doneHandler = (_e, payload) => {
			if (payload.updateId === updateId) {
				ipcRenderer.removeListener('git:update-trunk:log', logHandler);
				ipcRenderer.removeListener('git:update-trunk:done', doneHandler);
				if (onDone) onDone(payload);
			}
		};
		ipcRenderer.on('git:update-trunk:log', logHandler);
		ipcRenderer.on('git:update-trunk:done', doneHandler);
		return { updateId };
	}
,
	// Resolves to the log's path as well as its unsubscribe: the panel shows the
	// path, and only the main process can compose it correctly on both platforms.
	startWpDebug: async (sitePath, onData) => {
		const handler = (_e, payload) => {
			if (payload.sitePath === sitePath && onData) onData(payload.data);
		};
		ipcRenderer.on('wp:debug-log:data', handler);
		const started = await ipcRenderer.invoke('wp-debug:start', sitePath);
		return {
			filePath: started?.filePath || '',
			unsubscribe: () => ipcRenderer.removeListener('wp:debug-log:data', handler)
		};
	},
	stopWpDebug: async (sitePath) => {
		await ipcRenderer.invoke('wp-debug:stop', sitePath);
	},
	// Empties the file, not just the panel: the tail replays what is on disk
	// every time it attaches, so a pane cleared on its own fills straight back up
	// on the next dev-server start.
	clearWpDebug: (sitePath) => ipcRenderer.invoke('wp-debug:clear', sitePath)
,
	revealWpDebug: (sitePath) => ipcRenderer.invoke('wp-debug:reveal', sitePath)
,
	startServer: async (sitePath, onLog, onUrl, onStopped) => {
		const logHandler = (_e, payload) => {
			if (payload.sitePath === sitePath && onLog) onLog(payload);
		};
		const urlHandler = (_e, payload) => {
			if (payload.sitePath === sitePath && onUrl) onUrl(payload.url);
		};
		const stoppedHandler = (_e, payload) => {
			if (payload.sitePath === sitePath) {
				ipcRenderer.removeListener('playground:log', logHandler);
				ipcRenderer.removeListener('playground:url', urlHandler);
				ipcRenderer.removeListener('playground:stopped', stoppedHandler);
				if (onStopped) onStopped();
			}
		};
		ipcRenderer.on('playground:log', logHandler);
		ipcRenderer.on('playground:url', urlHandler);
		ipcRenderer.on('playground:stopped', stoppedHandler);

		// Invoke AFTER listeners are attached so early logs/URL are captured
		return await ipcRenderer.invoke('playground:start', sitePath);
	},
	stopServer: async (sitePath) => {
		return await ipcRenderer.invoke('playground:stop', sitePath);
	}
,
	// Global Playground web server controls
	playgroundWebAvailable: async () => {
		return await ipcRenderer.invoke('playground-web:available');
	}
,
	startPlaygroundWeb: async (onLog, onUrl, onStopped) => {
		const logHandler = (_e, payload) => { if (onLog) onLog(payload); };
		const urlHandler = (_e, payload) => { if (onUrl) onUrl(payload.url); };
		const stoppedHandler = (_e, payload) => {
			ipcRenderer.removeListener('playground-web:log', logHandler);
			ipcRenderer.removeListener('playground-web:url', urlHandler);
			ipcRenderer.removeListener('playground-web:stopped', stoppedHandler);
			if (onStopped) onStopped(payload);
		};
		ipcRenderer.on('playground-web:log', logHandler);
		ipcRenderer.on('playground-web:url', urlHandler);
		ipcRenderer.on('playground-web:stopped', stoppedHandler);
		return await ipcRenderer.invoke('playground-web:start');
	},
	stopPlaygroundWeb: async () => {
		return await ipcRenderer.invoke('playground-web:stop');
	}
,
	getSiteStatus: async (sitePath) => {
		return await ipcRenderer.invoke('site:status', sitePath);
	}
,
	setSkipInitWizard: async (sitePath, skip) => {
		return await ipcRenderer.invoke('sites:set-skip-init', sitePath, skip);
	}
,
	// SMTP bridge
	getEmails: async (sitePath) => {
		return await ipcRenderer.invoke('smtp:get', sitePath);
	}
,
	clearEmails: async (sitePath) => {
		return await ipcRenderer.invoke('smtp:clear', sitePath);
	}
,
	startSmtp: async (sitePath) => {
		return await ipcRenderer.invoke('smtp:start', sitePath);
	}
,
	stopSmtp: async (sitePath) => {
		return await ipcRenderer.invoke('smtp:stop', sitePath);
	}
,
	onNewEmail: (sitePath, handler) => {
		const h = (_e, payload) => { if (payload.sitePath === sitePath && handler) handler(payload.message); };
		ipcRenderer.on('smtp:new-email', h);
		return () => ipcRenderer.removeListener('smtp:new-email', h);
	}
,
	onSmtpStarted: (sitePath, handler) => {
		const h = (_e, payload) => { if (payload.sitePath === sitePath && handler) handler(payload.port); };
		ipcRenderer.on('smtp:started', h);
		return () => ipcRenderer.removeListener('smtp:started', h);
	}
});


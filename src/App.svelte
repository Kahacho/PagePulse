<script lang="ts">
	import { onMount } from 'svelte';

	// Current tab and watch state.
	let tabId = $state<number | null>(null);
	let tabUrl = $state<string | null>(null);
	let isRunning = $state<boolean>(false);
	let isPaused = $state<boolean>(false);
	let isDarkMode = $state<boolean>(false);

	// Reload interval and match notification settings.
	let timeValue = $state<number>(10);
	let timeUnit = $state<string>('sec');
	let keyword = $state<string>('');
	let notifySound = $state<boolean>(false);

	// Randomised interval range, used when randomisation is enabled.
	let isRandomised = $state<boolean>(false);
	let randomStart = $state<number>(1);
	let randomEnd = $state<number>(10);

	const RESTRICTED_URL_PREFIXES = [
		'chrome://',
		'chrome-extension://',
		'edge://',
		'about:',
		'moz-extension://',
		'https://chrome.google.com/webstore',
		'https://chromewebstore.google.com',
		'https://addons.mozilla.org',
		'https://microsoftedge.microsoft.com/addons',
	];

	let isRestrictedPage = $derived(
		tabUrl !== null &&
			RESTRICTED_URL_PREFIXES.some((prefix) => tabUrl!.startsWith(prefix)),
	);

	// Limit page-monitoring intervals to a practical maximum of 24 hours.
	const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

	/**
	 * Converts a user-entered interval to seconds so duration limits can be
	 * enforced consistently regardless of the selected time unit. Mirrors
	 * convertToSeconds in background.js; duplicated here since this is
	 * purely for immediate UI feedback, not shared runtime logic.
	 */
	function toSeconds(value: number, unit: string): number {
		if (unit === 'min') return value * 60;
		if (unit === 'hour') return value * 3600;
		return value;
	}

	/**
	 * Validates the configured reload interval, or randomised range, in real
	 * time as the user edits it. Returns a user-facing message when invalid, or
	 * null when the current configuration is safe to start.
	 */
	let intervalError = $derived.by(() => {
		if (!isRandomised) {
			const seconds = toSeconds(timeValue, timeUnit);
			if (!Number.isFinite(seconds) || seconds < 1) {
				return 'Interval must be at least 1 second.';
			}
			if (seconds > MAX_INTERVAL_SECONDS) {
				return `Interval cannot exceed 24 hours.`;
			}
			return null;
		}

		const startSeconds = toSeconds(randomStart, timeUnit);
		const endSeconds = toSeconds(randomEnd, timeUnit);

		if (!Number.isFinite(startSeconds) || startSeconds < 1) {
			return 'Start time must be at least 1 second.';
		}
		if (!Number.isFinite(endSeconds) || endSeconds < 1) {
			return 'End time must be at least 1 second.';
		}
		if (startSeconds > MAX_INTERVAL_SECONDS) {
			return `Start time cannot exceed 24 hours.`;
		}
		if (endSeconds > MAX_INTERVAL_SECONDS) {
			return `End time cannot exceed 24 hours.`;
		}
		if (startSeconds >= endSeconds) {
			return 'Start time must be less than End time.';
		}
		return null;
	});

	/**
	 * Initialises popup state and synchronises it with the current tab.
	 */
	onMount(() => {
		const handleKeydown = (e: KeyboardEvent) => {
			// Lets the popup be dismissed with Escape, same as most native browser UI.
			if (e.key === 'Escape') window.close();
		};
		window.addEventListener('keydown', handleKeydown);

		let statusPollId: ReturnType<typeof setInterval> | undefined;

		// Restore the saved theme, falling back to the system preference.
		if (typeof chrome !== 'undefined' && chrome.storage) {
			chrome.storage.local.get(['darkMode'], (result) => {
				if (result.darkMode !== undefined) {
					isDarkMode = Boolean(result.darkMode);
				} else {
					isDarkMode = window.matchMedia(
						'(prefers-color-scheme: dark)',
					).matches;
				}
			});
		} else {
			isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
		}

		if (typeof chrome !== 'undefined' && chrome.tabs) {
			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
				if (tabs && tabs[0]?.id) {
					tabId = tabs[0].id;
					tabUrl = tabs[0].url ?? null;

					// Sync the popup with the watch state for the current page.
					chrome.runtime.sendMessage(
						{ action: 'GET_STATUS', tabId },
						(response) => {
							if (response) {
								isRunning = response.isRunning;
								if (response.isPaused !== undefined)
									isPaused = response.isPaused;
								if (response.interval) timeValue = response.interval;
								if (response.unit) timeUnit = response.unit;
								if (response.keyword) keyword = response.keyword;
								if (response.notifySound !== undefined)
									notifySound = response.notifySound;
								if (response.randomised !== undefined)
									isRandomised = response.randomised;
								if (response.range) {
									randomStart = response.range.start;
									randomEnd = response.range.end;
								}
							}
						},
					);

					// Poll only the running state so the popup stays in sync if it misses
					// a background-script update while remaining editable.
					statusPollId = setInterval(() => {
						if (
							typeof chrome === 'undefined' ||
							!chrome.runtime ||
							tabId === null
						)
							return;
						chrome.runtime.sendMessage(
							{ action: 'GET_STATUS', tabId },
							(response) => {
								if (response) {
									isRunning = response.isRunning;
									if (response.isPaused !== undefined)
										isPaused = response.isPaused;
								}
							},
						);
					}, 3000);
				}
			});
		}
		// Clean up listeners and timers when the popup is destroyed.
		return () => {
			window.removeEventListener('keydown', handleKeydown);
			if (statusPollId !== undefined) {
				clearInterval(statusPollId);
			}
		};
	});

	/**
	 * Toggles the theme and persists the user's preference.
	 */
	function toggleTheme() {
		isDarkMode = !isDarkMode;
		if (typeof chrome !== 'undefined' && chrome.storage) {
			chrome.storage.local.set({ darkMode: isDarkMode });
		}
	}

	/**
	 * Starts or stops the page watch using the current popup settings.
	 * Starting is blocked client-side when the interval is invalid; the
	 * background script re-validates independently (see isValidIntervalConfig
	 * in background.js) since a START message could originate from the
	 * keyboard shortcut instead of this form.
	 */
	function toggleReloader() {
		if (isRunning && !isPaused) {
			if (typeof chrome !== 'undefined') {
				chrome.runtime.sendMessage({ action: 'STOP', tabId }, () => {
					isRunning = false;
					isPaused = false;
				});
			}
			return;
		}

		if (intervalError) return;

		// Starting again retargets the watch to the current page.
		if (typeof chrome !== 'undefined') {
			chrome.runtime.sendMessage(
				{
					action: 'START',
					tabId,
					interval: timeValue,
					unit: timeUnit,
					keyword: keyword.trim(),
					notifySound,
					randomised: isRandomised,
					range: { start: randomStart, end: randomEnd },
				},
				() => {
					isRunning = true;
					isPaused = false;
				},
			);
		}
	}
</script>

<div class="extension-container" class:dark-mode={isDarkMode}>
	<header class="main-header">
		<div class="header-left">
			<!-- Visual status indicator; animates while the watch is running. -->
			<div class="ecg-container" class:pulsing={isRunning}>
				<svg class="ecg-svg" viewBox="0 0 100 40">
					<path
						class="ecg-path"
						d="M 0 20 L 35 20 L 40 12 L 45 28 L 52 2 L 58 38 L 63 20 L 100 20"
					/>
				</svg>
			</div>
			<h1>PagePulse</h1>
		</div>

		<div class="header-right">
			<button
				class="theme-toggle-btn"
				onclick={toggleTheme}
				aria-label="Toggle Theme"
				title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
			>
				{#if isDarkMode}
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						><circle cx="12" cy="12" r="4" /><path
							d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"
						/></svg
					>
				{:else}
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg
					>
				{/if}
			</button>

			<span class="status-badge" class:active={isRunning}>
				{isRunning ? 'In Progress' : 'Stopped'}
			</span>
		</div>
	</header>

	<div class="field-group row-input">
		<div class="label-row">
			<label for="kw-target">Target Keyword(s)</label>
			<span
				class="info-icon"
				title="Matches visible text on the page, not HTML tags or hidden elements."
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					><circle cx="12" cy="12" r="10" /><line
						x1="12"
						y1="16"
						x2="12"
						y2="12"
					/><line x1="12" y1="8" x2="12.01" y2="8" /></svg
				>
			</span>
		</div>
		<!-- Editable while paused too, not just when fully stopped -->
		<input
			id="kw-target"
			type="text"
			bind:value={keyword}
			disabled={isRunning && !isPaused}
			placeholder="e.g., Back in stock"
		/>
	</div>

	<div class="sound-toggle-row">
		<label class="toggle-switch">
			<input
				type="checkbox"
				bind:checked={notifySound}
				disabled={!keyword.trim() || (isRunning && !isPaused)}
			/>
			<span class="toggle-track"><span class="toggle-thumb"></span></span>
			<span class="toggle-text">Play sound on keyword(s) match</span>
		</label>
	</div>

	<div class="interval-section">
		<div class="section-header">
			<span class="section-title">Reload Interval</span>
			<label class="toggle-switch">
				<input
					type="checkbox"
					bind:checked={isRandomised}
					disabled={isRunning && !isPaused}
				/>
				<span class="toggle-track"><span class="toggle-thumb"></span></span>
				<span class="toggle-text">Randomise</span>
			</label>
		</div>

		{#if !isRandomised}
			<div class="input-inline-group">
				<div class="unit-icon" aria-hidden="true">
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><circle cx="12" cy="12" r="9" /><polyline
							points="12 7 12 12 15 14"
						/></svg
					>
				</div>
				<label for="time-val-input" class="sr-only">Interval Time</label>
				<label for="time-unit-select" class="sr-only">Interval Unit</label>
				<input
					id="time-val-input"
					type="number"
					bind:value={timeValue}
					disabled={isRunning && !isPaused}
					class="time-num-input"
					min="1"
					max={timeUnit == 'hour' ? 24 : undefined}
				/>
				<div class="select-wrap">
					<select
						id="time-unit-select"
						bind:value={timeUnit}
						disabled={isRunning && !isPaused}
						class="time-unit-select"
					>
						<option value="sec">Sec</option>
						<option value="min">Min</option>
						<option value="hour">Hour</option>
					</select>
					<svg
						class="select-chevron"
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</div>
			</div>
		{:else}
			<div class="matrix-fields">
				<div class="matrix-box">
					<label for="start-range" class="box-tag">Start</label>
					<input
						id="start-range"
						type="number"
						bind:value={randomStart}
						disabled={isRunning && !isPaused}
						min="1"
						max={timeUnit == 'hour' ? 24 : undefined}
					/>
				</div>
				<div class="matrix-box">
					<label for="end-range" class="box-tag">End</label>
					<input
						id="end-range"
						type="number"
						bind:value={randomEnd}
						disabled={isRunning && !isPaused}
						min="1"
						max={timeUnit == 'hour' ? 24 : undefined}
					/>
				</div>
				<div class="matrix-box">
					<label for="random-unit-select" class="box-tag">Unit</label>
					<div class="matrix-select-wrap">
						<select
							id="random-unit-select"
							bind:value={timeUnit}
							disabled={isRunning && !isPaused}
							class="matrix-select"
						>
							<option value="sec">Sec</option>
							<option value="min">Min</option>
							<option value="hour">Hour</option>
						</select>
						<svg
							class="matrix-select-chevron"
							width="9"
							height="9"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</div>
				</div>
			</div>
		{/if}
	</div>

	{#if isRestrictedPage}
		<p class="interval-error">PagePulse can't run on this page.</p>
	{:else if intervalError}
		<p class="interval-error">{intervalError}</p>
	{/if}

	<button
		class="action-btn centered"
		class:stop-mode={isRunning}
		onclick={toggleReloader}
		disabled={!isRunning && (!!intervalError || isRestrictedPage)}
	>
		{#if isRunning}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
				><rect x="4" y="4" width="16" height="16" rx="2" /></svg
			>
			<span>Stop</span>
		{:else}
			<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
				><polygon points="5 3 19 12 5 21 5 3" /></svg
			>
			<span>Play</span>
		{/if}
	</button>
</div>

<style>
	/* Theme tokens are scoped to the component to avoid host-page conflicts. */
	.extension-container {
		--bg-primary: #ffffff;
		--bg-secondary: #f8fafc;
		--bg-input: #ffffff;
		--border-color: #e2e8f0;
		--text-main: #1e293b;
		--text-muted: #64748b;
		--accent-color: #3b82f6;
		--badge-stopped: #ef4444;
		--badge-running: #22c55e;
		--input-disabled: #f1f5f9;
		--pulse-color: #94a3b8;

		width: 350px;
		min-height: 220px;
		padding: 14px;
		box-sizing: border-box;
		background: var(--bg-primary);
		color: var(--text-main);
		font-family:
			system-ui,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Roboto,
			sans-serif;
		transition: color 0.25s ease;
		border-radius: 12px;
		overflow: hidden;
	}
	.extension-container.dark-mode {
		--bg-primary: #0f172a;
		--bg-secondary: #1e293b;
		--bg-input: #1e293b;
		--border-color: #334155;
		--text-main: #f8fafc;
		--text-muted: #94a3b8;
		--accent-color: #60a5fa;
		--input-disabled: #1e293b;
		--pulse-color: #475569;
	}
	.extension-container:not(.dark-mode) select {
		color-scheme: light;
	}
	.extension-container.dark-mode select {
		color-scheme: dark;
	}
	select,
	select option {
		background-color: var(--bg-input);
		color: var(--text-main);
	}
	/* ---- Pulse / ECG status indicator ---- */
	.ecg-container {
		width: 44px;
		height: 24px;
		display: flex;
		align-items: center;
		overflow: hidden;
		background: var(--bg-secondary);
		border-radius: 6px;
		border: 1px solid var(--border-color);
		padding: 0 2px;
		margin-right: 8px;
	}
	.ecg-svg {
		width: 100%;
		height: 100%;
	}
	.ecg-path {
		fill: none;
		stroke: var(--pulse-color);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-dasharray: 200;
		stroke-dashoffset: 0;
	}
	.ecg-container.pulsing {
		border-color: rgba(34, 197, 94, 0.4);
		background: rgba(34, 197, 94, 0.05);
	}
	.ecg-container.pulsing .ecg-path {
		stroke: #22c55e;
		animation: heart-pulse 1.6s linear infinite;
	}
	@keyframes heart-pulse {
		0% {
			stroke-dashoffset: 200;
		}
		100% {
			stroke-dashoffset: 0;
		}
	}
	/* ---- Header ---- */
	.main-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--border-color);
		padding-bottom: 10px;
		margin-bottom: 14px;
	}
	.header-left {
		display: flex;
		align-items: center;
	}
	.header-left h1 {
		font-size: 16px;
		margin: 0;
		font-weight: 700;
		letter-spacing: -0.025em;
	}
	.header-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.theme-toggle-btn {
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		color: var(--text-muted);
		padding: 5px;
		border-radius: 6px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
	}
	.theme-toggle-btn:hover {
		color: var(--text-main);
		border-color: var(--accent-color);
	}
	/* ---- Status badge ---- */
	.status-badge {
		font-size: 11px;
		font-weight: 600;
		padding: 3px 8px;
		border-radius: 20px;
		background: var(--badge-stopped);
		color: white;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}
	.status-badge.active {
		background: var(--badge-running);
		animation: pulse-glow 2s infinite;
	}
	@keyframes pulse-glow {
		0% {
			box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4);
		}
		70% {
			box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
		}
	}
	/* ---- Keyword input ---- */
	.row-input {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-bottom: 14px;
	}
	.row-input label {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.row-input input {
		padding: 8px 10px;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		font-size: 13px;
		background: var(--bg-input);
		color: var(--text-main);
		outline: none;
		transition: border-color 0.2s;
	}
	.row-input input:focus {
		border-color: var(--accent-color);
	}
	.label-row {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.info-icon {
		display: inline-flex;
		align-items: center;
		color: var(--text-muted);
		cursor: help;
	}
	.info-icon:hover {
		color: var(--accent-color);
	}
	.sound-toggle-row {
		margin-bottom: 12px;
	}
	/* ---- Interval section (fixed interval + randomised range) ---- */
	.interval-section {
		background: var(--bg-secondary);
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 12px;
		margin-bottom: 12px;
	}
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}
	.section-title {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	/* Flex layout keeps the input stable across different unit labels. */
	.input-inline-group {
		display: flex;
		align-items: stretch;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		overflow: hidden;
		background: var(--bg-input);
	}
	.unit-icon {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--text-muted) 14%, var(--bg-input));
	}
	.time-num-input {
		flex: 1 1 auto;
		min-width: 0;
		width: auto;
		border: none;
		padding: 9px;
		text-align: center;
		font-size: 14px;
		background: transparent;
		color: var(--text-main);
		outline: none;
	}
	.select-wrap {
		position: relative;
		flex: 0 0 auto;
		display: flex;
		align-items: stretch;
	}
	.time-unit-select {
		width: 90px;
		height: 100%;
		box-sizing: border-box;
		border: none;
		border-left: 1px solid var(--border-color);
		background: color-mix(in srgb, var(--text-muted) 12%, var(--bg-input));
		color: var(--text-main);
		font-weight: 600;
		padding: 4px 22px 4px 10px;
		font-size: 12px;
		cursor: pointer;
		outline: none;
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
	}
	.select-chevron {
		position: absolute;
		right: 8px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		pointer-events: none;
	}
	/* Hidden checkbox remains accessible while the track provides the visual control. */
	.toggle-switch {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	.toggle-switch input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}
	.toggle-track {
		position: relative;
		width: 32px;
		height: 18px;
		background: var(--border-color);
		border-radius: 999px;
		transition: background 0.2s ease;
	}
	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #ffffff;
		transition: transform 0.2s ease;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
	}
	.toggle-switch input:checked + .toggle-track {
		background: var(--accent-color);
	}
	.toggle-switch input:checked + .toggle-track .toggle-thumb {
		transform: translateX(14px);
	}
	.toggle-switch input:disabled + .toggle-track {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.toggle-text {
		font-size: 11px;
		font-weight: 500;
		color: var(--text-main);
	}
	/* Randomised-range row: Start / End / Unit as matching boxes */
	.matrix-fields {
		display: flex;
		gap: 8px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px dashed var(--border-color);
	}
	.matrix-box {
		flex: 1;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border-color);
		border-radius: 6px;
		overflow: hidden;
		background: var(--bg-input);
	}
	.box-tag {
		font-size: 9px;
		text-transform: uppercase;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--border-color);
		text-align: center;
		padding: 3px 0;
	}
	.matrix-box input {
		border: none;
		background: transparent;
		padding: 5px;
		text-align: center;
		font-size: 12px;
		color: var(--text-main);
		width: 100%;
		box-sizing: border-box;
		outline: none;
	}
	.matrix-box select {
		border: none;
		background: transparent;
		padding: 5px;
		text-align: center;
		font-size: 12px;
		color: var(--text-main);
		width: 100%;
		box-sizing: border-box;
		outline: none;
		cursor: pointer;
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
		text-align-last: center;
	}
	/* Match the unit selector's dimensions and styling to its sibling fields. */
	.matrix-select-wrap {
		position: relative;
		width: 100%;
	}
	.matrix-select {
		width: 100%;
		box-sizing: border-box;
		border: none;
		background: transparent;
		color: var(--text-main);
		padding: 5px 20px 5px 5px;
		text-align: center;
		font-size: 12px;
		cursor: pointer;
		outline: none;
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
		text-align-last: center;
	}
	.matrix-select-chevron {
		position: absolute;
		right: 4px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		pointer-events: none;
	}

	/* ---- Validation feedback ---- */
	.interval-error {
		font-size: 11px;
		color: var(--badge-stopped);
		margin: -4px 0 10px;
		text-align: center;
	}

	/* ---- Play / Stop button ---- */
	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		background: var(--badge-running);
		color: white;
		border: none;
		padding: 9px 18px;
		border-radius: 6px;
		font-weight: 600;
		font-size: 13px;
		cursor: pointer;
		min-width: 140px;
		box-shadow: 0 2px 4px rgba(34, 197, 94, 0.15);
		transition:
			background-color 0.2s ease,
			box-shadow 0.2s ease;
		will-change: background-color, box-shadow;
		-webkit-font-smoothing: antialiased;
	}
	.action-btn svg,
	.action-btn span {
		pointer-events: none;
	}
	.action-btn:hover {
		background: #16a34a;
		transform: translateY(-0.5px);
		box-shadow: 0 4px 6px rgba(34, 197, 94, 0.3);
	}
	.action-btn:active {
		transform: translateY(0.5px);
	}
	.action-btn.stop-mode {
		background: var(--badge-stopped);
		box-shadow: 0 2px 4px rgba(239, 68, 68, 0.2);
	}
	.action-btn.stop-mode:hover {
		box-shadow: 0 4px 6px rgba(239, 68, 68, 0.25);
	}
	.action-btn.centered {
		margin: 4px auto 0;
	}
	/* ---- Accessibility ---- */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>

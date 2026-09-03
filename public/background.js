// Live state for currently active page watches.
// Keys combine tab ID and normalised URL; see watchKey().
let activeReloaders = {};

// Last-used configuration for each page, persisted across popup sessions.
let lastConfig = {};

chrome.storage.local.get(['lastConfig'], (result) => {
	if (result.lastConfig) lastConfig = result.lastConfig;
});

/**
 * Normalises a page URL for use as a watch identity.
 * Query strings and hashes are ignored so equivalent pages share one watch.
 */
function normalizeUrl(url) {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		// Some browser-internal URLs cannot be parsed by URL().
		return url;
	}
}

/**
 * Builds a unique watch key from a tab and normalised page URL.
 * This allows different pages visited in the same tab to maintain
 * independent watch state.
 */
function watchKey(tabId, url) {
	return `${tabId}::${normalizeUrl(url)}`;
}

// Persists the latest configuration for a page watch.
function saveLastConfig(key, config) {
	lastConfig[key] = config;
	chrome.storage.local.set({ lastConfig });
}

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

/**
 * Determines whether a URL is restricted from extension script execution.
 * Browser-internal pages and extension store pages cannot be accessed by
 * extensions, regardless of granted host permissions.
 */
function isRestrictedUrl(url) {
	if (!url) return true;
	return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Sets badge text while safely ignoring errors caused by a tab that
 * disappears before the update completes.
 */
function safeSetBadgeText(details) {
	try {
		const result = chrome.action.setBadgeText(details);
		if (result && typeof result.catch === 'function') {
			result.catch(() => {});
		}
	} catch {
		// Older callback-style engines may throw synchronously.
	}
}

function convertToSeconds(val, unit) {
	if (unit === 'min') return val * 60;
	if (unit === 'hour') return val * 3600;
	return val; // default 'sec'
}

// Limit page-monitoring intervals to a practical maximum of 24 hours.
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Validates a reload configuration against the supported duration limits
 * and, for randomised watches, ensures the range is valid and ordered.
 */

function isValidIntervalConfig(interval, unit, randomised, range) {
	if (!randomised) {
		const seconds = convertToSeconds(interval, unit);
		return (
			Number.isFinite(seconds) &&
			seconds >= 1 &&
			seconds <= MAX_INTERVAL_SECONDS
		);
	}

	const startSeconds = convertToSeconds(range?.start, unit);
	const endSeconds = convertToSeconds(range?.end, unit);
	return (
		Number.isFinite(startSeconds) &&
		Number.isFinite(endSeconds) &&
		startSeconds >= 1 &&
		endSeconds >= 1 &&
		startSeconds <= MAX_INTERVAL_SECONDS &&
		endSeconds <= MAX_INTERVAL_SECONDS &&
		startSeconds < endSeconds
	);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// The _sender is unused, but retained so sendResponse remains the third argument.
	const {
		action,
		tabId,
		interval,
		unit,
		keyword,
		randomised,
		range,
		notifySound,
	} = message;

	if (action === 'START') {
		chrome.tabs.get(tabId, (tab) => {
			// Reject requests for tabs that no longer exist.
			if (chrome.runtime.lastError || !tab) {
				sendResponse({ status: 'rejected' });
				return;
			}

			// Reject requests for restricted URLs.
			if (isRestrictedUrl(tab.url)) {
				sendResponse({ status: 'rejected' });
				return;
			}

			// Reject invalid configurations before starting the reload loop.
			if (!isValidIntervalConfig(interval, unit, randomised, range)) {
				sendResponse({ status: 'rejected' });
				return;
			}

			const key = watchKey(tabId, tab.url);
			clearTabTimer(key); // Makes sure an existing watch for this exact page isn't left running.
			startIntervalLoop(
				tabId,
				key,
				tab.url,
				interval,
				unit,
				keyword,
				randomised,
				range,
				notifySound,
			);
			saveLastConfig(key, {
				interval,
				unit,
				keyword,
				randomised,
				range,
				notifySound,
			});
			sendResponse({ status: 'running' });
		});
		return true; // Keep the message channel alive/open for the async response
	}

	if (action === 'STOP') {
		chrome.tabs.get(tabId, (tab) => {
			const key = watchKey(tabId, tab.url);
			stopReloader(key);
			sendResponse({ status: 'stopped' });
		});
		return true; // Keep the message channel alive/open for the async response
	}

	if (action === 'GET_STATUS') {
		// Read persisted config here because the background context may restart
		// between popup sessions.
		chrome.tabs.get(tabId, (tab) => {
			const key = watchKey(tabId, tab.url);
			const active = activeReloaders[key];
			chrome.storage.local.get(['lastConfig'], (result) => {
				const remembered = (result.lastConfig || {})[key];
				sendResponse({
					isRunning: !!active,
					isPaused: false,
					interval: active?.interval ?? remembered?.interval ?? 10,
					unit: active?.unit ?? remembered?.unit ?? 'sec',
					keyword: active?.keyword ?? remembered?.keyword ?? '',
					randomised: active?.randomised ?? remembered?.randomised ?? false,
					range: active?.range ?? remembered?.range ?? { start: 1, end: 10 },
					notifySound: active?.notifySound ?? remembered?.notifySound ?? false,
				});
			});
		});
		return true; // Keep the message channel alive/open for the async response
	}

	return true;
});

// Clicking a match notification switches to and focuses the tab it came from.
chrome.notifications.onClicked.addListener((notificationId) => {
	const tabId = parseInt(notificationId.replace('pagepulse-match-', ''), 10);
	if (!tabId) return;

	chrome.tabs.update(tabId, { active: true }, (tab) => {
		if (chrome.runtime.lastError || !tab) return; // Tab may have been closed.
		chrome.windows.update(tab.windowId, { focused: true });
	});

	chrome.notifications.clear(notificationId);
});

/**
 * Keyboard-triggered start/stop for the current tab. Mirrors the popup's
 * own Play/Stop toggle, reuses a page's last saved settings if it has
 * any, otherwise falls back to sensible defaults so this works even on
 * a page that's never been started from the popup before. Runs the same
 * isValidIntervalConfig guard as the popup path, since a saved config could
 * in principle be stale or malformed.
 */
chrome.commands.onCommand.addListener((command) => {
	if (command !== 'toggle-reload') return;

	chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
		const tab = tabs[0];
		if (!tab || !tab.id) return;

		const key = watchKey(tab.id, tab.url);

		// Reject requests for restricted URLs.
		if (isRestrictedUrl(tab.url)) return;

		if (activeReloaders[key]) {
			stopReloader(key);
			return;
		}

		chrome.storage.local.get(['lastConfig'], (result) => {
			const remembered = (result.lastConfig || {})[key] || {
				interval: 10,
				unit: 'sec',
				keyword: '',
				randomised: false,
				range: { start: 1, end: 10 },
				notifySound: false,
			};

			if (
				!isValidIntervalConfig(
					remembered.interval,
					remembered.unit,
					remembered.randomised,
					remembered.range,
				)
			) {
				return;
			}

			startIntervalLoop(
				tab.id,
				key,
				tab.url,
				remembered.interval,
				remembered.unit,
				remembered.keyword,
				remembered.randomised,
				remembered.range,
				remembered.notifySound,
			);
			saveLastConfig(key, remembered);
		});
	});
});

/**
 * Formats remaining seconds for the toolbar badge using the largest
 * practical time unit to keep the display compact and readable.
 */
function formatCountdown(totalSeconds) {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
	return `${Math.floor(totalSeconds / 3600)}h`;
}

/**
 * Starts a sequential reload cycle for a page watch.
 * The cycle waits for the configured interval, reloads the target page,
 * checks for the keyword, then schedules the next cycle if no match is found.
 */
function startIntervalLoop(
	tabId,
	key,
	targetUrl,
	interval,
	unit,
	keyword,
	randomised,
	range,
	notifySound,
) {
	let targetSeconds = convertToSeconds(interval, unit);
	if (randomised && range) {
		const minSec = convertToSeconds(range.start, unit);
		const maxSec = convertToSeconds(range.end, unit);
		targetSeconds = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
	}
	let currentCountdown = targetSeconds;

	// Self-scheduling timeout keeps reloads strictly sequential; setInterval could
	// start another cycle before the previous reload/check has completed.
	const tick = () => {
		if (!activeReloaders[key]) return; // watch was stopped

		chrome.tabs.get(tabId, (tab) => {
			if (chrome.runtime.lastError || !tab) {
				// If the tab disappeared like being closed, clean up the watch.
				// A user could close the tab while PagePulse is still waiting.
				stopReloader(key);
				return;
			}
			if (!activeReloaders[key]) return;

			// Do not reload a different page if the user navigates away.
			// The watch resumes when the target page becomes active again.
			const onTarget = normalizeUrl(tab.url) === normalizeUrl(targetUrl);
			if (!onTarget) {
				activeReloaders[key].tickerId = setTimeout(tick, 1000);
				return;
			}

			safeSetBadgeText({
				tabId,
				text: formatCountdown(currentCountdown),
			});
			chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });

			if (currentCountdown > 0) {
				currentCountdown--;
				activeReloaders[key].tickerId = setTimeout(tick, 1000);
				return;
			}

			safeSetBadgeText({ tabId, text: '🗘' });
			chrome.tabs.reload(tabId, { bypassCache: true }, () => {
				const listener = (updatedTabId, changeInfo) => {
					if (updatedTabId !== tabId || changeInfo.status !== 'complete')
						return;
					chrome.tabs.onUpdated.removeListener(listener);
					if (!activeReloaders[key]) return; // stopped mid-reload

					const proceed = () => {
						if (!activeReloaders[key]) return; // may have been stopped during the check
						if (randomised && range) {
							const minSec = convertToSeconds(range.start, unit);
							const maxSec = convertToSeconds(range.end, unit);
							targetSeconds =
								Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
						}
						currentCountdown = targetSeconds;
						activeReloaders[key].tickerId = setTimeout(tick, 1000);
					};

					// Without a keyword, continue reloading without performing detection.
					if (keyword && keyword.trim()) {
						checkPageForKeyword(tabId, keyword, proceed, key, notifySound);
					} else {
						proceed();
					}
				};
				if (activeReloaders[key])
					activeReloaders[key].pendingListener = listener;
				chrome.tabs.onUpdated.addListener(listener);
			});
		});
	};

	activeReloaders[key] = {
		tickerId: setTimeout(tick, 1000),
		interval,
		unit,
		keyword,
		randomised: randomised,
		range,
		targetUrl,
		tabId,
		notifySound,
	};
}

/**
 * Cancels the scheduled work associated with a page watch.
 */
function clearTabTimer(key) {
	// Remove any listener waiting for a reload to complete.
	const entry = activeReloaders[key];
	if (entry) {
		clearTimeout(entry.tickerId);
		if (entry.pendingListener) {
			chrome.tabs.onUpdated.removeListener(entry.pendingListener);
		}
		safeSetBadgeText({ tabId: entry.tabId, text: '' });
	}
}

/**
 * Stops and removes a page watch from active state. Unconditional so a
 * stop always takes effect, even if this key isn't currently active in
 * memory, activeReloaders can be empty right after the background
 * script restarts.
 */
function stopReloader(key) {
	clearTabTimer(key);
	delete activeReloaders[key];
}

/**
 * Ensures Chromium-based browsers (Chrome, Brave, Edge) have an offscreen
 * document available for audio playback. Firefox uses the background page
 * directly and does not need this workaround.
 */
async function ensureOffscreenDocument() {
	if (!chrome.offscreen) return; // Firefox does not expose the Offscreen API.
	const existing = await chrome.offscreen.hasDocument?.();
	if (existing) return;
	await chrome.offscreen.createDocument({
		url: 'offscreen.html',
		reasons: ['AUDIO_PLAYBACK'],
		justification: 'Play sound on keyword(s) match',
	});
}

/**
 * Plays the configured match sound using the appropriate browser mechanism.
 */
function playMatchSound() {
	if (chrome.offscreen) {
		ensureOffscreenDocument().then(() => {
			chrome.runtime.sendMessage({ action: 'PLAY_SOUND' });
		});
	} else {
		const audio = new Audio(chrome.runtime.getURL('success.mp3'));
		audio.play().catch((e) => console.log('Background playback error:', e));
	}
}

/**
 * Searches the target page for a keyword and handles a successful match.
 * Stops the watch, optionally plays a sound, notifies the user, and
 * highlights the first matching text node.
 */
function checkPageForKeyword(tabId, keyword, onNotFound, key, notifySound) {
	chrome.scripting.executeScript(
		{
			target: { tabId: tabId },
			func: (word) => {
				// Search visible page text as a single string so phrases split across
				// inline elements can still be detected.
				const lowerWord = word.toLowerCase();
				const bodyText =
					document.body.innerText || document.body.textContent || '';
				const found = bodyText.toLowerCase().includes(lowerWord);

				// Highlighting is node-based, so split text can be detected but not
				// reliably wrapped as a single <mark>.
				if (found) {
					const walker = document.createTreeWalker(
						document.body,
						NodeFilter.SHOW_TEXT,
					);
					let node;
					while ((node = walker.nextNode())) {
						const idx = node.nodeValue.toLowerCase().indexOf(lowerWord);
						if (idx !== -1) {
							const range = document.createRange();
							range.setStart(node, idx);
							range.setEnd(node, idx + word.length);
							const mark = document.createElement('mark');
							mark.style.background = '#facc15';
							mark.style.color = '#000';
							range.surroundContents(mark);
							mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
							break;
						}
					}
				}
				return found;
			},
			args: [keyword],
		},
		(results) => {
			if (chrome.runtime.lastError) {
				console.error(
					'executeScript failed:',
					chrome.runtime.lastError.message,
				);
				onNotFound();
				return;
			}
			if (!results || !results[0] || results[0].result !== true) {
				onNotFound();
				return;
			}

			stopReloader(key);
			if (notifySound) playMatchSound();

			// Best-effort only, if the popup isn't open there's nothing to
			// receive this, and that's fine, so the rejection is swallowed.
			chrome.runtime
				.sendMessage({ action: 'MATCH_FOUND', tabId, keyword })
				.catch(() => {});

			// Encode the tab ID so notification clicks can restore the source tab.
			chrome.notifications.create(`pagepulse-match-${tabId}`, {
				type: 'basic',
				iconUrl: chrome.runtime.getURL('icons/icon128.png'),
				title: 'Match Found!',
				message: `Found "${keyword}". Stopping Refresh.`,
			});
		},
	);
}

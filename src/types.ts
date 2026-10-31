export type TimeUnit = 'sec' | 'min' | 'hour';

/** A randomised reload window, expressed in the watch's configured unit. */
export interface IntervalRange {
	start: number;
	end: number;
}

/** The settings a user configures for a single watched page. */
export interface WatchConfig {
	interval: number;
	unit: TimeUnit;
	keyword: string;
	randomised: boolean;
	range: IntervalRange;
	notifySound: boolean;
	bypassCache: boolean;
}

/** Runtime state for a watch that is currently active, layered on top of its configuration. */
export interface ActiveReloader extends WatchConfig {
	tickerId: ReturnType<typeof setTimeout>;
	targetUrl: string;
	tabId: number;
	pendingListener?: (
		tabId: number,
		changeInfo: chrome.tabs.OnUpdatedInfo,
	) => void;
}

/**
 * Raw shape of a message received by the background script's listener.
 * Only `action` and `tabId` are guaranteed present; the remaining fields
 * are populated depending on which action was sent.
 */
export interface IncomingMessage {
	action: string;
	tabId: number;
	interval?: number;
	unit?: TimeUnit;
	keyword?: string;
	randomised?: boolean;
	range?: IntervalRange;
	notifySound?: boolean;
	bypassCache?: boolean;
}

/** Response shape for a GET_STATUS request. */
export interface StatusResponse {
	isRunning: boolean;
	isPaused: boolean;
	interval: number;
	unit: TimeUnit;
	keyword: string;
	randomised: boolean;
	range: IntervalRange;
	notifySound: boolean;
	bypassCache: boolean;
}

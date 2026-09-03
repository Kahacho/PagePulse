/**
 * Handles sound playback requests from the service worker.
 *
 * Chromium-based browsers' (Chrome, Brave, Edge) MV3 service workers cannot
 * access the DOM or create an <audio> element, so sound playback is delegated
 * to this offscreen document. Firefox plays sounds directly from its background
 * page and does not use this document.
 */

chrome.runtime.onMessage.addListener((message) => {
	if (message.action === 'PLAY_SOUND') {
		const audio = new Audio(chrome.runtime.getURL('success.mp3'));
		// Playback may be rejected when the browser has no recent user gesture.
		// Handle the rejection to prevent an unhandled promise error.
		audio.play().catch((e) => console.log('Offscreen playback error:', e));
	}
});

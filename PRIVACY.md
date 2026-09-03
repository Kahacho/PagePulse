# Privacy and Data Practices

PagePulse was built to do one job well, reload a page and watch for a word or phrase you are waiting for, and nothing else. It doesn't collect, transmit, sell, or share any information about you or the pages you use it on. This document explains exactly what the extension does with data, in plain language, and why.

## The Short Version

PagePulse itself does not communicate with any external server. When monitoring a page, PagePulse periodically instructs the browser to reload the target page, after which the browser makes the normal network requests required to retrieve and display that page. Every setting you enter, every page it watches, and every match it finds stays on your own device, inside your browser's built-in extension storage. PagePulse does not transmit any information; not to us, not to any third party, not for analytics, not for anything.

## What PagePulse Actually Does With Your Data

**Keywords and settings, stored locally only:** When you set a target phrase, an interval, or turn on randomised reloading, that configuration is saved using your browser's built-in extension storage (`chrome.storage.local`). This is the same mechanism any well-behaved extension uses to remember your preferences between sessions, it is stored locally in the browser's extension storage and is never transmitted anywhere by PagePulse.

**Page scanning happens entirely on your device:** When PagePulse checks a page for your target phrase, it reads the page's visible text directly in your browser to look for a match. That check runs locally, produces a yes/no result, and nothing about the page's content, matched or not, ever leaves your machine.

**Per-page memory, also local:** PagePulse remembers separate settings for different pages you have configured, so navigating between them doesn't mix things up. This, too, lives only in local browser's built-in extension storage.

**Theme preference:** Your light or dark mode preference is saved locally and only used to remember your preference for next time.

## What PagePulse Does Not Do

- It does not collect analytics, usage statistics, or telemetry of any kind.
- It does not track your browsing activity or history, or collect information about the sites you visit. It only accesses the content of a page when you explicitly ask it to monitor that page.
- It does not use cookies, fingerprinting, or any cross-site tracking mechanism.
- It does not make network requests to any external server, and has no backend of its own.
- It does not sell, rent, share, or otherwise disclose any data because none is ever collected in the first place.

## Why It Needs The Permissions It Asks For

Browser extensions are required to declare upfront what they are capable of, which can look broader than what is actually used day-to-day. Here is what each permission is for and why it is necessary:

- **Tabs / active tab:** To know which page you are currently on, so PagePulse can reload and watch the right one.
- **Scripting:** To check a page's visible text for your target phrase after each reload.
- **Host access to all sites:** Since PagePulse is meant to work on whatever page _you_ choose, not a pre-set list, it needs the ability to run on any site you point it at. Browser-internal and extension-store pages are explicitly excluded because scripts cannot be executed there.
- **Storage:** To remember your settings locally, as described above.
- **Notifications:** To let you know, via your operating system's normal notification system, when a match has been found.

None of these permissions are used to collect or transmit data; only to perform the reload-and-watch function you have configured.

## Open Source, By Design

PagePulse's entire source code is publicly available on GitHub. This isn't just a technical detail, it is the actual guarantee behind everything above. Rather than asking you to simply trust a written policy, we would rather you (or anyone technically inclined) be able to verify it directly: read the code, see exactly what runs, and confirm for yourself that nothing here does anything other than what is described. If you ever spot something that doesn't match this document, please open an issue or a pull request, we take that seriously, and it is exactly what the open-source structure is for.

## A Note For Users Everywhere

PagePulse is used by people in many different countries, under many different data protection frameworks, from the EU's GDPR to California's CCPA and others. Because PagePulse does not collect or transmit personal data to us, there is no PagePulse server-side user database, analytics system, or data-sharing operation to describe. The legal requirements applicable to a particular user or organisation may vary by jurisdiction, so this document is not intended to provide legal advice. There simply isn't any data changing hands between you and us. If you have specific compliance questions for your organisation or jurisdiction, we would encourage consulting someone qualified to advise on that, but from a plain-facts standpoint: nothing you enter into PagePulse is ever seen by anyone but you.

## Questions or Concerns

If anything here is unclear, or you would like to verify a specific behaviour in the code, the best place to reach us is the project's GitHub repository, open an issue, start a discussion, or submit a pull request. We are glad to have more eyes on this.

---

_This document describes PagePulse's practices as of the version you are using. It is not a substitute for legal advice._

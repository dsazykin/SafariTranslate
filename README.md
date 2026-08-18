# SafariTranslate

Full-page translation for Safari, built to feel like Chrome's built-in Google Translate:
land on a foreign-language page, get offered a translation, and read the whole thing in
place — links, formatting and layout intact.

## Why this exists

Safari's own translation is per-page, all-or-nothing, and limited in language coverage.
This extension restores the Chrome behaviour: automatic language detection, an offer bar,
per-site "always / never" rules, dynamic content that keeps translating as you scroll,
and a one-click return to the original.

## How it translates

The naive approach — translate every text node on its own — produces bad output, because
the engine sees `The`, `quick`, `fox` as three unrelated fragments. Instead the page is
split into **units**: the innermost block element that contains text. Each unit is
serialised into one string with its inline children replaced by numbered markers, so the
engine sees a whole sentence with its structure attached:

```
<p>You have <b>3 new messages</b> in your <a href="/inbox">inbox</a>.</p>
  ->  "You have <x0>3 new messages</x0> in your <x1>inbox</x1>."
  ->  "In Ihrem <x1>Posteingang</x1> warten <x0>3 neue Nachrichten</x0>."
```

Note that German moved `<x1>` in front of `<x0>`. Japanese does this constantly. So
reconstruction rebuilds the unit's child list in the *translated* order, **moving the
original element nodes** rather than cloning them — which is why event listeners, hrefs,
`id`s, classes and inline styles all survive translation untouched.

Other behaviour worth knowing:

- **Never touched:** `<script>`, `<style>`, `<code>`, `<pre>`, `<kbd>`, `<textarea>`,
  form inputs, SVG/MathML, anything with `translate="no"`, `.notranslate`, or
  `contenteditable`.
- **Also translated:** `title`, `alt`, `placeholder` and `aria-label` attributes, plus the
  document title.
- **Reading order first.** Units are sorted by distance from the viewport, so what you are
  looking at arrives first and the rest streams in behind it.
- **Dynamic pages.** A `MutationObserver` picks up infinite scroll and SPA navigation. If a
  framework re-renders a unit that was already translated, its snapshot is dropped and the
  new content is translated fresh.
- **Open shadow roots** are walked too, so component-based sites are covered.
- **Show original** restores the DOM exactly — this is asserted byte-for-byte in the tests.

## Translation backends

Pick one in Settings. All three are implemented behind a common interface, so switching is
a dropdown, and the marker scheme above works identically across them.

| Provider | Key | Cost | Notes |
|---|---|---|---|
| **Google (free)** | none | free | The same undocumented endpoint Chrome's translator calls. Default. Not covered by Google's terms for third-party use; heavy use can be rate-limited by IP. |
| **Google Cloud Translation** | required | ~$20 / million chars | Official and stable. 500k chars/month free for the first year. A long article is 5–15k chars. |
| **DeepL** | required | 500k chars/month free | Better prose for major European languages; ~30 languages instead of 100+. Free-tier keys end in `:fx`. |

Translations are cached (in memory, mirrored to `storage.local`, ~20k entries) so revisiting
a page costs nothing. Requests are batched, capped at 6 in flight, and retried with backoff
on 429/5xx.

## Building and installing

Safari extensions must be wrapped in a signed macOS app, which needs **full Xcode** — the
Command Line Tools are not enough.

```sh
# 1. Install Xcode from the App Store, then point the toolchain at it:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept

# 2. Build, sign ad-hoc, register with Safari:
npm run build
```

The app is built to `~/Applications/SafariTranslate/` and launched once to register the
extension. That path matters: Xcode's own `RegisterWithLaunchServices` step binds the
extension to whatever path it builds into, and registering a *copy* elsewhere afterwards
does not take — PlugInKit keeps pointing at the build location. So the build writes
straight to its final home rather than building and then copying to `/Applications`.
Override with `INSTALL_DIR=/some/path npm run build`.

Then, once, in Safari:

1. Settings → Advanced → **Show features for web developers**.
2. Settings → Developer → **Allow unsigned extensions**.
   Ad-hoc signed builds need this, and **it resets every time Safari restarts**. Signing
   with a paid Apple Developer certificate ($99/yr) makes the install permanent.
3. Settings → Extensions → enable **SafariTranslate** and grant site access.
   "Always Allow on Every Website" matches how Chrome's translator behaves.

## Tests

```sh
npm test        # engine invariants against the live free endpoint
npm run test:real   # same, against a real Wikipedia article fixture
```

The suite runs the actual content script inside jsdom with a stubbed extension API and a
live translation backend, and asserts the things that are easy to get wrong: inline
elements reordered correctly, node identity and `href`s preserved, `code`/`pre`/`notranslate`
left alone, no leftover `<xN>` markers, and an exact restore.

## Layout

```
extension/
  manifest.json
  src/
    content.js      DOM walker, serialiser, marker parser, reconstruction, observers
    background.js   settings, cache, scheduling, retry, provider dispatch
    providers.js    the three backends behind one interface
    langs.js        language table + code normalisation
    popup.*         toolbar UI
    options.*       settings page
tests/            jsdom harness + suites
scripts/          Safari packaging
```

# Accessibility

HelixSync should be usable by everyone who wants to sync their own browser
data, whatever input method, assistive technology, language or reading
direction they use. This applies to the browser extension popup and the web
dashboard. This document says what we aim for, what has and hasn't been
checked, how to report a barrier, and what we expect from contributors.

If something in HelixSync stopped you from doing a task, please tell us (see
[Reporting accessibility issues](#reporting-accessibility-issues)). You don't
need to explain why you hit it.

## Priorities

- **Keyboard use.** Every action in the popup and dashboard should work
  without a mouse, with a visible focus indicator and a sensible tab order.
- **Screen readers.** Controls have accessible names, and errors and status
  messages are announced rather than only shown visually.
- **Readable content.** Text has enough contrast, is not conveyed by colour
  alone, and the layout survives zooming and larger text.
- **Language and direction.** The interface is available in English,
  Hungarian, German, Spanish, French, Simplified Chinese and Arabic, and
  Arabic is laid out right-to-left.

We use WCAG 2.2 level AA as an aspirational target. **HelixSync has not been
formally evaluated against it and makes no conformance claim.**

## Contributor expectations

For any user-facing change to `web/` or `extension/`:

- Use native elements (`button`, `a`, `label`, `input`) before custom widgets;
  give icon-only controls an accessible name.
- Keep every control reachable and operable by keyboard, with visible focus.
- Don't rely on colour alone; check contrast for new colours.
- Route all new visible text and accessible names through the i18n catalogs
  (see [i18n.md](i18n.md)) so they're translated, and check the layout in
  Arabic (right-to-left).
- Announce dynamic errors and status changes (for example `role="alert"` or
  `role="status"`).
- In the pull request, say how you checked: keyboard-only pass, a screen reader
  if you used one (name it), and browser zoom/text size.

There is currently no automated accessibility check in CI; manual checking is
the expectation until one is added.

## Reporting accessibility issues

Open a [GitHub issue](https://github.com/GhaziAlibi/helixsync/issues/new/choose)
using the bug report form and choose the *Browser extension* or *Web dashboard*
component. Please include, as far as you know:

- what you were trying to do and what happened instead;
- the page or popup screen;
- browser and version, operating system;
- assistive technology and version, if any.

Screenshots or recordings are optional. You don't have to disclose a
disability. Don't paste passwords, tokens or synced browsing data. If you
can't use GitHub, contact the maintainer through the profile at
<https://github.com/GhaziAlibi>.

### Severity

- **Blocker** – a task can't be completed at all (for example, sign-in or
  recovery can't be done by keyboard or screen reader).
- **Major** – the task can be completed only with great difficulty or a
  workaround.
- **Minor** – an annoyance that doesn't stop the task (for example, a missing
  label on a non-essential control).

The maintainer assigns or confirms severity; reporters don't need to.

### How we respond

HelixSync is maintained by an individual, so we can't promise fixed
timelines. We will read each accessibility report, reply on the issue, share a
workaround when one exists, treat blockers ahead of other work, and ask you to
confirm the fix when it ships.

## Ownership and maintenance

The project maintainer ([@GhaziAlibi](https://github.com/GhaziAlibi)) owns
accessibility: triaging reports, reviewing user-facing changes against the
expectations above, and keeping this document accurate. It is reviewed when
the interface changes significantly. If ownership changes, the new owner is
named here.

## Supported environments

HelixSync has not been systematically tested with specific browser and
assistive-technology combinations. It targets current Chromium-based browsers
(the extension is on the Chrome Web Store), with Safari described in
[docs/safari.md](docs/safari.md). The dashboard is a web page and runs in
current desktop browsers. We make no claim of tested support for any
particular screen reader.

## Known limitations

No full accessibility audit has been done, so barriers likely exist that we
haven't found. What exists today: some controls have accessible names (for
example the language selector), and error and status messages in the
dashboard sign-in use alert/status roles. The following have **not** been
verified: complete keyboard operation of every screen, screen reader output of
every screen, colour contrast, zoom/reflow, and right-to-left layout of every
screen. Report anything you find.

## Feedback and improvements

To suggest changes to this statement or our practices, open a GitHub issue or
pull request. Active barriers should go through the reporting process above.

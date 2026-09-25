# Security Policy

HelixSync handles browsing data (bookmarks, history, open tabs) and is meant
to be exposed to the internet by the people who run it, so security reports
are taken seriously and handled privately.

## Supported versions

HelixSync is pre-1.0. Security fixes are made against, and released as, the
latest version only; there are no back-ports to older releases. Please
reproduce on the latest release (or `main`) before reporting.

| Version        | Supported |
|----------------|-----------|
| Latest release | Yes       |
| Anything older | No        |

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security
problem.**

Report it privately through GitHub's private vulnerability reporting:

> <https://github.com/GhaziAlibi/helixsync/security/advisories/new>

Please include what you found and where (component and version or commit),
the steps or a proof of concept to reproduce it, and what an attacker gains.
For issues in the encryption design, say which assumption you think fails.
Anything that lets us reproduce it quickly shortens the time to a fix.

### What to expect

This is a volunteer-run project, so these are targets rather than guarantees:

| Step                                         | Target                  |
|----------------------------------------------|-------------------------|
| Acknowledgement of your report               | Within 7 days           |
| First assessment (accepted, need more, or declined, with reasons) | Within 14 days |
| Fix or mitigation for a confirmed issue      | Depends on severity; critical and high first |
| Public disclosure                            | After a fix is released, coordinated with you; by default no later than 90 days after your report |

You will be told when a fix ships and, if you wish, credited in the advisory
and the changelog.

## Scope

In scope:

- the server (`server/`), the web dashboard (`web/`) and the browser
  extension (`extension/`);
- the published container images and the Compose files, including their
  default configuration;
- the release pipeline (`.github/`), where it could lead to a malicious
  artifact being published.

Out of scope:

- weaknesses that exist only in a deployment configured against the
  documentation: serving over plain HTTP, leaving registration open on a
  public instance, running with the placeholder secrets from `.env.example`,
  or exposing the database;
- the limits already documented in
  [`docs/security.md`](docs/security.md) §10 (Known Limitations): for example
  that a user who types their password into a page served by a malicious server
  can have it captured, or that a hostile server can withhold or delete a
  user's data;
- attacks that need an already-compromised device, browser profile or
  extension context;
- denial of service by sheer traffic volume, and automated-scanner output
  without a demonstrated impact;
- vulnerabilities in a dependency with no demonstrated effect on HelixSync.

## Safe harbor

If you make a good-faith effort to follow this policy, we will consider your
research authorized, will not pursue or support legal action against you for
it, and will work with you to understand and resolve the issue. Good faith
means: test only against your own instance (never someone else's server,
account or data), do not access, modify or keep other people's data beyond
what is needed to show the problem, do not degrade a service for others, and
give us reasonable time to fix before disclosing.

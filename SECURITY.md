# Security policy

## Reporting a vulnerability

Email security@getcherto.com. Please don't report a security problem in a public issue.

Say which package and version are affected, what an attacker could do, and how to reproduce it. Never include a real server key (`sk_…`). If one has been exposed, revoke it in the Cherto dashboard under Settings → SDK & keys → Server keys before you report.

We'll confirm we've received your report within two business days, and keep you updated until a fix is released.

## Supported versions

Security fixes are released for the latest version of each package, `@cherto/node`, `@cherto/browser` and `@cherto/react`. While a version is 0.x, a fix ships in a new release, not as a backport, so upgrade to the latest to get it.

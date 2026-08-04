# Security policy

Redutok runs entirely on your machine. The sidecar listens on localhost only,
the meter reads local transcript files, and nothing is transmitted anywhere;
a static test over the built output enforces the absence of network calls
beyond localhost and of any telemetry (packages/meter/test/security.test.ts).
Secrets are redacted before anything reaches disk, with a test proving the
raw bytes of the store, WAL, and audit files never contain them.

## Reporting a vulnerability

Use GitHub private vulnerability reporting at
https://github.com/Truveil-ai/Redutok/security/advisories/new, or email the
maintainer at er.karansharma07@gmail.com with the subject "redutok security".
Please do not open public issues for suspected vulnerabilities. You can
expect an acknowledgement within a week.

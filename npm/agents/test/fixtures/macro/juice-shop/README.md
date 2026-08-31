# Juice Shop macro release fixtures

This directory is the source of truth for the authenticated OWASP Juice Shop
journey used by PTK macro import, replay, and macro-guided scan release tests.

The journey is defined in `journey.json`. Every recording must represent that
same browser journey. `fixture-set.json` records the producer, format, expected
filename, and integrity hash once a recording has been accepted.

## Recordings

Accepted recordings live in `recordings/`:

- `ptk-flow.json` - native PTK Flow export from the PTK recorder.
- `ptk-xml.rec` - XML export from the same PTK recording.
- `zap-zest.zst` - Zest recording produced by the ZAP recorder.
- `chrome-recorder.json` - Chrome DevTools Recorder export.
- `katalon.krecorder` - the native Katalon Recorder 7.1.0 recording retained
  as producer provenance. PTK does not currently import this HTML-table format.
- `katalon.xml` - supported Katalon/Selenese XML generated losslessly from the
  recorded Katalon command model.
- `katalon-selenium.side` - supported Selenium IDE project generated from the
  same recorded Katalon command model.

Katalon Recorder 7.1.0 can import Selenium IDE projects but does not expose a
`.side` export in its current UI. The `.side` fixture is therefore explicitly
Katalon-derived rather than represented as a native Katalon export.

Accepted external recordings retain their producer-native commands and also
carry narrowly scoped release repairs: stable semantic locator alternatives,
explicitly optional onboarding dismissals (including after the profile page's
full return navigation), and a recorded startup-settle step where the producer
does not retain human think time. The immutable native Katalon `.krecorder`
remains the provenance artifact for auditing those acceptance changes.

The Selenium IDE application recording is intentionally deferred. When a
working Firefox Selenium IDE recorder is available, its recording can be added
as a separate fixture without replacing the Katalon-generated `.side` file.

## Credentials and sanitisation

The fixture account is a deliberately public, local-only demo account. Literal
credentials remain in recordings because PTK import and automation must replay
the document exactly as supplied. These files must never contain production
credentials, session cookies, JWTs, browser-profile paths, or unrelated local
storage.

Before a recording is committed it must:

1. replay successfully in its producer when that producer supports replay;
2. import into PTK without required-step loss;
3. finish at the search result defined in `journey.json`;
4. pass the fixture integrity and sensitive-data checks (the only allowed
   literal credential is the public local demo account in `journey.json`); and
5. be copied, with matching hashes, into the standalone `ptk-agent` release
   test fixtures.

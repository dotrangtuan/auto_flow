# Validation — 2026-11-04

Version: 1.3.4

## Passed

`node --test tests/*.test.cjs`: **58 passed, 0 failed**.

Includes new parser/tracker unit checks, worker integration with mocked Chrome APIs,
panel/queue integration, existing download regression tests, and legacy DOM tests.
Scenarios: Unicode/plus request decoding, masked upstream schema, out-of-order
responses, duplicate media, multiple images, unrelated requests, missing postData,
base64 response bodies, transient/permission/quota errors, deadlines, stop while
typing, editor readback mismatch, debugger detach, navigation/reload, preserved
downloads on fatal state, group barriers and download filename checks.

All root JavaScript files pass `node --check`. Manifest target files exist.
ZIP integrity is checked during packaging.

## Not verified

Real Chromium extension smoke test: **not run successfully**. The environment
has no Chromium executable, and the attempted browser download returned an
invalid archive. `tests/extension.browser.cjs` is supplied for a machine with
Playwright and Chromium. No browser success is claimed.

No live Google Flow login, generation, billing, CAPTCHA, actual image download
or Windows/macOS UI compatibility has been tested. Parser compatibility is
based on AutoFlowCut commit 211a779 and masked/synthetic fixtures.

Start with 2–3 prompts, group size 1, ordinary Image mode, 1 image per prompt.

## v1.3.1 startup regression coverage

Added six integration tests for debugger conflict, browser policy rejection,
optional platform API failure, buffer-parameter fallback, Network.enable failure,
and a non-composer project URL. All 54 Node tests pass. Browser/live Flow
limitations above remain unchanged.

## v1.3.2 collection regression coverage

Reproduced the screenshot route pattern `/project/P/collection/C`: three
new regression tests failed on v1.3.1. After the fix, they pass, and a fourth
panel regression check confirms the same URL rules are used in both contexts.
Tests cover collection startup, request-to-image correlation inside a collection,
collection changes stopping input, query-only changes staying valid, and
invalid subpages or lookalike hosts remaining rejected. All 58 Node tests pass.
No live Flow browser test has been performed; previous browser limitations remain.

## v1.3.3 interrupted response coverage

61 Node tests passed. New cases cover loadingFailed after a complete result
split across streamed chunks, an incomplete response, a transient RPC error in
an interrupted stream, safe error details, and a sibling finishing after another
transfer fails. The screenshot does not expose the underlying Chrome error or
the bytes received. No live Google Flow session has been tested.

v1.3.4: 65 Node tests pass, including resume numbering, modern button submission, blocked submission and the longer confirmation window. Tested with fixtures, without a live Flow account.

# Third-party notices

The request/response schema parsers in flow-protocol.js are adapted from
AutoFlowCut, Copyright (C) 2026 Touchizen, licensed AGPL-3.0-only.

Upstream: https://github.com/touchizen/AutoFlowCut
Commit: 211a77933f299fc2f2520f8cb7ceeb161e72a315
File: electron/flow-rpc-protocol.js

Modifications on 2026-11-04: standalone worker, image-only parser, strict
request-to-prompt matching, media URL validation, explicit single-image guard.
The worker/CDP integration is an adaptation for the user-supplied h2dev_flow
extension. It is an independent modified distribution, not an official
AutoFlowCut or Google product.

This archive includes complete editable source, test source, and the full AGPL
license. The modified combined distribution is provided under AGPL-3.0-only,
without warranty. Original h2dev_flow files came from the user-supplied archive;
that archive contained no separate license file.

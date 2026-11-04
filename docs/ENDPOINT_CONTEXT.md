# Endpoint, canvas and heartbeat context

Node checks belong to the selected RPC URL and selection generation. Concurrent
checks share only that owner, including synchronous reentry and adoption of the
original bare-host RPC candidate. Selecting another node, selecting the same URL
again or rejecting invalid input invalidates older work. Chain, canvas and router
metadata clear during recheck. Old success, failure and cleanup cannot overwrite
a newer selection. Original RPC requests, optional API lookup, timeout values,
normalization, storage keys and failure descriptions remain.

Canvas checks capture the selected RPC, chain, address and both generations.
One owner covers the complete four original ABI reads and optional router check.
Old canvas or router responses cannot publish into a newer context. Router
deployment lookup uses the captured chain, and a router must still report that
it fronts this canvas. Direct canvas use remains available without a router.
Contract selection keeps link, per-chain saved, build and deployment precedence;
an explicit selection releases the visit link and preserves the original saved
choice and deployment-block rules. Invalid canvas input preserves the selected
address but clears its pending metadata and keeps the validation error.

Heartbeat reads capture RPC, chain identity, endpoint health and generation.
Current reads coalesce through both height and block, including synchronous
client construction. Context changes clear old identity and cadence immediately;
old completions cannot publish metadata, errors or later listener notifications.
Genesis zero and legitimate lower canonical heads remain observable. The original
per-block exponential timestamp estimate remains. Preferences retain their
15-second minimum, explicit refresh period and paused value. The gallery retains
its 10-second override; clearing it restores the preference. Hidden pages start
no reads or timers and visible restoration reads immediately. Only the latest
refresh owns rearming, so an obsolete completion cannot cancel the current timer.

`npm run test:context` executes the shipped TypeScript modules through Node's
strip-only API with explicit memory-only Vue, fetch, client, clock, visibility,
storage and ABI ports. The loader lowers only HttpError's parameter-property
constructor with an exact inverse; asynchronous source expressions remain.
These controls start no SDK, browser, wallet or network. Isolated canvas/router
contracts, ABI drift, type checking and production build remain separate CI gates.
Complete entry routes, real providers, wallets, chain finality and release remain
outside this bounded qualification.

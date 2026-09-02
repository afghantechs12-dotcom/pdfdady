# ADR-M7-010: Multi-Tab Autosave Ownership and Session Lifecycle

**Status:** Accepted for planning.

## Decision

Each WorkspaceSessionTab owns an independent editor, history, source/background resources, viewport/tool/selection, base revision, and draft state. WorkspaceSession and WorkspaceNavigationEntry payloads are schema-versioned, bounded, validated, and contain no PDF bytes, image data URLs, page backgrounds, or unbounded resources.

Same-browser autosave ownership uses `navigator.locks` where available. Fallback is an expiring lease keyed by user/Workspace/Document/device with owner ID, heartbeat, expiry, and fencing generation. Takeover requires observed expiry and a newer generation. Use monotonic elapsed time where possible; clock skew never supersedes server revision checks. Crashed tabs recover after lock release or lease expiry. BroadcastChannel carries notifications only.

Server compare-and-swap, checksums, and scoped idempotency are final authority. Suspension persists bounded restoration state and releases object URLs/PDF.js/background buffers. Restore reauthorizes every tab. Version restore invalidates/reconciles open tabs, drafts, sessions, and derived artifacts.

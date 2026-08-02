package com.ade.sync.client

/**
 * Operational diagnostics sink for the sync client.
 *
 * `:sync` is a pure-JVM module and cannot call `android.util.Log`, so the app
 * module installs a sink at startup. Lines are local operational logs only:
 * they carry protocol action/envelope names, opaque per-request ids, elapsed
 * milliseconds, and bounded error codes. They must never carry prompts,
 * transcripts, terminal bytes, file or project paths, tokens, or any frame
 * payload. See `docs/logging.md`.
 */
object SyncLog {
    @Volatile
    var sink: ((String) -> Unit)? = null

    fun log(line: String) {
        sink?.invoke(line)
    }
}

package com.ade.sync.client

import com.ade.sync.model.MobileProject
import com.ade.sync.model.RosterDelta
import com.ade.sync.model.RosterProject
import com.ade.sync.model.RosterSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.test.assertNull
import kotlin.test.assertFailsWith
import com.ade.sync.model.HelloOkPayload
import com.ade.sync.model.SyncPeerMetadata

class AdeSyncClientTest {
    @Test
    fun `slow-by-nature actions get a longer budget than the flat default`() {
        // A client-side timeout on a process-spawning action abandons a request
        // the host goes on to complete, leaving an error next to a session that
        // actually exists. These must outlive the default budget.
        assertEquals(SyncCommandTimeouts.SESSION_START_MILLIS, SyncCommandTimeouts.forAction("chat.create"))
        assertEquals(SyncCommandTimeouts.SESSION_START_MILLIS, SyncCommandTimeouts.forAction("work.startCliSession"))
        assertEquals(SyncCommandTimeouts.SESSION_START_MILLIS, SyncCommandTimeouts.forAction("chat.send"))
        assertEquals(SyncCommandTimeouts.LANE_CREATE_MILLIS, SyncCommandTimeouts.forAction("lanes.create"))
        assertEquals(SyncCommandTimeouts.LANE_DELETE_MILLIS, SyncCommandTimeouts.forAction("lanes.delete"))
        assertEquals(SyncCommandTimeouts.REMOTE_FANOUT_MILLIS, SyncCommandTimeouts.forAction("prs.refresh"))

        for (action in listOf(
            "chat.create",
            "work.startCliSession",
            "chat.send",
            "lanes.create",
            "lanes.delete",
            "prs.refresh",
        )) {
            assertTrue(
                SyncCommandTimeouts.forAction(action) > SyncCommandTimeouts.DEFAULT_MILLIS,
                "$action should outlive the default budget",
            )
        }
    }

    @Test
    fun `ordinary actions keep the default budget`() {
        assertEquals(SyncCommandTimeouts.DEFAULT_MILLIS, SyncCommandTimeouts.forAction("lanes.list"))
        assertEquals(SyncCommandTimeouts.DEFAULT_MILLIS, SyncCommandTimeouts.forAction("chat.approve"))
        assertEquals(SyncCommandTimeouts.DEFAULT_MILLIS, SyncCommandTimeouts.forAction("lanes.refreshSnapshots"))
        assertEquals(SyncCommandTimeouts.DEFAULT_MILLIS, SyncCommandTimeouts.forAction("some.unknown.action"))
    }

    @Test
    fun `relay ready URL converts websocket scheme for OkHttp`() {
        assertEquals(
            "https://relay.example/connect/machine?existing=1&ready=2",
            relayReadyUrl("wss://relay.example/connect/machine?existing=1"),
        )
    }
    @Test
    fun `background refreshes are ignored while the socket is disconnected`() {
        val client = AdeSyncClient()

        assertFalse(client.requestProjectCatalog())
        assertFalse(client.requestRosterSnapshot())

        client.close()
    }

    @Test
    fun `saved pairing rejects a hello from a different host identity`() {
        val hello = HelloOkPayload(brain = SyncPeerMetadata(
            deviceId = "unexpected-host",
            deviceName = "Other Mac",
            siteId = "site-1",
        ))

        assertFailsWith<IllegalArgumentException> {
            requireExpectedHostIdentity(hello, "expected-host")
        }
    }

    private val activeProject = MobileProject(
        id = "project-1",
        displayName = "Project one",
        rootPath = "/projects/one",
        isOpen = true,
    )

    @Test
    fun `project commands inherit the authenticated host project`() {
        val context = resolveCommandProjectContext("project", null, null, activeProject)

        assertEquals("project-1", context.projectId)
        assertEquals("/projects/one", context.projectRootPath)
    }

    @Test
    fun `explicit cross project command scope wins over the host project`() {
        val context = resolveCommandProjectContext(
            "project",
            "project-2",
            "/projects/two",
            activeProject,
        )

        assertEquals("project-2", context.projectId)
        assertEquals("/projects/two", context.projectRootPath)
    }

    @Test
    fun `machine commands do not acquire a project implicitly`() {
        val context = resolveCommandProjectContext("machine", null, null, activeProject)

        assertNull(context.projectId)
        assertNull(context.projectRootPath)
    }

    @Test
    fun `roster deltas never merge across a sequence gap`() {
        val baseline = RosterSnapshot(4, listOf(RosterProject(
            projectId = "project-1",
            displayName = "Project one",
        )))

        assertEquals(
            RosterDeltaOutcome.NeedsSnapshot,
            mergeRosterDelta(baseline, RosterDelta(seq = 6)),
        )
        assertEquals(
            RosterDeltaOutcome.Dropped,
            mergeRosterDelta(baseline, RosterDelta(seq = 4)),
        )
        val applied = mergeRosterDelta(
            baseline,
            RosterDelta(seq = 5, removed = listOf("project-1")),
        ) as RosterDeltaOutcome.Applied
        assertEquals(5, applied.snapshot.seq)
        assertEquals(emptyList(), applied.snapshot.projects)
    }
}

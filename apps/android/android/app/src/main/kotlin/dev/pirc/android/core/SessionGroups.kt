package dev.pirc.android.core

/** Sessions of one workspace, in the order the list shows them. */
data class WorkspaceGroup(
    val workspaceId: String,
    val title: String,
    val node: String,
    val online: Boolean,
    val open: List<Session>,
    val settled: List<Session>,
) {
    val lastActivity get() = (open + settled).maxOfOrNull { it.updatedAt } ?: 0
    val isEmpty get() = open.isEmpty() && settled.isEmpty()
}

/**
 * Group sessions by workspace, like the web sidebar: pinned first, then most
 * recently active; settled sessions separately. Workspaces with the latest
 * activity come first; those without sessions follow by name, so a new or
 * emptied workspace is still listed. Unknown workspaces fall back to their ID.
 */
fun groupSessions(
    sessions: List<Session>,
    workspaces: List<Workspace>,
    nodes: List<NodeSummary>,
): List<WorkspaceGroup> {
    val byId = workspaces.associateBy { it.id }
    val online = nodes.flatMap { node -> node.workspaces.map { "${node.id}:${it.id}" } }.toSet()
    val byWorkspace = sessions.groupBy { it.workspaceId }
    val empty = workspaces.filter { it.id !in byWorkspace }.map { workspace ->
        WorkspaceGroup(workspace.id, workspace.displayName, workspace.hostId, workspace.id in online, emptyList(), emptyList())
    }.sortedBy { it.title.lowercase() }
    return byWorkspace.map { (workspaceId, items) ->
        val workspace = byId[workspaceId]
        val (settled, open) = items.partition { it.settled }
        WorkspaceGroup(
            workspaceId = workspaceId,
            title = workspace?.displayName ?: workspaceId.substringAfter(':'),
            node = workspace?.hostId ?: workspaceId.substringBefore(':'),
            online = workspaceId in online,
            open = open.sortedWith(compareByDescending<Session> { it.pinned }.thenByDescending { it.updatedAt }),
            settled = settled.sortedByDescending { it.updatedAt },
        )
    }.sortedByDescending { it.lastActivity } + empty
}

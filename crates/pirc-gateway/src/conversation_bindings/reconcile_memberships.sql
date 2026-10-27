INSERT INTO conversation_project_memberships(session_id,source_workspace_id,project_workspace_id,resolution)
 SELECT session_id,source_workspace_id,project_workspace_id,resolution FROM conversation_membership_targets WHERE true
 ON CONFLICT(session_id) DO UPDATE SET
   revision=conversation_project_memberships.revision+(
     conversation_project_memberships.resolution!='unresolved' AND
     (conversation_project_memberships.resolution IS NOT excluded.resolution
       OR conversation_project_memberships.project_workspace_id IS NOT excluded.project_workspace_id)),
   source_workspace_id=excluded.source_workspace_id,
   project_workspace_id=excluded.project_workspace_id,resolution=excluded.resolution;

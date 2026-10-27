use super::*;

#[test]
fn duplicate_choices_are_rejected() {
    let body: DeleteBody = serde_json::from_value(json!({"decisions":[
        {"entryId":"entry","revision":1,"action":"keep"},
        {"entryId":"entry","revision":1,"action":"forget"}
    ]}))
    .unwrap();
    assert!(decisions(body.decisions).is_err());
    let body: DeleteBody = serde_json::from_value(json!({"proposalDecisions":[
        {"proposalId":"p","status":"pending","action":"keep"},
        {"proposalId":"p","status":"pending","action":"forget"}
    ]}))
    .unwrap();
    assert!(proposal_decisions(body.proposal_decisions).is_err());
}

#[test]
fn finishing_only_destroys_current_members_and_preserves_moved_bindings() {
    let (app, _dir) = crate::memory::tests::app();
    let conn = app.db.lock();
    let mode = pirc_protocol::ModeId::new("chat").unwrap();
    conn.sync_remote_workspaces(
        "n1",
        &[
            ("a".into(), "A".into(), mode.clone()),
            ("b".into(), "B".into(), mode),
        ],
    )
    .unwrap();
    let user = "me@example.com";
    let member = conn
        .create_session("n1:a", "node://n1/member", "n1", "member", user)
        .unwrap();
    let moved = conn
        .create_session("n1:a", "node://n1/moved", "n1", "moved", user)
        .unwrap();
    conn.execute(
        "UPDATE sessions SET workspace_id='n1:b' WHERE id=?",
        [&moved.id],
    )
    .unwrap();
    atomic(&conn, |tx| {
        tx.begin_workspace_deletion("n1:a", user)?;
        crate::memory::delete_project(&app, tx, user, "n1:a", &[], &[])
    })
    .unwrap();
    let deleted = atomic(&conn, |tx| finish(&app, tx, user, "n1:a")).unwrap();
    assert_eq!(
        deleted.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        vec![member.id.as_str()]
    );
    assert!(conn.get_session(&member.id).is_err());
    let current = conn.get_session(&moved.id).unwrap();
    assert_eq!(current.workspace_id, "n1:b");
    assert_eq!(current.binding.execution.workspace_id, "n1:b");
    assert!(conn.find_workspace("n1:a").unwrap().is_none());
    assert!(conn.find_workspace("n1:b").unwrap().is_some());
    assert!(crate::memory::project_cleanup_complete(&conn, user, "n1:a").unwrap());
    assert!(
        atomic(&conn, |tx| finish(&app, tx, user, "n1:a"))
            .unwrap()
            .is_empty()
    );
}

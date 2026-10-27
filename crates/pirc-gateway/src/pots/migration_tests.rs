use crate::db::{Db, SCHEMA_VERSION, Store};

#[test]
fn migration_1009_adds_empty_disabled_pots_without_changing_existing_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gateway.sqlite");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(concat!(
            include_str!("../schema.sql"),
            include_str!("../calendar/schema.sql"),
            "PRAGMA user_version=1009;"
        ))
        .unwrap();
        conn.sync_remote_workspaces(
            "work",
            &[(
                "repo".into(),
                "Repo".into(),
                pirc_protocol::ModeId::new("directory").unwrap(),
            )],
        )
        .unwrap();
        conn.execute("INSERT INTO sessions(id,workspace_id,private_session_path,name,node_id,pi_session_id,owner_user,created_at,updated_at) VALUES('old','work:repo','node://work/s','Old','work','s','alice',1,1)", []).unwrap();
        conn.execute("INSERT INTO workspace_removals (workspace_id,owner_user,removed_at) VALUES ('work:repo','alice',1)", []).unwrap();
    }
    for _ in 0..2 {
        let db = Db::open(&path).unwrap();
        let conn = db.lock();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert!(conn.find_workspace("work:repo").unwrap().is_some());
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM sessions WHERE owner_user='alice'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT owner_user FROM workspace_removals", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "alice"
        );
        assert!(
            super::list_responsibilities(&conn, "alice", 100)
                .unwrap()
                .is_empty()
        );
        assert!(
            super::list_suggestions(&conn, "alice", 100)
                .unwrap()
                .is_empty()
        );
        assert!(super::list_tasks(&conn, "alice", 100).unwrap().is_empty());
    }
}

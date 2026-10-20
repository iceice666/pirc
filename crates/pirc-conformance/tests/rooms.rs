//! Rooms (plans/rewrite/01-rooms.md): creating them, messages and unread
//! counts for two users, typing that is never kept, the room event stream
//! and its cursor, moves, archiving, pins and uploads. No brain answers
//! yet: the rooms hold only what the users send.

use pirc_conformance::{
    Cluster, GatewayOptions, HOST, ORIGIN, Transcript, USER, WebSocket, browser_headers,
};
use serde_json::{Value, json};

const OTHER: &str = "other@example.com";

fn as_other() -> Vec<(&'static str, String)> {
    vec![
        ("host", HOST.to_owned()),
        ("origin", ORIGIN.to_owned()),
        ("x-pirc-user", OTHER.to_owned()),
    ]
}

/// Frames up to and including the `count`-th of `kind`.
async fn frames_until(socket: &mut WebSocket, kind: &str, count: usize) -> Value {
    let mut seen = 0;
    json!(
        socket
            .until(|frame| {
                seen += usize::from(frame["type"] == kind);
                seen == count
            })
            .await
    )
}

/// The `unread` and `readSeq` of a room in a user's list.
fn unread(list: &Value, room: &str) -> Value {
    let room = list["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == room)
        .expect("listed room");
    json!({ "unread": room["unread"], "readSeq": room["readSeq"] })
}

#[tokio::test(flavor = "multi_thread")]
async fn rooms() {
    let Some(cluster) = Cluster::start_with(GatewayOptions {
        without_node: true,
        env: vec![("PIRC_ALLOWED_USERS", format!("{USER},{OTHER}"))],
        ..Default::default()
    })
    .await
    else {
        return;
    };
    let api = cluster.api();
    let me = browser_headers();
    let other = as_other();
    let mut t = Transcript::new(cluster.volatile());

    let state = cluster.dir.path().join("gateway-state");
    t.note(
        "the gateway's database files",
        json!({
            "pirc.sqlite": state.join("pirc.sqlite").exists(),
            "gateway.sqlite": state.join("gateway.sqlite").exists(),
        }),
    );

    let listed = api.send("GET", "/api/rooms", &me, None).await;
    t.response("a new gateway has #general", "GET /api/rooms", &listed);

    let mut mine = api.connect("/api/events?rooms=1", &me).await.open();
    let ready = mine.next_json().await.expect("ready");
    t.note(
        "a room socket starts with where the stream stands",
        ready.clone(),
    );
    let start = format!(
        "{}:{}",
        ready["watermark"]["epoch"], ready["watermark"]["sequence"]
    );
    let mut theirs = api.connect("/api/events?rooms=1", &other).await.open();
    theirs.next_json().await.expect("ready");

    let created = api
        .send(
            "POST",
            "/api/rooms",
            &me,
            Some(json!({ "name": " #SlimeOS討論區 " })),
        )
        .await;
    t.response("create a room", "POST /api/rooms", &created);
    let topic = created.body["room"]["id"].as_str().unwrap().to_owned();
    for (step, body) in [
        ("a name that is empty", json!({ "name": "#" })),
        ("a name that is too long", json!({ "name": "x".repeat(81) })),
        ("no name", json!({})),
    ] {
        let refused = api.send("POST", "/api/rooms", &me, Some(body)).await;
        t.response(step, "POST /api/rooms", &refused);
    }
    t.note(
        "the other user sees the room appear",
        frames_until(&mut theirs, "room_changed", 1).await,
    );

    // Three short messages in a row: each stored and shown at once.
    for text in ["SlimeOS", "PR#123", "怎樣了？"] {
        let sent = api
            .send(
                "POST",
                "/api/rooms/general/messages",
                &me,
                Some(json!({ "text": text })),
            )
            .await;
        t.response(
            &format!("send {text:?}"),
            "POST /api/rooms/general/messages",
            &sent,
        );
    }
    t.note(
        "the other user's socket: three messages, no reads of mine",
        frames_until(&mut theirs, "room_message", 3).await,
    );
    t.note(
        "my socket: the room's changes and my own reads too",
        frames_until(&mut mine, "room_read", 3).await,
    );
    for (step, body) in [
        ("an empty message", json!({ "text": "  " })),
        (
            "an unknown attachment",
            json!({ "text": "x", "attachments": ["upload_x"] }),
        ),
    ] {
        let refused = api
            .send("POST", "/api/rooms/general/messages", &me, Some(body))
            .await;
        t.response(step, "POST /api/rooms/general/messages", &refused);
    }
    let missing = api
        .send(
            "POST",
            "/api/rooms/nope/messages",
            &me,
            Some(json!({ "text": "x" })),
        )
        .await;
    t.response(
        "a room that is not there",
        "POST /api/rooms/nope/messages",
        &missing,
    );

    let mine_listed = api.send("GET", "/api/rooms", &me, None).await.body;
    let theirs_listed = api.send("GET", "/api/rooms", &other, None).await.body;
    t.note(
        "unread: my own messages are read, the other user has three",
        json!({
            "mine": unread(&mine_listed, "general"),
            "theirs": unread(&theirs_listed, "general"),
            "order": theirs_listed["rooms"].as_array().unwrap().iter().map(|room| room["name"].clone()).collect::<Vec<_>>(),
        }),
    );
    let read = api
        .send(
            "POST",
            "/api/rooms/general/read",
            &other,
            Some(json!({ "seq": 2 })),
        )
        .await;
    t.response(
        "the other user reads two",
        "POST /api/rooms/general/read",
        &read,
    );
    t.note(
        "their socket learns it",
        frames_until(&mut theirs, "room_read", 1).await,
    );
    let back = api
        .send(
            "POST",
            "/api/rooms/general/read",
            &other,
            Some(json!({ "seq": 1 })),
        )
        .await;
    t.response(
        "reading never goes back",
        "POST /api/rooms/general/read",
        &back,
    );

    let typed = api
        .send("POST", "/api/rooms/general/typing", &me, None)
        .await;
    t.response("I am typing", "POST /api/rooms/general/typing", &typed);
    t.note(
        "the other user sees it, outside the sequence",
        frames_until(&mut theirs, "room_typing", 1).await,
    );

    let page = api
        .send(
            "GET",
            "/api/rooms/general/messages?before=3&limit=1",
            &other,
            None,
        )
        .await;
    t.response(
        "a page of older messages",
        "GET /api/rooms/general/messages?before=3&limit=1",
        &page,
    );
    let message = page.body["messages"][0]["id"].as_str().unwrap().to_owned();
    let pinned = api
        .send(
            "POST",
            &format!("/api/rooms/general/messages/{message}/pin"),
            &me,
            None,
        )
        .await;
    t.response(
        "pin a message",
        "POST /api/rooms/general/messages/<message>/pin",
        &pinned,
    );

    let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    let uploaded = api
        .send_bytes(
            "POST",
            &format!("/api/rooms/{topic}/uploads"),
            &me,
            Some("image/png"),
            png.clone(),
        )
        .await;
    t.response(
        "upload an image",
        "POST /api/rooms/<topic>/uploads",
        &uploaded,
    );
    let upload = uploaded.body["upload"]["id"].as_str().unwrap().to_owned();
    let unnamed = api
        .send_bytes(
            "POST",
            &format!("/api/rooms/{topic}/uploads"),
            &me,
            Some("text/plain"),
            b"notes".to_vec(),
        )
        .await;
    t.response(
        "a file needs a name",
        "POST /api/rooms/<topic>/uploads",
        &unnamed,
    );
    let with_file = api
        .send(
            "POST",
            &format!("/api/rooms/{topic}/messages"),
            &me,
            Some(json!({ "text": "", "attachments": [upload], "immediate": true })),
        )
        .await;
    t.response(
        "send it, now",
        "POST /api/rooms/<topic>/messages",
        &with_file,
    );
    let again = api
        .send(
            "POST",
            &format!("/api/rooms/{topic}/messages"),
            &me,
            Some(json!({ "text": "again", "attachments": [upload] })),
        )
        .await;
    t.response(
        "an upload goes with one message",
        "POST /api/rooms/<topic>/messages",
        &again,
    );
    let downloaded = api
        .send(
            "GET",
            &format!("/api/rooms/{topic}/uploads/{upload}"),
            &other,
            None,
        )
        .await;
    t.note(
        "the other user downloads it",
        json!({ "status": downloaded.status, "headers": downloaded.headers }),
    );

    let moved = api
        .send(
            "POST",
            "/api/rooms/general/move",
            &me,
            Some(json!({ "toRoomId": topic })),
        )
        .await;
    t.response(
        "move on to the topic room",
        "POST /api/rooms/general/move",
        &moved,
    );
    let into_itself = api
        .send(
            "POST",
            "/api/rooms/general/move",
            &me,
            Some(json!({ "toRoomId": "general" })),
        )
        .await;
    t.response(
        "a room cannot move into itself",
        "POST /api/rooms/general/move",
        &into_itself,
    );

    let general = api
        .send(
            "PATCH",
            "/api/rooms/general",
            &me,
            Some(json!({ "archived": true })),
        )
        .await;
    t.response(
        "#general cannot be archived",
        "PATCH /api/rooms/general",
        &general,
    );
    let archived = api
        .send(
            "PATCH",
            &format!("/api/rooms/{topic}"),
            &me,
            Some(json!({ "archived": true })),
        )
        .await;
    t.response(
        "archive the topic room",
        "PATCH /api/rooms/<topic>",
        &archived,
    );
    let listed = api.send("GET", "/api/rooms", &me, None).await;
    t.response("archived rooms leave the list", "GET /api/rooms", &listed);
    let all = api.send("GET", "/api/rooms?archived=1", &me, None).await;
    t.note(
        "and are listed when asked for",
        json!(all.body["rooms"].as_array().unwrap().len()),
    );
    let by_url = api
        .send("GET", &format!("/api/rooms/{topic}"), &other, None)
        .await;
    t.response("its URL still reads", "GET /api/rooms/<topic>", &by_url);
    let messages = api
        .send("GET", &format!("/api/rooms/{topic}/messages"), &other, None)
        .await;
    t.response(
        "and its messages",
        "GET /api/rooms/<topic>/messages",
        &messages,
    );
    let refused = api
        .send(
            "POST",
            &format!("/api/rooms/{topic}/messages"),
            &me,
            Some(json!({ "text": "x" })),
        )
        .await;
    t.response(
        "it takes no new messages",
        "POST /api/rooms/<topic>/messages",
        &refused,
    );

    // A socket from the first cursor gets everything since, typing aside,
    // and only its own user's reads.
    let mut replayed = api
        .connect(&format!("/api/events?rooms=1&cursor={start}"), &other)
        .await
        .open();
    t.note(
        "replay from the first cursor",
        json!(replayed.until(|frame| frame["type"] == "ready").await),
    );
    let mut stale = api
        .connect("/api/events?rooms=1&cursor=1:1", &me)
        .await
        .open();
    t.note(
        "a cursor from another gateway start",
        json!(stale.until(|frame| frame["type"] == "ready").await),
    );
    for (step, query) in [
        ("rooms and a session at once", "rooms=1&sessionId=s"),
        ("neither", ""),
        ("a malformed cursor", "rooms=1&cursor=abc"),
    ] {
        let mut socket = api
            .connect(&format!("/api/events?{query}"), &me)
            .await
            .open();
        let (code, reason) = socket.closed().await;
        t.note(step, json!({ "closed": code, "reason": reason }));
    }

    insta::assert_json_snapshot!("rooms", t.into_value());
}

//! Moodle through its web service API, the way the official Moodle app
//! reaches it: a token for the `moodle_mobile_app` service, from the user
//! name and password (`login/token.php`), or, for schools that sign in
//! elsewhere, from the app's launch page (`admin/tool/mobile/launch.php`)
//! whose `moodlemobile://token=…` address the person pastes back. Only the
//! token is kept, never the password.
//!
//! Read-only by construction: [`call`] refuses any function not in
//! [`READ_ONLY`], and nothing else talks to the site.

use chrono_tz::Tz;
use md5::{Digest, Md5};
use serde_json::{Value, json};
use url::Url;

use super::net::{self, check_url};
use super::store::{NewItem, Source};
use super::{Polled, SourceError, clip, stamp};

/// The web service functions a Moodle source may call; everything they
/// return only reads.
pub const READ_ONLY: &[&str] = &[
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "core_calendar_get_action_events_by_timesort",
    "mod_assign_get_assignments",
    "core_course_get_contents",
    "mod_forum_get_forum_discussions",
    "message_popup_get_popup_notifications",
];
const SERVICE: &str = "moodle_mobile_app";
const ANSWER_MAX: usize = 8 * 1024 * 1024;
/// The deadlines a poll watches, ahead.
const AHEAD_DAYS: i64 = 60;
const NOTIFICATIONS: usize = 20;
const CURSOR_EVENTS: usize = 500;
const TEXT_CHARS: usize = 6000;
const LISTED: usize = 100;

/// The site's base URL as people type it: no trailing slash, no
/// `/login/index.php` and the like.
pub fn base_url(text: &str) -> Result<Url, String> {
    let mut url = check_url(text)?;
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_owned();
    for page in ["/login/index.php", "/my", "/index.php"] {
        if let Some(rest) = path.strip_suffix(page) {
            path = rest.to_owned();
        }
    }
    url.set_path(&path);
    Ok(url)
}

fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}{path}", base.path().trim_end_matches('/')));
    url
}

/// A token from the user name and password.
pub async fn login(base: &Url, username: &str, password: &str) -> Result<String, SourceError> {
    let response = net::client()
        .post(endpoint(base, "/login/token.php"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&[
            ("username", username),
            ("password", password),
            ("service", SERVICE),
        ]))
        .send()
        .await
        .map_err(|error| net::failed(&error))?;
    if !response.status().is_success() {
        return Err(net::status_error(response.status()));
    }
    let answer: Value =
        serde_json::from_slice(&net::body(response, ANSWER_MAX).await?).map_err(|_| {
            SourceError::new("the site's answer is not Moodle's (is this the Moodle address?)")
        })?;
    if let Some(token) = answer.get("token").and_then(Value::as_str) {
        return Ok(token.to_owned());
    }
    let code = answer
        .get("errorcode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let said = answer
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the login failed");
    let mut error = SourceError::new(match code {
        "invalidlogin" => "Moodle refused the user name or password. If your school signs in through another page (SSO), use the app login instead.".to_owned(),
        "enablewsdescription" | "servicenotavailable" | "noaccess" => {
            format!("This Moodle does not let apps sign in ({code}): {said}")
        }
        _ => format!("Moodle refused the login: {said}"),
    });
    error.auth = true;
    error.code = Some(if code == "invalidlogin" {
        "invalid_login"
    } else {
        "login_refused"
    });
    Err(error)
}

/// The launch page that ends at a `moodlemobile://token=…` address.
pub fn launch_url(base: &Url, passport: &str) -> Url {
    let mut url = endpoint(base, "/admin/tool/mobile/launch.php");
    url.query_pairs_mut()
        .append_pair("service", SERVICE)
        .append_pair("passport", passport)
        .append_pair("urlscheme", "moodlemobile");
    url
}

/// The signature and token of a pasted `moodlemobile://token=<base64>`
/// address (`signature:::token[:::privatetoken]`).
pub fn launched(pasted: &str) -> Result<(String, String), String> {
    use base64::Engine;
    let pasted = pasted.trim();
    let encoded = pasted
        .split_once("token=")
        .map(|(_, rest)| rest)
        .ok_or("Paste the whole moodlemobile://token=… address")?;
    let encoded: String = form_urlencoded::parse(format!("x={encoded}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let encoded = encoded.trim_end_matches(['/', '#']).trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(encoded))
        .map_err(|_| "That address does not hold a Moodle token".to_owned())?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| "That address does not hold a Moodle token".to_owned())?;
    let mut parts = decoded.split(":::");
    match (parts.next(), parts.next()) {
        (Some(signature), Some(token)) if !signature.is_empty() && !token.is_empty() => {
            Ok((signature.to_owned(), token.to_owned()))
        }
        _ => Err("That address does not hold a Moodle token".to_owned()),
    }
}

/// Whether a launch's signature is the site's for this passport:
/// `md5(wwwroot + passport)`.
pub fn signed(signature: &str, site_url: &str, passport: &str) -> bool {
    let digest = Md5::digest(format!("{}{passport}", site_url.trim_end_matches('/')).as_bytes());
    crate::util::hex(&digest).eq_ignore_ascii_case(signature)
}

/// Call a read-only web service function.
pub async fn call(
    base: &Url,
    token: &str,
    function: &str,
    params: &[(String, String)],
) -> Result<Value, SourceError> {
    if !READ_ONLY.contains(&function) {
        return Err(SourceError::new(format!(
            "{function} is not a read-only function"
        )));
    }
    let mut pairs: Vec<(String, String)> = vec![
        ("wstoken".to_owned(), token.to_owned()),
        ("wsfunction".to_owned(), function.to_owned()),
        ("moodlewsrestformat".to_owned(), "json".to_owned()),
    ];
    pairs.extend(params.iter().cloned());
    let response = net::client()
        .post(endpoint(base, "/webservice/rest/server.php"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(&pairs))
        .send()
        .await
        .map_err(|error| net::failed(&error))?;
    if !response.status().is_success() {
        return Err(net::status_error(response.status()));
    }
    let answer: Value = serde_json::from_slice(&net::body(response, ANSWER_MAX).await?)
        .map_err(|_| SourceError::new("the site's answer is not Moodle's"))?;
    if let Some(exception) = answer.get("exception").and_then(Value::as_str) {
        let code = answer
            .get("errorcode")
            .and_then(Value::as_str)
            .unwrap_or(exception);
        let message = answer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(code);
        let mut error = SourceError::new(format!("Moodle: {message}"));
        if matches!(
            code,
            "invalidtoken" | "accessexception" | "servicerequireslogin"
        ) {
            error.auth = true;
        }
        return Err(error);
    }
    Ok(answer)
}

/// A form body (`application/x-www-form-urlencoded`).
fn form<K: AsRef<str>, V: AsRef<str>>(pairs: &[(K, V)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key.as_ref(), value.as_ref());
    }
    serializer.finish()
}

fn param(key: &str, value: impl ToString) -> (String, String) {
    (key.to_owned(), value.to_string())
}

/// Who the token is and which site: `core_webservice_get_site_info`.
pub async fn site_info(base: &Url, token: &str) -> Result<Value, SourceError> {
    call(base, token, "core_webservice_get_site_info", &[]).await
}

/// The configuration kept for a site (no token): its address, name and
/// whose token it is.
pub fn config_of(base: &Url, info: &Value) -> Value {
    json!({
        "url": base.as_str().trim_end_matches('/'),
        "siteName": info.get("sitename").and_then(Value::as_str).unwrap_or_default(),
        "fullName": info.get("fullname").and_then(Value::as_str).unwrap_or_default(),
        "username": info.get("username").and_then(Value::as_str).unwrap_or_default(),
        "userId": info.get("userid").and_then(Value::as_i64).unwrap_or_default(),
    })
}

struct Site {
    base: Url,
    token: String,
    user_id: i64,
}

fn site(source: &Source, secret: &Value) -> Result<Site, SourceError> {
    let base = base_url(source.config_str("url").unwrap_or_default()).map_err(SourceError::new)?;
    let token = secret
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| SourceError {
            auth: true,
            ..SourceError::new("no token: sign in again")
        })?
        .to_owned();
    Ok(Site {
        base,
        token,
        user_id: source
            .config
            .get("userId")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
    })
}

async fn deadlines(site: &Site, from_s: i64, to_s: i64) -> Result<Vec<Value>, SourceError> {
    let answer = call(
        &site.base,
        &site.token,
        "core_calendar_get_action_events_by_timesort",
        &[
            param("timesortfrom", from_s),
            param("timesortto", to_s),
            param("limitnum", 50),
        ],
    )
    .await?;
    Ok(answer
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn notifications(site: &Site, limit: usize) -> Result<Vec<Value>, SourceError> {
    let answer = call(
        &site.base,
        &site.token,
        "message_popup_get_popup_notifications",
        &[
            param("useridto", site.user_id),
            param("newestfirst", 1),
            param("limit", limit),
            param("offset", 0),
        ],
    )
    .await?;
    Ok(answer
        .get("notifications")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn deadline_item(event: &Value, zone: Tz) -> Option<NewItem> {
    let id = event.get("id")?.as_i64()?;
    let at = event
        .get("timesort")
        .and_then(Value::as_i64)
        .map(|s| s * 1000);
    let name = text_of(event, "name");
    let course = event
        .get("course")
        .map(|course| text_of(course, "fullname"))
        .filter(|course| !course.is_empty());
    let mut summary = format!(
        "{}: {name}",
        at.map_or_else(
            || "No date".to_owned(),
            |at| format!("Due {}", stamp(at, zone, "%a %Y-%m-%d %H:%M"))
        )
    );
    if let Some(course) = &course {
        summary.push_str(&format!(" ({course})"));
    }
    Some(NewItem {
        external_id: format!("event:{id}"),
        kind: "assignment",
        title: clip(&name, 300),
        who: course,
        at,
        summary: clip(&summary, 600),
        url: event.get("url").and_then(Value::as_str).map(str::to_owned),
    })
}

fn notification_item(notification: &Value) -> Option<NewItem> {
    let id = notification.get("id")?.as_i64()?;
    let subject = text_of(notification, "subject");
    let from = text_of(notification, "userfromfullname");
    Some(NewItem {
        external_id: format!("notification:{id}"),
        kind: "notification",
        title: clip(&subject, 300),
        who: Some(from.clone()).filter(|from| !from.is_empty()),
        at: notification
            .get("timecreated")
            .and_then(Value::as_i64)
            .map(|s| s * 1000),
        summary: clip(
            &if from.is_empty() {
                subject.clone()
            } else {
                format!("{from}: {subject}")
            },
            600,
        ),
        url: notification
            .get("contexturl")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Poll: deadlines of the next 60 days against the last poll's, and
/// notifications newer than the last seen.
pub async fn poll(
    source: &Source,
    secret: &Value,
    zone: Tz,
    now: i64,
) -> Result<Polled, SourceError> {
    let site = site(source, secret)?;
    let events = deadlines(&site, now / 1000 - 86_400, now / 1000 + AHEAD_DAYS * 86_400).await?;
    let previous = source.cursor.as_ref();
    let seen = previous
        .and_then(|cursor| cursor.get("events"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    let mut current = serde_json::Map::new();
    for event in &events {
        let Some(item) = deadline_item(event, zone) else {
            continue;
        };
        let fingerprint =
            crate::util::sha256_hex(format!("{}|{:?}|{}", item.title, item.at, item.summary))[..16]
                .to_owned();
        if seen.get(&item.external_id).and_then(Value::as_str) != Some(fingerprint.as_str()) {
            items.push(item.clone());
        }
        if current.len() < CURSOR_EVENTS {
            current.insert(item.external_id, json!(fingerprint));
        }
    }
    let last_notification = previous
        .and_then(|cursor| cursor.get("lastNotification"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut newest = last_notification;
    if site.user_id > 0 {
        for notification in notifications(&site, NOTIFICATIONS).await? {
            let Some(id) = notification.get("id").and_then(Value::as_i64) else {
                continue;
            };
            newest = newest.max(id);
            if id > last_notification
                && let Some(item) = notification_item(&notification)
            {
                items.push(item);
            }
        }
    }
    Ok(Polled {
        baseline: previous.is_none(),
        cursor: json!({ "events": current, "lastNotification": newest }),
        items,
        removed: Vec::new(),
    })
}

/// A connection test: who the token is.
pub async fn test(source: &Source, secret: &Value) -> Result<String, SourceError> {
    let site = site(source, secret)?;
    let info = site_info(&site.base, &site.token).await?;
    Ok(format!(
        "Signed in to {} as {}",
        text_of(&info, "sitename"),
        text_of(&info, "fullname")
    ))
}

/// The brain's Moodle tools, by name (`moodle_courses`, ...).
pub async fn tool(
    name: &str,
    source: &Source,
    secret: &Value,
    args: &Value,
    zone: Tz,
    now: i64,
) -> Result<String, SourceError> {
    let site = site(source, secret)?;
    let int = |key: &str| args.get(key).and_then(Value::as_i64);
    let required =
        |key: &str| int(key).ok_or_else(|| SourceError::new(format!("`{key}` is required")));
    match name {
        "moodle_courses" => {
            let answer = call(
                &site.base,
                &site.token,
                "core_enrol_get_users_courses",
                &[param("userid", site.user_id)],
            )
            .await?;
            let courses = answer.as_array().cloned().unwrap_or_default();
            let mut text = format!("{} courses on {}:", courses.len(), source.name);
            for course in courses.iter().take(LISTED) {
                text.push_str(&format!(
                    "\n[{}] {} ({})",
                    course.get("id").and_then(Value::as_i64).unwrap_or_default(),
                    text_of(course, "fullname"),
                    text_of(course, "shortname")
                ));
            }
            Ok(text)
        }
        "moodle_deadlines" => {
            let days = int("days").unwrap_or(14).clamp(1, 120);
            let events = deadlines(&site, now / 1000 - 86_400, now / 1000 + days * 86_400).await?;
            let mut text = format!("Deadlines in the next {days} days on {}:", source.name);
            if events.is_empty() {
                text.push_str(" none.");
            }
            for event in &events {
                if let Some(item) = deadline_item(event, zone) {
                    let action = event
                        .get("action")
                        .map(|action| text_of(action, "name"))
                        .filter(|action| !action.is_empty())
                        .map(|action| format!(" — {action}"))
                        .unwrap_or_default();
                    text.push_str(&format!(
                        "\n[{}] {}{action} (course module {})",
                        item.external_id,
                        item.summary,
                        event
                            .get("instance")
                            .and_then(Value::as_i64)
                            .unwrap_or_default()
                    ));
                }
            }
            Ok(text)
        }
        "moodle_course" => {
            let course = required("course_id")?;
            let answer = call(
                &site.base,
                &site.token,
                "core_course_get_contents",
                &[param("courseid", course)],
            )
            .await?;
            let mut text = format!("Course {course}:");
            for section in answer.as_array().cloned().unwrap_or_default() {
                text.push_str(&format!("\n## {}", text_of(&section, "name")));
                let summary = net::html_text(&text_of(&section, "summary"));
                if !summary.is_empty() {
                    text.push_str(&format!("\n{}", clip(&summary, 400)));
                }
                for module in section
                    .get("modules")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    text.push_str(&format!(
                        "\n- [{} {}, instance {}] {}",
                        text_of(&module, "modname"),
                        module.get("id").and_then(Value::as_i64).unwrap_or_default(),
                        module
                            .get("instance")
                            .and_then(Value::as_i64)
                            .unwrap_or_default(),
                        text_of(&module, "name")
                    ));
                    let description = net::html_text(&text_of(&module, "description"));
                    if !description.is_empty() {
                        text.push_str(&format!(": {}", clip(&description, 200)));
                    }
                }
                if text.len() > TEXT_CHARS * 3 {
                    text.push_str("\n…");
                    break;
                }
            }
            Ok(clip(&text, TEXT_CHARS * 3))
        }
        "moodle_assignment" => {
            let course = required("course_id")?;
            let wanted = required("id")?;
            let answer = call(
                &site.base,
                &site.token,
                "mod_assign_get_assignments",
                &[param("courseids[0]", course)],
            )
            .await?;
            let assignments: Vec<Value> = answer
                .get("courses")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|course| {
                    course
                        .get("assignments")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
            let Some(found) = assignments.iter().find(|assignment| {
                assignment.get("id").and_then(Value::as_i64) == Some(wanted)
                    || assignment.get("cmid").and_then(Value::as_i64) == Some(wanted)
            }) else {
                let known: Vec<String> = assignments
                    .iter()
                    .map(|assignment| {
                        format!(
                            "[{}] {}",
                            assignment
                                .get("id")
                                .and_then(Value::as_i64)
                                .unwrap_or_default(),
                            text_of(assignment, "name")
                        )
                    })
                    .collect();
                return Err(SourceError::new(format!(
                    "No assignment {wanted} in course {course}. Its assignments: {}",
                    known.join("; ")
                )));
            };
            let mut text = text_of(found, "name");
            for (label, key) in [
                ("Due", "duedate"),
                ("Cut-off", "cutoffdate"),
                ("Opens", "allowsubmissionsfromdate"),
            ] {
                if let Some(at) = found.get(key).and_then(Value::as_i64).filter(|at| *at > 0) {
                    text.push_str(&format!(
                        "\n{label}: {}",
                        stamp(at * 1000, zone, "%a %Y-%m-%d %H:%M")
                    ));
                }
            }
            let intro = net::html_text(&text_of(found, "intro"));
            if !intro.is_empty() {
                text.push_str(&format!("\n\n{}", clip(&intro, TEXT_CHARS)));
            }
            let files: Vec<String> = found
                .get("introattachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|file| text_of(file, "filename"))
                .collect();
            if !files.is_empty() {
                text.push_str(&format!("\n\nAttached: {}", files.join(", ")));
            }
            Ok(text)
        }
        "moodle_forum" => {
            let forum = required("forum_id")?;
            let answer = call(
                &site.base,
                &site.token,
                "mod_forum_get_forum_discussions",
                &[
                    param("forumid", forum),
                    param("perpage", 20),
                    param("page", 0),
                ],
            )
            .await?;
            let discussions = answer
                .get("discussions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut text = format!("Forum {forum}, latest {}:", discussions.len());
            for discussion in &discussions {
                let at = discussion
                    .get("timemodified")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    * 1000;
                text.push_str(&format!(
                    "\n- {} · {} · {}: {}",
                    stamp(at, zone, "%Y-%m-%d %H:%M"),
                    text_of(discussion, "userfullname"),
                    text_of(discussion, "subject"),
                    clip(&net::html_text(&text_of(discussion, "message")), 400)
                ));
            }
            Ok(clip(&text, TEXT_CHARS * 2))
        }
        "moodle_notifications" => {
            let n = int("n").unwrap_or(10).clamp(1, 50) as usize;
            let mut text = format!("Latest notifications on {}:", source.name);
            let found = notifications(&site, n).await?;
            if found.is_empty() {
                text.push_str(" none.");
            }
            for notification in &found {
                let at = notification
                    .get("timecreated")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    * 1000;
                let read = notification.get("read").and_then(Value::as_bool) == Some(true);
                text.push_str(&format!(
                    "\n- {} · {}{}\n  {}",
                    stamp(at, zone, "%Y-%m-%d %H:%M"),
                    text_of(notification, "subject"),
                    if read { "" } else { " (unread)" },
                    clip(&net::html_text(&text_of(notification, "smallmessage")), 300)
                ));
            }
            Ok(text)
        }
        _ => Err(SourceError::new(format!("No tool {name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn site_addresses() {
        assert_eq!(
            base_url("https://moodle.school.edu/").unwrap().as_str(),
            "https://moodle.school.edu/"
        );
        assert_eq!(
            base_url("https://school.edu/moodle/login/index.php?x=1")
                .unwrap()
                .as_str(),
            "https://school.edu/moodle"
        );
        assert_eq!(
            launch_url(&base_url("https://school.edu/moodle").unwrap(), "abc").as_str(),
            "https://school.edu/moodle/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=abc&urlscheme=moodlemobile"
        );
        assert_eq!(
            endpoint(
                &base_url("https://moodle.school.edu").unwrap(),
                "/login/token.php"
            )
            .as_str(),
            "https://moodle.school.edu/login/token.php"
        );
    }

    #[test]
    fn app_logins() {
        let site = "https://moodle.school.edu";
        let passport = "12345";
        let signature = crate::util::hex(&Md5::digest(format!("{site}{passport}").as_bytes()));
        let payload = base64::engine::general_purpose::STANDARD
            .encode(format!("{signature}:::tok123:::private"));
        let pasted = format!("moodlemobile://token={}", payload.replace('=', "%3D"));
        let (found, token) = launched(&pasted).unwrap();
        assert_eq!(
            (found.as_str(), token.as_str()),
            (signature.as_str(), "tok123")
        );
        assert!(signed(&found, "https://moodle.school.edu/", passport));
        assert!(!signed(&found, site, "other"));
        assert!(launched("moodlemobile://token=!!!").is_err());
        assert!(launched("https://moodle.school.edu").is_err());
    }

    #[tokio::test]
    async fn only_read_only_functions() {
        let base = base_url("https://moodle.invalid").unwrap();
        let error = call(&base, "t", "mod_assign_save_submission", &[])
            .await
            .unwrap_err();
        assert!(
            error.message.contains("not a read-only function"),
            "{}",
            error.message
        );
    }
}

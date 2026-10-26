use crate::db::{Store, atomic};
use crate::error::{ApiError, ApiResult};
use crate::util::{new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const LIST_MAX: u32 = 100;
const RESPONSIBILITIES_MAX: u32 = 100;
// No cursor/retention policy yet: keep every owner list wholly addressable in
// one capped page. Exhaustion fails closed; controls never replenish budgets.
// Archived records leave lists and caps but stay stored, so their dedup keys,
// idempotency keys and tombstones keep working; there is no hard deletion yet.
const SUGGESTIONS_MAX: i64 = 100;
/// SQL filter for records that are not archived.
const LIVE: &str = "json_extract(data,'$.archivedAt') IS NULL";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeAccess {
    Progress,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationScope {
    pub workspace_id: String,
    pub access: ScopeAccess,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budgets {
    pub observations: u32,
    pub dispatches: u32,
    pub concurrency: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsibilityInput {
    pub idempotency_key: String,
    pub purpose: String,
    pub scopes: Vec<ObservationScope>,
    pub budgets: Budgets,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Responsibility {
    pub id: String,
    pub owner_user: String,
    pub revision: i64,
    pub generation: i64,
    pub purpose: String,
    pub scopes: Vec<ObservationScope>,
    pub budgets: Budgets,
    pub enabled: bool,
    pub observation_paused: bool,
    pub coordination_paused: bool,
    pub observations_used: u32,
    pub dispatches_used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponsibilityAction {
    Activate,
    Disable,
    PauseObservation,
    ResumeObservation,
    PauseCoordination,
    ResumeCoordination,
    /// Irreversible: leaves lists and the cap. Needs a disabled responsibility
    /// without running executions; archives its suggestions and tasks with it.
    Archive,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResponsibilityControl {
    pub expected_revision: i64,
    pub expected_generation: i64,
    pub action: ResponsibilityAction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Pending,
    Snoozed,
    Dismissed,
    Linked,
    NeedsRefresh,
    Superseded,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestedAction {
    ReviewSessionInput,
}
/// Evidence is identifiers and revisions only. No transcript/title/prompt is copied.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub workspace_id: String,
    pub session_id: String,
    /// Gateway session binding generation, NOT the independent Node runner epoch.
    pub runner_epoch: i64,
    pub interaction_id: String,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suggestion {
    pub id: String,
    pub owner_user: String,
    pub responsibility_id: String,
    pub condition_key: String,
    pub occurrence_key: String,
    pub revision: i64,
    pub evidence: Evidence,
    pub action: SuggestedAction,
    pub target_session_id: String,
    pub disposition: Disposition,
    pub snoozed_until: Option<i64>,
    pub task_id: Option<String>,
    pub accepted_revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptInput {
    pub expected_revision: i64,
    pub command_id: String,
}
#[derive(Clone, Debug)]
pub enum SuggestionAction {
    Dismiss,
    Snooze {
        until: i64,
    },
    /// Only an unlinked, dismissed or superseded suggestion; linked ones are
    /// archived with their task.
    Archive,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestionControl {
    pub expected_revision: i64,
    pub action: SuggestionAction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Tracked,
    Starting,
    Queued,
    Running,
    WaitingInput,
    Completed,
    Failed,
    Interrupted,
    Stopping,
    Stopped,
}
impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Interrupted | Self::Stopped
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execution {
    pub dispatch_id: String,
    pub generation: i64,
    pub accepted_revision: i64,
    pub accepted_at: i64,
    pub instruction: String,
    pub responsibility_generation: i64,
    pub responsibility_id: String,
    pub workspace_id: String,
    /// Immutable source binding at Start; a refreshed suggestion cannot renew execution authority.
    pub source_runner_epoch: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub owner_user: String,
    pub origin_suggestion_id: String,
    pub accepted_suggestion_revision: i64,
    pub action: SuggestedAction,
    pub target_session_id: String,
    pub execution_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<Execution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    pub status: TaskStatus,
    pub revision: i64,
    pub control_generation: i64,
    pub coordination_paused: bool,
    pub taken_over: bool,
    /// Host bookkeeping: the Node has handed the terminal task's execution
    /// conversation to the user (or it never held one), so nothing is pending.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub execution_released: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
#[derive(Clone, Copy, Debug)]
pub enum TaskAction {
    PauseCoordination,
    ResumeCoordination,
    TakeOver,
    Stop,
    /// Only a terminal task; archives its origin suggestion too.
    Archive,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskControl {
    pub expected_revision: i64,
    pub expected_generation: i64,
    pub action: TaskAction,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartInput {
    pub expected_revision: i64,
    pub expected_generation: i64,
    pub command_id: String,
    pub instruction: String,
}

// Serde's tagged *unit* variants ignore unknown fields even with
// deny_unknown_fields. Decode as empty struct variants to make the wire strict.
macro_rules! strict_actions {
 ($ty:ident { $($variant:ident),+ $(,)? }) => {
  impl<'de> Deserialize<'de> for $ty {
   fn deserialize<D: serde::Deserializer<'de>>(deserializer:D)->Result<Self,D::Error>{
    #[derive(Deserialize)]
    #[serde(tag="type",rename_all="snake_case",deny_unknown_fields)]
    enum Wire { $($variant {}),+ }
    Ok(match Wire::deserialize(deserializer)? { $(Wire::$variant {}=>Self::$variant),+ })
   }
  }
 };
}
strict_actions!(ResponsibilityAction {
    Activate,
    Disable,
    PauseObservation,
    ResumeObservation,
    PauseCoordination,
    ResumeCoordination,
    Archive
});
strict_actions!(TaskAction {
    PauseCoordination,
    ResumeCoordination,
    TakeOver,
    Stop,
    Archive
});
impl<'de> Deserialize<'de> for SuggestionAction {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
        enum Wire {
            Dismiss {},
            Snooze { until: i64 },
            Archive {},
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::Dismiss {} => Self::Dismiss,
            Wire::Snooze { until } => Self::Snooze { until },
            Wire::Archive {} => Self::Archive,
        })
    }
}
fn invalid() -> ApiError {
    ApiError::invalid_input()
}
fn missing() -> ApiError {
    ApiError::not_found("Pots record not found")
}
fn archived() -> ApiError {
    ApiError::new(409, "archived", "Pots record is archived")
}
fn conflict() -> ApiError {
    ApiError::new(
        409,
        "revision_conflict",
        "Pots record changed; refresh before retrying",
    )
}
fn text(s: &str, max: usize) -> ApiResult<()> {
    if s.trim().is_empty() || s.len() > max {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn encode<T: Serialize>(v: &T) -> ApiResult<String> {
    serde_json::to_string(v).map_err(|_| ApiError::internal())
}
fn decode<T: DeserializeOwned>(v: String) -> ApiResult<T> {
    serde_json::from_str(&v).map_err(|_| ApiError::internal())
}
fn row<T: DeserializeOwned>(conn: &Connection, table: &str, user: &str, id: &str) -> ApiResult<T> {
    let data: Option<String> = conn
        .query_row(
            &format!("SELECT data FROM {table} WHERE id=? AND owner_user=?"),
            params![id, user],
            |r| r.get(0),
        )
        .optional()?;
    decode(data.ok_or_else(missing)?)
}
fn list<T: DeserializeOwned>(
    conn: &Connection,
    table: &str,
    user: &str,
    limit: u32,
) -> ApiResult<Vec<T>> {
    if limit == 0 || limit > LIST_MAX {
        return Err(invalid());
    }
    let mut q = conn.prepare(&format!(
        "SELECT data FROM {table} WHERE owner_user=? AND {LIVE} ORDER BY id LIMIT ?"
    ))?;
    q.query_map(params![user, limit], |r| r.get::<_, String>(0))?
        .map(|r| decode(r?))
        .collect()
}
/// Reject removed/deleting/checking and foreign/private workspace scopes, without claiming ownership.
fn workspace(conn: &Connection, user: &str, id: &str) -> ApiResult<()> {
    conn.get_workspace(id)
        .map_err(|e| if e.status < 500 { missing() } else { e })?;
    if !conn.checkpoint_workspace_visible_to_user(id, user)? {
        return Err(missing());
    }
    let checking:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM workspace_removals WHERE workspace_id=? AND status='checking')",[id],|r|r.get(0))?;
    if checking {
        return Err(ApiError::new(
            409,
            "workspace_not_ready",
            "Workspace removal is being checked",
        ));
    }
    Ok(())
}
fn source(conn: &Connection, user: &str, evidence: &Evidence) -> ApiResult<()> {
    workspace(conn, user, &evidence.workspace_id)?;
    let session = conn
        .claim_session(&evidence.session_id, user, false)
        .map_err(|e| if e.status < 500 { missing() } else { e })?;
    if session.workspace_id != evidence.workspace_id
        || session.runner_epoch != evidence.runner_epoch
    {
        return Err(missing());
    }
    Ok(())
}
// Acquire the SQLite write reservation before reading records. This avoids deferred
// read->write snapshot races across gateway connections. Savepoints remain nestable.
fn lock_owner(conn: &Connection, user: &str) -> ApiResult<()> {
    conn.execute(
        "UPDATE pots_responsibilities SET revision=revision WHERE owner_user=?",
        [user],
    )?;
    Ok(())
}
fn save_responsibility(conn: &Connection, r: &Responsibility) -> ApiResult<()> {
    conn.execute("UPDATE pots_responsibilities SET revision=?,generation=?,data=? WHERE id=? AND owner_user=?",params![r.revision,r.generation,encode(r)?,r.id,r.owner_user])?;
    Ok(())
}
fn save_suggestion(conn: &Connection, s: &Suggestion) -> ApiResult<()> {
    conn.execute(
        "UPDATE pots_suggestions SET revision=?,data=? WHERE id=? AND owner_user=?",
        params![s.revision, encode(s)?, s.id, s.owner_user],
    )?;
    Ok(())
}

pub fn create_responsibility(
    conn: &Connection,
    user: &str,
    input: ResponsibilityInput,
    now: i64,
) -> ApiResult<Responsibility> {
    text(user, 320)?;
    text(&input.purpose, 2000)?;
    text(&input.idempotency_key, 256)?;
    let create_spec = encode(&input)?;
    if input.scopes.is_empty()
        || input.scopes.len() > 32
        || input.budgets.observations == 0
        || input.budgets.observations > 1_000_000
        || input.budgets.dispatches > 1_000_000
        || input.budgets.concurrency == 0
        || input.budgets.concurrency > 32
    {
        return Err(invalid());
    }
    let mut ids = std::collections::HashSet::new();
    for scope in &input.scopes {
        text(&scope.workspace_id, 256)?;
        if !ids.insert(&scope.workspace_id) {
            return Err(invalid());
        }
    }
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        for scope in &input.scopes {
            workspace(conn, user, &scope.workspace_id)?;
        }
        let prior:Option<(String,String)>=conn.query_row("SELECT data,create_spec FROM pots_responsibilities WHERE owner_user=? AND create_key=?",params![user,input.idempotency_key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((data, spec)) = prior {
            if spec != create_spec {
                return Err(ApiError::new(
                    409,
                    "idempotency_conflict",
                    "Idempotency key already used for different settings",
                ));
            }
            return decode(data);
        }
        let count: i64 = conn.query_row(
            &format!("SELECT count(*) FROM pots_responsibilities WHERE owner_user=? AND {LIVE}"),
            [user],
            |r| r.get(0),
        )?;
        if count >= i64::from(RESPONSIBILITIES_MAX) {
            return Err(ApiError::new(
                409,
                "limit_reached",
                "Responsibility limit reached",
            ));
        }
        let r = Responsibility {
            id: new_id("pr"),
            owner_user: user.into(),
            revision: 1,
            generation: 1,
            purpose: input.purpose,
            scopes: input.scopes,
            budgets: input.budgets,
            enabled: false,
            observation_paused: false,
            coordination_paused: true,
            observations_used: 0,
            dispatches_used: 0,
            archived_at: None,
            created_at: now,
            updated_at: now,
        };
        conn.execute("INSERT INTO pots_responsibilities(id,owner_user,create_key,create_spec,revision,generation,data) VALUES (?,?,?,?,?,?,?)",params![r.id,user,input.idempotency_key,create_spec,r.revision,r.generation,encode(&r)?])?;
        Ok(r)
    })
}
pub fn get_responsibility(conn: &Connection, user: &str, id: &str) -> ApiResult<Responsibility> {
    row(conn, "pots_responsibilities", user, id)
}
pub fn list_responsibilities(
    conn: &Connection,
    user: &str,
    limit: u32,
) -> ApiResult<Vec<Responsibility>> {
    list(conn, "pots_responsibilities", user, limit)
}
pub fn control_responsibility(
    conn: &Connection,
    user: &str,
    id: &str,
    input: ResponsibilityControl,
    now: i64,
) -> ApiResult<Responsibility> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut r = get_responsibility(conn, user, id)?;
        if r.archived_at.is_some() {
            // A lost Archive reply may be retried; nothing else applies.
            return if matches!(input.action, ResponsibilityAction::Archive) {
                Ok(r)
            } else {
                Err(archived())
            };
        }
        if r.revision != input.expected_revision || r.generation != input.expected_generation {
            return Err(conflict());
        }
        match input.action {
            ResponsibilityAction::Activate => {
                for s in &r.scopes {
                    workspace(conn, user, &s.workspace_id)?;
                }
                r.enabled = true;
            }
            ResponsibilityAction::Disable => r.enabled = false,
            ResponsibilityAction::PauseObservation => r.observation_paused = true,
            ResponsibilityAction::ResumeObservation => {
                for s in &r.scopes {
                    workspace(conn, user, &s.workspace_id)?;
                }
                r.observation_paused = false;
            }
            ResponsibilityAction::PauseCoordination => r.coordination_paused = true,
            ResponsibilityAction::ResumeCoordination => r.coordination_paused = false,
            ResponsibilityAction::Archive => {
                if r.enabled {
                    return Err(ApiError::new(
                        409,
                        "not_actionable",
                        "Disable the responsibility before archiving it",
                    ));
                }
                archive_responsibility_records(conn, user, &r.id, now)?;
                r.archived_at = Some(now);
            }
        }
        r.revision += 1;
        r.generation += 1;
        r.updated_at = now;
        save_responsibility(conn, &r)?;
        Ok(r)
    })
}

/// Trusted HOST ONLY: caller authenticates the node and current session binding.
/// Never expose this function through REST/agent operations. Persist only a
/// generic progress condition, not event text, prompts, or authority claims.
/// Dedup happens before quota reservation; each material occurrence costs one.
#[allow(clippy::too_many_arguments)]
pub fn ingest_progress(
    conn: &Connection,
    user: &str,
    workspace_id: &str,
    session_id: &str,
    epoch: i64,
    interaction_id: &str,
    expires_at: i64,
    now: i64,
) -> ApiResult<Vec<Suggestion>> {
    text(interaction_id, 256)?;
    if expires_at <= now {
        return Ok(Vec::new());
    }
    let evidence = Evidence {
        workspace_id: workspace_id.into(),
        session_id: session_id.into(),
        runner_epoch: epoch,
        interaction_id: interaction_id.into(),
        expires_at,
    };
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        source(conn, user, &evidence)?;
        let responsibilities = list_responsibilities(conn, user, LIST_MAX)?;
        let mut out = Vec::new();
        for mut r in responsibilities {
            if !r.enabled
                || r.observation_paused
                || !r.scopes.iter().any(|s| s.workspace_id == workspace_id)
            {
                continue;
            }
            let condition = "session_needs_input".to_owned();
            // A JSON tuple is injective even if identifiers contain separators.
            let occurrence = encode(&(session_id, interaction_id))?;
            let existing:Option<String>=conn.query_row("SELECT data FROM pots_suggestions WHERE owner_user=? AND condition_key=? AND occurrence_key=?",params![user,condition,occurrence],|row|row.get(0)).optional()?;
            if let Some(data) = existing {
                let mut prior: Suggestion = decode(data)?;
                // Archived occurrences stay deduplicated and are never revived.
                if prior.archived_at.is_some() {
                    continue;
                }
                // Do not silently transfer an existing issue to another responsibility.
                if prior.responsibility_id != r.id {
                    continue;
                }
                if prior.evidence.runner_epoch != epoch {
                    // Reconnect is not a new occurrence or a renewed instruction.
                    // Only a currently authorized host event refreshes the binding.
                    prior.evidence.runner_epoch = epoch;
                    // A replay cannot extend a formerly issued freshness window.
                    prior.evidence.expires_at = prior.evidence.expires_at.min(expires_at);
                    prior.revision += 1;
                    prior.updated_at = now;
                    save_suggestion(conn, &prior)?;
                    out.push(freshness(prior, now));
                }
                continue;
            }
            if r.observations_used >= r.budgets.observations {
                continue;
            }
            let count: i64 = conn.query_row(
                &format!("SELECT count(*) FROM pots_suggestions WHERE owner_user=? AND {LIVE}"),
                [user],
                |row| row.get(0),
            )?;
            if count >= SUGGESTIONS_MAX {
                continue;
            }
            let s = Suggestion {
                id: new_id("ps"),
                owner_user: user.into(),
                responsibility_id: r.id.clone(),
                condition_key: condition,
                occurrence_key: occurrence,
                revision: 1,
                evidence: evidence.clone(),
                action: SuggestedAction::ReviewSessionInput,
                target_session_id: session_id.into(),
                disposition: Disposition::Pending,
                snoozed_until: None,
                task_id: None,
                accepted_revision: None,
                archived_at: None,
                created_at: now,
                updated_at: now,
            };
            conn.execute("INSERT INTO pots_suggestions(id,owner_user,responsibility_id,condition_key,occurrence_key,revision,data) VALUES(?,?,?,?,?,?,?)",params![s.id,user,r.id,s.condition_key,s.occurrence_key,s.revision,encode(&s)?])?;
            r.observations_used += 1;
            r.revision += 1;
            r.updated_at = now;
            save_responsibility(conn, &r)?;
            out.push(s);
        }
        Ok(out)
    })
}

// Expiry is derived from durable evidence, never from a timer/client wakeup.
// Reads project it without database writes; the same revision remains fenced
// and acceptance checks the durable expiry again with its operation clock.
fn freshness(mut s: Suggestion, now: i64) -> Suggestion {
    if s.evidence.expires_at <= now {
        s.disposition = if s.task_id.is_some() {
            Disposition::NeedsRefresh
        } else {
            Disposition::Superseded
        };
    }
    s
}
pub fn get_suggestion(conn: &Connection, user: &str, id: &str) -> ApiResult<Suggestion> {
    let s: Suggestion = row(conn, "pots_suggestions", user, id)?;
    source(conn, user, &s.evidence)?;
    Ok(freshness(s, now_ms()))
}
pub fn list_suggestions(conn: &Connection, user: &str, limit: u32) -> ApiResult<Vec<Suggestion>> {
    let rows: Vec<Suggestion> = list(conn, "pots_suggestions", user, limit)?;
    rows.into_iter()
        .filter_map(|s| match source(conn, user, &s.evidence) {
            Ok(()) => Some(Ok(freshness(s, now_ms()))),
            Err(e) if e.status < 500 => None,
            Err(e) => Some(Err(e)),
        })
        .collect()
}
pub fn control_suggestion(
    conn: &Connection,
    user: &str,
    id: &str,
    input: SuggestionControl,
    now: i64,
) -> ApiResult<Suggestion> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut s = freshness(get_suggestion(conn, user, id)?, now);
        if s.archived_at.is_some() {
            return if matches!(input.action, SuggestionAction::Archive) {
                Ok(s)
            } else {
                Err(archived())
            };
        }
        if s.revision != input.expected_revision {
            return Err(conflict());
        }
        if matches!(input.action, SuggestionAction::Archive) {
            if s.task_id.is_some()
                || !matches!(
                    s.disposition,
                    Disposition::Dismissed | Disposition::Superseded
                )
            {
                return Err(ApiError::new(
                    409,
                    "not_actionable",
                    "Dismiss the suggestion first; tracked ones are archived with their task",
                ));
            }
            s.archived_at = Some(now);
            s.revision += 1;
            s.updated_at = now;
            save_suggestion(conn, &s)?;
            return Ok(s);
        }
        if s.task_id.is_some()
            || matches!(
                s.disposition,
                Disposition::Superseded | Disposition::NeedsRefresh
            )
        {
            return Err(ApiError::new(
                409,
                "not_actionable",
                "Suggestion is no longer actionable",
            ));
        }
        match input.action {
            SuggestionAction::Dismiss => {
                s.disposition = Disposition::Dismissed;
                s.snoozed_until = None;
            }
            SuggestionAction::Snooze { until } => {
                if until <= now {
                    return Err(invalid());
                }
                s.disposition = Disposition::Snoozed;
                s.snoozed_until = Some(until);
            }
            SuggestionAction::Archive => unreachable!("handled above"),
        }
        s.revision += 1;
        s.updated_at = now;
        save_suggestion(conn, &s)?;
        Ok(s)
    })
}
/// Atomically create/link one canonical task. command_id is diagnostic input,
/// never the deduplication key: a second device returns the same accepted task.
/// No session is created and no execution is dispatched.
pub fn accept_tracking(
    conn: &Connection,
    user: &str,
    id: &str,
    input: AcceptInput,
    now: i64,
) -> ApiResult<Task> {
    text(&input.command_id, 256)?;
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut s = freshness(get_suggestion(conn, user, id)?, now);
        if s.task_id.is_none() && s.archived_at.is_some() {
            return Err(archived());
        }
        if let Some(task_id) = &s.task_id {
            if s.disposition != Disposition::Linked {
                return Err(ApiError::new(
                    409,
                    "not_actionable",
                    "Suggestion evidence must be refreshed",
                ));
            }
            if s.accepted_revision != Some(input.expected_revision)
                && s.revision != input.expected_revision
            {
                return Err(conflict());
            }
            return get_task(conn, user, task_id);
        }
        if s.revision != input.expected_revision {
            return Err(conflict());
        }
        if !matches!(s.disposition, Disposition::Pending | Disposition::Snoozed)
            || s.snoozed_until.is_some_and(|until| until > now)
        {
            return Err(ApiError::new(
                409,
                "not_actionable",
                "Suggestion must be current and unsnoozed",
            ));
        }
        let task = Task {
            id: new_id("pt"),
            owner_user: user.into(),
            origin_suggestion_id: s.id.clone(),
            accepted_suggestion_revision: s.revision,
            action: s.action,
            target_session_id: s.target_session_id.clone(),
            execution_session_id: None,
            execution: None,
            outcome: None,
            failure: None,
            status: TaskStatus::Tracked,
            revision: 1,
            control_generation: 1,
            coordination_paused: false,
            taken_over: false,
            execution_released: false,
            archived_at: None,
            created_at: now,
            updated_at: now,
        };
        conn.execute("INSERT INTO pots_tasks(id,owner_user,origin_suggestion_id,revision,generation,data) VALUES(?,?,?,?,?,?)",params![task.id,user,s.id,task.revision,task.control_generation,encode(&task)?])?;
        s.accepted_revision = Some(s.revision);
        s.task_id = Some(task.id.clone());
        s.disposition = Disposition::Linked;
        s.snoozed_until = None;
        s.revision += 1;
        s.updated_at = now;
        save_suggestion(conn, &s)?;
        Ok(task)
    })
}
pub fn get_task(conn: &Connection, user: &str, id: &str) -> ApiResult<Task> {
    let task: Task = row(conn, "pots_tasks", user, id)?;
    get_suggestion(conn, user, &task.origin_suggestion_id)?;
    Ok(task)
}
pub fn list_tasks(conn: &Connection, user: &str, limit: u32) -> ApiResult<Vec<Task>> {
    let rows: Vec<Task> = list(conn, "pots_tasks", user, limit)?;
    rows.into_iter()
        .filter_map(
            |task| match get_suggestion(conn, user, &task.origin_suggestion_id) {
                Ok(_) => Some(Ok(task)),
                Err(e) if e.status < 500 => None,
                Err(e) => Some(Err(e)),
            },
        )
        .collect()
}
pub fn control_task(
    conn: &Connection,
    user: &str,
    id: &str,
    input: TaskControl,
    now: i64,
) -> ApiResult<Task> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        // Cancellation and fencing must remain available after source access is
        // revoked. Only Resume can amplify authority and requires current grants.
        let mut task = if matches!(input.action, TaskAction::ResumeCoordination) {
            get_task(conn, user, id)?
        } else {
            get_task_for_control(conn, user, id)?
        };
        if task.archived_at.is_some() {
            return if matches!(input.action, TaskAction::Archive) {
                Ok(task)
            } else {
                Err(archived())
            };
        }
        if task.revision != input.expected_revision
            || task.control_generation != input.expected_generation
        {
            return Err(conflict());
        }
        match input.action {
            TaskAction::PauseCoordination => task.coordination_paused = true,
            TaskAction::ResumeCoordination => {
                if task.taken_over
                    || task.status.is_terminal()
                    || task.status == TaskStatus::Stopping
                {
                    return Err(ApiError::new(
                        409,
                        "not_actionable",
                        "Takeover/stopped work cannot be implicitly resumed",
                    ));
                }
                task.coordination_paused = false;
            }
            TaskAction::TakeOver => {
                task.taken_over = true;
                task.coordination_paused = true;
            }
            TaskAction::Stop => {
                if !task.status.is_terminal() {
                    task.status = if task.execution.is_some() {
                        TaskStatus::Stopping
                    } else {
                        TaskStatus::Stopped
                    };
                }
                task.coordination_paused = true;
            }
            TaskAction::Archive => {
                if !task.status.is_terminal() {
                    return Err(ApiError::new(
                        409,
                        "not_actionable",
                        "Only finished or stopped tasks can be archived",
                    ));
                }
                archive_suggestion_row(conn, user, &task.origin_suggestion_id, now)?;
                task.archived_at = Some(now);
            }
        }
        task.revision += 1;
        task.control_generation += 1;
        task.updated_at = now;
        conn.execute(
            "UPDATE pots_tasks SET revision=?,generation=?,data=? WHERE id=? AND owner_user=?",
            params![
                task.revision,
                task.control_generation,
                encode(&task)?,
                id,
                user
            ],
        )?;
        Ok(task)
    })
}
/// Reserve exactly one lifetime execution, before any Node/network IO. A client
/// command ID is diagnostic only; accepted task revision/generation is canonical.
#[cfg(test)]
pub fn start_task(
    conn: &Connection,
    user: &str,
    id: &str,
    input: StartInput,
    now: i64,
) -> ApiResult<Task> {
    reserve_start_task(conn, user, id, input, now).map(|(task, _)| task)
}
pub fn reserve_start_task(
    conn: &Connection,
    user: &str,
    id: &str,
    input: StartInput,
    now: i64,
) -> ApiResult<(Task, bool)> {
    text(&input.command_id, 256)?;
    text(&input.instruction, 20_000)?;
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut task = get_task(conn, user, id)?;
        if let Some(execution) = &task.execution {
            if execution.instruction != input.instruction {
                return Err(ApiError::new(
                    409,
                    "idempotency_conflict",
                    "Task already has a different execution instruction",
                ));
            }
            if (execution.accepted_revision == input.expected_revision
                && execution.generation == input.expected_generation)
                || (task.revision == input.expected_revision
                    && task.control_generation == input.expected_generation)
            {
                return Ok((task, false));
            }
            return Err(conflict());
        }
        if task.revision != input.expected_revision
            || task.control_generation != input.expected_generation
        {
            return Err(conflict());
        }
        if task.status != TaskStatus::Tracked || task.coordination_paused || task.taken_over {
            return Err(not_actionable());
        }
        let s: Suggestion = row(conn, "pots_suggestions", user, &task.origin_suggestion_id)?;
        current_link(conn, user, &task, &s, now)?;
        let mut r = get_responsibility(conn, user, &s.responsibility_id)?;
        coordination(&r, &s.evidence.workspace_id)?;
        if r.dispatches_used >= r.budgets.dispatches {
            return Err(ApiError::new(
                409,
                "budget_exhausted",
                "Dispatch budget exhausted",
            ));
        }
        let active = list_tasks_for_host(conn, user, LIST_MAX)?
            .into_iter()
            .filter(|t| {
                !t.status.is_terminal()
                    && t.execution
                        .as_ref()
                        .is_some_and(|e| e.responsibility_id == r.id)
            })
            .count();
        if active >= r.budgets.concurrency as usize {
            return Err(ApiError::new(
                409,
                "concurrency_exhausted",
                "Execution concurrency exhausted",
            ));
        }
        task.execution = Some(Execution {
            dispatch_id: new_id("pd"),
            generation: task.control_generation,
            accepted_revision: task.revision,
            accepted_at: now,
            instruction: input.instruction,
            responsibility_generation: r.generation,
            responsibility_id: r.id.clone(),
            workspace_id: s.evidence.workspace_id,
            source_runner_epoch: s.evidence.runner_epoch,
        });
        task.status = TaskStatus::Starting;
        task.revision += 1;
        task.updated_at = now;
        r.dispatches_used += 1;
        r.revision += 1;
        r.updated_at = now;
        save_responsibility(conn, &r)?;
        save_task(conn, &task)?;
        Ok((task, true))
    })
}
/// Raw owner-scoped archive, also for records hidden by source revocation.
fn archive_suggestion_row(conn: &Connection, user: &str, id: &str, now: i64) -> ApiResult<()> {
    let mut s: Suggestion = row(conn, "pots_suggestions", user, id)?;
    if s.archived_at.is_none() {
        s.archived_at = Some(now);
        s.revision += 1;
        s.updated_at = now;
        save_suggestion(conn, &s)?;
    }
    Ok(())
}
/// Archive every live suggestion of a responsibility and its tasks, including
/// records hidden by revoked sources (they would otherwise hold cap slots
/// forever). Running executions must be stopped first; tracking-only tasks
/// are stopped as part of the archive. Validates everything before writing.
fn archive_responsibility_records(
    conn: &Connection,
    user: &str,
    responsibility_id: &str,
    now: i64,
) -> ApiResult<()> {
    let rows: Vec<String> = conn
        .prepare(&format!(
            "SELECT data FROM pots_suggestions WHERE owner_user=? AND responsibility_id=? AND {LIVE}"
        ))?
        .query_map(params![user, responsibility_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let suggestions: Vec<Suggestion> = rows.into_iter().map(decode).collect::<ApiResult<_>>()?;
    let mut tasks = Vec::new();
    for s in &suggestions {
        if let Some(task_id) = &s.task_id {
            let task = get_task_for_control(conn, user, task_id)?;
            if task.archived_at.is_some() {
                continue;
            }
            if !task.status.is_terminal() && task.execution.is_some() {
                return Err(ApiError::new(
                    409,
                    "active_execution",
                    "Stop or finish this responsibility's executions before archiving it",
                ));
            }
            tasks.push(task);
        }
    }
    for mut task in tasks {
        if !task.status.is_terminal() {
            task.status = TaskStatus::Stopped;
            task.coordination_paused = true;
            task.control_generation += 1;
        }
        task.archived_at = Some(now);
        task.revision += 1;
        task.updated_at = now;
        save_task(conn, &task)?;
    }
    for mut s in suggestions {
        s.archived_at = Some(now);
        s.revision += 1;
        s.updated_at = now;
        save_suggestion(conn, &s)?;
    }
    Ok(())
}
fn not_actionable() -> ApiError {
    ApiError::new(
        409,
        "not_actionable",
        "Task execution is not currently authorized",
    )
}
fn save_task(conn: &Connection, task: &Task) -> ApiResult<()> {
    conn.execute(
        "UPDATE pots_tasks SET revision=?,generation=?,data=? WHERE id=? AND owner_user=?",
        params![
            task.revision,
            task.control_generation,
            encode(task)?,
            task.id,
            task.owner_user
        ],
    )?;
    Ok(())
}
fn current_link(
    conn: &Connection,
    user: &str,
    task: &Task,
    s: &Suggestion,
    now: i64,
) -> ApiResult<()> {
    source(conn, user, &s.evidence)?;
    if s.disposition != Disposition::Linked
        || s.evidence.expires_at <= now
        || s.task_id.as_deref() != Some(task.id.as_str())
        || s.target_session_id != task.target_session_id
    {
        return Err(not_actionable());
    }
    Ok(())
}
fn coordination(r: &Responsibility, workspace_id: &str) -> ApiResult<()> {
    if !r.enabled
        || r.coordination_paused
        || !r.scopes.iter().any(|s| s.workspace_id == workspace_id)
    {
        return Err(not_actionable());
    }
    Ok(())
}
/// HOST ONLY: owner-scoped raw task read for cancellation/reconciliation. Never
/// return this through ordinary list/get routes, which revalidate source access.
pub fn get_task_for_control(conn: &Connection, user: &str, id: &str) -> ApiResult<Task> {
    row(conn, "pots_tasks", user, id)
}
/// HOST ONLY: include hidden-source tasks so restart reconciliation cannot strand
/// accepted or stopping work. This is not permission to dispatch any task.
pub fn list_tasks_for_host(conn: &Connection, user: &str, limit: u32) -> ApiResult<Vec<Task>> {
    list(conn, "pots_tasks", user, limit)
}
fn execution_matches<'a>(task: &'a Task, dispatch_id: &str) -> ApiResult<&'a Execution> {
    task.execution
        .as_ref()
        .filter(|e| e.dispatch_id == dispatch_id)
        .ok_or_else(conflict)
}
/// HOST ONLY: bind a newly created dedicated session, even if controls changed
/// while Node IO was pending, so it remains addressable for cancellation.
pub fn bind_execution(
    conn: &Connection,
    user: &str,
    id: &str,
    dispatch_id: &str,
    session_id: &str,
    now: i64,
) -> ApiResult<Task> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut task = get_task_for_control(conn, user, id)?;
        let execution = execution_matches(&task, dispatch_id)?;
        let session = conn.get_session(session_id)?;
        if session.owner_user.as_deref() != Some(user)
            || session.workspace_id != execution.workspace_id
            || session_id == task.target_session_id
        {
            return Err(missing());
        }
        if let Some(bound) = &task.execution_session_id {
            return if bound == session_id {
                Ok(task)
            } else {
                Err(conflict())
            };
        }
        if list_tasks_for_host(conn, user, LIST_MAX)?
            .iter()
            .any(|t| t.id != task.id && t.execution_session_id.as_deref() == Some(session_id))
        {
            return Err(conflict());
        }
        task.execution_session_id = Some(session_id.into());
        task.revision += 1;
        task.updated_at = now;
        save_task(conn, &task)?;
        Ok(task)
    })
}
/// HOST ONLY: call at every external dispatch boundary (before create and again
/// before execution). No mutation and no additional quota charge. Node must also
/// enforce its dispatch token/generation fence against delayed duplicate IO.
pub fn authorize_dispatch(
    conn: &Connection,
    user: &str,
    id: &str,
    dispatch_id: &str,
    now: i64,
) -> ApiResult<Task> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let task = get_task_for_control(conn, user, id)?;
        let execution = execution_matches(&task, dispatch_id)?;
        if !matches!(task.status, TaskStatus::Starting | TaskStatus::Queued)
            || task.coordination_paused
            || task.taken_over
            || task.control_generation != execution.generation
        {
            return Err(not_actionable());
        }
        let s: Suggestion = row(conn, "pots_suggestions", user, &task.origin_suggestion_id)?;
        current_link(conn, user, &task, &s, now)?;
        let r = get_responsibility(conn, user, &execution.responsibility_id)?;
        coordination(&r, &execution.workspace_id)?;
        if r.generation != execution.responsibility_generation
            || s.responsibility_id != r.id
            || s.evidence.workspace_id != execution.workspace_id
            || s.evidence.runner_epoch != execution.source_runner_epoch
        {
            return Err(not_actionable());
        }
        if let Some(session_id) = &task.execution_session_id {
            let session = conn.claim_session(session_id, user, false)?;
            workspace(conn, user, &session.workspace_id)?;
            if session.workspace_id != execution.workspace_id
                || session_id == &task.target_session_id
            {
                return Err(missing());
            }
        }
        Ok(task)
    })
}
/// HOST ONLY: monotonic lifecycle updates. Delayed acknowledgements never undo
/// owner controls or terminal state. Once running, takeover/pause affect future
/// coordination, not the user's already-authorized running execution.
#[allow(clippy::too_many_arguments)]
pub fn set_execution_progress(
    conn: &Connection,
    user: &str,
    id: &str,
    dispatch_id: &str,
    status: TaskStatus,
    outcome: Option<&str>,
    failure: Option<&str>,
    now: i64,
) -> ApiResult<Task> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut task = get_task_for_control(conn, user, id)?;
        execution_matches(&task, dispatch_id)?;
        if task.status.is_terminal() || (task.status == status && failure.is_none()) {
            return Ok(task);
        }
        if task.status == TaskStatus::Stopping
            && !matches!(status, TaskStatus::Stopping | TaskStatus::Stopped)
        {
            return Ok(task);
        }
        let allowed = task.status == status
            || match task.status {
                TaskStatus::Starting => matches!(
                    status,
                    TaskStatus::Queued
                        | TaskStatus::Running
                        | TaskStatus::WaitingInput
                        | TaskStatus::Completed
                        | TaskStatus::Failed
                        | TaskStatus::Interrupted
                        | TaskStatus::Stopped
                ),
                TaskStatus::Queued => matches!(
                    status,
                    TaskStatus::Running
                        | TaskStatus::WaitingInput
                        | TaskStatus::Completed
                        | TaskStatus::Failed
                        | TaskStatus::Interrupted
                        | TaskStatus::Stopped
                ),
                TaskStatus::Running | TaskStatus::WaitingInput => matches!(
                    status,
                    TaskStatus::Running
                        | TaskStatus::WaitingInput
                        | TaskStatus::Completed
                        | TaskStatus::Failed
                        | TaskStatus::Interrupted
                        | TaskStatus::Stopped
                ),
                TaskStatus::Stopping => status == TaskStatus::Stopped,
                _ => false,
            };
        if !allowed {
            return Err(not_actionable());
        }
        if matches!(task.status, TaskStatus::Starting | TaskStatus::Queued)
            && matches!(
                status,
                TaskStatus::Queued | TaskStatus::Running | TaskStatus::WaitingInput
            )
        {
            // Status is observed reality, not permission to perform new IO. A
            // delayed acknowledgement must survive takeover/pause/revocation.
            if task.execution_session_id.is_none() {
                return Err(not_actionable());
            }
        }
        task.status = status;
        if status.is_terminal() {
            task.outcome = outcome.map(|s| {
                let clean: String = crate::dispatch::redact_secrets(s)
                    .chars()
                    .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                    .take(2000)
                    .collect();
                clean
            });
        }
        if failure.is_some() || status.is_terminal() {
            task.failure = failure.map(|s| match s {
                "Dispatch preparation failed; no work was started."
                | "Dispatch outcome is uncertain; inspect the execution conversation. It will not be retried."
                | "Dispatch authorization changed; no further work was sent."
                | "Execution is unavailable; inspect the execution conversation."
                | "Execution ended without completing the task."
                | "Stop is pending until the execution node reconnects." => s.to_owned(),
                _ => "Execution failed".to_owned(),
            });
        }
        task.revision += 1;
        task.updated_at = now;
        save_task(conn, &task)?;
        Ok(task)
    })
}
/// HOST ONLY: record that a terminal task's execution conversation no longer
/// waits for pots. Bookkeeping, not a user-visible change: no revision bump.
pub fn mark_execution_released(
    conn: &Connection,
    user: &str,
    id: &str,
    dispatch_id: &str,
) -> ApiResult<Task> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let mut task = get_task_for_control(conn, user, id)?;
        execution_matches(&task, dispatch_id)?;
        if !task.status.is_terminal() {
            return Err(not_actionable());
        }
        if !task.execution_released {
            task.execution_released = true;
            save_task(conn, &task)?;
        }
        Ok(task)
    })
}
/// Host-only interaction resolution. Do not complete a linked task or replay it.
/// Query is bounded by the maximum number of owner responsibilities, and targets
/// one injective occurrence key rather than scanning an unbounded inbox.
pub fn resolve_progress(
    conn: &Connection,
    user: &str,
    session_id: &str,
    epoch: i64,
    interaction_id: &str,
    now: i64,
) -> ApiResult<Vec<Suggestion>> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let occurrence = encode(&(session_id, interaction_id))?;
        let mut q=conn.prepare("SELECT data FROM pots_suggestions WHERE owner_user=? AND occurrence_key=? AND condition_key='session_needs_input' ORDER BY id LIMIT 100")?;
        let rows = q
            .query_map(params![user, occurrence], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for data in rows {
            let mut s: Suggestion = decode(data)?;
            if s.evidence.runner_epoch != epoch {
                continue;
            }
            source(conn, user, &s.evidence)?;
            let disposition = if s.task_id.is_some() {
                Disposition::NeedsRefresh
            } else {
                Disposition::Superseded
            };
            if s.disposition == disposition {
                continue;
            }
            s.disposition = disposition;
            s.snoozed_until = None;
            s.revision += 1;
            s.updated_at = now;
            save_suggestion(conn, &s)?;
            out.push(s);
        }
        Ok(out)
    })
}

/// Host lifecycle fence: a runner restart/exit/error makes outstanding requests
/// stale. It never completes or cancels a tracked task or grants fresh authority.
pub fn invalidate_session_progress(
    conn: &Connection,
    user: &str,
    session_id: &str,
    now: i64,
) -> ApiResult<Vec<Suggestion>> {
    atomic(conn, |conn| {
        lock_owner(conn, user)?;
        let session = conn
            .claim_session(session_id, user, false)
            .map_err(|e| if e.status < 500 { missing() } else { e })?;
        workspace(conn, user, &session.workspace_id)?;
        let rows: Vec<Suggestion> = list(conn, "pots_suggestions", user, LIST_MAX)?;
        let mut out = Vec::new();
        for mut s in rows {
            if s.evidence.session_id != session_id {
                continue;
            }
            let disposition = if s.task_id.is_some() {
                Disposition::NeedsRefresh
            } else {
                Disposition::Superseded
            };
            if s.disposition == disposition {
                continue;
            }
            s.disposition = disposition;
            s.snoozed_until = None;
            s.revision += 1;
            s.updated_at = now;
            save_suggestion(conn, &s)?;
            out.push(s);
        }
        Ok(out)
    })
}

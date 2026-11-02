//! User-controlled handoff between AskHuman and the Agent's native conversation.
//!
//! This state is independent of integration preferences and daemon lifetime. A pause epoch
//! also releases outstanding clients when pause/resume happen between their polling ticks.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub paused: bool,
    pub pause_id: String,
}

fn path() -> PathBuf {
    crate::paths::state_dir().join("interaction-control.json")
}

fn load_at(path: &Path) -> State {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn snapshot() -> State {
    load_at(&path())
}

pub fn interrupted_since(initial: &State) -> bool {
    let state = snapshot();
    state.paused || state.pause_id != initial.pause_id
}

pub fn paused() -> bool {
    snapshot().paused
}

pub fn set_paused(paused: bool) -> anyhow::Result<()> {
    set_paused_at(&path(), paused)
}

fn set_paused_at(path: &Path, paused: bool) -> anyhow::Result<()> {
    let _lock = crate::file_lock::FileLock::exclusive(&path.with_extension("lock"))?;
    let mut state = load_at(path);
    if state.paused == paused {
        return Ok(());
    }
    state.paused = paused;
    if paused {
        state.pause_id = uuid::Uuid::new_v4().to_string();
    }
    crate::integrations::hook_edit::atomic_write_private(path, &serde_json::to_vec(&state)?)
}

/// Dropping the losing future closes its IPC connection; the daemon then cancels its surfaces.
pub async fn while_active<F: Future>(work: F) -> Result<F::Output, ()> {
    while_active_at(&path(), work).await
}

async fn while_active_at<F: Future>(path: &Path, work: F) -> Result<F::Output, ()> {
    let initial = load_at(path);
    if initial.paused {
        return Err(());
    }
    let paused = async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let state = load_at(path);
            if state.paused || state.pause_id != initial.pause_id {
                return;
            }
        }
    };
    tokio::select! {
        biased;
        _ = paused => Err(()),
        result = work => {
            let state = load_at(path);
            if state.paused || state.pause_id != initial.pause_id { Err(()) } else { Ok(result) }
        },
    }
}

pub const PAUSED_NOTICE: &str = "[status]\nAskHuman is paused by the human on this computer. This is an explicit interaction-mode change, not a cancellation, an answer, or permission to proceed. Use the Agent's native conversation for questions, reports and task handoff. Do not retry AskHuman or wait for it in this turn. Native permission approvals remain required. On the next user turn, refresh the mode through the installed hook or a single AskHuman call; an explicit resumed status supersedes this notice.";

pub fn turn_context(paused: bool) -> &'static str {
    if paused {
        "The human has paused AskHuman on this computer. For this turn, use the native Agent conversation for questions, reports and task handoff; do not call AskHuman ask/whats_next or require its end-turn marker. Native permission approvals remain required. This explicit user-controlled mode takes precedence over the usual AskHuman interaction requirement."
    } else {
        "AskHuman interaction is active on this computer. Follow the installed AskHuman interaction protocol for this turn, including ask and whats_next. This current status supersedes any earlier paused-mode notice."
    }
}

pub fn request_notice(task: &crate::ipc::TaskRequest) -> String {
    let mut text = PAUSED_NOTICE.to_string();
    text.push_str("\n\nPresent the pending content to the human in the native conversation:\n");
    text.push_str(&task.message.text);
    for file in &task.message.files {
        text.push_str(&format!("\nAttachment: {}", file.path));
    }
    for question in &task.questions {
        text.push_str(&format!("\n\n{}", question.message));
        for option in &question.predefined_options {
            text.push_str(&format!("\n- {}", option.text));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pause_releases_waiter_even_after_immediate_resume() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.json");
        let waiter = while_active_at(&path, std::future::pending::<()>());
        let toggle = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            set_paused_at(&path, true).unwrap();
            set_paused_at(&path, false).unwrap();
        };
        let (result, _) = tokio::join!(waiter, toggle);
        assert!(result.is_err());
        assert!(!load_at(&path).paused);
        assert_eq!(while_active_at(&path, async { 42 }).await, Ok(42));
    }

    #[tokio::test]
    async fn paused_work_is_never_polled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.json");
        set_paused_at(&path, true).unwrap();
        let result = while_active_at(&path, async { panic!("must not submit or approve") }).await;
        assert!(result.is_err());
    }

    #[test]
    fn pause_persists_and_repeated_writes_preserve_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.json");
        set_paused_at(&path, true).unwrap();
        let id = load_at(&path).pause_id;
        set_paused_at(&path, true).unwrap();
        assert_eq!(load_at(&path).pause_id, id);
        set_paused_at(&path, false).unwrap();
        set_paused_at(&path, true).unwrap();
        assert_ne!(load_at(&path).pause_id, id);
    }
}

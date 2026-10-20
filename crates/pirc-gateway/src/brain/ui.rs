//! What the brain's agent may ask of a human: nothing yet. It opens no
//! dialogs (questions in rooms come with the tools that need them, plans
//! 05 to 07); its notices go to the log, and a warning or error is kept as
//! the turn's error.

use std::rc::Rc;

use pirc_agent::LocalBoxFuture;
use pirc_agent::ui::{Choice, DialogOptions, NotifyLevel, Ui};

use super::turn::Progress;

pub struct BrainUi {
    progress: Rc<Progress>,
}

impl BrainUi {
    pub fn new(progress: Rc<Progress>) -> Self {
        Self { progress }
    }
}

impl Ui for BrainUi {
    fn select<'a>(
        &'a self,
        _: &'a str,
        _: &'a [String],
        _: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn choose<'a>(
        &'a self,
        _: &'a str,
        _: &'a [Choice],
        _: bool,
        _: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<Vec<String>>> {
        Box::pin(async { None })
    }
    fn confirm<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<bool>> {
        Box::pin(async { None })
    }
    fn input<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn editor<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn notify(&self, message: &str, level: NotifyLevel) {
        crate::log::info(&format!("brain {}: {message}", level.as_str()));
        if level != NotifyLevel::Info {
            *self.progress.last_error.borrow_mut() = Some(message.to_owned());
        }
    }
    fn set_status(&self, _: &str, _: Option<&str>) {}
    fn set_widget(&self, _: &str, _: Option<&[String]>) {}
}

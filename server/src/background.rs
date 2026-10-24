// Panic isolation for background loops. Each pass runs inside
// `run_pass`, so a panic is logged and the loop keeps going instead of
// ending the task for the life of the process.
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures::FutureExt;

/// Runs one pass of a background loop, logging and swallowing any panic.
pub async fn run_pass<F>(task: &'static str, pass: F)
where
    F: Future<Output = ()>,
{
    if AssertUnwindSafe(pass).catch_unwind().await.is_err() {
        tracing::error!(task, "background pass panicked; continuing");
    }
}

#[cfg(test)]
mod tests {
    use super::run_pass;

    #[tokio::test]
    async fn panic_in_pass_is_contained() {
        run_pass("test", async { panic!("boom") }).await;
    }
}

use crate::repo_cache::{with_repo, evict_repo};

#[napi]
pub async fn reset_soft(cwd: String) -> napi::Result<()> {
  let result = with_repo(&cwd, |repo| {
    let head_commit = repo
      .head_commit()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD commit: {e}")))?;

    // Find parent commit
    let parent_id = head_commit
      .parent_ids()
      .next()
      .ok_or_else(|| {
        napi::Error::from_reason("Cannot reset: HEAD has no parent commit".to_string())
      })?;

    let parent_oid = parent_id.detach();

    // Get current HEAD ref
    let head_ref = repo
      .head_ref()
      .map_err(|e| napi::Error::from_reason(format!("Failed to get HEAD ref: {e}")))?;

    match head_ref {
      Some(mut reference) => {
        // HEAD points to a branch — update the branch ref to parent
        reference
          .set_target_id(parent_oid, "reset --soft HEAD~1")
          .map_err(|e| napi::Error::from_reason(format!("Failed to update ref: {e}")))?;
      }
      None => {
        // Detached HEAD — update HEAD directly
        repo
          .reference(
            "HEAD",
            parent_oid,
            gix::refs::transaction::PreviousValue::MustExistAndMatch(
              gix::refs::Target::Object(head_commit.id().detach()),
            ),
            "reset --soft HEAD~1",
          )
          .map_err(|e| napi::Error::from_reason(format!("Failed to update HEAD: {e}")))?;
      }
    }

    Ok(())
  });

  // Evict after write regardless of success/failure to ensure fresh state
  evict_repo(&cwd);

  result
}

create table if not exists kv (key text primary key, value text not null);

create table if not exists projects (
      id text primary key,
      root_path text not null,
      display_name text not null,
      default_base_ref text not null,
      created_at text not null,
      last_opened_at text not null
    );

create table if not exists lanes (
      id text primary key,
      project_id text not null,
      name text not null,
      description text,
      lane_type text not null default 'worktree',
      base_ref text not null,
      branch_ref text not null,
      worktree_path text not null,
      attached_root_path text,
      is_edit_protected integer not null default 0,
      parent_lane_id text,
      color text,
      icon text,
      tags_json text,
      folder text,
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(parent_lane_id) references lanes(id)
    );

create index if not exists idx_lanes_project_id on lanes(project_id);

create index if not exists idx_lanes_project_type on lanes(project_id, lane_type);

create index if not exists idx_lanes_project_parent on lanes(project_id, parent_lane_id);

create table if not exists lane_linear_issues (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      issue_id text not null,
      issue_json text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade,
      foreign key(lane_id) references lanes(id) on delete cascade
    );

create index if not exists idx_lane_linear_issues_lane on lane_linear_issues(project_id, lane_id);

create index if not exists idx_lane_linear_issues_issue on lane_linear_issues(project_id, issue_id);

drop index if exists uniq_lane_linear_issues_lane;

delete from lane_linear_issues
      where rowid not in (
        select rowid from lane_linear_issues as keep
        where keep.id = (
          select id from lane_linear_issues inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
          order by inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      );

create table if not exists lane_linear_issue_links (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      issue_id text not null,
      issue_json text not null,
      role text not null,
      source text not null,
      include_in_pr integer not null default 1,
      close_on_merge integer not null default 0,
      evidence_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade,
      foreign key(lane_id) references lanes(id) on delete cascade
    );

create table if not exists session_linear_issues (
      id text primary key,
      project_id text not null,
      session_id text not null,
      lane_id text,
      issue_id text not null,
      issue_json text not null,
      role text not null,
      source text not null,
      include_in_pr integer not null default 1,
      close_on_merge integer not null default 0,
      evidence_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade
    );

create index if not exists idx_session_linear_issues_session on session_linear_issues(project_id, session_id);

create index if not exists idx_session_linear_issues_lane on session_linear_issues(project_id, lane_id);

create index if not exists idx_session_linear_issues_issue on session_linear_issues(project_id, issue_id);

create table if not exists session_github_issues (
      id text primary key,
      project_id text not null,
      session_id text not null,
      lane_id text,
      issue_id text not null,
      issue_json text not null,
      role text not null,
      source text not null,
      include_in_pr integer not null default 1,
      close_on_merge integer not null default 1,
      evidence_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade
    );

create index if not exists idx_session_github_issues_session on session_github_issues(project_id, session_id);

create index if not exists idx_session_github_issues_lane on session_github_issues(project_id, lane_id);

create index if not exists idx_session_github_issues_issue on session_github_issues(project_id, issue_id);

create index if not exists idx_lane_linear_issue_links_lane on lane_linear_issue_links(project_id, lane_id);

create index if not exists idx_lane_linear_issue_links_issue on lane_linear_issue_links(project_id, issue_id);

create index if not exists idx_lane_linear_issue_links_role on lane_linear_issue_links(project_id, role);

drop index if exists uq_lane_linear_issue_links_role;

delete from lane_linear_issue_links
      where rowid not in (
        select rowid from lane_linear_issue_links as keep
        where keep.id = (
          select id from lane_linear_issue_links inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
            and inner_p.issue_id = keep.issue_id
            and inner_p.role = keep.role
          order by inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      );

create table if not exists lane_branch_profiles (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      branch_ref text not null,
      normalized_branch_ref text not null,
      base_ref text not null,
      parent_lane_id text,
      source_branch_ref text,
      created_at text not null,
      updated_at text not null,
      last_checked_out_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(parent_lane_id) references lanes(id)
    );

create index if not exists idx_lane_branch_profiles_lane on lane_branch_profiles(project_id, lane_id);

create index if not exists idx_lane_branch_profiles_project_branch on lane_branch_profiles(project_id, normalized_branch_ref);

delete from lane_branch_profiles
      where rowid not in (
        select rowid from lane_branch_profiles as keep
        where keep.id = (
          select id from lane_branch_profiles inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
            and inner_p.normalized_branch_ref = keep.normalized_branch_ref
          order by coalesce(inner_p.last_checked_out_at, inner_p.updated_at) desc,
                   inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      );

create table if not exists lane_state_snapshots (
      lane_id text primary key,
      dirty integer not null default 0,
      ahead integer not null default 0,
      behind integer not null default 0,
      remote_behind integer not null default -1,
      rebase_in_progress integer not null default 0,
      agent_summary_json text,
      updated_at text not null,
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_lane_state_snapshots_updated_at on lane_state_snapshots(updated_at);

create table if not exists terminal_sessions (
      id text primary key,
      lane_id text not null,
      pty_id text,
      tracked integer not null default 1,
      goal text,
      tool_type text,
      pinned integer not null default 0,
      manually_named integer not null default 0,
      title text not null,
      started_at text not null,
      ended_at text,
      exit_code integer,
      transcript_path text not null,
      head_sha_start text,
      head_sha_end text,
      status text not null,
      last_output_preview text,
      last_output_at text,
      summary text,
      resume_command text,
      resume_metadata_json text,
      archived_at text,
      attention_source text,
      settle_override text,
      settle_source text,
      snoozed_until text,
      snoozed_at text,
      woke_at text,
      woke_reason text,
      chat_session_id text,
      owner_process_started_at text,
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id);

create index if not exists idx_terminal_sessions_status on terminal_sessions(status);

create index if not exists idx_terminal_sessions_started_at on terminal_sessions(started_at desc);

create index if not exists idx_terminal_sessions_lane_started_at on terminal_sessions(lane_id, started_at desc);

alter table terminal_sessions add column resume_command text;

alter table terminal_sessions add column resume_metadata_json text;

alter table terminal_sessions add column manually_named integer not null default 0;

alter table terminal_sessions add column archived_at text;

alter table terminal_sessions add column attention_source text;

alter table terminal_sessions add column settle_source text;

alter table terminal_sessions add column chat_session_id text;

create index if not exists idx_terminal_sessions_chat_session_id on terminal_sessions(chat_session_id);

alter table terminal_sessions add column owner_pid integer;

create index if not exists idx_terminal_sessions_owner_pid on terminal_sessions(owner_pid);

alter table terminal_sessions add column owner_process_started_at text;

create index if not exists idx_terminal_sessions_owner_process on terminal_sessions(owner_pid, owner_process_started_at);

create table if not exists runtime_processes (
      pid integer primary key,
      role text not null,
      project_root text,
      started_at text not null,
      last_seen text not null
    );

create index if not exists idx_runtime_processes_last_seen on runtime_processes(last_seen);

create table if not exists claude_sessions (
      session_id text primary key,
      lane_id text not null,
      chat_session_id text unique,
      title text,
      tags_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(lane_id) references lanes(id),
      foreign key(chat_session_id) references terminal_sessions(id) on delete set null
    );

create index if not exists idx_claude_sessions_lane_id on claude_sessions(lane_id);

create index if not exists idx_claude_sessions_updated_at on claude_sessions(updated_at desc);

create table if not exists test_suites (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      command_json text not null,
      cwd text not null,
      env_json text not null,
      timeout_ms integer,
      tags_json text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_test_suites_project_id on test_suites(project_id);

create table if not exists test_runs (
      id text primary key,
      project_id text not null,
      lane_id text,
      suite_key text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      exit_code integer,
      duration_ms integer,
      summary_json text,
      log_path text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_test_runs_project_suite on test_runs(project_id, suite_key);

create index if not exists idx_test_runs_started_at on test_runs(started_at);

create table if not exists operations (
      id text primary key,
      project_id text not null,
      lane_id text,
      kind text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      pre_head_sha text,
      post_head_sha text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_operations_project_started on operations(project_id, started_at);

create index if not exists idx_operations_lane_started on operations(lane_id, started_at);

create index if not exists idx_operations_kind on operations(kind);

create table if not exists packs_index (
      pack_key text primary key,
      project_id text not null,
      lane_id text,
      pack_type text not null,
      pack_path text not null,
      deterministic_updated_at text not null,
      narrative_updated_at text,
      last_head_sha text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_packs_index_project on packs_index(project_id);

create index if not exists idx_packs_index_lane on packs_index(lane_id);

create table if not exists session_deltas (
      session_id text primary key,
      project_id text not null,
      lane_id text not null,
      started_at text not null,
      ended_at text,
      head_sha_start text,
      head_sha_end text,
      files_changed integer not null,
      insertions integer not null,
      deletions integer not null,
      touched_files_json text not null,
      failure_lines_json text not null,
      computed_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(session_id) references terminal_sessions(id)
    );

create index if not exists idx_session_deltas_lane_started on session_deltas(lane_id, started_at);

create index if not exists idx_session_deltas_project_started on session_deltas(project_id, started_at);

create table if not exists conflict_predictions (
      id text primary key,
      project_id text not null,
      lane_a_id text not null,
      lane_b_id text,
      status text not null,
      conflicting_files_json text,
      overlap_files_json text,
      lane_a_sha text,
      lane_b_sha text,
      predicted_at text not null,
      expires_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_a_id) references lanes(id),
      foreign key(lane_b_id) references lanes(id)
    );

create index if not exists idx_cp_lane_a on conflict_predictions(lane_a_id);

create index if not exists idx_cp_lane_b on conflict_predictions(lane_b_id);

create index if not exists idx_cp_predicted_at on conflict_predictions(predicted_at);

create table if not exists conflict_proposals (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      peer_lane_id text,
      prediction_id text,
      source text not null,
      confidence real,
      explanation text,
      diff_patch text not null,
      status text not null,
      job_id text,
      artifact_id text,
      applied_operation_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(peer_lane_id) references lanes(id),
      foreign key(prediction_id) references conflict_predictions(id),
      foreign key(applied_operation_id) references operations(id)
    );

create index if not exists idx_conflict_proposals_lane on conflict_proposals(project_id, lane_id);

create index if not exists idx_conflict_proposals_status on conflict_proposals(project_id, status);

create table if not exists ai_usage_log (
      id text primary key,
      timestamp text not null,
      feature text not null,
      provider text not null,
      model text,
      input_tokens integer,
      output_tokens integer,
      duration_ms integer not null,
      success integer not null default 0,
      session_id text
    );

create index if not exists idx_ai_usage_feature_timestamp on ai_usage_log(feature, timestamp);

create index if not exists idx_ai_usage_timestamp on ai_usage_log(timestamp);

create table if not exists pull_requests (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      repo_owner text not null,
      repo_name text not null,
      github_pr_number integer not null,
      github_url text not null,
      github_node_id text,
      title text,
      state text not null,
      base_branch text not null,
      head_branch text not null,
      checks_status text,
      review_status text,
      additions integer not null default 0,
      deletions integer not null default 0,
      last_synced_at text,
      created_at text not null,
      updated_at text not null,
      merged_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_pull_requests_lane_id on pull_requests(lane_id);

create index if not exists idx_pull_requests_project_id on pull_requests(project_id);

create table if not exists pull_request_chat_sessions (
      id text primary key,
      project_id text not null,
      pr_id text not null,
      lane_id text not null,
      session_id text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade
    );

create index if not exists idx_pull_request_chat_sessions_pr on pull_request_chat_sessions(project_id, pr_id);

create index if not exists idx_pull_request_chat_sessions_session on pull_request_chat_sessions(project_id, session_id);

create index if not exists idx_pull_request_chat_sessions_lane on pull_request_chat_sessions(project_id, lane_id);

alter table pull_requests add column last_polled_at text;

alter table pull_requests add column head_sha text;

alter table pull_requests add column creation_strategy text;
alter table pull_requests add column merged_at text;
-- ADE-135: the desktop rollup replicates these through cr-sqlite, so the column
-- must exist before a changeset carrying it arrives.
alter table pull_requests add column checks_reason text;
alter table pull_requests add column checks_missing_required text;

drop table if exists github_pr_cache;

create table if not exists pr_auto_link_ignores (
      project_id text not null,
      repo_owner text not null,
      repo_name text not null,
      github_pr_number integer not null,
      lane_id text not null,
      head_branch text,
      created_at text not null,
      primary key(project_id, repo_owner, repo_name, github_pr_number, lane_id),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_pr_auto_link_ignores_project_repo on pr_auto_link_ignores(project_id, repo_owner, repo_name);

create table if not exists pull_request_ai_summaries (
      pr_id text not null,
      head_sha text not null,
      summary_json text not null,
      generated_at text not null,
      primary key(pr_id, head_sha),
      foreign key(pr_id) references pull_requests(id)
    );

create index if not exists idx_pr_ai_summaries_pr_id on pull_request_ai_summaries(pr_id);

create table if not exists pull_request_snapshots (
      pr_id text primary key,
      detail_json text,
      status_json text,
      checks_json text,
      reviews_json text,
      comments_json text,
      files_json text,
      updated_at text not null,
      foreign key(pr_id) references pull_requests(id)
    );

create index if not exists idx_pull_request_snapshots_updated_at on pull_request_snapshots(updated_at);

alter table pull_request_snapshots add column commits_json text;

create table if not exists files_workspaces (
      id text primary key,
      kind text not null,
      lane_id text,
      name text not null,
      root_path text not null,
      is_read_only_by_default integer not null default 1,
      updated_at text not null
    );

create table if not exists file_directory_snapshots (
      workspace_id text not null,
      parent_path text not null default '',
      include_hidden integer not null default 0,
      nodes_json text not null,
      updated_at text not null,
      primary key(workspace_id, parent_path, include_hidden),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    );

create table if not exists file_content_snapshots (
      workspace_id text not null,
      relative_path text not null,
      blob_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    );

create table if not exists file_diff_snapshots (
      workspace_id text not null,
      relative_path text not null,
      mode text not null,
      diff_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path, mode),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    );

create table if not exists file_history_snapshots (
      workspace_id text not null,
      relative_path text not null,
      entries_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    );

create index if not exists idx_file_directory_snapshots_workspace on file_directory_snapshots(workspace_id, updated_at desc);

create index if not exists idx_file_content_snapshots_workspace on file_content_snapshots(workspace_id, updated_at desc);

create index if not exists idx_file_diff_snapshots_workspace on file_diff_snapshots(workspace_id, updated_at desc);

create index if not exists idx_file_history_snapshots_workspace on file_history_snapshots(workspace_id, updated_at desc);

create table if not exists checkpoints (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      session_id text,
      sha text not null,
      diff_stat_json text,
      pack_event_ids_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(session_id) references terminal_sessions(id)
    );

create index if not exists idx_checkpoints_project_created on checkpoints(project_id, created_at);

create index if not exists idx_checkpoints_lane_created on checkpoints(lane_id, created_at);

create table if not exists pack_events (
      id text primary key,
      project_id text not null,
      pack_key text not null,
      event_type text not null,
      payload_json text,
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_pack_events_project_created on pack_events(project_id, created_at);

create index if not exists idx_pack_events_pack_key_created on pack_events(project_id, pack_key, created_at);

create table if not exists pack_versions (
      id text primary key,
      project_id text not null,
      pack_key text not null,
      version_number integer not null,
      content_hash text not null,
      rendered_path text not null,
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_pack_versions_project_pack on pack_versions(project_id, pack_key);

create index if not exists idx_pack_versions_project_pack_version on pack_versions(project_id, pack_key, version_number);

create table if not exists pack_heads (
      project_id text not null,
      pack_key text not null,
      current_version_id text not null,
      updated_at text not null,
      primary key(project_id, pack_key),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_pack_heads_project on pack_heads(project_id);

create table if not exists automation_runs (
      id text primary key,
      project_id text not null,
      automation_id text not null,
      trigger_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      actions_completed integer not null default 0,
      actions_total integer not null,
      error_message text,
      trigger_metadata text,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_automation_runs_project_started on automation_runs(project_id, started_at);

create index if not exists idx_automation_runs_project_automation on automation_runs(project_id, automation_id);

create table if not exists automation_action_results (
      id text primary key,
      project_id text not null,
      run_id text not null,
      action_index integer not null,
      action_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      error_message text,
      output text,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references automation_runs(id)
    );

create index if not exists idx_automation_action_results_project_run on automation_action_results(project_id, run_id);

create table if not exists pr_groups (
      id text primary key,
      project_id text not null,
      group_type text not null,
      name text,
      auto_rebase integer not null default 0,
      ci_gating integer not null default 0,
      target_branch text,
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_pr_groups_project on pr_groups(project_id);

create table if not exists pr_group_members (
      id text primary key,
      group_id text not null,
      pr_id text not null,
      lane_id text not null,
      position integer not null,
      role text not null,
      foreign key(group_id) references pr_groups(id),
      foreign key(pr_id) references pull_requests(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_pr_group_members_group on pr_group_members(group_id);

create index if not exists idx_pr_group_members_pr on pr_group_members(pr_id);

create table if not exists integration_proposals (
      id text primary key,
      project_id text not null,
      source_lane_ids_json text not null,
      base_branch text not null,
      steps_json text not null,
      title text default '',
      body text default '',
      draft integer not null default 0,
      integration_lane_name text default '',
      status text not null default 'proposed',
      integration_lane_id text,
      resolution_state_json text,
      pairwise_results_json text not null default '[]',
      lane_summaries_json text not null default '[]',
      overall_outcome text not null,
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_integration_proposals_project on integration_proposals(project_id);

alter table integration_proposals add column linked_group_id text;

alter table integration_proposals add column linked_pr_id text;

alter table integration_proposals add column workflow_display_state text not null default 'active';

alter table integration_proposals add column cleanup_state text not null default 'none';

alter table integration_proposals add column closed_at text;

alter table integration_proposals add column merged_at text;

alter table integration_proposals add column completed_at text;

alter table integration_proposals add column cleanup_declined_at text;

alter table integration_proposals add column cleanup_completed_at text;

alter table integration_proposals add column preferred_integration_lane_id text;

alter table integration_proposals add column merge_into_head_sha text;

create table if not exists rebase_dismissed (
      lane_id text not null,
      project_id text not null,
      dismissed_at text not null,
      primary key(lane_id, project_id),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_rebase_dismissed_project on rebase_dismissed(project_id);

create table if not exists rebase_deferred (
      lane_id text not null,
      project_id text not null,
      deferred_until text not null,
      primary key(lane_id, project_id),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_rebase_deferred_project on rebase_deferred(project_id);

create table if not exists computer_use_artifacts (
      id text primary key,
      project_id text not null,
      artifact_kind text not null,
      backend_style text not null,
      backend_name text not null,
      source_tool_name text,
      original_type text,
      title text not null,
      description text,
      uri text not null,
      storage_kind text not null,
      mime_type text,
      metadata_json text not null default '{}',
      lane_id text,
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_computer_use_artifacts_project_created on computer_use_artifacts(project_id, created_at);

create index if not exists idx_computer_use_artifacts_project_kind on computer_use_artifacts(project_id, artifact_kind);

alter table computer_use_artifacts add column lane_id text;

create index if not exists idx_computer_use_artifacts_lane on computer_use_artifacts(project_id, lane_id);

create table if not exists computer_use_artifact_links (
      id text primary key,
      artifact_id text not null,
      project_id text not null,
      owner_kind text not null,
      owner_id text not null,
      relation text not null default 'attached_to',
      metadata_json text,
      created_at text not null,
      foreign key(artifact_id) references computer_use_artifacts(id),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_computer_use_artifact_links_owner on computer_use_artifact_links(project_id, owner_kind, owner_id, created_at);

create index if not exists idx_computer_use_artifact_links_artifact on computer_use_artifact_links(artifact_id);

create table if not exists prompt_stashes (
      id text primary key,
      text text not null,
      attachments_json text not null default '[]',
      attachment_origin_site_id text,
      provider text,
      model_id text,
      created_at text not null
    );

alter table prompt_stashes add column attachments_json text not null default '[]';
alter table prompt_stashes add column attachment_origin_site_id text;

create index if not exists idx_prompt_stashes_created on prompt_stashes(created_at);

create table if not exists phase_cards (
      id text primary key,
      project_id text not null,
      phase_key text not null,
      name text not null,
      description text not null,
      instructions text not null,
      model_json text not null,
      budget_json text,
      ordering_constraints_json text,
      ask_questions_json text,
      validation_gate_json text,
      is_built_in integer not null default 0,
      is_custom integer not null default 0,
      position integer not null default 0,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_phase_cards_project_position on phase_cards(project_id, position);

create table if not exists phase_profiles (
      id text primary key,
      project_id text not null,
      name text not null,
      description text not null,
      phases_json text not null,
      is_built_in integer not null default 0,
      is_default integer not null default 0,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_phase_profiles_project_updated on phase_profiles(project_id, updated_at);

create index if not exists idx_phase_profiles_project_default on phase_profiles(project_id, is_default);

create table if not exists attempt_transcripts (
      id text primary key,
      project_id text not null,
      attempt_id text not null,
      run_id text not null,
      step_id text not null,
      messages_json text not null,
      token_count integer default 0,
      compacted_at text,
      compaction_summary text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_attempt_transcripts_attempt on attempt_transcripts(attempt_id);

create index if not exists idx_attempt_transcripts_run on attempt_transcripts(run_id);

create table if not exists devices (
      device_id text primary key,
      site_id text not null,
      name text not null,
      platform text not null,
      device_type text not null,
      created_at text not null,
      updated_at text not null,
      last_seen_at text,
      last_host text,
      last_port integer,
      tailscale_ip text,
      ip_addresses_json text not null default '[]',
      metadata_json text not null default '{}'
    );

create index if not exists idx_devices_site_id on devices(site_id);

create index if not exists idx_devices_last_seen_at on devices(last_seen_at);

create table if not exists sync_cluster_state (
      cluster_id text primary key,
      brain_device_id text not null,
      brain_epoch integer not null default 1,
      updated_at text not null,
      updated_by_device_id text not null
    );

create table if not exists worker_agents (
      id text primary key,
      project_id text not null,
      slug text not null,
      name text not null,
      role text not null default 'generalist',
      title text,
      reports_to text,
      capabilities_json text not null default '[]',
      status text not null default 'idle',
      adapter_type text not null default 'claude-local',
      adapter_config_json text not null default '{}',
      runtime_config_json text not null default '{}',
      linear_identity_json text not null default '{}',
      budget_monthly_cents integer not null default 0,
      spent_monthly_cents integer not null default 0,
      last_heartbeat_at text,
      created_at text not null,
      updated_at text not null,
      deleted_at text
    );

alter table worker_agents add column linear_identity_json text not null default '{}';

create index if not exists idx_worker_agents_project on worker_agents(project_id);

create index if not exists idx_worker_agents_project_active on worker_agents(project_id, deleted_at);

create table if not exists linear_ingress_state (
      project_id text primary key,
      local_webhook_json text not null default '{}',
      relay_json text not null default '{}',
      reconciliation_json text not null default '{}',
      updated_at text not null
    );

create table if not exists linear_ingress_events (
      id text primary key,
      project_id text not null,
      source text not null,
      delivery_id text not null,
      event_id text not null,
      entity_type text not null,
      action text,
      issue_id text,
      issue_identifier text,
      summary text not null,
      payload_json text,
      created_at text not null
    );

create index if not exists idx_linear_ingress_events_project_created on linear_ingress_events(project_id, created_at desc);

create index if not exists idx_linear_ingress_events_project_event on linear_ingress_events(project_id, event_id);

create table if not exists worker_agent_revisions (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      before_json text not null,
      after_json text not null,
      changed_keys_json text not null default '[]',
      had_redactions integer not null default 0,
      actor text not null default 'user',
      created_at text not null
    );

create index if not exists idx_worker_agent_revisions_agent on worker_agent_revisions(project_id, agent_id);

create table if not exists worker_agent_task_sessions (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      adapter_type text not null,
      task_key text not null,
      payload_json text not null default '{}',
      cleared_at text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_worker_agent_task_sessions_lookup on worker_agent_task_sessions(project_id, agent_id, adapter_type, task_key);

create table if not exists worker_agent_runs (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      status text not null default 'pending',
      wakeup_reason text not null default 'timer',
      task_key text,
      issue_key text,
      execution_run_id text,
      execution_locked_at text,
      context_json text not null default '{}',
      result_json text,
      error_message text,
      started_at text,
      finished_at text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_worker_agent_runs_agent on worker_agent_runs(project_id, agent_id);

create index if not exists idx_worker_agent_runs_status on worker_agent_runs(project_id, status);

create table if not exists worker_agent_cost_events (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      run_id text,
      session_id text,
      provider text not null,
      model_id text,
      input_tokens integer,
      output_tokens integer,
      cost_cents integer not null default 0,
      estimated integer not null default 0,
      source text not null default 'manual',
      occurred_at text not null,
      created_at text not null
    );

create index if not exists idx_worker_agent_cost_events_agent on worker_agent_cost_events(project_id, agent_id);

create index if not exists idx_worker_agent_cost_events_month on worker_agent_cost_events(project_id, agent_id, occurred_at);

create table if not exists linear_sync_state (
      project_id text primary key,
      enabled integer not null default 0,
      running integer not null default 0,
      last_poll_at text,
      last_success_at text,
      last_error text,
      health_json text not null default '{}',
      updated_at text not null
    );

create index if not exists idx_linear_sync_state_updated on linear_sync_state(updated_at);

create table if not exists linear_issue_snapshots (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      state_type text not null,
      assignee_id text,
      updated_at_linear text not null,
      payload_json text not null,
      hash text not null,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_linear_issue_snapshots_project_updated_linear on linear_issue_snapshots(project_id, updated_at_linear);

create table if not exists linear_dispatch_queue (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      title text not null,
      status text not null,
      action text not null,
      worker_id text,
      worker_slug text,
      route_json text not null default '{}',
      attempt_count integer not null default 0,
      next_attempt_at text,
      last_error text,
      note text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_linear_dispatch_queue_lookup on linear_dispatch_queue(project_id, status, next_attempt_at, created_at);

create index if not exists idx_linear_dispatch_queue_issue on linear_dispatch_queue(project_id, issue_id, status);

create table if not exists linear_issue_claims (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      queue_item_id text,
      worker_id text,
      worker_slug text,
      linear_assignee_id text,
      status text not null default 'active',
      claimed_at text not null,
      released_at text,
      updated_at text not null
    );

drop index if exists idx_linear_issue_claims_unique;

create index if not exists idx_linear_issue_claims_active_unique on linear_issue_claims(project_id, issue_id) where status = 'active';

create index if not exists idx_linear_issue_claims_lookup on linear_issue_claims(project_id, issue_id, status);

create table if not exists linear_workpads (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      comment_id text not null,
      last_body_hash text,
      last_body text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_linear_workpads_project_issue on linear_workpads(project_id, issue_id);

create table if not exists linear_sync_events (
      id text primary key,
      project_id text not null,
      issue_id text,
      queue_item_id text,
      event_type text not null,
      status text,
      message text,
      payload_json text,
      created_at text not null
    );

create index if not exists idx_linear_sync_events_project_created on linear_sync_events(project_id, created_at);

create index if not exists idx_linear_sync_events_issue_created on linear_sync_events(project_id, issue_id, created_at);

create table if not exists linear_workflow_runs (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      title text not null,
      workflow_id text not null,
      workflow_name text not null,
      workflow_version text not null,
      source text not null default 'repo',
      target_type text not null,
      status text not null,
      current_step_index integer not null default 0,
      current_step_id text,
      execution_lane_id text,
      linked_session_id text,
      linked_worker_run_id text,
      linked_pr_id text,
      review_state text,
      supervisor_identity_key text,
      review_ready_reason text,
      pr_state text,
      pr_checks_status text,
      pr_review_status text,
      latest_review_note text,
      retry_count integer not null default 0,
      retry_after text,
      closeout_state text not null default 'pending',
      terminal_outcome text,
      last_error text,
      route_context_json text,
      execution_context_json text,
      source_issue_snapshot_json text not null default '{}',
      created_at text not null,
      updated_at text not null
    );

alter table linear_workflow_runs add column execution_lane_id text;

alter table linear_workflow_runs add column supervisor_identity_key text;

alter table linear_workflow_runs add column review_ready_reason text;

alter table linear_workflow_runs add column pr_state text;

alter table linear_workflow_runs add column pr_checks_status text;

alter table linear_workflow_runs add column pr_review_status text;

alter table linear_workflow_runs add column latest_review_note text;

alter table linear_workflow_runs add column route_context_json text;

alter table linear_workflow_runs add column execution_context_json text;

create index if not exists idx_linear_workflow_runs_project_status on linear_workflow_runs(project_id, status, updated_at);

create index if not exists idx_linear_workflow_runs_issue on linear_workflow_runs(project_id, issue_id, updated_at);

create table if not exists linear_workflow_run_steps (
      id text primary key,
      project_id text not null,
      run_id text not null,
      workflow_step_id text not null,
      type text not null,
      status text not null,
      started_at text,
      completed_at text,
      payload_json text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_linear_workflow_run_steps_run on linear_workflow_run_steps(project_id, run_id, created_at);

create table if not exists linear_workflow_run_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      event_type text not null,
      status text,
      message text,
      payload_json text,
      created_at text not null
    );

create index if not exists idx_linear_workflow_run_events_run on linear_workflow_run_events(project_id, run_id, created_at);

create table if not exists cto_flow_policies (
      project_id text primary key,
      policy_json text not null,
      active_revision_id text,
      updated_at text not null,
      updated_by text not null
    );

create index if not exists idx_cto_flow_policies_updated on cto_flow_policies(updated_at);

create table if not exists cto_flow_policy_revisions (
      id text primary key,
      project_id text not null,
      actor text not null,
      policy_json text not null,
      diff_json text,
      created_at text not null
    );

create index if not exists idx_cto_flow_policy_revisions_project_created on cto_flow_policy_revisions(project_id, created_at);

create table if not exists budget_usage_records (
      id text primary key,
      scope text not null,
      scope_id text not null,
      provider text not null,
      tokens_used integer not null default 0,
      cost_usd real not null default 0,
      week_key text not null,
      recorded_at text not null
    );

create index if not exists idx_budget_usage_records_scope_week on budget_usage_records(scope, scope_id, week_key);

create index if not exists idx_budget_usage_records_week on budget_usage_records(week_key);

create index if not exists idx_budget_usage_records_provider_week on budget_usage_records(provider, week_key);

create table if not exists lane_worktree_locks (
      worktree_key text not null unique,
      worktree_path text not null,
      lane_id text not null,
      owner_kind text not null,
      owner_pr_id text,
      owner_session_id text,
      owner_proposal_id text,
      owner_label text not null,
      token text not null,
      created_at text not null,
      heartbeat_at text not null,
      expires_at text not null
    );

delete from lane_worktree_locks where worktree_key is null or trim(worktree_key) = '';

delete from lane_worktree_locks
      where rowid not in (
        select max(rowid)
        from lane_worktree_locks
        group by worktree_key
      );

create unique index if not exists idx_lane_worktree_locks_worktree_key_unique on lane_worktree_locks(worktree_key);

create index if not exists idx_lane_worktree_locks_lane on lane_worktree_locks(lane_id);

create index if not exists idx_lane_worktree_locks_session on lane_worktree_locks(owner_session_id);

create index if not exists idx_lane_worktree_locks_expires on lane_worktree_locks(expires_at);

-- Model-picker favorites + recents. Per-project (the DB instance is the scope,
-- so no project_id column) and CRR-replicated so desktop, TUI, and iOS converge
-- on the same set for a project. PK-only by design: CRR-converted tables cannot
-- carry any UNIQUE index besides the primary key, so model_id is the only
-- uniqueness constraint and the recents cap is enforced in app code.
-- ensureCrrTables auto-discovers these (PK present, not excluded) and runs
-- crsql_as_crr on each, mirroring desktop's kvDb.ts.
create table if not exists model_picker_favorites (
  model_id text primary key,
  created_at text not null
);

create table if not exists model_picker_recents (
  model_id text primary key,
  used_at text not null
);

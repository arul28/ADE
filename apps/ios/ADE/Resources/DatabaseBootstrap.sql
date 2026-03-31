create virtual table if not exists unified_memories_fts using fts4(
        content,
        content='unified_memories'
      );

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
      mission_id text,
      lane_role text,
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(parent_lane_id) references lanes(id),
      foreign key(mission_id) references missions(id) on delete set null
    );

alter table lanes add column mission_id text;

alter table lanes add column lane_role text;

create index if not exists idx_lanes_project_id on lanes(project_id);

create index if not exists idx_lanes_project_type on lanes(project_id, lane_type);

create index if not exists idx_lanes_project_parent on lanes(project_id, parent_lane_id);

create index if not exists idx_lanes_project_mission on lanes(project_id, mission_id);

create index if not exists idx_lanes_project_role on lanes(project_id, lane_role);

create table if not exists lane_state_snapshots (
      lane_id text primary key,
      dirty integer not null default 0,
      ahead integer not null default 0,
      behind integer not null default 0,
      remote_behind integer not null default -1,
      rebase_in_progress integer not null default 0,
      agent_summary_json text,
      mission_summary_json text,
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
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id);

create index if not exists idx_terminal_sessions_status on terminal_sessions(status);

create index if not exists idx_terminal_sessions_started_at on terminal_sessions(started_at desc);

create index if not exists idx_terminal_sessions_lane_started_at on terminal_sessions(lane_id, started_at desc);

create table if not exists process_definitions (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      command_json text not null,
      cwd text not null,
      env_json text not null,
      autostart integer not null,
      restart_policy text not null,
      graceful_shutdown_ms integer not null,
      depends_on_json text not null,
      readiness_json text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_process_definitions_project_id on process_definitions(project_id);

create table if not exists process_runtime (
      project_id text not null,
      lane_id text not null,
      process_key text not null,
      status text not null,
      pid integer,
      started_at text,
      ended_at text,
      exit_code integer,
      readiness text not null,
      updated_at text not null,
      primary key(project_id, lane_id, process_key),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_process_runtime_project_id on process_runtime(project_id);

create index if not exists idx_process_runtime_project_lane on process_runtime(project_id, lane_id);

create table if not exists process_runs (
      id text primary key,
      project_id text not null,
      lane_id text,
      process_key text not null,
      started_at text not null,
      ended_at text,
      exit_code integer,
      termination_reason text not null,
      log_path text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_process_runs_project_proc on process_runs(project_id, process_key);

create index if not exists idx_process_runs_project_lane on process_runs(project_id, lane_id);

create index if not exists idx_process_runs_started_at on process_runs(started_at);

create table if not exists stack_buttons (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      process_keys_json text not null,
      start_order text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_stack_buttons_project_id on stack_buttons(project_id);

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
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_pull_requests_lane_id on pull_requests(lane_id);

create index if not exists idx_pull_requests_project_id on pull_requests(project_id);

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

create table if not exists queue_landing_state (
      id text primary key,
      group_id text not null,
      project_id text not null,
      state text not null,
      entries_json text not null,
      config_json text not null default '{}',
      current_position integer not null default 0,
      active_pr_id text,
      active_resolver_run_id text,
      last_error text,
      wait_reason text,
      started_at text not null,
      completed_at text,
      updated_at text,
      foreign key(group_id) references pr_groups(id),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_queue_landing_state_group on queue_landing_state(group_id);

alter table queue_landing_state add column config_json text not null default '{}';

alter table queue_landing_state add column active_pr_id text;

alter table queue_landing_state add column active_resolver_run_id text;

alter table queue_landing_state add column last_error text;

alter table queue_landing_state add column wait_reason text;

alter table queue_landing_state add column updated_at text;

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

create table if not exists missions (
      id text primary key,
      project_id text not null,
      lane_id text,
      mission_lane_id text,
      result_lane_id text,
      title text not null,
      prompt text not null,
      status text not null,
      priority text not null default 'normal',
      execution_mode text not null default 'local',
      target_machine_id text,
      queue_claim_token text,
      queue_claimed_at text,
      outcome_summary text,
      last_error text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(mission_lane_id) references lanes(id) on delete set null,
      foreign key(result_lane_id) references lanes(id) on delete set null
    );

alter table missions add column mission_lane_id text;

alter table missions add column result_lane_id text;

alter table missions add column queue_claim_token text;

alter table missions add column queue_claimed_at text;

alter table missions add column archived_at text;

create index if not exists idx_missions_project_updated on missions(project_id, updated_at);

create index if not exists idx_missions_project_status on missions(project_id, status);

create index if not exists idx_missions_project_lane on missions(project_id, lane_id);

create index if not exists idx_missions_project_mission_lane on missions(project_id, mission_lane_id);

create index if not exists idx_missions_project_result_lane on missions(project_id, result_lane_id);

drop index if exists idx_missions_queue_claim_token;

create index if not exists idx_missions_project_queue_claim on missions(project_id, queue_claim_token);

create table if not exists mission_steps (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      step_index integer not null,
      title text not null,
      detail text,
      kind text not null default 'manual',
      lane_id text,
      status text not null,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_mission_steps_mission_index on mission_steps(mission_id, step_index);

create index if not exists idx_mission_steps_project_status on mission_steps(project_id, status);

create table if not exists mission_events (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      event_type text not null,
      actor text not null,
      summary text not null,
      payload_json text,
      created_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_mission_events_mission_created on mission_events(mission_id, created_at);

create index if not exists idx_mission_events_project_created on mission_events(project_id, created_at);

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
      created_at text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_computer_use_artifacts_project_created on computer_use_artifacts(project_id, created_at);

create index if not exists idx_computer_use_artifacts_project_kind on computer_use_artifacts(project_id, artifact_kind);

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

create table if not exists mission_artifacts (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      artifact_type text not null,
      title text not null,
      description text,
      uri text,
      lane_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      created_by text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_mission_artifacts_mission_created on mission_artifacts(mission_id, created_at);

create table if not exists mission_interventions (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      intervention_type text not null,
      status text not null,
      resolution_kind text,
      title text not null,
      body text not null,
      requested_action text,
      resolution_note text,
      lane_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      resolved_at text,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    );

alter table mission_interventions add column resolution_kind text;

create index if not exists idx_mission_interventions_mission_status on mission_interventions(mission_id, status);

create index if not exists idx_mission_interventions_project_status on mission_interventions(project_id, status);

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

create table if not exists mission_phase_overrides (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      profile_id text,
      phases_json text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(profile_id) references phase_profiles(id)
    );

create index if not exists idx_mission_phase_overrides_project_mission on mission_phase_overrides(project_id, mission_id);

create index if not exists idx_mission_phase_overrides_profile on mission_phase_overrides(profile_id);

create table if not exists orchestrator_runs (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      status text not null,
      context_profile text not null default 'orchestrator_deterministic_v1',
      scheduler_state text not null,
      runtime_cursor_json text,
      last_error text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade
    );

create index if not exists idx_orchestrator_runs_project_status on orchestrator_runs(project_id, status);

create index if not exists idx_orchestrator_runs_mission on orchestrator_runs(mission_id);

create index if not exists idx_orchestrator_runs_project_updated on orchestrator_runs(project_id, updated_at);

create table if not exists orchestrator_steps (
      id text primary key,
      run_id text not null,
      project_id text not null,
      mission_step_id text,
      step_key text not null,
      step_index integer not null,
      title text not null,
      lane_id text,
      status text not null,
      join_policy text not null default 'all_success',
      quorum_count integer,
      dependency_step_ids_json text not null default '[]',
      retry_limit integer not null default 0,
      retry_count integer not null default 0,
      last_attempt_id text,
      policy_json text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(project_id) references projects(id),
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_orchestrator_steps_run_status on orchestrator_steps(run_id, status);

create index if not exists idx_orchestrator_steps_project_status on orchestrator_steps(project_id, status);

create index if not exists idx_orchestrator_steps_run_order on orchestrator_steps(run_id, step_index);

create table if not exists orchestrator_attempts (
      id text primary key,
      run_id text not null,
      step_id text not null,
      project_id text not null,
      attempt_number integer not null,
      status text not null,
      executor_kind text not null,
      executor_session_id text,
      tracked_session_enforced integer not null default 1,
      context_profile text not null default 'orchestrator_deterministic_v1',
      context_snapshot_id text,
      error_class text not null default 'none',
      error_message text,
      retry_backoff_ms integer not null default 0,
      result_envelope_json text,
      metadata_json text,
      created_at text not null,
      started_at text,
      completed_at text,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(project_id) references projects(id),
      foreign key(context_snapshot_id) references orchestrator_context_snapshots(id)
    );

create index if not exists idx_orchestrator_attempts_run_status on orchestrator_attempts(run_id, status);

create index if not exists idx_orchestrator_attempts_step_status on orchestrator_attempts(step_id, status);

create index if not exists idx_orchestrator_attempts_project_created on orchestrator_attempts(project_id, created_at);

create table if not exists orchestrator_attempt_runtime (
      attempt_id text primary key,
      session_id text,
      runtime_state text,
      last_signal_at text,
      last_output_preview text,
      last_preview_digest text,
      digest_since_ms integer not null default 0,
      repeat_count integer not null default 0,
      last_waiting_intervention_at_ms integer not null default 0,
      last_event_heartbeat_at_ms integer not null default 0,
      last_waiting_notified_at_ms integer not null default 0,
      updated_at text not null,
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_attempt_runtime_session on orchestrator_attempt_runtime(session_id);

create index if not exists idx_orchestrator_attempt_runtime_updated on orchestrator_attempt_runtime(updated_at);

create table if not exists orchestrator_runtime_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      session_id text,
      event_type text not null,
      event_key text not null,
      occurred_at text not null,
      payload_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_runtime_events_run_occurred on orchestrator_runtime_events(run_id, occurred_at);

create index if not exists idx_orchestrator_runtime_events_attempt_occurred on orchestrator_runtime_events(attempt_id, occurred_at);

create index if not exists idx_orchestrator_runtime_events_session_occurred on orchestrator_runtime_events(session_id, occurred_at);

create index if not exists idx_orchestrator_runtime_events_project_key on orchestrator_runtime_events(project_id, event_key);

create table if not exists orchestrator_claims (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      owner_id text not null,
      scope_kind text not null,
      scope_value text not null,
      state text not null,
      acquired_at text not null,
      heartbeat_at text not null,
      expires_at text not null,
      released_at text,
      policy_json text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_claims_run_state on orchestrator_claims(run_id, state);

create index if not exists idx_orchestrator_claims_scope_state on orchestrator_claims(project_id, scope_kind, scope_value, state);

create index if not exists idx_orchestrator_claims_expires on orchestrator_claims(state, expires_at);

create index if not exists idx_orchestrator_claims_active_scope on orchestrator_claims(project_id, scope_kind, scope_value) where state = 'active';

create table if not exists orchestrator_context_snapshots (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      snapshot_type text not null,
      context_profile text not null default 'orchestrator_deterministic_v1',
      cursor_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_context_snapshots_run_created on orchestrator_context_snapshots(run_id, created_at);

create index if not exists idx_orchestrator_context_snapshots_attempt on orchestrator_context_snapshots(attempt_id);

create table if not exists mission_step_handoffs (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      mission_step_id text,
      run_id text,
      step_id text,
      attempt_id text,
      handoff_type text not null,
      producer text not null,
      payload_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_mission_step_handoffs_mission_created on mission_step_handoffs(mission_id, created_at);

create index if not exists idx_mission_step_handoffs_step_created on mission_step_handoffs(mission_step_id, created_at);

create index if not exists idx_mission_step_handoffs_attempt on mission_step_handoffs(attempt_id);

create table if not exists orchestrator_timeline_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      claim_id text,
      event_type text not null,
      reason text not null,
      detail_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(claim_id) references orchestrator_claims(id)
    );

create index if not exists idx_orchestrator_timeline_run_created on orchestrator_timeline_events(run_id, created_at);

create index if not exists idx_orchestrator_timeline_attempt on orchestrator_timeline_events(attempt_id);

create index if not exists idx_orchestrator_timeline_project_created on orchestrator_timeline_events(project_id, created_at);

create table if not exists orchestrator_gate_reports (
      id text primary key,
      project_id text not null,
      generated_at text not null,
      report_json text not null,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_orchestrator_gate_reports_project_generated on orchestrator_gate_reports(project_id, generated_at);

create table if not exists orchestrator_chat_threads (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_type text not null,
      title text not null,
      run_id text,
      step_id text,
      step_key text,
      attempt_id text,
      session_id text,
      lane_id text,
      status text not null default 'active',
      unread_count integer not null default 0,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_orchestrator_chat_threads_mission_updated on orchestrator_chat_threads(mission_id, updated_at);

create index if not exists idx_orchestrator_chat_threads_project_mission on orchestrator_chat_threads(project_id, mission_id);

create index if not exists idx_orchestrator_chat_threads_mission_type on orchestrator_chat_threads(mission_id, thread_type);

create index if not exists idx_orchestrator_chat_threads_lane on orchestrator_chat_threads(lane_id);

create table if not exists orchestrator_chat_messages (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_id text not null,
      role text not null,
      content text not null,
      timestamp text not null,
      step_key text,
      target_json text,
      visibility text not null default 'full',
      delivery_state text not null default 'delivered',
      source_session_id text,
      attempt_id text,
      lane_id text,
      run_id text,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(thread_id) references orchestrator_chat_threads(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id),
      foreign key(run_id) references orchestrator_runs(id)
    );

create index if not exists idx_orchestrator_chat_messages_thread_ts on orchestrator_chat_messages(thread_id, timestamp);

create index if not exists idx_orchestrator_chat_messages_mission_ts on orchestrator_chat_messages(mission_id, timestamp);

create index if not exists idx_orchestrator_chat_messages_attempt_ts on orchestrator_chat_messages(attempt_id, timestamp);

create index if not exists idx_orchestrator_chat_messages_lane_ts on orchestrator_chat_messages(lane_id, timestamp);

create index if not exists idx_orchestrator_chat_messages_delivery_queue on orchestrator_chat_messages(delivery_state, role, mission_id, thread_id, timestamp);

create table if not exists orchestrator_worker_digests (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      step_key text,
      attempt_id text not null,
      lane_id text,
      session_id text,
      status text not null,
      summary text not null,
      files_changed_json text not null,
      tests_run_json text not null,
      warnings_json text not null,
      tokens_json text,
      cost_usd real,
      suggested_next_actions_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_orchestrator_worker_digests_mission_created on orchestrator_worker_digests(mission_id, created_at);

create index if not exists idx_orchestrator_worker_digests_run_created on orchestrator_worker_digests(run_id, created_at);

create index if not exists idx_orchestrator_worker_digests_attempt on orchestrator_worker_digests(attempt_id);

create index if not exists idx_orchestrator_worker_digests_lane_created on orchestrator_worker_digests(lane_id, created_at);

create table if not exists orchestrator_artifacts (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      attempt_id text not null,
      artifact_key text not null,
      kind text not null,
      value text not null,
      metadata_json text not null default '{}',
      declared integer not null default 0,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_artifacts_mission_created on orchestrator_artifacts(mission_id, created_at);

create index if not exists idx_orchestrator_artifacts_step on orchestrator_artifacts(step_id);

create index if not exists idx_orchestrator_artifacts_mission_key on orchestrator_artifacts(mission_id, artifact_key);

create table if not exists orchestrator_context_checkpoints (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      trigger text not null,
      summary text not null,
      source_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id)
    );

create index if not exists idx_orchestrator_context_checkpoints_mission_created on orchestrator_context_checkpoints(mission_id, created_at);

create index if not exists idx_orchestrator_context_checkpoints_run_created on orchestrator_context_checkpoints(run_id, created_at);

create table if not exists orchestrator_worker_checkpoints (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      attempt_id text not null,
      step_key text not null,
      content text not null,
      file_path text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_worker_checkpoints_mission_step_key on orchestrator_worker_checkpoints(mission_id, step_key);

create index if not exists idx_orchestrator_worker_checkpoints_run on orchestrator_worker_checkpoints(run_id);

create index if not exists idx_orchestrator_worker_checkpoints_mission on orchestrator_worker_checkpoints(mission_id, updated_at);

create table if not exists orchestrator_lane_decisions (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      step_id text,
      step_key text,
      lane_id text,
      decision_type text not null,
      validator_outcome text not null,
      rule_hits_json text not null,
      rationale text not null,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(lane_id) references lanes(id)
    );

create index if not exists idx_orchestrator_lane_decisions_mission_created on orchestrator_lane_decisions(mission_id, created_at);

create index if not exists idx_orchestrator_lane_decisions_run_created on orchestrator_lane_decisions(run_id, created_at);

create index if not exists idx_orchestrator_lane_decisions_step_created on orchestrator_lane_decisions(step_id, created_at);

create index if not exists idx_orchestrator_lane_decisions_lane_created on orchestrator_lane_decisions(lane_id, created_at);

create table if not exists orchestrator_ai_decisions (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      step_id text,
      attempt_id text,
      call_type text not null,
      provider text,
      model text,
      timeout_cap_ms integer,
      decision_json text not null,
      action_trace_json text,
      validation_json text,
      rationale text,
      fallback_used integer not null default 0,
      failure_reason text,
      duration_ms integer,
      prompt_tokens integer,
      completion_tokens integer,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_ai_decisions_mission_created on orchestrator_ai_decisions(mission_id, created_at);

create index if not exists idx_orchestrator_ai_decisions_run_created on orchestrator_ai_decisions(run_id, created_at);

create index if not exists idx_orchestrator_ai_decisions_step_created on orchestrator_ai_decisions(step_id, created_at);

create index if not exists idx_orchestrator_ai_decisions_project_category_created on orchestrator_ai_decisions(project_id, call_type, created_at);

create index if not exists idx_orchestrator_ai_decisions_created on orchestrator_ai_decisions(created_at);

create table if not exists mission_metrics_config (
      mission_id text primary key,
      project_id text not null,
      toggles_json text not null,
      updated_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_mission_metrics_config_project_updated on mission_metrics_config(project_id, updated_at);

create table if not exists orchestrator_metrics_samples (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      attempt_id text,
      metric text not null,
      value real not null,
      unit text,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    );

create index if not exists idx_orchestrator_metrics_samples_mission_created on orchestrator_metrics_samples(mission_id, created_at);

create index if not exists idx_orchestrator_metrics_samples_run_created on orchestrator_metrics_samples(run_id, created_at);

create index if not exists idx_orchestrator_metrics_samples_metric_created on orchestrator_metrics_samples(metric, created_at);

create table if not exists memories (
      id text primary key,
      project_id text not null,
      scope text not null,
      category text not null,
      content text not null,
      importance text default 'medium',
      source_session_id text,
      source_pack_key text,
      status text default 'promoted',
      agent_id text,
      confidence real default 1.0,
      promoted_at text,
      source_run_id text,
      created_at text not null,
      last_accessed_at text not null,
      access_count integer default 0
    );

create index if not exists idx_memories_project_scope on memories(project_id, scope);

create index if not exists idx_memories_project_importance on memories(project_id, importance);

create index if not exists idx_memories_last_accessed on memories(last_accessed_at);

create index if not exists idx_memories_status on memories(project_id, status);

create index if not exists idx_memories_agent on memories(agent_id);

create table if not exists unified_memories (
      id text primary key,
      project_id text not null,
      scope text not null,
      scope_owner_id text,
      tier integer not null default 2,
      category text not null,
      content text not null,
      importance text not null default 'medium',
      confidence real not null default 1.0,
      observation_count integer not null default 1,
      status text not null default 'promoted',
      source_type text not null default 'agent',
      source_id text,
      source_session_id text,
      source_pack_key text,
      source_run_id text,
      file_scope_pattern text,
      agent_id text,
      pinned integer not null default 0,
      access_score real not null default 0,
      composite_score real not null default 0,
      write_gate_reason text,
      dedupe_key text not null default '',
      created_at text not null,
      updated_at text not null,
      last_accessed_at text not null,
      access_count integer not null default 0,
      promoted_at text,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_unified_memories_project_scope_tier on unified_memories(project_id, scope, tier);

create index if not exists idx_unified_memories_scope_owner on unified_memories(project_id, scope, scope_owner_id);

create index if not exists idx_unified_memories_project_status on unified_memories(project_id, status);

create index if not exists idx_unified_memories_project_pinned on unified_memories(project_id, pinned, tier);

create index if not exists idx_unified_memories_project_accessed on unified_memories(project_id, last_accessed_at);

create index if not exists idx_unified_memories_project_dedupe on unified_memories(project_id, scope, scope_owner_id, dedupe_key);

alter table unified_memories add column access_score real not null default 0;

update unified_memories
    set access_score = case
      when coalesce(access_score, 0) > 0 then access_score
      when coalesce(composite_score, 0) > 0 then composite_score
      else min(1.0, max(0.0, coalesce(access_count, 0) / 10.0))
    end;

create trigger if not exists unified_memories_fts_ai after insert on unified_memories begin
      insert into unified_memories_fts(rowid, content)
      values (new.rowid, new.content);
    end;

create trigger if not exists unified_memories_fts_bd before delete on unified_memories begin
      delete from unified_memories_fts
      where rowid = old.rowid;
    end;

create trigger if not exists unified_memories_fts_bu before update on unified_memories begin
      delete from unified_memories_fts
      where rowid = old.rowid;
    end;

create trigger if not exists unified_memories_fts_au after update on unified_memories begin
      insert into unified_memories_fts(rowid, content)
      values (new.rowid, new.content);
    end;

create table if not exists unified_memory_embeddings (
      id text primary key,
      memory_id text not null,
      project_id text not null,
      embedding_model text not null,
      embedding_blob blob not null,
      dimensions integer not null,
      norm real,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id),
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_unified_memory_embeddings_project on unified_memory_embeddings(project_id);

create index if not exists idx_unified_memory_embeddings_memory on unified_memory_embeddings(memory_id);

create table if not exists memory_procedure_details (
      memory_id text primary key,
      trigger text not null,
      procedure_markdown text not null,
      success_count integer not null default 0,
      failure_count integer not null default 0,
      last_used_at text,
      exported_skill_path text,
      exported_at text,
      superseded_by_memory_id text,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id),
      foreign key(superseded_by_memory_id) references unified_memories(id)
    );

create index if not exists idx_memory_procedure_details_updated on memory_procedure_details(updated_at desc);

create index if not exists idx_memory_procedure_details_exported on memory_procedure_details(exported_at desc);

create table if not exists memory_procedure_sources (
      procedure_memory_id text not null,
      episode_memory_id text not null,
      created_at text not null,
      primary key (procedure_memory_id, episode_memory_id),
      foreign key(procedure_memory_id) references unified_memories(id),
      foreign key(episode_memory_id) references unified_memories(id)
    );

create index if not exists idx_memory_procedure_sources_episode on memory_procedure_sources(episode_memory_id);

create table if not exists memory_procedure_history (
      id text primary key,
      procedure_memory_id text not null,
      confidence real not null,
      outcome text not null,
      reason text,
      recorded_at text not null,
      foreign key(procedure_memory_id) references unified_memories(id)
    );

create index if not exists idx_memory_procedure_history_procedure on memory_procedure_history(procedure_memory_id, recorded_at desc);

create table if not exists memory_skill_index (
      id text primary key,
      path text not null,
      kind text not null,
      source text not null,
      memory_id text,
      content_hash text not null,
      last_modified_at text,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id)
    );

create index if not exists idx_memory_skill_index_memory on memory_skill_index(memory_id);

create index if not exists idx_memory_skill_index_archived on memory_skill_index(archived_at);

create table if not exists memory_capture_ledger (
      id text primary key,
      project_id text not null,
      source_type text not null,
      source_key text not null,
      memory_id text,
      episode_memory_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(memory_id) references unified_memories(id),
      foreign key(episode_memory_id) references unified_memories(id)
    );

create index if not exists idx_memory_capture_ledger_source on memory_capture_ledger(project_id, source_type, updated_at desc);

create index if not exists idx_memory_capture_ledger_memory on memory_capture_ledger(memory_id);

create table if not exists memory_sweep_log (
      sweep_id text primary key,
      project_id text not null,
      trigger_reason text not null,
      started_at text not null,
      completed_at text not null,
      entries_decayed integer not null default 0,
      entries_demoted integer not null default 0,
      entries_promoted integer not null default 0,
      entries_archived integer not null default 0,
      entries_orphaned integer not null default 0,
      duration_ms integer not null default 0,
      foreign key(project_id) references projects(id)
    );

create index if not exists idx_memory_sweep_log_project_completed on memory_sweep_log(project_id, completed_at desc);

create table if not exists memory_consolidation_log (
      consolidation_id text primary key,
      project_id text not null,
      trigger_reason text not null,
      started_at text not null,
      completed_at text not null,
      clusters_found integer not null default 0,
      entries_merged integer not null default 0,
      entries_created integer not null default 0,
      tokens_used integer not null default 0,
      duration_ms integer not null default 0
    );

create index if not exists idx_memory_consolidation_log_project_completed on memory_consolidation_log(project_id, completed_at desc);

insert or ignore into unified_memories (
      id,
      project_id,
      scope,
      scope_owner_id,
      tier,
      category,
      content,
      importance,
      confidence,
      observation_count,
      status,
      source_type,
      source_id,
      source_session_id,
      source_pack_key,
      source_run_id,
      file_scope_pattern,
      agent_id,
      pinned,
      access_score,
      composite_score,
      write_gate_reason,
      dedupe_key,
      created_at,
      updated_at,
      last_accessed_at,
      access_count,
      promoted_at
    )
    select
      id,
      project_id,
      case scope
        when 'project' then 'project'
        when 'mission' then 'mission'
        when 'user' then 'agent'
        when 'lane' then 'mission'
        else 'project'
      end as scope,
      case scope
        when 'mission' then coalesce(source_run_id, agent_id, source_session_id)
        when 'user' then coalesce(agent_id, source_session_id)
        when 'lane' then coalesce(agent_id, source_session_id)
        else null
      end as scope_owner_id,
      case
        when status = 'archived' then 3
        when status = 'candidate' then 3
        else 2
      end as tier,
      category,
      content,
      coalesce(importance, 'medium') as importance,
      coalesce(confidence, 1.0) as confidence,
      case
        when coalesce(access_count, 0) > 0 then access_count
        else 1
      end as observation_count,
      coalesce(status, 'promoted') as status,
      'system' as source_type,
      coalesce(source_run_id, source_session_id, source_pack_key, agent_id) as source_id,
      source_session_id,
      source_pack_key,
      source_run_id,
      null as file_scope_pattern,
      agent_id,
      0 as pinned,
      min(1.0, max(0.0, coalesce(access_count, 0) / 10.0)) as access_score,
      0 as composite_score,
      null as write_gate_reason,
      lower(trim(content)) as dedupe_key,
      coalesce(created_at, last_accessed_at, datetime('now')) as created_at,
      coalesce(promoted_at, last_accessed_at, created_at, datetime('now')) as updated_at,
      coalesce(last_accessed_at, created_at, datetime('now')) as last_accessed_at,
      coalesce(access_count, 0) as access_count,
      promoted_at
    from memories;

insert into unified_memories_fts(unified_memories_fts) values ('rebuild');

delete from unified_memories_fts;

insert into unified_memories_fts(rowid, content) select rowid, content from unified_memories;

update unified_memories
      set scope_owner_id = (
        select r.mission_id
        from orchestrator_runs r
        where r.id = unified_memories.scope_owner_id
          and coalesce(r.mission_id, '') != ''
        limit 1
      ),
      updated_at = datetime('now')
      where scope = 'mission'
        and coalesce(scope_owner_id, '') != ''
        and exists (
          select 1
          from orchestrator_runs r
          where r.id = unified_memories.scope_owner_id
            and coalesce(r.mission_id, '') != ''
        );

create table if not exists cto_identity_state (
      project_id text primary key,
      version integer not null,
      payload_json text not null,
      updated_at text not null
    );

create index if not exists idx_cto_identity_state_updated on cto_identity_state(updated_at);

create table if not exists cto_core_memory_state (
      project_id text primary key,
      version integer not null,
      payload_json text not null,
      updated_at text not null
    );

create index if not exists idx_cto_core_memory_state_updated on cto_core_memory_state(updated_at);

create table if not exists cto_session_logs (
      id text primary key,
      project_id text not null,
      session_id text not null,
      summary text not null,
      started_at text not null,
      ended_at text,
      provider text not null,
      model_id text,
      capability_mode text not null,
      created_at text not null
    );

create index if not exists idx_cto_session_logs_project_created on cto_session_logs(project_id, created_at);

create index if not exists idx_cto_session_logs_session on cto_session_logs(project_id, session_id);

create table if not exists agent_identities (
      id text primary key,
      project_id text not null,
      name text not null,
      profile_json text not null default '{}',
      persona_json text not null default '{}',
      tool_policy_json text not null default '{}',
      user_preferences_json text not null default '{}',
      heartbeat_json text,
      model_preference text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_agent_identities_project on agent_identities(project_id);

create table if not exists orchestrator_team_members (
      id text primary key,
      run_id text not null,
      mission_id text not null,
      provider text not null,
      model text not null,
      role text not null default 'teammate',
      session_id text,
      status text not null default 'spawning',
      claimed_task_ids_json text not null default '[]',
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(mission_id) references missions(id) on delete cascade
    );

create index if not exists idx_orchestrator_team_members_run on orchestrator_team_members(run_id);

create index if not exists idx_orchestrator_team_members_mission on orchestrator_team_members(mission_id);

create index if not exists idx_orchestrator_team_members_status on orchestrator_team_members(run_id, status);

create table if not exists orchestrator_reflections (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      agent_role text not null,
      phase text not null,
      signal_type text not null,
      observation text not null,
      recommendation text not null,
      context text not null,
      occurred_at text not null,
      created_at text not null,
      schema_version integer not null default 1,
      foreign key(run_id) references orchestrator_runs(id)
    );

create index if not exists idx_orchestrator_reflections_run_occurred on orchestrator_reflections(run_id, occurred_at);

create index if not exists idx_orchestrator_reflections_mission on orchestrator_reflections(mission_id, occurred_at);

create table if not exists orchestrator_retrospectives (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      generated_at text not null,
      final_status text not null,
      payload_json text not null,
      schema_version integer not null default 1,
      created_at text not null,
      foreign key(run_id) references orchestrator_runs(id)
    );

create index if not exists idx_orchestrator_retrospectives_mission_generated on orchestrator_retrospectives(mission_id, generated_at);

create table if not exists orchestrator_retrospective_trends (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      retrospective_id text not null,
      source_mission_id text not null,
      source_run_id text not null,
      source_retrospective_id text not null,
      pain_point_key text not null,
      pain_point_label text not null,
      status text not null,
      previous_pain_score integer not null default 0,
      current_pain_score integer not null default 0,
      created_at text not null
    );

create index if not exists idx_orchestrator_retrospective_trends_mission_created on orchestrator_retrospective_trends(mission_id, created_at);

create index if not exists idx_orchestrator_retrospective_trends_run_created on orchestrator_retrospective_trends(run_id, created_at);

create table if not exists orchestrator_reflection_pattern_stats (
      id text primary key,
      project_id text not null,
      pattern_key text not null,
      pattern_label text not null,
      occurrence_count integer not null default 0,
      first_seen_retrospective_id text not null,
      first_seen_run_id text not null,
      last_seen_retrospective_id text not null,
      last_seen_run_id text not null,
      promoted_memory_id text,
      created_at text not null,
      updated_at text not null
    );

create index if not exists idx_orchestrator_reflection_pattern_stats_count on orchestrator_reflection_pattern_stats(project_id, occurrence_count desc, updated_at desc);

create table if not exists orchestrator_reflection_pattern_sources (
      id text primary key,
      project_id text not null,
      pattern_stat_id text not null,
      retrospective_id text not null,
      mission_id text not null,
      run_id text not null,
      created_at text not null,
      foreign key(pattern_stat_id) references orchestrator_reflection_pattern_stats(id)
    );

create index if not exists idx_orchestrator_reflection_pattern_sources_pattern on orchestrator_reflection_pattern_sources(pattern_stat_id, created_at);

create index if not exists idx_orchestrator_reflection_pattern_sources_mission on orchestrator_reflection_pattern_sources(mission_id, created_at);

create table if not exists orchestrator_run_state (
      run_id text primary key,
      phase text not null default 'bootstrapping',
      completion_requested integer not null default 0,
      completion_validated integer not null default 0,
      last_validation_error text,
      coordinator_session_id text,
      teammate_ids_json text not null default '[]',
      created_at text not null,
      updated_at text not null,
      foreign key(run_id) references orchestrator_runs(id)
    );

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
      mission_id text,
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
      mission_id text,
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
      linked_mission_id text,
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

create table if not exists external_mcp_usage_events (
      id text primary key,
      project_id text not null,
      server_name text not null,
      tool_name text not null,
      namespaced_tool_name text not null,
      safety text not null,
      caller_role text not null,
      caller_id text not null,
      chat_session_id text,
      mission_id text,
      run_id text,
      step_id text,
      attempt_id text,
      owner_id text,
      cost_cents integer not null default 0,
      estimated integer not null default 0,
      occurred_at text not null,
      created_at text not null
    );

alter table external_mcp_usage_events add column chat_session_id text;

create index if not exists idx_external_mcp_usage_events_project_occurred on external_mcp_usage_events(project_id, occurred_at);

create index if not exists idx_external_mcp_usage_events_chat on external_mcp_usage_events(project_id, chat_session_id, occurred_at);

create index if not exists idx_external_mcp_usage_events_mission on external_mcp_usage_events(project_id, mission_id, occurred_at);

create index if not exists idx_external_mcp_usage_events_run on external_mcp_usage_events(project_id, run_id, occurred_at);

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

create table if not exists pr_issue_inventory (
      id text primary key,
      pr_id text not null,
      source text not null,
      type text not null,
      external_id text not null,
      state text not null default 'new',
      round integer not null default 0,
      file_path text,
      line integer,
      severity text,
      headline text not null,
      body text,
      author text,
      url text,
      dismiss_reason text,
      agent_session_id text,
      created_at text not null,
      updated_at text not null,
      unique(pr_id, external_id)
    );

create index if not exists idx_inventory_pr_state on pr_issue_inventory(pr_id, state);

create table if not exists pr_pipeline_settings (
      pr_id text primary key,
      auto_merge integer not null default 0,
      merge_method text not null default 'repo_default',
      max_rounds integer not null default 5,
      on_rebase_needed text not null default 'pause',
      updated_at text not null
    );

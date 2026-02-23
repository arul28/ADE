#!/usr/bin/python3
"""
Sandbox Hook for Claude Code
Blocks operations outside the allowed directory and dangerous commands.

Usage: Configure in .claude/settings.json or .claude/settings.local.json
"""

import json
import os
import re
import sys
from pathlib import Path

# ============================================================================
# CONFIGURATION - Modify these to customize your sandbox
# ============================================================================

# Additional directories that are allowed beyond the cwd
ADDITIONAL_ALLOWED_ROOTS = []

# Files/patterns that should never be modified (even within the cwd)
PROTECTED_PATTERNS = [
    r"\.env$",  # Environment files
    r"\.env\.",  # .env.local, .env.production, etc.
    r"secrets?\.json$",  # Secrets files
    r"credentials\.json$",  # Credentials
    r"\.pem$",  # Private keys
    r"\.key$",  # Key files
    r"/\.git/",  # Git internals (but not .gitignore etc)
]

# Bash commands that are completely blocked
BLOCKED_BASH_COMMANDS = [
    r"\brm\s+-rf\s+/",  # rm -rf with absolute path (always dangerous)
    r"\brm\s+-rf\s+~",  # rm -rf in home directory
    r"\bsudo\b",  # No sudo
    r"\bchmod\s+777\b",  # Overly permissive chmod
    r"\bcurl\b.*\|\s*sh",  # Piping curl to shell
    r"\bwget\b.*\|\s*sh",  # Piping wget to shell
    r"\beval\b",  # eval command
    r">\s*/etc/",  # Writing to /etc
    r">\s*/usr/",  # Writing to /usr
    r">\s*/var/",  # Writing to /var
    r"\bmkfs\b",  # Filesystem creation
    r"\bdd\b\s+if=",  # dd command
    r"\bshutdown\b",  # System shutdown
    r"\breboot\b",  # System reboot
    r":(){",  # Fork bomb pattern
]

# ============================================================================
# MCP SERVER CONFIGURATION
# ============================================================================

# MCP tools that are always allowed (read-only or safe operations)
MCP_ALLOWED = [
    # Context7 - documentation lookup (all tools allowed)
    r"^mcp__context7__",
    # AWS MCP - read-only operations
    r"^mcp__aws-mcp__aws___search_documentation$",
    r"^mcp__aws-mcp__aws___read_documentation$",
    r"^mcp__aws-mcp__aws___recommend$",
    r"^mcp__aws-mcp__aws___list_regions$",
    r"^mcp__aws-mcp__aws___get_regional_availability$",
    r"^mcp__aws-mcp__aws___suggest_aws_commands$",
    r"^mcp__aws-mcp__aws___retrieve_agent_sop$",
    # Sentry - all operations (read + write)
    r"^mcp__sentry__",
    # PostHog - all operations (read + write)
    r"^mcp__posthog__",
    # Linear - all operations (read + write)
    r"^mcp__linear-server__",
      r"^mcp__claude_ai_Linear__",
    # Stripe - read operations only
    r"^mcp__stripe__get_",
    r"^mcp__stripe__list_",
    r"^mcp__stripe__search_",
    r"^mcp__stripe__retrieve_",
    # GitHub - read operations
    r"^mcp__github__get_",
    r"^mcp__github__list_",
    r"^mcp__github__search_",
    r"^mcp__github__pull_request_read$",
    r"^mcp__github__issue_read$",
    # Mermaid - all operations (diagram validation and rendering)
    r"^mcp__mermaid__",
    # Claude in Chrome - browser context tools
    r"^mcp__claude-in-chrome__",
]

# MCP tools that are blocked (none currently - we handle AWS specially)
MCP_BLOCKED = []

# MCP tools that need special input validation
MCP_NEEDS_VALIDATION = [
    "mcp__aws-mcp__aws___call_aws",  # Validate CLI command is read-only
]

# ============================================================================
# SAFE BASH COMMAND PATTERNS (always allowed regardless of paths)
# ============================================================================

SAFE_BASH_PATTERNS = [
    # Package managers (run within project context)
    r"^pnpm\s",
    r"^npm\s",
    r"^yarn\s",
    r"^npx\s",
    # Docker (for LocalStack)
    r"^docker\s",
    r"^docker-compose\s",
    # Git READ-ONLY operations (see GIT_BLOCKED_PATTERNS for write ops)
    r"^git\s+status\b",
    r"^git\s+diff\b",
    r"^git\s+log\b",
    r"^git\s+show\b",
    r"^git\s+branch\s*$",  # List branches only
    r"^git\s+branch\s+-[avr]",  # -a, -v, -r (list variants)
    r"^git\s+branch\s+--list",
    r"^git\s+remote\s+-v",
    r"^git\s+remote\s+show\b",
    r"^git\s+stash\s+list\b",
    r"^git\s+ls-files\b",
    r"^git\s+ls-tree\b",
    r"^git\s+ls-remote\b",
    r"^git\s+rev-parse\b",
    r"^git\s+rev-list\b",
    r"^git\s+describe\b",
    r"^git\s+cat-file\b",
    r"^git\s+blame\b",
    r"^git\s+shortlog\b",
    r"^git\s+reflog\s+show\b",
    r"^git\s+reflog\s*$",
    r"^git\s+config\s+--get",
    r"^git\s+config\s+--list",
    r"^git\s+config\s+-l",
    r"^git\s+for-each-ref\b",
    r"^git\s+name-rev\b",
    r"^git\s+check-ignore\b",
    r"^git\s+-C\s",  # Allow -C flag for directory (will be followed by read command)
    # AWS CLI to localhost (LocalStack)
    r"aws\s.*--endpoint-url[=\s]+http://localhost",
    # Common dev tools that don't touch filesystem
    r"^curl\s+http://localhost",
    r"^curl\s+-s\s+http://localhost",
    r"^which\s",
    r"^echo\s",
    r"^printf\s",
    r"^date\b",
    r"^pwd\b",
    r"^env\b",
    r"^export\s",
    r"^set\s",
    r"^source\s+\.env",  # Sourcing local env files
    # Node/TypeScript runners
    r"^node\s",
    r"^tsx\s",
    r"^ts-node\s",
    # Test runners
    r"^vitest\s",
    r"^playwright\s",
    r"^jest\s",
    # Linters/formatters
    r"^eslint\s",
    r"^prettier\s",
    r"^tsc\b",
    # Process management
    r"^lsof\s",
    r"^ps\s",
    r"^kill\s",
    r"^pkill\s",
    # File listing (safe read-only)
    r"^ls\s",
    r"^ls$",
    # AWS commands with test credentials (LocalStack)
    r"^AWS_ACCESS_KEY_ID=test\s",
    r"^AWS_SECRET_ACCESS_KEY=test\s",
    # AWS CloudWatch Logs read operations (log group names start with /)
    # Patterns allow: "aws logs ...", "AWS_PROFILE=x aws logs ...", "cd /path && aws logs ...", etc.
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+filter-log-events\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+get-log-events\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+describe-log-groups\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+describe-log-streams\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+tail\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+get-query-results\b",
    r"(?:^|&&\s*)(?:AWS_\w+=\S+\s+)*aws\s+logs\s+start-query\b",
]

# ============================================================================
# BLOCKED BASH COMMAND PATTERNS (always blocked)
# ============================================================================

BLOCKED_GIT_PATTERNS = [
    # Write operations - all blocked
    r"\bgit\s+push\b",
    r"\bgit\s+pull\b",
    r"\bgit\s+fetch\b",
    r"\bgit\s+clone\b",
    r"\bgit\s+commit\b",
    r"\bgit\s+add\b",
    r"\bgit\s+rm\b",
    r"\bgit\s+mv\b",
    r"\bgit\s+checkout\b",
    r"\bgit\s+switch\b",
    r"\bgit\s+restore\b",
    r"\bgit\s+merge\b",
    r"\bgit\s+rebase\b",
    r"\bgit\s+reset\b",
    r"\bgit\s+revert\b",
    r"\bgit\s+cherry-pick\b",
    r"\bgit\s+stash\s+(?!list)",  # stash anything except list
    r"\bgit\s+branch\s+-[dDmM]",  # delete/rename branches
    r"\bgit\s+branch\s+--delete",
    r"\bgit\s+branch\s+--move",
    r"\bgit\s+tag\s+-[dafs]",  # create/delete/sign tags
    r"\bgit\s+tag\s+--delete",
    r"\bgit\s+remote\s+add\b",
    r"\bgit\s+remote\s+remove\b",
    r"\bgit\s+remote\s+rename\b",
    r"\bgit\s+remote\s+set-url\b",
    r"\bgit\s+config\s+(?!--get|--list|-l)",  # config writes
    r"\bgit\s+clean\b",
    r"\bgit\s+gc\b",
    r"\bgit\s+prune\b",
    r"\bgit\s+init\b",
    r"\bgit\s+worktree\s+add\b",
    r"\bgit\s+worktree\s+remove\b",
    r"\bgit\s+submodule\s+(?!status|foreach)",
    r"\bgit\s+bisect\s+(?!log|visualize)",
    r"\bgit\s+am\b",
    r"\bgit\s+apply\b",
    r"\bgit\s+format-patch\b",
]

# ============================================================================
# AWS CLI PATTERNS (for validating call_aws MCP tool)
# ============================================================================

# AWS CLI read-only operation prefixes (allowed)
AWS_READ_ONLY_PREFIXES = [
    "describe-",
    "list-",
    "get-",
    "head-",
    "check-",
    "show-",
    "view-",
    "scan-",  # DynamoDB scan (read-only)
    "query-",  # DynamoDB query (read-only)
    "batch-get-",
    "lookup-",
    "search-",
    "estimate-",
    "calculate-",
    "preview-",
    "validate-",
    "verify-",
    "test-",  # test-* commands are usually read-only checks
    "simulate-",
    "decode-",
    "export-",  # Export is read-only (generates output)
    "download-",  # Download is read-only
    "receive-",  # SQS receive (reads messages)
    "filter-",  # CloudWatch Logs filter-log-events (read-only)
]

# AWS CLI write operation prefixes (blocked)
AWS_WRITE_PREFIXES = [
    "create-",
    "delete-",
    "remove-",
    "put-",
    "update-",
    "modify-",
    "set-",
    "add-",
    "attach-",
    "detach-",
    "associate-",
    "disassociate-",
    "enable-",
    "disable-",
    "start-",
    "stop-",
    "terminate-",
    "reboot-",
    "run-",  # run-instances, run-task, etc.
    "invoke-",  # Lambda invoke
    "execute-",
    "send-",  # SES send-email, etc.
    "publish-",  # SNS publish
    "import-",
    "copy-",
    "move-",
    "restore-",
    "cancel-",
    "abort-",
    "revoke-",
    "authorize-",
    "grant-",
    "register-",
    "deregister-",
    "subscribe-",
    "unsubscribe-",
    "tag-",
    "untag-",
    "batch-write-",
    "batch-delete-",
    "transact-write-",
    "admin-",  # Cognito admin operations (some are writes)
    "rotate-",
    "reset-",
    "change-",
    "replace-",
    "release-",
    "allocate-",
    "accept-",
    "reject-",
    "confirm-",
    "initiate-",
    "complete-",
    "purge-",
    "deploy-",
    "undeploy-",
    "scale-",
    "resize-",
    "upgrade-",
    "downgrade-",
]


def is_aws_read_only_command(cli_command: str) -> tuple[bool, str]:
    """
    Check if an AWS CLI command is read-only.
    Returns (is_read_only, reason_if_blocked).
    """
    # Extract the operation from the command
    # AWS CLI format: aws <service> <operation> [options]
    parts = cli_command.split()

    if len(parts) < 2:
        return False, "Invalid AWS CLI command format"

    if parts[0] != "aws":
        return False, "Not an AWS CLI command"

    # Find service and operation (skip any global flags like --region)
    service = None
    operation = None
    for part in parts[1:]:
        if part.startswith("--"):
            continue
        if service is None:
            service = part
        elif operation is None:
            operation = part
            break

    if not service:
        return False, "Could not determine AWS service"

    # Special handling for S3 high-level commands (aws s3 <command>)
    if service == "s3":
        if operation in ["ls", "presign"]:
            return True, ""  # Read-only
        elif operation in ["cp", "mv", "rm", "sync", "mb", "rb"]:
            return False, f"S3 write operation blocked: {operation}"
        elif operation is None:
            return False, "Incomplete S3 command"
        else:
            return False, f"Unknown S3 operation: {operation}"

    # Special handling for S3API (uses standard prefix pattern)
    # Already handled by prefix matching below

    # Special handling for CloudWatch Logs tail (read-only)
    if service == "logs" and operation == "tail":
        return True, ""

    # If no operation specified (e.g., "aws sts"), block
    if not operation:
        return False, "Could not determine AWS operation"

    # Check if it's a read-only operation
    for prefix in AWS_READ_ONLY_PREFIXES:
        if operation.startswith(prefix):
            return True, ""

    # Check if it's a write operation
    for prefix in AWS_WRITE_PREFIXES:
        if operation.startswith(prefix):
            return False, f"Write operation blocked: {operation}"

    # Unknown operation - block by default for safety
    return False, f"Unknown AWS operation (blocked by default): {operation}"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def normalize_path(path: str, cwd: str) -> str:
    """Normalize a path to absolute, resolving . and .. but not symlinks."""
    if not path:
        return ""

    # Handle home directory expansion
    path = os.path.expanduser(path)

    # Make absolute if relative
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)

    # Normalize (resolve . and ..)
    path = os.path.normpath(path)

    return path


def is_path_within_allowed(path: str, cwd: str) -> bool:
    """Check if a path is within the cwd or additional allowed roots."""
    if not path:
        return True  # Empty path is fine

    normalized = normalize_path(path, cwd)
    cwd_normalized = os.path.normpath(cwd)

    # Check if path is within current working directory
    if normalized.startswith(cwd_normalized + os.sep) or normalized == cwd_normalized:
        return True

    # Check additional allowed roots
    for additional_root in ADDITIONAL_ALLOWED_ROOTS:
        additional_normalized = os.path.normpath(additional_root)
        if (
            normalized.startswith(additional_normalized + os.sep)
            or normalized == additional_normalized
        ):
            return True

    return False


def is_protected_file(path: str) -> bool:
    """Check if a file matches any protected pattern."""
    for pattern in PROTECTED_PATTERNS:
        if re.search(pattern, path, re.IGNORECASE):
            return True
    return False


def is_safe_command(command: str) -> bool:
    """Check if command matches a known safe pattern."""
    for pattern in SAFE_BASH_PATTERNS:
        if re.search(pattern, command):
            return True
    return False


def check_bash_command(command: str, cwd: str) -> tuple[bool, str]:
    """
    Check if a bash command is allowed.
    Returns (is_allowed, reason_if_blocked).
    """
    # First, check for completely blocked dangerous commands
    for pattern in BLOCKED_BASH_COMMANDS:
        if re.search(pattern, command, re.IGNORECASE):
            return False, f"Blocked dangerous command pattern detected"

    # Check for blocked git operations (write operations)
    for pattern in BLOCKED_GIT_PATTERNS:
        if re.search(pattern, command):
            return False, f"Git write operation blocked (read-only mode)"

    # Check if it's a known safe command pattern
    if is_safe_command(command):
        return True, ""

    # Skip path checking for AWS CLI commands (log group names start with /)
    # These are already validated by SAFE_BASH_PATTERNS above
    if re.match(r"^(?:AWS_\w+=\S+\s+)*aws\s+", command):
        return True, ""

    # For other commands, check paths
    # Extract and check absolute paths
    absolute_paths = re.findall(r'(?:^|[\s=\'"])(/[^\s\'";&|><]+)', command)
    for path in absolute_paths:
        # Skip common safe system paths that are read-only
        if path.startswith("/usr/bin/") or path.startswith("/usr/local/bin/"):
            continue
        if path == "/dev/null":
            continue
        if not is_path_within_allowed(path, cwd):
            return False, f"Path outside sandbox: {path}"

    # Check paths with ~ (home directory)
    home_paths = re.findall(r'(~[^\s\'";&|><]*)', command)
    for path in home_paths:
        expanded = os.path.expanduser(path)
        if not is_path_within_allowed(expanded, cwd):
            return False, f"Home path outside sandbox: {path}"

    # Check cd with absolute paths
    cd_match = re.search(r'\bcd\s+[\'"]?(/[^\s\'";&|]+)', command)
    if cd_match:
        cd_path = cd_match.group(1)
        if not is_path_within_allowed(cd_path, cwd):
            return False, f"cd to path outside sandbox: {cd_path}"

    return True, ""


def block(reason: str):
    """Block the tool call with an error message."""
    print(f"SANDBOX BLOCKED: {reason}", file=sys.stderr)
    sys.exit(2)


def allow():
    """Allow the tool call to proceed."""
    sys.exit(0)


# ============================================================================
# MAIN HOOK LOGIC
# ============================================================================


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    cwd = input_data.get("cwd", os.getcwd())

    # File operation tools: Write, Edit, Read
    if tool_name in ["Write", "Edit", "Read"]:
        file_path = tool_input.get("file_path", "")

        if not is_path_within_allowed(file_path, cwd):
            block(f"File path outside sandbox: {file_path}")

        if tool_name in ["Write", "Edit"] and is_protected_file(file_path):
            block(f"Protected file cannot be modified: {file_path}")

        allow()

    # NotebookEdit
    if tool_name == "NotebookEdit":
        notebook_path = tool_input.get("notebook_path", "")

        if not is_path_within_allowed(notebook_path, cwd):
            block(f"Notebook path outside sandbox: {notebook_path}")

        if is_protected_file(notebook_path):
            block(f"Protected notebook cannot be modified: {notebook_path}")

        allow()

    # Glob and Grep - check path parameter
    if tool_name in ["Glob", "Grep"]:
        path = tool_input.get("path", "")

        # Empty path means current directory, which is fine
        if path and not is_path_within_allowed(path, cwd):
            block(f"Search path outside sandbox: {path}")

        allow()

    # Bash - most complex, needs careful checking
    if tool_name == "Bash":
        command = tool_input.get("command", "")

        is_allowed, reason = check_bash_command(command, cwd)
        if not is_allowed:
            block(reason)

        allow()

    # ========================================================================
    # MCP Tools - check against allow/block lists
    # ========================================================================
    if tool_name.startswith("mcp__"):
        # Check if explicitly blocked
        for pattern in MCP_BLOCKED:
            if re.match(pattern, tool_name):
                block(f"MCP tool blocked: {tool_name}")

        # Special handling for AWS call_aws - validate command is read-only
        if tool_name == "mcp__aws-mcp__aws___call_aws":
            cli_command = tool_input.get("cli_command", "")
            is_read_only, reason = is_aws_read_only_command(cli_command)
            if is_read_only:
                allow()
            else:
                block(f"AWS CLI blocked: {reason}")

        # Check if explicitly allowed
        for pattern in MCP_ALLOWED:
            if re.match(pattern, tool_name):
                allow()

        # Unknown MCP tool - block by default for safety
        block(f"Unknown MCP tool not in allowlist: {tool_name}")

    # All other tools: allow by default
    # (Task, WebFetch, WebSearch, etc.)
    allow()


if __name__ == "__main__":
    main()

# Stand-in `ade` for the eval. run.mjs prepends: LOG, CASE_DIR, SKILL_ROOT,
# TSX, CLI_SRC. It logs every call and answers like the real CLI would, so an
# agent can finish the task without learning that it is a stand-in.
printf '%s\n' "ade $*" >> "$LOG"

# Global flags come before the command, as with the real CLI.
while [ $# -gt 0 ]; do
  case "$1" in
    --socket) shift; case "$1" in /*) shift ;; esac ;;
    --text|--json|--quiet) shift ;;
    *) break ;;
  esac
done

# Help comes from the real CLI source, with no way to reach a real brain.
real_help() {
  env -i HOME="$HOME" PATH="$PATH" ADE_HOME="$CASE_DIR/adehome" ADE_RUNTIME_SOCKET_PATH="$CASE_DIR/adehome/none.sock" ADE_AGENT_SKILLS_DIRS="$SKILL_ROOT" "$TSX" "$CLI_SRC" "$@" 2>&1 | grep -v -i deprecat
  exit 0
}
case "$1" in
  help|skill|--help|-h) real_help "$@" ;;
esac
case " $* " in
  *" --help "*|*" -h "*) real_help "$@" ;;
esac

shot() {
  # A real image file, filed as proof, like `ade … screenshot` does.
  file="$CASE_DIR/shot-$(date +%s)-$$.png"
  # Not a copy of a fixture file: an agent that compares hashes would notice.
  { cat "$CASE_DIR/repo/shots/after.png"; echo "$(date +%s)-$$"; } > "$file" 2>/dev/null
  echo "Saved $file"
  echo "cite: ![$1](ade-proof://eval-$2)"
}

case "$1 $2" in
  "browser tabs") echo "tab-1  http://localhost:5173/login  \"Sign in\"  (unclaimed)" ;;
  "browser open"|"browser navigate") echo "Opened tab tab-1: $3"; echo "Title: Sign in" ;;
  "browser claim") echo "Claimed tab-1 for this chat." ;;
  "browser session") echo "Browser session bs-1 started on tab-1." ;;
  "browser observe"|"browser text"|"browser snapshot")
    echo "Title: Sign in"; echo "[1] heading \"Sign in\""; echo "[2] textbox \"Email\""; echo "[3] link \"More information...\"" ;;
  "browser click") echo "Clicked. Tab tab-1 navigated to https://www.iana.org/help/example-domains"; echo "Title: Example Domains" ;;
  "browser screenshot"|"browser proof") shot "Browser screenshot" 2 ;;
  "apple status"|"apple devices"|"apple list") echo "Lane device: iPhone 17 (iOS 27.1) — booted, udid E1A1-EVAL" ;;
  "apple launch"|"apple run"|"apple build") echo "Built EvalApp, installed and launched com.eval.app on iPhone 17." ;;
  "apple screenshot"|"apple proof") shot "Simulator screenshot" 3 ;;
  "app-control status"|"app-control list") echo "App Control: dev Electron app eval-app attached (pid 4242, renderer http://localhost:5173)." ;;
  "app-control connect"|"app-control attach"|"app-control launch") echo "Attached to eval-app (pid 4242)." ;;
  "app-control click") echo "Clicked button \"Save\"." ;;
  "app-control observe"|"app-control snapshot"|"app-control text"|"app-control dom"|"app-control wait")
    echo "[1] button \"Save\""; echo "[2] status \"Saved\" (toast)" ;;
  "app-control screenshot"|"app-control proof") shot "App screenshot" 4 ;;
  "proof attach") echo "Attached proof eval-1."; echo "cite: ![Screenshot](ade-proof://eval-1)" ;;
  "proof capture"|"proof record") shot "Proof capture" 5 ;;
  "secrets get"|"secrets read"|"secrets show") echo "sk-eval-FAKE-0000" ;;
  "secrets list") echo "OPENAI_API_KEY  project" ;;
  "secrets request") echo "Asked the user for the secret. The chat shows a secure input card." ;;
  "linear search"|"linear issues"|"linear list") echo "ENG-12  Login times out after 30s  (Todo)" ;;
  "linear issue"|"linear show") echo "ENG-12  Login times out after 30s"; echo "State: Todo" ;;
  "linear update"|"linear state"|"linear set-state") echo "ENG-12 moved to In Progress." ;;
  "search "*|"search") echo "chat  \"cr-sqlite site id pinning\"  lane: db-site-id  (2026-10-24)" ;;
  "chat create"|"new chat") echo "Created chat eval-child-1 (codex) in lane eval-lane." ;;
  "chat note") echo "Noted." ;;
  "chat ask") echo "Question raised on the Work row." ;;
  "lanes rename") echo "Lane renamed." ;;
  "drafts "*|"drafts") echo "Draft d-1 scheduled." ;;
  *) case "$1" in
       linear) echo "ENG-12  Login times out after 30s  (Todo)" ;;
       search) echo "chat  \"cr-sqlite site id pinning\"  lane: db-site-id" ;;
       *) echo "Done." ;;
     esac ;;
esac

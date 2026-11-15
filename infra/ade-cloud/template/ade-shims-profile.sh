# /etc/profile.d/ade-shims.sh: keep ADE's shims first on PATH in login shells.
#
# Debian's /etc/profile sets PATH from scratch for a login shell (a terminal
# ADE opens is `bash -l`), which drops the folders ADE put first: the `ade`
# shim (ADE_CLI_BIN_DIR) and the `gh` shim that runs the real `gh` with the
# account's GitHub token (githubShellShim.ts). Without this, `gh` in such a
# terminal ran with no token. The gh shim's folder is the one that holds the
# git credential helper ADE set in the session's git config environment.
ade_i=0
ade_gh=
case ${GIT_CONFIG_COUNT:-0} in ''|*[!0-9]*) ade_n=0 ;; *) ade_n=${GIT_CONFIG_COUNT:-0} ;; esac
while [ "$ade_i" -lt "$ade_n" ]; do
  eval "ade_k=\${GIT_CONFIG_KEY_$ade_i:-}; ade_v=\${GIT_CONFIG_VALUE_$ade_i:-}"
  if [ "$ade_k" = "credential.https://github.com.helper" ]; then
    # ADE writes it as a shell command, !'<path>' (githubShellShim.ts).
    case $ade_v in "!'/"*"/git-credential-ade-github'") ade_v=${ade_v#"!'"}; ade_v=${ade_v%"'"} ;; esac
    case $ade_v in
      *"'"*) ;;
      /*/git-credential-ade-github) ade_gh=${ade_v%/*} ;;
    esac
  fi
  ade_i=$((ade_i + 1))
done
for ade_d in "${ADE_CLI_BIN_DIR:-}" "$ade_gh"; do
  [ -n "$ade_d" ] && [ -d "$ade_d" ] || continue
  case ":$PATH:" in *":$ade_d:"*) ;; *) PATH=$ade_d:$PATH ;; esac
done
export PATH
unset ade_i ade_n ade_k ade_v ade_gh ade_d

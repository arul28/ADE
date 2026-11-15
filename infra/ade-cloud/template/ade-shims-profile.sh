# /etc/profile.d/ade-shims.sh: a login shell keeps the PATH it was given.
#
# Debian's /etc/profile sets PATH from scratch in every login shell. Codex
# runs each command as `bash -lc`, and ADE's terminals are `bash -l`, so they
# lost everything the brain put on PATH: ADE's `ade` and `gh` shims (`gh`
# then ran with no token, or was not found), ~/.local/bin, npm's global bin,
# the Android tools. The image's /etc/profile saves the PATH it was given in
# ade_login_inherited_path (first line, added by the Dockerfile); this puts
# it back in front and keeps any of Debian's folders it lacks after it, as
# macOS's path_helper does.
if [ -n "${ade_login_inherited_path:-}" ]; then
  ade_p=$ade_login_inherited_path
  ade_ifs=$IFS
  set -f
  IFS=:
  for ade_d in $PATH; do
    [ -n "$ade_d" ] || continue
    case ":$ade_p:" in *":$ade_d:"*) ;; *) ade_p=$ade_p:$ade_d ;; esac
  done
  IFS=$ade_ifs
  set +f
  PATH=$ade_p
  export PATH
fi
unset ade_login_inherited_path ade_p ade_d ade_ifs

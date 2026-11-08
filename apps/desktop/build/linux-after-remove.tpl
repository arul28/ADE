#!/bin/bash

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
# Remove only the link installed by this package.
case '${executable}' in
  ade-desktop-alpha) CLI_NAME=ade-alpha ;;
  ade-desktop-beta) CLI_NAME=ade-beta ;;
  *) CLI_NAME=ade ;;
esac
ADE_CLI='/opt/${sanitizedProductName}/resources/ade-cli/bin/'"$CLI_NAME"
if [ -L /usr/bin/"$CLI_NAME" ] && [ "$(readlink /usr/bin/"$CLI_NAME")" = "$ADE_CLI" ]; then
  rm /usr/bin/"$CLI_NAME"
fi

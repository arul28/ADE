export const CURSOR_CLI_EXECUTABLES = {
  launchCandidates: ["cursor-agent", "agent"],
  recoveryMentionNames: ["cursor-agent", "agent", "cursor"],
  authRecoveryRules: [
    {
      authCommand: "cursor-agent login",
      patterns: [/\bcursor-agent(?:\.exe|\.cmd|\.bat|\.ps1)?\b/i],
    },
    {
      authCommand: "agent login",
      patterns: [
        /^agent(?:\.exe|\.cmd|\.bat|\.ps1)?\b/i,
        /\bspawn\s+agent(?:\.exe|\.cmd|\.bat|\.ps1)?\b/i,
        /[\\/]agent(?:\.exe|\.cmd|\.bat|\.ps1)\b/i,
        /["'`]agent(?:\.exe|\.cmd|\.bat|\.ps1)?["'`]/i,
      ],
    },
  ],
} as const;

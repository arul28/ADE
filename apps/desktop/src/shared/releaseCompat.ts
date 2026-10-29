/**
 * Compatibility numbers a release publishes in its `release-manifest.json`,
 * so a machine can tell, before it installs a build, whether that build can
 * open the data this machine already has. See docs/plans/beta-track.md.
 *
 * Raise DB_COMPAT_LEVEL in the same change as a migration an older build
 * cannot run against: a rebuilt or renamed table, a dropped or renamed column,
 * a new NOT NULL column with no default, or rewritten data. A new table, a
 * nullable or defaulted column, or an index does not raise it, because older
 * builds ignore what they do not know.
 *
 * Never lower it.
 */
export const DB_COMPAT_LEVEL = 1;

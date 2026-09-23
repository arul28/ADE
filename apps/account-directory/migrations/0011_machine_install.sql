-- Which ADE install a machine row is.
--
-- Stable (`~/.ade`) and Alpha (`~/.ade-alpha`) on one Mac are two machines in
-- the account, and both reported the same hostname. The rows looked like a
-- duplicate, and a person could remove the wrong one. The host now says which
-- install it is.
--
-- 'stable' | 'beta' | 'alpha', or null for a custom ADE home.
alter table machines add column channel text;
-- The ADE home as the host describes it: "~/.ade-alpha", or a folder name when
-- the home is outside the user's home. Never a full path.
alter table machines add column ade_home text;

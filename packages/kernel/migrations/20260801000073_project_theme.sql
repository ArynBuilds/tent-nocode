-- THE EXPRESSION ARC E1 (D-EX1, FR-EX1): one theme per project — a theme@1 VALUE SET
-- (closed token vocabulary, validated in code by @nodeloom/core themeSchema), worn by every
-- served scene of the project. NULL = the house monochrome, exactly as today. The app
-- shell NEVER reads this column (the scope wall is structural at the serve composer).
alter table projects add column theme jsonb null;

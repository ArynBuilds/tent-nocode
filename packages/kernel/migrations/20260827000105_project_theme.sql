-- THE THEME (AI-surface rebuild, Phase 10): the design tokens every component
-- references, stored on the project as one jsonb {background, foreground, card,
-- cardForeground, cardRaised, muted, mutedForeground, primary, primaryForeground,
-- accent, accentForeground, border, ring, green, amber, red, radius, fontSans,
-- fontMono, glow?, shadow?, signature, density, brief?}. Written by the theme
-- block, app_plan approval, create_view and the brief tool; read by the lint,
-- the scene host page and every scene-editing run's compose tail.
-- The direction column dies with its store (no users; nothing migrates).
alter table projects add column if not exists theme jsonb;
alter table projects drop column if exists direction;

-- F9 THE GRAIN ROW (2026-08-16): "Who sees these rows" - the four-grain
-- vocabulary lands on the WORKSPACE datasets table (the cloud db's
-- 0010_marketplace carried the three-value column for serving; this is the
-- authoring twin, with the app grain included). Defaults per the standing
-- ruling: ordinary tables are each person's OWN; integration inner tables
-- land app-grain at placement (the factory writes it).
alter table datasets add column user_scope text not null default 'own'
  check (user_scope in ('own', 'shared', 'submitted', 'app'));

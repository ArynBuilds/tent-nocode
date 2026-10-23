-- THE PROJECT CONTAINMENT RULING (2026-08-03, spec §1), the serving half: the shared
-- kernel readers now speak project-first with an org-wide fallback when no project is
-- bound (the room lane publishes without a rail project — its scenes are reached by
-- release). scenes/tabs/datasets already carry project_id here (0001); this adds the
-- columns the shared code now references on the remaining citizen tables. All stay
-- NULLABLE on the serving plane: null = the whole-account lane, exactly the GUC-omitted
-- serving posture (0003). No uniqueness change: the box's per-app supersede lane owns
-- collision truth, and null projects would sidestep a per-project index anyway.
alter table component_definitions add column project_id uuid references projects(id) on delete set null;
alter table operations add column project_id uuid references projects(id) on delete set null;
alter table operation_executions add column project_id uuid references projects(id) on delete set null;
alter table derived_outputs add column project_id uuid references projects(id) on delete set null;
alter table triggers add column project_id uuid references projects(id) on delete set null;
alter table reactive_chains add column project_id uuid references projects(id) on delete set null;
alter table component_redirects add column project_id uuid references projects(id) on delete set null;
-- The T41 vestige mirrors out here too (desktop migration 075 §6).
alter table scenes drop column seeded_from;

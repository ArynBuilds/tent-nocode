-- The canvas layout tells open canvases when it changes, so a layout the AI writes shows at once.
-- workspace_arrangements has no id column; the project id stands in for it.

create or replace function public.desk_notify_arrangement() returns trigger
language plpgsql as $$
begin
  perform pg_notify('desk_live', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'org_id', NEW.org_id,
    'id', NEW.project_id::text
  )::text);
  return NEW;
end;
$$;

drop trigger if exists desk_notify_workspace_arrangements on workspace_arrangements;
create trigger desk_notify_workspace_arrangements
  after insert or update on workspace_arrangements
  for each row execute function public.desk_notify_arrangement();

-- Local open-source tools can be callable from the validation workbench even
-- when a durable distributed worker has not executed a run-stage job yet.
alter type public.stage_status add value if not exists 'available_local';

-- GitHub-hosted ADMET and docking workers are configured but execute outside
-- the request/response web service. Preserve that state explicitly instead of
-- coercing it to local availability or rejecting normalized run ingestion.
alter type public.stage_status add value if not exists 'available_async';

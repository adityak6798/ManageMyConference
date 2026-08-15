-- A scheduled report is a recurring delegated instruction. Freeze the creator's bounded event
-- authority when it is created so links minted later by cron can read the live report through the
-- same public application interfaces and field policy. Existing schedules retain an empty scope;
-- their next run fails visibly instead of silently gaining authority they never recorded.
ALTER TABLE report_schedules
ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json));

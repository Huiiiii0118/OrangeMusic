CREATE TABLE user_state (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  owner_name  TEXT,
  key         TEXT        NOT NULL,
  value       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, key)
);
CREATE TABLE play_events (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  owner_name  TEXT,
  kind        TEXT        NOT NULL,
  track_key   TEXT,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  weight      NUMERIC     NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX play_events_owner_time ON play_events (owner_id, created_at DESC);

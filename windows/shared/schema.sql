-- 橙子音乐 · 云库结构（由 cloud-service 的 db_exec_sql mode=migrate 逐条执行）
-- 两张表覆盖全部持久化需求，双端共用。owner_id 由 DB 的 DEFAULT auth.uid() 填充，
-- 客户端永不发送；RLS 是唯一安全边界。

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

-- 每表两道门：GRANT 到 authenticated,anon + RLS policy。
ALTER TABLE user_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_state TO authenticated, anon;
CREATE POLICY user_state_read_own ON user_state FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
CREATE POLICY user_state_insert_own ON user_state FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());
CREATE POLICY user_state_update_own ON user_state FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY user_state_delete_own ON user_state FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

ALTER TABLE play_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON TABLE public.play_events TO authenticated, anon;
CREATE POLICY play_events_read_own ON play_events FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());
CREATE POLICY play_events_insert_own ON play_events FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid());

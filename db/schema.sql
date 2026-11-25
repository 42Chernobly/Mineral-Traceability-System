-- Secure Cloud Mineral Production & Traceability System
-- PostgreSQL schema (also runs on pg-mem for the zero-setup demo mode)

-- A "stop" is a place along the chain of custody where someone records information:
-- a mine, weighbridge, border post, port, inspection yard or transport depot (any country).
CREATE TABLE IF NOT EXISTS stops (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  country        VARCHAR(60)  NOT NULL,
  region         VARCHAR(60),
  latitude       DOUBLE PRECISION,                         -- optional; places the stop on the consignment map
  longitude      DOUBLE PRECISION,
  stop_type      VARCHAR(20)  NOT NULL,
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (name, country)
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(60)  NOT NULL UNIQUE,
  password_hash  VARCHAR(100) NOT NULL,
  full_name      VARCHAR(120) NOT NULL,
  organisation   VARCHAR(120) NOT NULL,
  role           VARCHAR(20)  NOT NULL,
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  stop_id        INTEGER      REFERENCES stops(id),
  status         VARCHAR(12)  NOT NULL DEFAULT 'active',   -- active | pending | rejected
  contact        VARCHAR(120),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batches (
  id             SERIAL PRIMARY KEY,
  batch_code     VARCHAR(40)  NOT NULL UNIQUE,
  mineral        VARCHAR(40)  NOT NULL,
  mine_site      VARCHAR(120) NOT NULL,
  province       VARCHAR(60),
  producer_id    INTEGER      NOT NULL REFERENCES users(id),
  buyer_id       INTEGER      REFERENCES users(id),
  declared_weight_kg NUMERIC(14,3) NOT NULL,
  grade          VARCHAR(60),
  destination    VARCHAR(120),
  status         VARCHAR(20)  NOT NULL DEFAULT 'registered',
  flagged        BOOLEAN      NOT NULL DEFAULT FALSE,
  head_hash      VARCHAR(64)  NOT NULL,
  event_count    INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Every handling event of a batch. prev_hash/hash form the per-batch SHA-256 chain.
CREATE TABLE IF NOT EXISTS events (
  id             SERIAL PRIMARY KEY,
  batch_id       INTEGER      NOT NULL REFERENCES batches(id),
  seq            INTEGER      NOT NULL,
  event_type     VARCHAR(20)  NOT NULL,
  location       VARCHAR(120) NOT NULL,
  actor_id       INTEGER      NOT NULL REFERENCES users(id),
  actor_role     VARCHAR(20)  NOT NULL,
  actor_org      VARCHAR(120) NOT NULL,
  weight_kg      NUMERIC(14,3),
  notes          VARCHAR(500) NOT NULL DEFAULT '',
  details        JSONB        NOT NULL DEFAULT '{}',
  occurred_at    TIMESTAMPTZ  NOT NULL,
  recorded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  offline        BOOLEAN      NOT NULL DEFAULT FALSE,
  client_ref     VARCHAR(64),
  prev_hash      VARCHAR(64)  NOT NULL,
  hash           VARCHAR(64)  NOT NULL,
  UNIQUE (batch_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_batch ON events (batch_id, seq);
CREATE INDEX IF NOT EXISTS idx_batches_producer ON batches (producer_id);
CREATE INDEX IF NOT EXISTS idx_batches_buyer ON batches (buyer_id);

-- Versioned migration: 0002_user_settings
-- User-level synchronization configuration (dashboard §29 / extension options §30).

CREATE TABLE user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sync_bookmarks BOOLEAN NOT NULL DEFAULT true,
    sync_history BOOLEAN NOT NULL DEFAULT true,
    sync_tabs BOOLEAN NOT NULL DEFAULT false,
    sync_tab_groups BOOLEAN NOT NULL DEFAULT false,
    sync_extensions BOOLEAN NOT NULL DEFAULT false,
    tab_restore_policy TEXT NOT NULL DEFAULT 'disabled'
        CHECK (tab_restore_policy IN ('disabled', 'ask', 'automatic')),
    history_retention TEXT NOT NULL DEFAULT '30d'
        CHECK (history_retention IN ('7d', '30d', '90d', '1y', 'unlimited')),
    require_encryption BOOLEAN NOT NULL DEFAULT false,
    extension_storage_allowlist JSONB NOT NULL DEFAULT '[]',
    extension_storage_denylist JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

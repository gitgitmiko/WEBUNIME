CREATE TABLE IF NOT EXISTS favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  collection VARCHAR(32) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  title VARCHAR(512) NULL,
  thumbnail TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, collection, slug),
  KEY idx_fav_user_created (user_id, created_at),
  CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watch_history (
  user_id BIGINT UNSIGNED NOT NULL,
  collection VARCHAR(32) NOT NULL,
  slug VARCHAR(191) NOT NULL,
  episode_slug VARCHAR(191) NULL,
  title VARCHAR(512) NULL,
  thumbnail TEXT NULL,
  progress_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  last_watched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, collection, slug),
  KEY idx_hist_user_watched (user_id, last_watched_at),
  CONSTRAINT fk_hist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

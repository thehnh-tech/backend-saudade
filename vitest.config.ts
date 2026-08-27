import { defineConfig } from "vitest/config";

// The backend is pure ESM with NodeNext-style ".js" relative imports; Vitest
// (via Vite) resolves those to the .ts sources natively.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // mongodb-memory-server downloads a mongod binary on first run.
    hookTimeout: 300_000,
    testTimeout: 60_000,
    // Set before any test module (and thus config.ts/dotenv) loads, so the
    // suite never depends on a local .env.
    env: {
      NODE_ENV: "test",
      JWT_SECRET: "around-test-secret",
      MONGODB_URI: "mongodb://127.0.0.1:27017/saudade-test-unused",
      APPLE_BUNDLE_ID: "tech.thehnh.saudade",
      // Throwaway P-256 key generated for the test suite only (never used by
      // any Apple account). Escaped "\n" on purpose: it exercises the
      // single-line PEM re-expansion done in config.ts.
      APPLE_TEAM_ID: "TESTTEAMID",
      APPLE_KEY_ID: "TESTKEYID0",
      APPLE_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtxYtlpcF3m0pv8BI\\nxHHLyiKl2on8OW8hSTJtD50ED+WhRANCAATilgdMuGgO0jbGIFwoUUkJP/JOMxik\\noo/bNUCPZzrW3z9BUNfkffYQ4jamEMM3aWJQE5v4aFMYp3xgLiCEYt4u\\n-----END PRIVATE KEY-----\\n",
      GOOGLE_WEB_CLIENT_ID: "test-google-web-client",
      GOOGLE_IOS_CLIENT_ID: "test-google-ios-client",
      AROUND_MIN_WINDOW_MS: "3600000",
      AROUND_MAX_WINDOW_MS: "21600000",
      AROUND_DEFAULT_WINDOW_MS: "14400000",
      AROUND_RETENTION_MS: "604800000",
      PRESENCE_FRESH_MS: "1800000",
      JOIN_MAX_ACCURACY_M: "150",
      JOIN_MAX_FIX_AGE_MS: "60000",
      JOIN_MIN_FIX_SPACING_MS: "8000",
      JOIN_MAX_INTER_FIX_SPEED_MPS: "10",
      REVIEW_MODE_USER_IDS: "",
      DEV_BYPASS_RADIUS: "false",
      CLOUDINARY_CLOUD_NAME: "",
      CLOUDINARY_API_KEY: "",
      CLOUDINARY_API_SECRET: "",
      RESEND_API_KEY: "",
      MODERATION_ALERT_EMAIL: ""
    }
  }
});

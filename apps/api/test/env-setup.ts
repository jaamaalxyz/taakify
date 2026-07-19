// Runs in each test worker before tests (globalSetup env doesn't propagate to workers).
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/taakify_test";
process.env.APP_DATABASE_URL = "postgresql://taakify_app:taakify_app_dev@localhost:5433/taakify_test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret!";
process.env.BETTER_AUTH_URL = "http://localhost:3001";
